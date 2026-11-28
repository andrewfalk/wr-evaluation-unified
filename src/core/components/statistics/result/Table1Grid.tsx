// 층화 표(Table 1 — 그룹별 비교) — P2-78c에서 ResultPanel.tsx의 선언을 본문 그대로 옮겼다.
import type { AnalyzeDescriptiveStratifyGroup, AnalyzeDiscreteLevel } from '@wr/contracts/stats';
import type { Table1GroupView, Table1ContinuousView, Table1DiscreteView, StratifiedView, CatalogByKey } from './types';
import { num, variableLabel } from './format';

// Table1 스트라티피케이션 — 행=변수(이산형은 레벨별 행), 열=그룹인 요약표.
// GroupBreakdownTable(그룹 반복)+ContingencyTable(행×열 그리드, 위) 패턴을 결합한다.
// "비공개"(공개 정책상 억제)와 "—"(계산 불가 — 그룹 안에서 변수가 전부 결측)를
// 구분해서 표시한다 — 둘 다 "—"로 뭉뚱그리면 소수셀이라 숨겨진 건지 그냥 데이터가
// 없는 건지 사용자가 구분할 수 없다.
function stratifyGroupLabel(group: AnalyzeDescriptiveStratifyGroup, stratifyByKey: string): string {
  if (group.kind === 'total') return '전체';
  if (group.kind === 'other') return '기타';
  if (group.kind === 'missing') {
    // 파티셔너 자체는 변수 종류를 모르는 일반 로직이라(server/src/stats/dataset/descriptiveStratify.ts),
    // 라벨은 화면 표시 단계에서 stratifyByKey별로 결정한다 — 담당의만 "미배정",
    // 그 외 일반 범주형 변수는 기본값 "결측".
    return stratifyByKey === 'case.staff.assignedDoctorUserId' ? '미배정' : '결측';
  }
  return String(group.level);
}

// 표시명이 겹치는 열을 구분한다 — 담당의 표시명 조회가 실패해 여러 그룹이 전부
// "(알 수 없음)"이 되거나(server/src/stats/disclosure/descriptiveStratifySuppression.ts의 폴백), 이름이
// 같은 담당의가 둘 이상인 정상 조회에서도 열 제목만으로는 서로 다른 그룹임을
// 구분할 수 없다 — groupId/CSV엔 구분값이 있지만 화면엔 없었다(리뷰 지적). 원본
// UUID는 여전히 노출하지 않으면서, 중복된 라벨에만 순번을 붙인다.
function resolveGroupLabels(groups: AnalyzeDescriptiveStratifyGroup[], stratifyByKey: string): string[] {
  const rawLabels = groups.map((g) => stratifyGroupLabel(g, stratifyByKey));
  const totalByLabel = new Map<string, number>();
  for (const label of rawLabels) totalByLabel.set(label, (totalByLabel.get(label) || 0) + 1);
  const seenSoFar = new Map<string, number>();
  return rawLabels.map((label) => {
    if ((totalByLabel.get(label) as number) <= 1) return label;
    const index = (seenSoFar.get(label) || 0) + 1;
    seenSoFar.set(label, index);
    return `${label} ${index}`;
  });
}

// 이산형 변수의 레벨 목록 — 억제되지 않은 모든 그룹의 levels를 합집합으로 모은다.
// (버그 수정) 첫 번째 공개 그룹만 대표로 쓰면, 그 그룹에 없는 레벨(예: A그룹=남성만,
// B그룹=여성만 관측되고 total은 강제 억제된 경우)이 표에서 통째로 누락된다 — total이
// 억제돼도 A/B처럼 다른 그룹에만 있는 레벨은 여전히 공개 대상이므로 반드시 합쳐야 한다.
function resolveDiscreteLevelsForVariable(byGroup: Table1GroupView[], variableKey: string): Array<string | boolean> {
  const seen = new Map<string, string | boolean>(); // `${typeof level}:${String(level)}` -> 원본 level 값(대표 1개)
  for (const g of byGroup) {
    const cell = g.discrete.find((d) => d.variableKey === variableKey);
    if (!cell || cell.suppressed) continue;
    for (const l of cell.levels as AnalyzeDiscreteLevel[]) {
      const key = `${typeof l.level}:${String(l.level)}`;
      if (!seen.has(key)) seen.set(key, l.level);
    }
  }
  return Array.from(seen.values());
}

function Table1ContinuousCellText({ cell }: { cell: Table1ContinuousView | undefined }) {
  if (!cell) return '—';
  if (cell.suppressed) return <span className="swb-suppressed-note" style={{ fontStyle: 'italic' }}>비공개</span>;
  if (cell.mean === null) return '—'; // 계산 불가(그룹 안에서 변수 전부 결측) — 억제와 다른 표시
  return `${num(cell.mean, 2)} ± ${num(cell.sd, 2)} (n=${cell.n})`;
}

