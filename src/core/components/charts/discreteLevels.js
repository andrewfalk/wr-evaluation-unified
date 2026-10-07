// 범주형 기술통계 표시용 가공 — 요약 탭 표와 분포 탭 차트가 같은 선택값을 쓰도록 한 곳에서
// 만든다(계획서 §6). 서버 결과는 세 가지 모양이다.
//   - levels: 10명 이상 범주만(공개)
//   - other: 소수 범주(1~9명)와, 합친 값을 10명 이상으로 맞추려고 함께 합친 범주의 합(그 변수
//     하나만 요청했을 때만 서버가 만든다)
//   - rawLevels: stats.export_limited_rows 권한자에게만 오는 원본(소수 범주 포함). 있으면 이걸
//     쓰고 other는 무시한다 — rawLevels에는 "기타"로 합쳐진 범주가 이미 다 들어 있어서 둘을
//     함께 더하면 중복 집계된다.

export const TOP_LEVELS_IN_CHART = 20;
// "기타"는 10명 미만 범주뿐 아니라, 합친 값을 10명 이상으로 맞추려고 서버가 함께 끌어온 공개
// 범주도 포함할 수 있다(statsDescriptiveSuppression.ts planSmallLevelMerge) — 그래서 "10명 미만
// 범주 합계"라고 쓰면 부정확하다.
export const OTHER_LEVEL_LABEL = '기타 (공개 기준에 따라 병합한 범주 합계)';
export const OTHER_LEVEL_CHART_LABEL = '기타(병합한 범주 합계)';

function sumProportion(list) {
  return list.reduce((s, l) => s + l.proportion, 0);
}

// 원본(rawLevels)을 표시할 때의 최빈값 — 서버의 pickMode(statsDescriptiveSuppression.ts)와 같은
// 규칙(가장 큰 건수, 동점이면 순서형은 더 낮은(경한) 등급, 그 외는 값 문자열 사전순)이다.
// row.mode는 "기타"로 합쳐진 공개 범주 기준이라 원본과 다를 수 있다(예: 한 사람이 반복 기록해
// 소수 범주의 건수가 공개 범주보다 큰 경우). 순서형 rawLevels는 서버가 이미 심각도 순으로
// 정렬해 보내므로 동점이면 첫 항목이 가장 낮은 등급이다.
export function pickModeFromLevels(levels, isOrdinal) {
  if (!levels || levels.length === 0) return null;
  const maxCount = Math.max(...levels.map((l) => l.count));
  const tied = levels.filter((l) => l.count === maxCount);
  if (tied.length === 1 || isOrdinal) return tied[0].level;
  return [...tied].sort((a, b) => String(a.level).localeCompare(String(b.level)))[0].level;
}

/**
 * @returns {{
 *   isRaw: boolean,
 *   hasOther: boolean,
 *   tableRows: Array<{ key: string, label: string, count: number, proportion: number, merged: boolean }>,
 *   chartRows: Array<{ key: string, label: string, count: number, proportion: number, merged: boolean }>,
 * }}
 */
export function buildDiscreteDisplay({ levels, other, rawLevels, isOrdinal }) {
  const isRaw = Array.isArray(rawLevels);
  const shown = isRaw ? rawLevels : (levels ?? []);
  const effectiveOther = isRaw ? null : (other ?? null);

  const toRow = (l, i) => ({
    key: `level-${i}`,
    label: String(l.level),
    count: l.count,
    proportion: l.proportion,
    merged: false,
  });

  const tableRows = shown.map(toRow);
  if (effectiveOther) {
    tableRows.push({
      key: 'other', label: OTHER_LEVEL_LABEL, count: effectiveOther.count, proportion: effectiveOther.proportion, merged: true,
    });
  }

  // 원본일 때만 값이 있다 — 공개 결과는 서버가 계산한 row.mode를 그대로 쓴다.
  const rawMode = isRaw ? pickModeFromLevels(rawLevels, isOrdinal) : undefined;

  // 순서형은 등급 순서가 의미이므로 정렬·자르기 없이 서버 순서 그대로 그린다.
  if (isOrdinal) {
    return { isRaw, hasOther: !!effectiveOther, tableRows, chartRows: tableRows, rawMode };
  }

  // 명목형은 건수가 많은 순(동률은 서버 순서 유지 — 안정 정렬)으로 상위 N개만 그리고,
  // 나머지(상위 밖 범주 + 서버가 합친 "기타")는 막대 하나로 합친다.
  const ranked = shown.map((l, i) => ({ l, i }))
    .sort((a, b) => (b.l.count - a.l.count) || (a.i - b.i));
  const top = ranked.slice(0, TOP_LEVELS_IN_CHART).map(({ l, i }) => toRow(l, i));
  const rest = ranked.slice(TOP_LEVELS_IN_CHART).map(({ l }) => l);

  const chartRows = top;
  if (rest.length > 0 || effectiveOther) {
    const restCount = rest.reduce((s, l) => s + l.count, 0) + (effectiveOther ? effectiveOther.count : 0);
    const restProportion = sumProportion(rest) + (effectiveOther ? effectiveOther.proportion : 0);
    let label;
    if (rest.length > 0) label = `그 외 ${rest.length}개 범주${effectiveOther ? ' + 기타' : ''}`;
    else label = OTHER_LEVEL_CHART_LABEL;
    chartRows.push({ key: 'rest', label, count: restCount, proportion: restProportion, merged: true });
  }
  return { isRaw, hasOther: !!effectiveOther, tableRows, chartRows, rawMode };
}
