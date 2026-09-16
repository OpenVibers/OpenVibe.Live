#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# OpenVibe.Live — deploy
#
# Pull, validate, install units, restart, and PROVE the new process can serve a request before
# reporting success. Rolls back to the previous commit if it cannot.
#
#   sudo /opt/openvibe.live/deploy/scripts/deploy.sh            # deploy if there are new commits
#   sudo /opt/openvibe.live/deploy/scripts/deploy.sh --restart  # redeploy/restart even if current
#   sudo /opt/openvibe.live/deploy/scripts/deploy.sh --force    # discard local tracked changes
#   DRY_RUN=1 ./deploy/scripts/deploy.sh                        # print the plan, change nothing
#
# Exit codes: 0 success · 1 usage/precondition · 2 validation failed · 3 not ready after restart
#             (rolled back) · 4 rollback itself failed — MANUAL INTERVENTION
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

FORCE_DEPLOY=false
ALWAYS_RESTART=false
while [ "$#" -gt 0 ]; do
    case "$1" in
        --force|-f|--ignore-local-changes) FORCE_DEPLOY=true; shift ;;
        --restart) ALWAYS_RESTART=true; shift ;;
        --) shift; break ;;
        *) echo "Usage: $0 [--force] [--restart]"; exit 1 ;;
    esac
done

# Defaults match AGENTS.md and deploy/systemd/. The old values (/opt/openvibelive,
# openvibelive) never matched the installed unit, so the unit-install step silently did nothing.
REPO_DIR="${REPO_DIR:-/opt/openvibe.live}"
SERVICE="${SERVICE:-openvibe-live}"
UNIT_DIR="${UNIT_DIR:-$REPO_DIR/deploy/systemd}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
SITE_URL="${SITE_URL:-https://openvibe.live}"
API_URL="${API_URL:-http://127.0.0.1:3000}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
GIT_BRANCH="${GIT_BRANCH:-main}"
READY_PATH="${READY_PATH:-/api/ready}"
UPDATES_PATH="${UPDATES_PATH:-/updates}"
BROADCAST_ENDPOINT="${BROADCAST_ENDPOINT:-/api/admin/broadcast}"
# Production boot is dominated by opening and migrating a large SQLite database; 15s was never
# enough and the old loop reported success regardless.
READY_TIMEOUT="${READY_TIMEOUT:-90}"
DRY_RUN="${DRY_RUN:-0}"
LOCK_FILE="${LOCK_FILE:-/tmp/openvibe-live-deploy.lock}"

say() { echo "[Deploy] $*"; }
die() { echo "[Deploy] ✗ $*" >&2; exit "${2:-1}"; }
run() { if [ "$DRY_RUN" = "1" ]; then echo "       would run: $*"; else "$@"; fi; }

# ── Only one deploy at a time ────────────────────────────────────────────────
# Two overlapping deploys can leave the working tree on one commit and the running process on
# another, which is the hardest kind of outage to diagnose.
exec 9>"$LOCK_FILE"
flock -n 9 || die "another deploy is already running (lock: $LOCK_FILE)"

cd "$REPO_DIR" || die "repo not found at $REPO_DIR"

echo "╔══════════════════════════════════════╗"
echo "║      OpenVibe.Live — deploy          ║"
echo "╚══════════════════════════════════════╝"
say "repo=$REPO_DIR service=$SERVICE branch=$GIT_BRANCH dry_run=$DRY_RUN"

OLD_HASH=$(git rev-parse HEAD 2>/dev/null || echo none)
say "current commit: ${OLD_HASH:0:8}"

# ── Refuse to deploy over uncommitted work unless told to ────────────────────
if [ "$FORCE_DEPLOY" = true ]; then
    say "force: discarding local tracked changes (untracked files are kept)"
    run git reset --hard HEAD
elif ! git diff --quiet || ! git diff --cached --quiet; then
    die "working tree has uncommitted changes — commit them, or re-run with --force"
