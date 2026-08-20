// scripts/ingest.mjs
// Run once: node scripts/ingest.mjs
// Reads data/spotify_data.csv and loads it into data/spotify.db (SQLite)

import { createReadStream } from 'fs';
import { parse } from 'csv-parse';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CSV_PATH = resolve(__dirname, '../data/spotify_data.csv');
const DB_PATH = resolve(__dirname, '../data/spotify.db');

const db = new Database(DB_PATH);

// Create table + FTS5 virtual table for fast fuzzy search
db.exec(`
    DROP TABLE IF EXISTS songs;
    DROP TABLE IF EXISTS songs_fts;

    CREATE TABLE songs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        artist_name TEXT NOT NULL,
        track_name  TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE songs_fts USING fts5(
        artist_name,
        track_name,
        content='songs',
        content_rowid='id',
        tokenize='unicode61'
    );
`);

const insertMany = db.transaction((rows) => {
    const stmt = db.prepare('INSERT INTO songs (artist_name, track_name) VALUES (?, ?)');
    for (const row of rows) {
        stmt.run(row.artist_name, row.track_name);
    }
});

let buffer = [];
let total = 0;
const BATCH_SIZE = 5000;

const flush = () => {
    if (buffer.length === 0) return;
    insertMany(buffer);
    total += buffer.length;
    buffer = [];
    if (total % 100000 === 0) console.log(`  ... ${total.toLocaleString()} rows inserted`);
};

console.log('📀 Starting ingestion of spotify_data.csv...');
console.log(`   CSV: ${CSV_PATH}`);
console.log(`   DB:  ${DB_PATH}\n`);

const parser = parse({
    columns: true,       // use first row as header
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
    relax_column_count: true,
});

parser.on('readable', () => {
    let record;
    while ((record = parser.read()) !== null) {
        const artist = (record['artist_name'] || '').trim();
        const track = (record['track_name'] || '').trim();
        if (!artist || !track) continue;
        buffer.push({ artist_name: artist, track_name: track });
        if (buffer.length >= BATCH_SIZE) flush();
    }
});

parser.on('end', () => {
    flush(); // final batch

    // Rebuild FTS index
    console.log('\n🔍 Building FTS5 index...');
    db.exec(`INSERT INTO songs_fts(songs_fts) VALUES('rebuild');`);

    console.log(`\n✅ Done. ${total.toLocaleString()} rows inserted into ${DB_PATH}`);
    db.close();
});

parser.on('error', (err) => {
    console.error('❌ CSV parse error:', err.message);
    process.exit(1);
});

createReadStream(CSV_PATH).pipe(parser);
