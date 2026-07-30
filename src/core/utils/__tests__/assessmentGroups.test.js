import { describe, expect, it } from 'vitest';
import {
  buildAssessmentUnits,
  patternKeyOf,
  buildAssessmentGroups,
  mergeDisplayTags,
  applyPatternToUnits,
  revertPatch,
  buildAssessmentBlocks,
  formatGroupedAssessment,
  findUnassignedSideDiagnoses,
} from '../assessmentGroups.js';

function makeDiag(overrides = {}) {
  return {
    id: 'd1', code: '', name: '', side: '',
    confirmedRight: '', assessmentRight: '', reasonRight: [], reasonRightOther: '',
    confirmedLeft: '', assessmentLeft: '', reasonLeft: [], reasonLeftOther: '',
    klgRight: '', klgLeft: '', ellmanRight: '', ellmanLeft: '',
    ...overrides,
  };
}

const KNEE = { code: 'M17.0', name: '무릎 관절증' };
const SPINE = { code: 'M51.2', name: '요추간판 전위' };
const CERVICAL = { code: 'M50.1', name: '경추간판장애' };

describe('buildAssessmentUnits: 평가단위 생성', () => {
  it('우측만 선택하면 평가단위 1개(right)', () => {
    const diag = makeDiag({ ...KNEE, side: 'right' });
    const units = buildAssessmentUnits([diag], []);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ side: 'right', diagId: 'd1', confirmedKey: 'confirmedRight' });
  });

  it('좌측만 선택하면 평가단위 1개(left)', () => {
    const diag = makeDiag({ ...KNEE, side: 'left' });
    const units = buildAssessmentUnits([diag], []);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ side: 'left', confirmedKey: 'confirmedLeft' });
  });

  it('양측이면 평가단위 2개(right+left)', () => {
    const diag = makeDiag({ ...KNEE, side: 'both' });
    const units = buildAssessmentUnits([diag], []);
    expect(units.map(u => u.side)).toEqual(['right', 'left']);
  });

  it('척추(axial)는 side 값과 무관하게 Right 키를 쓰는 단일 "axial" 평가단위', () => {
    const diag = makeDiag({ ...SPINE, side: '' });
    const units = buildAssessmentUnits([diag], []);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ side: 'axial', confirmedKey: 'confirmedRight', reasonKey: 'reasonRight' });
  });

  it('경추(axial)도 동일하게 단일 평가단위', () => {
    const diag = makeDiag({ ...CERVICAL, side: '' });
    const units = buildAssessmentUnits([diag], []);
    expect(units).toHaveLength(1);
    expect(units[0].side).toBe('axial');
  });

  it('비축성 진단에 방향 미선택이면 평가단위가 없다', () => {
    const diag = makeDiag({ ...KNEE, side: '' });
    expect(buildAssessmentUnits([diag], [])).toHaveLength(0);
  });
});

