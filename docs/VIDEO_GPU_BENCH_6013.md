# 6.0-13 GPU 실측 0단계 보고서 — dev RTX 4060 (A안 판단용)

측정일 2026-07-04. 계획·범위는 `VIDEO_ANALYSIS_IMPLEMENTATION_PLAN.md` §"6.0-13 GPU 실측 0단계 계획" 참조.

## 환경 (확정 pin)

- GPU: RTX 4060 Laptop 8GB, 드라이버 576.88(**CUDA 12.9 상한** — CUDA 13 빌드 사용 불가)
- venv(dev 전용, 운영 requirements 무수정): Python 3.14, `onnxruntime-gpu==1.26.0`(**CUDA 12 빌드**),
  `nvidia-cudnn-cu12==9.10.2.21`, nvidia cu12 런타임 휠(cublas 12.9.2 등), rtmlib 0.0.15
- Windows에선 `onnxruntime.preload_dlls()` 필요(pip nvidia-* 휠은 PATH에 없음) — bench_pose.py가
  device≠cpu일 때 자동 호출

### 환경 함정 2건 (재현 시 필독)

1. **ORT-GPU 1.27은 CUDA 13 빌드** — 이 드라이버(12.9)에서 CUDA EP 생성 실패. 1.26이 CUDA 12 마지막 계열.
2. **cuDNN 9.23.x는 ORT 1.26과 비호환** — 세션 생성은 성공하나 **첫 추론에서** cudnn frontend Conv 그래프
   빌드 실패(`CUDNN_FE failure 11: CUDNN_BACKEND_API_FAILED`) 후 CPU로 무성 폴백. 9.10.2로 다운그레이드 시 정상.

### ⚠ 발견: ORT 무성 폴백 2종 — 6.0-12 운영 코드의 맹점 (후속 과제)

ORT는 두 시점에 예외 없이 CPU로 폴백한다: ① 세션 생성 시 EP init 실패(경고만), ② **첫 추론** 시 EP 실행
실패(stdout "Falling back to CPUExecutionProvider" 후 세션 재생성). `cuda_available()`(EP 목록)과 세션 생성
성공만 믿으면 **CPU 실행을 GPU로 오인**한다. bench_pose.py는 로드 직후+워밍업 후 2단으로
`session.get_providers()`를 검사해 차단하지만, **infer_clip.py의 `deviceUsed=cuda` 기록은 같은 맹점을
가짐**(운영 코드 무수정 원칙으로 이번 범위 제외) — "지난번 GPU 이득 없음" 관찰도 이 무성 폴백(실제 CPU 실행)
이었을 가능성이 높음. A안 본구현 시 infer_clip에 동일한 2단 검증 이식 필요.

## 직접 측정 ① — 프레임당 추론 ms (bench_pose.py, 200프레임×3회, 5fps 샘플링, persons/frame 0.86)

값은 3회 mean의 대표치(반복 간 편차 ±5% 내, yolox-s CPU r3 89ms는 이상치로 병기). det=YOLOX-tiny(416) 고정,
표기 없으면 pose 256x192(H×W) = rtmlib (w,h) 192,256.

| 조합 | CPU total | GPU total | CPU pose | GPU pose | CPU det | GPU det | peakRss CPU→GPU |
|---|---|---|---|---|---|---|---|
| tiny+s (현행 body) | **26.4** | 27.0 | 6.3 | 6.9 | 20.1 | 20.1 | 386MB → 1.26GB |
| tiny+m | 31.2 | **26.6** | 11.8 | 7.5 | 19.4 | 19.0 | 439MB → 1.27GB |
| tiny+l | 37.0 | **28.9** | 18.7 | 9.3 | 18.3 | 19.7 | 556MB → 1.29GB |
| yolox-s(640)+s | 75.4(r3 98) | 37.9 | 6.8 | 6.7 | 68.5 | 31.2 | 446MB → 1.28GB |
| wholebody rtmw-dw-l-m (현행) | 39.4 | **31.1** | 21.1 | 12.4 | 18.3 | 18.6 | 642MB → 1.30GB |

