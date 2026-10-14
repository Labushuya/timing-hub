FROM node:22-alpine AS builder
WORKDIR /app

RUN npm install -g pnpm@9

# Monorepo root manifests (for pnpm workspace install)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./

# Package manifests (needed before install)
COPY packages/shared-types/package.json    ./packages/shared-types/
COPY packages/scoring-engine/package.json  ./packages/scoring-engine/

# App manifest
COPY apps/api/package.json                 ./apps/api/

# Install all workspace dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/shared-types/   ./packages/shared-types/
COPY packages/scoring-engine/ ./packages/scoring-engine/
COPY apps/api/                ./apps/api/

# Build (api depends on shared-types + scoring-engine via workspace:*)
WORKDIR /app/apps/api
RUN pnpm run build

# ---- Runner ----
FROM node:22-alpine AS runner
WORKDIR /app

RUN apk add --no-cache curl

# Copy built output + runtime dependencies
COPY --from=builder /app/apps/api/dist                     ./dist
COPY --from=builder /app/apps/api/node_modules             ./node_modules
COPY --from=builder /app/apps/api/package.json             ./
# SQL migration files must be next to migrate.js at runtime
COPY --from=builder /app/apps/api/src/db/migrations        ./src/db/migrations

ENV NODE_ENV=production
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s \
  CMD curl -f http://localhost:3001/health || exit 1
CMD ["node", "dist/server.js"]