fi

# ── Fetch first, decide second ───────────────────────────────────────────────
say "fetching ${GIT_REMOTE}/${GIT_BRANCH}…"
run git fetch --quiet "$GIT_REMOTE" "$GIT_BRANCH"
TARGET_HASH=$(git rev-parse "${GIT_REMOTE}/${GIT_BRANCH}" 2>/dev/null || echo "$OLD_HASH")

if [ "$OLD_HASH" = "$TARGET_HASH" ] && [ "$ALWAYS_RESTART" != true ]; then
    # The old script restarted here anyway — a free outage for no change at all.
    say "already at ${TARGET_HASH:0:8}; nothing to deploy."
    say "pass --restart if you actually want to bounce the service."
    exit 0
fi

CHANGED_FILES=""
if [ "$OLD_HASH" != "$TARGET_HASH" ]; then
    CHANGED_FILES=$(git diff --name-only "$OLD_HASH" "$TARGET_HASH" || true)
    COMMIT_LOG=$(git --no-pager log --oneline "${OLD_HASH}..${TARGET_HASH}" 2>/dev/null || echo "Update deployed")
    COMMIT_COUNT=$(printf '%s\n' "$COMMIT_LOG" | grep -c . || true)
    say "$COMMIT_COUNT new commit(s):"
    printf '%s\n' "$COMMIT_LOG" | sed 's/^/         /'
else
    COMMIT_LOG="Restart requested"; COMMIT_COUNT=0
fi

# ── Validate BEFORE interrupting anything ────────────────────────────────────
# Everything below happens while the old process is still serving traffic.
say "validating the target revision…"
run git merge --ff-only "$TARGET_HASH" >/dev/null 2>&1 || {
    [ "$DRY_RUN" = "1" ] || die "fast-forward to ${TARGET_HASH:0:8} failed — diverged history" 2
}
NEW_HASH=$(git rev-parse HEAD)

# Syntax-check every JS file the release touches. A parse error caught here costs nothing; the
# same error caught by systemd costs an outage plus a rollback.
if [ -n "$CHANGED_FILES" ]; then
    CHECKED=0
    while IFS= read -r f; do
        case "$f" in
            *.js) [ -f "$f" ] || continue
                  node --check "$f" >/dev/null 2>&1 || die "syntax error in $f" 2
                  CHECKED=$((CHECKED+1)) ;;
        esac
    done <<< "$CHANGED_FILES"
    say "syntax-checked $CHECKED changed JS file(s)"
fi

# Dependencies: only when the lockfile actually moved. npm ci rebuilds native modules
# (better-sqlite3, mediasoup, sharp, onnxruntime), which is slow and must not run on every deploy.
if printf '%s\n' "$CHANGED_FILES" | grep -qx 'package-lock.json\|package.json'; then
    say "lockfile changed — installing dependencies (service still running)…"
    run npm ci --omit=dev --no-audit --no-fund || die "npm ci failed" 2
else
    say "dependencies unchanged — skipping npm ci"
fi

# ── systemd units ────────────────────────────────────────────────────────────
UNITS_CHANGED=false
install_unit() {
    local src="$1" dest="$2"
    [ -f "$src" ] || return 0
    if [ ! -f "$dest" ] || ! cmp -s "$src" "$dest"; then
        say "installing $(basename "$dest")"
        run install -m 0644 -D "$src" "$dest"
        UNITS_CHANGED=true
    fi
}
install_unit "$UNIT_DIR/${SERVICE}.service" "$SYSTEMD_DIR/${SERVICE}.service"
install_unit "$UNIT_DIR/${SERVICE}.socket"  "$SYSTEMD_DIR/${SERVICE}.socket"
install_unit "$UNIT_DIR/${SERVICE}.service.d/socket.conf" "$SYSTEMD_DIR/${SERVICE}.service.d/socket.conf"
if [ "$UNITS_CHANGED" = true ]; then
    run systemctl daemon-reload
    run systemctl enable "${SERVICE}.socket" >/dev/null 2>&1 || true
    run systemctl enable "$SERVICE" >/dev/null 2>&1 || true
