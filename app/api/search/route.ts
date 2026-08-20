import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// ═══════════════════════════════════════════════════════════════════
// 🔧 KONFIGURASI DB
// ═══════════════════════════════════════════════════════════════════
const DB_URL = process.env.BLOB_DB_URL || process.env.DB_URL;
const DB_PATH = '/tmp/data.db';
const DB_EXPECTED_SIZE_MB = 400;
const DB_MIN_VALID_SIZE = DB_EXPECTED_SIZE_MB * 0.90 * 1024 * 1024;

const globalForDb = globalThis as unknown as {
    db: InstanceType<typeof Database> | null;
    fts5Available: boolean | null;
    dbPromise: Promise<void> | null;
    dbCached: boolean | null;  // ✅ NEW: track apakah DB dari cache atau download baru
};

/**
 * 🚀 Pastikan DB tersedia di /tmp (download jika belum).
 */
async function ensureDb(): Promise<InstanceType<typeof Database>> {
    if (globalForDb.db) return globalForDb.db;

    if (globalForDb.dbPromise) {
        await globalForDb.dbPromise;
        if (globalForDb.db) return globalForDb.db;
    }

    globalForDb.dbPromise = (async () => {
        let needDownload = true;
        globalForDb.dbCached = false;  // ✅ default: not cached

        // Cek apakah DB sudah ada & valid di /tmp
        if (fs.existsSync(DB_PATH)) {
            try {
                const stat = fs.statSync(DB_PATH);
                if (stat.size >= DB_MIN_VALID_SIZE && isSQLiteHeader(DB_PATH)) {
                    console.log(`[DB] ✅ Found valid cached DB in /tmp (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
                    needDownload = false;
                    globalForDb.dbCached = true;  // ✅ pakai cache
                } else {
                    console.log(`[DB] ⚠️ Invalid cached DB (size=${stat.size}, header=${peekHeader(DB_PATH)}). Re-downloading...`);
                    fs.unlinkSync(DB_PATH);
                }
            } catch (err) {
                console.warn('[DB] ⚠️ Failed to inspect cached DB:', err);
                needDownload = true;
            }
        }

        if (needDownload) {
            if (!DB_URL) {
                throw new Error(
                    `[DB] DB_URL tidak diset. Set env var BLOB_DB_URL atau DB_URL ke URL file DB 400MB Anda ` +
                    `(Vercel Blob, Cloudflare R2, atau CDN publik).`
                );
            }

            console.log(`[DB] ⬇️  Downloading ${DB_EXPECTED_SIZE_MB}MB DB from ${DB_URL}...`);
            const start = Date.now();
            
            const res = await fetch(DB_URL, {
                signal: AbortSignal.timeout(60_000),
            });

            if (!res.ok) {
                throw new Error(`[DB] Failed to fetch DB: ${res.status} ${res.statusText}`);
            }

            const contentLength = res.headers.get('content-length');
            const expectedBytes = contentLength ? parseInt(contentLength, 10) : null;
            console.log(`[DB] Content-Length: ${expectedBytes ? (expectedBytes / 1024 / 1024).toFixed(1) + ' MB' : 'unknown'}`);

            const buffer = Buffer.from(await res.arrayBuffer());
            fs.writeFileSync(DB_PATH, buffer);

            const elapsed = Date.now() - start;
            console.log(`[DB] ✅ Downloaded in ${elapsed}ms (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);

            if (buffer.length < DB_MIN_VALID_SIZE) {
                fs.unlinkSync(DB_PATH);
                throw new Error(
                    `[DB] Downloaded file terlalu kecil (${(buffer.length / 1024 / 1024).toFixed(1)}MB). ` +
                    `Minimum: ${(DB_MIN_VALID_SIZE / 1024 / 1024).toFixed(1)}MB. ` +
                    `Kemungkinan URL salah atau file korup.`
                );
            }

            if (!isSQLiteHeader(DB_PATH)) {
                const header = peekHeader(DB_PATH);
                fs.unlinkSync(DB_PATH);
                throw new Error(
                    `[DB] File yang didownload BUKAN SQLite valid. ` +
                    `Header: "${header}". Pastikan URL menunjuk ke file .db, bukan HTML 404.`
                );
            }

            globalForDb.dbCached = false;  // ✅ baru didownload
        }

        globalForDb.db = new Database(DB_PATH, { readonly: true });

        try {
            const tables = globalForDb.db
                .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%fts%'`)
                .all();
            globalForDb.fts5Available = tables.length > 0;
            console.log(`[DB] ✅ FTS5 available: ${globalForDb.fts5Available}`);
        } catch (err: any) {
            console.warn(`[DB] ⚠️ FTS5 check failed: ${err.message}`);
            globalForDb.fts5Available = false;
        }
    })();

    await globalForDb.dbPromise;
    return globalForDb.db!;
}

function isSQLiteHeader(filePath: string): boolean {
    try {
        const fd = fs.openSync(filePath, 'r');
        const head = Buffer.alloc(16);
        fs.readSync(fd, head, 0, 16, 0);
        fs.closeSync(fd);
        return head.toString('utf8', 0, 15) === 'SQLite format 3';
    } catch {
        return false;
    }
}

function peekHeader(filePath: string): string {
    try {
        const fd = fs.openSync(filePath, 'r');
        const head = Buffer.alloc(60);
        fs.readSync(fd, head, 0, 60, 0);
        fs.closeSync(fd);
        return head.toString('utf8').replace(/[^\x20-\x7E]/g, '?').slice(0, 50);
    } catch {
        return '<unreadable>';
    }
}

// ═══════════════════════════════════════════════════════════════════
// 🧹 HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

function sanitize(str: string): string {
    return str.replace(/[^a-zA-Z0-9\s]/g, '').trim();
}

function popularityBonus(popularity: number | null | undefined): number {
    if (popularity == null) return 0;
    return Math.min(100, Math.max(0, popularity));
}

// ═══════════════════════════════════════════════════════════════════
// 🎯 MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════

export async function POST(req: NextRequest) {
    const startTime = Date.now();
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║  🔍 SEARCH API - Multi-Artist Priority + Popularity  ║');
    console.log('╚══════════════════════════════════════════════════════╝');

    try {
        const body = await req.json();
        const {
            keywords = [],
            genres = [],
            likedArtists = [],
            filteredArtists = [],
            artistsInDb = [],
            artistsNotInDb = [],
            limit = 500,
            excludeSongs = [],
        } = body;

        const priorityArtistsSet = new Set<string>();
        [...likedArtists, ...filteredArtists, ...artistsInDb].forEach(a => {
            if (a && typeof a === 'string') {
                priorityArtistsSet.add(a.toLowerCase().trim());
            }
        });
        const priorityArtists = Array.from(priorityArtistsSet);

        console.log('📥 Input parameters:');
        console.log(`   Keywords:         ${JSON.stringify(keywords)}`);
        console.log(`   Genres:           ${JSON.stringify(genres)}`);
        console.log(`   Liked Artists:    ${likedArtists.length}`);
        console.log(`   Filtered Artists: ${filteredArtists.length}`);
        console.log(`   Artists in DB:    ${artistsInDb.length}`);
        console.log(`   Artists NOT in DB: ${artistsNotInDb.length}`);
        console.log(`   🎯 Priority Artists: ${priorityArtists.length} → ${priorityArtists.slice(0, 5).join(', ')}${priorityArtists.length > 5 ? '...' : ''}`);
        console.log(`   Limit:            ${limit}`);

        const database = await ensureDb();
        
        // ✅ SIMPAN STATUS CACHED SEBELUM QUERY
        const wasCached = globalForDb.dbCached === true;
        
        const candidates: any[] = [];
        const seen = new Set<string>();
        const strategyStats: Record<string, number> = {
            'priority-artist': 0,
            'partial-artist': 0,
            'fts5-keywords': 0,
            'fts5-genres': 0,
            'like-fallback': 0,
            'popular-fill': 0,
        };

        const isPriorityArtist = (artistName: string): boolean => {
            return priorityArtistsSet.has(artistName.toLowerCase().trim());
        };

        const addIfNew = (
            row: any, 
            baseScore: number = 0, 
            source: string = '',
            forcePriority: boolean = false
        ) => {
            if (!row?.artist_name || !row?.track_name) return;
            const key = `${row.artist_name.toLowerCase()}||${row.track_name.toLowerCase()}`;
            const isExcluded = excludeSongs.some(
                (ex: any) =>
                    ex?.title?.toLowerCase() === row.track_name.toLowerCase() &&
                    ex?.artist?.toLowerCase() === row.artist_name.toLowerCase()
            );
            if (seen.has(key) || isExcluded) return;

            seen.add(key);

            const isPriority = forcePriority || isPriorityArtist(row.artist_name);
            const artistMatchBonus = isPriority ? 300 : 0;
            const popBonus = popularityBonus(row.popularity);
            const finalScore = artistMatchBonus + baseScore + popBonus;

            candidates.push({
                ...row,
                _score: finalScore,
                _baseScore: baseScore,
                _popBonus: popBonus,
                _artistBonus: artistMatchBonus,
                _isPriority: isPriority,
                _source: source,
            });
        };

        // ═══════════════════════════════════════════════════════════
        // 🎯 STRATEGY 0: PRIORITY ARTISTS
        // ═══════════════════════════════════════════════════════════
        console.log('\n🎯 [STRATEGY 0] Priority Artists - Guaranteed Slots');
        
        if (priorityArtists.length > 0) {
            const priorityStmt = database.prepare(`
                SELECT artist_name, track_name, track_id, genre, popularity, year,
                       danceability, energy, valence, tempo
                FROM spotify_data
                WHERE LOWER(artist_name) = LOWER(?)
                ORDER BY popularity DESC
                LIMIT 25
            `);

            for (const artist of priorityArtists) {
                try {
                    const rows = priorityStmt.all(artist);
                    rows.forEach((r: any) => addIfNew(r, 100, 'priority-artist', true));
                    strategyStats['priority-artist'] += rows.length;
                    
                    if (rows.length > 0) {
                        const pops = rows.slice(0, 3).map((r: any) => r.popularity).join(', ');
                        console.log(`   ✅ PRIORITY "${artist}": ${rows.length} songs (top pop: ${pops})`);
                    } else {
                        console.log(`   ⚠️ PRIORITY "${artist}": NOT FOUND in DB`);
                    }
                } catch (err: any) {
                    console.warn(`   ⚠️ Priority "${artist}" failed: ${err.message}`);
                }
            }
            console.log(`📊 Total priority songs: ${strategyStats['priority-artist']}`);
        }

        // ═══════════════════════════════════════════════════════════
        // STRATEGY 1B: PARTIAL ARTIST MATCH
        // ═══════════════════════════════════════════════════════════
        console.log('\n🔎 [STRATEGY 1B] Partial Artist Match');
        if (artistsNotInDb.length > 0) {
            const partialStmt = database.prepare(`
                SELECT artist_name, track_name, track_id, genre, popularity, year,
                       danceability, energy, valence, tempo
                FROM spotify_data
                WHERE LOWER(artist_name) LIKE ?
                ORDER BY popularity DESC
                LIMIT 15
            `);

            for (const artist of artistsNotInDb) {
                if (isPriorityArtist(artist)) continue;
                
                try {
                    const pattern = `%${artist.toLowerCase()}%`;
                    const rows = partialStmt.all(pattern);
                    rows.forEach((r: any) => addIfNew(r, 80, 'partial-artist'));
                    strategyStats['partial-artist'] += rows.length;
                    if (rows.length > 0) {
                        console.log(`   ✅ PARTIAL "${artist}": ${rows.length} songs`);
                    }
                } catch (err: any) {
                    console.warn(`   ⚠️ Partial "${artist}" failed: ${err.message}`);
                }
            }
            console.log(`📊 Total partial matches: ${strategyStats['partial-artist']}`);
        }

        // ═══════════════════════════════════════════════════════════
        // STRATEGY 2: FTS5 Keyword Search
        // ═══════════════════════════════════════════════════════════
        console.log('\n🔎 [STRATEGY 2] FTS5 keyword search');
        const validKeywords = (keywords as string[]).map(sanitize).filter((t: string) => t.length >= 2);
        
        if (validKeywords.length > 0 && globalForDb.fts5Available) {
            try {
                const ftsQuery = validKeywords.map((t: string) => `"${t}"`).join(' OR ');
                const ftsStmt = database.prepare(`
                    SELECT s.artist_name, s.track_name, s.track_id, s.genre, s.popularity,
                           s.year, s.danceability, s.energy, s.valence, s.tempo, rank
                    FROM spotify_data_fts f
                    JOIN spotify_data s ON s.track_id = f.track_id
                    WHERE spotify_data_fts MATCH ?
                    ORDER BY s.popularity DESC
                    LIMIT 300
                `);
                const rows = ftsStmt.all(ftsQuery);
                rows.forEach((r: any) => addIfNew(r, 50, 'fts5-keyword'));
                strategyStats['fts5-keywords'] = rows.length;
                console.log(`   ✅ FTS5 keywords: ${rows.length} matches`);
            } catch (err: any) {
                console.warn(`   ⚠️ FTS5 failed: ${err.message}`);
                globalForDb.fts5Available = false;
            }
        }

        // ═══════════════════════════════════════════════════════════
        // STRATEGY 3: FTS5 Genre Search
        // ═══════════════════════════════════════════════════════════
        console.log('\n🎵 [STRATEGY 3] FTS5 genre search');
        const validGenres = (genres as string[]).map(sanitize).filter((t: string) => t.length >= 2);

        if (validGenres.length > 0 && globalForDb.fts5Available) {
            try {
                const genreQuery = validGenres.map((g: string) => `"${g}"`).join(' OR ');
                const genreStmt = database.prepare(`
                    SELECT s.artist_name, s.track_name, s.track_id, s.genre, s.popularity,
                           s.year, s.danceability, s.energy, s.valence, s.tempo, rank
                    FROM spotify_data_fts f
                    JOIN spotify_data s ON s.track_id = f.track_id
                    WHERE spotify_data_fts MATCH ?
                    ORDER BY s.popularity DESC
                    LIMIT 300
                `);
                const rows = genreStmt.all(genreQuery);
                rows.forEach((r: any) => addIfNew(r, 40, 'fts5-genre'));
                strategyStats['fts5-genres'] = rows.length;
                console.log(`   ✅ FTS5 genres: ${rows.length} matches`);
            } catch (err: any) {
                console.warn(`   ⚠️ FTS5 genre failed: ${err.message}`);
            }
        }

        // ═══════════════════════════════════════════════════════════
        // STRATEGY 4: LIKE fallback
        // ═══════════════════════════════════════════════════════════
        if (!globalForDb.fts5Available || candidates.length < 50) {
            console.log('\n🔄 [STRATEGY 4] LIKE fallback');
            try {
                const allTerms = [...validKeywords, ...validGenres].slice(0, 5);
                const likeStmt = database.prepare(`
                    SELECT artist_name, track_name, track_id, genre, popularity, year
                    FROM spotify_data
                    WHERE LOWER(artist_name) LIKE ? OR LOWER(track_name) LIKE ?
                    ORDER BY popularity DESC
                    LIMIT 100
                `);
                for (const term of allTerms) {
                    try {
                        const pattern = `%${term.toLowerCase()}%`;
                        const rows = likeStmt.all(pattern, pattern);
                        rows.forEach((r: any) => addIfNew(r, 30, 'like-fallback'));
                        strategyStats['like-fallback'] += rows.length;
                        if (rows.length > 0) {
                            console.log(`   ✅ LIKE "${term}": ${rows.length} matches`);
                        }
                    } catch (err: any) {
                        console.warn(`   ⚠️ LIKE "${term}" failed: ${err.message}`);
                    }
                }
            } catch (err: any) {
                console.warn(`   ⚠️ LIKE fallback failed: ${err.message}`);
            }
        }

        // ═══════════════════════════════════════════════════════════
        // STRATEGY 5: Popular songs fill
        // ═══════════════════════════════════════════════════════════
        if (candidates.length < limit / 2) {
            console.log('\n🔥 [STRATEGY 5] Popular songs fill');
            try {
                const remaining = Math.min(300, limit - candidates.length);
                const popularStmt = database.prepare(`
                    SELECT artist_name, track_name, track_id, genre, popularity, year
                    FROM spotify_data
                    ORDER BY popularity DESC
                    LIMIT ?
                `);
                const rows = popularStmt.all(remaining);
                rows.forEach((r: any) => addIfNew(r, 5, 'popular-fill'));
                strategyStats['popular-fill'] = rows.length;
                console.log(`   ✅ Popular fill: ${rows.length} songs`);
            } catch (err: any) {
                console.warn(`   ⚠️ Popular fill failed: ${err.message}`);
            }
        }

        // ═══════════════════════════════════════════════════════════
        // 🏆 FINAL SORTING
        // ═══════════════════════════════════════════════════════════
        console.log('\n📊 [FINAL] Sorting by (artistBonus + base + popularity)...');
        const sorted = candidates.sort((a, b) => {
            const scoreDiff = (b._score || 0) - (a._score || 0);
            if (scoreDiff !== 0) return scoreDiff;
            return (b.popularity || 0) - (a.popularity || 0);
        });
        
        const finalResults = sorted.slice(0, limit).map((c, idx) => ({
            ...c,
            poolIndex: idx,
        }));

        // ═══════════════════════════════════════════════════════════
        // 📊 STATISTIK
        // ═══════════════════════════════════════════════════════════
        const artistDistribution: Record<string, number> = {};
        const priorityArtistStats: { artist: string; count: number; avgPop: number }[] = [];
        
        finalResults.forEach(r => {
            const a = r.artist_name;
            artistDistribution[a] = (artistDistribution[a] || 0) + 1;
        });

        for (const artist of priorityArtists) {
            const artistSongs = finalResults.filter(r => 
                r.artist_name.toLowerCase() === artist.toLowerCase()
            );
            const avgPop = artistSongs.length > 0
                ? artistSongs.reduce((s, r) => s + (r.popularity || 0), 0) / artistSongs.length
                : 0;
            priorityArtistStats.push({
                artist,
                count: artistSongs.length,
                avgPop: Number(avgPop.toFixed(1)),
            });
        }

        const sourceStats: Record<string, number> = {};
        finalResults.forEach(r => {
            const src = r._source || 'unknown';
            sourceStats[src] = (sourceStats[src] || 0) + 1;
        });

        const avgPopularity = finalResults.length > 0
            ? finalResults.reduce((sum, r) => sum + (r.popularity || 0), 0) / finalResults.length
            : 0;

        const totalLatency = Date.now() - startTime;
        
        console.log(`\n✅ SEARCH COMPLETE`);
        console.log(`   Total candidates: ${finalResults.length}`);
        console.log(`   Avg popularity:   ${avgPopularity.toFixed(1)}`);
        console.log(`   Strategy stats:   ${JSON.stringify(strategyStats)}`);
        console.log(`   Source dist:      ${JSON.stringify(sourceStats)}`);
        console.log(`   DB cached:        ${wasCached ? 'YES ⚡' : 'NO (downloaded)'}`);
        
        console.log(`\n🎯 PRIORITY ARTIST DISTRIBUTION:`);
        if (priorityArtistStats.length > 0) {
            priorityArtistStats
                .sort((a, b) => b.count - a.count)
                .forEach(stat => {
                    const status = stat.count > 0 ? '✅' : '❌';
                    console.log(`   ${status} ${stat.artist.padEnd(25)} → ${stat.count} songs (avg pop: ${stat.avgPop})`);
                });
        }

        console.log(`\n🔝 TOP 10 ARTISTS IN RESULTS:`);
        Object.entries(artistDistribution)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .forEach(([artist, count], i) => {
                const isPri = isPriorityArtist(artist) ? '🎯' : '  ';
                console.log(`   ${isPri} ${(i + 1).toString().padStart(2)}. ${artist.padEnd(30)} → ${count} songs`);
            });

        console.log(`\n   Latency: ${totalLatency}ms`);
        console.log('╔══════════════════════════════════════════════════════╗');

        return NextResponse.json({
            songs: finalResults.map(({ _score, _baseScore, _popBonus, _artistBonus, _isPriority, _source, ...rest }) => rest),
            stats: {
                total: finalResults.length,
                avgPopularity: Number(avgPopularity.toFixed(2)),
                priorityArtists: priorityArtists,
                priorityArtistStats: priorityArtistStats,
                strategies: strategyStats,
                sources: sourceStats,
                latencyMs: totalLatency,
                fts5Available: globalForDb.fts5Available,
                dbPath: DB_PATH,
                dbCached: wasCached,  // ✅ FIXED: pakai wasCached yang sudah di-set
            }
        });

    } catch (err: any) {
        console.error('❌ [SEARCH FATAL]', err);
        return NextResponse.json(
            { 
                error: err.message, 
                songs: [], 
                debug: { 
                    message: err.message,
                    hint: err.message.includes('DB_URL') 
                        ? 'Set env var BLOB_DB_URL ke URL public file DB Anda (Vercel Blob / R2)' 
                        : undefined
                } 
            },
            { status: 500 }
        );
    }
}