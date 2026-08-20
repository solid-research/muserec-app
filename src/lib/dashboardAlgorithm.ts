import { 
    SearchSession, 
    RecommendationRecord, 
    SongInteraction,
    PlaylistSong 
} from "../solid-storage";

// ═══════════════════════════════════════════════════════════════════
// 🎯 TYPE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════

export type ScoreMap = Record<string, number>;

export interface ScoredSong {
    song: PlaylistSong;
    playlistId: string;
    score: number;
    reasons: string[];
    behaviorScore: number;
    assignedGenre: string;
}

export interface DashboardInsights {
    topGenres: Array<{ name: string; score: number; slot: number }>;
    topArtists: Array<{ name: string; score: number }>;
    topSongs: ScoredSong[];
    totalSessions: number;
    totalInteractions: number;
    genreSource: ScoreMap;
    artistSource: ScoreMap;
    allocationBreakdown: Array<{ genre: string; picked: number; target: number }>;
}

// ═══════════════════════════════════════════════════════════════════
// ⚙️  SCORING WEIGHTS (NO BOOST - DIRECT SCORING ONLY)
// ═══════════════════════════════════════════════════════════════════

const WEIGHTS = {
    // (1) Search session contribution
    sessionGenre: 1,
    sessionArtist: 1,
    sessionPlaylist: 1,
    
    // (2) Behavior contribution
    preview: 1,
    like: 1,
    dislike: -1,
};

const MAX_SONGS_PER_ARTIST = 2;  // Artist diversity constraint
const GENERAL_BUCKET = '__general__';

// ═══════════════════════════════════════════════════════════════════
// 📊 (1) SEARCH SESSION STATISTICS
// ═══════════════════════════════════════════════════════════════════

function analyzeSessions(sessions: SearchSession[], playlists: RecommendationRecord[]) {
    const genreScores: ScoreMap = {};
    const artistScores: ScoreMap = {};
    const songScores: ScoreMap = {};
    
    for (const session of sessions) {
        // Genre frequency dari user's choices
        for (const genre of session.correctedGenres || session.originalGenres || []) {
            const g = genre.toLowerCase().trim();
            if (g) genreScores[g] = (genreScores[g] || 0) + WEIGHTS.sessionGenre;
        }
        
        // Find linked playlist
        const playlist = playlists.find(
            p => p.sessionId === session.sessionId || p.playlistUrl === session.playlistUrl
        );
        
        if (playlist) {
            // Artist count dari playlist songs
            const artistCount: ScoreMap = {};
            for (const song of playlist.songs) {
                const a = song.artist.toLowerCase().trim();
                artistCount[a] = (artistCount[a] || 0) + 1;
            }
            for (const [artist, count] of Object.entries(artistCount)) {
                if (artist) {
                    artistScores[artist] = (artistScores[artist] || 0) + (WEIGHTS.sessionArtist * count);
                }
            }
            
            // Song scores dari session playlist
            for (const song of playlist.songs) {
                const key = `${song.title.toLowerCase()}||${song.artist.toLowerCase()}`;
                songScores[key] = (songScores[key] || 0) + WEIGHTS.sessionPlaylist;
            }
        }
    }
    
    return { genreScores, artistScores, songScores };
}

// ═══════════════════════════════════════════════════════════════════
// ❤️ (2) BEHAVIOR ANALYSIS
// ═══════════════════════════════════════════════════════════════════

