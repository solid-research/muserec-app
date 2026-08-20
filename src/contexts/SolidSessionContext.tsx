'use client';

import React, {
    createContext,
    useContext,
    useEffect,
    useState,
    ReactNode,
} from 'react';
import {
    getDefaultSession,
    handleIncomingRedirect,
    Session,
} from '@inrupt/solid-client-authn-browser';

// Tipe context
interface SolidSessionContextType {
    session: Session;
    isLoggedIn: boolean;
    login: (options: {
        oidcIssuer: string;
        clientId?: string;
        redirectUrl: string;
        clientName: string;
    }) => Promise<void>;
    logout: () => Promise<void>;
}

// Buat context
const SolidSessionContext = createContext<SolidSessionContextType | undefined>(undefined);

// Provider
export function SolidSessionProvider({ children }: { children: ReactNode }) {
    const [session, setSession] = useState<Session>(getDefaultSession());
    const [isLoggedIn, setIsLoggedIn] = useState<boolean>(session.info.isLoggedIn);
    const [loading, setLoading] = useState<boolean>(true);

    useEffect(() => {
        async function init() {
            try {
                console.log("SolidSessionProvider: Handling incoming redirect...");
                await handleIncomingRedirect({ restorePreviousSession: true });
                console.log("SolidSessionProvider: Redirect handled.");
            } catch (err) {
                console.error("SolidSessionProvider: Error handling redirect:", err);
            } finally {
                const sess = getDefaultSession();
                setSession(sess);
                setIsLoggedIn(sess.info.isLoggedIn);
                console.log("SolidSessionProvider: Logged in status:", sess.info.isLoggedIn);
                setLoading(false);
            }
        }
        init();
    }, []);

    const login = async ({
        oidcIssuer,
        clientId,
        redirectUrl,
        clientName,
    }: {
        oidcIssuer: string;
        clientId?: string;
        redirectUrl: string;
        clientName: string;
    }) => {
        await session.login({ oidcIssuer, clientId, redirectUrl, clientName });
    };

    const logout = async () => {
        await session.logout();
        setIsLoggedIn(false);
        setSession(getDefaultSession());
        localStorage.clear();
    };

    if (loading) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen bg-gray-900 text-white gap-4">
                <div>Loading authentication...</div>
                <button
                    onClick={() => {
                        localStorage.clear();
                        window.location.href = '/sign-in';
                    }}
                    className="px-4 py-2 bg-red-600 rounded hover:bg-red-700"
                >
                    Reset & Reload
                </button>
            </div>
        );
    }

    return (
        <SolidSessionContext.Provider
            value={{ session, isLoggedIn, login, logout }}
        >
            {children}
        </SolidSessionContext.Provider>
    );
}

// Hook aman
export function useSolidSession(): SolidSessionContextType {
    const context = useContext(SolidSessionContext);

    if (!context) {
        // Saat prerendering di server-side
        if (typeof window === 'undefined') {
            return {
                session: getDefaultSession(),
                isLoggedIn: false,
                login: async () => { },
                logout: async () => { },
            };
        }

        // Saat client-side tapi tidak dibungkus (fallback + warning)
        console.warn(
            '⚠️ useSolidSession is called outside <SolidSessionProvider>. Using empty fallback session.'
        );
        return {
            session: getDefaultSession(),
            isLoggedIn: false,
            login: async () => { },
            logout: async () => { },
        };
    }

    return context;
}
