import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export const runtime = 'nodejs';

let db: Database.Database | null = null;
function getDb(): Database.Database {
    if (!db) {
        const dbPath = path.resolve(process.cwd(), 'data/data.db');
        if (!fs.existsSync(dbPath)) {
            throw new Error(`Database not found at: ${dbPath}`);
        }
        db = new Database(dbPath, { readonly: true });
    }
    return db;
}

function normalize(str: string): string {
    return str.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim();
}

interface SongInput {
    title: string;
    artist: string;
}

interface SongResult {
    originalTitle: string;
    originalArtist: string;
    found: boolean;
    matchedTitle?: string;
    matchedArtist?: string;
    genre?: string;
    popularity?: number;
    matchMethod?: 'exact' | 'fts5' | 'like' | 'partial' | 'artist-only';
    confidence?: 'high' | 'medium' | 'low' | 'none';
}

export async function POST(req: NextRequest) {
    const startTime = Date.now();
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║  ✅ SONGS VALIDATION API - Anti-Hallucination        ║');
    console.log('╚══════════════════════════════════════════════════════╝');

    try {
        const { songs }: { songs: SongInput[] } = await req.json();
        console.log(`📥 Validating ${songs.length} songs from LLM picks`);
        songs.forEach((s, i) => console.log(`   ${i + 1}. "${s.title}" by ${s.artist}`));

        if (!Array.isArray(songs)) {
            return NextResponse.json({ error: 'songs must be an array' }, { status: 400 });
        }

        const database = getDb();
        const results: SongResult[] = [];

        for (const song of songs) {
            const { title, artist } = song;
            console.log(`\n🔍 Validating: "${title}" by ${artist}`);

            // ═══════════════════════════════════════════
            // Strategy 1: Exact match (case-insensitive)
            // ═══════════════════════════════════════════
            const exactMatch = database
                .prepare(`SELECT artist_name, track_name, genre, popularity FROM spotify_data
                           WHERE LOWER(track_name) = LOWER(?) AND LOWER(artist_name) = LOWER(?)
                           LIMIT 1`)
                .get(title, artist) as any;

            if (exactMatch) {
                console.log(`   ✅ EXACT MATCH → "${exactMatch.track_name}" by ${exactMatch.artist_name} (pop: ${exactMatch.popularity})`);
                results.push({
                    originalTitle: title,
                    originalArtist: artist,
                    found: true,
                    matchedTitle: exactMatch.track_name,
                    matchedArtist: exactMatch.artist_name,
                    genre: exactMatch.genre,
                    popularity: exactMatch.popularity,
                    matchMethod: 'exact',
                    confidence: 'high',
                });
                continue;
            }

            // ═══════════════════════════════════════════
            // Strategy 2: FTS5 fuzzy search (sorted by popularity)
            // ═══════════════════════════════════════════
            try {
                const normTitle = normalize(title);
                const normArtist = normalize(artist);
                const ftsQuery = `"${normTitle}" OR "${normArtist}"`;
                const ftsMatches = database
                    .prepare(`SELECT s.artist_name, s.track_name, s.genre, s.popularity
                               FROM spotify_data_fts f
                               JOIN spotify_data s ON s.track_id = f.track_id
                               WHERE spotify_data_fts MATCH ?
                               ORDER BY s.popularity DESC, rank
                               LIMIT 10`)
                    .all(ftsQuery) as any[];

                if (ftsMatches.length > 0) {
                    const titleWords = normTitle.split(' ').filter(w => w.length >= 3);
                    const artistWords = normArtist.split(' ').filter(w => w.length >= 3);

                    const bestMatch = 
                        ftsMatches.find(row => {
                            const rowTitle = normalize(row.track_name);
                            const rowArtist = normalize(row.artist_name);
                            return (
                                titleWords.some(w => rowTitle.includes(w)) &&
                                artistWords.some(w => rowArtist.includes(w))
                            );
                        }) ||
                        ftsMatches.find(row => 
                            titleWords.some(w => normalize(row.track_name).includes(w))
                        ) ||
                        ftsMatches[0];

                    console.log(`   ✅ FTS5 MATCH → "${bestMatch.track_name}" by ${bestMatch.artist_name} (pop: ${bestMatch.popularity})`);
                    results.push({
                        originalTitle: title,
                        originalArtist: artist,
                        found: true,
                        matchedTitle: bestMatch.track_name,
                        matchedArtist: bestMatch.artist_name,
                        genre: bestMatch.genre,
                        popularity: bestMatch.popularity,
                        matchMethod: 'fts5',
                        confidence: 'medium',
                    });
                    continue;
                }
            } catch (err: any) {
                console.warn(`   ⚠️ FTS5 failed: ${err.message}`);
            }

            // ═══════════════════════════════════════════
            // Strategy 3: LIKE match (sorted by popularity)
            // ═══════════════════════════════════════════
            const likeMatch = database
                .prepare(`SELECT artist_name, track_name, genre, popularity FROM spotify_data
                           WHERE LOWER(track_name) LIKE ? AND LOWER(artist_name) LIKE ?
                           ORDER BY popularity DESC
                           LIMIT 1`)
                .get(`%${normalize(title)}%`, `%${normalize(artist)}%`) as any;

            if (likeMatch) {
                console.log(`   ✅ LIKE MATCH → "${likeMatch.track_name}" by ${likeMatch.artist_name} (pop: ${likeMatch.popularity})`);
                results.push({
                    originalTitle: title,
                    originalArtist: artist,
                    found: true,
                    matchedTitle: likeMatch.track_name,
                    matchedArtist: likeMatch.artist_name,
                    genre: likeMatch.genre,
                    popularity: likeMatch.popularity,
                    matchMethod: 'like',
                    confidence: 'medium',
                });
                continue;
            }

            // ═══════════════════════════════════════════
            // Strategy 4: Partial match (title only, different artist)
            // ═══════════════════════════════════════════
            const partialMatches = database
                .prepare(`SELECT artist_name, track_name, genre, popularity FROM spotify_data
                           WHERE LOWER(track_name) LIKE ?
                           ORDER BY popularity DESC
                           LIMIT 3`)
                .all(`%${normalize(title)}%`) as any[];

            if (partialMatches.length > 0) {
                const artistNorm = normalize(artist);
                const bestPartial = partialMatches.find(row => 
                    normalize(row.artist_name).includes(artistNorm.split(' ')[0])
                ) || partialMatches[0];

                console.log(`   ⚠️ PARTIAL MATCH → "${bestPartial.track_name}" by ${bestPartial.artist_name} (pop: ${bestPartial.popularity})`);
                results.push({
                    originalTitle: title,
                    originalArtist: artist,
                    found: true,
                    matchedTitle: bestPartial.track_name,
                    matchedArtist: bestPartial.artist_name,
                    genre: bestPartial.genre,
                    popularity: bestPartial.popularity,
                    matchMethod: 'partial',
                    confidence: 'low',
                });
                continue;
            }

            // ═══════════════════════════════════════════
            // Strategy 5: Artist-only (replace hallucinated title with top song)
            // ═══════════════════════════════════════════
            const artistOnlyMatch = database
                .prepare(`SELECT artist_name, track_name, genre, popularity FROM spotify_data
                           WHERE LOWER(artist_name) = LOWER(?)
                           ORDER BY popularity DESC
                           LIMIT 1`)
                .get(artist) as any;

            if (artistOnlyMatch) {
                console.log(`   ⚠️ ARTIST-ONLY → replaced with "${artistOnlyMatch.track_name}" (pop: ${artistOnlyMatch.popularity})`);
                results.push({
                    originalTitle: title,
                    originalArtist: artist,
                    found: true,
                    matchedTitle: artistOnlyMatch.track_name,
                    matchedArtist: artistOnlyMatch.artist_name,
                    genre: artistOnlyMatch.genre,
                    popularity: artistOnlyMatch.popularity,
                    matchMethod: 'artist-only',
                    confidence: 'low',
                });
                continue;
            }

            // ═══════════════════════════════════════════
            // ❌ NOT FOUND - Anti-hallucination
            // ═══════════════════════════════════════════
            console.log(`   ❌ NOT FOUND (hallucination detected)`);
            results.push({
                originalTitle: title,
                originalArtist: artist,
                found: false,
                confidence: 'none',
            });
        }

        const foundCount = results.filter(r => r.found).length;
        const hallucinatedCount = results.filter(r => !r.found).length;
        const highConf = results.filter(r => r.confidence === 'high').length;
        const medConf = results.filter(r => r.confidence === 'medium').length;
        const lowConf = results.filter(r => r.confidence === 'low').length;

        console.log(`\n✅ VALIDATION COMPLETE`);
        console.log(`   Found:        ${foundCount}/${results.length}`);
        console.log(`   Hallucinated: ${hallucinatedCount}/${results.length}`);
        console.log(`   Confidence:   high=${highConf}, medium=${medConf}, low=${lowConf}`);
        console.log(`   Methods:      ${results.filter(r => r.found).map(r => r.matchMethod).join(', ') || 'none'}`);
        console.log(`   Latency:      ${Date.now() - startTime}ms`);
        console.log('╔══════════════════════════════════════════════════════╗');

        return NextResponse.json({ 
            results,
            stats: {
                total: results.length,
                found: foundCount,
                hallucinated: hallucinatedCount,
                confidenceBreakdown: { high: highConf, medium: medConf, low: lowConf },
                latencyMs: Date.now() - startTime,
            }
        });

    } catch (err: any) {
        console.error('❌ [SONGS ERROR]', err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}