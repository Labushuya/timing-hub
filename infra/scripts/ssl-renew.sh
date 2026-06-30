#!/bin/bash
# =============================================================================
# Timing Hub — SSL Certificate Renewal Script
# =============================================================================
# Renews Let's Encrypt certificates via certbot and reloads nginx if updated.
#
# INSTALLATION:
#   Add to root crontab (runs at 03:30 on the 1st and 15th of each month):
#     30 3 1,15 * * /home/pi/timing-hub/infra/scripts/ssl-renew.sh
#
# MANUAL RUN:
#   sudo /home/pi/timing-hub/infra/scripts/ssl-renew.sh
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="/var/log/ssl-renew.log"
TIMESTAMP="$(date '+%Y-%m-%d %H:%M:%S')"

log() {
    echo "[$TIMESTAMP] $*" | tee -a "$LOG_FILE"
}

# --- Ensure log file is writable ---
touch "$LOG_FILE" 2>/dev/null || LOG_FILE="/tmp/ssl-renew.log"

log "Starting SSL certificate renewal check..."
cd "$INFRA_DIR"

# --- Run certbot renew ---
# certbot exits 0 if certs are fine or successfully renewed.
# We capture output to detect whether renewal actually happened.
RENEW_OUTPUT="$(docker compose --env-file .env.prod -f docker-compose.prod.yml \
    run --rm certbot renew --non-interactive 2>&1)"

echo "$RENEW_OUTPUT" >> "$LOG_FILE"

# --- Reload nginx only if certificates were actually renewed ---
if echo "$RENEW_OUTPUT" | grep -q "Congratulations, all renewals succeeded"; then
    log "Certificates renewed — reloading nginx..."
    docker compose --env-file .env.prod -f docker-compose.prod.yml exec nginx nginx -s reload
    log "nginx reloaded OK"
elif echo "$RENEW_OUTPUT" | grep -q "No renewals were attempted"; then
    log "No renewal needed — certificates are still valid."
else
    log "WARNING: Unexpected certbot output — check log for details."
    exit 1
fi

log "SSL renewal check complete."
