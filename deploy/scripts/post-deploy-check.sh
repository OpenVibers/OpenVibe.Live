#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# OpenVibe.Live — post-deploy verification
#
# Every check reports pass or fail and the script exits non-zero if any REQUIRED check failed.
# The previous version ended every command with `|| true`, so it always exited 0 — it printed
# information but could never tell you the deploy was broken.
#
#   sudo ./post-deploy-check.sh [domain] [service]
#
# Exit: 0 all required checks passed · 1 one or more required checks failed
# ═══════════════════════════════════════════════════════════════
set -uo pipefail   # deliberately NOT -e: we want to run every check, then report.

DOMAIN="${1:-openvibe.live}"
SERVICE="${2:-openvibe-live}"
API_URL="${API_URL:-http://127.0.0.1:3000}"

FAILED=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILED=$((FAILED+1)); }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
sect() { printf '\n== %s ==\n' "$1"; }

sect "service"
if systemctl is-active --quiet "$SERVICE"; then pass "$SERVICE is active"
else fail "$SERVICE is NOT active"; fi
if systemctl is-enabled --quiet "$SERVICE" 2>/dev/null; then pass "$SERVICE is enabled at boot"
else warn "$SERVICE is not enabled at boot"; fi

sect "socket activation"
if systemctl list-unit-files "${SERVICE}.socket" >/dev/null 2>&1 && systemctl is-active --quiet "${SERVICE}.socket"; then
    pass "${SERVICE}.socket active — restarts queue connections instead of refusing them"
else
    warn "no active socket unit — a restart will refuse connections for the length of boot"
fi

sect "readiness"
# Readiness, not liveness: /api/ready only returns 200 once the database answers and boot is done.
READY_BODY=$(curl -sf --max-time 10 "${API_URL}/api/ready" 2>/dev/null || echo '')
if [ -n "$READY_BODY" ]; then pass "local /api/ready -> 200"
else fail "local /api/ready did not return 200 (process up but not serving)"; fi

sect "public reachability"
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$DOMAIN/api/health" || echo 000)
if [ "$CODE" = "200" ]; then pass "https://$DOMAIN/api/health -> 200"
else fail "https://$DOMAIN/api/health -> $CODE"; fi
HOME_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$DOMAIN/" || echo 000)
if [ "$HOME_CODE" = "200" ]; then pass "https://$DOMAIN/ -> 200"
else fail "https://$DOMAIN/ -> $HOME_CODE"; fi

sect "asset versioning"
# A versioned asset must exist at the exact URL the freshly-served HTML asks for. If HTML and
# assets ever disagree the page half-loads, which is worse than being plainly down.
HTML=$(curl -s --max-time 20 "https://$DOMAIN/" || echo '')
MISSING=0; CHECKED=0
while IFS= read -r asset; do
    [ -n "$asset" ] || continue
    CHECKED=$((CHECKED+1))
    AC=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$DOMAIN$asset" || echo 000)
    [ "$AC" = "200" ] || { fail "asset referenced by HTML is missing: $asset ($AC)"; MISSING=$((MISSING+1)); }
done <<< "$(printf '%s' "$HTML" | grep -oE '(src|href)="/(js|css)/[^"]+"' | sed -E 's/^(src|href)="//; s/"$//' | sort -u | head -40)"
[ "$CHECKED" -gt 0 ] && [ "$MISSING" -eq 0 ] && pass "$CHECKED referenced JS/CSS assets all resolve"
[ "$CHECKED" -eq 0 ] && warn "could not parse asset references from HTML"

sect "nginx"
if sudo nginx -t >/dev/null 2>&1; then pass "nginx config valid"
else fail "nginx config INVALID"; sudo nginx -t 2>&1 | sed 's/^/      /'; fi

sect "listening ports"
PORTS=$(ss -tulpn 2>/dev/null | grep -Eo ':(80|443|1935|9935|3000)\b' | sort -u | tr '\n' ' ')
[ -n "$PORTS" ] && pass "listening on:$PORTS" || warn "could not read listening ports"

sect "firewall / fail2ban (advisory)"
sudo ufw status 2>/dev/null | head -1 | sed 's/^/  /' || warn "ufw unavailable"
sudo fail2ban-client status 2>/dev/null | head -2 | sed 's/^/  /' || warn "fail2ban unavailable"

sect "recent errors in the log"
ERRS=$(journalctl -u "$SERVICE" --since '5 minutes ago' --no-pager 2>/dev/null | grep -icE 'error|unhandled|ECONNREFUSED|TypeError' || true)
if [ "${ERRS:-0}" -gt 20 ]; then fail "$ERRS error lines in the last 5 minutes"; journalctl -u "$SERVICE" -n 15 --no-pager | sed 's/^/      /'
elif [ "${ERRS:-0}" -gt 0 ]; then warn "$ERRS error line(s) in the last 5 minutes"
else pass "no error lines in the last 5 minutes"; fi

printf '\n'
if [ "$FAILED" -gt 0 ]; then
    printf '\033[31m%d required check(s) FAILED\033[0m\n' "$FAILED"
    exit 1
fi
printf '\033[32mAll required checks passed\033[0m\n'
