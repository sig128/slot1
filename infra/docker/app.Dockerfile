# syntax=docker/dockerfile:1.7
# One build for the SLOT1 processes. Targets: api, worker, web, inference, inference-gpu.
#   docker build -f infra/docker/app.Dockerfile --target api -t slot1-api .

# GPU inference base: any CUDA 12 + cuDNN 9 runtime image your host driver supports.
ARG CUDA_RUNTIME_IMAGE=nvidia/cuda:12.6.3-cudnn-runtime-ubuntu24.04

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo

# Install dependencies from the lockfile only (cached unless a manifest changes).
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY apps/inference/package.json apps/inference/
COPY packages/analysis/package.json packages/analysis/
COPY packages/bot/package.json packages/bot/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/gta-runtime/package.json packages/gta-runtime/
COPY packages/platform/package.json packages/platform/
COPY packages/services/package.json packages/services/
COPY packages/twitch/package.json packages/twitch/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# The web app's /api rewrite target is fixed at build time (Next serializes rewrites).
ARG SLOT1_API_INTERNAL_URL=http://api:4000
ENV SLOT1_API_INTERNAL_URL=$SLOT1_API_INTERNAL_URL
RUN pnpm --filter @slot1/api --filter @slot1/worker --filter @slot1/inference build \
 && pnpm --filter @slot1/web build \
 && pnpm --filter @slot1/api deploy --legacy --prod /out/api \
 && pnpm --filter @slot1/worker deploy --legacy --prod /out/worker \
 && pnpm --filter @slot1/inference deploy --legacy --prod /out/inference

# API and worker need ffmpeg/ffprobe, tesseract and a caption font at runtime.
FROM node:22-bookworm-slim AS media-runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tesseract-ocr tesseract-ocr-eng fonts-dejavu-core ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
ENTRYPOINT ["/usr/bin/tini", "--"]

FROM media-runtime AS api
COPY --from=build --chown=node:node /out/api ./
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]

FROM media-runtime AS worker
COPY --from=build --chown=node:node /out/worker ./
COPY --from=build --chown=node:node /repo/apps/worker/dist ./dist
USER node
CMD ["node", "dist/main.js"]

FROM node:22-bookworm-slim AS web
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
# Self-hosted fonts and other static files (the standalone server doesn't include public/).
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

# Shared GTA-model inference service, CPU build (ONNX Runtime CPU execution provider).
FROM node:22-bookworm-slim AS inference
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production INFERENCE_HOST=0.0.0.0 INFERENCE_PORT=4100
WORKDIR /app
COPY --from=build --chown=node:node /out/inference ./
COPY --from=build --chown=node:node /repo/apps/inference/dist ./dist
USER node
EXPOSE 4100
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]

# GPU build: onnxruntime-node's CUDA execution provider needs CUDA 12 + cuDNN 9 on Linux x64.
# pnpm skips onnxruntime-node's install script, so the CUDA EP libraries are fetched here
# explicitly. The base image comes from the CUDA_RUNTIME_IMAGE build arg (top of this file).
FROM ${CUDA_RUNTIME_IMAGE} AS inference-gpu
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=base /usr/local/bin/node /usr/local/bin/node
ENV NODE_ENV=production INFERENCE_HOST=0.0.0.0 INFERENCE_PORT=4100 INFERENCE_EXECUTION_PROVIDERS=cuda,cpu
WORKDIR /app
COPY --from=build /out/inference ./
COPY --from=build /repo/apps/inference/dist ./dist
RUN ONNXRUNTIME_NODE_INSTALL=cuda12 node node_modules/onnxruntime-node/script/install.js && chown -R 1000:1000 /app
USER 1000
EXPOSE 4100
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
