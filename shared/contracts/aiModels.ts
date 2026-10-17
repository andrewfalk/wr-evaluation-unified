// AI 모델 allowlist·기본값·토큰 제한 — 서버(ai.ts)·Vercel(api/analyze.js)·Electron 독립형·화면 선택지의 단일 출처.
// 루트 ai-models.config.cjs(CJS)와 같은 값이다. 소비처를 이 파일로 옮기는 PR(hf7-3)에서 그 파일을 지운다 —
// 그 전까지는 aiModels.test.ts가 두 값이 어긋나지 않게 묶어 둔다.

export const ALLOWED_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6-20250514',
] as const;

export type AiModel = (typeof ALLOWED_MODELS)[number];

export const DEFAULT_GEMINI_MODEL: AiModel = 'gemini-2.5-flash';
export const DEFAULT_CLAUDE_MODEL: AiModel = 'claude-haiku-4-5-20251001';
export const CLAUDE_MAX_TOKENS = 2000;
export const GEMINI_MAX_OUTPUT_TOKENS = { pro: 65536, flash: 8192 } as const;

export function isAllowedModel(model: unknown): model is AiModel {
  return typeof model === 'string' && (ALLOWED_MODELS as readonly string[]).includes(model);
}

/** 웹 화면(AIAnalysisPanel)의 모델 선택지. 값은 모두 ALLOWED_MODELS 안에 있다. */
export const MODEL_OPTIONS: ReadonlyArray<{
  group: string;
  options: ReadonlyArray<{ value: AiModel; label: string }>;
}> = [
  {
    group: 'Google Gemini',
    options: [
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (빠름/저비용)' },
      { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (정밀)' },
    ],
  },
  {
    group: 'Anthropic Claude',
    options: [
      { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (빠름/저비용)' },
      { value: 'claude-sonnet-4-6-20250514', label: 'Sonnet 4.6 (정밀)' },
    ],
  },
];