describe('patternKeyOf: 그룹 판정', () => {
  it('상병 상태/업무관련성 미입력이면 null(미완료)', () => {
    const diag = makeDiag({ ...KNEE, side: 'right' });
    const [unit] = buildAssessmentUnits([diag], []);
    expect(patternKeyOf(diag, unit)).toBeNull();
  });

  it('낮음인데 사유가 없으면 null(미완료)', () => {
    const diag = makeDiag({ ...KNEE, side: 'right', confirmedRight: 'confirmed', assessmentRight: 'low', reasonRight: [] });
    const [unit] = buildAssessmentUnits([diag], []);
    expect(patternKeyOf(diag, unit)).toBeNull();
  });

  it('사유 선택 순서가 달라도 같은 집합이면 같은 키', () => {
    const [unitA] = buildAssessmentUnits([makeDiag({ id: 'a', ...KNEE, side: 'right' })], []);
    const diagA = makeDiag({ id: 'a', ...KNEE, side: 'right', confirmedRight: 'confirmed', assessmentRight: 'low', reasonRight: ['lowBurden', 'other'], reasonRightOther: '노출 기간 짧음' });
    const diagB = makeDiag({ id: 'b', ...KNEE, side: 'right', confirmedRight: 'confirmed', assessmentRight: 'low', reasonRight: ['other', 'lowBurden'], reasonRightOther: '노출 기간 짧음' });
    const [unitB] = buildAssessmentUnits([diagB], []);
    expect(patternKeyOf(diagA, unitA)).toBe(patternKeyOf(diagB, unitB));
  });

  it('기타 문구가 다르면 다른 키', () => {
    const diagA = makeDiag({ id: 'a', ...KNEE, side: 'right', confirmedRight: 'confirmed', assessmentRight: 'low', reasonRight: ['other'], reasonRightOther: 'A' });
    const diagB = makeDiag({ id: 'b', ...KNEE, side: 'right', confirmedRight: 'confirmed', assessmentRight: 'low', reasonRight: ['other'], reasonRightOther: 'B' });
    const [unitA] = buildAssessmentUnits([diagA], []);
    const [unitB] = buildAssessmentUnits([diagB], []);
    expect(patternKeyOf(diagA, unitA)).not.toBe(patternKeyOf(diagB, unitB));
  });

  it('사유 집합이 다르면 다른 키', () => {
    const diagA = makeDiag({ id: 'a', ...KNEE, side: 'right', confirmedRight: 'confirmed', assessmentRight: 'low', reasonRight: ['lowBurden'] });
    const diagB = makeDiag({ id: 'b', ...KNEE, side: 'right', confirmedRight: 'confirmed', assessmentRight: 'low', reasonRight: ['ageMild'] });
    const [unitA] = buildAssessmentUnits([diagA], []);
    const [unitB] = buildAssessmentUnits([diagB], []);
    expect(patternKeyOf(diagA, unitA)).not.toBe(patternKeyOf(diagB, unitB));
  });

  it('높음 상태면 남아있는 과거 낮음 사유를 무시하고 같은 키로 취급', () => {
    const diagA = makeDiag({ id: 'a', ...KNEE, side: 'right', confirmedRight: 'confirmed', assessmentRight: 'high', reasonRight: ['lowBurden'] });
    const diagB = makeDiag({ id: 'b', ...KNEE, side: 'right', confirmedRight: 'confirmed', assessmentRight: 'high', reasonRight: [] });
    const [unitA] = buildAssessmentUnits([diagA], []);
    const [unitB] = buildAssessmentUnits([diagB], []);
    expect(patternKeyOf(diagA, unitA)).toBe(patternKeyOf(diagB, unitB));
  });
});

describe('buildAssessmentGroups: 그룹 구성과 정렬', () => {
  function bothHigh(id) {
    return makeDiag({ id, ...KNEE, side: 'both', confirmedRight: 'confirmed', assessmentRight: 'high', confirmedLeft: 'confirmed', assessmentLeft: 'high' });
  }
  function rightLow(id, reason = 'lowBurden') {
    return makeDiag({ id, ...KNEE, side: 'right', confirmedRight: 'confirmed', assessmentRight: 'low', reasonRight: [reason] });
  }
  function incompleteRight(id) {
    return makeDiag({ id, ...KNEE, side: 'right' });
  }

  it('완료 그룹은 구성원 수 내림차순, 동수면 최초 등장 순서로 정렬되고 미완료는 별도 목록', () => {
    const diagnoses = [bothHigh('d1'), rightLow('d2'), rightLow('d3'), incompleteRight('d4')];
    const info = buildAssessmentGroups(diagnoses, []);
    expect(info.stats).toEqual({ diagnosisCount: 4, unitCount: 5, groupCount: 2, incompleteCount: 1 });
    // low 그룹(2개)이 both-high 그룹(2개)보다 units 수는 같음(2 vs 2) → 먼저 등장한 both-high가 앞
    expect(info.groups[0].meta).toMatchObject({ confirmed: 'confirmed', assessment: 'high' });
    expect(info.groups[0].units).toHaveLength(2);
    expect(info.groups[1].meta).toMatchObject({ confirmed: 'confirmed', assessment: 'low' });
    expect(info.groups[1].units).toHaveLength(2);
    expect(info.incomplete).toHaveLength(1);
  });

  it('그룹 크기가 다르면 큰 그룹이 먼저 온다', () => {
    const diagnoses = [rightLow('d1'), bothHigh('d2'), bothHigh('d3')];
    const info = buildAssessmentGroups(diagnoses, []);
    expect(info.groups[0].meta.assessment).toBe('high');
    expect(info.groups[0].units).toHaveLength(4);
    expect(info.groups[1].meta.assessment).toBe('low');
  });
});

