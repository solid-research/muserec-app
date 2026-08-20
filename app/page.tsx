"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
    History, RefreshCcw, Sparkles, Settings, ArrowRight,
    Music, TrendingUp, Mic2, Flame, BarChart3
} from "lucide-react";
import Header from "./components/header";
import SongCard from "./components/songCard";
import SettingsModal from "./components/settings";
import { useSolidSession } from '@/src/contexts/SolidSessionContext';
import { getPodUrlAll } from '@inrupt/solid-client';
import {
    loadBehaveKnowledge,
    loadRecommendations,
    loadSettings,
    loadSearchSessions,
    SongInteraction,
    RecommendationRecord,
    SearchSession,
    initializePodFiles
} from "../src/solid-storage";
import { generateSmartRecommendations, DashboardInsights } from "../src/lib/dashboardAlgorithm";
import toast, { Toaster } from 'react-hot-toast';

export default function Home() {
    const { session, isLoggedIn } = useSolidSession();
    const router = useRouter();
    const [storageRoot, setStorageRoot] = useState<string | null>(null);

    const [sessions, setSessions] = useState<SearchSession[]>([]);
    const [playlists, setPlaylists] = useState<RecommendationRecord[]>([]);
    const [interactions, setInteractions] = useState<SongInteraction[]>([]);
    const [loading, setLoading] = useState(true);
    const [limit, setLimit] = useState<5 | 10 | 15>(5);
    const [shuffleSeed, setShuffleSeed] = useState(0);
    const [reloading, setReloading] = useState(false);

    const [needsOnboarding, setNeedsOnboarding] = useState(false);
    const [showSettings, setShowSettings] = useState(false);

    useEffect(() => {
        if (!isLoggedIn) router.replace('/sign-in');
    }, [isLoggedIn, router]);

    const loadDashboardData = async (storage: string) => {
        try {
            const [sess, pl, intr] = await Promise.all([
                loadSearchSessions(storage, session.fetch),
                loadRecommendations(storage, session.fetch),
                loadBehaveKnowledge(storage, session.fetch),
            ]);
            setSessions(sess);
            setPlaylists(pl);
            setInteractions(intr);
        } catch (err) {
            console.error("Failed to load dashboard data:", err);
        }
    };

    // 🎯 Jalankan algoritma scoring
    const insights: DashboardInsights | null = useMemo(() => {
        if (playlists.length === 0) return null;
        return generateSmartRecommendations(sessions, playlists, interactions, limit, shuffleSeed);
    }, [sessions, playlists, interactions, limit, shuffleSeed]);

    useEffect(() => {
        if (isLoggedIn && session?.info?.webId) {
            (async () => {
                try {
                    let podUrls = await getPodUrlAll(session.info.webId!, { fetch: session.fetch });
                    if (!podUrls.length) podUrls = [session.info.webId!.replace('/profile/card#me', '/')];
                    const storage = podUrls[0];
                    setStorageRoot(storage);

                    await initializePodFiles(storage, session.fetch);

                    const settings = await loadSettings(storage, session.fetch);

                    if (!settings || settings.genres.length === 0) {
                        setNeedsOnboarding(true);
                        setShowSettings(true);
                    } else {
                        await loadDashboardData(storage);
                    }
                } catch (err: any) {
                    toast.error('Failed to connect to Solid Pod');
                } finally {
                    setLoading(false);
                }
            })();
        }
    }, [isLoggedIn, session]);

    const handleOnboardingSuccess = async () => {
        setNeedsOnboarding(false);
        setShowSettings(false);
        if (storageRoot) {
            setLoading(true);
            await loadDashboardData(storageRoot);
            setLoading(false);
            toast.success('🎉 Welcome! Ready to generate your first recommendations.');
            router.push('/findMore');
        }
    };

    const handleReload = async () => {
        if (!storageRoot || reloading) return;
        setReloading(true);
        await loadDashboardData(storageRoot);
        setShuffleSeed(prev => prev + 1);
        setReloading(false);
        toast.success('Fresh picks loaded!', { duration: 1500 });
    };

    return (
        <div className="min-h-screen bg-gray-800 text-white">
            <Toaster position="bottom-right" />
            <div className="max-w-6xl mx-auto flex flex-col p-6">
                <Header storageRoot={storageRoot} />

                {showSettings && (
                    <SettingsModal
                        storageRoot={storageRoot}
                        isMandatory={needsOnboarding}
                        onClose={() => !needsOnboarding && setShowSettings(false)}
                        onSaveSuccess={handleOnboardingSuccess}
                    />
                )}

                <main className="mt-6">
                    <div className="flex items-center justify-between mb-6">
                        <div>
                            <h2 className="text-2xl font-bold">Your Music Dashboard</h2>
                            <p className="text-gray-400 text-sm">
                                Smart recommendations based on your search history + interactions.
                            </p>
                        </div>
                        <button
                            onClick={() => setShowSettings(true)}
                            className="p-2 bg-gray-700 hover:bg-gray-600 rounded-full transition-colors"
                            title="Settings"
                        >
                            <Settings size={20} />
                        </button>
                    </div>

                    {loading ? (
                        <div className="text-center py-20 animate-pulse text-gray-400">
                            Analyzing your taste profile...
                        </div>
                    ) : (
                        <>
                            {/* 🎯 SMART RECOMMENDATIONS */}
                            {insights && insights.topSongs.length > 0 ? (
                                <section className="mb-10">
                                    <div className="flex items-center justify-between mb-4">
                                        <h3 className="text-xl font-bold flex items-center gap-2">
                                            <Sparkles className="text-indigo-400" />
                                            Top Picks For You
                                        </h3>
                                        <div className="flex items-center gap-3">
                                            {/* Song count selector */}
                                            <div className="flex items-center gap-1 bg-gray-700/50 rounded-full p-1">
                                                {([5, 10, 15] as const).map((n) => (
                                                    <button
                                                        key={n}
                                                        onClick={() => setLimit(n)}
                                                        className={`px-3 py-0.5 rounded-full text-xs font-semibold transition-all ${
                                                            limit === n
                                                                ? "bg-indigo-600 text-white shadow"
                                                                : "text-gray-400 hover:text-white"
                                                        }`}
                                                    >
                                                        {n}
                                                    </button>
                                                ))}
                                            </div>
                                            {/* Reload button */}
                                            <button
                                                onClick={handleReload}
                                                disabled={reloading}
                                                title="Get a fresh arrangement"
                                                className="flex items-center gap-1.5 px-3 py-1 bg-gray-700/50 hover:bg-gray-600/60 rounded-full text-xs font-semibold text-gray-300 hover:text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                                <RefreshCcw size={12} className={reloading ? "animate-spin" : ""} />
                                                {reloading ? "Loading..." : "Shuffle"}
                                            </button>
                                            <span className="text-xs text-gray-500 bg-gray-700/50 px-3 py-1 rounded-full">
                                                {insights.totalSessions} sessions · {insights.totalInteractions} interactions
                                            </span>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                        {insights.topSongs.map((scored, idx) => (
                                            <SongCard
                                                key={scored.song.songUrl || idx}
                                                storageRoot={storageRoot}
                                                songUrl={scored.song.songUrl}
                                                song={{
                                                    id: `smart-${idx}`,
                                                    title: scored.song.title,
                                                    artist: scored.song.artist,
                                                    imageSrc: scored.song.cover || undefined,
                                                    isPersonalized: true,
                                                    matchMethod: "Smart Ranking",
                                                    reason: scored.reasons[0] || "Recommended for you",
                                                }}
                                            />
                                        ))}
                                    </div>

                                    <div className="mt-6 flex justify-center">
                                        <button
                                            onClick={() => router.push('/findMore')}
                                            className="flex items-center gap-2 px-6 py-3 bg-indigo-600 hover:bg-indigo-700 rounded-lg font-semibold shadow-lg transition-all hover:scale-105"
                                        >
                                            <RefreshCcw size={18} />
                                            Generate New Recommendations
                                            <ArrowRight size={18} />
                                        </button>
                                    </div>
                                </section>
                            ) : (
                                <div className="text-center py-16 bg-gray-700/30 rounded-xl border border-gray-700 mb-10">
                                    <Sparkles size={48} className="mx-auto text-indigo-400 mb-4" />
                                    <h3 className="text-xl font-bold mb-2">Ready to discover?</h3>
                                    <p className="text-gray-400 mb-6">
                                        Generate your first AI-curated playlist to start building your taste profile.
                                    </p>
                                    <button
                                        onClick={() => router.push('/findMore')}
                                        className="px-6 py-3 bg-indigo-600 hover:bg-indigo-700 rounded-lg font-semibold"
                                    >
                                        Start First Recommendation
                                    </button>
                                </div>
                            )}

                            {/* 📊 TASTE PROFILE INSIGHTS */}
                            {insights && (insights.topGenres.length > 0 || insights.topArtists.length > 0) && (
                                <section className="mb-10 grid grid-cols-1 md:grid-cols-2 gap-4">
                                    {/* Top Genres */}
                                    {insights.topGenres.length > 0 && (
                                        <div className="bg-gray-700/30 p-5 rounded-xl border border-gray-700">
                                            <h4 className="font-bold text-lg mb-3 flex items-center gap-2">
                                                <BarChart3 size={18} className="text-indigo-400" />
                                                Top Genres
                                            </h4>
                                            <div className="space-y-2">
                                                {insights.topGenres.slice(0, 5).map((g, i) => {
                                                    const maxScore = insights.topGenres[0].score;
                                                    const pct = (g.score / maxScore) * 100;
                                                    return (
                                                        <div key={g.name} className="flex items-center gap-3">
                                                            <span className="text-xs text-gray-500 w-4">#{i + 1}</span>
                                                            <div className="flex-1">
                                                                <div className="flex justify-between mb-1">
                                                                    <span className="text-sm font-medium capitalize">{g.name}</span>
                                                                    <span className="text-xs text-gray-400">{g.score.toFixed(1)} pts</span>
                                                                </div>
                                                                <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                                                                    <div
                                                                        className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 rounded-full transition-all"
                                                                        style={{ width: `${pct}%` }}
                                                                    />
                                                                </div>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}

                                    {/* Top Artists */}
                                    {insights.topArtists.length > 0 && (
                                        <div className="bg-gray-700/30 p-5 rounded-xl border border-gray-700">
                                            <h4 className="font-bold text-lg mb-3 flex items-center gap-2">
                                                <Mic2 size={18} className="text-pink-400" />
                                                Top Artists
                                            </h4>
                                            <div className="space-y-2">
                                                {insights.topArtists.slice(0, 5).map((a, i) => {
                                                    const maxScore = insights.topArtists[0].score;
                                                    const pct = (a.score / maxScore) * 100;
                                                    return (
                                                        <div key={a.name} className="flex items-center gap-3">
                                                            <span className="text-xs text-gray-500 w-4">#{i + 1}</span>
                                                            <div className="flex-1">
                                                                <div className="flex justify-between mb-1">
                                                                    <span className="text-sm font-medium truncate">{a.name}</span>
                                                                    <span className="text-xs text-gray-400">{a.score.toFixed(1)} pts</span>
                                                                </div>
                                                                <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                                                                    <div
                                                                        className="h-full bg-gradient-to-r from-pink-500 to-rose-500 rounded-full transition-all"
                                                                        style={{ width: `${pct}%` }}
                                                                    />
                                                                </div>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}
                                </section>
                            )}

                            {/* 📊 SESSION STATS SUMMARY */}
                            {insights && insights.totalSessions > 0 && (
                                <section className="mb-10 grid grid-cols-3 gap-3">
                                    <div className="bg-gray-700/30 p-4 rounded-xl border border-gray-700 text-center">
                                        <Flame className="mx-auto mb-2 text-orange-400" size={24} />
                                        <div className="text-2xl font-bold">{insights.totalSessions}</div>
                                        <div className="text-xs text-gray-400">Search Sessions</div>
                                    </div>
                                    <div className="bg-gray-700/30 p-4 rounded-xl border border-gray-700 text-center">
                                        <TrendingUp className="mx-auto mb-2 text-green-400" size={24} />
                                        <div className="text-2xl font-bold">{insights.totalInteractions}</div>
                                        <div className="text-xs text-gray-400">Interactions</div>
                                    </div>
                                    <div className="bg-gray-700/30 p-4 rounded-xl border border-gray-700 text-center">
                                        <Music className="mx-auto mb-2 text-indigo-400" size={24} />
                                        <div className="text-2xl font-bold">{playlists.reduce((sum, p) => sum + p.songs.length, 0)}</div>
                                        <div className="text-xs text-gray-400">Total Songs</div>
                                    </div>
                                </section>
                            )}
                        </>
                    )}
                </main>
            </div>
        </div>
    );
}