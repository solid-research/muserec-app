import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

// Environment Variables
const BASE_URL = process.env.NEXT_PUBLIC_API_URL;
const API_KEY = process.env.NEXT_PUBLIC_API_KEY;

const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Gemini Base URL
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ==========================================================
// HELPER: Mapping Model Lama → Model Tersedia (CLAUDE)
// ==========================================================
const CLAUDE_MODEL_MAP: Record<string, string> = {
    'claude-3-opus-20240229': 'claude-sonnet-5',
    'claude-3-opus': 'claude-sonnet-5',
    'claude-3-sonnet-20240229': 'claude-sonnet-5',
    'claude-3-haiku-20240307': 'claude-sonnet-5',
    'claude-3-5-sonnet-20240620': 'claude-sonnet-5',
    'claude-3-5-sonnet-20241022': 'claude-sonnet-5',
    'claude-3-5-sonnet-latest': 'claude-sonnet-5',
    'claude-3-7-sonnet-20250219': 'claude-sonnet-5',
    'claude-sonnet-4-20250514': 'claude-sonnet-5',
};

function resolveClaudeModel(model: string): string {
    for (const [oldModel, newModel] of Object.entries(CLAUDE_MODEL_MAP)) {
        if (model === oldModel || model.startsWith(oldModel)) {
            console.log(`[Claude] 🔄 Remapped: "${model}" → "${newModel}"`);
            return newModel;
        }
    }
    return model;
}

// ==========================================================
// 🆕 HELPER: Mapping Gemini Legacy → Model Stabil Terkini
// ==========================================================
// Berdasarkan daftar model aktual dari API Google (Agustus 2026):
// - gemini-2.5-flash: Stable (Juni 2025), 1M input, 65K output
// - gemini-3.5-flash: Stable terbaru (Mei 2026)
// - gemini-3.6-flash: Paling baru (Juli 2026)
// - gemini-2.5-flash-lite: Versi lebih murah/cepat
//
// Model 1.5 dan 2.0 TIDAK ADA lagi di daftar → semua kita arahkan ke 2.5 Flash
const GEMINI_MODEL_MAP: Record<string, string> = {
    // Legacy models (sudah deprecated)
    'gemini-pro': 'gemini-2.5-flash',
    'gemini-1.0-pro': 'gemini-2.5-flash',

    // Gemini 1.5 (sudah tidak tersedia)
    'gemini-1.5-pro': 'gemini-2.5-flash',
    'gemini-1.5-pro-latest': 'gemini-2.5-flash',
    'gemini-1.5-flash': 'gemini-2.5-flash',     // ← Frontend Anda kirim ini
    'gemini-1.5-flash-latest': 'gemini-2.5-flash',
    'gemini-1.5-flash-8b': 'gemini-2.5-flash',
    'gemini-1.5-flash-001': 'gemini-2.5-flash',
    'gemini-1.5-flash-002': 'gemini-2.5-flash',

    // Gemini 2.0 (sudah tidak tersedia)
    'gemini-2.0-flash': 'gemini-2.5-flash',
    'gemini-2.0-flash-exp': 'gemini-2.5-flash',
};

function resolveGeminiModel(model: string): string {
    if (GEMINI_MODEL_MAP[model]) {
        console.log(`[Gemini] 🔄 Remapped: "${model}" → "${GEMINI_MODEL_MAP[model]}"`);
        return GEMINI_MODEL_MAP[model];
    }
    return model;
}

// ==========================================================
// HELPER: Call Anthropic API dengan Auto-Fallback
// ==========================================================
async function callAnthropicWithFallback(
    originalModel: string,
    messages: any[],
    systemPrompt: string
): Promise<Response> {
    const CLAUDE_FALLBACKS = [
        originalModel,
        'claude-sonnet-5',
        'claude-opus-5',
        'claude-sonnet-4-6',
        'claude-opus-4-8',
        'claude-fable-5',
        'claude-sonnet-4-5-20250929',
    ];

    const uniqueFallbacks = [...new Set(CLAUDE_FALLBACKS)];

    let lastErrorText = '';
    let lastErrorStatus = 500;

    for (const candidateModel of uniqueFallbacks) {
        console.log(`[Anthropic] 🔄 Trying model: ${candidateModel}`);

        const anthropicBody: any = {
            model: candidateModel,
            messages: messages,
            max_tokens: 8192,
        };

        if (systemPrompt.trim()) {
            anthropicBody.system = systemPrompt.trim();
        }

        try {
            const response = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
                method: 'POST',
                headers: {
                    'x-api-key': ANTHROPIC_API_KEY!,
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json',
                },
                body: JSON.stringify(anthropicBody),
            });

            if (response.ok) {
                console.log(`[Anthropic] ✅ Success with: ${candidateModel}`);
                return response;
            }

            const errText = await response.text();
            lastErrorText = errText;
            lastErrorStatus = response.status;

            if (response.status !== 404) {
                console.error(`[Anthropic ❌ Non-retryable] ${response.status}: ${errText}`);
                return NextResponse.json({ error: errText }, { status: response.status });
            }

            console.warn(`[Anthropic ⚠️] "${candidateModel}" not found, trying next...`);
        } catch (err: any) {
            lastErrorText = err.message;
            lastErrorStatus = 500;
            console.error(`[Anthropic ❌ Network error] ${err.message}`);
        }
    }

    return NextResponse.json(
        { error: `All Claude model fallbacks failed. Last error: ${lastErrorText}` },
        { status: lastErrorStatus }
    );
}