describe('findUnassignedSideDiagnoses: 방향 미선택 비축성 상병', () => {
  it('비축성 진단 중 side가 비어있는 것만 골라 원본 index와 함께 반환한다', () => {
    const diagnoses = [
      makeDiag({ id: 'a', ...KNEE, side: 'right' }),
      makeDiag({ id: 'b', ...KNEE, side: '' }),
      makeDiag({ id: 'c', ...SPINE, side: '' }), // 축성은 side 없어도 대상 아님
    ];
    const result = findUnassignedSideDiagnoses(diagnoses, []);
    expect(result).toEqual([{ diag: diagnoses[1], index: 1 }]);
  });

  it('코드/이름이 모두 없는 빈 진단은 제외한다', () => {
    const diagnoses = [makeDiag({ code: '', name: '', side: '' })];
    expect(findUnassignedSideDiagnoses(diagnoses, [])).toEqual([]);
  });
});

describe('buildAssessmentGroups: 방향 미선택 진단이 통계에 반영된다', () => {
  it('unassignedSideDiagnoses를 반환하고 incompleteCount에 합산한다', () => {
    const diagnoses = [
      makeDiag({ id: 'a', ...KNEE, side: 'right', confirmedRight: 'confirmed', assessmentRight: 'high' }),
      makeDiag({ id: 'b', ...KNEE, side: '' }), // 방향 미선택 — 평가단위 0개
      makeDiag({ id: 'c', ...KNEE, side: 'left' }), // 방향은 선택했지만 미입력 — 평가단위 1개(미완료)
    ];
    const info = buildAssessmentGroups(diagnoses, []);
    expect(info.unassignedSideDiagnoses).toEqual([{ diag: diagnoses[1], index: 1 }]);
    expect(info.incomplete).toHaveLength(1); // c만 (b는 애초에 평가단위가 없음)
    expect(info.stats.incompleteCount).toBe(2); // incomplete(1) + unassignedSideDiagnoses(1)
  });
});

describe('mergeDisplayTags: 우/좌 병합 표시', () => {
  it('같은 그룹에 우/좌 평가단위가 모두 있으면 "#N(양측)"으로 합친다', () => {
    const diag = makeDiag({ ...KNEE, side: 'both', confirmedRight: 'confirmed', assessmentRight: 'high', confirmedLeft: 'confirmed', assessmentLeft: 'high' });
    const info = buildAssessmentGroups([diag], []);
    const tags = mergeDisplayTags(info.groups[0].units, info.byId);
    expect(tags).toEqual([{ label: '#1(양측)', sideLabel: '양측', unitIds: [`${diag.id}:right`, `${diag.id}:left`], diagId: diag.id, both: true, index: 0 }]);
  });

  it('우/좌가 다른 그룹으로 갈라지면 각각 "(우)"/"(좌)"로 표시', () => {
    const diag = makeDiag({
      ...KNEE, side: 'both',
      confirmedRight: 'confirmed', assessmentRight: 'high',
      confirmedLeft: 'confirmed', assessmentLeft: 'low', reasonLeft: ['lowBurden'],
    });
    const info = buildAssessmentGroups([diag], []);
    expect(info.groups).toHaveLength(2);
    const highGroup = info.groups.find(g => g.meta.assessment === 'high');
    const lowGroup = info.groups.find(g => g.meta.assessment === 'low');
    expect(mergeDisplayTags(highGroup.units, info.byId)).toEqual([{ label: '#1(우)', sideLabel: '우측', unitIds: [`${diag.id}:right`], diagId: diag.id, both: false, index: 0 }]);
    expect(mergeDisplayTags(lowGroup.units, info.byId)).toEqual([{ label: '#1(좌)', sideLabel: '좌측', unitIds: [`${diag.id}:left`], diagId: diag.id, both: false, index: 0 }]);
  });

  it('축성 평가단위는 "(평가)"로 표시', () => {
    const diag = makeDiag({ ...SPINE, confirmedRight: 'confirmed', assessmentRight: 'high' });
    const info = buildAssessmentGroups([diag], []);
    expect(mergeDisplayTags(info.groups[0].units, info.byId)[0].label).toBe('#1(평가)');
  });

  it('한 그룹 안에 여러 상병이 섞여도 원본 배열 순서(diagIndex)대로 정렬된다', () => {
    // d1(index0)=높음, d2(index1)=낮음(다른 그룹), d3(index2)=높음(d1과 같은 그룹) →
    // 같은 그룹인 d1·d3의 태그가 등장 순서(0, 2)대로 나와야 한다.
    const diagnoses = [
      makeDiag({ id: 'd1', ...KNEE, side: 'right', confirmedRight: 'confirmed', assessmentRight: 'high' }),
      makeDiag({ id: 'd2', ...KNEE, side: 'right', confirmedRight: 'confirmed', assessmentRight: 'low', reasonRight: ['lowBurden'] }),
      makeDiag({ id: 'd3', ...KNEE, side: 'right', confirmedRight: 'confirmed', assessmentRight: 'high' }),
    ];
    const info = buildAssessmentGroups(diagnoses, []);
    const highGroup = info.groups.find(g => g.meta.assessment === 'high');
    const tags = mergeDisplayTags(highGroup.units, info.byId);
    expect(tags.map(t => t.label)).toEqual(['#1(우)', '#3(우)']);
  });
});

