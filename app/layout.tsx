import type { Metadata } from 'next'
import React from 'react'
import './globals.css'
import { SolidSessionProvider } from '@/src/contexts/SolidSessionContext'

export const metadata: Metadata = {
    title: 'MuseRec',
    description: 'Music Recommendation App',
}

export default function RootLayout({
    children,
}: {
    children: React.ReactNode
}) {
    return (
        <html lang="en">
            <body className="bg-gray-900 text-white min-h-screen">
                <SolidSessionProvider>
                    {children}
                </SolidSessionProvider>
            </body>
        </html>
    )
}
