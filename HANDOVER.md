# Timing:Hub — Handover
**Stand: 2026-10-14 | Letzter Commit: siehe `git log --oneline -1`**

> Dieses Dokument ist für die nächste Claude-Session (Opus 5.5) bestimmt.
> Repo: https://github.com/Labushuya/timing-hub | Branch: `master`
> Lokales Verzeichnis: `C:\Code\claude\timing-hub`

---

## 1. Projektstatus: Vollständig implementiert, Deployment ausstehend

Alle Entwicklungsphasen sind abgeschlossen. Das einzige offene Thema ist das
**Pi 5 Deployment** (Docker Compose, Self-Hosted, timinghub.de).

Die drei zuvor bekannten Bugs sind in diesem Commit behoben:
- `turbo.json`: `pipeline` → `tasks` (Turborepo 2.x)
- `svelte.config.js`: `adapter-vercel` → `adapter-node` (für Docker)
- Dockerfiles: Monorepo-Root als Build-Context (workspace-Packages erreichbar)
- `docker-compose.prod.yml`: `postgres` nutzte `.env` statt `.env.prod` (behoben)

---

## 2. Was ist Timing:Hub?

Browser-basierte SaaS Live-Zeitnahme-Plattform für klassische Motorsport-Veranstaltungen
(ADAC, Badenpokal, Schauinsland Klassik, Käthchen Klassik). Kein Install für Endnutzer.

**Rollen:** Veranstalter · Zeitnehmer · Kommissar · Teilnehmer (öffentlich, kein Account)

**Domain:** timinghub.de / timinghub.net / timinghub.eu (Strato, HTTPS aktiv, Landing Page live)

---

## 3. Stack

| Schicht | Technologie |
|---|---|
| Frontend | SvelteKit 2 + Svelte 5 (Runes), Tailwind 4, PWA |
| API | Fastify 5, TypeScript, Node.js 22 |
| Scoring Engine | Pure TypeScript (`packages/scoring-engine`) |
| DB | PostgreSQL 16 (BIGINT ms UTC für alle Timestamps) |
| Cache / Queue | Redis 7 + BullMQ |
| Bridge | Go 1.23 (Universal Timing Bridge) |
| Hosting | Raspberry Pi 5, Docker Compose, Nginx, Let's Encrypt |

---

## 4. Monorepo-Struktur

```
timing-hub/
├── apps/
│   ├── web/        # SvelteKit (adapter-node, CMD: node build)
│   ├── api/        # Fastify 5
│   └── bridge/     # Go 1.23
├── packages/
│   ├── shared-types/
│   └── scoring-engine/   # GLP, SP, Rundstrecke, Orientierung
├── infra/
│   ├── docker-compose.prod.yml   # Build-Context = Monorepo-Root!
│   ├── .env.prod.example
│   ├── nginx/conf.d/
│   │   ├── timing-hub-bootstrap.conf  # HTTP-only (ACME-Challenge)
│   │   └── timing-hub.conf            # HTTPS (nach SSL-Cert aktivieren)
│   └── scripts/
│       ├── first-setup.sh   # Ersteinrichtung (SSL, Migrationen, Seed)
│       ├── deploy.sh        # Updates
│       ├── duckdns-update.sh
│       ├── ssl-renew.sh
│       └── backup.sh
├── landing/
│   ├── index.html                  # Live auf timinghub.de
│   └── TimingHub-Banner-Logo.png   # README-Banner
└── docs/
    ├── betriebsanleitung.md
    └── self-hosting-raspberry-pi.md
```

---

## 5. Datenbankschema (7 Migrationen, node-pg-migrate)

| Migration | Inhalt |
|---|---|
| 001_initial.sql | users, registration_tokens, refresh_tokens (v1 Basistabellen) |
| 002_events.sql | events (DROP+CREATE, BIGINT timestamps, format-Feld) |
| 003_posten.sql | posten + posten_sessions (access_token, bridge_token) |
| 004_participants.sql | participants (startnummer, co_driver, car_*, class, target_time_ms) |
| 005_time_entries.sql | time_entries (raw_timestamp_ms BIGINT, server_recv_ms, lap_number, client_seq), results, audit_log |
| 006_glp_sections.sql | section_targets, events.hide_target_times/run_count/run_scoring |
| 007_time_entries_run.sql | Index idx_time_entries_run, section_times Cache-Tabelle |

**Alle Timestamps:** BIGINT ms UTC (außer users/tokens: TIMESTAMPTZ aus Migration 001)

Migrationen ausführen:
```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml exec api \
  node dist/db/migrations/migrate.js up
```

---

## 6. API-Routen (alle unter /api/v1)

```
GET  /health
POST /auth/register|login|refresh  GET /auth/me
POST/GET/DELETE /admin/tokens       GET/PATCH /admin/users/:id
POST/GET/PATCH/DELETE /events       /events/:slug
POST /events/:slug/activate|finish
GET/POST/PATCH/DELETE /events/:slug/participants
GET/POST/PATCH/DELETE /events/:slug/posten
POST /times                          # Einzeleintrag
POST /times/batch                    # Offline-Sync (client_seq Dedup)
GET  /events/:slug/times
PATCH /times/:id/confirm|void|assign
GET/PUT /events/:slug/section-targets
GET /events/:slug/results            # ?format=csv|pdf
POST /events/:slug/results/recompute
GET /ws?token=...&type=user|zeitnehmer|bridge
```

---

## 7. Scoring Engine (GLP — Kernprinzip)

Timy erfasst **absolute Uhrzeiten**. Laufzeit = `Ziel_ts - Start_ts`.

