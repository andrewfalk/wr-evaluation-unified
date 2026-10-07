// 히스토그램 가로축 경계 라벨 배치 — 순수 함수. 라벨 "개수"가 아니라 각 라벨이 실제로 차지하는
// 좌우 범위로 겹침을 판정한다(긴 라벨 12개는 실제 Chromium에서도 겹쳤다).
//
// - 위치는 균등 간격을 가정하지 않고 렌더링에 쓰는 실제 경계 좌표(positions[i] = xScale(edges[i]))를
//   입력으로 받는다. 서버 폴백 경계는 부동소수점 반올림 때문에 간격이 같지 않을 수 있다.
// - 각 라벨의 정렬(start/middle/end)을 먼저 확정하고, 확정된 정렬의 범위로 겹침을 판정한다. 마지막
//   라벨을 end로 바꾼 뒤에 간격을 계산하지 않으면 겹침이 다시 생긴다.
// - 겹침 금지는 예외가 없다. 어떤 간격으로도 첫·마지막 라벨이 함께 들어가지 않는 극단이면 첫 라벨
//   하나만 표시한다(나머지는 툴팁과 "데이터 보기" 표로 확인).

const DEFAULT_CHAR_WIDTH = 6.5; // 10px 축 라벨의 숫자·쉼표·점을 넉넉히 덮는 평균 폭(px)
const DEFAULT_GAP = 8;

/**
 * @param {object} params
 * @param {number[]} params.positions  경계별 x 좌표(px, 플롯 안쪽 기준 — 첫 경계가 0)
 * @param {string[]} params.labels     경계별 라벨 문자열
 * @param {number} params.innerWidth   플롯 안쪽 가로 폭(px)
 * @param {number} params.marginLeft   왼쪽 여백(px) — 이만큼은 라벨이 튀어나와도 잘리지 않는다
 * @param {number} params.marginRight  오른쪽 여백(px)
 * @returns {Array<{ index: number, anchor: 'start' | 'middle' | 'end' }>}
 */
export function chooseEdgeLabels({
  positions, labels, innerWidth, marginLeft, marginRight, charWidth = DEFAULT_CHAR_WIDTH, gap = DEFAULT_GAP,
}) {
  const n = labels.length;
  if (n === 0) return [];
  const last = n - 1;

  const widthOf = (i) => labels[i].length * charWidth;
  const anchorOf = (i) => {
    const x = positions[i];
    const w = widthOf(i);
    if (x + w / 2 > innerWidth + marginRight) return 'end';
    if (x - w / 2 < -marginLeft) return 'start';
    return 'middle';
  };
  const rangeOf = ({ index, anchor }) => {
    const x = positions[index];
    const w = widthOf(index);
    if (anchor === 'end') return [x - w, x];
    if (anchor === 'start') return [x, x + w];
    return [x - w / 2, x + w / 2];
  };
  const conflict = (a, b) => rangeOf(b)[0] - rangeOf(a)[1] < gap;
  const allClear = (sel) => {
    for (let j = 1; j < sel.length; j += 1) if (conflict(sel[j - 1], sel[j])) return false;
    return true;
  };

  if (n === 1) return [{ index: 0, anchor: anchorOf(0) }];

  for (let stride = 1; stride <= last; stride += 1) {
    const indices = [];
    for (let i = 0; i <= last; i += stride) indices.push(i);
    if (indices[indices.length - 1] !== last) indices.push(last);
    const selected = indices.map((index) => ({ index, anchor: anchorOf(index) }));
    // 마지막 라벨은 항상 둔다. 바로 앞 정규 라벨이 (정렬 확정 후) 겹치면 그 정규 라벨을 뺀다(첫 라벨 제외).
    while (selected.length >= 3 && conflict(selected[selected.length - 2], selected[selected.length - 1])) {
      selected.splice(selected.length - 2, 1);
    }
    if (allClear(selected)) return selected;
  }
  return [{ index: 0, anchor: 'start' }];
}
