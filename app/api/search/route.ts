import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const globalForDb = globalThis as unknown as {
    db: InstanceType<typeof Database> | null;
    fts5Available: boolean | null;
};

function getDb() {
    if (!globalForDb.db) {
        const dbPath = path.join(process.cwd(), 'data', 'data.db');
        if (!fs.existsSync(dbPath)) {
            throw new Error(`Database not found at: ${dbPath}`);
        }
        globalForDb.db = new Database(dbPath, { readonly: true });
        try {
            const tables = globalForDb.db
                .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%fts%'`)
                .all();
            globalForDb.fts5Available = tables.length > 0;
        } catch {
            globalForDb.fts5Available = false;
        }
    }
    return globalForDb.db;
}

function sanitize(str: string): string {
    return str.replace(/[^a-zA-Z0-9\s]/g, '').trim();
}

function popularityBonus(popularity: number | null | undefined): number {
    if (popularity == null) return 0;
    return Math.min(100, Math.max(0, popularity));
}

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

        // 🎯 PRIORITY ARTISTS: gabungan semua artist pilihan user (deduplicate, case-insensitive)
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

        const database = getDb();
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

            // 🎯 SCORING: artistBonus (300) + baseScore + popularityBonus (0-100)
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
        // 🎯 STRATEGY 0: PRIORITY ARTISTS - GUARANTEED SLOTS (25/artist)
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
        // STRATEGY 1B: PARTIAL ARTIST MATCH (artistsNotInDb)
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
        // 📊 STATISTIK PER ARTIST
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

        console.log(`\n✅ SEARCH COMPLETE`);
        console.log(`   Total candidates: ${finalResults.length}`);
        console.log(`   Avg popularity:   ${avgPopularity.toFixed(1)}`);
        console.log(`   Strategy stats:   ${JSON.stringify(strategyStats)}`);
        console.log(`   Source dist:      ${JSON.stringify(sourceStats)}`);
        
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

        console.log(`\n   Latency: ${Date.now() - startTime}ms`);
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
                latencyMs: Date.now() - startTime,
                fts5Available: globalForDb.fts5Available,
            }
        });

    } catch (err: any) {
        console.error('❌ [SEARCH FATAL]', err);
        return NextResponse.json(
            { error: err.message, songs: [], debug: { message: err.message } },
            { status: 500 }
        );
    }
}