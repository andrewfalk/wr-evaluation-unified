// 프리셋 저장 창의 순수 함수(P2-88c에서 preset/presetSearch.ts로 꺼냄) — 비슷한 프리셋 점수·검색 글자·표시값의 지금 규칙.
import { describe, expect, it } from 'vitest';
import {
  formatPresetFieldValue,
  getKeywordMatchScore,
  getPresetDraft,
  normalizeSearchText,
  tokenize,
} from '../presetSearch';
import type { PresetRecord } from '../presetSearch';

describe('getPresetDraft', () => {
  it('직종명·카테고리·설명을 꺼내고, 비면 빈 글자와 기본 카테고리(미분류)', () => {
    expect(getPresetDraft({ jobName: '조립원', category: '제조업', description: '라인' } as PresetRecord)).toEqual({ jobName: '조립원', category: '제조업', description: '라인' });
    expect(getPresetDraft(null)).toEqual({ jobName: '', category: '미분류', description: '' });
    expect(getPresetDraft({ jobName: '조립원', category: '' } as PresetRecord)).toEqual({ jobName: '조립원', category: '미분류', description: '' });
  });

  it('직접 만든 프리셋의 _customCategory·_customDescription을 먼저 본다', () => {
    expect(getPresetDraft({ jobName: 'a', category: '제조업', _customCategory: '나만의 분류', _customDescription: '야간' } as PresetRecord))
      .toEqual({ jobName: 'a', category: '나만의 분류', description: '야간' });
  });
});

describe('normalizeSearchText · tokenize', () => {
  it('앞뒤 공백을 자르고 소문자로', () => {
    expect(normalizeSearchText('  Welder 용접 ')).toBe('welder 용접');
    expect(normalizeSearchText(null)).toBe('');
    expect(normalizeSearchText(undefined)).toBe('');
  });

  it('공백으로 나눈 두 글자 이상 낱말만', () => {
    expect(tokenize(' 라인  작업 a Bc ')).toEqual(['라인', '작업', 'bc']);
    expect(tokenize('')).toEqual([]);
  });
});

describe('formatPresetFieldValue', () => {
  it('배열은 쉼표로, 객체는 JSON으로(직렬화할 수 없으면 [객체])', () => {
    expect(formatPresetFieldValue(['a', 'b'], 'string')).toBe('a, b');
    expect(formatPresetFieldValue({ x: 1 }, 'string')).toBe('{"x":1}');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatPresetFieldValue(circular, 'string')).toBe('[객체]');
  });

  it('불리언 필드는 Y/N, 그 밖의 값은 그대로', () => {
    expect(formatPresetFieldValue(true, 'boolean')).toBe('Y');
    expect(formatPresetFieldValue(false, 'boolean')).toBe('N');
    expect(formatPresetFieldValue(0, 'boolean')).toBe('N');
    expect(formatPresetFieldValue('120', 'number')).toBe('120');
    expect(formatPresetFieldValue(0, 'number')).toBe(0);
    expect(formatPresetFieldValue(false, 'string')).toBe(false);
  });
});

describe('getKeywordMatchScore', () => {
  const draft = { jobName: '조립원', category: '제조업', description: '라인 작업' };

  it('직종명 같음 6 · 카테고리 같음 4 · 설명 같음 3 + 겹치는 낱말마다 1', () => {
    // 낱말: 조립원·제조업·라인·작업 — 모두 프리셋 글자에 있다(+4)
    expect(getKeywordMatchScore({ jobName: '조립원', category: '제조업', description: '라인 작업' } as PresetRecord, draft)).toBe(6 + 4 + 3 + 4);
  });

  it('포함 관계는 직종명 4 · 카테고리 2 · 설명 2', () => {
    // 직종명 '조립원 반장' ⊃ '조립원'(4), 카테고리 '제조업체' ⊃ '제조업'(2), 설명 '라인 작업 보조' ⊃ '라인 작업'(2), 낱말 4
    expect(getKeywordMatchScore({ jobName: '조립원 반장', category: '제조업체', description: '라인 작업 보조' } as PresetRecord, draft)).toBe(4 + 2 + 2 + 4);
  });

  it('입력이 비면 그 항목은 세지 않고, 겹치는 것이 없으면 0', () => {
    expect(getKeywordMatchScore({ jobName: '사무원', category: '기타' } as PresetRecord, { jobName: '', category: '', description: '' })).toBe(0);
    expect(getKeywordMatchScore({ jobName: '사무원', category: '기타', description: '야간' } as PresetRecord, draft)).toBe(0);
  });

  it('빈 프리셋 글자는 어떤 입력에도 포함된다고 본다(지금 동작)', () => {
    // presetDescription '' — draftDescription.includes('')가 참이라 설명 포함 2점
    expect(getKeywordMatchScore({ jobName: '용접원', category: '건설업' } as PresetRecord, { jobName: '', category: '', description: '라인' })).toBe(2);
  });
});
