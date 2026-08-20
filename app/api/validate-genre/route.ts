import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let db: Database.Database | null = null;
function getDb(): Database.Database {
    if (!db) {
        const dbPath = path.join(process.cwd(), 'data', 'data.db');
        if (!fs.existsSync(dbPath)) throw new Error(`Database not found at: ${dbPath}`);
        db = new Database(dbPath, { readonly: true });
    }
    return db;
}

function findSongsByGenre(database: Database.Database, genres: string[], limit = 20): any[] {
    if (genres.length === 0) return [];
    const placeholders = genres.map(() => 'LOWER(genre) LIKE LOWER(?)').join(' OR ');
    const patterns = genres.map(g => `%${g}%`);
    try {
        return database.prepare(`
            SELECT artist_name, track_name, genre, popularity
            FROM spotify_data
            WHERE (${placeholders}) AND genre IS NOT NULL AND genre != ''
            ORDER BY popularity DESC LIMIT ?
        `).all(...patterns, limit) as any[];
    } catch { return []; }
}

function findSimilarArtists(database: Database.Database, artist: string, limit = 5): any[] {
    try {
        return database.prepare(`
            SELECT DISTINCT artist_name, genre, popularity
            FROM spotify_data
            WHERE LOWER(artist_name) LIKE LOWER(?) AND genre IS NOT NULL
            ORDER BY popularity DESC LIMIT ?
        `).all(`%${artist}%`, limit) as any[];
    } catch { return []; }
}

// 🆕 Helper: Find songs by specific artist
function findSongsByArtist(database: Database.Database, artist: string, limit = 5): any[] {
    try {
        return database.prepare(`
            SELECT track_name, genre, popularity
            FROM spotify_data
            WHERE LOWER(artist_name) = LOWER(?)
            ORDER BY popularity DESC LIMIT ?
        `).all(artist, limit) as any[];
    } catch { return []; }
}

