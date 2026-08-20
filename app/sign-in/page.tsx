'use client';

import React, { useState, useEffect } from 'react';
import { useSolidSession } from '@/src/contexts/SolidSessionContext';
import toast, { Toaster } from 'react-hot-toast';
import { useRouter } from 'next/navigation';

export default function SignInPage() {
    const [oidcIssuer, setOidcIssuer] = useState('https://login.inrupt.com');
    const { session, isLoggedIn } = useSolidSession();
    const router = useRouter();

    useEffect(() => {
        if (isLoggedIn) {
            router.replace('/');
        }
    }, [isLoggedIn, router]);

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            await session.login({
                oidcIssuer,
                redirectUrl: window.location.origin,
                clientName: 'MuseRec App'
            });
        } catch (error) {
            toast.error('Login failed. Please check the OIDC provider.');
            console.error(error);
        }
    };

    return (
        <div className="flex min-h-full flex-col justify-center px-6 py-12 lg:px-8">
            <Toaster position="bottom-right" />
            <div className="sm:mx-auto sm:w-full sm:max-w-sm">
                <h1 className="text-center text-lg font-bold text-white">
                    Welcome to MuseRec!
                </h1>
                <h2 className="text-center text-sm text-gray-400">
                    Please input your OIDC provider to start.
                </h2>
            </div>

            <div className="mt-10 sm:mx-auto sm:w-full sm:max-w-sm">
                <form className="space-y-6" onSubmit={handleLogin}>
                    <div>
                        <label htmlFor="oidc_provider" className="block text-sm font-medium leading-6 text-white">OIDC Provider</label>
                        <div className="mt-2">
                            <input
                                id="oidc_provider"
                                name="oidc_provider"
                                type="text"
                                required
                                value={oidcIssuer}
                                onChange={(e) => setOidcIssuer(e.target.value)}
                                className="block w-full rounded-md border-0 py-3 px-3 text-gray-900 shadow-lg ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm sm:leading-6"
                            />
                        </div>
                    </div>

                    <div>
                        <button type="submit" className="flex w-full justify-center rounded-md bg-indigo-600 px-6 py-3 text-base font-semibold leading-6 text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
                            Sign in to Solid
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
