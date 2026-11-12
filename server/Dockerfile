# =============================================================================
# wr-evaluation-unified — server image (영상 추론 동봉, 6.0-9)
#
# Four-stage build (npm workspaces, 루트 package-lock.json 하나 — REFACTORING_ROADMAP P0-7 W3):
#   web-builder      → 루트 + @wr/contracts·@wr/analytics-core 설치, 공유 패키지 dist + Vite SPA
#   server-builder   → @wr/server 설치(dev 포함), TypeScript 컴파일
#   server-prod-deps → @wr/server 운영 의존성만(npm ci --omit=dev), 네이티브 모듈(bcrypt) glibc 빌드
#   production       → Node 22 (Debian bookworm) + Python 포즈 추론 런타임 + baked 가중치.
#                      저장소와 같은 경로 구조(/app/node_modules·/app/shared·/app/packages·/app/server)라
#                      워크스페이스 심링크(node_modules/@wr/* → ../../shared 등)가 그대로 유효하다.
#
# ABI 정합(6.0-9): server-builder·production을 같은 Debian(bookworm) 계열로 통일한다.
#   네이티브 모듈(bcrypt 등)을 musl(alpine)에서 빌드해 glibc 런타임으로 복사하면 부팅 시
#   로딩이 깨지므로, 추론 스택(onnxruntime/opencv glibc wheel) 요구와 맞춰 glibc로 일원화.
#
# 영상 추론(6.0-9): 운영은 에어갭이므로 가중치를 이미지에 굽는다. 빌드 전 온라인 PC에서
#   scripts/fetch-pose-weights.ps1 을 1회 실행해 services/pose-inference/models/*.onnx 를
#   배치하고 manifest sha256/weightsComplete 를 확정해야 한다(미배치면 추론은 dev 자동다운로드
#   폴백이라 --network none 에서 실패).
#
# Usage:
#   docker build -f server/Dockerfile --build-arg WR_GIT_COMMIT=$(git rev-parse HEAD) -t wr-app-server .
#   docker run --rm --network none wr-app-server \
#     /opt/pose-venv/bin/python /app/pose-inference/infer_clip.py --input <clip> --output /tmp/k.json --fps 5
# =============================================================================

# =============================================================================
# Stage 1: Build web SPA (Vite) — 정적 산출물만 생성(네이티브 모듈 미복사 → alpine 유지 가능)
# =============================================================================
FROM node:22-alpine AS web-builder
WORKDIR /build

# PR0-A: 클라이언트 완료 보고(completionClientBuildVersion)의 빌드 식별자 출처. 이 스테이지엔
# .git이 없어(.dockerignore) vite.config.js의 `git rev-parse` 폴백이 항상 'unknown'이 된다 —
# production 스테이지의 WR_GIT_COMMIT(§8.11 recipe code commit)과 같은 값을 여기도 받는다.
ARG WR_GIT_COMMIT=unknown
ENV WR_GIT_COMMIT=$WR_GIT_COMMIT

# 워크스페이스 매니페스트 먼저(설치 레이어 캐시). 서버 매니페스트도 있어야 lock의 워크스페이스 목록과 맞는다.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY packages/analytics-core/package.json ./packages/analytics-core/
COPY server/package.json ./server/
RUN npm ci --include-workspace-root --workspace @wr/contracts --workspace @wr/analytics-core

COPY scripts/ ./scripts/
COPY shared/ ./shared/
COPY packages/ ./packages/
COPY vite.config.js index.html ./
COPY src/ ./src/
COPY public/ ./public/
RUN VITE_DEFAULT_INTEGRATION_MODE=intranet npm run build:web

# =============================================================================
# Stage 2: Build server TypeScript (glibc — 런타임과 ABI 정합)
# =============================================================================
FROM node:22-bookworm-slim AS server-builder
WORKDIR /build

# 네이티브 모듈(bcrypt 등) 소스 빌드 폴백 대비(prebuilt 없을 때).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY packages/analytics-core/package.json ./packages/analytics-core/
COPY server/package.json ./server/
RUN npm ci --workspace @wr/server

