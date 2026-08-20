"use client";

import { useState, useRef, useEffect } from "react";
import { ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { useSolidSession } from "@/src/contexts/SolidSessionContext";
import SettingsModal from "./settings";

interface HeaderProps { storageRoot?: string | null; }

export default function Header({ storageRoot }: HeaderProps) {
    const router = useRouter();
    const { session, logout } = useSolidSession();
    const [showSettings, setShowSettings] = useState(false);
    const [showMenu, setShowMenu] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    // Click outside to close dropdown
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setShowMenu(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    return (
        <>
            {showSettings && <SettingsModal storageRoot={storageRoot} onClose={() => setShowSettings(false)} />}

            <header className="flex items-center gap-4 relative py-2">
                <button onClick={() => router.push("/")} className="text-2xl font-bold text-gray-100 hover:text-white transition-colors">
                    MuseRec
                </button>

                <div className="absolute right-0 flex items-center gap-2">
                    <button onClick={() => router.push("/findMore")} className="px-4 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors">
                        Find more songs
                    </button>

                    <div className="relative" ref={menuRef}>
                        <button
                            onClick={() => setShowMenu(!showMenu)}
                            title={session?.info?.webId || "Account"}
                            className="px-4 py-2 rounded-md bg-gray-700 text-gray-200 text-sm font-medium hover:bg-gray-600 transition-colors flex items-center gap-2 max-w-[220px]"
                        >
                            <span className="truncate">
                                {session?.info?.webId ? new URL(session.info.webId).hostname : "Account"}
                            </span>
                            <ChevronDown className="w-4 h-4 shrink-0" />
                        </button>

                        {showMenu && (
                            <div className="absolute right-0 mt-2 w-56 origin-top-right rounded-md bg-gray-800 shadow-lg ring-1 ring-white/10 z-50">
                                <div className="py-1">
                                    <button onClick={() => { router.push("/accountHistory"); setShowMenu(false); }} className="w-full text-left block px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 hover:text-white">
                                        History
                                    </button>
                                    <button onClick={() => { logout(); setShowMenu(false); }} className="w-full text-left block px-4 py-2 text-sm text-gray-300 hover:bg-red-500 hover:text-white">
                                        Log out
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </header>
        </>
    );
}