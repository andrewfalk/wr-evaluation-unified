// 상병별 종합평가(확인 상태·업무관련성·낮음 사유)를 "평가단위"(상병+방향) 단위로 묶어
// 동일 패턴을 하나의 그룹으로 다루기 위한 순수 함수 모음. 저장되는 상태는 없고
// 항상 diagnoses 배열로부터 매번 다시 계산한다.

import { resolveDiagnosisModule } from './diagnosisMapping';
import { getStatusText, getReasonText } from '../../modules/knee/utils/calculations';
import { LOW_REASON_OPTIONS } from '../../modules/knee/utils/data';

function normalizeOtherText(value) {
  return String(value || '').trim().replace(/\r\n/g, '\n');
}

// 낮음 사유는 선택한 순서와 무관하게 항상 LOW_REASON_OPTIONS 정의 순서(기타는 항상 맨 뒤)로
// 표시한다 — 그래야 같은 사유 집합이면 그룹 키도 항상 같은 문자열로 만들어지고, 화면에도
// 매번 같은 순서로 보인다.
const REASON_ORDER = LOW_REASON_OPTIONS.map(o => o.value);
function sortReasons(reasons) {
  return Array.from(new Set(reasons)).sort((a, b) => REASON_ORDER.indexOf(a) - REASON_ORDER.indexOf(b));
}

export function assessmentLabel(value) {
  return value === 'high' ? '높음' : value === 'low' ? '낮음' : '-';
}

// knee/calculations.js의 getStatusText("확인"/"미확인")는 "상병 상태(...)"처럼 감싸는
// 문맥에서만 뜻이 분명하다. 그룹 카드 제목·패턴 에디터·문서 헤더처럼 단독으로 나오는
// 곳은 "상병 확인"/"상병 미확인"으로 풀어써야 오해가 없다.
export function statusText(status) {
  return status === 'confirmed' ? '상병 확인' : status === 'unconfirmed' ? '상병 미확인' : '-';
}

// 축성(척추/경추) 진단은 side 값과 무관하게 Right 키를 단일 "평가" 슬롯으로 쓴다
// (기존 AssessmentTab.jsx의 렌더링 규칙과 동일). side='' 비축성 진단은 방향 미선택
// 상태라 평가단위 자체가 없다 — DiagnosisForm에서 방향을 먼저 선택해야 한다.
function unitsForDiagnosis(diag, activeModules) {
  const resolvedModule = resolveDiagnosisModule(diag, activeModules);
  const moduleId = resolvedModule?.moduleId ?? null;
  const isAxial = moduleId === 'spine' || moduleId === 'cervical';

  if (isAxial) {
    return [{
      id: `${diag.id}:axial`, diagId: diag.id, side: 'axial', moduleId,
      confirmedKey: 'confirmedRight', assessmentKey: 'assessmentRight',
      reasonKey: 'reasonRight', reasonOtherKey: 'reasonRightOther',
    }];
  }

  const units = [];
  if (diag.side === 'right' || diag.side === 'both') {
    units.push({
      id: `${diag.id}:right`, diagId: diag.id, side: 'right', moduleId,
      confirmedKey: 'confirmedRight', assessmentKey: 'assessmentRight',
      reasonKey: 'reasonRight', reasonOtherKey: 'reasonRightOther',
    });
  }
  if (diag.side === 'left' || diag.side === 'both') {
    units.push({
      id: `${diag.id}:left`, diagId: diag.id, side: 'left', moduleId,
      confirmedKey: 'confirmedLeft', assessmentKey: 'assessmentLeft',
      reasonKey: 'reasonLeft', reasonOtherKey: 'reasonLeftOther',
    });
  }
  return units;
}

export function buildAssessmentUnits(diagnoses, activeModules = []) {
  const units = [];
  (diagnoses || []).forEach((diag, diagIndex) => {
    unitsForDiagnosis(diag, activeModules).forEach(unit => {
      units.push({ ...unit, diagIndex });
    });
  });
  return units;
}

