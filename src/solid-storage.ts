import {
    getSolidDataset, saveSolidDatasetAt, createSolidDataset, setThing,
    buildThing, createThing, getThingAll, getThing, getStringNoLocale,
    getStringNoLocaleAll, getUrl, getUrlAll, getInteger, getDatetime
} from '@inrupt/solid-client';
import { v4 as uuidv4 } from 'uuid';

const SCHEMA = "https://schema.org/";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

export const POD_FILES = {
    SETTINGS: 'settings.ttl',
    SEEDS: 'seeds.ttl',
    SESSIONS: 'sessions.ttl',
    PLAYLISTS: 'playlists.ttl',
    BEHAVE: 'behave-knowledge.ttl'
};

// ═══════════════════════════════════════════════════════════════════
// 🛡️ UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

const normalizeStorageRoot = (storageRoot: string): string => {
    if (!storageRoot) return '';
    return storageRoot.endsWith('/') ? storageRoot : `${storageRoot}/`;
};

const getFileUrl = (storageRoot: string, fileName: string): string => {
    const root = normalizeStorageRoot(storageRoot);
    return `${root}public/music-rec-data/${fileName}`;
};

const isNotFoundError = (e: any): boolean => {
    if (!e) return false;
    const status = e.statusCode || e.status || e.response?.status;
    const message = (e.message || '').toLowerCase();
    return (
        status === 404 || status === 403 ||
        message.includes('404') || message.includes('403') ||
        message.includes('not found') || message.includes('forbidden')
    );
};

const makeSafeId = (input: string): string => {
    if (!input) return 'unknown';
    return input
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 80) || 'unknown';
};

// ═══════════════════════════════════════════════════════════════════
// 🎯 DEDUPLICATION HELPERS (NEW)
// ═══════════════════════════════════════════════════════════════════

/**
 * Normalize string untuk matching (case-insensitive, accent-insensitive, symbol-insensitive)
 * "Bohemian Rhapsody" == "bohemian rhapsody" == "Böhemian Rhapsody!"
 */
const normalizeForMatch = (s: string): string => {
    if (!s) return '';
    return s
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
};

/**
 * Generate deterministic fingerprint dari (title, artist) untuk URL yang stabil.
 * Menggunakan djb2 hash - cepat, deterministic, collision rate rendah.
 */
