import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const API_URL = process.env.API_URL || 'https://openrouter.ai/api/v1';
const API_KEY = process.env.OPENROUTER_API_KEY;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { messages, model, stream = false } = body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: 'Missing or invalid messages array' }, { status: 400 });
    }
    if (!model) {
      return NextResponse.json({ error: 'Missing model parameter' }, { status: 400 });
    }

    if (!API_KEY) {
      console.error('[OpenRouter ❌] OPENROUTER_API_KEY tidak ditemukan.');
      return NextResponse.json({ error: 'Server config error: OpenRouter API Key missing' }, { status: 500 });
    }

    let finalModel = model;
    
    // ✅ Hanya tambahkan 'openai/' jika model TIDAK sudah memiliki prefix '/'
    // Model seperti 'anthropic/...', 'google/...', 'meta-llama/...' akan tetap utuh.
    if (API_URL.includes('openrouter.ai') && !finalModel.includes('/')) {
      finalModel = `openai/${finalModel}`; 
    }

    // ✅ Hapus semua trailing slash (/) di akhir URL untuk mencegah double slash (//) yang menyebabkan 404
    const cleanApiUrl = API_URL.replace(/\/+$/, '');
    const requestUrl = `${cleanApiUrl}/chat/completions`;
    
    console.log(`[Router 📤] Forwarding to: ${requestUrl} with model: ${finalModel}`);

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'https://muserec-app.vercel.app',
      'X-Title': 'Muserec App'
    };

    const response = await fetch(requestUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: finalModel, messages, stream }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[Provider ❌ Upstream Error] Status: ${response.status} | Model: ${finalModel} | Body: ${errText}`);
      
      return NextResponse.json(
        { error: `Provider API Error (${response.status})`, details: errText },
        { status: response.status === 401 || response.status === 402 || response.status === 404 ? response.status : 500 }
      );
    }

    if (stream) {
      return new NextResponse(response.body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
      });
    }

    const data = await response.json();
    return NextResponse.json(data);

  } catch (err: any) {
    console.error("[Router ❌ Unhandled Exception]", err);
    return NextResponse.json({ error: 'Internal Server Error', details: err.message }, { status: 500 });
  }
}