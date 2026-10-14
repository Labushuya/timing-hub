FROM node:22-alpine AS builder
WORKDIR /app

RUN npm install -g pnpm@9

# Monorepo root manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./

# Package manifests (needed before install)
COPY packages/shared-types/package.json    ./packages/shared-types/
COPY packages/scoring-engine/package.json  ./packages/scoring-engine/

# App manifest
COPY apps/web/package.json                 ./apps/web/

# Install all workspace dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/shared-types/   ./packages/shared-types/
COPY packages/scoring-engine/ ./packages/scoring-engine/
COPY apps/web/                ./apps/web/

# Build SvelteKit (adapter-node → outputs to build/)
WORKDIR /app/apps/web
RUN pnpm run build

# ---- Runner ----
FROM node:22-alpine AS runner
WORKDIR /app

RUN apk add --no-cache curl

COPY --from=builder /app/apps/web/build         ./build
COPY --from=builder /app/apps/web/node_modules  ./node_modules
COPY --from=builder /app/apps/web/package.json  ./

ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s \
  CMD curl -f http://localhost:3000 || exit 1
CMD ["node", "build"]
