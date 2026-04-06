// 통합 평가 시스템 - AI 분석 API Route
// Claude / Gemini API 프록시 (API 키를 서버에서 안전하게 관리)

export default async function handler(req, res) {
    const allowedOrigins = ['http://localhost:3000', 'http://127.0.0.1:3000'];
    if (process.env.APP_ORIGIN) allowedOrigins.push(process.env.APP_ORIGIN);

    const origin = req.headers.origin || '';
    const isAllowed = allowedOrigins.includes(origin)
        || /^https:\/\/[\w-]+\.vercel\.app$/.test(origin);
    const corsOrigin = isAllowed ? origin : allowedOrigins[0];

    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-WR-User-Id, X-WR-Org-Id, X-WR-Auth-Mode');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({
            error: { message: 'Method not allowed. Use POST.' }
        });
    }

    try {
        const { prompt, systemPrompt, model } = req.body;

        if (!prompt || typeof prompt !== 'string') {
            return res.status(400).json({
                error: { message: '분석할 데이터가 없습니다.' }
            });
        }

        if (prompt.length > 50000) {
            return res.status(400).json({
                error: { message: '요청 데이터가 너무 큽니다.' }
            });
        }

        const defaultSystemPrompt = '당신은 직업성 질환 평가 전문 직업환경의학 전문의입니다. 분석 결과를 한국어로 작성하세요.';
        const sysPrompt = systemPrompt || defaultSystemPrompt;

        const isGemini = (model || '').startsWith('gemini');

        if (isGemini) {
            return await handleGemini(req, res, { prompt, sysPrompt, model });
        } else {
            return await handleClaude(req, res, { prompt, sysPrompt, model });
        }

    } catch (error) {
        console.error('Server error:', error);
        return res.status(500).json({
            error: { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' }
        });
    }
}

async function handleClaude(req, res, { prompt, sysPrompt, model }) {
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) {
        return res.status(500).json({
            error: { message: 'Claude API 키가 설정되지 않았습니다. 관리자에게 문의하세요.' }
        });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
            model: model || 'claude-haiku-4-5-20251001',
            max_tokens: 2000,
            system: sysPrompt,
            messages: [{ role: 'user', content: prompt }]
        })
    });

    const data = await response.json();

    if (!response.ok) {
        console.error('Claude API error:', data);
        let userMessage = 'AI 분석 중 오류가 발생했습니다.';
        if (response.status === 401) userMessage = 'Claude API 인증 오류입니다.';
        else if (response.status === 429) userMessage = '요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요.';
        return res.status(response.status).json({
            error: { message: userMessage, detail: data.error?.message }
        });
    }

    return res.status(200).json(data);
}

async function handleGemini(req, res, { prompt, sysPrompt, model }) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return res.status(500).json({
            error: { message: 'Gemini API 키가 설정되지 않았습니다. 관리자에게 문의하세요.' }
        });
    }

    const geminiModel = model || 'gemini-2.5-flash';
    const isPro = geminiModel.includes('pro');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`;

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
            system_instruction: { parts: [{ text: sysPrompt }] },
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: isPro ? 65536 : 8192 }
        })
    });

    const data = await response.json();

    if (!response.ok) {
        console.error('Gemini API error:', data);
        const detail = data.error?.message || JSON.stringify(data.error || data);
        let userMessage = `AI 분석 중 오류가 발생했습니다. (${detail})`;
        if (response.status === 400) userMessage = `Gemini 요청 형식 오류: ${detail}`;
        else if (response.status === 403) userMessage = `Gemini API 인증 오류: ${detail}`;
        else if (response.status === 429) userMessage = '요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요.';
        return res.status(response.status).json({
            error: { message: userMessage, detail }
        });
    }

    return res.status(200).json(data);
}
