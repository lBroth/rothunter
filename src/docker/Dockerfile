# =========================================
# RotHunter server — multi-stage build
#
#   stage 1: build the UI (Vite → static)
#   stage 2: slim runtime, runs the server via tsx
#
# The LLM (llama.cpp + Qwen2.5-Coder-14B Q4_K_M) ships as a SEPARATE
# sidecar container (see docker-compose.yml). RotHunter reaches it over
# the docker-compose network at http://rothunter-llm:8080.
#
# We deliberately ship the server as TypeScript-source + `tsx` rather
# than a tsc build. The shared AME codebase has a handful of pre-
# existing ts-morph type-cast diagnostics that fail strict tsc; tsx
# transpiles on the fly without enforcing them, which is the right
# trade-off for a self-hosted dev tool that already pays the tsx cost
# locally.
# =========================================

# --- 1. UI build --------------------------------------------------------
FROM node:22-alpine AS ui-build
WORKDIR /app/ui
COPY src/rothunter/ui/package.json src/rothunter/ui/package-lock.json ./
COPY src/rothunter/ui/.npmrc ./
RUN npm install --no-audit --no-fund
COPY src/rothunter/ui/ ./
RUN npm run build

# --- 2. Runtime ---------------------------------------------------------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV ROTHUNTER_PORT=3000
ENV ROTHUNTER_HOST=0.0.0.0
ENV ROTHUNTER_WORKSPACE=/workspace
ENV ROTHUNTER_LLM_BASE_URL=http://rothunter-llm:8080/v1
ENV ROTHUNTER_LLM_MODEL=bartowski/Qwen2.5-Coder-14B-Instruct-GGUF

COPY package.json package-lock.json ./
# Production deps only, plus tsx (dev dep in package.json but the runtime
# needs it because we ship TS source — see Dockerfile header for why).
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts \
  && npm install --no-save --no-audit --no-fund tsx@^4 \
  && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
COPY --from=ui-build /app/ui/dist ./src/rothunter/ui/dist

EXPOSE 3000
VOLUME ["/workspace"]
CMD ["npx", "tsx", "src/rothunter/server/index.ts"]
