#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# OpenVibe.Live — Deploy Script
# Pulls latest from GitHub, notifies chat, and restarts the service.
#
# Usage (from the server):
#   sudo /opt/openvibelive/deploy/scripts/deploy.sh
#
# Or remotely:
#   ssh openvibe.tools "sudo /opt/openvibelive/deploy/scripts/deploy.sh"
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

FORCE_DEPLOY=false
while [ "$#" -gt 0 ]; do
    case "$1" in
        --force|-f|--ignore-local-changes)
            FORCE_DEPLOY=true
            shift
            ;;
        --)
            shift
            break
            ;;
        *)
            echo "Usage: $0 [--force]"
            exit 1
            ;;
    esac
done

REPO_DIR="${REPO_DIR:-/opt/openvibelive}"
SERVICE="${SERVICE:-openvibelive}"
SERVICE_UNIT_SOURCE="${SERVICE_UNIT_SOURCE:-$REPO_DIR/deploy/systemd/${SERVICE}.service}"
SERVICE_UNIT_DEST="${SERVICE_UNIT_DEST:-/etc/systemd/system/${SERVICE}.service}"
SITE_URL="${SITE_URL:-https://openvibe.live}"
API_URL="${API_URL:-http://127.0.0.1:3000}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
GIT_BRANCH="${GIT_BRANCH:-main}"
HEALTH_PATH="${HEALTH_PATH:-/api/health}"
UPDATES_PATH="${UPDATES_PATH:-/updates}"
BROADCAST_ENDPOINT="${BROADCAST_ENDPOINT:-/api/admin/broadcast}"
DEPLOY_TIMEOUT="${DEPLOY_TIMEOUT:-15}"

cd "$REPO_DIR"

echo "╔══════════════════════════════════════╗"
echo "║    🏕️  OpenVibe.Live Deploy Script     ║"
echo "╚══════════════════════════════════════╝"
echo ""

# 1. Record current commit before pull
OLD_HASH=$(git rev-parse HEAD 2>/dev/null || echo "none")
echo "[Deploy] Current commit: ${OLD_HASH:0:8}"

# 2. Pull latest from GitHub
if [ "$FORCE_DEPLOY" = true ]; then
    echo "[Deploy] Force deploy enabled: discarding local tracked changes before pulling."
    echo "[Deploy] Untracked files will be preserved to avoid removing runtime downloads or temp artifacts."
    git reset --hard HEAD
fi

echo "[Deploy] Pulling from ${GIT_REMOTE} ${GIT_BRANCH}..."
git pull "$GIT_REMOTE" "$GIT_BRANCH" --ff-only
NEW_HASH=$(git rev-parse HEAD)
echo "[Deploy] New commit: ${NEW_HASH:0:8}"

# 3. Update systemd service config if the repo includes one
UNIT_UPDATED=false
if [ -f "$SERVICE_UNIT_SOURCE" ]; then
    echo "[Deploy] Found service unit source: ${SERVICE_UNIT_SOURCE}"
    if [ ! -f "$SERVICE_UNIT_DEST" ] || ! cmp -s "$SERVICE_UNIT_SOURCE" "$SERVICE_UNIT_DEST"; then
        echo "[Deploy] Installing updated service unit to ${SERVICE_UNIT_DEST}"
        sudo cp "$SERVICE_UNIT_SOURCE" "$SERVICE_UNIT_DEST"
        sudo chmod 644 "$SERVICE_UNIT_DEST"
        UNIT_UPDATED=true
    else
        echo "[Deploy] Service unit is already up to date."
    fi
    if [ "$UNIT_UPDATED" = true ]; then
        echo "[Deploy] Reloading systemd daemon..."
        sudo systemctl daemon-reload
        sudo systemctl enable "$SERVICE" >/dev/null 2>&1 || true
    fi
else
    echo "[Deploy] No service unit file found at ${SERVICE_UNIT_SOURCE}, skipping systemd update."
fi

# 4. Check if there are actually new commits
if [ "$OLD_HASH" = "$NEW_HASH" ]; then
    echo "[Deploy] Already up to date — no new commits."
    echo "[Deploy] Restarting service anyway..."
    sudo systemctl restart "$SERVICE"
    echo "[Deploy] Done. ✅"
    exit 0
fi

# 5. Get commit log between old and new
COMMIT_LOG=$(git --no-pager log --oneline "${OLD_HASH}..${NEW_HASH}" 2>/dev/null || echo "Update deployed")
COMMIT_COUNT=$(echo "$COMMIT_LOG" | wc -l | tr -d ' ')
echo "[Deploy] ${COMMIT_COUNT} new commit(s):"
echo "$COMMIT_LOG"
echo ""

# 5. Build a summary for the chat notification (first 3 lines max)
SUMMARY_LINES=$(echo "$COMMIT_LOG" | head -3)
if [ "$COMMIT_COUNT" -gt 3 ]; then
    SUMMARY="${SUMMARY_LINES}
...and $((COMMIT_COUNT - 3)) more"
else
    SUMMARY="$SUMMARY_LINES"
fi

# Single-line summary for the chat message
FIRST_LINE=$(echo "$COMMIT_LOG" | head -1 | sed 's/^[a-f0-9]* //')
if [ "$COMMIT_COUNT" -eq 1 ]; then
    CHAT_SUMMARY="Update: ${FIRST_LINE}"
else
    CHAT_SUMMARY="${COMMIT_COUNT} updates deployed — ${FIRST_LINE}"
fi

# 6. Send update notification to chat (before restart)
echo "[Deploy] Notifying chat..."
UPDATES_URL="${SITE_URL}${UPDATES_PATH}"
NOTIFY_URL="${API_URL}${BROADCAST_ENDPOINT}"
# Use the admin broadcast endpoint if we have an admin token, otherwise skip
# The server will also send a restart message automatically on SIGTERM
curl -sf -X POST "${NOTIFY_URL}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${ADMIN_TOKEN:-}" \
    -d "{
        \"type\": \"update\",
        \"summary\": $(echo "$CHAT_SUMMARY" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'),
        \"url\": \"${UPDATES_URL}\"
    }" 2>/dev/null && echo "[Deploy] Chat notified ✅" || echo "[Deploy] Chat notification skipped (no admin token or server down)"

# 7. Restart the service (this triggers graceful shutdown → server_restart message)
echo "[Deploy] Restarting ${SERVICE}..."
sudo systemctl restart "$SERVICE"

# 8. Wait for service to come back up
echo -n "[Deploy] Waiting for server..."
for i in $(seq 1 "${DEPLOY_TIMEOUT}"); do
    sleep 1
    if curl -sf "${API_URL}${HEALTH_PATH}" > /dev/null 2>&1; then
        echo " up! ✅"
        break
    fi
    echo -n "."
done

echo ""
echo "[Deploy] Deployment complete! 🎉"
echo "[Deploy] ${COMMIT_COUNT} commit(s) deployed: ${OLD_HASH:0:8} → ${NEW_HASH:0:8}"