# 서버 tsc는 @wr/* 를 node_modules 심링크 → 패키지 exports(require 조건) → dist/*.d.cts 로 해석한다.
COPY --from=web-builder /build/shared/dist ./shared/dist
COPY --from=web-builder /build/packages/analytics-core/dist ./packages/analytics-core/dist
COPY server/ ./server/
# --ignore-scripts: 서버 prebuild(공유 패키지 tsup 재빌드)는 건너뛴다 — 공유 패키지 dist는 위에서 web-builder가
# 만든 것을 복사했고, 이 단계는 서버 의존성만 설치해 tsup이 없다. build 자체는 dist 삭제 → tsc -p tsconfig.build.json.
RUN npm run build --workspace @wr/server --ignore-scripts
# 옛 빌드 잔여물 가드(7.2.0 리허설): x.js 가 같은 이름의 폴더 모듈 x/index.js 를 가리면 Node 는 x.js 를 불러온다.
# PC 의 server/dist 가 빌드 컨텍스트로 넘어와 S5·S6 이전 라우터(routes/auth.js 등)가 이미지에 섞였던 사고를 막는다
# (.dockerignore 의 **/dist 와 build 의 dist 삭제가 1·2차 방어, 이것이 3차).
RUN cd server/dist \
    && stale="$(find . -name '*.js' | while read -r f; do if [ -f "${f%.js}/index.js" ]; then echo "$f"; fi; done)" \
    && if [ -n "$stale" ]; then echo "server/dist: 폴더 모듈을 가리는 옛 빌드 파일:" $stale; exit 1; fi

# =============================================================================
# Stage 3: 서버 운영 의존성만 (dev 의존성·클라이언트 의존성 제외, glibc 네이티브 빌드)
# =============================================================================
FROM node:22-bookworm-slim AS server-prod-deps
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY packages/analytics-core/package.json ./packages/analytics-core/
COPY server/package.json ./server/
RUN npm ci --omit=dev --workspace @wr/server

# =============================================================================
# Stage 4: Production runtime — Node(glibc) + Python 포즈 추론 + baked 가중치
# =============================================================================
FROM node:22-bookworm-slim AS production
ENV NODE_ENV=production
# recipe(§8.11) code commit 출처 — 빌드 시 주입(scripts/export-offline-package.ps1이 전달).
ARG WR_GIT_COMMIT=unknown
ENV WR_GIT_COMMIT=$WR_GIT_COMMIT
WORKDIR /app

# 추론 런타임(Python) + OpenCV 런타임 라이브러리(libGL/glib) + healthcheck용 wget.
# (bookworm-slim은 busybox wget이 없어 명시 설치 — 기존 alpine과 healthcheck 호환 유지.)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip \
      libgl1 libglib2.0-0 \
      wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# pose-inference Python venv(격리). onnxruntime(CPU)+opencv-headless+rtmlib+jsonschema.
COPY services/pose-inference/requirements.txt /app/pose-inference/requirements.txt
RUN python3 -m venv /opt/pose-venv \
    && /opt/pose-venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/pose-venv/bin/pip install --no-cache-dir -r /app/pose-inference/requirements.txt

# 추론 스크립트 + baked 가중치(models/*.onnx, fetch-pose-weights.ps1로 사전 배치) + 계약/설정.
# (.dockerignore가 .venv/__pycache__는 제외, models/*.onnx는 포함.)
COPY services/pose-inference/ /app/pose-inference/

# 워커 execFile 대상 경로 + baked 모델 경로. 텔레메트리 비활성(에어갭).
ENV VIDEO_ANALYSIS_PYTHON=/opt/pose-venv/bin/python \
    VIDEO_ANALYSIS_SCRIPTS_DIR=/app/pose-inference \
    POSE_MODELS_DIR=/app/pose-inference/models \
    ORT_DISABLE_TELEMETRY=1

