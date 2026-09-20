import { describe, it, expect } from 'vitest';
import {
  extractDiagnosisIdentityModuleGroup,
  extractDiagnosisIdentityCode,
  extractDiagnosisIdentityName,
  extractDiagnosisAssessmentStatus,
  extractDiagnosisAssessmentLowReasonUnrelated,
  extractDiagnosisAssessmentLowReasonOther,
  extractDiagnosisAssessmentLowReasonLowBurden,
  extractDiagnosisRollupAnyHighRelatedness,
  extractDiagnosisRollupHasKnee,
  extractDiagnosisRollupHasShoulder,
  extractDiagnosisRollupHasWrist,
  extractDiagnosisRollupHasElbow,
  extractDiagnosisRollupHasSpine,
  extractDiagnosisRollupHasCervical,
} from '../../../modules/diagnosis/extractors';
import { deterministicMigrate } from '../../../migration/deterministicMigrate';

const FALLBACK = '2024-01-01T00:00:00.000Z';

function migrate(payload: unknown, caseId = 'case-1') {
  return deterministicMigrate(payload, { caseId, createdAtFallbackIso: FALLBACK });
}

function diagnosesCase(diagnoses: unknown[]) {
  return { data: { shared: { diagnoses }, modules: {}, activeModules: [] } };
}

function diagnosesCaseWithActiveModules(diagnoses: unknown[], activeModules: string[]) {
  return { data: { shared: { diagnoses }, modules: {}, activeModules } };
}

describe('extractDiagnosisIdentityModuleGroup — diagnosisMapping.ts 정규식 버그 수정 후 최초 파생(§5.5 ④)', () => {
  it('명시적 moduleId가 유효한 6개 모듈 중 하나면 그대로 사용한다', () => {
    const dx = { id: 'dx-1', code: 'M17.1', name: '무릎 관절증', moduleId: 'shoulder' };
    const result = extractDiagnosisIdentityModuleGroup(migrate(diagnosesCase([dx])));
    expect(result).toEqual([{ entityKey: ['dx-1', 'unspecified'], value: 'shoulder', missing: null, qualityFlags: [] }]);
  });

  it('moduleId가 "__none__"이면 not_applicable(구조적으로 부위군이 없음, 결측 아님)', () => {
    const dx = { id: 'dx-1', code: 'M17.1', name: '무릎 관절증', moduleId: '__none__' };
    const result = extractDiagnosisIdentityModuleGroup(migrate(diagnosesCase([dx])));
    expect(result).toEqual([{ entityKey: ['dx-1', 'unspecified'], value: null, missing: 'not_applicable', qualityFlags: [] }]);
  });

  it('moduleId 없이 ICD 코드로 매치되면 해당 부위군을 반환한다', () => {
    const dx = { id: 'dx-1', code: 'M51.2', name: '요추간판탈출증' };
    const result = extractDiagnosisIdentityModuleGroup(migrate(diagnosesCase([dx])));
    expect(result).toEqual([{ entityKey: ['dx-1', 'unspecified'], value: 'spine', missing: null, qualityFlags: [] }]);
  });

  it('moduleId 없이 상병명으로만 매치되면 해당 부위군을 반환한다', () => {
    const dx = { id: 'dx-1', code: '', name: '허리 통증' };
    const result = extractDiagnosisIdentityModuleGroup(migrate(diagnosesCase([dx])));
    expect(result).toEqual([{ entityKey: ['dx-1', 'unspecified'], value: 'spine', missing: null, qualityFlags: [] }]);
  });

  // 이 회귀 테스트가 바로 diagnosisMapping.ts 버그 수정의 존재 이유다 — 수정 전에는 이
  // 값이 'spine'으로 잘못 반환됐다(정규식 끝 빈 대안이 모든 미매칭 문자열에 매치).
  it('어떤 모듈 패턴에도 안 걸리는 진단명은 not_entered + legacy_unknown(요추로 잘못 집계되지 않는다)', () => {
    const dx = { id: 'dx-1', code: 'J00', name: '감기' };
    const result = extractDiagnosisIdentityModuleGroup(migrate(diagnosesCase([dx])));
    expect(result).toEqual([{ entityKey: ['dx-1', 'unspecified'], value: null, missing: 'not_entered', qualityFlags: ['legacy_unknown'] }]);
  });

  it('activeModules가 1개뿐이어도(UI fallback 규칙) 그 모듈로 잘못 집계되지 않는다', () => {
    const payload = {
      data: { shared: { diagnoses: [{ id: 'dx-1', code: 'J00', name: '감기' }] }, modules: {}, activeModules: ['spine'] },
    };
    const result = extractDiagnosisIdentityModuleGroup(migrate(payload));
    expect(result[0].value).toBeNull();
    expect(result[0].missing).toBe('not_entered');
  });

  it('side="both"인 진단은 양측으로 explode되지만 부위군 값은 동일하다', () => {
    const dx = { id: 'dx-1', code: 'M51.2', name: '요추간판탈출증', side: 'both' };
    const result = extractDiagnosisIdentityModuleGroup(migrate(diagnosesCase([dx])));
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.entityKey[1]).sort()).toEqual(['left', 'right']);
    expect(result.every((r) => r.value === 'spine')).toBe(true);
  });

  it('빈 placeholder 진단(code/name 둘 다 공백)은 엔터티 자체가 없다', () => {
    const dx = { id: 'dx-1', code: '', name: '' };
    const result = extractDiagnosisIdentityModuleGroup(migrate(diagnosesCase([dx])));
    expect(result).toEqual([]);
  });

  it('결정성 — 동일 snapshot을 두 번 추출해도 byte-identical 결과', () => {
    const payload = diagnosesCase([{ id: 'dx-1', code: 'M51.2', name: '요추간판탈출증' }]);
    expect(extractDiagnosisIdentityModuleGroup(migrate(payload))).toEqual(extractDiagnosisIdentityModuleGroup(migrate(payload)));
  });
});

