# Timing Hub

<div align="center">

**Professional motorsport live-timing platform for classic events**

*ADAC • Badenpokal • Schauinsland Klassik • Käthchen Klassik*

[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![SvelteKit](https://img.shields.io/badge/SvelteKit-2.x-FF3E00?style=flat-square&logo=svelte&logoColor=white)](https://kit.svelte.dev/)
[![Fastify](https://img.shields.io/badge/Fastify-5.x-000000?style=flat-square&logo=fastify&logoColor=white)](https://fastify.dev/)
[![Go](https://img.shields.io/badge/Go-1.23-00ADD8?style=flat-square&logo=go&logoColor=white)](https://go.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-7-DC382D?style=flat-square&logo=redis&logoColor=white)](https://redis.io/)
[![pnpm](https://img.shields.io/badge/pnpm-9.x-F69220?style=flat-square&logo=pnpm&logoColor=white)](https://pnpm.io/)

[**timinghub.de**](https://timinghub.de) · [Issues](https://github.com/Labushuya/timing-hub/issues) · [Releases](https://github.com/Labushuya/timing-hub/releases)

</div>

---

## What is Timing Hub?

Timing Hub replaces manual scoring sheets and Excel files at classic motorsport events with a browser-based real-time system. No installation required for anyone except the optional [Timy Bridge](#timy-bridge) for hardware timing devices.

### Who uses it?

| Role | What they do |
|---|---|
| **Veranstalter** (Organizer) | Creates events, configures participants & posts, exports results |
| **Zeitnehmer** (Marshal) | Enters times at their post via phone browser — or plugs in a Timy device |
| **Kommissar** (Chief Timekeeper) | Live overview of all posts, confirms/voids entries, exports final results |
| **Teilnehmer** (Participant) | Views their own times and the live leaderboard — no account needed |

### Motorsport formats supported

- **GLP** — Gleichmäßigkeitsprüfung (target time vs. actual, penalty points)
- **Sonderprüfung** — Fastest time wins, sector support
- **Rundstrecke** — Lap times, best lap, gap to leader
- **Orientierungsfahrt / Rallye** — Multi-section, early/late penalties

---

## Architecture

```
timinghub.de          (Vercel — SvelteKit SSR + PWA)
    │
api.timinghub.de      (Railway — Fastify 5 + Node.js)
    │
    ├── PostgreSQL 16  (Railway)
    ├── Redis 7        (Railway — pub/sub + BullMQ)
    └── Worker         (Railway — scoring recompute)

At the event venue:
  [ALGE Timy 3] ──USB──► [timy-bridge] ──WSS──► API
```

### Monorepo structure

```
timing-hub/
├── apps/
│   ├── web/        # SvelteKit 2 + Svelte 5 + Tailwind 4
│   ├── api/        # Fastify 5 + TypeScript
│   └── bridge/     # Go 1.23 binary (Timy USB bridge)
├── packages/
│   ├── shared-types/     # TypeScript interfaces
│   └── scoring-engine/   # Pure TS scoring logic (GLP/SP/Rundstrecke/Orientierung)
└── infra/
    └── docker-compose.dev.yml
```

---

## Timy Bridge

The only non-browser component. A single executable (~14 MB, no installer) that:

1. Auto-detects an ALGE Timy 3 (VID `0x0c4a`, PID `0x0889`) on USB
2. Streams timing impulses to the cloud via WebSocket
3. Buffers locally (SQLite WAL) when offline — resumes on reconnect
4. Shows a tray icon (green = connected, red = device missing)

**Download from [Releases](https://github.com/Labushuya/timing-hub/releases):**
- `timy-bridge-windows-amd64.exe`
- `timy-bridge-darwin-arm64`
- `timy-bridge-linux-amd64`

---

## Getting Started (Development)

### Prerequisites

- Node.js 20+
- pnpm 9+
- Docker (for local Postgres + Redis)
- Go 1.23+ (bridge only)

### Setup

```bash
git clone https://github.com/Labushuya/timing-hub.git
cd timing-hub

# Install dependencies
pnpm install

# Start local database + Redis
docker compose -f infra/docker-compose.dev.yml up -d

# Copy env file and configure
cp .env.example .env

# Run database migrations
pnpm --filter @timing-hub/api migrate

# Start everything in parallel
pnpm dev
```

App is available at:
- **Frontend:** http://localhost:5173
- **API:** http://localhost:3001
- **API health:** http://localhost:3001/health

### First-time admin setup

The first admin account is bootstrapped via `MASTER_ADMIN_TOKEN` in `.env`.
Use it to call `POST /v1/admin/tokens` to generate registration tokens for Veranstalter accounts.

---

## Development

```bash
pnpm typecheck    # TypeScript check (all packages)
pnpm test         # Run unit tests
pnpm lint         # ESLint + Prettier check
pnpm build        # Production build (all packages)
```

### Bridge (Go)

```bash
cd apps/bridge
go build -o timy-bridge .
./timy-bridge --config bridge.toml
```

The bridge exposes a local status API at `http://localhost:7272/status`.

---

## Deployment

| Service | Platform | Notes |
|---|---|---|
| Frontend | Vercel | Auto-deploy on push to `main` |
| API | Railway | 2 replicas, auto-scale |
| Worker | Railway | BullMQ scoring jobs |
| PostgreSQL | Railway | Postgres 16 + pgbouncer |
| Redis | Railway | Pub/Sub + BullMQ queues |
| DNS | Cloudflare | timinghub.de + api.timinghub.de |

Required secrets in Railway/Vercel:
`DATABASE_URL` · `REDIS_URL` · `JWT_SECRET` · `MASTER_ADMIN_TOKEN` · `CORS_ORIGIN` · `SENTRY_DSN` (optional)

---

## Roadmap

- [x] Phase 0 — Monorepo foundation, shared types, scoring engine
- [x] Phase 1 — Auth, admin token system, event/participant/posten CRUD
- [x] Phase 2 — WebSocket hub, live timing, scoring integration, dashboards
- [ ] Phase 3 — Timy Bridge Go binary (USB protocol, cross-platform release)
- [ ] Phase 4 — PWA service worker, i18n (DE/EN), PDF export, bundle optimization
- [ ] Phase 5 — E2E tests, load testing, Sentry monitoring, beta with real organizer

---

## License

Private — all rights reserved. Contact the maintainer for licensing inquiries.