```typescript
// ExtendedScoringInput (packages/scoring-engine/src/types.ts)
{
  entries: TimeEntry[];
  participants: Participant[];
  config: EventConfig;
  posten: PostenWithOrder[];       // nach sort_order
  section_targets: SectionTarget[];
  run_scoring: 'sum' | 'best' | 'best_of_n';
  run_scoring_n?: number;
  hide_target_times: boolean;
}
```

---

## 8. Universal Timing Bridge (Go)

Plugin-Architektur (`device.Driver` Interface). Unterstützt:
- ALGE Timy 3 (USB VID 0x0c4a/PID 0x0889)
- TAG Heuer CP 450/500/520/525/540 (RS-232)
- Trentmann RallyStar (RS-232)

HTTP-Status: `localhost:7272` · Gerätewechsel zur Laufzeit via `POST /device`

---

## 9. Svelte 5 Gotchas

- Stores als `.svelte.ts` (nicht `.ts`) — Runes funktionieren nur dort
- Cross-Store-Imports: `.svelte.js` (nicht `.svelte.ts`)
- `$page.params['key'] ?? ''` — immer `?? ''` guard (gibt `string | undefined`)
- Snippets: `{@render SnippetName({prop})}` Syntax

---

## 10. Branding

- **Name:** Timing:Hub (Doppelpunkt = Markenzeichen, immer in Rot `#e63012`)
- **Primärfarbe:** `#e63012` · **Hintergrund:** `#0f0f0f`
- **Font:** System-Stack (-apple-system, Segoe UI, Helvetica)

---

## 11. Offene Aufgaben

### Pi 5 Deployment (vollständig ausstehend)

```bash
# 1. Repo klonen
cd /home/pi && git clone https://github.com/Labushuya/timing-hub.git

# 2. Docker installieren (falls nicht vorhanden)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker pi && newgrp docker

# 3. Pi-hole von Port 80 befreien (falls installiert)
sudo nano /etc/lighttpd/lighttpd.conf  # server.port = 8081
sudo systemctl restart lighttpd

# 4. Fritz!Box: Port 80 + 443 → Pi-IP forwarden

# 5. DuckDNS einrichten
nano infra/scripts/duckdns-update.sh   # DUCKDNS_TOKEN + DUCKDNS_DOMAIN setzen
chmod +x infra/scripts/duckdns-update.sh
./infra/scripts/duckdns-update.sh       # Muss "OK" ausgeben
crontab -e  # */5 * * * * /home/pi/timing-hub/infra/scripts/duckdns-update.sh

# 6. Strato DNS: CNAME @ → timinghub.duckdns.org (Propagation abwarten: ~15min)

# 7. Nginx Bootstrap aktivieren (HTTPS-Config deaktivieren)
mv infra/nginx/conf.d/timing-hub.conf \
   infra/nginx/conf.d/timing-hub.conf.disabled

# 8. First Setup
cd infra
./scripts/first-setup.sh
# → interaktiv: .env.prod ausfüllen, SSL-Zertifikat holen, Services starten

# 9. Nach SSL-Zertifikat: HTTPS-Config aktivieren
mv nginx/conf.d/timing-hub-bootstrap.conf \
   nginx/conf.d/timing-hub-bootstrap.conf.disabled
mv nginx/conf.d/timing-hub.conf.disabled \
   nginx/conf.d/timing-hub.conf
docker compose --env-file .env.prod -f docker-compose.prod.yml restart nginx

# 10. Alle Services hochfahren + Datenbank
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
docker compose --env-file .env.prod -f docker-compose.prod.yml exec api \
  node dist/db/migrations/migrate.js up
docker compose --env-file .env.prod -f docker-compose.prod.yml exec api \
  node dist/db/seed.js

# 11. Autostart
sudo cp infra/systemd/timing-hub.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable timing-hub
```

### Backlog (keine Deadline)

- [ ] Klassen-Modi: konfigurierbare Kriterien (Baujahr, Hubraum, Kategorie)
- [ ] Monetarisierung: Stripe-Integration für Event-Token
- [ ] ALGE MT: **bewusst nicht entwickeln** (nur Hintergrundwissen)

---

## 12. Secret Files — was zu sichern ist

**Eine einzige Datei** enthält alle Produktions-Secrets und ist bewusst **nicht** im Repo
(in `.gitignore` eingetragen):

| Pfad auf dem Pi | Status | Backup |
|---|---|---|
| `/home/pi/timing-hub/infra/.env.prod` | Wird beim `first-setup.sh` erstellt | USB-Stick oder Passwortmanager |

Ohne diese Datei kann nach einem Pi-Ausfall die Datenbank nicht wiederhergestellt werden.
Template liegt im Repo unter `infra/.env.prod.example`.

### Vollständige .env.prod Variablen

```bash
# Generieren mit: openssl rand -hex 32
POSTGRES_DB=timing_hub
POSTGRES_USER=timing_hub
POSTGRES_PASSWORD=<stark>
DATABASE_URL=postgresql://timing_hub:<PW>@postgres:5432/timing_hub
REDIS_URL=redis://redis:6379
JWT_SECRET=<64-char hex>
MASTER_ADMIN_TOKEN=<64-char hex>
PORT=3001
NODE_ENV=production
CORS_ORIGIN=https://timinghub.de,https://www.timinghub.de
PUBLIC_API_URL=https://api.timinghub.de
PUBLIC_WS_URL=wss://api.timinghub.de/ws
ORIGIN=https://timinghub.de
SENTRY_DSN=                        # optional
```