// ==========================================================
// 🆕 HELPER: Call Gemini API dengan Auto-Fallback (UPDATED)
// ==========================================================
async function callGeminiAPI(
    model: string,
    messages: any[],
    stream: boolean
) {
    const resolvedModel = resolveGeminiModel(model);

    // 🆕 Fallback list berdasarkan model yang ACTUALLY TERSEDIA di API
    const GEMINI_FALLBACKS = [
        resolvedModel,
        'gemini-2.5-flash',       // Primary: Stable sejak Juni 2025
        'gemini-3.5-flash',       // Fallback 1: Stable terbaru (Mei 2026)
        'gemini-3.6-flash',       // Fallback 2: Paling baru (Juli 2026)
        'gemini-2.5-flash-lite',  // Fallback 3: Versi lebih murah/cepat
    ];

    const uniqueFallbacks = [...new Set(GEMINI_FALLBACKS)];

    // Parse messages ke format Gemini
    let systemPrompt = "";
    const geminiContents: { role: string; parts: { text: string }[] }[] = [];

    for (const msg of messages) {
        if (msg.role === 'system') {
            systemPrompt += (systemPrompt ? "\n\n" : "") + (msg.content || "");
        } else if (msg.role === 'user' || msg.role === 'assistant') {
            const geminiRole = msg.role === 'assistant' ? 'model' : 'user';
            const lastMsg = geminiContents[geminiContents.length - 1];
            if (lastMsg && lastMsg.role === geminiRole) {
                lastMsg.parts[0].text += "\n\n" + (msg.content || "");
            } else {
                geminiContents.push({
                    role: geminiRole,
                    parts: [{ text: msg.content || "" }]
                });
            }
        }
    }

    if (geminiContents.length === 0) {
        throw new Error('Gemini requires at least one user message');
    }
    if (geminiContents[0].role !== 'user') {
        geminiContents.unshift({
            role: 'user',
            parts: [{ text: "Please respond to the following conversation context:" }]
        });
    }

    let lastErrorText = '';
    let lastErrorStatus = 500;

    // Coba setiap model dengan fallback
    for (const candidateModel of uniqueFallbacks) {
        try {
            const geminiBody: any = {
                contents: geminiContents,
                generationConfig: {
                    temperature: 0.7,
                    maxOutputTokens: 8192,
                    topP: 0.95,
                    topK: 40,
                },
            };

            if (systemPrompt.trim()) {
                geminiBody.systemInstruction = {
                    parts: [{ text: systemPrompt.trim() }]
                };
            }

            const endpoint = `${GEMINI_BASE_URL}/models/${candidateModel}:generateContent?key=${GEMINI_API_KEY}`;
            console.log(`[Gemini] 📤 Trying: ${candidateModel}`);
            console.log(`[Gemini] 🌐 Endpoint: ${endpoint.replace(GEMINI_API_KEY!, '***API_KEY***')}`);

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(geminiBody),
            });

            if (response.ok) {
                const data = await response.json();
                console.log(`[Gemini ✅ Success] Model: ${candidateModel}`);
                console.log(`[Gemini ✅ Success] Finish reason: ${data.candidates?.[0]?.finishReason}`);

                const content = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

                return NextResponse.json({
                    id: `gemini-${Date.now()}`,
                    object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000),
                    model: candidateModel,
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content },
                        finish_reason: data.candidates?.[0]?.finishReason === 'STOP' ? 'stop' : 'length'
                    }],
                    usage: {
                        prompt_tokens: data.usageMetadata?.promptTokenCount || 0,
                        completion_tokens: data.usageMetadata?.candidatesTokenCount || 0,
                        total_tokens: data.usageMetadata?.totalTokenCount || 0
                    }
                });
            }

            const errText = await response.text();
            lastErrorText = errText;
            lastErrorStatus = response.status;

            console.error(`[Gemini ❌ Error] Model: ${candidateModel}, Status: ${response.status}`);
            console.error(`[Gemini ❌ Error] Body: ${errText.substring(0, 500)}`);

            // Jika 404 (model not found) atau butuh migrasi API, coba model berikutnya
            if (response.status === 404 ||
                errText.includes('Interactions API') ||
                errText.includes('not supported for generateContent')) {
                console.warn(`[Gemini ⚠️] "${candidateModel}" tidak valid, mencoba fallback berikutnya...`);
                continue;
            }

            // Error lain (401, 429, 500), langsung return
            return NextResponse.json(
                { error: `Gemini API Error (${response.status}): ${errText}` },
                { status: response.status }
            );

        } catch (err: any) {
            lastErrorText = err.message;
            lastErrorStatus = 500;
            console.error(`[Gemini ❌ Network error with ${candidateModel}]:`, err.message);
        }
    }

    // Semua fallback gagal
    throw new Error(`All Gemini model fallbacks failed. Last error: ${lastErrorText}`);
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { messages, model, stream = false } = body;

        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return new NextResponse('Missing or invalid messages array', { status: 400 });
        }

        if (!model) {
            return new NextResponse('Missing model parameter', { status: 400 });
        }

        console.log(`[Router] 📨 Received request for model: "${model}"`);

        const lowerModel = model.toLowerCase();
        const isAnthropic = lowerModel.includes('claude');
        const isGemini = lowerModel.includes('gemini');

        // ==========================================================
        // RUTE 1: ANTHROPIC NATIVE API (Claude)
        // ==========================================================
        if (isAnthropic && ANTHROPIC_API_KEY) {
            const resolvedModel = resolveClaudeModel(model);

            let systemPrompt = "";
            const anthropicMessages: { role: string; content: string }[] = [];

            for (const msg of messages) {
                if (msg.role === 'system') {
                    systemPrompt += (systemPrompt ? "\n\n" : "") + (msg.content || "");
                } else if (msg.role === 'user' || msg.role === 'assistant') {
                    const lastMsg = anthropicMessages[anthropicMessages.length - 1];
                    if (lastMsg && lastMsg.role === msg.role) {
                        lastMsg.content += "\n\n" + (msg.content || "");
                    } else {
                        anthropicMessages.push({
                            role: msg.role,
                            content: msg.content || ""
                        });
                    }
                }
            }

            if (anthropicMessages.length === 0) {
                return new NextResponse('Anthropic requires at least one user message', { status: 400 });
            }

            if (anthropicMessages[0].role !== 'user') {
                anthropicMessages.unshift({
                    role: 'user',
                    content: "Please respond to the following conversation context:"
                });
            }

            console.log(`[Anthropic] System prompt: ${systemPrompt.length} chars`);
            console.log(`[Anthropic] Messages count: ${anthropicMessages.length}`);

            const response = await callAnthropicWithFallback(
                resolvedModel,
                anthropicMessages,
                systemPrompt
            );

            if (!response.ok) {
                return response;
            }

            const data = await response.json();
            const content = data.content?.find((c: any) => c.type === 'text')?.text || "";

            return NextResponse.json({
                id: data.id || `chatcmpl-${Date.now()}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: data.model,
                choices: [{
                    index: 0,
                    message: { role: 'assistant', content },
                    finish_reason: data.stop_reason || 'stop'
                }],
                usage: {
                    prompt_tokens: data.usage?.input_tokens || 0,
                    completion_tokens: data.usage?.output_tokens || 0,
                    total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
                }
            });
        }

        // ==========================================================
        // RUTE 2: GEMINI NATIVE API
        // ==========================================================
        else if (isGemini && GEMINI_API_KEY) {
            try {
                return await callGeminiAPI(model, messages, stream);
            } catch (err: any) {
                console.error("[Gemini ❌ Error]", err.message);
                return NextResponse.json(
                    { error: err.message || 'Gemini API Error' },
                    { status: 500 }
                );
            }
        }

        // ==========================================================
        // RUTE 3: LITELLM (OpenAI / fallback)
        // ==========================================================
        else {
            console.log(`[Router] 📤 Sending to LiteLLM: ${model}`);

            const response = await fetch(`${BASE_URL}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${API_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ model, messages, stream }),
            });

            if (!response.ok) {
                const errText = await response.text();
                console.error(`[LiteLLM ❌ Error] ${errText}`);
                return new NextResponse(`LiteLLM API Error: ${errText}`, { status: response.status });
            }

            if (stream) {
                return new NextResponse(response.body, {
                    status: 200,
                    headers: {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive'
                    },
                });
            } else {
                const data = await response.json();
                return NextResponse.json(data);
            }
        }

    } catch (err: any) {
        console.error("[Router ❌ Error]", err);
        return new NextResponse(`Internal Error: ${err.message}`, { status: 500 });
    }
}