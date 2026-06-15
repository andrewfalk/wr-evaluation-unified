// AI 모델 기본값·토큰 제한·allowlist — api/analyze.js(Vercel) + electron/main.js 공유
// CJS로 작성: ESM(api/analyze.js)에서는 default import, CJS(electron/main.js)에서는 require로 사용 가능
module.exports = {
  ALLOWED_MODELS: [
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-6-20250514',
  ],
  DEFAULT_CLAUDE_MODEL: 'claude-haiku-4-5-20251001',
  DEFAULT_GEMINI_MODEL: 'gemini-2.5-flash',
  CLAUDE_MAX_TOKENS: 2000,
  GEMINI_MAX_OUTPUT_TOKENS: { pro: 65536, flash: 8192 },
};
