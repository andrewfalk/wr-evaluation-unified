import { describe, it, expect } from 'vitest';
import { calculateBMI, calculateAge, stableStringify, escapeHtml, isBroadcastSafe, isGrainCompatible } from '../common';

describe('calculateBMI', () => {
  it('computes BMI to one decimal place', () => {
    expect(calculateBMI(170, 65)).toBe('22.5');
  });

  it('returns 0 for missing or non-positive height', () => {
    expect(calculateBMI('', 65)).toBe(0);
    expect(calculateBMI(0, 65)).toBe(0);
    expect(calculateBMI(170, '')).toBe(0);
  });
});

describe('calculateAge — UI hybrid (strict fast path + lenient fallback)', () => {
  it('computes age for well-formed YYYY-MM-DD dates', () => {
    expect(calculateAge('1990-03-01', '2020-03-01')).toBe(30);
    expect(calculateAge('1990-03-02', '2020-03-01')).toBe(29);
  });

  it('returns 0 when either date is missing', () => {
    expect(calculateAge('', '2020-03-01')).toBe(0);
    expect(calculateAge('1990-03-01', '')).toBe(0);
  });

  it('falls back to lenient Date parsing for non-strict formats (legacy compat)', () => {
    // ISO datetime with an explicit time component isn't strict YYYY-MM-DD; original
    // behavior (new Date(string)) is preserved for this path.
    expect(calculateAge('1990-03-01T00:00:00Z', '2020-03-01T00:00:00Z')).toBe(30);
  });
});

describe('stableStringify', () => {
  it('produces identical output regardless of key insertion order', () => {
    const a = stableStringify({ b: 1, a: 2 });
    const b = stableStringify({ a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it('sorts keys of nested objects too', () => {
    expect(stableStringify({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  it('preserves array order (only object keys are sorted)', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
  });
});

describe('escapeHtml', () => {
  it('escapes the five XSS-relevant characters', () => {
    expect(escapeHtml(`<script>"'&</script>`)).toBe(
      '&lt;script&gt;&quot;&#039;&amp;&lt;/script&gt;',
    );
  });

  it('passes non-string values through unchanged', () => {
    expect(escapeHtml(42)).toBe(42);
    expect(escapeHtml(null)).toBe(null);
  });
});

// grain 단순화 + 공통변수 브로드캐스트(PR0-B4 개정, person grain 삭제 후속) — 클라이언트
// (CatalogPanel.jsx/RecipePanel.jsx)와 서버(statsRecipeValidation.ts)가 이 두 함수를
// 그대로 공유한다(복제 구현 금지 — 2차 리뷰 지적). 여기서 판정 규칙 자체를 고정한다.
describe('isBroadcastSafe', () => {
  it('quasi_identifier는 안전하지 않다', () => {
    expect(isBroadcastSafe({ grain: 'case', sensitivity: 'quasi_identifier', type: 'high_cardinality' })).toBe(false);
  });

  it('high_cardinality는 안전하지 않다(sensitivity가 non_sensitive여도)', () => {
    expect(isBroadcastSafe({ grain: 'case', sensitivity: 'non_sensitive', type: 'high_cardinality' })).toBe(false);
  });

  it('quasi_identifier도 high_cardinality도 아니면 안전하다', () => {
    expect(isBroadcastSafe({ grain: 'case', sensitivity: 'non_sensitive', type: 'categorical' })).toBe(true);
  });
});

describe('isGrainCompatible', () => {
  it('변수의 grain과 대상 grain이 같으면 항상 허용(브로드캐스트 판정과 무관)', () => {
    expect(isGrainCompatible({ grain: 'job', sensitivity: 'quasi_identifier', type: 'high_cardinality' }, 'job')).toBe(true);
  });

  it('브로드캐스트 안전 case 변수는 job/disease에서도 허용', () => {
    const gender = { grain: 'case', sensitivity: 'non_sensitive', type: 'categorical' };
    expect(isGrainCompatible(gender, 'job')).toBe(true);
    expect(isGrainCompatible(gender, 'disease')).toBe(true);
  });

  it('case의 브로드캐스트 제외 변수(quasi_identifier/high_cardinality)는 job/disease에서 거부', () => {
    const jobNameRollup = { grain: 'case', sensitivity: 'quasi_identifier', type: 'high_cardinality' };
    expect(isGrainCompatible(jobNameRollup, 'job')).toBe(false);
    expect(isGrainCompatible(jobNameRollup, 'disease')).toBe(false);
  });

  it('job↔disease는 서로 거부(둘 다 case가 아니므로 브로드캐스트 대상이 아님)', () => {
    const jobVar = { grain: 'job', sensitivity: 'non_sensitive', type: 'continuous' };
    const diseaseVar = { grain: 'disease', sensitivity: 'non_sensitive', type: 'ordinal' };
    expect(isGrainCompatible(jobVar, 'disease')).toBe(false);
    expect(isGrainCompatible(diseaseVar, 'job')).toBe(false);
  });

  it('job/disease 변수를 case에 쓰는 역방향(롤업)은 거부 — 이번 범위 밖', () => {
    const jobVar = { grain: 'job', sensitivity: 'non_sensitive', type: 'continuous' };
    expect(isGrainCompatible(jobVar, 'case')).toBe(false);
  });

  // 2차 리뷰 지적 — 목적지 grain 검사가 동일성 검사보다 먼저 와야 한다. 순서가 틀리면
  // 더 이상 유효하지 않은 값(옛 person grain)이나 임의의 조작된 문자열끼리 우연히
  // 같을 때 브로드캐스트 안전 여부와 무관하게 통과해버린다.
  it('더 이상 존재하지 않는 grain("person")이나 임의 문자열은 변수·목적지가 동일해도 거부한다', () => {
    const stalePersonVar = { grain: 'person', sensitivity: 'non_sensitive', type: 'categorical' };
    expect(isGrainCompatible(stalePersonVar, 'person')).toBe(false);
    const madeUpVar = { grain: 'made_up_grain', sensitivity: 'non_sensitive', type: 'categorical' };
    expect(isGrainCompatible(madeUpVar, 'made_up_grain')).toBe(false);
  });
});
