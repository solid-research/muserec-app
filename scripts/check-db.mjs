import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(resolve(__dirname, '../data/spotify.db'), { readonly: true });

const count = db.prepare('SELECT COUNT(*) as c FROM songs').get();
console.log('✅ Total songs in DB:', count.c.toLocaleString());

const sample = db.prepare("SELECT artist_name, track_name FROM songs WHERE LOWER(track_name) LIKE '%blinding lights%' LIMIT 3").all();
console.log('Sample "Blinding Lights" search:', sample);

const fake = db.prepare("SELECT artist_name, track_name FROM songs WHERE LOWER(track_name) = 'fakesong99999xyz' LIMIT 1").all();
console.log('Fake song search (should be empty):', fake);

db.close();
