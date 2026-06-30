#!/bin/bash
# =============================================================================
# DuckDNS IP Update Script
# =============================================================================
# Updates your DuckDNS subdomain with the current public IP address.
#
# INSTALLATION:
#   1. Copy this script to /usr/local/bin/duckdns-update.sh
#   2. Make executable: chmod +x /usr/local/bin/duckdns-update.sh
#   3. Create /etc/duckdns.conf with:
#        DUCKDNS_TOKEN=your-token-here
#        DUCKDNS_DOMAIN=your-subdomain
#   4. Secure the config: chmod 600 /etc/duckdns.conf
#   5. Add to crontab (every 5 minutes):
#        */5 * * * * /usr/local/bin/duckdns-update.sh
#
# MANUAL RUN:
#   sudo /usr/local/bin/duckdns-update.sh
# =============================================================================

# --- Fallback defaults (override via /etc/duckdns.conf) ---
DUCKDNS_TOKEN=""
DUCKDNS_DOMAIN=""

LOG_FILE="/var/log/duckdns.log"

# --- Load config file if present ---
CONFIG_FILE="/etc/duckdns.conf"
if [ -f "$CONFIG_FILE" ]; then
    # shellcheck source=/dev/null
    source "$CONFIG_FILE"
fi

# --- Validate required variables ---
if [ -z "$DUCKDNS_TOKEN" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: DUCKDNS_TOKEN is not set. Check $CONFIG_FILE or script defaults." | tee -a "$LOG_FILE"
    exit 1
fi

if [ -z "$DUCKDNS_DOMAIN" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: DUCKDNS_DOMAIN is not set. Check $CONFIG_FILE or script defaults." | tee -a "$LOG_FILE"
    exit 1
fi

# --- Ensure log file is writable ---
touch "$LOG_FILE" 2>/dev/null || {
    echo "WARNING: Cannot write to $LOG_FILE — logging to /tmp/duckdns.log instead"
    LOG_FILE="/tmp/duckdns.log"
}

# --- Call DuckDNS API ---
TIMESTAMP="$(date '+%Y-%m-%d %H:%M:%S')"
RESPONSE="$(curl -s -o /tmp/duckdns_response.txt -w "%{http_code}" \
    "https://www.duckdns.org/update?domains=${DUCKDNS_DOMAIN}&token=${DUCKDNS_TOKEN}&ip=")"

HTTP_CODE="$RESPONSE"
BODY="$(cat /tmp/duckdns_response.txt 2>/dev/null)"

# --- Log result ---
if [ "$HTTP_CODE" = "200" ] && [ "$BODY" = "OK" ]; then
    echo "[$TIMESTAMP] OK — domain=${DUCKDNS_DOMAIN} updated successfully" >> "$LOG_FILE"
else
    echo "[$TIMESTAMP] FAIL — domain=${DUCKDNS_DOMAIN} HTTP=${HTTP_CODE} body=${BODY}" >> "$LOG_FILE"
    exit 1
fi
