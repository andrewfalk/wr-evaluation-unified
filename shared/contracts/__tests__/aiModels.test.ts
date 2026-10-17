import fs from 'node:fs';
import path from 'node:path';
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

describe('모델 값', () => {
  it('허용 목록·기본값·토큰 한도가 운영 값 그대로다', () => {
    expect([...ALLOWED_MODELS]).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-6-20250514']);
    expect(DEFAULT_GEMINI_MODEL).toBe('gemini-2.5-flash');
    expect(DEFAULT_CLAUDE_MODEL).toBe('claude-haiku-4-5-20251001');
    expect(CLAUDE_MAX_TOKENS).toBe(2000);
    expect({ ...GEMINI_MAX_OUTPUT_TOKENS }).toEqual({ pro: 65536, flash: 8192 });
  });
});

// 모델 정보의 단일 출처는 이 계약이다. 소비처(화면·Vercel 함수·Electron 독립형)가 모델명을 따로 들고 있지 않아야 하고,
// 옛 공유 파일(ai-models.config.cjs)이 되살아나지 않아야 한다.
describe('소비처는 이 계약을 쓴다', () => {
  const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
  const HARDCODED = /gemini-2.5|claude-(haiku|sonnet)/;

  it('옛 ai-models.config.cjs는 없다', () => {
    expect(fs.existsSync(path.join(ROOT, 'ai-models.config.cjs'))).toBe(false);
  });

  it('AIAnalysisPanel은 모델 선택지를 계약에서 가져오고 모델명을 하드코딩하지 않는다', () => {
    const source = read('src/core/components/AIAnalysisPanel.jsx');
    expect(source).toContain("from '@contracts/aiModels'");
    expect(source).toContain('MODEL_OPTIONS');
    expect(source).not.toMatch(HARDCODED);
  });

  it('Vercel 함수는 shared/dist의 CJS 계약(.cjs)을 불러오고 모델명을 하드코딩하지 않는다', () => {
    const source = read('api/analyze.js');
    expect(source).toContain("from '../shared/dist/aiModels.cjs'");
    expect(source).toContain("from '../shared/dist/aiPrompt.cjs'");
    // ESM 빌드(.js)를 가져오면 Vercel의 CJS 변환 뒤 require(esm)이 되어 Node 20.18·22.11 등에서 함수 로드가 실패한다.
    expect(source).not.toMatch(/from '\.\.\/shared\/dist\/[A-Za-z]+\.js'/);
    expect(source).not.toMatch(HARDCODED);
  });

  it('Electron 독립형은 shared/dist의 CJS 계약을 불러오고 모델명을 하드코딩하지 않는다', () => {
    const source = read('electron/aiRequest.js');
    expect(source).toContain("require('../shared/dist/aiModels.cjs')");
    expect(source).toContain("require('../shared/dist/aiPrompt.cjs')");
    expect(source).not.toMatch(HARDCODED);
  });

  it('Electron 패키징에 계약 파일이 포함되고 옛 파일은 없다', () => {
    const builder = read('electron-builder.base.yml');
    // electron/aiRequest.js가 require하는 CJS 계약 3개만 넣는다(.d.ts·ESM 번들은 설치본에 필요 없다).
    for (const file of ['aiModels', 'aiAnalysis', 'aiPrompt']) expect(builder).toContain(`shared/dist/${file}.cjs`);
    expect(builder).not.toContain('ai-models.config.cjs');
  });
});