describe('applyPatternToUnits / revertPatch: 일괄 적용과 되돌리기', () => {
  it('대상 방향의 필드만 바뀌고 반대쪽·klg·ellman은 보존된다', () => {
    const diag = makeDiag({
      ...KNEE, side: 'both',
      confirmedRight: 'confirmed', assessmentRight: 'high',
      confirmedLeft: 'unconfirmed', assessmentLeft: 'low', reasonLeft: ['ageMild'],
      klgRight: '2', klgLeft: '3',
    });
    const diagnoses = [diag];
    const [rightUnit] = buildAssessmentUnits(diagnoses, []).filter(u => u.side === 'right');

    const { next, undoPatch } = applyPatternToUnits(diagnoses, [rightUnit], { confirmed: 'confirmed', assessment: 'low', reasons: ['lowBurden'] });

    const updated = next[0];
    expect(updated.confirmedRight).toBe('confirmed');
    expect(updated.assessmentRight).toBe('low');
    expect(updated.reasonRight).toEqual(['lowBurden']);
    // 반대쪽/개별 필드 보존
    expect(updated.confirmedLeft).toBe('unconfirmed');
    expect(updated.assessmentLeft).toBe('low');
    expect(updated.reasonLeft).toEqual(['ageMild']);
    expect(updated.klgRight).toBe('2');
    expect(updated.klgLeft).toBe('3');
    // 원본 배열/객체는 불변
    expect(diagnoses[0].assessmentRight).toBe('high');

    const reverted = revertPatch(next, undoPatch);
    expect(reverted[0]).toEqual(diag);
  });

  it('높음으로 바꿔도 과거 낮음 사유는 지우지 않는다(숨겨질 뿐)', () => {
    const diag = makeDiag({ ...KNEE, side: 'right', confirmedRight: 'confirmed', assessmentRight: 'low', reasonRight: ['lowBurden'] });
    const [unit] = buildAssessmentUnits([diag], []);
    const { next } = applyPatternToUnits([diag], [unit], { confirmed: 'confirmed', assessment: 'high' });
    expect(next[0].assessmentRight).toBe('high');
    expect(next[0].reasonRight).toEqual(['lowBurden']);
  });

  it('여러 평가단위에 한 번에 적용해도 diagnoses는 한 번만 새로 만들어진다(불변 배열 1개 반환)', () => {
    const diags = [
      makeDiag({ id: 'a', ...KNEE, side: 'right' }),
      makeDiag({ id: 'b', ...KNEE, side: 'left' }),
    ];
    const units = buildAssessmentUnits(diags, []);
    const { next } = applyPatternToUnits(diags, units, { confirmed: 'confirmed', assessment: 'high' });
    expect(next).toHaveLength(2);
    expect(next.every(d => d.confirmedRight === 'confirmed' || d.confirmedLeft === 'confirmed')).toBe(true);
  });
});