// PR0-B4 Slice 6 — coverage 잔여 필드(매핑표 §1 shared.diagnoses[]).
describe('extractDiagnosisIdentityCode/Name — diagnosis_side grain(side와 무관하게 진단 자체 값 반복)', () => {
  it('미입력은 not_entered', () => {
    const dx = { id: 'dx-1', code: '', name: 'x' };
    expect(extractDiagnosisIdentityCode(migrate(diagnosesCase([dx])))).toEqual([
      { entityKey: ['dx-1', 'unspecified'], value: null, missing: 'not_entered', qualityFlags: [] },
    ]);
  });

  it('정상 입력은 그대로 통과', () => {
    const dx = { id: 'dx-1', code: 'M51.2', name: '요추간판탈출증' };
    expect(extractDiagnosisIdentityCode(migrate(diagnosesCase([dx])))).toEqual([
      { entityKey: ['dx-1', 'unspecified'], value: 'M51.2', missing: null, qualityFlags: [] },
    ]);
    expect(extractDiagnosisIdentityName(migrate(diagnosesCase([dx])))).toEqual([
      { entityKey: ['dx-1', 'unspecified'], value: '요추간판탈출증', missing: null, qualityFlags: [] },
    ]);
  });

  it('문자열이 아니면 not_entered + invalid', () => {
    const dx = { id: 'dx-1', code: 123 as unknown, name: '요추간판탈출증' };
    expect(extractDiagnosisIdentityCode(migrate(diagnosesCase([dx])))).toEqual([
      { entityKey: ['dx-1', 'unspecified'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] },
    ]);
  });

  it('side="both"로 엔터티가 2개로 explode돼도 값은 동일하게 반복된다', () => {
    const dx = { id: 'dx-1', code: 'M51.2', name: '요추간판탈출증', side: 'both' };
    const result = extractDiagnosisIdentityCode(migrate(diagnosesCase([dx])));
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.value === 'M51.2')).toBe(true);
  });
});

