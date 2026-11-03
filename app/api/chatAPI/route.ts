import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Baca variabel lingkungan dengan aman
const API_URL = process.env.API_URL || 'https://openrouter.ai/api/v1';
const API_KEY = process.env.OPENROUTER_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

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

    const lowerModel = model.toLowerCase();
    const isGemini = lowerModel.includes('gemini');

    // ==========================================================
    // RUTE 1: GEMINI API (Langsung ke Google)
    // ==========================================================
    if (isGemini) {
      if (!GEMINI_API_KEY) {
        console.error('[Gemini ❌] GEMINI_API_KEY tidak ditemukan.');
        return NextResponse.json({ error: 'Server config error: Gemini API Key missing' }, { status: 500 });
      }

      // Menerima format lama (AIzaSy) DAN format baru Auth Key (AQ.)
      const isValidGeminiKey = GEMINI_API_KEY.startsWith('AIzaSy') || GEMINI_API_KEY.startsWith('AQ.');
      if (!isValidGeminiKey) {
        console.error('[Gemini ❌] Format key tidak valid:', GEMINI_API_KEY.substring(0, 6) + '...');
        return NextResponse.json({ error: 'Invalid Gemini API Key format.' }, { status: 500 });
      }

      // Normalisasi nama model untuk Google API
      const resolvedModel = model.includes('gemini-2.0') ? 'gemini-2.0-flash' : 'gemini-1.5-flash';
      
      let systemPrompt = "";
      const geminiContents: any[] = [];

      for (const msg of messages) {
        if (msg.role === 'system') {
          systemPrompt += (systemPrompt ? "\n\n" : "") + (msg.content || "");
        } else {
          const geminiRole = msg.role === 'assistant' ? 'model' : 'user';
          const lastMsg = geminiContents[geminiContents.length - 1];
          if (lastMsg && lastMsg.role === geminiRole) {
            lastMsg.parts[0].text += "\n\n" + (msg.content || "");
          } else {
            geminiContents.push({ role: geminiRole, parts: [{ text: msg.content || "" }] });
          }
        }
      }

      if (geminiContents.length === 0 || geminiContents[0].role !== 'user') {
        geminiContents.unshift({ role: 'user', parts: [{ text: "Hello" }] });
      }

      const geminiBody: any = {
        contents: geminiContents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
      };
      if (systemPrompt.trim()) {
        geminiBody.systemInstruction = { parts: [{ text: systemPrompt.trim() }] };
      }

      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${resolvedModel}:generateContent?key=${GEMINI_API_KEY}`;
      
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[Gemini ❌ Upstream Error] Status: ${response.status} | Body: ${errText}`);
        return NextResponse.json(
          { error: `Gemini API Error (${response.status})`, details: errText },
          { status: response.status === 400 || response.status === 401 ? response.status : 500 }
        );
      }

      const data = await response.json();
      const content = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      
      return NextResponse.json({
        id: `gemini-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: resolvedModel,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      });
    }

    // ==========================================================
    // RUTE 2: OPENROUTER (GPT-4o, Claude, Llama, Mistral, dll)
    // ==========================================================
    if (!API_KEY) {
      console.error('[OpenRouter ❌] OPENROUTER_API_KEY tidak ditemukan.');
      return NextResponse.json({ error: 'Server config error: OpenRouter API Key missing' }, { status: 500 });
    }

    let finalModel = model;
    
    // ✅ PERBAIKAN PENTING: Hanya tambahkan 'openai/' jika model TIDAK sudah memiliki prefix '/'
    // Contoh: 'gpt-4o' -> 'openai/gpt-4o', TAPI 'anthropic/claude-3.5-sonnet' tetap utuh.
    if (API_URL.includes('openrouter.ai') && !finalModel.includes('/')) {
      finalModel = `openai/${finalModel}`; 
      console.log(`[Router 🔄] Auto-fix model untuk OpenRouter: "${model}" → "${finalModel}"`);
    }

    // ✅ PERBAIKAN KRUSIAL: Hapus semua trailing slash (/) di akhir URL secara otomatis
    // agar tidak terjadi double slash (//) yang menyebabkan error 404 di OpenRouter
    const cleanApiUrl = API_URL.replace(/\/+$/, '');
    const requestUrl = `${cleanApiUrl}/chat/completions`;
    
    console.log(`[Router 📤] Forwarding to: ${requestUrl} with model: ${finalModel}`);

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'https://muserec-app.vercel.app',
      'X-Title': 'Muserec App'
    };

    const response = await fetch(requestUrl, { // <-- Gunakan requestUrl yang sudah dibersihkan
      method: 'POST',
      headers,
      body: JSON.stringify({ model: finalModel, messages, stream }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[Provider ❌ Upstream Error] Status: ${response.status} | Body: ${errText}`);
      
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