# PR1 — stats-engine Python venv(격리, pose venv와 완전히 별도). numpy+scipy+jsonschema만
# 필요했다(pandas/statsmodels는 PR1 범위 밖) — opencv 의존(libgl1/libglib2.0-0)도
# procps도 불필요(계획서 §2.3 — analyze.py는 shell:true 없이 직접 spawn되고 BLAS
# 스레드 제한으로 프로세스를 추가로 fork하지 않는 단일 프로세스 트리 전제, tree-kill
# 미도입).
# PR4-A1 — 연관성 회귀(OLS·이분 로지스틱) 도입으로 statsmodels(+전이 의존 pandas·
# patsy)가 requirements.txt에 추가됐다. 이미지 +약 136MB 실측(로컬 python:3.11-slim
# 기준, `docs/OFFLINE_DEPLOYMENT_PACKAGE.md` §16-1 갱신 참고) — opencv/procps는
# 여전히 불필요(covariance는 statsmodels가 아니라 regression.py가 직접 계산해
# HC3/CR1 공식만 쓴다, statsmodels는 Logit MLE·적합도 지표 전용).
COPY services/stats-engine/requirements.txt /app/stats-engine/requirements.txt
RUN python3 -m venv /opt/stats-venv \
    && /opt/stats-venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/stats-venv/bin/pip install --no-cache-dir -r /app/stats-engine/requirements.txt

# fixtures/(R 참조값·pytest용)는 런타임에 불필요 — .dockerignore로 제외하지 않았다면 여기서
# 스크립트만 명시 복사해도 되지만, 이미지 크기 영향이 미미해 디렉터리 전체를 그대로 복사한다.
COPY services/stats-engine/ /app/stats-engine/

ENV STATS_ENGINE_PYTHON=/opt/stats-venv/bin/python \
    STATS_ENGINE_SCRIPTS_DIR=/app/stats-engine

# 운영 의존성 트리 전체(/build → /app, bookworm에서 설치해 ABI 정합): 루트 node_modules(끌어올린 패키지 +
# @wr/* 워크스페이스 상대 심링크), 버전이 달라 server/node_modules에 남은 패키지, 워크스페이스 package.json들.
# 같은 구조로 복사하므로 심링크가 /app/shared·/app/packages/analytics-core·/app/server를 그대로 가리킨다.
COPY --from=server-prod-deps /build/ /app/
# 공유 패키지 빌드 산출물(@wr/contracts·@wr/analytics-core의 exports가 가리키는 dist).
COPY --from=web-builder /build/shared/dist /app/shared/dist
COPY --from=web-builder /build/packages/analytics-core/dist /app/packages/analytics-core/dist
# 서버 컴파일 결과 + 마이그레이션(server/src/db/migrate.ts: dist/db/../../migrations).
COPY --from=server-builder /build/server/dist /app/server/dist
COPY server/migrations /app/server/migrations

# Web SPA served at / for non-API routes (server/src/app.ts: path.join(__dirname, 'web'))
COPY --from=web-builder /build/dist/web /app/server/dist/web

# 영상 업로드 공유 디렉터리(named volume `video_uploads` 마운트 대상). 부팅 시 비-root(node)가
# 하위 tmp/를 만들므로(buildUploadMiddleware) 디렉터리를 미리 생성하고 소유권을 node에 준다.
# 빈 named volume은 첫 마운트 때 이미지의 이 경로 소유권/권한을 상속하므로, 이게 있어야
# fresh 볼륨이 node 소유가 되어 mkdir EACCES 부팅 크래시를 막는다(6.0-9).
# (이미 root 소유로 생성된 기존 볼륨은 상속이 안 되므로 재배포 시 한 번 chown 필요.)
RUN mkdir -p /app/.video-uploads && chown -R node:node /app/.video-uploads

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

# Run as unprivileged user (node user is built into the official image)
USER node

# 운영 문서·스크립트의 `docker compose exec app node dist/cli/seedAdmin.js` 같은 명령이 그대로 동작하도록
# 서버 패키지 폴더를 작업 폴더로 둔다(그 밖의 경로는 모두 절대 경로 환경변수 — compose·위 ENV).
WORKDIR /app/server
# S9: the server stops gracefully on SIGTERM (src/boot.ts) — the compose file gives it stop_grace_period 15s.
STOPSIGNAL SIGTERM
CMD ["node", "dist/index.js"]
