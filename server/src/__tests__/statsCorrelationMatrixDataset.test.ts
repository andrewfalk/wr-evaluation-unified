// PR3-B — 코드리뷰 수정 1차(2026-09-11): buildCorrelationMatrixPairedDatasets()가
// pair마다 buildPairedDataset() 전체(원시 PairedRow[] 포함)를 만들어 Map에 쌓던
// 걸 카운트 3개짜리 경량 요약(summarizeCorrelationMatrixPair)으로 교체했다 —
// k=20/rows=17,500이면 원래 방식은 332만 5천 개의 행 객체를 유지했다(실측).
//
// 코드리뷰 수정 2차(2026-09-11) — 1차 수정의 isCorrelationMatrixTotalValuesWithinLimit()는
// "총 개수(k×rows)"만 확인해, 3변수×60,000행처럼 총합은 상한 이내지만 행 수
// 자체가 변수당 상한(MAX_VALUES_PER_VARIABLE)을 넘거나 직렬화 바이트가 상한을
// 넘는 입력을 놓쳤다(리뷰 반례). evaluateCorrelationMatrixInputLimits()로
// 교체해 세 상한(변수당/총합/바이트)을 전부 C(k,2) 순회 전에 확인한다.
//
// 코드리뷰 수정 3차(2026-09-11) — 2차 수정의 바이트 검사는 `{variables}`만
// 직렬화했는데, 실제 Python payload는 `{protocolVersion:3, correlationMatrix:
// {method, variables}}`라 73~74바이트(method 문자열 길이에 따라 다름) 더 크다.
// "래퍼는 몇 바이트뿐이라 무시 가능"이라는 판단이 평균적으론 맞아도 상한 검사처럼
// 정확히 경계에서 동작해야 하는 로직엔 틀렸다 — 실측으로 2,097,152B(선검사
// 통과)와 2,097,225B(실제 요청, 상한 초과)가 정확히 갈리는 경계값을 리뷰가
// 재현했다. 이제 실제 envelope과 바이트 단위로 동일하게 측정한다.
import { describe, it, expect } from 'vitest';
import {
  allCorrelationMatrixPairs,
  buildCorrelationMatrixPairedDatasets,
  evaluateCorrelationMatrixInputLimits,
  pairMapKey,
} from '../statsCorrelationMatrixDataset';
import { buildPairedDataset } from '../statsBivariateDataset';
import { MAX_TOTAL_VALUES, MAX_VALUES_PER_VARIABLE } from '../statsEngineLimits';
import type { DatasetRow } from '../statsDatasetBuilder';
import type { ExtractedValue } from '@wr/analytics-core';

function presentValue<T>(value: T): ExtractedValue<T> {
  return { value, missing: null, qualityFlags: [] };
}
function missingValue(): ExtractedValue<null> {
  return { value: null, missing: 'not_entered', qualityFlags: [] };
}
function makeRow(caseId: string, personClusterKey: string, values: DatasetRow['values']): DatasetRow {
  return { caseId, personClusterKey, values };
}

// k개 변수 전부에 같은 rowCount만큼 실수(소수점 9자리, §8 실측이 쓴 것과 동일한
// "값 개수 상한보다 바이트 상한이 먼저 걸리는" 최악 경로 자릿수)를 채운다.
function makeManyVariableRows(rowCount: number, keys: string[]): DatasetRow[] {
  return Array.from({ length: rowCount }, (_, i) => ({
    caseId: `c${i}`,
    personClusterKey: `p${i}`,
    values: Object.fromEntries(keys.map((k) => [k, presentValue(i + 0.123456789)])),
  }));
}

describe('allCorrelationMatrixPairs', () => {
  it('i<j 순서로 모든 조합을 만든다(대각선·역순 없음)', () => {
    const pairs = allCorrelationMatrixPairs(['a', 'b', 'c']);
    expect(pairs).toEqual([
      { xKey: 'a', yKey: 'b' },
      { xKey: 'a', yKey: 'c' },
      { xKey: 'b', yKey: 'c' },
    ]);
  });
});

