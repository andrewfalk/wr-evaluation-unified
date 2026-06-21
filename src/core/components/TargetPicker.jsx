// 대상자 선택 캔버스 (6.0-6b, PR D2b, §8.7). 기본은 원본 프레임 없이 person box 후보만 중립 캔버스에
// 그려 클릭으로 대상자를 고른다(privacy_first — 얼굴·작업장 미노출). bbox는 xywh 픽셀(sample-detect 계약).
// 정책 예외(VIDEO_ANALYSIS_TARGET_THUMBNAIL): frameUrl 주어지면 대표 프레임 썸네일을 배경으로 깔아
// 어느 박스가 실제 작업자인지 식별 가능(동의+인트라넷 전제). frameUrl 없으면 기존 중립 배경.
import { memo } from 'react';

// 후보 bbox(원본 프레임 좌표)를 표시 박스로 스케일 — 순수 함수(테스트 대상).
export function scaledCandidates(result, maxWidth = 360) {
  if (!result || !result.frameWidth) return { width: 0, height: 0, scale: 1, boxes: [] };
  const scale = maxWidth / result.frameWidth;
  const boxes = (result.persons || []).map((p) => {
    const [x, y, w, h] = p.bbox;
    return { id: p.id, x: x * scale, y: y * scale, w: w * scale, h: h * scale };
  });
  return { width: maxWidth, height: (result.frameHeight || 0) * scale, scale, boxes };
}

function TargetPickerImpl({ result, selectedId, onSelect, frameUrl = null }) {
  if (!result) return null;
  // 네이티브 프레임 좌표로 그리고(viewBox), 표시 크기는 CSS(.va-media-box 4:3)가 결정 → 세로 영상도 안 길어짐.
  const W = result.frameWidth;
  const H = result.frameHeight || Math.round(W * 0.75);
  const { boxes } = scaledCandidates(result, W); // scale=1 → 네이티브 좌표
  const sw = Math.max(2, W / 200);  // 표시 스케일 무관하게 선 굵기 유지(프레임 폭 비례)
  const fs = Math.max(12, W / 28);
  return (
    <div>
      <div className="va-media-box">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="group" aria-label="대상자 선택">
          {/* 정책 예외: 대표 프레임 썸네일 배경(있을 때만). 박스는 동일 좌표로 위에 겹친다. */}
          {frameUrl && <image href={frameUrl} x={0} y={0} width={W} height={H} preserveAspectRatio="none" />}
          {boxes.map((b) => {
            const sel = b.id === selectedId;
            return (
              <g key={b.id} onClick={() => onSelect(b.id)} style={{ cursor: 'pointer' }}>
                <rect x={b.x} y={b.y} width={b.w} height={b.h}
                  fill={sel ? 'rgba(46,125,50,0.35)' : 'rgba(255,255,255,0.06)'}
                  stroke={sel ? '#2e7d32' : '#90caf9'} strokeWidth={sel ? sw * 1.5 : sw} />
                <text x={b.x + fs * 0.3} y={b.y + fs} fill="#fff" fontSize={fs}>{b.id}</text>
              </g>
            );
          })}
        </svg>
      </div>
      {boxes.length === 0 && <p className="muted">탐지된 사람이 없습니다(다른 클립/프레임 확인).</p>}
    </div>
  );
}

export const TargetPicker = memo(TargetPickerImpl);
