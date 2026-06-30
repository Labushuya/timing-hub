FROM node:22-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm@9
COPY package.json ./
COPY pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

FROM node:22-alpine AS runner
WORKDIR /app
RUN apk add --no-cache curl
COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s CMD curl -f http://localhost:3000 || exit 1
CMD ["node", "build"]
