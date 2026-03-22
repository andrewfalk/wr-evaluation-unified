// 통합 평가 시스템 - AI 분석 API Route
// Claude API 프록시 (API 키를 서버에서 안전하게 관리)

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({
            error: { message: 'Method not allowed. Use POST.' }
        });
    }

    const apiKey = process.env.CLAUDE_API_KEY;

    if (!apiKey) {
        console.error('CLAUDE_API_KEY environment variable is not set');
        return res.status(500).json({
            error: { message: 'AI 분석 서비스가 설정되지 않았습니다. 관리자에게 문의하세요.' }
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

        const defaultSystemPrompt = '당신은 직업성 질환 평가 전문 산업의학 전문의입니다. 분석 결과를 한국어로 작성하세요.';

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-beta': 'prompt-caching-2024-07-31'
            },
            body: JSON.stringify({
                model: model || 'claude-haiku-4-5-20251001',
                max_tokens: 2000,
                system: [
                    {
                        type: 'text',
                        text: systemPrompt || defaultSystemPrompt,
                        cache_control: { type: 'ephemeral' }
                    }
                ],
                messages: [
                    {
                        role: 'user',
                        content: prompt
                    }
                ]
            })
        });

        const data = await response.json();

        if (!response.ok) {
            console.error('Claude API error:', data);

            let userMessage = 'AI 분석 중 오류가 발생했습니다.';
            if (response.status === 401) userMessage = 'API 인증 오류입니다. 관리자에게 문의하세요.';
            else if (response.status === 429) userMessage = '요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요.';
            else if (response.status === 500) userMessage = 'AI 서비스가 일시적으로 불안정합니다.';

            return res.status(response.status).json({
                error: { message: userMessage, detail: data.error?.message }
            });
        }

        return res.status(200).json(data);

    } catch (error) {
        console.error('Server error:', error);
        return res.status(500).json({
            error: { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' }
        });
    }
}