핵심 관찰:
- **pose는 GPU에서 확실히 빨라진다**: m 11.8→7.5, l 18.7→9.3, wholebody 21.1→12.4 (약 40~50%↓).
- **det(YOLOX-tiny)는 GPU 이득 0** (20ms 그대로) — 전처리/NMS가 CPU + 왕복 오버헤드. **총 시간의 지배 요소가
  det로 확인됨** → 향후 B안(최적화)의 1순위 대상은 pose가 아니라 det.
- yolox-s는 GPU에서도 det 31ms로 비쌈 → **후보 탈락**(det 품질 문제가 실측되면 재검토).
- smoke 가드: 후보 3종 모두 통과(bbox **(N,4) 강제**·kpts (N,17,2) 원 shape 검사·finite). rtmlib det_model은
  score 없는 좌표 4컬럼을 반환하며, 측정 루프·운영 infer_clip이 이 출력을 가공 없이 pose에 넘기는 계약이므로
  smoke도 (N,4) 외 포맷은 즉시 실패시킨다(계획서의 "bbox score [0,1]" 항목은 score 미노출로 적용 불가 확인).

## 직접 측정 ② — end-to-end (infer_clip.py 무수정, 60초 클립=298프레임 샘플, 3회 wall-clock)

| variant | CPU e2e (3회) | GPU e2e (3회) |
|---|---|---|
| body (tiny+s) | 11.8 / 12.9 / 12.9s | 13.2 / 12.7 / 12.2s |
| wholebody | 17.5 / 17.7 / 14.2s | 16.7 / 18.5 / 17.2s |

- **e2e GPU 값의 검증 강도**: infer_clip은 무수정이라 자체 `deviceUsed=cuda` 기록만으로는 무성 폴백을 배제할
  수 없다(위 §무성 폴백 2종). 따라서 **사후 로그 검증**으로 보강했다 — e2e cuda 로그 12건(stdout+stderr 캡처) 전수에서
  `Falling back`/`EP Error`/`Failed to create`/`CUDNN` 패턴 **0건**(무성 폴백 시 반드시 출력됨) + 동일 venv에서
  세션 레벨 CUDA 동작은 bench 2단 검증으로 확인. 이 근거로 e2e cuda 런은 실제 GPU 실행으로 판정한다.
- **결론(보수적으로)**: 이 클립 길이(60초)에서는 GPU e2e 이득이 관측되지 않았다. run-to-run 편차(±20%,
  wholebody CPU r3 14.2s 같은 이상치 포함)가 per-frame 기대 절감(wholebody 8.3ms×298 ≈ 2.5s)과 같은 자릿수라
  e2e 실측으로는 판별 불가. CUDA 초기화·preload(~2–3s)가 매 실행 반복되는 것도 상쇄 요인.
- "손익분기 ≈ 수 분 이상 클립 또는 연속 다건 처리"는 **per-frame 직접측정 기반 추정**이며 e2e 실측으로는
  미확인 — 판단 근거로 쓸 때 이 한계를 유지할 것.
- 운영 관점: wholebody GPU 1분 클립 추론 ≈ 31ms×300 ≈ **9.3s** (+init·오버헤드) — deadline 600s 대비 매우 여유.

## 외삽 추정 — 상위 후보 e2e (직접 측정 아님)

공식: `estimated_e2e = current_e2e_cuda + (candidate_infer_ms − current_infer_ms) × sampled_frames`
기준값 둘 다 CUDA per-frame total(det+pose). 가정: 디코드/JSON/feature/overlay 비용은 모델 무관 동일.
**모델 로드/CUDA init 차이는 제외한 per-frame 처리 구간 추정.**

