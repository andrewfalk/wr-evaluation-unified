import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  ALLOWED_MODELS,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_CLAUDE_MODEL,
  CLAUDE_MAX_TOKENS,
  GEMINI_MAX_OUTPUT_TOKENS,
  MODEL_OPTIONS,
  isAllowedModel,
} from '../aiModels';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('isAllowedModel', () => {
  it('allowlist에 있는 모델만 통과시킨다', () => {
    for (const model of ALLOWED_MODELS) expect(isAllowedModel(model)).toBe(true);
  });

  it.each(['', 'gpt-4o', 'gemini-2.5-flash ', 'GEMINI-2.5-FLASH', 'gemini-2.5-flash/../x', 'gemini-1.5-pro', undefined, null, 5, {}, ['gemini-2.5-flash']])(
    '그 밖의 값은 거부 — %j',
    (model) => {
      expect(isAllowedModel(model)).toBe(false);
    },
  );

  it('기본 모델은 allowlist 안에 있다', () => {
    expect(isAllowedModel(DEFAULT_GEMINI_MODEL)).toBe(true);
    expect(isAllowedModel(DEFAULT_CLAUDE_MODEL)).toBe(true);
  });
});

describe('MODEL_OPTIONS', () => {
  const values = MODEL_OPTIONS.flatMap((group) => group.options.map((option) => option.value));

  it('선택지는 모두 allowlist 안에 있고 allowlist 전체를 덮는다', () => {
    expect([...values].sort()).toEqual([...ALLOWED_MODELS].sort());
  });
});

// 이관 기간의 드리프트 방지 — 소비처(api/analyze.js·electron/main.js·AIAnalysisPanel)를 이 계약으로 옮기는 PR(hf7-2/3)에서
// 이 블록을 지운다(루트 ai-models.config.cjs 삭제 시점).
describe('기존 소비처와의 일치(이관 전까지)', () => {
  const legacy = createRequire(import.meta.url)(path.join(ROOT, 'ai-models.config.cjs')) as {
    ALLOWED_MODELS: string[];
    DEFAULT_CLAUDE_MODEL: string;
    DEFAULT_GEMINI_MODEL: string;
    CLAUDE_MAX_TOKENS: number;
    GEMINI_MAX_OUTPUT_TOKENS: { pro: number; flash: number };
  };

  it('ai-models.config.cjs와 같은 값이다', () => {
    expect([...ALLOWED_MODELS]).toEqual(legacy.ALLOWED_MODELS);
    expect(DEFAULT_GEMINI_MODEL).toBe(legacy.DEFAULT_GEMINI_MODEL);
    expect(DEFAULT_CLAUDE_MODEL).toBe(legacy.DEFAULT_CLAUDE_MODEL);
    expect(CLAUDE_MAX_TOKENS).toBe(legacy.CLAUDE_MAX_TOKENS);
    expect({ ...GEMINI_MAX_OUTPUT_TOKENS }).toEqual(legacy.GEMINI_MAX_OUTPUT_TOKENS);
  });

  it('AIAnalysisPanel의 하드코딩 선택지와 같은 모델·라벨이다', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/core/components/AIAnalysisPanel.jsx'), 'utf8');
    const panel = [...source.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map((m) => ({ value: m[1], label: m[2] }));
    const contract = MODEL_OPTIONS.flatMap((group) => group.options.map((o) => ({ value: o.value as string, label: o.label })));
    expect(panel).toEqual(contract);
  });
});