describe('buildCorrelationMatrixPairedDatasets — 경량 요약', () => {
  it('각 pair의 카운트가 buildPairedDataset()의 동일 필드와 정확히 일치한다(회귀 — 경량화가 값을 바꾸지 않았는지)', () => {
    const rows: DatasetRow[] = [
      makeRow('c1', 'p1', { a: presentValue(1), b: presentValue(2), c: presentValue(3) }),
      makeRow('c2', 'p2', { a: missingValue(), b: presentValue(5), c: presentValue(6) }),
      makeRow('c3', 'p3', { a: presentValue(7), b: missingValue(), c: presentValue(9) }),
      makeRow('c4', 'p3', { a: missingValue(), b: missingValue(), c: presentValue(12) }), // p3 재사용(반복측정)
    ];
    const keys = ['a', 'b', 'c'];
    const summaries = buildCorrelationMatrixPairedDatasets(rows, keys);

    for (const { xKey, yKey } of allCorrelationMatrixPairs(keys)) {
      const expected = buildPairedDataset(rows, xKey, yKey);
      const actual = summaries.get(pairMapKey(xKey, yKey))!;
      expect(actual.includedCaseCount).toBe(expected.includedCaseCount);
      expect(actual.includedPersonCount).toBe(expected.includedPersonCount);
      expect(actual.excludedPersonCount).toBe(expected.excludedPersonCount);
    }
  });

  it('반환값에 원시 행 배열(pairs)이 없다(경량 요약 전용 shape — 회귀 방지)', () => {
    const rows: DatasetRow[] = [makeRow('c1', 'p1', { a: presentValue(1), b: presentValue(2) })];
    const summaries = buildCorrelationMatrixPairedDatasets(rows, ['a', 'b']);
    const summary = summaries.get('a::b')!;
    expect(summary).not.toHaveProperty('pairs');
    expect(summary).not.toHaveProperty('exclusions');
    expect(Object.keys(summary).sort()).toEqual(['excludedPersonCount', 'includedCaseCount', 'includedPersonCount']);
  });
});

