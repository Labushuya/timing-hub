#!/bin/bash
# =============================================================================
# Timing Hub — First-Time Setup Script
# =============================================================================
# Provisions a fresh Raspberry Pi with the full Timing Hub stack including
# SSL certificates, database migrations and seed data.
#
# USAGE:
#   cd /home/pi/timing-hub/infra
#   ./scripts/first-setup.sh
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Banner ---
echo ""
echo "============================================================"
echo "  Timing Hub — First-Time Setup"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================================"
echo ""

# --- Check Docker is available ---
echo "[check] Verifying Docker installation..."
if ! command -v docker &>/dev/null; then
    echo "ERROR: docker is not installed or not in PATH."
    echo "       Install Docker: https://docs.docker.com/engine/install/"
    exit 1
fi
if ! docker compose version &>/dev/null; then
    echo "ERROR: 'docker compose' (v2) is not available."
    echo "       Ensure Docker Desktop or the compose plugin is installed."
    exit 1
fi
echo "  Docker OK: $(docker --version)"
echo "  Compose OK: $(docker compose version)"
echo ""

# --- Create .env.prod from example if missing ---
cd "$INFRA_DIR"
if [ ! -f ".env.prod" ]; then
    if [ -f ".env.prod.example" ]; then
        echo "[setup] Copying .env.prod.example to .env.prod..."
        cp .env.prod.example .env.prod
    else
        echo "WARNING: .env.prod.example not found — creating a minimal .env.prod placeholder."
        cat > .env.prod <<'EOF'
# Timing Hub Production Environment
# Fill in all values before proceeding.
DOMAIN=your-domain.duckdns.org
POSTGRES_DB=timing_hub
POSTGRES_USER=timing_hub
POSTGRES_PASSWORD=change_me_strong_password
REDIS_PASSWORD=change_me_redis_password
JWT_SECRET=change_me_jwt_secret_min32chars
CERTBOT_EMAIL=you@example.com
EOF
    fi
    echo "  .env.prod created."
else
    echo "[setup] .env.prod already exists — skipping copy."
fi
echo ""

# --- Prompt user to fill in .env.prod ---
echo "============================================================"
echo "  ACTION REQUIRED: Edit .env.prod before continuing."
echo "  Set your domain, passwords, email and other secrets."
echo "  File location: $INFRA_DIR/.env.prod"
echo "============================================================"
read -p "Press Enter once you have saved your changes to .env.prod..."
echo ""

# --- Read domain and email from .env.prod ---
DOMAIN="$(grep '^DOMAIN=' .env.prod | cut -d= -f2)"
CERTBOT_EMAIL="$(grep '^CERTBOT_EMAIL=' .env.prod | cut -d= -f2)"

# --- Allow override at prompt ---
read -p "Domain for SSL certificate [$DOMAIN]: " INPUT_DOMAIN
[ -n "$INPUT_DOMAIN" ] && DOMAIN="$INPUT_DOMAIN"

read -p "Email for Let's Encrypt notifications [$CERTBOT_EMAIL]: " INPUT_EMAIL
[ -n "$INPUT_EMAIL" ] && CERTBOT_EMAIL="$INPUT_EMAIL"

echo ""

# --- Start postgres, redis, and nginx (bootstrap / HTTP-only config) ---
echo "[1/6] Starting postgres, redis, and nginx (bootstrap mode)..."
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d postgres redis nginx
echo ""

# --- Wait for postgres to be healthy ---
echo "[2/6] Waiting for PostgreSQL to be ready..."
MAX_WAIT=60
WAITED=0
until docker compose --env-file .env.prod -f docker-compose.prod.yml \
    exec -T postgres pg_isready -q 2>/dev/null; do
    if [ "$WAITED" -ge "$MAX_WAIT" ]; then
        echo "ERROR: PostgreSQL did not become healthy within ${MAX_WAIT}s."
        exit 1
    fi
    echo "  Waiting... (${WAITED}s elapsed)"
    sleep 3
    WAITED=$((WAITED + 3))
done
echo "  PostgreSQL is ready."
echo ""

# --- Obtain SSL certificates ---
echo "[3/6] Requesting SSL certificate from Let's Encrypt..."
echo "  Domain : $DOMAIN"
echo "  Email  : $CERTBOT_EMAIL"
docker compose --env-file .env.prod -f docker-compose.prod.yml \
    run --rm certbot certonly \
    --webroot --webroot-path=/var/www/certbot \
    --email "$CERTBOT_EMAIL" \
    --agree-tos --no-eff-email \
    -d "$DOMAIN" \
    -d "www.$DOMAIN" \
    -d "api.$DOMAIN"
echo "  Certificate obtained."
echo ""

# --- Reload nginx with full HTTPS config ---
echo "[4/6] Reloading nginx with HTTPS configuration..."
docker compose --env-file .env.prod -f docker-compose.prod.yml exec nginx nginx -s reload
echo ""

# --- Start api and web ---
echo "[5/6] Starting api and web services..."
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d api web
echo ""

# --- Run database migrations ---
echo "[6/6] Running database migrations..."
docker compose --env-file .env.prod -f docker-compose.prod.yml exec api node dist/db/migrations/migrate.js up
echo ""

# --- Seed database ---
echo "[seed] Running database seed..."
docker compose --env-file .env.prod -f docker-compose.prod.yml exec api node dist/db/seed.js
echo ""

# --- Success summary ---
echo "============================================================"
echo "  Timing Hub setup complete!"
echo ""
echo "  App         : https://$DOMAIN"
echo "  Admin panel : https://$DOMAIN/admin"
echo ""
echo "  Admin credentials are printed by the seed script above."
echo "  Change the admin password after first login."
echo ""
echo "  Useful commands:"
echo "    View logs  : docker compose -f $INFRA_DIR/docker-compose.prod.yml logs -f"
echo "    Stop all   : docker compose -f $INFRA_DIR/docker-compose.prod.yml down"
echo "    Deploy     : $SCRIPT_DIR/deploy.sh"
echo "============================================================"
