"""
키포인트 레이아웃 단일 source (6.0-10).

손목 영상분석은 hand-wrist profile 클립에 한해 wholebody pose(133점: body17+feet6+face68+hand42)를
쓰되, **face·feet는 추출 후 drop**하고 body17+hand42 = 59점만 저장한다(convention "wholebody133-trimmed",
privacy + 손목분석 무용).

이 모듈이 그 trimmed 레이아웃의 **유일한 정의처**다:
  - TRIMMED_SOURCE_INDICES : 원본 wholebody133 배열에서 추출할 원래 인덱스 목록(길이 59) — infer_clip이 슬라이스.
  - WHOLEBODY_TRIMMED_INDEX : 이름 → trimmed(0..58) 인덱스 — feature_calc가 손목 각도 키포인트 접근에 사용.
  - COCO17_INDEX           : 이름 → coco17(0..16) 인덱스 — body convention(기존 feature_config.json과 동일해야 함).

feature_config.json에 wholebody 인덱스를 중복 정의하지 않는다(정적 JSON ↔ 코드 drift 방지). feature_calc가
convention에 따라 이 상수를 직접 참조한다. coco17은 기존 feature_config.json.keypointIndex와 동일성을 테스트로 고정.

원본 COCO-WholeBody133 레이아웃: body 0-16, feet 17-22, face 23-90, left_hand 91-111, right_hand 112-132.
손(21점/한손) 순서(MMPose wholebody): root, thumb1-4, forefinger1-4, middle1-4, ring1-4, pinky1-4.
손가락 MCP = 각 손가락 *1 (예: middle1 = 중지 MCP). 손목 각도는 wrist(body) + {side}_middle1(손 MCP)로 정의.
"""

# --- COCO17 body (원본 wholebody 0..16과 동일) ---
COCO17_NAMES = [
    "nose", "left_eye", "right_eye", "left_ear", "right_ear",
    "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "left_hip", "right_hip",
    "left_knee", "right_knee", "left_ankle", "right_ankle",
]
COCO17_INDEX = {name: i for i, name in enumerate(COCO17_NAMES)}

# --- 한 손(21점) 키포인트 이름(손 내부 순서 0..20) ---
HAND_POINT_NAMES = [
    "hand_root",
    "thumb1", "thumb2", "thumb3", "thumb4",
    "forefinger1", "forefinger2", "forefinger3", "forefinger4",
    "middle1", "middle2", "middle3", "middle4",
    "ring1", "ring2", "ring3", "ring4",
    "pinky1", "pinky2", "pinky3", "pinky4",
]
HAND_KP_COUNT = len(HAND_POINT_NAMES)  # 21

# 원본 wholebody133에서 각 손의 시작 인덱스.
_WHOLEBODY_LEFT_HAND_START = 91
_WHOLEBODY_RIGHT_HAND_START = 112

# --- trimmed(59) 구성: body17(0..16) + left_hand(17..37) + right_hand(38..58) ---
# 원본 인덱스 목록(infer_clip이 wholebody133 배열에서 이 순서로 추출 → 저장 배열은 0..58).
TRIMMED_SOURCE_INDICES = (
    list(range(0, 17))
    + list(range(_WHOLEBODY_LEFT_HAND_START, _WHOLEBODY_LEFT_HAND_START + HAND_KP_COUNT))
    + list(range(_WHOLEBODY_RIGHT_HAND_START, _WHOLEBODY_RIGHT_HAND_START + HAND_KP_COUNT))
)

TRIMMED_KEYPOINT_COUNT = len(TRIMMED_SOURCE_INDICES)  # 59


def _build_trimmed_index():
    idx = dict(COCO17_INDEX)  # body17 → 0..16
    pos = 17
    for side in ("left", "right"):
        for hand_name in HAND_POINT_NAMES:
            idx[f"{side}_{hand_name}"] = pos
            pos += 1
    return idx


# 이름 → trimmed(0..58) 인덱스. 예: left_wrist=9(body), left_middle1=17+9=26, right_middle1=38+9=47.
WHOLEBODY_TRIMMED_INDEX = _build_trimmed_index()

# convention → (이름→인덱스) 맵. feature_calc가 keypointConvention으로 선택.
KEYPOINT_INDEX_BY_CONVENTION = {
    "coco17": COCO17_INDEX,
    "wholebody133-trimmed": WHOLEBODY_TRIMMED_INDEX,
}
