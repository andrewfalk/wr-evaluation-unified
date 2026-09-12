import { useState } from 'react';

// PR3-B 계획서 §6.8.5 — 지금까지 각 차트의 hover 정보는 SVG <title>뿐이었다.
// <title>은 마우스 hover에만 반응하고 키보드 포커스로는 절대 안 뜬다(브라우저
// 네이티브 동작) — 마우스를 못 쓰는 키보드 사용자는 그 정보에 접근할 방법이
// 없었다. 이 컴포넌트로 감싼 shape는 (1) tabIndex로 Tab 이동 가능해지고,
// (2) aria-label로 스크린리더가 포커스 시 바로 읽어주고, (3) hover든 focus든
// 실제로 화면에 보이는 말풍선이 뜬다(스크린리더 없이 키보드만 쓰는 저시력
// 사용자도 값을 볼 수 있어야 하므로 aria-label만으로는 부족하다).
//
// children은 이미 배치가 끝난 shape(<rect>/<circle> 등)여야 한다 — 이 컴포넌트는
// 좌표를 계산하지 않고 호출자가 준 anchorX/anchorY(말풍선을 띄울 기준점, 보통
// shape의 중심 위)만 그대로 쓴다. 말풍선 폭은 label 길이로 대략 추정한다(정확한
// 텍스트 측정은 DOM 시점이 아니면 불가능하고, 툴팁 용도로는 여유 있게 잡는 것으로
// 충분하다).

// 코드리뷰 수정(2026-09-12) — 처음엔 말풍선을 항상 anchor 위쪽에만 그렸다. 차트
// 맨 위 근처의 요소(히스토그램 최고 막대, 누적막대 첫 행, 히트맵 첫 행 등)에서는
// 말풍선이 SVG viewBox 상단 밖(y<0)으로 나가 잘렸다(리뷰가 실측: 히스토그램
// 최고 막대는 배경 y=-14, 누적막대 첫 행은 글자 중심 y=-4 — 실제로 뷰 밖).
// 위쪽 여유가 부족하면 아래로 뒤집어야 한다. ChartTooltip 혼자서는 anchor가
// 속한 차트의 margin.top을 모르므로, 호출자가 자신의 margin.top+anchorY로
// 판정한 placement('above'|'below')를 넘겨준다 — 여기서 추측하지 않는다.
export const TOOLTIP_BUBBLE_HEIGHT = 20;
export const TOOLTIP_GAP = 6;
// anchor로부터 말풍선까지 필요한 전체 여유 공간(위쪽에 그릴 때 기준) — 이보다
// margin.top+anchorY가 작으면 위쪽에 그려선 안 된다(잘림).
export const TOOLTIP_CLEARANCE = TOOLTIP_BUBBLE_HEIGHT + TOOLTIP_GAP;

/** 차트 로컬 anchorY(margin 적용 전 <g> 내부 좌표)와 그 차트의 margin.top으로
 * "위쪽에 그리면 SVG viewBox 밖으로 잘리는지"를 판정한다. 각 차트가 자신의
 * margin.top을 알고 있으므로 호출부에서 element마다 이 함수로 placement를
 * 정해 ChartTooltip에 넘긴다(추측 아니라 계산). */
export function chooseTooltipPlacement(localAnchorY, marginTop) {
  return marginTop + localAnchorY < TOOLTIP_CLEARANCE ? 'below' : 'above';
}

export function ChartTooltip({ label, anchorX, anchorY, placement = 'above', children }) {
  const [active, setActive] = useState(false);
  const show = () => setActive(true);
  const hide = () => setActive(false);
  const bubbleWidth = Math.min(280, Math.max(40, label.length * 6 + 16));
  const isBelow = placement === 'below';
  // above: anchor 바로 위(배경 -26~-6, 글자 중심 -12). below: 위아래 대칭으로
  // anchor 바로 아래(배경 6~26, 글자 중심 20).
  const bgY = isBelow ? TOOLTIP_GAP : -TOOLTIP_CLEARANCE;
  const textY = isBelow ? TOOLTIP_GAP + TOOLTIP_BUBBLE_HEIGHT / 2 : -TOOLTIP_GAP - TOOLTIP_BUBBLE_HEIGHT / 2;

  return (
    <g
      tabIndex={0}
      role="img"
      aria-label={label}
      className="chart-tooltip-target"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {active && (
        <g className="chart-tooltip-bubble" transform={`translate(${anchorX},${anchorY})`}>
          <rect x={-bubbleWidth / 2} y={bgY} width={bubbleWidth} height={TOOLTIP_BUBBLE_HEIGHT} rx={4} className="chart-tooltip-bg" />
          <text x={0} y={textY} textAnchor="middle" dominantBaseline="middle" className="chart-tooltip-text">
            {label}
          </text>
        </g>
      )}
    </g>
  );
}
