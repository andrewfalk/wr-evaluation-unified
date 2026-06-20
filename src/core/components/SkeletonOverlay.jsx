// 검수용 골격 overlay (6.0-8, §8.6.1). keypoints artifact(좌표만, 원본 프레임 없음)를 중립 배경 위
// 뼈대로 렌더해 "그 값이 실제 자세에서 맞는지"를 눈으로 검수한다(privacy_first — 얼굴·작업장 미노출).
// overlay payload = { jobId, clipId, targetTrackId, keypoints }(서버가 sha256+계약 검증). 대상 track은
// 밝게, 나머지는 흐리게. TargetPicker의 SVG/순수함수 패턴을 따른다.
import { memo, useState } from 'react';

// COCO17 골격 연결(뼈대). 인덱스는 keypoints 계약(coco17 17점) 기준.
export const COCO17_BONES = [
  [5, 7], [7, 9], [6, 8], [8, 10],       // 양팔(어깨-팔꿈치-손목)
  [5, 6], [5, 11], [6, 12], [11, 12],    // 몸통(어깨/골반 사각)
  [11, 13], [13, 15], [12, 14], [14, 16],// 양다리(골반-무릎-발목)
  [0, 1], [0, 2], [1, 3], [2, 4],        // 얼굴(코-눈-귀)
  [0, 5], [0, 6],                        // 목(코-어깨)
];

const MIN_SCORE = 0.2; // 이 미만 keypoint는 가림/미검출로 보고 점·선 생략.

// keypoints([x,y,score][]) → 표시 좌표로 스케일. normalized면 frame 크기로 환원 후 스케일.
// 순수 함수(테스트 대상). 반환 points의 score는 가시성 판정용으로 보존.
export function scaledKeypoints(keypoints, meta, maxWidth = 360) {
  const fw = meta?.frameWidth || 0;
  const fh = meta?.frameHeight || 0;
  if (!fw || !Array.isArray(keypoints)) return { width: 0, height: 0, scale: 1, points: [] };
  const norm = meta?.coordinateSpace === 'normalized';
  const scale = maxWidth / fw;
  const points = keypoints.map((kp) => {
    const px = norm ? kp[0] * fw : kp[0];
    const py = norm ? kp[1] * fh : kp[1];
    return { x: px * scale, y: py * scale, score: kp[2] };
  });
  return { width: maxWidth, height: fh * scale, scale, points };
}

function PersonSkeleton({ points, target }) {
  const stroke = target ? '#90caf9' : 'rgba(255,255,255,0.18)';
  const fill = target ? '#2e7d32' : 'rgba(255,255,255,0.25)';
  return (
    <g>
      {COCO17_BONES.map(([a, b], i) => {
        const pa = points[a];
        const pb = points[b];
        if (!pa || !pb || pa.score < MIN_SCORE || pb.score < MIN_SCORE) return null;
        return <line key={i} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke={stroke} strokeWidth={target ? 2.5 : 1.5} />;
      })}
      {points.map((p, i) => (p.score < MIN_SCORE ? null : (
        <circle key={i} cx={p.x} cy={p.y} r={target ? 3 : 2} fill={fill} />
      )))}
    </g>
  );
}

function SkeletonOverlayImpl({ overlay, maxWidth = 360 }) {
  const [frameIndex, setFrameIndex] = useState(0);
  const kp = overlay?.keypoints;
  const frames = kp?.frames || [];
  if (!kp || frames.length === 0) return <p className="muted">표시할 골격 프레임이 없습니다.</p>;

  const idx = Math.min(frameIndex, frames.length - 1);
  const frame = frames[idx];
  const meta = { frameWidth: kp.frameWidth, frameHeight: kp.frameHeight, coordinateSpace: kp.coordinateSpace };
  const targetId = overlay.targetTrackId ?? null;
  // 대상 track을 마지막에 그려 위로 오게(흐린 후보 위에 강조).
  const persons = (frame.persons || []).slice().sort((a, b) => {
    const at = a.trackId === targetId ? 1 : 0;
    const bt = b.trackId === targetId ? 1 : 0;
    return at - bt;
  });
  const targetPresent = targetId == null || (frame.persons || []).some((p) => p.trackId === targetId);
  const dims = scaledKeypoints([], meta, maxWidth); // 캔버스 크기만 산출(빈 입력)

  return (
    <div>
      <svg width={dims.width} height={dims.height} role="img" aria-label="검수 골격"
        style={{ background: '#222', border: '1px solid #444', borderRadius: 6 }}>
        {persons.map((person, i) => {
          const s = scaledKeypoints(person.keypoints, meta, maxWidth);
          return <PersonSkeleton key={person.trackId ?? i} points={s.points} target={person.trackId === targetId} />;
        })}
      </svg>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
        <input type="range" min={0} max={frames.length - 1} value={idx}
          onChange={(e) => setFrameIndex(Number(e.target.value))}
          aria-label="프레임 스크럽" style={{ flex: 1 }} />
        <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          {idx + 1}/{frames.length} · {Math.round(frame.timestampMs)}ms
        </span>
      </div>
      {!targetPresent && <p className="muted" style={{ fontSize: 12 }}>이 프레임에 대상자(track)가 없습니다.</p>}
    </div>
  );
}

export const SkeletonOverlay = memo(SkeletonOverlayImpl);
