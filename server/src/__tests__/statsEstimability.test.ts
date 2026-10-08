import { describe, it, expect } from 'vitest';
import { computeEstimability } from '../statsEstimability';
import type { DatasetRow } from '../statsDatasetBuilder';
import type { AnalyticsVariableMetadata, ExtractedValue } from '@wr/analytics-core';

function makeVariable(key: string, type: AnalyticsVariableMetadata['type']): AnalyticsVariableMetadata {
  return {
    key,
    label: key,
    group: 'test',
    moduleId: 'test',
    grain: 'case',
    type,
    provenance: 'derived',
    dependsOn: [],
    availableAt: 'assessment',
    shownToAssessor: true,
    allowedAnalysisPurposes: ['association', 'formula_audit'],
    sensitivity: 'non_sensitive',
    formulaFamily: 'test_family',
    supportedFormulaPolicies: ['recompute_current'],
  };
}

function makeRow(caseId: string, personClusterKey: string, values: DatasetRow['values']): DatasetRow {
  return { caseId, personClusterKey, values };
}

function presentValue<T>(value: T): ExtractedValue<T> {
  return { value, missing: null, qualityFlags: [] };
}

function missingValue(): ExtractedValue<null> {
  return { value: null, missing: 'not_entered', qualityFlags: [] };
}

describe('computeEstimability — boolean 변수 연결 억제', () => {
  it('caseCount=21, 사건10·비사건10, 결측1(사람 단위 1명)이면 missingRatesByVariable와 eventNonEvent가 함께 억제된다', () => {
    const catalogByKey = new Map([['flag', makeVariable('flag', 'boolean')]]);
    const rows: DatasetRow[] = [];
    for (let i = 0; i < 10; i++) rows.push(makeRow(`case-event-${i}`, `person-event-${i}`, { flag: presentValue(true) }));
    for (let i = 0; i < 10; i++) rows.push(makeRow(`case-nonevent-${i}`, `person-nonevent-${i}`, { flag: presentValue(false) }));
    rows.push(makeRow('case-missing-1', 'person-missing-1', { flag: missingValue() }));

    expect(rows).toHaveLength(21);

    const result = computeEstimability(rows, ['flag'], catalogByKey);
    expect(result.missingRatesByVariable.flag).toBeNull();
    const entry = result.eventNonEvent.find((e) => e.variableKey === 'flag')!;
    expect(entry.suppressed).toBe(true);
    expect(entry.events).toBeNull();
    expect(entry.nonEvents).toBeNull();
  });

  // §3라운드 — person 단위 판정 회귀 테스트. 사례 수만 보면 사건=10·비사건=10이라 둘 다
  // 안전해 보이지만(사례-기준 옛 구현은 공개해버림), 사건 사례 10건이 전부 1명에게서
  // 나왔으므로(eventPersonCount=1) person 기준 구현은 반드시 억제해야 한다.
  it('사건 사례 10건이 전부 1명에게서 나오면(eventPersonCount=1) 사례 수 기준으로는 안전해 보여도 억제된다', () => {
    const catalogByKey = new Map([['flag', makeVariable('flag', 'boolean')]]);
    const rows: DatasetRow[] = [];
    for (let i = 0; i < 10; i++) rows.push(makeRow(`case-event-${i}`, 'person-solo-event', { flag: presentValue(true) }));
    for (let i = 0; i < 10; i++) rows.push(makeRow(`case-nonevent-${i}`, `person-nonevent-${i}`, { flag: presentValue(false) }));

    const result = computeEstimability(rows, ['flag'], catalogByKey);
    const entry = result.eventNonEvent.find((e) => e.variableKey === 'flag')!;
    // 사례 수 기준(events=10,nonEvents=10)이면 둘 다 억제 임계값(10) 미만이 아니라서
    // "안전하다"고 잘못 판단할 수 있다 — person 기준 구현은 eventPersonCount=1이 0<n<10에
    // 걸려 반드시 억제해야 한다.
    expect(entry.suppressed).toBe(true);
    expect(entry.events).toBeNull();
    expect(entry.nonEvents).toBeNull();
  });

  it('event/nonEvent/missing 전부 person 수가 10 이상이면 억제되지 않는다(회귀 방지)', () => {
    const catalogByKey = new Map([['flag', makeVariable('flag', 'boolean')]]);
    const rows: DatasetRow[] = [];
    for (let i = 0; i < 12; i++) rows.push(makeRow(`case-event-${i}`, `person-event-${i}`, { flag: presentValue(true) }));
    for (let i = 0; i < 12; i++) rows.push(makeRow(`case-nonevent-${i}`, `person-nonevent-${i}`, { flag: presentValue(false) }));

    const result = computeEstimability(rows, ['flag'], catalogByKey);
    const entry = result.eventNonEvent.find((e) => e.variableKey === 'flag')!;
    expect(entry.suppressed).toBe(false);
    expect(entry.events).toBe(12);
    expect(entry.nonEvents).toBe(12);
    expect(result.missingRatesByVariable.flag).toBe(0);
  });
});

