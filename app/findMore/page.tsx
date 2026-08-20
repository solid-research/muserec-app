"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
    X, Play, Loader2, AlertCircle, ArrowLeft, Edit2,
    CheckCircle, Music, User, Sparkles, Database
} from "lucide-react";
import Header from "../components/header";
import SongCard from "../components/songCard";
import SettingsModal from "../components/settings";
import { useSolidSession } from "@/src/contexts/SolidSessionContext";
import { getPodUrlAll } from "@inrupt/solid-client";
import {
    loadSettings,
    loadBehaveKnowledge,
    saveSearchSession,
    saveRecommendations,
    saveSeedSongs,
    initializePodFiles
} from "../../src/solid-storage";
import toast, { Toaster } from "react-hot-toast";
import { v4 as uuidv4 } from "uuid";

// Types
type Song = {
    id: string;
    title: string;
    artist: string | { name: string };
    album: { cover_medium: string };
    preview: string;
};

type SelectedSong = {
    id: string;
    title: string;
    artist: string;
    cover: string;
    preview: string;
};

type Personalization = {
    favoriteArtists: string[];
    previouslyRecommended: { title: string; artist: string }[];
    dislikedSongs: { title: string; artist: string }[];
    genrePreferences: string[];
    interactionCount: number;
};

type ValidationLog = {
    step: string;
    message: string;
    type: "info" | "success" | "warning" | "error" | "debug";
};

// Extended type untuk recommendations dengan songUrl
type EnrichedRecommendation = {
    title: string;
    artist: string;
    genre?: string;
    reason?: string;
    personalized?: boolean;
    genreMatch?: boolean;
    verified?: boolean;
    matchMethod?: string;
    cover?: string | null;
    preview?: string | null;
    songUrl?: string;  // URL reference ke playlists.ttl
};

// Genre label mapping
const GENRE_LABELS: Record<string, string> = {
    pop: "Pop", "k-pop": "K-pop", rnb: "R&B", rap: "Rap",
    edm: "EDM", rock: "Rock", metal: "Metal", indie: "Indie",
    country: "Country", ballad: "Ballad"
};