| 조합(GPU) | 60s 클립(298프레임) 추정 e2e | 비교: 현행 CPU 직접측정(mean) |
|---|---|---|
| tiny+m | 12.7 + (26.6−27.0)×0.298 ≈ **12.6s** | 12.5s |
| tiny+l | 12.7 + (28.9−27.0)×0.298 ≈ **13.3s** | 12.5s |

## GPU 실사용 증적

- `sessionProviders`(det/pose 세션 실측 EP)에 CUDAExecutionProvider — 로드 직후·워밍업 후 2단 검증 통과.
- `nvidia-smi --query-compute-apps`에 벤치 python.exe 프로세스 등재(로그: 세션 스크래치
  `bench-results/nvidia-smi-compute-apps.csv`).
- pose 시간 반감(21→12ms 등)은 CPU로는 불가능한 변화.
- **한계**: Windows WDDM + 한글 로캘에서 nvidia-smi `memory.used`/`utilization.gpu` 전역 쿼리와 프로세스별
  VRAM이 0/[N/A]로 나와 **VRAM 절대치 미확보**(계획의 `gpuMemoryUsedMB` 컬럼 대체 불가). 모델 크기
  (onnx 최대 105MB)+CUDA context 기준 수백 MB 추정, 8GB 대비 여유. 정밀 VRAM·per-op 프로파일링은 후속.

## 결론

**① body — A안 성립**: RTMPose-**l**을 GPU로 돌려도 현행 tiny+s CPU와 동급(28.9 vs 26.4ms/frame, e2e 추정
13.3 vs 12.5s). 즉 **속도 손해 없이 pose 정확도 등급을 s→m/l로 올릴 수 있다**. 단 "GPU라서 빨라진다"는 아니고
"GPU라서 더 큰 모델을 공짜로 쓴다"가 정확한 표현. det는 tiny 유지(yolox-s 탈락).

**② wholebody — 충분**: 현행 rtmw-dw-l-m GPU가 per-frame 25%↓, 1분 클립 추론 ~9.3s로 deadline 600s에 매우
여유. 단 60초 클립 e2e에서는 GPU 이득이 관측되지 않음(CUDA init 상쇄 + 편차) — GPU 전환의 실익은 "여러 클립
연속 처리"나 "수 분 이상 클립"에서 발생(per-frame 기반 추정, e2e 미확인).

**서버 GPU 도입 시사점**: 서버는 워커가 클립마다 python 프로세스를 새로 띄우므로 CUDA init 비용이 매 job에
반복됨 — GPU 도입 시 (a) 상주 프로세스화 또는 (b) 1분+ 클립·wholebody 위주 기대효과로 계산해야 함.

**다음 단계(사용자 결정 대기)**: A안 진행 여부·모델 선택(m vs l). 진행 시 선결 과제는 계획 섹션 참조
(manifest 티어 축, cuda일 때만 상위 티어 강등, infer_clip 무성 폴백 2단 검증 이식, 정확도 지표).

## 재현 방법

```powershell
# venv 준비(1회): pip install "onnxruntime-gpu[cuda,cudnn]==1.26.0" "nvidia-cudnn-cu12==9.10.2.21"
cd services/pose-inference
.\.venv\Scripts\python.exe bench_pose.py --model body --device cuda --max-frames 200          # 현행
.\.venv\Scripts\python.exe bench_pose.py --model body --device cuda --max-frames 200 `
  --pose-onnx <rtmpose-l end2end.onnx> --pose-size 192,256                                    # 후보(w,h 주의)
.\.venv\Scripts\python.exe infer_clip.py --input samples/people-detection.mp4 --output out.json `
  --fps 5 --pose-variant wholebody --device cuda                                              # e2e
```

후보 .onnx 출처(OpenMMLab onnx_sdk, zip 내 end2end.onnx — 레포 미커밋):
rtmpose-m `…256x192-e48f03d0_20230504.zip`, rtmpose-l `…256x192-4dba18fc_20230504.zip`,
yolox-s `yolox_s_8xb8-300e_humanart-3ef259a7.zip`.
