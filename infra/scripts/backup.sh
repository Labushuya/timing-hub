#!/bin/bash
# =============================================================================
# Timing Hub — Database Backup Script
# =============================================================================
# Dumps the PostgreSQL database to a compressed file and rotates old backups.
#
# INSTALLATION:
#   Add to crontab for daily backup at 02:00:
#     0 2 * * * /home/pi/timing-hub/infra/scripts/backup.sh
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

BACKUP_DIR="/home/pi/backups"
RETENTION_DAYS=14
TIMESTAMP="$(date '+%Y%m%d_%H%M%S')"
BACKUP_FILE="$BACKUP_DIR/timing-hub_${TIMESTAMP}.sql.gz"

# --- Read database name from .env.prod if available ---
ENV_FILE="$INFRA_DIR/.env.prod"
DB_NAME="timing_hub"
DB_USER="postgres"

if [ -f "$ENV_FILE" ]; then
    _db="$(grep '^POSTGRES_DB=' "$ENV_FILE" | cut -d= -f2)"
    _user="$(grep '^POSTGRES_USER=' "$ENV_FILE" | cut -d= -f2)"
    [ -n "$_db" ]   && DB_NAME="$_db"
    [ -n "$_user" ] && DB_USER="$_user"
fi

echo "============================================================"
echo "  Timing Hub — Database Backup"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================================"

# --- Create backup directory if needed ---
if [ ! -d "$BACKUP_DIR" ]; then
    echo "Creating backup directory: $BACKUP_DIR"
    mkdir -p "$BACKUP_DIR"
fi

# --- Run pg_dump via docker compose ---
echo "Dumping database '$DB_NAME' as user '$DB_USER'..."
cd "$INFRA_DIR"
docker compose --env-file .env.prod -f docker-compose.prod.yml \
    exec -T postgres \
    pg_dump -U "$DB_USER" "$DB_NAME" \
    | gzip > "$BACKUP_FILE"

BACKUP_SIZE="$(du -sh "$BACKUP_FILE" | cut -f1)"
echo "Backup saved: $BACKUP_FILE ($BACKUP_SIZE)"

# --- Remove backups older than retention period ---
echo "Removing backups older than $RETENTION_DAYS days..."
DELETED_COUNT="$(find "$BACKUP_DIR" -name "timing-hub_*.sql.gz" \
    -mtime "+$RETENTION_DAYS" -print -delete | wc -l)"
echo "Deleted $DELETED_COUNT old backup(s)."

# --- Summary ---
REMAINING="$(find "$BACKUP_DIR" -name "timing-hub_*.sql.gz" | wc -l)"
echo ""
echo "Done. $REMAINING backup(s) retained in $BACKUP_DIR."
