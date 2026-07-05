# 6.0-15 det 빈도 감소 실측 보고서 — dev RTX 4060 (B안 1순위)

측정일 2026-07-05. 계획·설계는 `VIDEO_ANALYSIS_IMPLEMENTATION_PLAN.md` 6.0-15 항목 참조.
구현: det를 N샘플프레임당 1회(`detIntervalSec`, 초 단위 — 프로필 fps 5/12/20 적응), 사이(carry)
프레임은 직전 pose 키포인트 역산 확장 박스를 pose 입력으로 재사용 + trackId 매칭 없이 상속.
score/hand-subset/sanity gate 위반 시 다음 프레임 det 강제. **기본 off(0)** — opt-in 롤아웃(6.0-14식).

## 환경

- 6.0-13과 동일: RTX 4060 Laptop 8GB, ORT-GPU 1.26 + cuDNN 9.10.2, rtmlib 0.0.15, Python 3.14 venv.
- 하네스: `services/pose-inference/compare_det_interval.py` — 같은 클립을 interval off/on 2회 추론,
  keypoints·각도·트랙·feature·target 매핑(±500ms·IoU 0.3, `mapTargetTrack` 재현)·dominant 비교.
- 결과 원본: 세션 scratchpad `ab_*` 디렉터리(`compare_result.json`) — 수치는 본 문서에 전사.

### 측정 클립 (실작업 손목 클립 부재 — 대체 근거)

dev 라이브 검증에 쓴 손목 원본은 privacy_first 정책으로 삭제(artifacts만 잔존), 6.0-14의 유로폼
실작업영상도 미보유 → **대체 클립**으로 측정. B2 게이트에서 실작업 영상으로 재확인 필요.

| 클립 | 내용 | fps | 성격 |
|---|---|---|---|
| pitching01.mp4 (4s·121f) | 투수 1인, 빠른 팔·다리 스윙 | 29.97 | **통제 시나리오**(1인) + carry 최악 케이스(고속 사지) |
| pitching75.mp4 (76.7s·2,299f) | 위를 19회 연결(합성) | 29.97 | **진단 규모 재현**(손목 75s 클립=2,263f과 동급). 4s마다 위치 점프 = sanity guard 의도 검증 |
| samples/people-detection.mp4 (50s·596f) | 거리 보행자 ~10인 출입 | 12 | **비통제 스트레스**(전제 위반 케이스) |

29.97fps 원본 + `--fps 20` 요청 = `step=round(1.4985)=1` → **전 프레임 처리**(손목 진단 조건 재현).
interval 1초 → `N=floor(1.0×29.97)=29`(floor — round면 N=30=1001ms로 target 매핑 ±500ms 창 이탈).

## 회귀 0 증명 (기본 off)

main 구버전 infer_clip vs 본 구현(interval 미설정), people-detection.mp4 596프레임 CPU 실추론:
**keypoints.json diff 0**(bbox·trackId·preprocessConfigHash 포함) + **clip_features.json diff 0**
(featureConfigVersion 불변 — feature_config version bump 없음, detection 블록은 전처리 파라미터로
version과 무관하다는 원칙). 활성 시에만 해시에 `detInterval`(config와 동일 필드명) 추가.

## A/B 실측 — 통제 시나리오(1인), wholebody, interval 1s

| 지표 | 4s CPU | 76.7s CPU | 76.7s GPU(auto) |
|---|---|---|---|
| e2e off→on | 9.3→4.7s (**1.98×**) | 201→90.7s (**2.22×**) | 114.9→68.6s (**1.68×**) |
| det 실행 off→on | 121→5 | 2,299→101 | 2,299→101 |
| 강제 det(스케줄 외) | 0 | 21 (≈루프 경계 18회 — sanity guard 의도 동작) | 21 |
| trackId 스왑/초과 신규발급 | **0 / 0** | **0 / 0** | **0 / 0** |
| target 매핑(중간 지점 최악 포함) | **10/10 동일** | **40/40 동일** | **40/40 동일** |
| 키포인트 편차(bbox 대각 %) p50/p95 | 0.50/3.94 | 0.51/4.24 | 0.51/4.02 |
| hand conf 변화 | +1.6%(개선) | +1.8%(개선) | +1.7%(개선) |
| 손목 kp loss 프레임 off→on | 1→0 | **44→12(개선)** | 44→12 |

- **손목 클립 목표 달성**: 진단(2분+ → 40초–1분) 대비 CPU 90.7s·GPU 68.6s. 현행 운영(CPU·매 프레임
  det) 201s 기준 **GPU+interval 조합 시 2.9×**. 남은 지배 비용은 pose(GPU 12ms×2,299≈28s)와 디코드.
- **carry가 오히려 개선시키는 지표**: 역산 박스는 대상 중심 crop이라 hand conf·손목 loss가 매 프레임
  det 박스보다 안정적(44→12 프레임).
- 각도 시계열: 무릎 p95 3.4–6.0°, 팔꿈치 p50 2.4–2.6°. 팔꿈치 p95 20–48°는 투구 최고속 구간
  단발 프레임(crop 차이가 극단 동작에서 증폭) — posture 비율 피처에는 비전파(아래 feature 표).

### feature 비교 (76.7s, dominant 경로)