// 비축성 진단 중 방향(우/좌/양측)을 아직 선택하지 않은 것 — unitsForDiagnosis가 평가단위를
// 0개 생성하므로 buildAssessmentGroups의 groups/incomplete 어디에도 잡히지 않는다. 그룹
// 화면과 그룹 형식 출력(formatGroupedAssessment) 양쪽에서 똑같이 찾아내 쓸 수 있도록 단일
// 함수로 둔다 — 화면 표시용 판정과 출력용 판정이 따로 놀면(중복 구현) 둘이 어긋나기 쉽다.
export function findUnassignedSideDiagnoses(diagnoses, activeModules = []) {
  return (diagnoses || [])
    .map((diag, index) => ({ diag, index }))
    .filter(({ diag }) => {
      if (!(diag.code || diag.name) || diag.side) return false;
      const moduleId = resolveDiagnosisModule(diag, activeModules)?.moduleId;
      return moduleId !== 'spine' && moduleId !== 'cervical';
    });
}

// null = 평가단위가 미완료(조치 필요) 상태라는 뜻 — 그룹 키가 아니라 판정 결과다.
export function patternKeyOf(diag, unit) {
  const confirmed = diag[unit.confirmedKey];
  const assessment = diag[unit.assessmentKey];
  if (!confirmed || !assessment) return null;

  if (assessment === 'low') {
    const reasons = diag[unit.reasonKey] || [];
    if (!reasons.length) return null;
    const sortedReasons = sortReasons(reasons);
    const other = sortedReasons.includes('other') ? normalizeOtherText(diag[unit.reasonOtherKey]) : '';
    return `${confirmed}|${assessment}|${sortedReasons.join(',')}|${other}`;
  }
  return `${confirmed}|${assessment}|`;
}

export function isUnitComplete(diag, unit) {
  return patternKeyOf(diag, unit) !== null;
}

export function buildAssessmentGroups(diagnoses, activeModules = []) {
  const byId = new Map((diagnoses || []).map(diag => [diag.id, diag]));
  const units = buildAssessmentUnits(diagnoses, activeModules);
  const unassignedSideDiagnoses = findUnassignedSideDiagnoses(diagnoses, activeModules);
  const incomplete = [];
  const groupMap = new Map();
  const groupOrder = [];

  units.forEach(unit => {
    const diag = byId.get(unit.diagId);
    const key = patternKeyOf(diag, unit);
    if (key === null) {
      incomplete.push(unit);
      return;
    }
    if (!groupMap.has(key)) {
      const confirmed = diag[unit.confirmedKey];
      const assessment = diag[unit.assessmentKey];
      const meta = { confirmed, assessment, reasons: [], other: '' };
      if (assessment === 'low') {
        meta.reasons = sortReasons(diag[unit.reasonKey] || []);
        meta.other = meta.reasons.includes('other') ? normalizeOtherText(diag[unit.reasonOtherKey]) : '';
      }
      groupMap.set(key, { key, meta, units: [] });
      groupOrder.push(key);
    }
    groupMap.get(key).units.push(unit);
  });

  const groups = groupOrder.map(key => groupMap.get(key));
  groups.sort((a, b) => {
    if (b.units.length !== a.units.length) return b.units.length - a.units.length;
    const firstIndex = group => Math.min(...group.units.map(u => u.diagIndex));
    return firstIndex(a) - firstIndex(b);
  });

  return {
    byId,
    units,
    incomplete,
    unassignedSideDiagnoses,
    groups,
    stats: {
      diagnosisCount: (diagnoses || []).filter(d => d.code || d.name).length,
      unitCount: units.length,
      groupCount: groups.length,
      // 방향 미선택 진단은 평가단위가 0개라 incomplete 배열엔 안 잡히지만, 여전히
      // "조치가 필요한" 항목이므로 미완료 수치에 합산한다(화면 요약과 실제 카드 수가
      // 어긋나지 않도록).
      incompleteCount: incomplete.length + unassignedSideDiagnoses.length,
    },
  };
}