const recordingFingerprint = (title: string, artist: string): string => {
    const combined = `${normalizeForMatch(title)}|${normalizeForMatch(artist)}`;
    let hash = 5381;
    for (let i = 0; i < combined.length; i++) {
        hash = ((hash << 5) + hash) + combined.charCodeAt(i);
        hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
};

/**
 * Find existing MusicRecording di dataset yang match (title, artist).
 * Return URL jika ketemu, null jika tidak.
 */
const findExistingRecording = (dataset: any, title: string, artist: string): string | null => {
    const targetTitle = normalizeForMatch(title);
    const targetArtist = normalizeForMatch(artist);

    for (const thing of getThingAll(dataset)) {
        const types = getUrlAll(thing, RDF_TYPE) || [];
        if (!types.includes(`${SCHEMA}MusicRecording`)) continue;

        const name = getStringNoLocale(thing, `${SCHEMA}name`) || '';
        if (normalizeForMatch(name) !== targetTitle) continue;

        const artistUrl = getUrl(thing, `${SCHEMA}byArtist`);
        if (!artistUrl) continue;

        const artistThing = getThing(dataset, artistUrl);
        const artistName = artistThing
            ? getStringNoLocale(artistThing, `${SCHEMA}name`) || ''
            : '';
        if (normalizeForMatch(artistName) !== targetArtist) continue;

        return thing.url;
    }
    return null;
};

/**
 * Ensure artist Thing exists (shared / deduplicated by safe ID).
 * Return dataset (possibly updated) + artistUrl.
 */
const ensureArtist = (dataset: any, fileUrl: string, artistName: string): { dataset: any; artistUrl: string } => {
    const artistId = makeSafeId(artistName);
    const artistUrl = `${fileUrl}#artist-${artistId}`;

    if (!getThing(dataset, artistUrl)) {
        dataset = setThing(
            dataset,
            buildThing(createThing({ url: artistUrl }))
                .addUrl(RDF_TYPE, `${SCHEMA}MusicGroup`)
                .addStringNoLocale(`${SCHEMA}name`, artistName)
                .build()
        );
    }

    return { dataset, artistUrl };
};

/**
 * Get or create a MusicRecording for (title, artist).
 * - If same (title, artist) already exists → reuse URL (isNew = false)
 * - Otherwise → create new #recording-{hash} (isNew = true)
 * - Handle rare hash collisions by appending counter.
 */
const getOrCreateRecording = (
    dataset: any,
    fileUrl: string,
    title: string,
    artist: string,
    timestamp?: Date
): { dataset: any; recordingUrl: string; isNew: boolean } => {
    // 1. Cek apakah sudah ada recording dengan (title, artist) yang sama
    const existing = findExistingRecording(dataset, title, artist);
    if (existing) {
        return { dataset, recordingUrl: existing, isNew: false };
    }

    // 2. Generate URL deterministik
    const hash = recordingFingerprint(title, artist);
    let recordingUrl = `${fileUrl}#recording-${hash}`;

    // 3. Handle hash collision (very rare, tapi defensive)
    let counter = 1;
    let existingThing = getThing(dataset, recordingUrl);
    while (existingThing) {
        // Check if it's actually the same recording (URL conflict karena hash collision)
        const exName = getStringNoLocale(existingThing, `${SCHEMA}name`) || '';
        const exArtistUrl = getUrl(existingThing, `${SCHEMA}byArtist`);
        const exArtistThing = exArtistUrl ? getThing(dataset, exArtistUrl) : null;
        const exArtistName = exArtistThing
            ? getStringNoLocale(exArtistThing, `${SCHEMA}name`) || ''
            : '';

        // Jika benar-benar sama (hash collision tapi same song), reuse
        if (normalizeForMatch(exName) === normalizeForMatch(title) &&
            normalizeForMatch(exArtistName) === normalizeForMatch(artist)) {
            return { dataset, recordingUrl, isNew: false };
        }

        // Real collision - beda lagu, hash sama → append counter
        recordingUrl = `${fileUrl}#recording-${hash}-${counter++}`;
        existingThing = getThing(dataset, recordingUrl);
    }

    // 4. Create artist (shared) + recording (new)
    const artistResult = ensureArtist(dataset, fileUrl, artist);
    dataset = artistResult.dataset;

    let recordingBuilder = buildThing(createThing({ url: recordingUrl }))
        .addUrl(RDF_TYPE, `${SCHEMA}MusicRecording`)
        .addStringNoLocale(`${SCHEMA}name`, title)
        .addUrl(`${SCHEMA}byArtist`, artistResult.artistUrl);

    if (timestamp) {
        recordingBuilder.addDatetime(`${SCHEMA}dateCreated`, timestamp);
    }

    dataset = setThing(dataset, recordingBuilder.build());

    return { dataset, recordingUrl, isNew: true };
};

// ═══════════════════════════════════════════════════════════════════
// 📁 POD INITIALIZATION
// ═══════════════════════════════════════════════════════════════════

export async function initializePodFiles(storageRoot: string, fetch: any): Promise<void> {
    console.log('🚀 Initializing 5 Pod files (lazy creation)...');
    const files = [
        POD_FILES.SETTINGS, POD_FILES.SEEDS, POD_FILES.SESSIONS,
        POD_FILES.PLAYLISTS, POD_FILES.BEHAVE
    ];

    for (const fileName of files) {
        const fileUrl = getFileUrl(storageRoot, fileName);
        try {
            await getSolidDataset(fileUrl, { fetch });
        } catch (checkErr: any) {
            if (isNotFoundError(checkErr)) {
                try {
                    const emptyDataset = createSolidDataset();
                    await saveSolidDatasetAt(fileUrl, emptyDataset, { fetch });
                } catch (createErr: any) {
                    console.warn(`⚠️ Could not auto-create ${fileName}: ${createErr.message}`);
                }
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
// 1. SETTINGS.TTL — User Profile
// ═══════════════════════════════════════════════════════════════════

export interface UserSettings {
    ageRange: string;
    genres: string[];
    favoriteArtists: string[];
    feelings: string[];
}

export async function saveSettings(storageRoot: string, settings: UserSettings, fetch: any): Promise<void> {
    const fileUrl = getFileUrl(storageRoot, POD_FILES.SETTINGS);
    let dataset = createSolidDataset();
    try { dataset = await getSolidDataset(fileUrl, { fetch }); }
    catch (e: any) { if (!isNotFoundError(e)) throw e; }

    const userThingUrl = `${fileUrl}#user-profile`;
    const existingThing = getThing(dataset, userThingUrl);
    let userBuilder = existingThing
        ? buildThing(existingThing)
        : buildThing(createThing({ url: userThingUrl })).addUrl(RDF_TYPE, `${SCHEMA}Person`);

    userBuilder.setStringNoLocale(`${SCHEMA}typicalAgeRange`, settings.ageRange);
    settings.genres.forEach(g => userBuilder.addStringNoLocale(`${SCHEMA}genre`, g));
    settings.favoriteArtists.forEach(a => userBuilder.addStringNoLocale(`${SCHEMA}knows`, a));
    settings.feelings.forEach(f => userBuilder.addStringNoLocale(`${SCHEMA}emotion`, f));

    dataset = setThing(dataset, userBuilder.build());
    await saveSolidDatasetAt(fileUrl, dataset, { fetch });
}

export async function loadSettings(storageRoot: string, fetch: any): Promise<UserSettings | null> {
    const fileUrl = getFileUrl(storageRoot, POD_FILES.SETTINGS);
    try {
        const dataset = await getSolidDataset(fileUrl, { fetch });
        const userThing = getThingAll(dataset).find(t => t.url.endsWith('#user-profile'));
        if (!userThing) return null;

        return {
            ageRange: getStringNoLocale(userThing, `${SCHEMA}typicalAgeRange`) || '18',
            genres: getStringNoLocaleAll(userThing, `${SCHEMA}genre`) || [],
            favoriteArtists: getStringNoLocaleAll(userThing, `${SCHEMA}knows`) || [],
            feelings: getStringNoLocaleAll(userThing, `${SCHEMA}emotion`) || []
        };
    } catch (e: any) {
        if (isNotFoundError(e)) return null;
        throw e;
    }
}

// ═══════════════════════════════════════════════════════════════════
// 2. SEEDS.TTL — Master Data: Seed Songs (DEDUPLICATED)
// ═══════════════════════════════════════════════════════════════════

export interface SeedSong {
    seedId: string;
    seedUrl: string;          // Per-session entry URL
    recordingUrl: string;     // Shared deduplicated recording URL
    title: string;
    artist: string;
    artistUrl: string;
    timestamp: Date;
    sourceSessionId?: string;
}

export interface SaveSeedResult {
    seedEntryUrl: string;     // #seed-{sessionId}-{i} — unique per session
    recordingUrl: string;     // #recording-{hash} — shared, deduplicated
    isNewRecording: boolean;  // true if this is first time we see this song
}

/**
 * 🎯 Save seed songs with smart deduplication.
 * - If (title, artist) already exists → reuse recording URL (no duplicate)
 * - Create a per-session entry that references the shared recording
 * 
 * @returns Array of SaveSeedResult with recording URLs for reference in sessions
 */
export async function saveSeedSongs(
    storageRoot: string,
    songs: { title: string; artist: string }[],
    sessionId: string,
    fetch: any
): Promise<SaveSeedResult[]> {
    const fileUrl = getFileUrl(storageRoot, POD_FILES.SEEDS);
    let dataset = createSolidDataset();
    try { dataset = await getSolidDataset(fileUrl, { fetch }); }
    catch (e: any) { if (!isNotFoundError(e)) throw e; }

    const timestamp = new Date();
    const results: SaveSeedResult[] = [];

    songs.forEach((song, i) => {
        // 1. Get or create recording (DEDUPLICATED)
        const recResult = getOrCreateRecording(dataset, fileUrl, song.title, song.artist, timestamp);
        dataset = recResult.dataset;

        // 2. Create per-session seed entry that references the recording
        const seedEntryUrl = `${fileUrl}#seed-${sessionId}-${i}`;

        dataset = setThing(
            dataset,
            buildThing(createThing({ url: seedEntryUrl }))
                .addUrl(RDF_TYPE, `${SCHEMA}ListItem`)      // Entry type
                .addUrl(`${SCHEMA}item`, recResult.recordingUrl) // Points to shared recording
                .addDatetime(`${SCHEMA}dateCreated`, timestamp)
                .addStringNoLocale(`${SCHEMA}identifier`, sessionId)
                .addInteger(`${SCHEMA}position`, i + 1)
                .build()
        );

        results.push({
            seedEntryUrl,
            recordingUrl: recResult.recordingUrl,
            isNewRecording: recResult.isNew
        });
    });

    await saveSolidDatasetAt(fileUrl, dataset, { fetch });

    const newCount = results.filter(r => r.isNewRecording).length;
    const reuseCount = results.length - newCount;
    console.log(`🌱 Saved ${songs.length} seeds (${newCount} new recordings, ${reuseCount} reused)`);

    return results;
}

/**
 * Load seed entries (per-session) + resolve recording metadata.
 * Backward compatible with old format (MusicRecording with schema:identifier).
 */
export async function loadSeedSongs(storageRoot: string, fetch: any): Promise<SeedSong[]> {
    const fileUrl = getFileUrl(storageRoot, POD_FILES.SEEDS);
    try {
        const dataset = await getSolidDataset(fileUrl, { fetch });
        const seeds: SeedSong[] = [];

        for (const thing of getThingAll(dataset)) {
            const types = getUrlAll(thing, RDF_TYPE) || [];

            // ─── NEW FORMAT: ListItem entry referencing a recording ───
            if (types.includes(`${SCHEMA}ListItem`)) {
                const sessionId = getStringNoLocale(thing, `${SCHEMA}identifier`);
                if (!sessionId) continue;

                const recordingUrl = getUrl(thing, `${SCHEMA}item`);
                if (!recordingUrl) continue;

                const recordingThing = getThing(dataset, recordingUrl);
                if (!recordingThing) continue;

                const title = getStringNoLocale(recordingThing, `${SCHEMA}name`) || 'Unknown';
                const artistUrl = getUrl(recordingThing, `${SCHEMA}byArtist`) || '';
                const artistThing = artistUrl ? getThing(dataset, artistUrl) : null;
                const artist = artistThing
                    ? getStringNoLocale(artistThing, `${SCHEMA}name`) || 'Unknown'
                    : 'Unknown';
                const timestamp = getDatetime(thing, `${SCHEMA}dateCreated`) || new Date();
                const seedId = thing.url.split('#')[1] || uuidv4();

                seeds.push({
                    seedId,
                    seedUrl: thing.url,
                    recordingUrl,
                    title, artist, artistUrl,
                    timestamp,
                    sourceSessionId: sessionId
                });
                continue;
            }

            // ─── OLD FORMAT: MusicRecording with schema:identifier (backward compat) ───
            if (types.includes(`${SCHEMA}MusicRecording`)) {
                const sessionId = getStringNoLocale(thing, `${SCHEMA}identifier`);
                if (!sessionId) continue;

                const title = getStringNoLocale(thing, `${SCHEMA}name`) || 'Unknown';
                const artistUrl = getUrl(thing, `${SCHEMA}byArtist`) || '';
                const artistThing = artistUrl ? getThing(dataset, artistUrl) : null;
                const artist = artistThing
                    ? getStringNoLocale(artistThing, `${SCHEMA}name`) || 'Unknown'
                    : 'Unknown';
                const timestamp = getDatetime(thing, `${SCHEMA}dateCreated`) || new Date();
                const seedId = thing.url.split('#')[1] || uuidv4();

                seeds.push({
                    seedId,
                    seedUrl: thing.url,
                    recordingUrl: thing.url, // old format: seed IS the recording
                    title, artist, artistUrl,
                    timestamp,
                    sourceSessionId: sessionId
                });
            }
        }

        return seeds.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    } catch (e: any) {
        if (isNotFoundError(e)) return [];
        return [];
    }
}

export async function getSeedsBySession(storageRoot: string, sessionId: string, fetch: any): Promise<SeedSong[]> {
    const allSeeds = await loadSeedSongs(storageRoot, fetch);
    return allSeeds.filter(s => s.sourceSessionId === sessionId);
}

// ═══════════════════════════════════════════════════════════════════
// 3. SESSIONS.TTL — Search History (With Original + Corrected Genres)
// ═══════════════════════════════════════════════════════════════════

export interface SearchSession {
    sessionId: string;
    query: string;
    vibe?: string;
    originalGenres: string[];
    correctedGenres: string[];
    seedUrls: string[];        // Can now point to either seed entries OR recording URLs
    seedCount: number;
    playlistUrl?: string;
    timestamp: Date;
    resultCount: number;
    genresCorrected: boolean;
}

export async function saveSearchSession(
    storageRoot: string,
    searchSession: SearchSession,
    fetch: any
): Promise<void> {
    const fileUrl = getFileUrl(storageRoot, POD_FILES.SESSIONS);
    let dataset = createSolidDataset();
    try { dataset = await getSolidDataset(fileUrl, { fetch }); }
    catch (e: any) { if (!isNotFoundError(e)) throw e; }

    const sessionUrl = `${fileUrl}#session-${searchSession.sessionId}`;
    const resultUrl = `${fileUrl}#result-${searchSession.sessionId}`;

    let resultBuilder = buildThing(createThing({ url: resultUrl }))
        .addUrl(RDF_TYPE, `${SCHEMA}SearchResultsPage`)
        .addInteger(`${SCHEMA}numberOfItems`, searchSession.resultCount);

    if (searchSession.playlistUrl) {
        resultBuilder.addUrl(`${SCHEMA}about`, searchSession.playlistUrl);
    }
    dataset = setThing(dataset, resultBuilder.build());

    let builder = buildThing(createThing({ url: sessionUrl }))
        .addUrl(RDF_TYPE, `${SCHEMA}SearchAction`)
        .addStringNoLocale(`${SCHEMA}query`, searchSession.query.trim())
        .addDatetime(`${SCHEMA}endTime`, searchSession.timestamp)
        .addInteger(`${SCHEMA}resultCount`, searchSession.resultCount)
        .addUrl(`${SCHEMA}result`, resultUrl);

    searchSession.originalGenres.forEach(g => {
        builder.addStringNoLocale(`${SCHEMA}additionalType`, g);
    });
    searchSession.correctedGenres.forEach(g => {
        builder.addStringNoLocale(`${SCHEMA}genre`, g);
    });
    if (searchSession.genresCorrected) {
        builder.addStringNoLocale(`${SCHEMA}description`, 'genres-corrected');
    }
    searchSession.seedUrls.forEach(seedUrl => {
        builder.addUrl(`${SCHEMA}object`, seedUrl);
    });
    if (searchSession.vibe) {
        builder.addStringNoLocale(`${SCHEMA}keywords`, searchSession.vibe);
    }

    dataset = setThing(dataset, builder.build());
    await saveSolidDatasetAt(fileUrl, dataset, { fetch });
}

export async function loadSearchSessions(storageRoot: string, fetch: any): Promise<SearchSession[]> {
    const fileUrl = getFileUrl(storageRoot, POD_FILES.SESSIONS);
    try {
        const dataset = await getSolidDataset(fileUrl, { fetch });

        return getThingAll(dataset)
            .filter(t => getUrl(t, RDF_TYPE) === `${SCHEMA}SearchAction`)
            .map(t => {
                const resultUrl = getUrl(t, `${SCHEMA}result`);
                const resultThing = resultUrl ? getThing(dataset, resultUrl) : null;
                const resultCount = resultThing ? getInteger(resultThing, `${SCHEMA}numberOfItems`) || 0 : 0;

                const playlistUrl = resultThing ? (getUrl(resultThing, `${SCHEMA}about`) || undefined) : undefined;
                const seedUrls = getUrlAll(t, `${SCHEMA}object`) || [];

                const correctedGenres = getStringNoLocaleAll(t, `${SCHEMA}genre`) || [];
                const originalGenres = getStringNoLocaleAll(t, `${SCHEMA}additionalType`) || [];

                const description = getStringNoLocale(t, `${SCHEMA}description`) || '';
                const genresCorrected = description === 'genres-corrected'
                    || JSON.stringify(originalGenres) !== JSON.stringify(correctedGenres);

                return {
                    sessionId: t.url.split('#session-')[1] || uuidv4(),
                    query: getStringNoLocale(t, `${SCHEMA}query`) || '',
                    vibe: getStringNoLocale(t, `${SCHEMA}keywords`) || undefined,
                    originalGenres,
                    correctedGenres,
                    genresCorrected,
                    seedUrls,
                    seedCount: seedUrls.length,
                    playlistUrl,
                    timestamp: getDatetime(t, `${SCHEMA}endTime`) || new Date(),
                    resultCount: getInteger(t, `${SCHEMA}resultCount`) || resultCount
                };
            })
            .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    } catch (e: any) {
        if (isNotFoundError(e)) return [];
        return [];
    }
}

// ═══════════════════════════════════════════════════════════════════
// 4. PLAYLISTS.TTL — Master Data: Recommendations (DEDUPLICATED)
// ═══════════════════════════════════════════════════════════════════

export interface PlaylistSong {
    songUrl: string;          // Shared recording URL (deduplicated)
    title: string;
    artist: string;
    artistUrl: string;
    cover?: string;           // Album cover URL (optional)
    reason?: string;
    position: number;
}

export interface RecommendationRecord {
    recordId: string;
    playlistUrl: string;
    sessionId?: string;
    sessionUrl?: string;
    timestamp: Date;
    context?: string;
    songs: PlaylistSong[];
    dedupeStats?: { newCount: number; reusedCount: number };  // 🆕 Stats
}

export interface SongToSave {
    title: string;
    artist: string;
    cover?: string;           // Album cover URL (optional)
    reason?: string;
}

/**
 * 🎯 Save playlist with smart song deduplication.
 * - Songs reused from existing recordings when (title, artist) matches
 * - Track entries created per-playlist (because position/reason vary)
 */
export async function saveRecommendations(
    storageRoot: string,
    record: {
        recordId: string;
        sessionId?: string;
        timestamp: Date;
        context?: string;
        songs: SongToSave[];
    },
    fetch: any
): Promise<RecommendationRecord> {
    const fileUrl = getFileUrl(storageRoot, POD_FILES.PLAYLISTS);
    let dataset = createSolidDataset();
    try { dataset = await getSolidDataset(fileUrl, { fetch }); }
    catch (e: any) { if (!isNotFoundError(e)) throw e; }

    const playlistUrl = `${fileUrl}#playlist-${record.recordId}`;
    const sessionsFileUrl = getFileUrl(storageRoot, POD_FILES.SESSIONS);

    let recordBuilder = buildThing(createThing({ url: playlistUrl }))
        .addUrl(RDF_TYPE, `${SCHEMA}MusicPlaylist`)
        .addDatetime(`${SCHEMA}dateCreated`, record.timestamp)
        .addStringNoLocale(`${SCHEMA}name`, `MuseRec Playlist ${record.recordId.substring(0, 8)}`)
        .addInteger(`${SCHEMA}numTracks`, record.songs.length);

    let sessionUrl: string | undefined;
    if (record.sessionId) {
        sessionUrl = `${sessionsFileUrl}#session-${record.sessionId}`;
        recordBuilder.addUrl(`${SCHEMA}about`, sessionUrl);
    }
    if (record.context) {
        recordBuilder.addStringNoLocale(`${SCHEMA}description`, record.context);
    }

    const savedSongs: PlaylistSong[] = [];
    let newCount = 0;
    let reusedCount = 0;

    record.songs.forEach((song, i) => {
        // 1. Get or create recording (DEDUPLICATED across playlists)
        const recResult = getOrCreateRecording(dataset, fileUrl, song.title, song.artist);
        dataset = recResult.dataset;
        if (recResult.isNew) newCount++;
        else reusedCount++;

        // 2. Create track entry per-playlist (holds position + reason)
        const trackEntryUrl = `${fileUrl}#track-${record.recordId}-${i}`;

        let trackBuilder = buildThing(createThing({ url: trackEntryUrl }))
            .addUrl(RDF_TYPE, `${SCHEMA}ListItem`)
            .addUrl(`${SCHEMA}item`, recResult.recordingUrl)
            .addInteger(`${SCHEMA}position`, i + 1);

        if (song.reason) {
            trackBuilder.addStringNoLocale(`${SCHEMA}reviewBody`, song.reason);
        }
        if (song.cover) {
            trackBuilder.addStringNoLocale(`${SCHEMA}image`, song.cover);
        }

        dataset = setThing(dataset, trackBuilder.build());
        recordBuilder.addUrl(`${SCHEMA}track`, trackEntryUrl);

        // Get artist URL for PlaylistSong
        const artistId = makeSafeId(song.artist);
        const artistUrl = `${fileUrl}#artist-${artistId}`;

        savedSongs.push({
            songUrl: recResult.recordingUrl,  // 🆕 Points to shared recording
            title: song.title,
            artist: song.artist,
            artistUrl,
            cover: song.cover,
            reason: song.reason,
            position: i + 1
        });
    });

    dataset = setThing(dataset, recordBuilder.build());
    await saveSolidDatasetAt(fileUrl, dataset, { fetch });

    console.log(`🎵 Playlist saved: ${newCount} new recordings, ${reusedCount} reused`);

    return {
        recordId: record.recordId,
        playlistUrl,
        sessionId: record.sessionId,
        sessionUrl,
        timestamp: record.timestamp,
        context: record.context,
        songs: savedSongs,
        dedupeStats: { newCount, reusedCount }
    };
}

/**
 * Load playlists. Backward compatible with old format (schema:track → MusicRecording directly).
 */
export async function loadRecommendations(storageRoot: string, fetch: any): Promise<RecommendationRecord[]> {
    const fileUrl = getFileUrl(storageRoot, POD_FILES.PLAYLISTS);
    try {
        const dataset = await getSolidDataset(fileUrl, { fetch });
        const records: RecommendationRecord[] = [];

        for (const thing of getThingAll(dataset)) {
            if (getUrl(thing, RDF_TYPE) !== `${SCHEMA}MusicPlaylist`) continue;

            const trackUrls = getUrlAll(thing, `${SCHEMA}track`) || [];
            const songs: PlaylistSong[] = [];

            for (const trackUrl of trackUrls) {
                const trackThing = getThing(dataset, trackUrl);
                if (!trackThing) continue;

                const trackTypes = getUrlAll(trackThing, RDF_TYPE) || [];

                let songThing: any = null;
                let songUrl = trackUrl;
                let position = songs.length + 1;
                let reason: string | undefined;
                let cover: string | undefined;

                // ─── NEW FORMAT: ListItem entry referencing recording ───
                if (trackTypes.includes(`${SCHEMA}ListItem`)) {
                    const recordingUrl = getUrl(trackThing, `${SCHEMA}item`);
                    if (!recordingUrl) continue;
                    songThing = getThing(dataset, recordingUrl);
                    songUrl = recordingUrl;
                    position = getInteger(trackThing, `${SCHEMA}position`) || position;
                    reason = getStringNoLocale(trackThing, `${SCHEMA}reviewBody`) || undefined;
                    cover = getStringNoLocale(trackThing, `${SCHEMA}image`) || undefined;
                }
                // ─── OLD FORMAT: track URL points directly to MusicRecording ───
                else if (trackTypes.includes(`${SCHEMA}MusicRecording`)) {
                    songThing = trackThing;
                    position = getInteger(trackThing, `${SCHEMA}position`) || position;
                    reason = getStringNoLocale(trackThing, `${SCHEMA}reviewBody`) || undefined;
                }
                else {
                    continue;
                }

                if (!songThing) continue;

                const songTypes = getUrlAll(songThing, RDF_TYPE) || [];
                if (!songTypes.includes(`${SCHEMA}MusicRecording`)) continue;

                const title = getStringNoLocale(songThing, `${SCHEMA}name`) || 'Unknown';
                const artistUrl = getUrl(songThing, `${SCHEMA}byArtist`) || '';
                const artistThing = artistUrl ? getThing(dataset, artistUrl) : null;
                const artist = artistThing
                    ? getStringNoLocale(artistThing, `${SCHEMA}name`) || 'Unknown'
                    : 'Unknown';

                songs.push({ songUrl, title, artist, artistUrl, cover, reason, position });
            }

            songs.sort((a, b) => a.position - b.position);

            const sessionUrl = getUrl(thing, `${SCHEMA}about`) || undefined;
            const sessionId = sessionUrl ? sessionUrl.split('#session-')[1] : undefined;

            records.push({
                recordId: thing.url.split('#playlist-')[1] || uuidv4(),
                playlistUrl: thing.url,
                sessionId,
                sessionUrl,
                timestamp: getDatetime(thing, `${SCHEMA}dateCreated`) || new Date(),
                context: getStringNoLocale(thing, `${SCHEMA}description`) || undefined,
                songs
            });
        }

        return records.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    } catch (e: any) {
        if (isNotFoundError(e)) return [];
        return [];
    }
}

// ═══════════════════════════════════════════════════════════════════
// 5. BEHAVE-KNOWLEDGE.TTL — REFERENCES ONLY (No Duplication!)
// ═══════════════════════════════════════════════════════════════════

export interface SongInteraction {
    interactionId: string;
    songRef: string;          // URL reference ONLY (no data!)
    action: 'like' | 'dislike' | 'preview';
    ratingValue?: number;
    timestamp: Date;
    resolvedTitle?: string;
    resolvedArtist?: string;
    resolvedSource?: 'playlist' | 'seed';
}

export async function saveInteraction(
    storageRoot: string,
    interaction: {
        interactionId: string;
        songRef: string;
        action: 'like' | 'dislike' | 'preview';
        ratingValue?: number;
        timestamp: Date;
    },
    fetch: any
): Promise<void> {
    const fileUrl = getFileUrl(storageRoot, POD_FILES.BEHAVE);
    let dataset = createSolidDataset();
    try { dataset = await getSolidDataset(fileUrl, { fetch }); }
    catch (e: any) { if (!isNotFoundError(e)) throw e; }

    const interactionUrl = `${fileUrl}#interaction-${interaction.interactionId}`;
    const existing = getThing(dataset, interactionUrl);

    let builder = existing
        ? buildThing(existing)
        : buildThing(createThing({ url: interactionUrl }));

    builder.addUrl(`${SCHEMA}object`, interaction.songRef)
        .addDatetime(`${SCHEMA}startTime`, interaction.timestamp);

    if (interaction.action === 'like' || interaction.action === 'dislike') {
        builder.addUrl(RDF_TYPE, `${SCHEMA}AggregateRating`)
            .setInteger(`${SCHEMA}ratingValue`, interaction.ratingValue ?? (interaction.action === 'like' ? 1 : -1))
            .setInteger(`${SCHEMA}bestRating`, 1)
            .setInteger(`${SCHEMA}worstRating`, -1)
            .setInteger(`${SCHEMA}ratingCount`, 1);
    } else if (interaction.action === 'preview') {
        builder.addUrl(RDF_TYPE, `${SCHEMA}ListenAction`);
    }

    dataset = setThing(dataset, builder.build());
    await saveSolidDatasetAt(fileUrl, dataset, { fetch });
}

export async function loadInteractions(storageRoot: string, fetch: any): Promise<SongInteraction[]> {
    const behaveFileUrl = getFileUrl(storageRoot, POD_FILES.BEHAVE);
    const seedsFileUrl = getFileUrl(storageRoot, POD_FILES.SEEDS);
    const playlistsFileUrl = getFileUrl(storageRoot, POD_FILES.PLAYLISTS);

    try {
        const [behaveDataset, seedsDataset, playlistsDataset] = await Promise.all([
            getSolidDataset(behaveFileUrl, { fetch }).catch(() => createSolidDataset()),
            getSolidDataset(seedsFileUrl, { fetch }).catch(() => createSolidDataset()),
            getSolidDataset(playlistsFileUrl, { fetch }).catch(() => createSolidDataset())
        ]);

        const interactions: SongInteraction[] = [];

        for (const thing of getThingAll(behaveDataset)) {
            const types = getUrlAll(thing, RDF_TYPE) || [];
            const songRef = getUrl(thing, `${SCHEMA}object`);
            if (!songRef) continue;

            const timestamp = getDatetime(thing, `${SCHEMA}startTime`) || new Date();
            const interactionId = thing.url.split('#interaction-')[1] || uuidv4();

            let action: 'like' | 'dislike' | 'preview' = 'preview';
            let ratingValue: number | undefined;

            if (types.includes(`${SCHEMA}AggregateRating`)) {
                ratingValue = getInteger(thing, `${SCHEMA}ratingValue`) ?? 0;
                action = ratingValue > 0 ? 'like' : 'dislike';
            } else if (types.includes(`${SCHEMA}ListenAction`)) {
                action = 'preview';
            }

            // 🎯 RESOLVE: Try both datasets + handle ListItem pattern
            let resolvedTitle = 'Unknown';
            let resolvedArtist = 'Unknown';
            let resolvedSource: 'playlist' | 'seed' = 'playlist';

            try {
                // Helper: resolve a recording URL from a dataset
                const resolveFromDataset = (ds: any, url: string): { title: string; artist: string } | null => {
                    // Direct recording
                    let recordingThing = getThing(ds, url);

                    // If it's a ListItem, follow schema:item
                    if (recordingThing) {
                        const itemUrl = getUrl(recordingThing, `${SCHEMA}item`);
                        if (itemUrl) {
                            recordingThing = getThing(ds, itemUrl);
                        }
                    }

                    if (!recordingThing) return null;
                    const types = getUrlAll(recordingThing, RDF_TYPE) || [];
                    if (!types.includes(`${SCHEMA}MusicRecording`)) return null;

                    const title = getStringNoLocale(recordingThing, `${SCHEMA}name`) || 'Unknown';
                    const artistUrl = getUrl(recordingThing, `${SCHEMA}byArtist`);
                    let artist = 'Unknown';
                    if (artistUrl) {
                        const artistThing = getThing(ds, artistUrl);
                        artist = artistThing
                            ? getStringNoLocale(artistThing, `${SCHEMA}name`) || 'Unknown'
                            : 'Unknown';
                    }
                    return { title, artist };
                };

                if (songRef.includes('playlists.ttl')) {
                    const result = resolveFromDataset(playlistsDataset, songRef);
                    if (result) {
                        resolvedTitle = result.title;
                        resolvedArtist = result.artist;
                        resolvedSource = 'playlist';
                    }
                } else if (songRef.includes('seeds.ttl')) {
                    const result = resolveFromDataset(seedsDataset, songRef);
                    if (result) {
                        resolvedTitle = result.title;
                        resolvedArtist = result.artist;
                        resolvedSource = 'seed';
                    }
                }
            } catch (err) {
                console.warn(`⚠️ Could not resolve ${songRef}:`, err);
            }

            interactions.push({
                interactionId,
                songRef,
                action,
                ratingValue,
                timestamp,
                resolvedTitle,
                resolvedArtist,
                resolvedSource
            });
        }

        return interactions.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    } catch (e: any) {
        if (isNotFoundError(e)) return [];
        return [];
    }
}

export async function loadBehaveKnowledge(storageRoot: string, fetch: any): Promise<SongInteraction[]> {
    return await loadInteractions(storageRoot, fetch);
}

// ═══════════════════════════════════════════════════════════════════
// 🧹 UTILITIES
// ═══════════════════════════════════════════════════════════════════

export async function seedInitialKnowledge(storageRoot: string, settings: UserSettings, fetch: any): Promise<void> {
    for (const artist of settings.favoriteArtists) {
        const artistId = makeSafeId(artist);
        await saveInteraction(storageRoot, {
            interactionId: `seed-artist-${artistId}`,
            songRef: `placeholder://artist-${artistId}`,
            action: 'like',
            ratingValue: 1,
            timestamp: new Date()
        }, fetch);
    }
}

export async function getPersonalizationStats(storageRoot: string, fetch: any) {
    const interactions = await loadInteractions(storageRoot, fetch);
    const liked = interactions.filter(i => i.action === 'like');
    const disliked = interactions.filter(i => i.action === 'dislike');

    const artistCounts: Record<string, number> = {};
    liked.forEach(i => {
        if (i.resolvedArtist && i.resolvedArtist !== 'Unknown') {
            artistCounts[i.resolvedArtist] = (artistCounts[i.resolvedArtist] || 0) + 1;
        }
    });

    return {
        totalInteractions: interactions.length,
        likedCount: liked.length,
        dislikedCount: disliked.length,
        topArtists: Object.entries(artistCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)
            .map(([artist, count]) => ({ artist, count })),
        likedSongs: liked.map(i => ({ title: i.resolvedTitle, artist: i.resolvedArtist })),
        dislikedSongs: disliked.map(i => ({ title: i.resolvedTitle, artist: i.resolvedArtist }))
    };
}