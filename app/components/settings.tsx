"use client";

import { useState, useEffect } from "react";
import { X } from "lucide-react";
import GenreSelector from "./genreSelector";
import { useSolidSession } from "@/src/contexts/SolidSessionContext";
import { loadSettings, saveSettings, UserSettings } from "@/src/solid-storage";
import toast from "react-hot-toast";

interface SettingsModalProps {
    storageRoot?: string | null;
    isMandatory?: boolean;
    onClose: () => void;
    onSaveSuccess?: () => void;
}

export default function SettingsModal({ storageRoot, isMandatory = false, onClose, onSaveSuccess }: SettingsModalProps) {
    const { session } = useSolidSession();
    const [loading, setLoading] = useState(false);
    const [settings, setSettings] = useState<UserSettings>({
        ageRange: "18", genres: [], favoriteArtists: [], feelings: []
    });

    useEffect(() => {
        if (storageRoot) {
            loadSettings(storageRoot, session.fetch).then(data => {
                if (data) setSettings(data);
            });
        }
    }, [storageRoot]);

    const handleGenreToggle = (genreValue: string) => {
        if (settings.genres.includes(genreValue)) {
            setSettings({ ...settings, genres: settings.genres.filter((g) => g !== genreValue) });
        } else if (settings.genres.length < 3) {
            setSettings({ ...settings, genres: [...settings.genres, genreValue] });
        }
    };

    const handleSave = async () => {
        if (!storageRoot) return;
        if (settings.genres.length === 0) {
            toast.error("Please select at least one genre!");
            return;
        }
        setLoading(true);
        try {
            await saveSettings(storageRoot, settings, session.fetch);
            toast.success("Settings saved to Solid Pod!");
            if (onSaveSuccess) onSaveSuccess();
            if (!isMandatory) onClose();
        } catch (err) {
            toast.error("Failed to save settings.");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div 
            className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4" 
            onClick={isMandatory ? undefined : onClose}
        >
            <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md text-gray-900" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-4">
                    <h2 className="text-xl font-bold">{isMandatory ? "Welcome to MuseRec! 🎵" : "Account Settings"}</h2>
                    {!isMandatory && <button onClick={onClose} className="text-gray-500 hover:text-gray-800"><X size={20} /></button>}
                </div>
                
                {isMandatory && <p className="text-sm text-gray-500 mb-4">Let's personalize your music experience. This will only take a minute.</p>}

                <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-1">
                        <label className="text-sm font-medium">Age Range</label>
                        <select value={settings.ageRange} onChange={(e) => setSettings({...settings, ageRange: e.target.value})} className="border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                            <option value="18">18-24</option>
                            <option value="25">25-34</option>
                            <option value="35">35+</option>
                        </select>
                    </div>

                    <div className="flex flex-col gap-1">
                        <label className="text-sm font-medium">Favorite Genres (Max 3)</label>
                        <GenreSelector selectedGenres={settings.genres} onGenreToggle={handleGenreToggle} maxSelection={3} showCount={true} />
                    </div>
                </div>

                <div className="flex justify-end gap-2 mt-6">
                    {!isMandatory && (
                        <button onClick={onClose} className="px-4 py-2 rounded-md bg-gray-200 text-gray-700 hover:bg-gray-300 transition-colors">Cancel</button>
                    )}
                    <button onClick={handleSave} disabled={loading} className="px-4 py-2 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 transition-colors disabled:opacity-50 font-semibold">
                        {loading ? "Saving..." : (isMandatory ? "Save" : "Save to Pod")}
                    </button>
                </div>
            </div>
        </div>
    );
}