describe('computeEstimability — 연속형 변수 missingRatesByVariable', () => {
  it('결측 person 수가 소수(1~9)면 null로 억제된다', () => {
    const catalogByKey = new Map([['x', makeVariable('x', 'continuous')]]);
    const rows: DatasetRow[] = [];
    for (let i = 0; i < 15; i++) rows.push(makeRow(`case-${i}`, `person-${i}`, { x: presentValue(1) }));
    rows.push(makeRow('case-missing', 'person-missing', { x: missingValue() }));

    const result = computeEstimability(rows, ['x'], catalogByKey);
    expect(result.missingRatesByVariable.x).toBeNull();
  });

  it('결측 person 수가 0이면(결측 없음) 정상적으로 0을 반환한다', () => {
    const catalogByKey = new Map([['x', makeVariable('x', 'continuous')]]);
    const rows: DatasetRow[] = [];
    for (let i = 0; i < 15; i++) rows.push(makeRow(`case-${i}`, `person-${i}`, { x: presentValue(1) }));

    const result = computeEstimability(rows, ['x'], catalogByKey);
    expect(result.missingRatesByVariable.x).toBe(0);
  });
});

describe('computeEstimability — candidateParameterCount', () => {
  it('항상 null이다(outcome/predictor 구분이 레시피에 없어 정의 불가)', () => {
    const catalogByKey = new Map([['x', makeVariable('x', 'continuous')]]);
    const rows: DatasetRow[] = Array.from({ length: 20 }, (_, i) => makeRow(`case-${i}`, `person-${i}`, { x: presentValue(1) }));
    const result = computeEstimability(rows, ['x'], catalogByKey);
    expect(result.candidateParameterCount).toBeNull();
  });
});

// 제한데이터 권한자 미리보기 전용 — unrestricted 옵션은 소수 셀 억제를 끈다. 기본값은 기존과 동일.
describe('computeEstimability — unrestricted', () => {
  function singleVariableRows(present: number, missing: number): DatasetRow[] {
    const rows: DatasetRow[] = [];
    for (let i = 0; i < present; i++) rows.push(makeRow(`case-p-${i}`, `person-p-${i}`, { v: presentValue('high') }));
    for (let i = 0; i < missing; i++) rows.push(makeRow(`case-m-${i}`, `person-m-${i}`, { v: missingValue() }));
    return rows;
  }
  const catalog = new Map([['v', makeVariable('v', 'categorical')]]);

  it('결측 2명(소수)이면 기본값은 완전사례 수·결측률을 숨기고 unrestricted는 실제 값을 낸다', () => {
    const rows = singleVariableRows(448, 2);
    const aggregate = computeEstimability(rows, ['v'], catalog);
    expect(aggregate.completeCaseN).toBeNull();
    expect(aggregate.missingRatesByVariable.v).toBeNull();

    const open = computeEstimability(rows, ['v'], catalog, { unrestricted: true });
    expect(open.completeCaseN).toBe(448);
    expect(open.missingRatesByVariable.v).toBeCloseTo(2 / 450, 10);
  });

  it('boolean 변수의 event/non-event도 소수 셀이어도 공개한다', () => {
    const boolCatalog = new Map([['flag', makeVariable('flag', 'boolean')]]);
    const rows: DatasetRow[] = [];
    for (let i = 0; i < 30; i++) rows.push(makeRow(`e-${i}`, `pe-${i}`, { flag: presentValue(true) }));
    for (let i = 0; i < 3; i++) rows.push(makeRow(`n-${i}`, `pn-${i}`, { flag: presentValue(false) }));

    const aggregate = computeEstimability(rows, ['flag'], boolCatalog);
    expect(aggregate.eventNonEvent[0]).toMatchObject({ suppressed: true, events: null, nonEvents: null });

    const open = computeEstimability(rows, ['flag'], boolCatalog, { unrestricted: true });
    expect(open.eventNonEvent[0]).toEqual({ variableKey: 'flag', events: 30, nonEvents: 3, suppressed: false });
    expect(open.missingRatesByVariable.flag).toBe(0);
  });

  it('소수 셀이 없으면 두 모드의 결과가 완전히 같다(해제로 달라진 것이 없음을 비교로 판정할 수 있다)', () => {
    const rows = singleVariableRows(40, 0);
    expect(computeEstimability(rows, ['v'], catalog, { unrestricted: true })).toEqual(computeEstimability(rows, ['v'], catalog));
  });
});