function Table1DiscreteCellText({ cell, level }: { cell: Table1DiscreteView | undefined; level: string | boolean | null }) {
  if (!cell) return '—';
  if (cell.suppressed) return <span className="swb-suppressed-note" style={{ fontStyle: 'italic' }}>비공개</span>;
  // 계산 불가(이 그룹에서 변수가 전부 결측 — n=0)와 "이 레벨이 관측 0건"을 구분한다.
  // 구분 안 하면 계산 불가인 셀도 다른 그룹에서 가져온 레벨과 만나 "0 (0.0%)"로
  // 찍혀 실제 값이 0인 것처럼 보인다(버그 수정).
  if (cell.n === 0) return '—';
  if (level === null) return '—';
  const found = (cell.levels as AnalyzeDiscreteLevel[]).find((l) => String(l.level) === String(level));
  return found ? `${found.count} (${(found.proportion * 100).toFixed(1)}%)` : '0 (0.0%)';
}

export function Table1Grid({ stratified, catalogByKey, limitedApplied = false }: { stratified: StratifiedView; catalogByKey: CatalogByKey; limitedApplied?: boolean }) {
  if (stratified.suppressed) {
    return <p className="swb-suppressed-note">공개 정책에 따라 표시되지 않음</p>;
  }
  const { groups, byGroup, stratifyByKey } = stratified as Required<StratifiedView>;
  const byGroupId = new Map(byGroup.map((g) => [g.groupId, g]));
  const total = byGroupId.get('total');
  const continuousKeys = (total?.continuous ?? []).map((c) => c.variableKey);
  const discreteKeys = (total?.discrete ?? []).map((d) => d.variableKey);
  const groupLabels = resolveGroupLabels(groups, stratifyByKey);

  return (
    <div className="swb-card">
      <div className="swb-table-scroll">
        <table className="swb-table" aria-label="Table 1 — 그룹별 비교">
          <thead>
            <tr>
              <th>변수</th>
              {groups.map((g, i) => <th key={g.groupId}>{groupLabels[i]}</th>)}
            </tr>
          </thead>
          <tbody>
            {continuousKeys.length === 0 && discreteKeys.length === 0 && (
              <tr><td colSpan={groups.length + 1}>선택된 변수 없음</td></tr>
            )}
            {continuousKeys.map((key) => (
              <tr key={key}>
                <th>{variableLabel(catalogByKey, key)}</th>
                {groups.map((g) => {
                  const cell = byGroupId.get(g.groupId)?.continuous.find((c) => c.variableKey === key);
                  return <td key={g.groupId}><Table1ContinuousCellText cell={cell} /></td>;
                })}
              </tr>
            ))}
            {discreteKeys.map((key) => {
              const levels = resolveDiscreteLevelsForVariable(byGroup, key);
              const displayLevels = levels.length > 0 ? levels : [null];
              return displayLevels.map((level, i) => (
                <tr key={`${key}-${i}`}>
                  <th>{variableLabel(catalogByKey, key)}{level !== null ? `: ${String(level)}` : ''}</th>
                  {groups.map((g) => {
                    const cell = byGroupId.get(g.groupId)?.discrete.find((d) => d.variableKey === key);
                    return <td key={g.groupId}><Table1DiscreteCellText cell={cell} level={level} /></td>;
                  })}
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 8 }}>
        {!limitedApplied && (
          <span className="swb-suppressed-note"><em>비공개</em> = 공개 정책에 따라 표시되지 않음(소수 인원 보호)</span>
        )}
        <span className="swb-suppressed-note">— = 계산 불가(해당 그룹에서 이 변수의 값이 전부 결측)</span>
      </div>
      {limitedApplied ? (
        <p className="swb-suppressed-note" style={{ marginTop: 8 }}>
          집계 단위는 선택한 사례·직업·상병입니다. 제한데이터 권한으로 소수 인원 보호가 해제되어 모든
          그룹(10명 미만 포함)과 전체 값이 그대로 표시됩니다.
        </p>
      ) : (
        <p className="swb-suppressed-note" style={{ marginTop: 8 }}>
          집계 단위는 선택한 사례·직업·상병이며, 공개 여부는 고유 인원 기준입니다. 그룹
          하나라도 비공개 처리되면 전체 값도 함께 비공개로 전환됩니다 — 전체와 공개된
          그룹만으로 비공개 그룹의 값을 역산하는 것을 막기 위함입니다.
        </p>
      )}
    </div>
  );
}