function analyzeBehavior(interactions: SongInteraction[], playlists: RecommendationRecord[]) {
    const genreScores: ScoreMap = {};
    const artistScores: ScoreMap = {};
    const songScores: ScoreMap = {};
    
    // Build lookup untuk resolve genre
    const songLookup = new Map<string, { title: string; artist: string; genre?: string }>();
    for (const playlist of playlists) {
        for (const song of playlist.songs) {
            songLookup.set(song.songUrl, {
                title: song.title,
                artist: song.artist,
                genre: (song as any).genre,
            });
        }
    }
    
    for (const interaction of interactions) {
        // Map action ke score
        let actionScore = 0;
        if (interaction.action === 'preview') actionScore = WEIGHTS.preview;
        else if (interaction.action === 'like') actionScore = WEIGHTS.like;
        else if (interaction.action === 'dislike') actionScore = WEIGHTS.dislike;
        
        if (actionScore === 0) continue;
        
        const songInfo = songLookup.get(interaction.songRef) || {
            title: interaction.resolvedTitle || 'Unknown',
            artist: interaction.resolvedArtist || 'Unknown',
        };
        
        // Artist score
        const artist = songInfo.artist.toLowerCase().trim();
        if (artist && artist !== 'unknown') {
            artistScores[artist] = (artistScores[artist] || 0) + actionScore;
        }
        
        // Song score
        songScores[interaction.songRef] = (songScores[interaction.songRef] || 0) + actionScore;
        
        // Genre score (jika ada metadata)
        if (songInfo.genre) {
            const g = songInfo.genre.toLowerCase().trim();
            genreScores[g] = (genreScores[g] || 0) + actionScore;
        }
    }
    
    return { genreScores, artistScores, songScores };
}

// ═══════════════════════════════════════════════════════════════════
// 🎯 HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

/**
 * Seeded shuffle using a linear congruential generator.
 * Produces a deterministic-but-different order for each seed value.
 */