fi

if [ "$DRY_RUN" = "1" ]; then say "dry run complete — nothing was changed."; exit 0; fi

# ── Tell chat, then restart ──────────────────────────────────────────────────
FIRST_LINE=$(printf '%s\n' "$COMMIT_LOG" | head -1 | sed 's/^[a-f0-9]* //')
CHAT_SUMMARY=$([ "$COMMIT_COUNT" -le 1 ] && echo "Update: ${FIRST_LINE}" || echo "${COMMIT_COUNT} updates deployed — ${FIRST_LINE}")
curl -sf -X POST "${API_URL}${BROADCAST_ENDPOINT}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${ADMIN_TOKEN:-}" \
    -d "{\"type\":\"update\",\"summary\":$(printf '%s' "$CHAT_SUMMARY" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),\"url\":\"${SITE_URL}${UPDATES_PATH}\"}" \
    >/dev/null 2>&1 && say "chat notified" || say "chat notification skipped"

# The socket unit, when present, holds the listener across the restart so connections queue
# instead of being refused. It does NOT preserve established WebSocket/WHIP/RTMP sessions.
if systemctl list-unit-files "${SERVICE}.socket" >/dev/null 2>&1 && systemctl is-enabled "${SERVICE}.socket" >/dev/null 2>&1; then
    systemctl is-active --quiet "${SERVICE}.socket" || systemctl start "${SERVICE}.socket" || true
    say "socket unit active — HTTP connections will queue through the restart"
else
    say "no socket unit active — expect brief connection refusals during restart"
fi

say "restarting ${SERVICE}…"
START_TS=$(date +%s)
systemctl restart "$SERVICE"

# ── Readiness gate that is actually a gate ───────────────────────────────────
# /api/health answers "a process is listening", which is true long before the database is open.
# /api/ready answers "this process can serve a real request". The old loop polled health and then
# printed success whether or not it ever succeeded.
wait_ready() {
    local deadline=$(( $(date +%s) + READY_TIMEOUT ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        if curl -sf --max-time 5 "${API_URL}${READY_PATH}" >/dev/null 2>&1; then return 0; fi
        systemctl is-active --quiet "$SERVICE" || { say "service is not running"; return 1; }
        sleep 1; printf '.'
    done
    printf '\n'; return 1
}
printf '[Deploy] waiting for readiness'
if wait_ready; then
    printf '\n'
    say "ready after $(( $(date +%s) - START_TS ))s"
else
    say "✗ not ready within ${READY_TIMEOUT}s — rolling back to ${OLD_HASH:0:8}"
    journalctl -u "$SERVICE" -n 40 --no-pager | sed 's/^/         /' || true
    git reset --hard "$OLD_HASH" >/dev/null 2>&1 || die "ROLLBACK FAILED: could not reset to $OLD_HASH" 4
    systemctl restart "$SERVICE" || die "ROLLBACK FAILED: service would not restart" 4
    printf '[Deploy] waiting for rollback'
    if wait_ready; then printf '\n'; say "rolled back to ${OLD_HASH:0:8} and serving"; exit 3; fi
    die "ROLLBACK FAILED: ${OLD_HASH:0:8} is not ready either — MANUAL INTERVENTION REQUIRED" 4
fi

# ── Post-conditions ──────────────────────────────────────────────────────────
SERVED=$(curl -sf --max-time 5 "${API_URL}/api/health" || echo '')
[ -n "$SERVED" ] || die "health endpoint not responding after readiness" 3

say "deployed ${OLD_HASH:0:8} → ${NEW_HASH:0:8} (${COMMIT_COUNT} commit(s))"
say "note: established WebSocket, WHIP, RTMP and WebRTC sessions were reconnected, not preserved."
say "done ✅"
