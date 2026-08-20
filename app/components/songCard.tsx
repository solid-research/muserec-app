"use client";

import React, { useState, useEffect } from "react";
import { CheckCircle2, Sparkles, ThumbsUp, ThumbsDown, Play } from "lucide-react";
import { useSolidSession } from "@/src/contexts/SolidSessionContext";
import { saveInteraction } from "@/src/solid-storage";
import { v4 as uuidv4 } from "uuid";
import toast from "react-hot-toast";

export interface SongRecommendation {
    id?: string;
    title?: string;
    artist?: string;
    imageSrc?: string;
    matchMethod?: string;
    isPersonalized?: boolean;
    isGenreMatch?: boolean;
    previewUrl?: string;
    reason?: string;
}

export interface SongCardProps {
    song?: SongRecommendation;
    storageRoot?: string | null;
    songUrl?: string;          // 🎯 Reference URL from playlists/seeds
    playlistId?: string;       // For backward compatibility
    onPreview?: () => void;
    rating?: "like" | "dislike" | null;
}

export default function SongCard({
    song, storageRoot, songUrl, playlistId, onPreview, rating: initialRating
}: SongCardProps) {
    const { session } = useSolidSession();
    const [currentRating, setCurrentRating] = useState<"like" | "dislike" | null>(initialRating || null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        setCurrentRating(initialRating || null);
    }, [initialRating]);

    const handleRate = async (type: "like" | "dislike") => {
        // 🎯 Need songUrl for proper reference
        if (!storageRoot || !songUrl || saving) {
            if (!songUrl) {
                toast.error("Song reference not available");
            }
            return;
        }

        const newRating = currentRating === type ? null : type;
        setCurrentRating(newRating);
        setSaving(true);

        try {
            await saveInteraction(storageRoot, {
                interactionId: uuidv4(),
                songRef: songUrl,  // 🎯 REFERENCE ONLY - no title/artist data!
                action: type,
                ratingValue: newRating === "like" ? 1 : -1,
                timestamp: new Date()
            }, session.fetch);

            if (newRating) {
                toast.success(`Saved ${newRating}!`, { duration: 2000 });
            }
        } catch (err) {
            console.error("Failed to save:", err);
            toast.error("Failed to save.");
            setCurrentRating(initialRating || null);
        } finally {
            setSaving(false);
        }
    };

    const handlePreview = () => {
        if (onPreview) onPreview();

        if (storageRoot && songUrl) {
            saveInteraction(storageRoot, {
                interactionId: uuidv4(),
                songRef: songUrl,  // 🎯 REFERENCE ONLY
                action: 'preview',
                timestamp: new Date()
            }, session.fetch).catch(console.error);
        }
    };

    const fallbackImage = "https://images.genius.com/2e57a191dbf4415737d22eeb90b1fb99.1000x1000x1.png";

    return (
        <div className="bg-white p-4 rounded-lg shadow text-gray-900 flex flex-col gap-3 items-center transition-all hover:shadow-lg border border-gray-100">
            <div className="flex items-center gap-2 flex-wrap justify-center min-h-[24px]">
                {song?.matchMethod && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-green-100 text-green-700 rounded-full font-semibold">
                        <CheckCircle2 size={10} /> {song.matchMethod}
                    </span>
                )}
                {song?.isPersonalized && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-purple-100 text-purple-700 rounded-full font-semibold">
                        <Sparkles size={10} /> Personalized
                    </span>
                )}
                {song?.isGenreMatch && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-blue-100 text-blue-700 rounded-full font-semibold">
                        🎯 Genre Match
                    </span>
                )}
            </div>

            <div className="relative group w-full flex justify-center">
                <img
                    src={song?.imageSrc || fallbackImage}
                    alt={`${song?.title || "Song"} cover`}
                    className="w-48 h-48 aspect-square object-cover rounded-md bg-gray-200"
                />
                {song?.previewUrl && (
                    <button
                        onClick={handlePreview}
                        className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity rounded-md"
                    >
                        <div className="w-12 h-12 bg-white rounded-full flex items-center justify-center text-indigo-600 shadow-lg">
                            <Play size={24} fill="currentColor" />
                        </div>
                    </button>
                )}
            </div>

            <div className="w-full text-center min-w-0">
                <h3 className="font-bold text-base truncate" title={song?.title}>
                    {song?.title || "Song Title"}
                </h3>
                <p className="text-blue-600 font-medium text-sm truncate" title={song?.artist}>
                    {song?.artist || "Artist"}
                </p>
            </div>

            {song?.reason && (
                <p className="text-xs text-gray-500 italic text-center line-clamp-2" title={song.reason}>
                    "{song.reason}"
                </p>
            )}

            <div className="flex flex-row justify-between items-center w-full mt-1 pt-2 border-t border-gray-100">
                <button
                    type="button"
                    onClick={handlePreview}
                    disabled={!song?.previewUrl}
                    className={`px-3 py-1.5 rounded text-xs font-semibold transition-colors flex items-center gap-1.5 ${song?.previewUrl
                        ? "bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
                        : "bg-gray-100 text-gray-400 cursor-not-allowed"
                        }`}
                >
                    <Play size={12} /> Preview
                </button>

                <div className="flex flex-row gap-3 items-center">
                    <button
                        type="button"
                        onClick={() => handleRate("like")}
                        disabled={saving || !songUrl}
                        className={`transition-all duration-200 ${currentRating === "like"
                            ? "text-green-600 scale-110"
                            : "text-gray-400 hover:text-green-500"
                            } ${saving || !songUrl ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                        title={songUrl ? "Like this song" : "Reference not available"}
                    >
                        <ThumbsUp
                            size={18}
                            className={currentRating === "like" ? "fill-green-600" : ""}
                        />
                    </button>

                    <button
                        type="button"
                        onClick={() => handleRate("dislike")}
                        disabled={saving || !songUrl}
                        className={`transition-all duration-200 ${currentRating === "dislike"
                            ? "text-red-600 scale-110"
                            : "text-gray-400 hover:text-red-500"
                            } ${saving || !songUrl ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                        title={songUrl ? "Dislike this song" : "Reference not available"}
                    >
                        <ThumbsDown
                            size={18}
                            className={currentRating === "dislike" ? "fill-red-600" : ""}
                        />
                    </button>
                </div>
            </div>
        </div>
    );
}