function seededShuffle<T>(arr: T[], seed: number): T[] {
    const a = [...arr];
    let s = (seed + 1) >>> 0;            // ensure unsigned 32-bit
    for (let i = a.length - 1; i > 0; i--) {
        s = Math.imul(s, 1664525) + 1013904223 >>> 0;  // LCG step
        const j = s % (i + 1);
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function mergeScores(a: ScoreMap, b: ScoreMap): ScoreMap {
    const merged = { ...a };
    for (const [key, val] of Object.entries(b)) {
        merged[key] = (merged[key] || 0) + val;
    }
    return merged;
}

function rankScores(map: ScoreMap): Array<{ name: string; score: number }> {
    return Object.entries(map)
        .map(([name, score]) => ({ name, score }))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score);
}

// ═══════════════════════════════════════════════════════════════════
// 📊 ALLOCATE GENRE SLOTS (Proportional Distribution)
// ═══════════════════════════════════════════════════════════════════

/**
 * Distribusikan kuota lagu per genre berdasarkan skor.
 * Pakai Largest Remainder Method untuk fairness saat pembulatan.
 */
function allocateGenreSlots(
    topGenres: Array<{ name: string; score: number }>, 
    limit: number
): Map<string, number> {
    const slots = new Map<string, number>();
    const totalScore = topGenres.reduce((sum, g) => sum + Math.max(g.score, 0), 0);
    
    if (totalScore === 0 || topGenres.length === 0) {
        return slots;
    }
    
    // Hitung kuota eksak (float)
    const exactSlots = topGenres.map(g => ({
        genre: g.name,
        exact: (g.score / totalScore) * limit,
    }));
    
    // Round down dulu, track fractional
    let allocated = 0;
    const fractional: Array<{ genre: string; frac: number }> = [];
    
    for (const slot of exactSlots) {
        const rounded = Math.floor(slot.exact);
        slots.set(slot.genre, rounded);
        allocated += rounded;
        fractional.push({ genre: slot.genre, frac: slot.exact - rounded });
    }
    
    // Distribusikan sisa ke yang fractional terbesar
    let remaining = limit - allocated;
    fractional.sort((a, b) => b.frac - a.frac);
    
    for (const item of fractional) {
        if (remaining <= 0) break;
        slots.set(item.genre, (slots.get(item.genre) || 0) + 1);
        remaining--;
    }
    
    return slots;
}

// ═══════════════════════════════════════════════════════════════════
// 🎯 PICK SONGS WITH ARTIST DIVERSITY
// ═══════════════════════════════════════════════════════════════════

function pickWithArtistDiversity(
    pool: ScoredSong[],
    count: number,
    artistCounts: Map<string, number>,
    maxPerArtist: number = MAX_SONGS_PER_ARTIST
): { picked: ScoredSong[]; remaining: ScoredSong[] } {
    const picked: ScoredSong[] = [];
    const remaining: ScoredSong[] = [];
    
    for (const song of pool) {
        const artist = song.song.artist.toLowerCase().trim();
        const currentCount = artistCounts.get(artist) || 0;
        
        if (picked.length < count && currentCount < maxPerArtist) {
            picked.push(song);
            artistCounts.set(artist, currentCount + 1);
        } else {
            remaining.push(song);
        }
    }
    
    return { picked, remaining };
}

// ═══════════════════════════════════════════════════════════════════
// 🎵 ASSIGN GENRE KE SETIAP SONG
// ═══════════════════════════════════════════════════════════════════

function assignGenreToSong(
    song: PlaylistSong,
    sessionGenreLookup: Map<string, string>,
): string {
    // 1️⃣ Metadata langsung
    const metaGenre = (song as any).genre;
    if (metaGenre && typeof metaGenre === 'string') {
        const g = metaGenre.toLowerCase().trim();
        if (g) return g;
    }
    
    // 2️⃣ Infer dari session yang merekomendasikannya
    const fromSession = sessionGenreLookup.get(song.songUrl);
    if (fromSession) return fromSession;
    
    // 3️⃣ Fallback
    return GENERAL_BUCKET;
}

// ═══════════════════════════════════════════════════════════════════
// 🎯 MAIN ALGORITHM (Simplified - No Boost)
// ═══════════════════════════════════════════════════════════════════

export function generateSmartRecommendations(
    sessions: SearchSession[],
    playlists: RecommendationRecord[],
    interactions: SongInteraction[],
    limit: number = 5,
    shuffleSeed: number = 0
): DashboardInsights {
    
    // (1) Search Session Statistics
    const sessionStats = analyzeSessions(sessions, playlists);
    
    // (2) Behavior Analysis
    const behaviorStats = analyzeBehavior(interactions, playlists);
    
    // AGGREGATE: gabungkan kedua sumber
    const finalGenres = mergeScores(sessionStats.genreScores, behaviorStats.genreScores);
    const finalArtists = mergeScores(sessionStats.artistScores, behaviorStats.artistScores);
    
    // Top genres & artists (sorted) — tetap untuk UI card
    const topGenres = rankScores(finalGenres);
    const topArtists = rankScores(finalArtists);
    
    // 🎯 Alokasi slot per genre
    const genreSlots = allocateGenreSlots(topGenres, limit);
    
    // 🎵 Build lookup: songUrl → genre (dari session yang merekomendasikannya)
    const songToSessionGenre = new Map<string, string>();
    for (const session of sessions) {
        const playlist = playlists.find(
            p => p.sessionId === session.sessionId || p.playlistUrl === session.playlistUrl
        );
        if (!playlist) continue;
        
        // Ambil genre pertama dari session sebagai inferensi
        const sessionGenre = (session.correctedGenres?.[0] || session.originalGenres?.[0] || '')
            .toLowerCase().trim();
        if (!sessionGenre) continue;
        
        for (const song of playlist.songs) {
            if (!songToSessionGenre.has(song.songUrl)) {
                songToSessionGenre.set(song.songUrl, sessionGenre);
            }
        }
    }
    
    // 🎵 Score semua songs (DIRECT SCORING - no boost)
    const allSongs: ScoredSong[] = [];
    
    for (const playlist of playlists) {
        for (const song of playlist.songs) {
            const key = `${song.title.toLowerCase()}||${song.artist.toLowerCase()}`;
            const artist = song.artist.toLowerCase().trim();
            
            // 🎯 DIRECT SCORING: session + behavior only
            const sessionScore = sessionStats.songScores[key] || 0;
            const behaviorScore = behaviorStats.songScores[song.songUrl] || 0;
            const totalScore = sessionScore + behaviorScore;
            
            // Assign genre
            const assignedGenre = assignGenreToSong(song, songToSessionGenre);
            
            // Build reasons — straightforward, factual
            const reasons: string[] = [];
            
            // Reason 1: Direct behavior
            if (behaviorScore > 0) {
                if (behaviorScore >= WEIGHTS.like) {
                    reasons.push(`You liked this song`);
                } else {
                    reasons.push(`You previewed this song`);
                }
            }
            
            // Reason 2: Artist popularity (factual, bukan boost)
            const artistInteractionCount = finalArtists[artist] || 0;
            if (artistInteractionCount >= 2 && reasons.length === 0) {
                reasons.push(`You like ${song.artist}`);
            }
            
            // Reason 3: Genre match
            if (assignedGenre !== GENERAL_BUCKET && reasons.length === 0) {
                reasons.push(`Based on your ${assignedGenre} taste`);
            }
            
            // Reason 4: Session appearance
            if (sessionScore > 0 && reasons.length === 0) {
                reasons.push("From your search history");
            }
            
            // Default fallback
            if (reasons.length === 0) {
                reasons.push("Recommended for you");
            }
            
            allSongs.push({
                song,
                playlistId: playlist.recordId,
                score: totalScore,
                reasons,
                behaviorScore,
                assignedGenre,
            });
        }
    }
    
    // Filter out songs with negative score (disliked).
    // Shuffle first (seeded) so equal-score ties break differently each reload.
    const candidates = seededShuffle(
        allSongs.filter(s => s.score >= 0),
        shuffleSeed
    ).sort((a, b) => b.score - a.score);
    
    // 🎯 PICK SONGS PER GENRE (dengan artist diversity)
    const picked: ScoredSong[] = [];
    const artistCounts = new Map<string, number>();
    const allocationBreakdown: Array<{ genre: string; picked: number; target: number }> = [];
    
    // Urutkan genre by score (prioritas tinggi dulu)
    const orderedGenres = [...topGenres]
        .filter(g => genreSlots.has(g.name))
        .sort((a, b) => b.score - a.score);
    
    const usedSongs = new Set<string>();
    
    for (const { name: genre } of orderedGenres) {
        const target = genreSlots.get(genre) || 0;
        if (target === 0) continue;
        
        // Filter pool untuk genre ini (yang belum dipakai)
        const genrePool = candidates.filter(s => 
            s.assignedGenre === genre && !usedSongs.has(s.song.songUrl)
        );
        
        const { picked: genrePicked } = pickWithArtistDiversity(
            genrePool, 
            target, 
            artistCounts
        );
        
        for (const s of genrePicked) {
            picked.push(s);
            usedSongs.add(s.song.songUrl);
        }
        
        allocationBreakdown.push({
            genre,
            picked: genrePicked.length,
            target,
        });
    }
    
    // 🔄 BACKFILL: jika kuota belum terpenuhi
    if (picked.length < limit) {
        const remaining = candidates.filter(s => !usedSongs.has(s.song.songUrl));
        const { picked: extra } = pickWithArtistDiversity(
            remaining,
            limit - picked.length,
            artistCounts
        );
        picked.push(...extra);
        
        // Update breakdown
        const generalEntry = allocationBreakdown.find(b => b.genre === GENERAL_BUCKET);
        if (generalEntry) {
            generalEntry.picked += extra.length;
        } else if (extra.length > 0) {
            allocationBreakdown.push({
                genre: 'other',
                picked: extra.length,
                target: extra.length,
            });
        }
    }
    
    // Final sort by score (terbaik di atas)
    picked.sort((a, b) => b.score - a.score);
    
    // 📊 Build topGenres dengan slot info (untuk UI)
    const topGenresWithSlots = topGenres.slice(0, 5).map(g => ({
        name: g.name,
        score: g.score,
        slot: genreSlots.get(g.name) || 0,
    }));
    
    return {
        topGenres: topGenresWithSlots,
        topArtists: topArtists.slice(0, 5),
        topSongs: picked.slice(0, limit),
        totalSessions: sessions.length,
        totalInteractions: interactions.length,
        genreSource: finalGenres,
        artistSource: finalArtists,
        allocationBreakdown,
    };
}