// 우/좌 평가단위가 같은 그룹(또는 같은 units 배열)에 함께 있으면 표시상 "#N(양측)"으로
// 합친다. 그 외에는 개별 단위마다 "#N(우)" / "#N(좌)" / "#N(평가)"로 표기한다. sideLabel은
// 같은 방향을 풀네임(우측/좌측/양측/평가)으로 담아 문서 출력(formatAssessmentTargetLines)에서
// 쓴다 — label은 화면 칩처럼 압축된 표기가 필요한 곳 전용.
// byId는 호환을 위해 인자로 남겨두지만 diagIndex는 diag가 아니라 unit에 실려 있어서
// 실제로는 사용하지 않는다.
export function mergeDisplayTags(units, byId) { // eslint-disable-line no-unused-vars
  const byDiag = new Map();
  const order = [];
  units.forEach(unit => {
    if (!byDiag.has(unit.diagId)) {
      byDiag.set(unit.diagId, []);
      order.push(unit.diagId);
    }
    byDiag.get(unit.diagId).push(unit);
  });

  const tags = order.map(diagId => {
    const diagUnits = byDiag.get(diagId);
    const index = diagUnits[0].diagIndex;
    const label = index + 1;
    if (diagUnits.length === 2) {
      return { label: `#${label}(양측)`, sideLabel: '양측', unitIds: diagUnits.map(u => u.id), diagId, both: true, index };
    }
    const unit = diagUnits[0];
    const suffix = unit.side === 'right' ? '우' : unit.side === 'left' ? '좌' : '평가';
    const sideLabel = unit.side === 'right' ? '우측' : unit.side === 'left' ? '좌측' : '평가';
    return { label: `#${label}(${suffix})`, sideLabel, unitIds: [unit.id], diagId, both: false, index };
  });

  tags.sort((a, b) => a.index - b.index);
  return tags;
}

// formatGroupedAssessment용 — "#N 코드 상병명 (방향)"을 상병 1건당 한 줄씩 사람이 읽기
// 편한 형태로 나열한다. entries는 { diagId, index, sideLabel } 모양(mergeDisplayTags의
// 반환값 또는 방향 미선택 항목)이면 된다. 척추/경추처럼 방향 개념이 없는 "평가" 항목은
// 굳이 "(평가)"를 붙이지 않는다 — 우측/좌측/양측과 달리 실제 방향 정보가 아니라서
// 옆에 있으면 오히려 헷갈린다.
function formatAssessmentTargetLines(entries, byId) {
  return entries.map(entry => {
    const diag = byId.get(entry.diagId);
    const name = `${diag?.code || ''} ${diag?.name || ''}`.trim();
    const suffix = entry.sideLabel === '평가' ? '' : ` (${entry.sideLabel})`;
    return `#${entry.index + 1}. ${name}${suffix}`;
  }).join('\n');
}

function cloneDiagnoses(diagnoses) {
  return diagnoses.map(diag => ({ ...diag }));
}

// units에 patch(confirmed/assessment/reasons/other)를 일괄 적용한 새 배열과, 되돌리기 위한
// undoPatch(적용 전 필드 값)를 함께 반환한다. diagnoses 원본은 변경하지 않는다.
export function applyPatternToUnits(diagnoses, units, patch) {
  const touchedIds = new Set(units.map(u => u.diagId));
  const next = diagnoses.map(diag => (touchedIds.has(diag.id) ? { ...diag } : diag));
  const nextById = new Map(next.map(diag => [diag.id, diag]));
  const prevByDiag = new Map();

  units.forEach(unit => {
    const diag = nextById.get(unit.diagId);
    if (!prevByDiag.has(unit.diagId)) prevByDiag.set(unit.diagId, {});
    const prevFields = prevByDiag.get(unit.diagId);
    prevFields[unit.confirmedKey] = diag[unit.confirmedKey];
    prevFields[unit.assessmentKey] = diag[unit.assessmentKey];
    prevFields[unit.reasonKey] = diag[unit.reasonKey];
    prevFields[unit.reasonOtherKey] = diag[unit.reasonOtherKey];

    diag[unit.confirmedKey] = patch.confirmed;
    diag[unit.assessmentKey] = patch.assessment;
    // 높음으로 바꿀 때 과거 낮음 사유는 지우지 않는다(단건 편집과 동일) — 출력·그룹
    // 판정에서만 무시된다.
    if (patch.assessment === 'low') {
      diag[unit.reasonKey] = (patch.reasons || []).slice();
      if ((patch.reasons || []).includes('other')) {
        diag[unit.reasonOtherKey] = patch.other || '';
      }
    }
  });

  const undoPatch = Array.from(prevByDiag.entries()).map(([diagId, prevFields]) => ({ diagId, prevFields }));
  return { next: cloneDiagnoses(next), undoPatch };
}

export function revertPatch(diagnoses, undoPatch) {
  if (!undoPatch || !undoPatch.length) return diagnoses;
  const prevById = new Map(undoPatch.map(p => [p.diagId, p.prevFields]));
  return diagnoses.map(diag => {
    const prevFields = prevById.get(diag.id);
    return prevFields ? { ...diag, ...prevFields } : diag;
  });
}

