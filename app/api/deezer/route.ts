
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q');

    if (!query) {
        return NextResponse.json({ error: 'Missing query parameter "q"' }, { status: 400 });
    }

    try {
        const res = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=10`);
        const data = await res.json();
        return NextResponse.json(data);
    } catch (error) {
        console.error('Deezer API error:', error);
        return NextResponse.json({ error: 'Failed to fetch from Deezer' }, { status: 500 });
    }
}
