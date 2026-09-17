#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# OpenVibe.Live — one-time switch from an in-place checkout to the release layout
#
#   sudo deploy/scripts/migrate-to-releases.sh [--wait-idle]     (DRY_RUN=1 to print the plan)
#
# Before:  /opt/openvibe.live            git checkout + node_modules + data/
# After:   /opt/openvibe.live/repo       git clone used to create releases
#          /opt/openvibe.live/releases/<id>   worktree + its own node_modules + data -> ../../shared/data
#          /opt/openvibe.live/current    -> releases/<id>
#          /opt/openvibe.live/shared/data     live.db, analytics.db, uploads… (moved, not copied)
#          /opt/openvibe.live/data       -> shared/data   (so absolute DB_PATH values keep working)
#
# The data move needs the service stopped (SQLite files are open), so this costs one restart — the
# same interruption as any server deploy. Everything else is prepared first, while the site serves.
# If the new layout does not come up ready, the move is undone and the old unit is reinstalled.
# The old checkout files are left in place; remove them by hand once you are happy.
# ═══════════════════════════════════════════════════════════════
set -euo pipefail
BASE_DIR="${BASE_DIR:-/opt/openvibe.live}"
SERVICE="${SERVICE:-openvibe-live}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
API_URL="${API_URL:-http://127.0.0.1:3000}"
READY_TIMEOUT="${READY_TIMEOUT:-90}"
DRY_RUN="${DRY_RUN:-0}"
WAIT_IDLE=false
[ "${1:-}" = "--wait-idle" ] && WAIT_IDLE=true
say() { echo "[Migrate] $*"; }
die() { echo "[Migrate] ✗ $1" >&2; exit "${2:-1}"; }
run() { if [ "$DRY_RUN" = "1" ]; then echo "       would run: $*"; else "$@"; fi; }

[ -d "$BASE_DIR/.git" ] || die "$BASE_DIR is not a git checkout (already migrated?)"
[ -e "$BASE_DIR/current" ] && die "$BASE_DIR/current already exists"
git -C "$BASE_DIR" diff --quiet && git -C "$BASE_DIR" diff --cached --quiet || die "checkout has uncommitted changes"
SHA=$(git -C "$BASE_DIR" rev-parse HEAD)
ORIGIN=$(git -C "$BASE_DIR" remote get-url origin)
ID="$(date +%Y%m%d-%H%M%S)-${SHA:0:8}"
REL="$BASE_DIR/releases/$ID"

say "preparing (service keeps running): repo clone, release $ID, node_modules links"
run mkdir -p "$BASE_DIR/releases" "$BASE_DIR/shared"
[ -d "$BASE_DIR/repo" ] || run git clone --quiet --no-checkout "$BASE_DIR" "$BASE_DIR/repo"
run git -C "$BASE_DIR/repo" remote set-url origin "$ORIGIN"
run git -C "$BASE_DIR/repo" fetch --quiet origin
run git -C "$BASE_DIR/repo" worktree add --detach "$REL" "$SHA"
run cp -al "$BASE_DIR/node_modules" "$REL/node_modules"
run ln -sfn ../../shared/data "$REL/data"
for f in "$REL"/deploy/systemd/release/openvibe-live.service; do [ -f "$f" ] || [ "$DRY_RUN" = "1" ] || die "release has no deploy/systemd/release unit — deploy a newer commit first"; done

if [ "$WAIT_IDLE" = true ] && [ "$DRY_RUN" != "1" ]; then
    while :; do
        n=$(curl -sf --max-time 5 "$API_URL/api/streams" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log((JSON.parse(d).streams||[]).filter(s=>s.is_live).length)}catch{console.log(0)}})' || echo 0)
        [ "$n" = "0" ] && break
        say "$n live stream(s); waiting a minute"; sleep 60
    done
fi

[ "$DRY_RUN" = "1" ] && { say "dry run complete — nothing was changed."; exit 0; }

undo() {
    say "undoing: restoring the in-place layout"
    $SYSTEMCTL stop "$SERVICE" || true
    [ -L "$BASE_DIR/data" ] && rm -f "$BASE_DIR/data"
    [ -d "$BASE_DIR/shared/data" ] && mv "$BASE_DIR/shared/data" "$BASE_DIR/data"
    rm -f "$BASE_DIR/current"
    install -m 0644 "$BASE_DIR/deploy/systemd/openvibe-live.service" "$SYSTEMD_DIR/${SERVICE}.service"
    $SYSTEMCTL daemon-reload
    $SYSTEMCTL start "$SERVICE"
    die "migration rolled back; the site runs from the checkout as before" 3
}

say "stopping $SERVICE to move data (HTTP connections queue on the socket meanwhile)…"
$SYSTEMCTL stop "$SERVICE"
mv "$BASE_DIR/data" "$BASE_DIR/shared/data" || undo
ln -s shared/data "$BASE_DIR/data" || undo
ln -sfn "releases/$ID" "$BASE_DIR/current" || undo
install -m 0644 "$REL/deploy/systemd/release/openvibe-live.service" "$SYSTEMD_DIR/${SERVICE}.service" || undo
$SYSTEMCTL daemon-reload
$SYSTEMCTL start "$SERVICE" || undo
deadline=$(( $(date +%s) + READY_TIMEOUT ))
until curl -sf --max-time 5 "$API_URL/api/ready" >/dev/null 2>&1; do
    [ "$(date +%s)" -lt "$deadline" ] || undo
    sleep 1
done
say "running from releases/$ID ✅  (old checkout files in $BASE_DIR can be removed by hand)"
