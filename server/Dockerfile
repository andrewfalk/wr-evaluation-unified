# =============================================================================
# wr-evaluation-unified — server image
#
# Three-stage build:
#   web-builder    → Vite SPA (prebuild:web hook builds shared contracts first)
#   server-builder → TypeScript compile (server + shared contracts)
#   production     → minimal Node 20 alpine runtime
#
# Usage:
#   docker build -f server/Dockerfile -t wr-app-server .
# =============================================================================

# =============================================================================
# Stage 1: Build web SPA (Vite)
# prebuild:web runs scripts/prebuild-shared.mjs which installs and builds the
# shared contracts package before Vite starts, so @contracts alias resolves.
# =============================================================================
FROM node:20-alpine AS web-builder
WORKDIR /build

# Root npm install
COPY package*.json ./
COPY scripts/ ./scripts/

# Shared package (prebuild:web will run 'npm --prefix shared run build')
COPY shared/ ./shared/

# Vite source
COPY vite.config.js index.html ./
COPY src/ ./src/
COPY public/ ./public/

RUN npm ci
RUN npm run build:web

# =============================================================================
# Stage 2: Build server TypeScript
# =============================================================================
FROM node:20-alpine AS server-builder
WORKDIR /build/server

# Copy built shared contracts so the file: dependency resolves at npm ci
COPY --from=web-builder /build/shared /build/shared

COPY server/package*.json ./
RUN npm ci

COPY server/ ./
RUN npm run build

# =============================================================================
# Stage 3: Production runtime (minimal)
# =============================================================================
FROM node:20-alpine AS production
ENV NODE_ENV=production
WORKDIR /app

# Server compiled JS + production node_modules
COPY --from=server-builder /build/server/dist       ./dist
COPY --from=server-builder /build/server/node_modules ./node_modules
COPY server/migrations ./migrations

# Web SPA served at / for non-API routes
COPY --from=web-builder /build/dist/web ./dist/web

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

# Run as unprivileged user (node user is built into the official image)
USER node

CMD ["node", "dist/index.js"]