describe('buildAssessmentBlocks: 개별 형식 문구 (기존 reportGenerator/exportService 포맷 재현)', () => {
  it('reasonIndent 2칸 — reportGenerator.js와 동일한 형식', () => {
    const diag = makeDiag({
      ...KNEE, side: 'both',
      confirmedRight: 'confirmed', assessmentRight: 'low', reasonRight: ['lowBurden'],
      confirmedLeft: 'unconfirmed', assessmentLeft: 'high',
    });
    const [block] = buildAssessmentBlocks([diag], [], { reasonIndent: '  ' });
    expect(block).toBe(
      '#1: M17.0 무릎 관절증\n' +
      '  우측: 상병 상태(확인) / 업무관련성(낮음)\n' +
      '  낮음 사유:\n' +
      '  - 누적 신체부담 낮음\n' +
      '  좌측: 상병 상태(미확인) / 업무관련성(높음)'
    );
  });

  it('reasonIndent 4칸 — exportService.js buildAssessmentSummary와 동일한 형식', () => {
    const diag = makeDiag({ ...KNEE, side: 'right', confirmedRight: 'confirmed', assessmentRight: 'low', reasonRight: ['lowBurden', 'other'], reasonRightOther: '노출 짧음' });
    const [block] = buildAssessmentBlocks([diag], [], { reasonIndent: '    ' });
    expect(block).toBe(
      '#1: M17.0 무릎 관절증\n' +
      '  우측: 상병 상태(확인) / 업무관련성(낮음)\n' +
      '    낮음 사유:\n' +
      '    - 누적 신체부담 낮음\n' +
      '    - 기타 (노출 짧음)'
    );
  });

  it('축성 진단은 "평가:" 한 줄로만 표시된다', () => {
    const diag = makeDiag({ ...SPINE, confirmedRight: 'confirmed', assessmentRight: 'high' });
    const [block] = buildAssessmentBlocks([diag], [], { reasonIndent: '  ' });
    expect(block).toBe('#1: M51.2 요추간판 전위\n  평가: 상병 상태(확인) / 업무관련성(높음)');
  });

  it('코드/이름이 모두 없는 진단은 건너뛴다', () => {
    const blocks = buildAssessmentBlocks([makeDiag({ code: '', name: '' })], [], { reasonIndent: '  ' });
    expect(blocks).toHaveLength(0);
  });

  it('방향 미선택 진단은 번호가 매겨진 헤더만 남고 본문이 없다', () => {
    const diagnoses = [makeDiag({ id: 'a', ...KNEE, side: '' }), makeDiag({ id: 'b', ...SPINE, confirmedRight: 'confirmed', assessmentRight: 'high' })];
    const blocks = buildAssessmentBlocks(diagnoses, [], { reasonIndent: '  ' });
    expect(blocks[0]).toBe('#1: M17.0 무릎 관절증');
    expect(blocks[1]).toBe('#2: M51.2 요추간판 전위\n  평가: 상병 상태(확인) / 업무관련성(높음)');
  });
});