| feature | off | on | Δ | 판정 |
|---|---|---|---|---|
| squatDuration(ratio) | 0.075 | 0.084 | +0.009 | posture 비율 — 안정 |
| overheadHours(ratio) | 0.217 | 0.200 | −0.017 | 〃 |
| neckFlexion/trunkFlexion(ratio) | 0.267/0.158 | 0.269/0.160 | +0.002 | 〃 |
| trunkPostureG(peak°) | 60.5 | 62.7 | +2.2 | 〃 |
| shoulderRepetitionRate | 22.5 | 22.7 | +0.2 | 안정 |
| elbow/wristRepetitionRate | 29.97 | 22.7 | **−7.3** | 반복 계열 — 민감(아래) |
| wristFlexion/DeviationPeak(°) | 67.8 | 74.9 | **+7.2** | peak 계열 — 민감 |

**반복·peak 계열 해석**: off 29.97 cycles/min은 이 클립의 투구 스윙+지터 half-swing이 섞인 값.
carry의 안정 crop이 지터 half-swing을 제거해 22.7로 내려간 것(아래 step 실측에서 15fps 처리도
동일하게 22.5 산출 — off 값이 전프레임 지터를 세고 있었다는 방증). 방향은 "과대 계수 완화"로
보이나 **어느 쪽이 참값인지는 이 합성 클립으로 판정 불가** — 반복·peak 피처는 전부 candidate
모드(자동 입력 없음, 수기 확인)이고, 정답 라벨 검증은 6.0-B2 게이트 소관.

## A/B 실측 — 비통제 스트레스(전제 위반), body, people-detection.mp4

10인 출입·소형 인물 다수: e2e 16.2→11.0s(1.47×), det 596→383(**강제 333** — score/sanity gate가
계속 발화해 사실상 매 1.5프레임 det). 스왑 카운터 65, dominant 불일치(t2↔t3). target 매핑은 18/18
동일. → **촬영 통제(1–2인) 전제가 깨지면 이득이 급감하고 트랙 안정성도 저하** — 전제의 실측 근거.
운영 활성은 촬영 프로토콜 준수 클립에 한정(어차피 서버 전역 env라 프로토콜 정착 후 활성 권고).

## 별도 항목 — step 반올림 수치 (행동 변경 없음, 6.0-15 스코프 밖)

20fps 요청이 29.97fps 원본에서 step=1(전 프레임)로 처리되는 1.5× 낭비 건. `--fps 15`(step=2,
eff 14.985fps)로 동일 클립 재실측(GPU·interval off):

- e2e 114.9→51.8s(프레임 반감 그대로), posture 비율 Δ≤0.017, peak 각도 Δ0.
- **반복수: elbow/wrist 29.97→22.48(−25%), shoulder 22.48→14.99(−33%)** — wrist
  `minFpsForReliableRate=15` 경계에서 Nyquist 민감도 실재 확인.
- 결론: step 내림(=샘플 fps 하향) 채택은 반복수 산출에 실질 영향 → **6.0-B2 정답 라벨 검증과 함께
  별도 결정**(수치만 확보, 코드 무변경 유지).

## 마진 스윕 (bboxMarginRatio, 4s CPU)

| margin | 강제 det | kp편차 p95(diag%) | hand conf | 손목 loss | target/스왑 |
|---|---|---|---|---|---|
| 0.10 | 0 | 2.64 | +0.7% | 1→1 | 0 fail / 0 |
| **0.15(채택)** | 0 | 3.94 | +1.6% | **1→0** | 0 fail / 0 |
| 0.20 | 0 | 5.25 | +1.6% | 1→0 | 0 fail / 0 |

세 값 모두 gate 통과. 0.15가 손목 loss 개선과 키포인트 편차의 균형점 — 기본값 유지.

## 한계·주의

- **carry 프레임 열화는 사후 복구 불가**(gate는 다음 프레임 det만 강제) — 본질적 비용. 이번 실측에선
  연속 실패 없이 강제 det 21회(전부 합성 루프 경계)로 수용 범위였으나, 실작업 영상 재확인은 B2에서.
- 합성 76.7s 클립의 dominant 불일치(t14↔t1)는 4s마다 위치 점프하는 합성 구조의 산물(off는 경계마다
  트랙 단절, on은 일부 구간 carry 유지) — 실제 단일 연속 촬영에선 4s 클립처럼 dominant 동일 확인됨.
- 신규 인물 진입은 다음 det까지 미탐지(≤1s) — 촬영 통제 전제로 수용.
- 반복·peak 계열 candidate 피처의 참값 판정은 이 측정으로 불가 — B2 gold 라벨 검증이 게이트.

## 결론·권고

1. **dev-stack 기본 활성(1초) 채택** — 통제 시나리오 gate 전부 통과(스왑 0, target 매핑 50/50,
   posture 피처 안정, 손목 지표 개선, CPU 2.2×/GPU 1.7×). `dev-intranet-server.ps1` 기본
   `VIDEO_DET_INTERVAL_SEC=1` 반영(.env로 0 가능).
2. **운영 서버**: 기본 off 유지. 활성은 §14-4-2 배포 게이트에서 B2 결과·촬영 프로토콜 정착과 함께 결정.
3. 서버 env는 [0, 1.0] 강제(fail-fast) — 1초 초과는 target 매핑 ±500ms 창 이탈 위험.
4. 반복수 참값 논쟁(off 지터 과대계수 vs on 과소계수)과 step 반올림 보정은 **6.0-B2로 이관**.
