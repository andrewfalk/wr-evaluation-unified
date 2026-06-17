"""
결정적 greedy IoU 트래커 (6.0-6b, PR D2a). 프레임별 person bbox detection을 안정적인 trackId로 잇는다.

§8.7: "가장 큰 box" 자동 선택은 엉뚱한 사람을 추적할 위험 → 대상자를 트랙으로 안정 추적해야 한다.
rtmlib PoseTracker(내부 상태·비결정) 대신 **의존성 없는 순수 파이썬 greedy IoU**로 구현 — 동일 입력은
동일 trackId를 내므로 합성 fixture 단위테스트가 쉽다(numpy/cv2 불필요).

매칭 규칙(결정적):
  - 모든 (detection, 활성 track) 쌍의 IoU를 구해 (IoU desc, track id asc, det idx asc)로 정렬 후 greedy 배정.
  - IoU >= iou_threshold 인 미배정 쌍만 매칭. 미매칭 detection → 새 트랙(t1, t2, ... 단조 증가).
  - max_age(샘플 프레임 수) 동안 미매칭 트랙은 은퇴.
"""


def iou(a, b):
    """xyxy 두 박스의 IoU(0~1). 면적 0/음수 방어."""
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)
    iw = max(0.0, ix2 - ix1)
    ih = max(0.0, iy2 - iy1)
    inter = iw * ih
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


class IoUTracker:
    def __init__(self, iou_threshold=0.3, max_age=10):
        self.iou_threshold = iou_threshold
        self.max_age = max_age
        self._tracks = []   # [{ "id": "t1", "bbox": [x1,y1,x2,y2], "age": int }]
        self._next = 1

    def update(self, bboxes):
        """bboxes: [[x1,y1,x2,y2], ...] (xyxy). 입력 순서에 정렬된 trackId 리스트 반환."""
        # 1) 모든 활성 트랙 age 증가(이번 프레임 매칭되면 0으로 리셋).
        for t in self._tracks:
            t["age"] += 1

        n = len(bboxes)
        assigned_det = [None] * n          # det idx -> trackId
        used_track = set()                 # 이번 프레임 매칭된 track id

        # 2) 모든 (det, track) 후보 쌍을 결정적 순서로 greedy 배정.
        pairs = []
        for di, box in enumerate(bboxes):
            for t in self._tracks:
                score = iou(box, t["bbox"])
                if score >= self.iou_threshold:
                    pairs.append((score, t["id"], di))
        # IoU desc, 동률은 track id asc → det idx asc (결정성).
        pairs.sort(key=lambda p: (-p[0], p[1], p[2]))
        for _score, tid, di in pairs:
            if assigned_det[di] is not None or tid in used_track:
                continue
            assigned_det[di] = tid
            used_track.add(tid)

        # 3) 매칭된 트랙 갱신 + 미매칭 detection은 새 트랙.
        by_id = {t["id"]: t for t in self._tracks}
        out = []
        for di, box in enumerate(bboxes):
            tid = assigned_det[di]
            if tid is None:
                tid = "t%d" % self._next
                self._next += 1
                self._tracks.append({"id": tid, "bbox": list(box), "age": 0})
            else:
                tr = by_id[tid]
                tr["bbox"] = list(box)
                tr["age"] = 0
            out.append(tid)

        # 4) 오래 미매칭된 트랙 은퇴.
        self._tracks = [t for t in self._tracks if t["age"] <= self.max_age]
        return out