export default function FindMorePage() {
    const { session, isLoggedIn } = useSolidSession();
    const router = useRouter();

    // ═══════════════════════════════════════════════════════════════════
    // STATE MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════

    const [storageRoot, setStorageRoot] = useState<string | null>(null);
    const [ageRange, setAgeRange] = useState("18");
    const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
    const [songQuery, setSongQuery] = useState("");
    const [searchResults, setSearchResults] = useState<Song[]>([]);
    const [selectedSongs, setSelectedSongs] = useState<SelectedSong[]>([]);
    const [theme, setTheme] = useState("");
    const [llm, setLlm] = useState("GPT");
    const [showSettings, setShowSettings] = useState(false);

    const [currentSessionId, setCurrentSessionId] = useState<string>("");

    const [loading, setLoading] = useState(false);
    const [recommendations, setRecommendations] = useState<EnrichedRecommendation[]>([]);
    const [ragStep, setRagStep] = useState("");
    const [validationLogs, setValidationLogs] = useState<ValidationLog[]>([]);
    const [personalization, setPersonalization] = useState<Personalization>({
        favoriteArtists: [],
        previouslyRecommended: [],
        dislikedSongs: [],
        genrePreferences: [],
        interactionCount: 0,
    });

    const audioRef = useRef<HTMLAudioElement | null>(null);

    // ═══════════════════════════════════════════════════════════════════
    // AUTH GUARD
    // ═══════════════════════════════════════════════════════════════════
    useEffect(() => {
        if (!isLoggedIn) router.replace("/sign-in");
    }, [isLoggedIn, router]);

    // ═══════════════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════════════
    useEffect(() => {
        if (isLoggedIn && session?.info?.webId) {
            (async () => {
                try {
                    let podUrls = await getPodUrlAll(session.info.webId!, { fetch: session.fetch });
                    if (!podUrls.length) podUrls = [session.info.webId!.replace("/profile/card#me", "/")];
                    const storage = podUrls[0];
                    setStorageRoot(storage);

                    await initializePodFiles(storage, session.fetch);

                    const settings = await loadSettings(storage, session.fetch);
                    if (settings) {
                        setAgeRange(settings.ageRange);
                        setSelectedGenres(settings.genres.slice(0, 3));
                    }

                    const interactions = await loadBehaveKnowledge(storage, session.fetch);
                    const liked = interactions.filter(i => i.action === "like");
                    const disliked = interactions.filter(i => i.action === "dislike");

                    setPersonalization({
                        favoriteArtists: [...new Set(liked.map(s => s.resolvedArtist).filter(Boolean) as string[])].slice(0, 5),
                        previouslyRecommended: liked.filter(s => s.resolvedTitle && s.resolvedArtist).map(s => ({ title: s.resolvedTitle!, artist: s.resolvedArtist! })),
                        dislikedSongs: disliked.filter(s => s.resolvedTitle && s.resolvedArtist).map(s => ({ title: s.resolvedTitle!, artist: s.resolvedArtist! })),
                        genrePreferences: settings?.genres || [],
                        interactionCount: interactions.length,
                    });
                } catch (err) {
                    console.error("Failed to initialize Pod:", err);
                }
            })();
        }
    }, [isLoggedIn, session]);

    // ═══════════════════════════════════════════════════════════════════
    // DEBOUNCED SEARCH
    // ═══════════════════════════════════════════════════════════════════
    useEffect(() => {
        const timer = setTimeout(async () => {
            if (songQuery.length < 2) { setSearchResults([]); return; }
            try {
                const res = await fetch(`/api/deezer?q=${encodeURIComponent(songQuery)}`);
                const data = await res.json();
                setSearchResults(data.data || []);
            } catch (err) {
                console.error("Search error:", err);
            }
        }, 500);
        return () => clearTimeout(timer);
    }, [songQuery]);

    // ═══════════════════════════════════════════════════════════════════
    // HELPER FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    const addLog = (step: string, message: string, type: ValidationLog["type"] = "info") => {
        setValidationLogs(prev => [...prev, { step, message, type }]);
    };

    const handleAddSong = (song: Song) => {
        const songId = song.id.toString();
        if (selectedSongs.length >= 5) {
            toast.error("You can only select 5 songs!");
            return;
        }
        if (selectedSongs.find(s => s.id === songId)) {
            toast.error("Song already selected!");
            return;
        }

        setSelectedSongs([...selectedSongs, {
            id: songId,
            title: song.title,
            artist: typeof song.artist === "string" ? song.artist : song.artist.name,
            cover: song.album.cover_medium,
            preview: song.preview,
        }]);
        toast.success(`Added "${song.title}"`, { duration: 1500 });
    };

    const handleRemoveSong = (id: string) =>
        setSelectedSongs(selectedSongs.filter(s => s.id !== id));

    const playPreview = (url: string) => {
        if (audioRef.current) audioRef.current.pause();
        audioRef.current = new Audio(url);
        audioRef.current.play().catch(e => console.log("Audio error", e));
    };

    const handleSettingsSaved = async () => {
        setShowSettings(false);
        if (storageRoot) {
            const settings = await loadSettings(storageRoot, session.fetch);
            if (settings) {
                setAgeRange(settings.ageRange);
                setSelectedGenres(settings.genres.slice(0, 3));
            }
            toast.success("Settings updated!");
        }
    };

    const isFormValid = selectedSongs.length >= 1 && selectedSongs.length <= 5 && selectedGenres.length > 0 && !!ageRange;
    const isSongSelected = (songId: string) => selectedSongs.some(s => s.id === songId.toString());

    // ═══════════════════════════════════════════════════════════════════
    // MAIN SUBMIT HANDLER - Normalized Architecture with Dual Genre
    // ═══════════════════════════════════════════════════════════════════
    const handleSubmit = async () => {
        if (!storageRoot) { toast.error("Pod not connected!"); return; }

        setLoading(true);
        setRecommendations([]);
        setRagStep("");
        setValidationLogs([]);

        const sessionId = uuidv4();
        setCurrentSessionId(sessionId);
        const startTime = Date.now();
        const selectedModel = llm === "Gemini" ? "gemini-2.5-flash"
            : llm === "Claude" ? "claude-sonnet-5" : "gpt-3.5-turbo";

        try {
            // ═══════════════════════════════════════════
            // STEP 0: Save seeds to seeds.ttl
            // ═══════════════════════════════════════════
            setRagStep("🌱 Step 0/7: Saving seed songs...");
            addLog("STEP 0", "🌱 Saving seeds to seeds.ttl...", "info");

            const seedSongs = selectedSongs.map(s => ({ title: s.title, artist: s.artist }));
            
            const seedResults = await saveSeedSongs(storageRoot, seedSongs, sessionId, session.fetch);
            const seedUrls = seedResults.map(r => r.seedEntryUrl);
            
            addLog("STEP 0", `✅ ${seedSongs.length} seeds saved`, "success");

            // ═══════════════════════════════════════════
            // STEP 1: Validate (Artist-First)
            // ═══════════════════════════════════════════
            setRagStep("🔬 Step 1/7: Analyzing artists...");
            const uniqueArtists = [...new Set(selectedSongs.map(s => s.artist))];

            const validateRes = await fetch("/api/validate-genre", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    artists: uniqueArtists,
                    selectedGenres,
                    seedSongs
                }),
            });

            if (!validateRes.ok) throw new Error("Validation API failed");
            const validateData = await validateRes.json();

            const validatedArtists = validateData.filteredArtists || uniqueArtists;
            const finalGenres = validateData.correctedGenres || selectedGenres;

            addLog("STEP 1", `✅ ${validatedArtists.length} artists kept`, "success");

            // ═══════════════════════════════════════════
            // STEP 2: Retrieve
            // ═══════════════════════════════════════════
            setRagStep("🔍 Step 2/7: Searching database...");
            const searchRes = await fetch("/api/search", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    keywords: theme ? theme.split(/\s+/).filter(w => w.length >= 3) : [],
                    genres: finalGenres,
                    likedArtists: validatedArtists,
                    excludeSongs: [
                        ...selectedSongs.map(s => ({ title: s.title, artist: s.artist })),
                        ...personalization.previouslyRecommended.slice(-20),
                        ...personalization.dislikedSongs,
                    ],
                    limit: 500,
                }),
            });

            if (!searchRes.ok) throw new Error("Search API error");
            const searchData = await searchRes.json();
            const candidates: any[] = searchData.songs || [];
            if (candidates.length === 0) throw new Error("No candidate songs found");
            addLog("STEP 2", `✅ ${candidates.length} candidates found`, "success");

            // ═══════════════════════════════════════════
            // STEP 3: Build Prompt
            // ═══════════════════════════════════════════
            setRagStep("🎵 Step 3/7: Building prompt...");
            const candidateList = candidates
                .map((s, i) => `[${i}] "${s.track_name}" by ${s.artist_name}${s.genre ? ` (${s.genre})` : ""}`)
                .join("\n");

            const seedSongsList = selectedSongs
                .map(s => `   - "${s.title}" by ${s.artist}`)
                .join("\n");

            const prompt = `You are an expert music curator. Select EXACTLY 5 songs from CANDIDATE POOL.

PRIORITY: Artist similarity > Musical style > Genre

USER'S SEEDS (ground truth):
${seedSongsList}

CANDIDATE POOL:
${candidateList}

OUTPUT JSON array:
[{"poolIndex": 0, "title": "EXACT", "artist": "EXACT", "reason": "Indonesian (max 15 words)", "personalized": bool, "genreMatch": bool}]`;

            // ═══════════════════════════════════════════
            // STEP 4: Generate
            // ═══════════════════════════════════════════
            setRagStep("🤖 Step 4/7: AI selecting songs...");
            const llmRes = await fetch("/api/chatAPI", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    messages: [
                        { role: "system", content: "Strict music recommender. Output only valid JSON array." },
                        { role: "user", content: prompt },
                    ],
                    model: selectedModel,
                    stream: false,
                }),
            });

            if (!llmRes.ok) throw new Error(`LLM API error: ${llmRes.status}`);
            const llmData = await llmRes.json();
            let content = llmData.choices?.[0]?.message?.content || "[]";
            content = content.replace(/```json/g, "").replace(/```/g, "").trim();
            const jsonMatch = content.match(/\[\s*\{[\s\S]*\}\s*\]/);
            const jsonString = jsonMatch ? jsonMatch[0] : content;
            let llmPicks: any[];
            try { 
                llmPicks = JSON.parse(jsonString); 
            } catch (e) { 
                try {
                    llmPicks = JSON.parse(content);
                } catch {
                    throw new Error("LLM returned invalid JSON"); 
                }
            }

            // ═══════════════════════════════════════════
            // STEP 5: Validate
            // ═══════════════════════════════════════════
            setRagStep("✅ Step 5/7: Final verification...");
            const verifyRes = await fetch("/api/songs", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ songs: llmPicks.map(p => ({ title: p.title, artist: p.artist })) }),
            });
            const verifyData = await verifyRes.json();
            const validatedPicks = verifyData.results || [];

            let validRecs = validatedPicks
                .filter((r: any) => r.found)
                .map((r: any) => {
                    const llmPick = llmPicks.find(p => p.title === r.originalTitle && p.artist === r.originalArtist);
                    return {
                        title: r.matchedTitle, artist: r.matchedArtist, genre: r.genre,
                        reason: llmPick?.reason || "Matches your taste",
                        personalized: llmPick?.personalized || false,
                        genreMatch: llmPick?.genreMatch || false,
                        verified: true, matchMethod: r.matchMethod,
                    };
                });

            if (validRecs.length === 0) {
                validRecs = llmPicks.slice(0, 5).map(p => ({
                    title: p.title, artist: p.artist, genre: "Unknown",
                    reason: p.reason, personalized: p.personalized,
                    genreMatch: p.genreMatch, verified: false, matchMethod: "pool-fallback",
                }));
            }

            // ═══════════════════════════════════════════
            // STEP 6: Enrich
            // ═══════════════════════════════════════════
            setRagStep("🎨 Step 6/7: Fetching metadata...");
            const enrichedRecs = await Promise.all(
                validRecs.map(async (rec: any) => {
                    try {
                        const res = await fetch(`/api/deezer?q=${encodeURIComponent(`${rec.title} ${rec.artist}`)}`);
                        const data = await res.json();
                        if (data.data && data.data.length > 0) {
                            const song = data.data[0];
                            return { ...rec, cover: song.album.cover_medium, preview: song.preview };
                        }
                    } catch (e) { }
                    return { ...rec, cover: null, preview: null };
                })
            );

            // ═══════════════════════════════════════════
            // STEP 7: Save with Standardized Linking + Dual Genre
            // ═══════════════════════════════════════════
            setRagStep("💾 Step 7/7: Saving with standardized linking...");

            // Save playlist FIRST to get song URLs
            const playlistsFileUrl = `${storageRoot}public/music-rec-data/playlists.ttl`;
            const playlistUrl = `${playlistsFileUrl}#playlist-${sessionId}`;

            const savedPlaylist = await saveRecommendations(storageRoot, {
                recordId: sessionId,
                sessionId,
                timestamp: new Date(),
                context: theme || "General Mix",
                songs: enrichedRecs.map(r => ({
                    title: r.title,
                    artist: r.artist,
                    cover: r.cover ?? undefined,
                    reason: r.reason
                })),
            }, session.fetch);

            addLog("STEP 7", `✅ Playlist saved with ${savedPlaylist.songs.length} songs`, "success");

            // 🎯 Detect if genres were corrected by LLM
            const genresCorrected = JSON.stringify(finalGenres) !== JSON.stringify(selectedGenres);
            if (genresCorrected) {
                addLog("STEP 7", `🔄 Genres corrected: ${selectedGenres.join(',')} → ${finalGenres.join(',')}`, "info");
            }

            // Save session with BOTH original + corrected genres
            await saveSearchSession(storageRoot, {
                sessionId,
                query: `${theme} ${finalGenres.join(",")}`.trim(),
                vibe: theme,
                originalGenres: selectedGenres,    // 🆕 User's original input
                correctedGenres: finalGenres,      // 🆕 LLM-corrected
                genresCorrected,                   // 🆕 Flag
                seedUrls: seedUrls,
                seedCount: seedUrls.length,
                playlistUrl: playlistUrl,
                timestamp: new Date(),
                resultCount: enrichedRecs.length,
            }, session.fetch);

            addLog("STEP 7", "✅ Session saved with dual genre tracking", "success");
            addLog("STEP 7", `🔗 All linked via ID: ${sessionId.substring(0, 8)}`, "success");

            // Attach song URLs to enriched recs for SongCard
            const recsWithUrls: EnrichedRecommendation[] = enrichedRecs.map((rec, idx) => ({
                ...rec,
                songUrl: savedPlaylist.songs[idx]?.songUrl
            }));

            setRecommendations(recsWithUrls);
            setRagStep(`✨ Done! ${enrichedRecs.length} songs ready in ${Date.now() - startTime}ms.`);
            setTimeout(() => setRagStep(""), 3000);

        } catch (error: any) {
            // ✅ CATCH BLOCK - Handle errors
            console.error("[RAG Flow ❌]", error);
            addLog("ERROR", `❌ ${error.message}`, "error");
            toast.error(error.message || "Failed to get recommendations.");
            setRagStep("");
        } finally {
            // ✅ FINALLY BLOCK - Reset loading state
            setLoading(false);
        }
    };

    // ═══════════════════════════════════════════════════════════════════
    // RENDER
    // ═══════════════════════════════════════════════════════════════════
    return (
        <div className="min-h-screen bg-gray-800 text-white">
            <Toaster position="bottom-right" />
            <div className="max-w-6xl mx-auto flex flex-col p-6">
                <Header storageRoot={storageRoot} />

                {/* Settings Modal */}
                {showSettings && (
                    <SettingsModal
                        storageRoot={storageRoot}
                        isMandatory={false}
                        onClose={() => setShowSettings(false)}
                        onSaveSuccess={handleSettingsSaved}
                    />
                )}

                <main className="mt-6">
                    {/* Top Navigation */}
                    <div className="flex items-center justify-between mb-6">
                        <button
                            onClick={() => router.push("/")}
                            className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors shadow-sm"
                        >
                            <ArrowLeft size={18} />
                            <span className="font-medium">Dashboard</span>
                        </button>

                        {storageRoot && (
                            <span className="text-xs text-gray-400 bg-gray-700/50 px-3 py-1.5 rounded-full flex items-center gap-2">
                                <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                                {new URL(storageRoot).hostname}
                            </span>
                        )}
                    </div>

                    {/* Header */}
                    <h2 className="text-2xl font-bold mb-2 flex items-center gap-2">
                        <Database size={24} className="text-indigo-400" />
                        Find More Songs
                    </h2>
                    <p className="text-gray-400 mb-6">
                        <strong>Artist-First + 5-File Linked Architecture:</strong> Your songs define taste.
                        All data traced: <code className="text-xs bg-gray-700 px-1 rounded">seeds → sessions → playlists</code>
                    </p>

                    {/* Personalization Banner */}
                    {personalization.interactionCount > 0 && (
                        <div className="p-3 bg-indigo-900/30 border border-indigo-700 rounded-md flex items-center gap-2 text-indigo-200 text-sm mb-6">
                            <Sparkles size={16} />
                            <span>
                                <strong>Personalization active:</strong> Using {personalization.interactionCount} past interactions.
                                {personalization.favoriteArtists.length > 0 && (
                                    <> Top artists: {personalization.favoriteArtists.slice(0, 3).join(", ")}.</>
                                )}
                            </span>
                        </div>
                    )}

                    <div className="grid grid-cols-1 md:grid-cols-6 gap-4">
                        {/* Step 1: About You (Readonly) */}
                        <div className="md:col-span-2">
                            <div className="p-4 bg-gray-100 rounded-lg text-gray-900 shadow h-full">
                                <div className="flex items-center justify-between mb-4">
                                    <div className="flex items-center gap-2">
                                        <User size={16} className="text-indigo-600" />
                                        <p className="font-bold text-gray-700">Step 1: About You</p>
                                    </div>
                                    <button
                                        onClick={() => setShowSettings(true)}
                                        className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-700 font-medium"
                                    >
                                        <Edit2 size={12} /> Edit
                                    </button>
                                </div>

                                <div className="mb-4">
                                    <label className="block text-xs font-semibold text-gray-600 mb-1">Age Range</label>
                                    <div className="flex items-center gap-2 px-3 py-2 bg-white rounded-md border border-gray-200 text-sm text-gray-700">
                                        <span className="font-medium">
                                            {ageRange === "18" && "18 - 24 years"}
                                            {ageRange === "25" && "25 - 34 years"}
                                            {ageRange === "35" && "35+ years"}
                                        </span>
                                    </div>
                                </div>

                                <div>
                                    <label className="block text-xs font-semibold text-gray-600 mb-2">
                                        Your Genres ({selectedGenres.length})
                                    </label>
                                    {selectedGenres.length > 0 ? (
                                        <div className="flex flex-wrap gap-2">
                                            {selectedGenres.map(genre => (
                                                <span
                                                    key={genre}
                                                    className="inline-flex items-center gap-1 px-3 py-1.5 bg-indigo-600 text-white text-xs font-semibold rounded-full shadow-sm"
                                                >
                                                    <Music size={10} />
                                                    {GENRE_LABELS[genre] || genre}
                                                </span>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-md">
                                            <p className="text-xs text-yellow-800">No genres selected.</p>
                                            <button
                                                onClick={() => setShowSettings(true)}
                                                className="mt-2 text-xs text-yellow-900 font-semibold underline"
                                            >
                                                Open Settings →
                                            </button>
                                        </div>
                                    )}
                                </div>

                                <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-md">
                                    <p className="text-xs text-blue-800">
                                        <strong>Artist-First:</strong> Your song picks are more important than genres.
                                        Genres auto-adjust to match your artist taste.
                                    </p>
                                </div>
                            </div>
                        </div>

                        {/* Step 2: Choose Songs */}
                        <div className="md:col-span-4">
                            <div className="p-4 bg-gray-100 rounded-lg text-gray-900 shadow h-full flex flex-col">
                                <div className="flex items-center justify-between mb-3">
                                    <p className="font-bold text-gray-700">Step 2: Choose minimum 1 song</p>
                                    <span className={`text-xs font-semibold px-2 py-1 rounded-full ${selectedSongs.length === 5
                                            ? "bg-green-100 text-green-700"
                                            : "bg-gray-200 text-gray-600"
                                        }`}>
                                        {selectedSongs.length}/5 selected
                                    </span>
                                </div>

                                <input
                                    type="text"
                                    placeholder="Search for a song..."
                                    value={songQuery}
                                    onChange={(e) => setSongQuery(e.target.value)}
                                    className="block w-full rounded-md border-0 py-2 px-3 shadow-sm ring-1 ring-inset ring-gray-300 text-sm bg-white mb-3"
                                />

                                {/* Search Results */}
                                {searchResults.length > 0 && (
                                    <div className="flex flex-wrap gap-2 max-h-56 overflow-y-auto border-b border-gray-200 pb-3 mb-3">
                                        {searchResults.map(song => {
                                            const isSelected = isSongSelected(song.id.toString());
                                            return (
                                                <div
                                                    key={song.id}
                                                    className={`bg-white rounded-lg shadow p-2 w-28 flex flex-col items-center text-center transition-all ${isSelected ? "ring-2 ring-green-500 bg-green-50" : ""
                                                        }`}
                                                >
                                                    <img
                                                        src={song.album.cover_medium}
                                                        alt=""
                                                        className={`w-full h-20 object-cover rounded ${isSelected ? "opacity-60" : ""}`}
                                                    />
                                                    <p className="text-[10px] font-bold mt-1 truncate w-full">
                                                        {song.title}
                                                    </p>
                                                    <p className="text-[9px] text-gray-500 truncate w-full">
                                                        {typeof song.artist === "string" ? song.artist : song.artist.name}
                                                    </p>
                                                    {isSelected ? (
                                                        <div className="mt-1 bg-green-500 text-white text-[10px] px-2 py-0.5 rounded w-full flex items-center justify-center gap-1">
                                                            <CheckCircle size={10} /> Added
                                                        </div>
                                                    ) : (
                                                        <button
                                                            onClick={() => handleAddSong(song)}
                                                            disabled={selectedSongs.length >= 5}
                                                            className="mt-1 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded hover:bg-blue-600 w-full disabled:bg-gray-300"
                                                        >
                                                            Add
                                                        </button>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}

                                {/* Selected Songs */}
                                <div className="mt-auto">
                                    <div className="flex items-center justify-between mb-2">
                                        <p className="text-gray-700 text-xs font-semibold">
                                            Your Seed Songs (will be saved to seeds.ttl):
                                        </p>
                                        {selectedSongs.length > 0 && (
                                            <button
                                                onClick={() => setSelectedSongs([])}
                                                className="text-xs text-red-600 hover:text-red-700 font-medium"
                                            >
                                                Clear all
                                            </button>
                                        )}
                                    </div>
                                    <div className="flex flex-wrap gap-2 min-h-[120px] p-3 bg-white/50 rounded-md border-2 border-dashed border-gray-300">
                                        {selectedSongs.length === 0 ? (
                                            <div className="w-full flex items-center justify-center text-gray-400 text-sm italic">
                                                Search and add songs above...
                                            </div>
                                        ) : (
                                            selectedSongs.map((song, idx) => (
                                                <div
                                                    key={song.id}
                                                    className="bg-white rounded-lg shadow-md p-2 w-28 flex flex-col items-center text-center relative group border-2 border-indigo-200"
                                                >
                                                    <div className="absolute -top-2 -left-2 w-6 h-6 bg-indigo-600 text-white rounded-full flex items-center justify-center text-xs font-bold shadow">
                                                        {idx + 1}
                                                    </div>
                                                    <button
                                                        onClick={() => handleRemoveSong(song.id)}
                                                        className="absolute top-1 right-1 bg-red-500 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 z-10"
                                                    >
                                                        <X size={10} />
                                                    </button>
                                                    <img src={song.cover} alt="" className="w-full h-20 object-cover rounded" />
                                                    <p className="text-[10px] font-bold mt-1 truncate w-full">
                                                        {song.title}
                                                    </p>
                                                    <p className="text-[9px] text-gray-500 truncate w-full">
                                                        {song.artist}
                                                    </p>
                                                    {song.preview && (
                                                        <button
                                                            onClick={() => playPreview(song.preview)}
                                                            className="mt-1 bg-green-500 text-white text-[10px] px-2 py-0.5 rounded hover:bg-green-600 w-full flex items-center justify-center gap-1"
                                                        >
                                                            <Play size={8} /> Preview
                                                        </button>
                                                    )}
                                                </div>
                                            ))
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Step 3 & 4: Vibe & AI */}
                        <div className="md:col-span-6 flex flex-col gap-4">
                            <div className="p-4 bg-gray-100 rounded-lg text-gray-900 shadow">
                                <p className="font-bold text-gray-700 mb-2">Step 3: What's the vibe? (Optional)</p>
                                <input
                                    type="text"
                                    placeholder="e.g., chill, workout, road trip..."
                                    value={theme}
                                    onChange={(e) => setTheme(e.target.value)}
                                    className="block w-full rounded-md border-0 py-2 px-3 shadow-sm ring-1 ring-inset ring-gray-300 text-sm bg-white"
                                />
                            </div>

                            <div className="p-4 bg-gray-100 rounded-lg text-gray-900 shadow">
                                <p className="font-bold text-gray-700 mb-2">Step 4: Choose your AI</p>
                                <select
                                    value={llm}
                                    onChange={(e) => setLlm(e.target.value)}
                                    className="block w-full rounded-md border-0 py-2 px-3 shadow-sm ring-1 ring-inset ring-gray-300 text-sm bg-white"
                                >
                                    <option value="GPT">OpenAI GPT</option>
                                    <option value="Gemini">Google Gemini</option>
                                    <option value="Claude">Anthropic Claude</option>
                                </select>
                            </div>

                            <button
                                onClick={handleSubmit}
                                disabled={!isFormValid || loading}
                                className="w-full py-3 rounded-lg bg-indigo-600 text-white font-semibold hover:bg-indigo-700 disabled:bg-gray-400 flex items-center justify-center gap-2 shadow"
                            >
                                {loading && <Loader2 className="animate-spin" size={18} />}
                                {loading ? "Processing (7 Steps)..." : "Recommend Me!"}
                            </button>

                            {!isFormValid && !loading && (
                                <p className="text-center text-gray-400 text-xs">
                                    {selectedGenres.length === 0
                                        ? "Set genres in Settings (Step 1)"
                                        : selectedSongs.length === 0
                                            ? "Select at least 1 song (Step 2)"
                                            : "Ready to recommend!"}
                                </p>
                            )}
                        </div>
                    </div>

                    {/* Processing Status */}
                    {ragStep && (
                        <div className="mt-6 p-4 bg-gray-900 border border-gray-700 rounded-lg text-white flex items-center gap-3">
                            <Loader2 className="animate-spin text-blue-400" size={20} />
                            <span className="text-sm font-mono">{ragStep}</span>
                            {currentSessionId && (
                                <span className="ml-auto text-xs text-gray-500">
                                    Session: <code>{currentSessionId.substring(0, 8)}</code>
                                </span>
                            )}
                        </div>
                    )}

                    {/* Validation Logs */}
                    {validationLogs.length > 0 && (
                        <div className="mt-6 p-4 bg-gray-900 border border-gray-700 rounded-lg">
                            <h3 className="text-white font-bold mb-3 flex items-center gap-2">
                                <AlertCircle size={16} /> Processing Logs (5-File Architecture)
                            </h3>
                            <div className="max-h-64 overflow-y-auto space-y-1 font-mono text-xs">
                                {validationLogs.map((log, idx) => (
                                    <div
                                        key={idx}
                                        className={`px-2 py-1 rounded ${log.type === "success" ? "bg-green-900/30 text-green-300" :
                                                log.type === "warning" ? "bg-yellow-900/30 text-yellow-300" :
                                                    log.type === "error" ? "bg-red-900/30 text-red-300" :
                                                        log.type === "debug" ? "bg-purple-900/30 text-purple-300" :
                                                            "bg-gray-800 text-gray-300"
                                            }`}
                                    >
                                        <span className="opacity-60">[{log.step}]</span> {log.message}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Recommendations Section */}
                    {recommendations.length > 0 && (
                        <div className="mt-8">
                            <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
                                Your Recommendations
                                <span className="text-sm font-normal text-gray-400">
                                    ({recommendations.length} songs)
                                </span>
                                {currentSessionId && (
                                    <span className="text-xs bg-indigo-900/50 text-indigo-300 px-2 py-1 rounded-full ml-2">
                                        Playlist: {currentSessionId.substring(0, 8)}
                                    </span>
                                )}
                            </h2>
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                {recommendations.map((rec, idx) => (
                                    <SongCard
                                        key={idx}
                                        storageRoot={storageRoot}
                                        songUrl={rec.songUrl}
                                        playlistId={currentSessionId}
                                        song={{
                                            id: uuidv4(),
                                            title: rec.title,
                                            artist: rec.artist,
                                            imageSrc: rec.cover || undefined,
                                            matchMethod: rec.matchMethod || "Artist-First RAG",
                                            isPersonalized: rec.personalized,
                                            isGenreMatch: rec.genreMatch,
                                            previewUrl: rec.preview || undefined,
                                            reason: rec.reason,
                                        }}
                                        onPreview={() => rec.preview && playPreview(rec.preview)}
                                    />
                                ))}
                            </div>
                        </div>
                    )}
                </main>
            </div>
        </div>
    );
}