describe('extractDiagnosisAssessmentStatus — diagnosis_side grain("업무관련성" high/low)', () => {
  it('비축성(예: 무릎) 진단에서 side가 unspecified면 평가단위 자체가 없어 not_entered', () => {
    const dx = { id: 'dx-1', code: 'M17.0', name: '무릎 관절증', assessmentRight: 'high' };
    expect(extractDiagnosisAssessmentStatus(migrate(diagnosesCase([dx])))).toEqual([
      { entityKey: ['dx-1', 'unspecified'], value: null, missing: 'not_entered', qualityFlags: [] },
    ]);
  });

  it('비축성 진단은 side별로 다른 필드를 읽는다 — right는 assessmentRight, left는 assessmentLeft', () => {
    const dx = { id: 'dx-1', code: 'M17.0', name: '무릎 관절증', side: 'both', assessmentRight: 'high', assessmentLeft: 'low' };
    const result = extractDiagnosisAssessmentStatus(migrate(diagnosesCase([dx])));
    expect(result.find((r) => r.entityKey[1] === 'right')?.value).toBe('high');
    expect(result.find((r) => r.entityKey[1] === 'left')?.value).toBe('low');
  });

  it('미입력은 not_entered, 도메인 밖 값(high/low가 아님)은 not_entered + invalid', () => {
    const dxBlank = { id: 'dx-1', code: 'M17.0', name: '무릎 관절증', side: 'right', assessmentRight: '' };
    expect(extractDiagnosisAssessmentStatus(migrate(diagnosesCase([dxBlank])))).toEqual([
      { entityKey: ['dx-1', 'right'], value: null, missing: 'not_entered', qualityFlags: [] },
    ]);
    const dxInvalid = { id: 'dx-1', code: 'M17.0', name: '무릎 관절증', side: 'right', assessmentRight: 'medium' };
    expect(extractDiagnosisAssessmentStatus(migrate(diagnosesCase([dxInvalid])))).toEqual([
      { entityKey: ['dx-1', 'right'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] },
    ]);
  });

  // 8차 검토 P1 재현 — 축성(척추/경추) 진단은 DiagnosisForm.jsx가 방향 라디오 자체를
  // 숨겨 diag.side가 항상 공백('unspecified')으로 남는다. assessmentGroups.js의
  // unitsForDiagnosis가 isAxial이면 side 값과 무관하게 Right 키 하나만 "평가" 슬롯으로
  // 쓰므로, extractor도 side==='unspecified'를 무조건 not_entered로 처리하면 정상 입력이
  // 있는데도 전부 결측으로 잘못 집계된다.
  it('축성(척추) 진단은 side 미선택이어도 assessmentRight를 그대로 읽는다', () => {
    const dx = { id: 'dx-1', code: 'M51.2', name: '요추간판탈출증', assessmentRight: 'low' };
    expect(extractDiagnosisAssessmentStatus(migrate(diagnosesCase([dx])))).toEqual([
      { entityKey: ['dx-1', 'unspecified'], value: 'low', missing: null, qualityFlags: [] },
    ]);
  });

  it('경추 진단도 동일하게 side 미선택 상태에서 assessmentRight를 읽는다', () => {
    const dx = { id: 'dx-1', code: 'M50.1', name: '경추간판탈출증', assessmentRight: 'high' };
    expect(extractDiagnosisAssessmentStatus(migrate(diagnosesCase([dx])))).toEqual([
      { entityKey: ['dx-1', 'unspecified'], value: 'high', missing: null, qualityFlags: [] },
    ]);
  });

  it('축성 진단은 side가 비정상적으로 "both"로 저장돼 있어도(레거시 오염) side 값과 무관하게 항상 assessmentRight만 읽는다', () => {
    const dx = { id: 'dx-1', code: 'M51.2', name: '요추간판탈출증', side: 'both', assessmentRight: 'high', assessmentLeft: 'low' };
    const result = extractDiagnosisAssessmentStatus(migrate(diagnosesCase([dx])));
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.value === 'high')).toBe(true);
  });

  // 9차 검토 P2 재현 — resolveAssessmentSide(당시 [])는 "활성 모듈이 정확히 1개일 때 코드/
  // 명으로 안 잡히는 진단을 그 모듈로 fallback"하는 UI 편의 규칙(assessmentGroups.js:36,
  // DiagnosisForm.jsx:41)을 꺼뒀다. 척추만 활성인 case에서 코드/명으로 분류 안 되는 진단도
  // UI에서는 축성으로 취급돼 assessmentRight에 저장되는데, 통계는 이걸 못 읽고 있었다.
  it('코드/명으로 분류 안 되는 진단도 활성 모듈이 척추 하나뿐이면 축성으로 취급해 assessmentRight를 읽는다', () => {
    const dx = { id: 'dx-1', code: 'J00', name: '감기', assessmentRight: 'low' };
    const result = extractDiagnosisAssessmentStatus(migrate(diagnosesCaseWithActiveModules([dx], ['spine'])));
    expect(result).toEqual([{ entityKey: ['dx-1', 'unspecified'], value: 'low', missing: null, qualityFlags: [] }]);
  });

  it('경추 하나만 활성이어도 동일하게 fallback되어 assessmentRight를 읽는다', () => {
    const dx = { id: 'dx-1', code: 'J00', name: '감기', assessmentRight: 'high' };
    const result = extractDiagnosisAssessmentStatus(migrate(diagnosesCaseWithActiveModules([dx], ['cervical'])));
    expect(result).toEqual([{ entityKey: ['dx-1', 'unspecified'], value: 'high', missing: null, qualityFlags: [] }]);
  });

  it('활성 모듈이 2개 이상이면 fallback 규칙 자체가 적용되지 않아(UI와 동일) 여전히 not_entered', () => {
    const dx = { id: 'dx-1', code: 'J00', name: '감기', assessmentRight: 'low' };
    const result = extractDiagnosisAssessmentStatus(migrate(diagnosesCaseWithActiveModules([dx], ['spine', 'knee'])));
    expect(result).toEqual([{ entityKey: ['dx-1', 'unspecified'], value: null, missing: 'not_entered', qualityFlags: [] }]);
  });

  // 부위군 분류 변수(extractDiagnosisIdentityModuleGroup)는 activeModules=[] 고정을 계속
  // 유지해야 한다 — 판정 라우팅과는 다른 정책이므로 이 회귀 방지 테스트로 둘을 구분한다.
  it('부위군 분류 변수(moduleGroup)는 활성 모듈이 1개여도 여전히 fallback하지 않는다(정책 구분 확인)', () => {
    const dx = { id: 'dx-1', code: 'J00', name: '감기' };
    const result = extractDiagnosisIdentityModuleGroup(migrate(diagnosesCaseWithActiveModules([dx], ['spine'])));
    expect(result).toEqual([{ entityKey: ['dx-1', 'unspecified'], value: null, missing: 'not_entered', qualityFlags: ['legacy_unknown'] }]);
  });
});

