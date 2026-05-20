import { describe, it, expect } from 'vitest';
import { normalizeSpineAssessmentFields, preserveDeletedSpineCommonFields } from '../spineAssessmentMigration.js';

const isSpine = d => d?.module === 'spine';

const spine = (extras = {}) => ({ name: 'spine-dx', module: 'spine', ...extras });
const knee = (extras = {}) => ({ name: 'knee-dx', module: 'knee', ...extras });

describe('normalizeSpineAssessmentFields', () => {
  it('1) 빈/null/undefined → 입력 그대로', () => {
    expect(normalizeSpineAssessmentFields([], isSpine)).toEqual([]);
    expect(normalizeSpineAssessmentFields(null, isSpine)).toBe(null);
    expect(normalizeSpineAssessmentFields(undefined, isSpine)).toBe(undefined);
  });

  it('2) 척추 진단 0개 (다른 모듈만) → 동일 참조 반환', () => {
    const input = [knee(), knee()];
    expect(normalizeSpineAssessmentFields(input, isSpine)).toBe(input);
  });

  it('3) 척추 진단 1개 → 동일 참조 반환', () => {
    const input = [spine({ verticalDistribution: 'confirmed' }), knee()];
    expect(normalizeSpineAssessmentFields(input, isSpine)).toBe(input);
  });

  it('4) 척추 진단 2개+, 모두 빈 값 → 동일 참조 반환', () => {
    const input = [spine(), spine(), knee()];
    expect(normalizeSpineAssessmentFields(input, isSpine)).toBe(input);
  });

  it('5) 척추 진단 2개+, 첫 번째에만 값 → 동일 참조 반환 (변경 없음)', () => {
    const input = [
      spine({ verticalDistribution: 'confirmed', concomitantSpondylosis: 'unconfirmed' }),
      spine(),
    ];
    expect(normalizeSpineAssessmentFields(input, isSpine)).toBe(input);
  });

  it('6) 척추 진단 2개+, 두 번째에만 값 → 첫 번째로 이동, 두 번째 두 필드 제거', () => {
    const input = [
      spine(),
      spine({ verticalDistribution: 'confirmed', concomitantSpondylosis: 'unconfirmed' }),
    ];
    const out = normalizeSpineAssessmentFields(input, isSpine);
    expect(out).not.toBe(input);
    expect(out[0].verticalDistribution).toBe('confirmed');
    expect(out[0].concomitantSpondylosis).toBe('unconfirmed');
    expect('verticalDistribution' in out[1]).toBe(false);
    expect('concomitantSpondylosis' in out[1]).toBe(false);
  });

  it('7) 양쪽 모두 값 → 첫 번째 값 보존, 두 번째 제거', () => {
    const input = [
      spine({ verticalDistribution: 'confirmed', concomitantSpondylosis: 'confirmed' }),
      spine({ verticalDistribution: 'unconfirmed', concomitantSpondylosis: 'unconfirmed' }),
    ];
    const out = normalizeSpineAssessmentFields(input, isSpine);
    expect(out[0].verticalDistribution).toBe('confirmed');
    expect(out[0].concomitantSpondylosis).toBe('confirmed');
    expect('verticalDistribution' in out[1]).toBe(false);
    expect('concomitantSpondylosis' in out[1]).toBe(false);
  });

  it('8) 척추 진단 3개+, 두 번째 VD만, 세 번째 CS만 → 첫 번째에 둘 다 모임', () => {
    const input = [
      spine(),
      spine({ verticalDistribution: 'confirmed' }),
      spine({ concomitantSpondylosis: 'unconfirmed' }),
    ];
    const out = normalizeSpineAssessmentFields(input, isSpine);
    expect(out[0].verticalDistribution).toBe('confirmed');
    expect(out[0].concomitantSpondylosis).toBe('unconfirmed');
    expect('verticalDistribution' in out[1]).toBe(false);
    expect('concomitantSpondylosis' in out[1]).toBe(false);
    expect('verticalDistribution' in out[2]).toBe(false);
    expect('concomitantSpondylosis' in out[2]).toBe(false);
  });

  it('9) 빈 필드 안 만듦: 두 번째에 CS만, VD 어디에도 없음 → 첫 번째에 CS만, VD 키 없음', () => {
    const input = [spine(), spine({ concomitantSpondylosis: 'confirmed' })];
    const out = normalizeSpineAssessmentFields(input, isSpine);
    expect(out[0].concomitantSpondylosis).toBe('confirmed');
    expect('verticalDistribution' in out[0]).toBe(false);
  });
});

describe('preserveDeletedSpineCommonFields', () => {
  const sp = (id, extras = {}) => ({ id, name: 'spine', module: 'spine', ...extras });
  const kn = (id) => ({ id, name: 'knee', module: 'knee' });

  it('변경 없음 → next 그대로 반환', () => {
    const prev = [sp('s1', { verticalDistribution: 'confirmed' })];
    const next = [sp('s1', { verticalDistribution: 'confirmed' })];
    expect(preserveDeletedSpineCommonFields(prev, next, isSpine)).toBe(next);
  });

  it('첫 spine 삭제 + 다른 spine 살아남음 → 값 이송', () => {
    const prev = [
      sp('s1', { verticalDistribution: 'confirmed', concomitantSpondylosis: 'unconfirmed' }),
      sp('s2'),
    ];
    const next = [sp('s2')];
    const out = preserveDeletedSpineCommonFields(prev, next, isSpine);
    expect(out[0].verticalDistribution).toBe('confirmed');
    expect(out[0].concomitantSpondylosis).toBe('unconfirmed');
  });

  it('첫 spine 삭제 + 살아남은 spine에 같은 필드 값 있으면 override 안 함', () => {
    const prev = [
      sp('s1', { verticalDistribution: 'confirmed' }),
      sp('s2', { verticalDistribution: 'unconfirmed' }),
    ];
    const next = [sp('s2', { verticalDistribution: 'unconfirmed' })];
    const out = preserveDeletedSpineCommonFields(prev, next, isSpine);
    expect(out[0].verticalDistribution).toBe('unconfirmed'); // 보존
  });

  it('spine 모두 삭제 → next 그대로 (이송할 대상 없음)', () => {
    const prev = [sp('s1', { verticalDistribution: 'confirmed' })];
    const next = [kn('k1')];
    expect(preserveDeletedSpineCommonFields(prev, next, isSpine)).toBe(next);
  });

  it('non-spine 삭제는 영향 없음', () => {
    const prev = [sp('s1', { verticalDistribution: 'confirmed' }), kn('k1')];
    const next = [sp('s1', { verticalDistribution: 'confirmed' })];
    expect(preserveDeletedSpineCommonFields(prev, next, isSpine)).toBe(next);
  });

  it('prev/next null-safe', () => {
    expect(preserveDeletedSpineCommonFields(null, [sp('s1')], isSpine)).toEqual([sp('s1')]);
    expect(preserveDeletedSpineCommonFields([sp('s1')], null, isSpine)).toBe(null);
  });
});
