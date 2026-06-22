# =============================================================================
# wr-evaluation-unified — server image (영상 추론 동봉, 6.0-9)
#
# Three-stage build:
#   web-builder    → Vite SPA (prebuild:web hook builds shared contracts first)
#   server-builder → TypeScript compile (server + shared contracts)
#   production     → Node 20 (Debian bookworm) + Python 포즈 추론 런타임 + baked 가중치
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
FROM node:20-alpine AS web-builder
WORKDIR /build

COPY package*.json ./
COPY scripts/ ./scripts/
COPY shared/ ./shared/
COPY vite.config.js index.html ./
COPY src/ ./src/
COPY public/ ./public/

RUN npm ci
RUN VITE_DEFAULT_INTEGRATION_MODE=intranet npm run build:web

# =============================================================================
# Stage 2: Build server TypeScript (glibc — 런타임과 ABI 정합)
# =============================================================================
FROM node:20-bookworm-slim AS server-builder
WORKDIR /build/server

# 네이티브 모듈(bcrypt 등) 소스 빌드 폴백 대비(prebuilt 없을 때).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy built shared contracts so the file: dependency resolves at npm ci
COPY --from=web-builder /build/shared /build/shared

COPY server/package*.json ./
RUN npm ci

COPY server/ ./
RUN npm run build

# =============================================================================
# Stage 3: Production runtime — Node(glibc) + Python 포즈 추론 + baked 가중치
# =============================================================================
FROM node:20-bookworm-slim AS production
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

# Server compiled JS + production node_modules (bookworm builder와 ABI 정합)
COPY --from=server-builder /build/server/dist        ./dist
COPY --from=server-builder /build/server/node_modules ./node_modules
COPY server/migrations ./migrations

# npm installs local file dependencies as symlinks. The @wr/contracts symlink
# points outside /app in the builder image, so vendor the built contract package
# into the final runtime image as real files.
RUN rm -rf ./node_modules/@wr/contracts && mkdir -p ./node_modules/@wr/contracts
COPY --from=server-builder /build/shared/package.json ./node_modules/@wr/contracts/package.json
COPY --from=server-builder /build/shared/dist ./node_modules/@wr/contracts/dist

# Web SPA served at / for non-API routes
COPY --from=web-builder /build/dist/web ./dist/web

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

CMD ["node", "dist/index.js"]
