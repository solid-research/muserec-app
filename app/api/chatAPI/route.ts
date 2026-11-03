import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

// 1. Gunakan variabel tanpa NEXT_PUBLIC_ untuk keamanan
const BASE_URL = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'https://openrouter.ai/api/v1';
const API_KEY = process.env.OPENROUTER_API_KEY || process.env.NEXT_PUBLIC_API_KEY;

const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ==========================================================
// HELPER: Mapping Model Claude
// ==========================================================
const CLAUDE_MODEL_MAP: Record<string, string> = {
  'claude-3-opus-20240229': 'claude-3-5-sonnet-20241022',
  'claude-3-opus': 'claude-3-5-sonnet-20241022',
  'claude-3-sonnet-20240229': 'claude-3-5-sonnet-20241022',
  'claude-3-haiku-20240307': 'claude-3-5-sonnet-20241022',
  'claude-3-5-sonnet-20240620': 'claude-3-5-sonnet-20241022',
  'claude-3-5-sonnet-latest': 'claude-3-5-sonnet-20241022',
};

function resolveClaudeModel(model: string): string {
  for (const [oldModel, newModel] of Object.entries(CLAUDE_MODEL_MAP)) {
    if (model === oldModel || model.startsWith(oldModel)) {
      return newModel;
    }
  }
  return model;
}

// ==========================================================
// HELPER: Mapping Model Gemini
// ==========================================================
const GEMINI_MODEL_MAP: Record<string, string> = {
  'gemini-pro': 'gemini-1.5-flash',
  'gemini-1.0-pro': 'gemini-1.5-flash',
  'gemini-1.5-pro': 'gemini-1.5-flash',
  'gemini-1.5-pro-latest': 'gemini-1.5-flash',
  'gemini-1.5-flash-latest': 'gemini-1.5-flash',
  'gemini-2.0-flash': 'gemini-1.5-flash',
};

function resolveGeminiModel(model: string): string {
  return GEMINI_MODEL_MAP[model] || model;
}

// ==========================================================
// HELPER: Call Gemini API
// ==========================================================
async function callGeminiAPI(model: string, messages: any[]) {
  const resolvedModel = resolveGeminiModel(model);
  
  let systemPrompt = "";
  const geminiContents: any[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemPrompt += (systemPrompt ? "\n\n" : "") + (msg.content || "");
    } else if (msg.role === 'user' || msg.role === 'assistant') {
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
    generationConfig: { temperature: 0.7, maxOutputTokens: 8192, topP: 0.95, topK: 40 },
  };

  if (systemPrompt.trim()) {
    geminiBody.systemInstruction = { parts: [{ text: systemPrompt.trim() }] };
  }

  const endpoint = `${GEMINI_BASE_URL}/models/${resolvedModel}:generateContent?key=${GEMINI_API_KEY}`;
  
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(geminiBody),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API Error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

  return NextResponse.json({
    id: `gemini-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: resolvedModel,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: data.usageMetadata?.promptTokenCount || 0,
      completion_tokens: data.usageMetadata?.candidatesTokenCount || 0,
      total_tokens: data.usageMetadata?.totalTokenCount || 0
    }
  });
}

// ==========================================================
// MAIN POST HANDLER
// ==========================================================
export async function POST(req: NextRequest) {
  try {
    // 1. Safe JSON Parsing
    let body;
    try {
      body = await req.json();
    } catch (e) {
      return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }

    const { messages, model, stream = false } = body;

    // 2. Validasi Input
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: 'Missing or invalid messages array' }, { status: 400 });
    }
    if (!model) {
      return NextResponse.json({ error: 'Missing model parameter' }, { status: 400 });
    }
    if (!API_KEY && !model.toLowerCase().includes('gemini')) {
      console.error("[Router ❌] API Key is missing from environment variables!");
      return NextResponse.json({ error: 'Server configuration error: API Key missing' }, { status: 500 });
    }

    console.log(`[Router 📨] Received request for model: "${model}"`);

    const lowerModel = model.toLowerCase();
    const isAnthropic = lowerModel.includes('claude');
    const isGemini = lowerModel.includes('gemini');

    // ==========================================================
    // RUTE 1: ANTHROPIC
    // ==========================================================
    if (isAnthropic && ANTHROPIC_API_KEY) {
      const resolvedModel = resolveClaudeModel(model);
      let systemPrompt = "";
      const anthropicMessages: any[] = [];

      for (const msg of messages) {
        if (msg.role === 'system') {
          systemPrompt += (systemPrompt ? "\n\n" : "") + (msg.content || "");
        } else {
          anthropicMessages.push({ role: msg.role, content: msg.content || "" });
        }
      }

      const anthropicBody: any = {
        model: resolvedModel,
        messages: anthropicMessages,
        max_tokens: 8192,
      };
      if (systemPrompt.trim()) anthropicBody.system = systemPrompt.trim();

      const response = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(anthropicBody),
      });

      if (!response.ok) {
        const errText = await response.text();
        return NextResponse.json({ error: `Anthropic Error: ${errText}` }, { status: response.status });
      }

      const data = await response.json();
      const content = data.content?.find((c: any) => c.type === 'text')?.text || "";

      return NextResponse.json({
        id: data.id || `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: data.model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: data.stop_reason || 'stop' }],
        usage: {
          prompt_tokens: data.usage?.input_tokens || 0,
          completion_tokens: data.usage?.output_tokens || 0,
          total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
        }
      });
    }

    // ==========================================================
    // RUTE 2: GEMINI
    // ==========================================================
    else if (isGemini && GEMINI_API_KEY) {
      try {
        return await callGeminiAPI(model, messages);
      } catch (err: any) {
        console.error("[Gemini ❌ Error]", err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
      }
    }

    // ==========================================================
    // RUTE 3: LITELLM / OPENROUTER (Fallback)
    // ==========================================================
    else {
      console.log(`[Router 📤] Forwarding to: ${BASE_URL} with model: ${model}`);

      // Header wajib untuk OpenRouter (Best Practice)
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      };

      // Jika menggunakan OpenRouter, tambahkan header identifikasi agar tidak diblokir
      if (API_KEY?.startsWith('sk-or-v1-') || BASE_URL?.includes('openrouter')) {
        headers['HTTP-Referer'] = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
        headers['X-Title'] = 'RAG Flow App';
      }

      const response = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, messages, stream }),
      });

      // Tangani error dari upstream dengan detail
      if (!response.ok) {
        const errText = await response.text();
        console.error(`[Provider ❌ Error] Status: ${response.status}`);
        console.error(`[Provider ❌ Error] Body: ${errText}`);
        
        return NextResponse.json(
          { error: `Provider API Error (${response.status})`, details: errText },
          { status: response.status }
        );
      }

      // Handle Streaming
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
      
      // Handle Non-Streaming
      const data = await response.json();
      return NextResponse.json(data);
    }

  } catch (err: any) {
    console.error("[Router ❌ Unhandled Exception]", err);
    return NextResponse.json(
      { error: 'Internal Server Error', details: err.message }, 
      { status: 500 }
    );
  }
}