export async function POST(req: NextRequest) {
    const startTime = Date.now();
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║  🎯 VALIDATE GENRE API - ARTIST-FIRST MODE          ║');
    console.log('╚══════════════════════════════════════════════════════╝');

    try {
        const { artists, selectedGenres, seedSongs } = await req.json();
        console.log(`📥 Input: ${artists.length} artists, ${seedSongs?.length || 0} seed songs`);

        if (!Array.isArray(artists) || artists.length === 0) {
            return NextResponse.json({ error: 'artists array is required' }, { status: 400 });
        }

        const database = getDb();
        const artistGenreData: Record<string, string[]> = {};
        const artistSongData: Record<string, any[]> = {};
        const artistsInDb: string[] = [];
        const artistsNotInDb: string[] = [];

        // 🎯 Query DB for each artist (ground truth data)
        console.log('\n🔍 [0A] Querying artist data from database...');
        for (const artist of artists) {
            try {
                const genres = (database.prepare(`
                    SELECT DISTINCT genre FROM spotify_data 
                    WHERE LOWER(artist_name) = LOWER(?) AND genre IS NOT NULL AND genre != ''
                    LIMIT 10
                `).all(artist) as { genre: string }[]).map(r => r.genre).filter(Boolean);

                const songs = findSongsByArtist(database, artist, 3);

                artistGenreData[artist] = genres;
                artistSongData[artist] = songs;

                if (genres.length > 0) {
                    artistsInDb.push(artist);
                    console.log(`   ✅ "${artist}" → ${genres.length} genres: ${genres.slice(0, 3).join(', ')}`);
                } else {
                    artistsNotInDb.push(artist);
                    console.log(`   ❌ "${artist}" → Not in DB`);
                }
            } catch (err: any) {
                console.warn(`   ⚠️ Error querying "${artist}": ${err.message}`);
                artistsNotInDb.push(artist);
            }
        }

        // Fallback for unknown artists
        const artistGenreFallback: Record<string, any> = {};
        if (artistsNotInDb.length > 0 && selectedGenres.length > 0) {
            const genreSampleSongs = findSongsByGenre(database, selectedGenres, 10);
            for (const artist of artistsNotInDb) {
                artistGenreFallback[artist] = {
                    similarArtists: findSimilarArtists(database, artist, 3).map(s => s.artist_name),
                    sampleSongs: genreSampleSongs.slice(0, 3),
                };
            }
        }

        // 🎯 Build artist info for prompt
        const artistInfo = artists.map(a => {
            const genres = artistGenreData[a] || [];
            const songs = artistSongData[a] || [];
            
            if (genres.length === 0) {
                const fallback = artistGenreFallback[a];
                return `- "${a}" (NOT in DB)\n  Similar: ${fallback?.similarArtists?.join(', ') || 'none'}`;
            }
            
            const songInfo = songs.length > 0 
                ? `\n  Popular songs: ${songs.map(s => `"${s.track_name}" (${s.genre})`).join(', ')}`
                : '';
            return `- "${a}" → Genres: ${genres.join(', ')}${songInfo}`;
        }).join('\n');

        const seedSongInfo = seedSongs && seedSongs.length > 0
            ? `\n\nUSER'S SELECTED SONGS (ground truth):\n${seedSongs.map((s: any) => `- "${s.title}" by ${s.artist}`).join('\n')}`
            : '';

        // 🎯 ARTIST-FIRST PROMPT
        const validationPrompt = `You are a music expert. Your task:
1. ARTISTS and SONGS are the GROUND TRUTH — they define user's taste
2. GENRES are SECONDARY — adjust/correct genres to match the artists
3. NEVER filter out artists — keep ALL of them regardless of genre match
4. Return genres that BEST represent the user's actual taste based on their artist/song picks

USER'S SELECTED GENRES (may be wrong): ${selectedGenres.join(', ') || 'none'}
${seedSongInfo}

ARTISTS + THEIR ACTUAL DATA:
${artistInfo}

Respond in EXACT JSON (no markdown, no extra text):
{
  "validations": [
    {
      "artist": "artist name",
      "inDatabase": true/false,
      "actualGenres": ["genre1", "genre2"],
      "keepArtist": true
    }
  ],
  "finalCorrectedGenres": ["genre1", "genre2", "genre3"],
  "filteredArtists": ["artist1", "artist2", "artist3"],
  "reasoning": "short explanation in Indonesian"
}

Rules:
- filteredArtists: ALWAYS include ALL input artists (artist-first!)
- finalCorrectedGenres: Max 5 genres derived from actual artist genres. Standard names: pop, rock, k-pop, rap, rnb, edm, metal, indie, country, ballad
- If artist is not in DB, infer genre from similar artists
- Keep ALL artists regardless of genre match`;

        let parsed: any = null;
        try {
            const llmRes = await fetch(`${req.nextUrl.origin}/api/chatAPI`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [
                        { role: 'system', content: 'Precise music expert. Artists are ground truth. Always return valid JSON. Never filter artists.' },
                        { role: 'user', content: validationPrompt }
                    ],
                    model: 'gpt-3.5-turbo',
                    stream: false
                })
            });

            if (llmRes.ok) {
                const llmData = await llmRes.json();
                let content = llmData.choices?.[0]?.message?.content || '{}';
                content = content.replace(/```json/g, '').replace(/```/g, '').trim();
                const jsonMatch = content.match(/\{[\s\S]*\}/);
                parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
            } else {
                console.log('⚠️ LLM response not ok, using fallback');
            }
        } catch (llmErr: any) {
            console.warn('⚠️ LLM call error, using fallback:', llmErr.message);
        }

        if (!parsed) {
            parsed = { finalCorrectedGenres: selectedGenres, filteredArtists: artists };
        }

        const correctedGenres = parsed.finalCorrectedGenres || selectedGenres;
        // 🎯 Ensure ALL artists are kept (artist-first)
        const filteredArtists = Array.isArray(parsed.filteredArtists) && parsed.filteredArtists.length > 0
            ? [...new Set([...parsed.filteredArtists, ...artists])]  // Merge to ensure all kept
            : artists;
        
        console.log('\n✅ VALIDATION COMPLETE (Artist-First)');
        console.log(`   Original genres:  ${selectedGenres.join(', ')}`);
        console.log(`   Corrected genres: ${correctedGenres.join(', ')}`);
        console.log(`   All ${filteredArtists.length} artists KEPT (artist-first)`);
        console.log(`   Reasoning: ${parsed.reasoning || 'N/A'}`);

        return NextResponse.json({
            success: true,
            artistGenreData,
            artistsInDb,
            artistsNotInDb,
            validations: parsed.validations || [],
            correctedGenres,
            filteredArtists,
            reasoning: parsed.reasoning || '',
            latencyMs: Date.now() - startTime,
            fallback: false
        });

    } catch (err: any) {
        console.error('❌ [VALIDATE GENRE ERROR]', err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}