describe('formatGroupedAssessment: 그룹 형식 문구', () => {
  it('완료 그룹을 먼저, 미완료를 마지막에 배치하고 상병별로 한 줄씩(코드+이름+방향) 나열한다', () => {
    const diagnoses = [
      makeDiag({ id: 'a', ...KNEE, side: 'both', confirmedRight: 'confirmed', assessmentRight: 'high', confirmedLeft: 'confirmed', assessmentLeft: 'high' }),
      makeDiag({ id: 'b', ...KNEE, side: 'right', confirmedRight: 'confirmed', assessmentRight: 'low', reasonRight: ['lowBurden'] }),
      makeDiag({ id: 'c', ...KNEE, side: 'left' }),
    ];
    const text = formatGroupedAssessment(diagnoses, []);
    expect(text).toBe(
      '[상병 확인 · 업무관련성 높음] 2개\n#1. M17.0 무릎 관절증 (양측)\n\n' +
      '[상병 확인 · 업무관련성 낮음] 1개\n#2. M17.0 무릎 관절증 (우측)\n낮음 사유:\n  - 누적 신체부담 낮음\n\n' +
      '[미입력/검토 필요] 1개\n#3. M17.0 무릎 관절증 (좌측)'
    );
  });

  it('방향 미선택 상병도 [미입력/검토 필요]에 포함된다(문서에서 사라지지 않는다)', () => {
    const diagnoses = [
      makeDiag({ id: 'a', ...KNEE, side: 'right', confirmedRight: 'confirmed', assessmentRight: 'high' }),
      makeDiag({ id: 'b', ...KNEE, side: '' }), // 방향 미선택 — 평가단위가 없어 그룹/미완료 둘 다 원래는 못 잡음
    ];
    const text = formatGroupedAssessment(diagnoses, []);
    expect(text).toContain('[미입력/검토 필요] 1개\n#2. M17.0 무릎 관절증 (방향 미선택)');
  });

  it('평가단위 미완료와 방향 미선택이 섞이면 원본 순서대로 한 줄씩 나열된다', () => {
    const diagnoses = [
      makeDiag({ id: 'a', ...KNEE, side: '' }), // 방향 미선택 (index 0)
      makeDiag({ id: 'b', ...KNEE, side: 'right' }), // 평가단위 미완료 (index 1)
    ];
    const text = formatGroupedAssessment(diagnoses, []);
    expect(text).toBe(
      '[미입력/검토 필요] 2개\n' +
      '#1. M17.0 무릎 관절증 (방향 미선택)\n' +
      '#2. M17.0 무릎 관절증 (우측)'
    );
  });

  it('양측 모두 미완료인 상병은 한 줄(양측)로 합쳐 보여주되, 헤더 개수는 평가단위 2개로 센다', () => {
    // mergeDisplayTags가 우/좌를 한 줄로 합치므로, 줄 수가 아니라
    // info.stats.incompleteCount(평가단위 기준)를 헤더에 써야 한다 — 회귀 방지.
    const diagnoses = [makeDiag({ ...KNEE, side: 'both' })]; // 우/좌 둘 다 미입력
    const text = formatGroupedAssessment(diagnoses, []);
    expect(text).toBe('[미입력/검토 필요] 2개\n#1. M17.0 무릎 관절증 (양측)');
  });

  it('양측 중 한쪽만 미완료면 평가단위 1개로 정확히 센다', () => {
    const diagnoses = [
      makeDiag({ ...KNEE, side: 'both', confirmedRight: 'confirmed', assessmentRight: 'high' }), // 좌만 미완료
    ];
    const text = formatGroupedAssessment(diagnoses, []);
    expect(text).toBe(
      '[상병 확인 · 업무관련성 높음] 1개\n#1. M17.0 무릎 관절증 (우측)\n\n' +
      '[미입력/검토 필요] 1개\n#1. M17.0 무릎 관절증 (좌측)'
    );
  });

  it('대상 목록이 먼저, 낮음 사유는 뒤에 "낮음 사유:" 다음 줄부터 사유 1개당 한 줄씩 불릿으로 나온다', () => {
    const diagnoses = [
      makeDiag({
        ...KNEE, side: 'right',
        confirmedRight: 'confirmed', assessmentRight: 'low',
        reasonRight: ['lowBurden', 'ageMild', 'other'], reasonRightOther: '노출 기간 짧음',
      }),
    ];
    const text = formatGroupedAssessment(diagnoses, []);
    expect(text).toBe(
      '[상병 확인 · 업무관련성 낮음] 1개\n' +
      '#1. M17.0 무릎 관절증 (우측)\n' +
      '낮음 사유:\n' +
      '  - 연령대비 경미\n' +
      '  - 누적 신체부담 낮음\n' +
      '  - 기타 (노출 기간 짧음)'
    );
  });

  it('척추/경추(축성)는 방향 개념이 없으므로 대상 줄에 "(평가)"를 붙이지 않는다', () => {
    const diagnoses = [
      makeDiag({ ...SPINE, confirmedRight: 'confirmed', assessmentRight: 'high' }),
      makeDiag({ id: 'c', ...CERVICAL, confirmedRight: 'confirmed', assessmentRight: 'high' }),
    ];
    const text = formatGroupedAssessment(diagnoses, []);
    expect(text).toContain('#1. M51.2 요추간판 전위\n#2. M50.1 경추간판장애');
    expect(text).not.toContain('(평가)');
  });
});
