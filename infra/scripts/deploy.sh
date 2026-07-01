#!/bin/bash
# =============================================================================
# Timing Hub — Deploy / Update Script
# =============================================================================
# Pulls the latest code and restarts services with zero-downtime rebuild.
#
# USAGE:
#   cd /home/pi/timing-hub/infra
#   ./scripts/deploy.sh
# =============================================================================
set -euo pipefail

# --- Resolve project root (infra/ is one level below project root) ---
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$INFRA_DIR/.." && pwd)"

# --- Header ---
echo "============================================================"
echo "  Timing Hub — Deployment"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================================"
echo ""
echo "Project root : $PROJECT_ROOT"
echo "Infra dir    : $INFRA_DIR"
echo ""

# --- Pull latest code ---
echo "[1/5] Pulling latest code from origin/master..."
cd "$PROJECT_ROOT"
git pull origin master
echo ""

# --- Check .env.prod ---
echo "[2/5] Checking environment file..."
if [ ! -f "$INFRA_DIR/.env.prod" ]; then
    echo "ERROR: $INFRA_DIR/.env.prod not found."
    echo "       Run first-setup.sh or copy .env.prod.example to .env.prod and fill in values."
    exit 1
fi
echo "  .env.prod found — OK"
echo ""

# --- Build updated images ---
echo "[3/5] Building api and web images..."
cd "$INFRA_DIR"
docker compose --env-file .env.prod -f docker-compose.prod.yml build api web
echo ""

# --- Restart services ---
echo "[4/5] Restarting api and web containers..."
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d api web
echo ""

# --- Run migrations ---
echo "[5/5] Running database migrations..."
docker compose --env-file .env.prod -f docker-compose.prod.yml exec api node dist/db/migrations/migrate.js up
echo ""

# --- Success summary ---
echo "============================================================"
echo "  Deployment complete!"
echo ""
echo "  App   : https://$(grep '^DOMAIN=' .env.prod | cut -d= -f2)"
echo "  Admin : https://$(grep '^DOMAIN=' .env.prod | cut -d= -f2)/admin"
echo "============================================================"