// 개별(비그룹) 형식 문구를 진단별 블록 배열로 반환한다. 코드·이름이 모두 없는 진단은
// 건너뛴다. reasonIndent는 "낮음 사유" 불릿 목록의 들여쓰기만 바꾸고(호출부마다
// 2칸/4칸으로 다름), 상태 줄("우측:"/"좌측:"/"평가:")의 들여쓰기는 항상 2칸으로 고정이다
// — 기존 reportGenerator.js·exportService.js 두 구현의 실제 출력을 그대로 재현하기 위함.
export function buildAssessmentBlocks(diagnoses, activeModules = [], { reasonIndent = '  ' } = {}) {
  const blocks = [];
  (diagnoses || []).forEach((diag, index) => {
    if (!(diag.code || diag.name)) return;
    const resolvedModule = resolveDiagnosisModule(diag, activeModules);
    const isAxial = resolvedModule?.moduleId === 'spine' || resolvedModule?.moduleId === 'cervical';
    let block = `#${index + 1}: ${diag.code || ''} ${diag.name || ''}`.trimEnd();

    function appendSide(label, confirmedValue, assessmentValue, reasons, other) {
      block += `\n  ${label}: 상병 상태(${getStatusText(confirmedValue)}) / 업무관련성(${assessmentLabel(assessmentValue)})`;
      if (assessmentValue === 'low') {
        const reasonText = getReasonText(reasons || [], other).split('\n').join(`\n${reasonIndent}- `);
        block += `\n${reasonIndent}낮음 사유:\n${reasonIndent}- ${reasonText}`;
      }
    }

    if (isAxial) {
      appendSide('평가', diag.confirmedRight, diag.assessmentRight, diag.reasonRight, diag.reasonRightOther);
      blocks.push(block);
      return;
    }
    if (diag.side === 'right' || diag.side === 'both') {
      appendSide('우측', diag.confirmedRight, diag.assessmentRight, diag.reasonRight, diag.reasonRightOther);
    }
    if (diag.side === 'left' || diag.side === 'both') {
      appendSide('좌측', diag.confirmedLeft, diag.assessmentLeft, diag.reasonLeft, diag.reasonLeftOther);
    }
    blocks.push(block);
  });
  return blocks;
}

// 그룹(패턴) 형식 문구 — 미완료는 맨 뒤에 붙인다(그룹 화면 UI는 반대로 미완료를 맨
// 앞에 두지만, 문서 출력은 완료된 평가 결과를 먼저 읽히는 편이 자연스럽다).
export function formatGroupedAssessment(diagnoses, activeModules = []) {
  const info = buildAssessmentGroups(diagnoses, activeModules);
  const sections = info.groups.map(group => {
    const targetLines = formatAssessmentTargetLines(mergeDisplayTags(group.units, info.byId), info.byId);
    let section = `[${statusText(group.meta.confirmed)} · 업무관련성 ${assessmentLabel(group.meta.assessment)}] ${group.units.length}개`;
    section += `\n${targetLines}`;
    if (group.meta.assessment === 'low') {
      // 사유를 한 줄에 쉼표로 몰아 쓰지 않고 항목당 한 줄씩 불릿으로 — 사람이 읽는 최종
      // 문서(EMR 종합소견)이므로 buildAssessmentBlocks의 개별 형식과 같은 방식으로 맞춘다.
      const reasonLines = getReasonText(group.meta.reasons, group.meta.other).split('\n').map(r => `  - ${r}`).join('\n');
      section += `\n낮음 사유:\n${reasonLines}`;
    }
    return section;
  });

  const incompleteEntries = [
    ...mergeDisplayTags(info.incomplete, info.byId),
    ...info.unassignedSideDiagnoses.map(({ diag, index }) => ({ diagId: diag.id, index, sideLabel: '방향 미선택' })),
  ].sort((a, b) => a.index - b.index);

  if (incompleteEntries.length) {
    // 헤더 개수는 완료 그룹 섹션과 동일하게 "평가단위" 기준(양측 미완료 1건 = 2개)을
    // 쓰고, 목록만 mergeDisplayTags로 병합된 대상(우/좌 합쳐 #N(양측) 한 줄)을 쓴다.
    // incompleteEntries.length(줄 수)를 그대로 쓰면 양측 모두 미완료인 상병이
    // 1개로 축소 표시된다.
    const targetLines = formatAssessmentTargetLines(incompleteEntries, info.byId);
    sections.push(`[미입력/검토 필요] ${info.stats.incompleteCount}개\n${targetLines}`);
  }

  return sections.join('\n\n');
}