describe('extractDiagnosisRollupAnyHighRelatedness — case grain("업무관련성" any 롤업)', () => {
  it('상병 중 하나라도 high면 true(다른 상병이 low여도 무관)', () => {
    const dxHigh = { id: 'dx-1', code: 'M75.1', name: '회전근개파열', side: 'right', assessmentRight: 'high' };
    const dxLow = { id: 'dx-2', code: 'M17.1', name: '무릎관절증', side: 'right', assessmentRight: 'low' };
    const result = extractDiagnosisRollupAnyHighRelatedness(migrate(diagnosesCase([dxHigh, dxLow])));
    expect(result).toEqual({ value: true, missing: null, qualityFlags: [] });
  });

  it('전부 low로 확정되면 false', () => {
    const dx1 = { id: 'dx-1', code: 'M75.1', name: '회전근개파열', side: 'right', assessmentRight: 'low' };
    const dx2 = { id: 'dx-2', code: 'M17.1', name: '무릎관절증', side: 'right', assessmentRight: 'low' };
    const result = extractDiagnosisRollupAnyHighRelatedness(migrate(diagnosesCase([dx1, dx2])));
    expect(result).toEqual({ value: false, missing: null, qualityFlags: [] });
  });

  it('low와 미판정이 혼재하면(high 없음) false가 아니라 not_entered다', () => {
    const dxLow = { id: 'dx-1', code: 'M75.1', name: '회전근개파열', side: 'right', assessmentRight: 'low' };
    const dxBlank = { id: 'dx-2', code: 'M17.1', name: '무릎관절증', side: 'right', assessmentRight: '' };
    const result = extractDiagnosisRollupAnyHighRelatedness(migrate(diagnosesCase([dxLow, dxBlank])));
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('신청상병이 0건이면 not_applicable', () => {
    const result = extractDiagnosisRollupAnyHighRelatedness(migrate(diagnosesCase([])));
    expect(result).toEqual({ value: null, missing: 'not_applicable', qualityFlags: [] });
  });

  it('side="both" 진단은 좌우가 다른 판정이어도 하나라도 high면 true', () => {
    const dx = { id: 'dx-1', code: 'M51.2', name: '요추간판탈출증', side: 'both', assessmentRight: 'low', assessmentLeft: 'low' };
    const dxKnee = { id: 'dx-2', code: 'M17.1', name: '무릎관절증', side: 'both', assessmentRight: 'low', assessmentLeft: 'high' };
    const result = extractDiagnosisRollupAnyHighRelatedness(migrate(diagnosesCase([dx, dxKnee])));
    expect(result).toEqual({ value: true, missing: null, qualityFlags: [] });
  });

  it('축성 진단의 high 판정도 정상 반영한다(resolveAssessmentSide 재사용 확인)', () => {
    const dx = { id: 'dx-1', code: 'M51.2', name: '요추간판탈출증', assessmentRight: 'high' };
    const result = extractDiagnosisRollupAnyHighRelatedness(migrate(diagnosesCase([dx])));
    expect(result).toEqual({ value: true, missing: null, qualityFlags: [] });
  });

  it('high가 있어도 다른 상병의 판정값이 손상돼 있으면 invalid 플래그를 함께 실어 보낸다', () => {
    const dxHigh = { id: 'dx-1', code: 'M75.1', name: '회전근개파열', side: 'right', assessmentRight: 'high' };
    const dxInvalid = { id: 'dx-2', code: 'M17.1', name: '무릎관절증', side: 'right', assessmentRight: 'medium' };
    const result = extractDiagnosisRollupAnyHighRelatedness(migrate(diagnosesCase([dxHigh, dxInvalid])));
    expect(result.value).toBe(true);
    expect(result.missing).toBeNull();
    expect(result.qualityFlags).toContain('invalid');
  });

  // 리뷰 지적 — 판정 오류(assessment 값 자체 손상)와 엔터티/ID 오류를 섞어 판정하면 안
  // 된다. 둘 다 qualityFlags에는 'invalid'가 남지만 value/missing은 서로 달라야 한다.
  // (수정 — 최초 버전은 dx-1/dx-2로 서로 다른 정상 ID를 써서 실제로는 ID 오류를 전혀
  // 만들지 않았다. grainEntities.ts의 resolveUniqueLocalId는 같은 id가 중복되면 두
  // 번째 엔터티에 'invalid' 플래그를 붙이고 id를 'dx-1#1'로 보정한다 — 그 경로를 실제로
  // 타도록 두 진단에 동일한 id를 준다.)
  it('대조: 판정은 전부 low로 확정됐지만 중복 ID로 엔터티 자체에 invalid 플래그가 붙어도 값은 false다', () => {
    const dx1 = { id: 'dx-1', code: 'M75.1', name: '회전근개파열', side: 'right', assessmentRight: 'low' };
    const dx2 = { id: 'dx-1', code: 'M17.1', name: '무릎관절증', side: 'right', assessmentRight: 'low' }; // id 중복(의도적)
    const result = extractDiagnosisRollupAnyHighRelatedness(migrate(diagnosesCase([dx1, dx2])));
    expect(result).toEqual({ value: false, missing: null, qualityFlags: ['invalid'] });
  });

  it('대조: low 하나 + 판정값 자체가 손상된 진단 하나는 not_entered(값은 다르지만 qualityFlags엔 둘 다 invalid가 남을 수 있음)', () => {
    const dxLow = { id: 'dx-1', code: 'M75.1', name: '회전근개파열', side: 'right', assessmentRight: 'low' };
    const dxCorrupted = { id: 'dx-2', code: 'M17.1', name: '무릎관절증', side: 'right', assessmentRight: 'medium' };
    const result = extractDiagnosisRollupAnyHighRelatedness(migrate(diagnosesCase([dxLow, dxCorrupted])));
    expect(result.value).toBeNull();
    expect(result.missing).toBe('not_entered');
    expect(result.qualityFlags).toContain('invalid');
  });
});

describe('diagnosis.rollup.hasX 6종 — case grain(부위별 "목록 포함 여부")', () => {
  it('무릎+어깨 진단이 섞이면 각 부위는 true, 나머지 4개는 false로 정확히 분리된다', () => {
    const dxKnee = { id: 'dx-1', code: 'M17.1', name: '무릎관절증' };
    const dxShoulder = { id: 'dx-2', code: 'M75.1', name: '회전근개파열' };
    const mr = migrate(diagnosesCase([dxKnee, dxShoulder]));
    expect(extractDiagnosisRollupHasKnee(mr)).toEqual({ value: true, missing: null, qualityFlags: [] });
    expect(extractDiagnosisRollupHasShoulder(mr)).toEqual({ value: true, missing: null, qualityFlags: [] });
    expect(extractDiagnosisRollupHasWrist(mr)).toEqual({ value: false, missing: null, qualityFlags: [] });
    expect(extractDiagnosisRollupHasElbow(mr)).toEqual({ value: false, missing: null, qualityFlags: [] });
    expect(extractDiagnosisRollupHasSpine(mr)).toEqual({ value: false, missing: null, qualityFlags: [] });
    expect(extractDiagnosisRollupHasCervical(mr)).toEqual({ value: false, missing: null, qualityFlags: [] });
  });

  it('moduleId가 "__none__"인 진단은 어느 부위에도 기여하지 않는다', () => {
    const dx = { id: 'dx-1', code: 'M17.1', name: '무릎관절증', moduleId: '__none__' };
    const result = extractDiagnosisRollupHasKnee(migrate(diagnosesCase([dx])));
    expect(result).toEqual({ value: false, missing: null, qualityFlags: [] });
  });

  it('진단이 0건이면 false(missing 아님)', () => {
    const result = extractDiagnosisRollupHasKnee(migrate(diagnosesCase([])));
    expect(result).toEqual({ value: false, missing: null, qualityFlags: [] });
  });

  // 리뷰 반영 핵심 케이스 — 미분류 진단은 "부위 없음(false)"과 구분해야 한다.
  it('6개 부위 어디로도 분류 안 되는 진단만 있으면 false가 아니라 not_entered(+legacy_unknown)다', () => {
    const dx = { id: 'dx-1', code: 'J00', name: '감기' };
    const result = extractDiagnosisRollupHasKnee(migrate(diagnosesCase([dx])));
    expect(result.value).toBeNull();
    expect(result.missing).toBe('not_entered');
    expect(result.qualityFlags).toContain('legacy_unknown');
  });

  // 미분류 진단이 있어도, 다른 진단이 확실히 그 부위로 분류되면 true 확정 자체는
  // 막히지 않는다 — 다만 발견한 품질 문제(legacy_unknown)는 그대로 실어 보낸다.
  it('미분류 진단이 섞여 있어도 다른 진단이 확실히 무릎이면 hasKnee=true이고 legacy_unknown 플래그도 함께 남는다', () => {
    const dxKnee = { id: 'dx-1', code: 'M17.1', name: '무릎관절증' };
    const dxUnknown = { id: 'dx-2', code: 'J00', name: '감기' };
    const result = extractDiagnosisRollupHasKnee(migrate(diagnosesCase([dxKnee, dxUnknown])));
    expect(result.value).toBe(true);
    expect(result.missing).toBeNull();
    expect(result.qualityFlags).toContain('legacy_unknown');
  });

  it('양측(side="both") 진단이 같은 부위로 분류돼도 true는 한 번만 확정된다(중복 계산 문제 없음)', () => {
    const dx = { id: 'dx-1', code: 'M51.2', name: '요추간판탈출증', side: 'both' };
    const result = extractDiagnosisRollupHasSpine(migrate(diagnosesCase([dx])));
    expect(result).toEqual({ value: true, missing: null, qualityFlags: [] });
  });

  it('서로 다른 방식(명시적 moduleId, 코드/명 패턴)으로 같은 부위에 매치된 진단 2개도 true 하나로 수렴한다', () => {
    const dxExplicit = { id: 'dx-1', code: 'X', name: 'X', moduleId: 'cervical' };
    const dxPattern = { id: 'dx-2', code: 'M50.1', name: '경추간판탈출증' };
    const result = extractDiagnosisRollupHasCervical(migrate(diagnosesCase([dxExplicit, dxPattern])));
    expect(result).toEqual({ value: true, missing: null, qualityFlags: [] });
  });
});

describe('extractDiagnosisAssessmentLowReason* — assessment!=="low"면 배열 내용과 무관하게 not_applicable', () => {
  it('assessment가 "low"가 아니면(예: "high") reasonRight에 값이 남아있어도 not_applicable', () => {
    const dx = { id: 'dx-1', code: 'M17.0', name: '무릎 관절증', side: 'right', assessmentRight: 'high', reasonRight: ['unrelated'] };
    expect(extractDiagnosisAssessmentLowReasonUnrelated(migrate(diagnosesCase([dx])))).toEqual([
      { entityKey: ['dx-1', 'right'], value: null, missing: 'not_applicable', qualityFlags: [] },
    ]);
  });

  it('assessment가 공백(미입력)이어도 "low"가 아니므로 not_applicable', () => {
    const dx = { id: 'dx-1', code: 'M17.0', name: '무릎 관절증', side: 'right', assessmentRight: '', reasonRight: ['unrelated'] };
    expect(extractDiagnosisAssessmentLowReasonUnrelated(migrate(diagnosesCase([dx])))).toEqual([
      { entityKey: ['dx-1', 'right'], value: null, missing: 'not_applicable', qualityFlags: [] },
    ]);
  });

  // 8차 검토 P1 재현 — reasonRight가 아예 undefined(필드 자체가 없던 시절 레코드)인 경우와
  // 명시적으로 빈 배열([])인 경우는 §다중선택 배열 계약상 서로 다른 결측 사유다. 이전
  // 구현은 isBlank(raw)로 둘을 구분 없이 not_entered 하나로 뭉뚱그렸다.
  it('reasonRight 필드 자체가 undefined면(스키마에 없던 시절 레코드) structural_missing', () => {
    const dx = { id: 'dx-1', code: 'M17.0', name: '무릎 관절증', side: 'right', assessmentRight: 'low' };
    expect(extractDiagnosisAssessmentLowReasonUnrelated(migrate(diagnosesCase([dx])))).toEqual([
      { entityKey: ['dx-1', 'right'], value: null, missing: 'structural_missing', qualityFlags: [] },
    ]);
  });

  it('assessment==="low"이고 reasonRight가 명시적으로 빈 배열이면(사유 없음을 선택) 정상 false — 분모에서 빠지지 않는다', () => {
    const dx = { id: 'dx-1', code: 'M17.0', name: '무릎 관절증', side: 'right', assessmentRight: 'low', reasonRight: [] };
    expect(extractDiagnosisAssessmentLowReasonUnrelated(migrate(diagnosesCase([dx])))).toEqual([
      { entityKey: ['dx-1', 'right'], value: false, missing: null, qualityFlags: [] },
    ]);
  });

  it('assessment==="low"이고 배열이 아니면(손상) not_entered + invalid', () => {
    const dx = { id: 'dx-1', code: 'M17.0', name: '무릎 관절증', side: 'right', assessmentRight: 'low', reasonRight: 'unrelated' as unknown };
    expect(extractDiagnosisAssessmentLowReasonUnrelated(migrate(diagnosesCase([dx])))).toEqual([
      { entityKey: ['dx-1', 'right'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] },
    ]);
  });

  // 8차 검토 P1 재현 — 이전 구현은 raw.filter(v => typeof v === 'string')로 손상 원소만
  // 조용히 걸러내 배열 전체를 정상 응답처럼 통과시켰다(예: ['lowBurden', 123] → true로
  // 집계돼 결측이어야 할 값이 정상값에 섞였다). 이제는 원소 중 하나라도 문자열이 아니면
  // 배열 전체를 거부한다(부분 필터링 금지).
  it('배열 원소 중 문자열이 아닌 게 섞여 있으면(손상) 배열 전체를 거부 — not_entered + invalid', () => {
    const dxAllInvalid = { id: 'dx-1', code: 'M17.0', name: '무릎 관절증', side: 'right', assessmentRight: 'low', reasonRight: [123] as unknown };
    expect(extractDiagnosisAssessmentLowReasonUnrelated(migrate(diagnosesCase([dxAllInvalid])))).toEqual([
      { entityKey: ['dx-1', 'right'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] },
    ]);
    const dxMixed = { id: 'dx-1', code: 'M17.0', name: '무릎 관절증', side: 'right', assessmentRight: 'low', reasonRight: ['lowBurden', 123] as unknown };
    expect(extractDiagnosisAssessmentLowReasonUnrelated(migrate(diagnosesCase([dxMixed])))).toEqual([
      { entityKey: ['dx-1', 'right'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] },
    ]);
  });

  it('assessment==="low"이고 정상 배열이면 옵션별 boolean으로 분해된다', () => {
    const dx = { id: 'dx-1', code: 'M17.0', name: '무릎 관절증', side: 'right', assessmentRight: 'low', reasonRight: ['unrelated', 'other'] };
    expect(extractDiagnosisAssessmentLowReasonUnrelated(migrate(diagnosesCase([dx])))).toEqual([
      { entityKey: ['dx-1', 'right'], value: true, missing: null, qualityFlags: [] },
    ]);
    expect(extractDiagnosisAssessmentLowReasonOther(migrate(diagnosesCase([dx])))).toEqual([
      { entityKey: ['dx-1', 'right'], value: true, missing: null, qualityFlags: [] },
    ]);
  });

  // 미지원 옵션값(카탈로그의 LOW_REASON_OPTIONS 7종에 없는 문자열, 예: 구버전에서 지운
  // 옵션)은 §다중선택 배열 계약상 배열 전체를 거부하지 않고 legacy_unknown 플래그만
  // 붙인다 — 그 행에 걸린 모든 옵션 boolean 추출에 공통으로 붙는다(어느 옵션이 true인지와
  // 무관하게 "이 배열에 알 수 없는 값이 섞여 있다"는 데이터 품질 신호이므로).
  it('배열에 미지원 문자열 옵션값이 섞여 있으면 옵션별 boolean은 정상 계산하되 legacy_unknown 플래그가 붙는다', () => {
    const dx = { id: 'dx-1', code: 'M17.0', name: '무릎 관절증', side: 'right', assessmentRight: 'low', reasonRight: ['unrelated', 'retiredOptionX'] };
    expect(extractDiagnosisAssessmentLowReasonUnrelated(migrate(diagnosesCase([dx])))).toEqual([
      { entityKey: ['dx-1', 'right'], value: true, missing: null, qualityFlags: ['legacy_unknown'] },
    ]);
    // 'other'는 선택되지 않았지만(명시적 false), 같은 행이라 legacy_unknown은 동일하게 붙는다.
    expect(extractDiagnosisAssessmentLowReasonOther(migrate(diagnosesCase([dx])))).toEqual([
      { entityKey: ['dx-1', 'right'], value: false, missing: null, qualityFlags: ['legacy_unknown'] },
    ]);
  });

  it('배열에 없는 옵션은 false(명시적 미선택)로 반환된다', () => {
    const dx = { id: 'dx-1', code: 'M51.2', name: 'x', side: 'right', assessmentRight: 'low', reasonRight: ['other'] };
    expect(extractDiagnosisAssessmentLowReasonUnrelated(migrate(diagnosesCase([dx])))).toEqual([
      { entityKey: ['dx-1', 'right'], value: false, missing: null, qualityFlags: [] },
    ]);
  });

  // 9차 검토 P2 — assessmentStatus와 동일한 activeModules fallback 버그가 lowReason
  // 경로(resolveLowReasonState도 resolveAssessmentSide를 공유)에도 있었다.
  it('코드/명으로 분류 안 되는 진단도 활성 모듈이 척추 하나뿐이면 reasonRight를 읽는다', () => {
    const dx = { id: 'dx-1', code: 'J00', name: '감기', assessmentRight: 'low', reasonRight: ['lowBurden'] };
    const result = extractDiagnosisAssessmentLowReasonLowBurden(migrate(diagnosesCaseWithActiveModules([dx], ['spine'])));
    expect(result).toEqual([{ entityKey: ['dx-1', 'unspecified'], value: true, missing: null, qualityFlags: [] }]);
  });
});