describe('evaluateCorrelationMatrixInputLimits — §8 세 상한을 순회 전에 확인', () => {
  it('세 상한 모두 이내면 ok:true + variables를 반환한다(재사용 대상)', () => {
    const keys = ['a', 'b', 'c'];
    const rows = makeManyVariableRows(100, keys);
    const result = evaluateCorrelationMatrixInputLimits(rows, keys, 'pearson_correlation');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.variables.map((v) => v.key)).toEqual(keys);
      expect(result.variables[0].values).toHaveLength(100);
    }
  });

  // 리뷰 반례 — 총 개수(3×60,000=180,000)는 MAX_TOTAL_VALUES(350,000) 이내지만
  // 행 수 자체(60,000)가 변수당 상한(50,000)을 넘는다. 1차 수정(총개수만 검사)은
  // 이 반례를 놓쳤다.
  it('총 개수는 상한 이내여도 행 수(=변수당 개수)가 MAX_VALUES_PER_VARIABLE을 넘으면 VALUES_PER_VARIABLE_EXCEEDED', () => {
    const keys = ['a', 'b', 'c'];
    const rowCount = MAX_VALUES_PER_VARIABLE + 1;
    expect(keys.length * rowCount).toBeLessThan(MAX_TOTAL_VALUES);
    const rows = makeManyVariableRows(rowCount, keys);
    const result = evaluateCorrelationMatrixInputLimits(rows, keys, 'pearson_correlation');
    expect(result).toEqual({ ok: false, violation: 'VALUES_PER_VARIABLE_EXCEEDED' });
  });

  it('변수당 개수는 상한 이내여도 총 개수(k×rows)가 MAX_TOTAL_VALUES를 넘으면 TOTAL_VALUES_EXCEEDED', () => {
    const rowCount = MAX_VALUES_PER_VARIABLE; // 변수당 상한과 정확히 같음(초과 아님)
    const keys = Array.from({ length: 8 }, (_, i) => `v${i}`); // 8 × 50,000 = 400,000 > 350,000
    const rows = makeManyVariableRows(rowCount, keys);
    const result = evaluateCorrelationMatrixInputLimits(rows, keys, 'pearson_correlation');
    expect(result).toEqual({ ok: false, violation: 'TOTAL_VALUES_EXCEEDED' });
  });

  // 리뷰 반례 — 값개수 상한(변수당·총합) 둘 다 이내여도 소수점 정밀도가 높은
  // 실수 데이터는 직렬화 바이트가 먼저 상한을 넘을 수 있다(§8의 핵심 발견).
  it('값 개수 상한(변수당·총합) 둘 다 이내여도 직렬화 바이트가 maxInputBytes를 넘으면 SERIALIZED_BYTES_EXCEEDED', () => {
    const keys = Array.from({ length: 20 }, (_, i) => `v${i}`);
    const rowCount = 7100; // 실측: k=20일 때 이 rows부터 {variables} 직렬화가 2MiB를 넘음
    expect(keys.length * rowCount).toBeLessThan(MAX_TOTAL_VALUES);
    expect(rowCount).toBeLessThan(MAX_VALUES_PER_VARIABLE);
    const rows = makeManyVariableRows(rowCount, keys);
    const result = evaluateCorrelationMatrixInputLimits(rows, keys, undefined);
    expect(result).toEqual({ ok: false, violation: 'SERIALIZED_BYTES_EXCEEDED' });
  });

  // 코드리뷰 수정 3차 — 리뷰가 실측으로 재현한 정확한 경계값 회귀 고정. k=20개
  // 변수 중 하나의 key 이름 길이를 조정해, "{variables}만 직렬화한 바이트"는
  // 상한 이내(true)지만 "실제 Python payload 바이트"는 상한을 넘는(true) 지점을
  // 정확히 만든다 — 고치기 전에는 이 지점에서 ok:true를 잘못 반환했다(선검사
  // 통과 → Python spawn 직전에야 뒤늦게 거부).
  it('{variables}만으로는 상한 이내지만 실제 envelope(protocolVersion+method 포함)로는 상한을 넘는 경계값도 SERIALIZED_BYTES_EXCEEDED로 잡는다', () => {
    const rowCount = 7060;
    const padLen = 780; // 실측: 이 패딩에서 variablesOnly<=한도<real
    const keys = Array.from({ length: 20 }, (_, i) => (i === 0 ? `v0${'x'.repeat(padLen)}` : `v${i}`));
    const rows = makeManyVariableRows(rowCount, keys);

    const variables = keys.map((key) => ({ key, values: rows.map((r) => (r.values[key] as { value: number }).value) }));
    const variablesOnlyBytes = Buffer.byteLength(JSON.stringify({ variables }), 'utf8');
    const realEnvelopeBytes = Buffer.byteLength(
      JSON.stringify({ protocolVersion: 3, correlationMatrix: { method: 'spearman_correlation', variables } }),
      'utf8',
    );
    // 이 테스트 자체가 "경계값" 전제가 실제로 성립하는지부터 확인(전제가 깨지면
    // 아래 result 검증이 무의미해지므로 먼저 방어).
    expect(variablesOnlyBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(realEnvelopeBytes).toBeGreaterThan(2 * 1024 * 1024);

    const result = evaluateCorrelationMatrixInputLimits(rows, keys, 'spearman_correlation');
    expect(result).toEqual({ ok: false, violation: 'SERIALIZED_BYTES_EXCEEDED' });
  });

  // method가 preview 시점처럼 아직 안 정해졌을 때(undefined)는 더 긴 method
  // (spearman_correlation)를 가정해 보수적으로 측정한다 — 실제 method가 무엇이든
  // 그보다 짧거나 같으므로 false negative(선검사만 통과하고 실제 요청이 거부되는
  // 경우)가 생기지 않는다. method 미지정 결과가 spearman_correlation 명시 결과와
  // 정확히 같은지로 "최악 경우를 가정한다"는 동작 자체를 고정한다.
  it('method 미지정(undefined)은 spearman_correlation(더 긴 문자열)을 가정한 것과 동일한 판정을 낸다', () => {
    const rowCount = 7060;
    const padLen = 780;
    const keys = Array.from({ length: 20 }, (_, i) => (i === 0 ? `v0${'x'.repeat(padLen)}` : `v${i}`));
    const rows = makeManyVariableRows(rowCount, keys);

    const withoutMethod = evaluateCorrelationMatrixInputLimits(rows, keys, undefined);
    const withSpearman = evaluateCorrelationMatrixInputLimits(rows, keys, 'spearman_correlation');
    expect(withoutMethod).toEqual(withSpearman);
    expect(withoutMethod).toEqual({ ok: false, violation: 'SERIALIZED_BYTES_EXCEEDED' });
  });
});
