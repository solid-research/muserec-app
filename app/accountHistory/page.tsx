"use client";

import { useState, useEffect } from "react";
import Header from "../components/header";
import { useSolidSession } from '@/src/contexts/SolidSessionContext';
import { getPodUrlAll } from '@inrupt/solid-client';
import { 
    loadInteractions, loadSearchSessions, loadRecommendations, loadSeedSongs,
    SongInteraction, SearchSession, RecommendationRecord, SeedSong
} from "@/src/solid-storage";
import toast, { Toaster } from "react-hot-toast";

const formatDate = (date: Date | string | undefined): string => {
    if (!date) return 'Unknown';
    const d = typeof date === 'string' ? new Date(date) : date;
    if (isNaN(d.getTime())) return 'Invalid';
    return new Intl.DateTimeFormat('en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true
    }).format(d);
};

const getRelativeTime = (date: Date | string | undefined): string => {
    if (!date) return '';
    const d = typeof date === 'string' ? new Date(date) : date;
    if (isNaN(d.getTime())) return '';
    const diffMs = new Date().getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return formatDate(d);
};

export default function AccountHistoryPage() {
    const { session, isLoggedIn } = useSolidSession();
    const [storageRoot, setStorageRoot] = useState<string | null>(null);
    // Only 2 tabs: Sessions and Song Recommendations
    const [activeTab, setActiveTab] = useState<'sessions' | 'playlists'>('sessions');
    
    // Keep loading all data for traceability purposes
    const [interactions, setInteractions] = useState<SongInteraction[]>([]);
    const [searches, setSearches] = useState<SearchSession[]>([]);
    const [recommendations, setRecommendations] = useState<RecommendationRecord[]>([]);
    const [seeds, setSeeds] = useState<SeedSong[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (isLoggedIn && session?.info?.webId) {
            (async () => {
                try {
                    let podUrls = await getPodUrlAll(session.info.webId!, { fetch: session.fetch });
                    if (!podUrls.length) podUrls = [session.info.webId!.replace('/profile/card#me', '/')];
                    const storage = podUrls[0];
                    setStorageRoot(storage);
                    
                    const [i, s, r, sd] = await Promise.all([
                        loadInteractions(storage, session.fetch),
                        loadSearchSessions(storage, session.fetch),
                        loadRecommendations(storage, session.fetch),
                        loadSeedSongs(storage, session.fetch)
                    ]);
                    setInteractions(i);
                    setSearches(s);
                    setRecommendations(r);
                    setSeeds(sd);
                } catch (err) {
                    toast.error('Failed to load history.');
                } finally {
                    setLoading(false);
                }
            })();
        }
    }, [isLoggedIn, session]);

    const getPlaylistForSession = (session: SearchSession) => 
        recommendations.find(r => r.playlistUrl === session.playlistUrl || r.sessionId === session.sessionId);
    
    const getInteractionsForSong = (songUrl: string) => 
        interactions.filter(i => i.songRef === songUrl);

    // Clean tab button without icons
    const TabButton = ({ id, label, count }: { id: string; label: string; count?: number }) => (
        <button 
            onClick={() => setActiveTab(id as any)} 
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === id 
                    ? 'border-indigo-500 text-indigo-400' 
                    : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
        >
            {label}
            {count !== undefined && (
                <span className={`ml-2 px-2 py-0.5 rounded-full text-xs ${
                    activeTab === id ? 'bg-indigo-500/20 text-indigo-300' : 'bg-gray-700 text-gray-400'
                }`}>{count}</span>
            )}
        </button>
    );

    // Clean genre comparison without emojis
    const GenreComparison = ({ session }: { session: SearchSession }) => {
        const { originalGenres, correctedGenres, genresCorrected } = session;
        
        if (!originalGenres?.length && !correctedGenres?.length) return null;
        
        return (
            <div className="mb-3 p-3 bg-gray-800/50 rounded border border-gray-700">
                <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-semibold text-gray-300">Genre Analysis</p>
                    {genresCorrected && (
                        <span className="text-[10px] bg-orange-900/50 text-orange-300 px-1.5 py-0.5 rounded">
                            LLM Corrected
                        </span>
                    )}
                </div>
                
                <div className="space-y-2">
                    <div>
                        <p className="text-[10px] text-gray-500 mb-1 uppercase tracking-wide">
                            User's Original Selection
                        </p>
                        <div className="flex flex-wrap gap-1">
                            {originalGenres.length > 0 ? originalGenres.map((g, i) => (
                                <span 
                                    key={i}
                                    className={`text-[10px] px-2 py-0.5 rounded ${
                                        genresCorrected && !correctedGenres.includes(g)
                                            ? 'bg-red-900/30 text-red-300 line-through'
                                            : 'bg-gray-600/50 text-gray-300'
                                    }`}
                                >
                                    {g}
                                </span>
                            )) : (
                                <span className="text-[10px] text-gray-500 italic">None</span>
                            )}
                        </div>
                    </div>

                    {genresCorrected && (
                        <div className="pt-2 border-t border-gray-700">
                            <p className="text-[10px] text-gray-500 mb-1 uppercase tracking-wide">
                                LLM-Corrected (used for search)
                            </p>
                            <div className="flex flex-wrap gap-1">
                                {correctedGenres.map((g, i) => {
                                    const isNew = !originalGenres.includes(g);
                                    return (
                                        <span 
                                            key={i}
                                            className={`text-[10px] px-2 py-0.5 rounded ${
                                                isNew 
                                                    ? 'bg-green-900/50 text-green-300 font-semibold'
                                                    : 'bg-indigo-900/50 text-indigo-300'
                                            }`}
                                        >
                                            {g}
                                        </span>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        );
    };

    // Clean status indicator using colored text (no icons)
    const InteractionStatus = ({ songUrl }: { songUrl: string }) => {
        const songInteractions = getInteractionsForSong(songUrl);
        const hasLiked = songInteractions.some(i => i.action === 'like');
        const hasDisliked = songInteractions.some(i => i.action === 'dislike');
        const hasPreviewed = songInteractions.some(i => i.action === 'preview');
        
        return (
            <div className="flex gap-2 shrink-0">
                {hasLiked && <span className="text-[10px] font-semibold text-green-400 uppercase">Liked</span>}
                {hasDisliked && <span className="text-[10px] font-semibold text-red-400 uppercase">Disliked</span>}
                {hasPreviewed && <span className="text-[10px] font-semibold text-blue-400 uppercase">Previewed</span>}
            </div>
        );
    };

    return (
        <div className="min-h-screen bg-gray-800 text-white">
            <Toaster position="bottom-right" />
            <div className="max-w-6xl mx-auto flex flex-col p-6">
                <Header storageRoot={storageRoot} />
                <main className="mt-6">
                    <h2 className="text-2xl font-bold mb-2">Account History</h2>
                    <p className="text-gray-400 text-sm mb-6">
                        Reference-based linking with dual genre tracking.
                    </p>
                    
                    {/* Only 2 tabs, no icons */}
                    <div className="flex border-b border-gray-700 mb-6 overflow-x-auto">
                        <TabButton id="sessions" label="Sessions" count={searches.length} />
                        <TabButton id="playlists" label="Song Recommendations" count={recommendations.length} />
                    </div>

                    {loading ? (
                        <p className="text-gray-400 text-center py-10">Loading...</p>
                    ) : (
                        <>
                            {/* ═══════════════════════════════════════════ */}
                            {/* TAB 1: SESSIONS                            */}
                            {/* ═══════════════════════════════════════════ */}
                            {activeTab === 'sessions' && (
                                <div className="space-y-3">
                                    {searches.length === 0 ? (
                                        <p className="text-gray-500 text-center py-8">No sessions yet.</p>
                                    ) : (
                                        <>
                                            <div className="bg-indigo-900/20 p-3 rounded border border-indigo-500/30 mb-4">
                                                <p className="text-xs text-indigo-300">
                                                    <strong>sessions.ttl</strong> — Search history with dual genre tracking (original and LLM-corrected).
                                                </p>
                                            </div>
                                            {searches.map(s => {
                                                const linkedPlaylist = getPlaylistForSession(s);
                                                const totalInteractions = linkedPlaylist 
                                                    ? linkedPlaylist.songs.reduce((acc, song) => 
                                                        acc + getInteractionsForSong(song.songUrl).length, 0) 
                                                    : 0;
                                                
                                                return (
                                                    <div key={s.sessionId} className="bg-gray-700/50 p-4 rounded border border-gray-700">
                                                        <div className="flex justify-between items-start mb-2">
                                                            <div className="min-w-0 flex-1">
                                                                <p className="font-semibold text-white truncate">"{s.query || 'General'}"</p>
                                                                <p className="text-xs text-gray-500">{formatDate(s.timestamp)}</p>
                                                            </div>
                                                            <code className="text-[10px] bg-gray-800 px-2 py-0.5 rounded text-indigo-300 shrink-0 ml-2">
                                                                {s.sessionId.substring(0, 8)}
                                                            </code>
                                                        </div>

                                                        {s.vibe && (
                                                            <div className="mb-2">
                                                                <span className="text-xs bg-purple-900/50 text-purple-300 px-2 py-0.5 rounded">
                                                                    Vibe: {s.vibe}
                                                                </span>
                                                            </div>
                                                        )}

                                                        <GenreComparison session={s} />
                                                        
                                                        <div className="flex gap-2 flex-wrap mt-3 text-xs">
                                                            <span className="bg-yellow-900/30 text-yellow-300 px-2 py-0.5 rounded">
                                                                {s.seedCount} input songs
                                                            </span>
                                                            <span className={`px-2 py-0.5 rounded ${linkedPlaylist ? 'bg-green-900/30 text-green-300' : 'bg-gray-700 text-gray-500'}`}>
                                                                {linkedPlaylist ? 'Recommendations available' : 'No recommendations'}
                                                            </span>
                                                            <span className="bg-gray-600/50 px-2 py-0.5 rounded text-gray-300">
                                                                {s.resultCount} results
                                                            </span>
                                                            {totalInteractions > 0 && (
                                                                <span className="bg-pink-900/30 text-pink-300 px-2 py-0.5 rounded">
                                                                    {totalInteractions} interactions
                                                                </span>
                                                            )}
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </>
                                    )}
                                </div>
                            )}

                            {/* ═══════════════════════════════════════════ */}
                            {/* TAB 2: SONG RECOMMENDATIONS                */}
                            {/* ═══════════════════════════════════════════ */}
                            {activeTab === 'playlists' && (
                                <div className="space-y-6">
                                    {recommendations.length === 0 ? (
                                        <p className="text-gray-500 text-center py-8">No recommendations yet.</p>
                                    ) : (
                                        <>
                                            <div className="bg-green-900/20 p-3 rounded border border-green-500/30 mb-4">
                                                <p className="text-xs text-green-300">
                                                    <strong>playlists.ttl</strong> — Song recommendation history with artist deduplication enabled.
                                                </p>
                                            </div>
                                            {recommendations.map(r => {
                                                const linkedSession = searches.find(s => s.sessionId === r.sessionId);
                                                return (
                                                    <div key={r.recordId} className="bg-gray-700/30 p-4 rounded border border-gray-700">
                                                        <div className="flex justify-between items-center mb-3 pb-3 border-b border-gray-700">
                                                            <div>
                                                                <p className="font-bold text-green-300 flex items-center gap-2">
                                                                    Recommendation
                                                                    <code className="text-xs bg-gray-800 px-2 py-0.5 rounded">
                                                                        {r.recordId.substring(0, 8)}
                                                                    </code>
                                                                </p>
                                                                <p className="text-xs text-gray-500">{formatDate(r.timestamp)}</p>
                                                            </div>
                                                            <span className="text-sm text-gray-400">{r.songs.length} songs</span>
                                                        </div>

                                                        {linkedSession && (
                                                            <>
                                                                <div className="mb-3 p-2 bg-blue-900/20 border border-blue-500/30 rounded text-xs">
                                                                    <p className="font-semibold text-blue-300 mb-1">
                                                                        Source query: "{linkedSession.query}"
                                                                    </p>
                                                                    {linkedSession.vibe && (
                                                                        <p className="text-[10px] text-blue-400">
                                                                            Vibe: {linkedSession.vibe}
                                                                        </p>
                                                                    )}
                                                                </div>
                                                                <GenreComparison session={linkedSession} />
                                                            </>
                                                        )}

                                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                                            {r.songs.map((song, idx) => (
                                                                <div key={idx} className="flex items-center gap-3 bg-gray-800/50 p-2 rounded">
                                                                    <div className="shrink-0 w-10 h-10 rounded bg-gray-700 flex items-center justify-center">
                                                                        <span className="text-xs font-bold text-gray-400">
                                                                            {idx + 1}
                                                                        </span>
                                                                    </div>
                                                                    <div className="min-w-0 flex-1">
                                                                        <p className="font-medium text-white text-sm truncate">{song.title}</p>
                                                                        <p className="text-xs text-gray-400 truncate">{song.artist}</p>
                                                                    </div>
                                                                    <InteractionStatus songUrl={song.songUrl} />
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </>
                                    )}
                                </div>
                            )}
                        </>
                    )}
                </main>
            </div>
        </div>
    );
}