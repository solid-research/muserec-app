import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Baca variabel lingkungan dengan aman
const API_URL = process.env.API_URL || 'https://openrouter.ai/api/v1';
const API_KEY = process.env.OPENROUTER_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Mapping model sederhana
const GEMINI_MODEL_MAP: Record<string, string> = {
  'gemini-pro': 'gemini-1.5-flash',
  'gemini-1.5-pro': 'gemini-1.5-flash',
  'gemini-1.5-flash': 'gemini-1.5-flash',
  'gemini-2.0-flash': 'gemini-1.5-flash',
};

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
    const isAnthropic = lowerModel.includes('claude');

    // ==========================================================
    // RUTE 1: GEMINI API
    // ==========================================================
    if (isGemini) {
      if (!GEMINI_API_KEY) {
        console.error('[Gemini ❌] GEMINI_API_KEY tidak ditemukan di Environment Variables.');
        return NextResponse.json({ error: 'Server configuration error: Gemini API Key missing' }, { status: 500 });
      }

      // Validasi format kunci API Google
      if (!GEMINI_API_KEY.startsWith('AIzaSy')) {
        console.error('[Gemini ❌] Format GEMINI_API_KEY tidak valid. Harus diawali dengan "AIzaSy". Key saat ini:', GEMINI_API_KEY.substring(0, 6) + '...');
        return NextResponse.json({ 
          error: 'Invalid Gemini API Key format. Key harus diawali dengan "AIzaSy". Silakan buat kunci baru di Google AI Studio.' 
        }, { status: 500 });
      }

      const resolvedModel = GEMINI_MODEL_MAP[model] || 'gemini-1.5-flash';
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
        generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
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
        console.error(`[Gemini ❌ Upstream Error] Status: ${response.status}`);
        console.error(`[Gemini ❌ Upstream Body] ${errText}`);
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
    // RUTE 2: OPENROUTER / LITELLM (Fallback untuk model lain)
    // ==========================================================
    if (!API_KEY) {
      console.error('[OpenRouter ❌] OPENROUTER_API_KEY tidak ditemukan di Environment Variables.');
      return NextResponse.json({ error: 'Server configuration error: API Key missing' }, { status: 500 });
    }

    console.log(`[Router 📤] Forwarding to: ${API_URL} with model: ${model}`);

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    };

    // Header wajib jika menggunakan OpenRouter langsung
    if (API_URL.includes('openrouter.ai')) {
      headers['HTTP-Referer'] = process.env.NEXT_PUBLIC_APP_URL || 'https://muserec-app.vercel.app';
      headers['X-Title'] = 'Muserec App';
    }

    const response = await fetch(`${API_URL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages, stream }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[Provider ❌ Upstream Error] Status: ${response.status}`);
      console.error(`[Provider ❌ Upstream Body] ${errText}`);
      
      return NextResponse.json(
        { error: `Provider API Error (${response.status})`, details: errText },
        { status: response.status === 401 || response.status === 403 ? response.status : 500 }
      );
    }

    if (stream) {
      return new NextResponse(response.body, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    const data = await response.json();
    return NextResponse.json(data);

  } catch (err: any) {
    console.error("[Router ❌ Unhandled Exception]", err);
    return NextResponse.json(
      { error: 'Internal Server Error', details: err.message }, 
      { status: 500 }
    );
  }
}
