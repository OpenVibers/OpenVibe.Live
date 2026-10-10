#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# OpenVibe.Live — deploy (a thin wrapper around `ovhost deploy live`)
#
# OpenVibe.Host's ovhost (/usr/local/bin/ovhost, strategy "release-layout", roadmap WS-N task 11) now
# does what this script did: a new release is prepared in releases/<time>-<sha8> while `current` serves
# (npm ci only when dependencies changed, else node_modules hard-linked; node --check on changed files),
# `current` switches atomically, public/ and docs/ switch without a restart, the socket unit stays held by
# systemd (rebound only when its unit file changed or pid 1 does not hold :3000), readiness gates the
# restart, a release that is not ready is switched back (exit 3), old releases are pruned, and the release
# is announced. See OpenVibe.Host docs/deploy-strategies.md.
#
#   sudo deploy/scripts/deploy.sh                  ovhost deploy live
#   sudo deploy/scripts/deploy.sh --wait-idle      ovhost deploy live --wait-idle   (hold a restart until nobody is live)
#   sudo deploy/scripts/deploy.sh --restart        ovhost deploy live --restart
#   sudo deploy/scripts/deploy.sh --rollback       ovhost rollback live             (the release the current one replaced)
#   DRY_RUN=1 deploy/scripts/deploy.sh             ovhost plan live                 (changes nothing)
#   READY_TIMEOUT=<s>                              --ready-timeout <s>
#
# ovhost --force drops live streams (and passes a freeze), so the wrapper refuses it: run
# `sudo ovhost deploy live --force` yourself when that is what you mean.
#
# OVHOST=<path> picks another ovhost. An unavailable or incompatible ovhost is an error.
#
# Exit codes are ovhost's, the same as before: 0 ok · 1 usage/precondition · 2 validation failed, nothing
# restarted · 3 not ready, rolled back · 4 rollback failed (manual intervention) · 5 protected sessions ·
# 6 frozen (ovhost freeze).
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

SERVICE=live
STRATEGY=release-layout
OVHOST="${OVHOST:-/usr/local/bin/ovhost}"
# ovhost runs as root; tests set OVHOST_SUDO= to call it directly.
if [ "${OVHOST_SUDO-auto}" = auto ]; then if [ "$(id -u)" -eq 0 ]; then SUDO=(); else SUDO=(sudo); fi; elif [ -n "${OVHOST_SUDO}" ]; then SUDO=("$OVHOST_SUDO"); else SUDO=(); fi

say() { echo "[Deploy] $*"; }

CMD=deploy
FLAGS=()
FORCE=false
while [ "$#" -gt 0 ]; do
    case "$1" in
        --wait-idle) FLAGS+=(--wait-idle); shift ;;
        --restart) FLAGS+=(--restart); shift ;;
        --rollback) CMD=rollback; shift ;;
        --force|-f|--ignore-local-changes) FORCE=true; shift ;;
        --) shift; break ;;
        *) echo "Usage: $0 [--wait-idle] [--restart] [--rollback]   (DRY_RUN=1 for the plan)"; exit 1 ;;
    esac
done
[ -n "${READY_TIMEOUT:-}" ] && FLAGS+=(--ready-timeout "$READY_TIMEOUT")

# Does this ovhost deploy live with the strategy this wrapper hands over to? Sets REASON when not.
REASON=""
probe() {
    if ! command -v "$OVHOST" >/dev/null 2>&1; then REASON="ovhost not found ($OVHOST)"; return 1; fi
    local caps api
    if ! caps=$("${SUDO[@]}" "$OVHOST" capabilities "$SERVICE" 2>/dev/null); then REASON="this ovhost has no 'capabilities' (too old) or no inventory entry for $SERVICE"; return 1; fi
    api=$(printf '%s\n' "$caps" | sed -n 's/^deploy-api=//p')
    case "$api" in ''|*[!0-9]*) REASON="this ovhost reports no deploy-api (too old)"; return 1 ;; esac
    if [ "$api" -lt 1 ]; then REASON="this ovhost's deploy-api is $api, 1 is needed"; return 1; fi
    if ! printf '%s\n' "$caps" | grep -qx "strategy=$STRATEGY"; then REASON="the host inventory does not deploy $SERVICE with strategy $STRATEGY ($(printf '%s\n' "$caps" | sed -n 's/^strategy=//p'))"; return 1; fi
    if ! printf '%s\n' "$caps" | grep -qx "managed=yes"; then REASON="ovhost does not manage $SERVICE"; return 1; fi
    return 0
}

if ! probe; then echo "[Deploy] ✗ $REASON" >&2; exit 1; fi

if [ "$FORCE" = true ]; then
    echo "[Deploy] ✗ --force drops live streams and passes a freeze." >&2
    echo "[Deploy]   Run: sudo $OVHOST ${CMD} ${SERVICE} --force   if that is what you mean." >&2
    exit 1
fi
if [ "${DRY_RUN:-0}" = 1 ]; then
    say "ovhost plan $SERVICE (DRY_RUN=1: nothing changes)"
    exec "${SUDO[@]}" "$OVHOST" plan "$SERVICE"
fi
say "ovhost $CMD $SERVICE ${FLAGS[*]:-}"
exec "${SUDO[@]}" "$OVHOST" "$CMD" "$SERVICE" "${FLAGS[@]}"
