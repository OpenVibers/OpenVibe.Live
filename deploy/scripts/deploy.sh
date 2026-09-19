#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# OpenVibe.Live — deploy
#
# Fetch, classify what changed, prepare, and do the least disruptive thing that makes it live.
#
#   sudo deploy/scripts/deploy.sh                  deploy origin/main if it moved
#   sudo deploy/scripts/deploy.sh --wait-idle      hold a restart until nobody is live (max 8h)
#   sudo deploy/scripts/deploy.sh --restart        restart even if nothing changed
#   sudo deploy/scripts/deploy.sh --rollback       release layout: switch back to the previous release
#   sudo deploy/scripts/deploy.sh --force          legacy layout: discard local tracked changes
#   DRY_RUN=1 deploy/scripts/deploy.sh             print the plan, change nothing
#
# What a change costs (see docs/deploy.md):
#   docs/, README etc., tests      no process restart; the new files are just in place
#   public/                        no restart — the server re-reads HTML and assets (content-hashed)
#   server/, vendor/, package*     restart; HTTP connections queue on the systemd socket, but live
#                                  WebSocket, WHIP, WebRTC and RTMP sessions are dropped and reconnect
#   package-lock.json              dependencies installed BEFORE anything is interrupted
#   deploy/systemd/                units installed, daemon-reload, restart
#   deploy/nginx/                  never auto-installed (the live config is generated elsewhere);
#                                  the script says so
#
# Two layouts:
#   release  /opt/openvibe.live/releases/<id> (code + node_modules), current -> releases/<id>,
#            shared/data. A deploy builds a new release while the old one serves; switching is an
#            atomic symlink rename; rollback switches back to a release that still has its own
#            node_modules. Set up once with deploy/scripts/migrate-to-releases.sh.
#   legacy   /opt/openvibe.live is a git checkout (what production runs until migrated).
#
# Exit codes: 0 success · 1 usage/precondition · 2 validation failed · 3 not ready after restart
#             (rolled back) · 4 rollback itself failed — MANUAL INTERVENTION · 5 gave up waiting for idle
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

FORCE_DEPLOY=false
ALWAYS_RESTART=false
WAIT_IDLE=false
ROLLBACK=false
while [ "$#" -gt 0 ]; do
    case "$1" in
        --force|-f|--ignore-local-changes) FORCE_DEPLOY=true; shift ;;
        --restart) ALWAYS_RESTART=true; shift ;;
        --wait-idle) WAIT_IDLE=true; shift ;;
        --rollback) ROLLBACK=true; shift ;;
        --) shift; break ;;
        *) echo "Usage: $0 [--wait-idle] [--restart] [--rollback] [--force]"; exit 1 ;;
    esac
done

BASE_DIR="${BASE_DIR:-/opt/openvibe.live}"
SERVICE="${SERVICE:-openvibe-live}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
# Unit files land in /etc: when systemctl is being run through sudo, so is the install.
SUDO_INSTALL=""; case "$SYSTEMCTL" in sudo*) SUDO_INSTALL="sudo";; esac; [ "$(id -u)" -eq 0 ] && SUDO_INSTALL=""
SITE_URL="${SITE_URL:-https://openvibe.live}"
API_URL="${API_URL:-http://127.0.0.1:3000}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
GIT_BRANCH="${GIT_BRANCH:-main}"
READY_PATH="${READY_PATH:-/api/ready}"
UPDATES_PATH="${UPDATES_PATH:-/updates}"
BROADCAST_ENDPOINT="${BROADCAST_ENDPOINT:-/api/admin/broadcast}"
READY_TIMEOUT="${READY_TIMEOUT:-90}"
IDLE_MAX_SECONDS="${IDLE_MAX_SECONDS:-28800}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
NPM="${NPM:-npm}"
DRY_RUN="${DRY_RUN:-0}"
# Not /tmp: fs.protected_regular stops root from reopening a lock a plain user created there.
LOCK_FILE="${LOCK_FILE:-$BASE_DIR/.deploy.lock}"

say() { echo "[Deploy] $*"; }
die() { echo "[Deploy] ✗ $1" >&2; exit "${2:-1}"; }
run() { if [ "$DRY_RUN" = "1" ]; then echo "       would run: $*"; else "$@"; fi; }

exec 9>"$LOCK_FILE"
flock -n 9 || die "another deploy is already running (lock: $LOCK_FILE)"

if [ -d "$BASE_DIR/releases" ] && [ -L "$BASE_DIR/current" ]; then LAYOUT=release; else LAYOUT=legacy; fi

echo "╔══════════════════════════════════════╗"
echo "║      OpenVibe.Live — deploy          ║"
echo "╚══════════════════════════════════════╝"
say "base=$BASE_DIR layout=$LAYOUT service=$SERVICE branch=$GIT_BRANCH dry_run=$DRY_RUN"

# ── Classification ───────────────────────────────────────────────────────────
# Prints one word per category that the changed file list touches.
classify() {
    local files="$1" cats=""
    add() { case " $cats " in *" $1 "*) ;; *) cats="$cats $1" ;; esac; }
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        case "$f" in
            package.json|package-lock.json) add deps; add server ;;
            server/db/migrations.js|server/db/schema.sql) add schema; add server ;;
            server/*|vendor/*|.env.example) add server ;;
            public/*) add static ;;
            deploy/systemd/*) add systemd ;;
            deploy/nginx/*) add nginx ;;
            docs/*) add static ;;
            *) add none ;;
        esac
    done <<< "$files"
    echo "$cats"
}
has() { case " $1 " in *" $2 "*) return 0 ;; *) return 1 ;; esac; }

# Whether package.json changed in a way that needs an install (scripts/description edits do not).
deps_changed() {
    local from="$1" to="$2" dir="$3"
    git -C "$dir" diff --quiet "$from" "$to" -- package-lock.json || return 0
    local a b
    a=$(git -C "$dir" show "$from:package.json" 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);console.log(JSON.stringify([j.dependencies,j.optionalDependencies,j.engines]))}catch{console.log("x")}})')
    b=$(git -C "$dir" show "$to:package.json" 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);console.log(JSON.stringify([j.dependencies,j.optionalDependencies,j.engines]))}catch{console.log("y")}})')
    [ "$a" != "$b" ]
}

# ── Live-stream guard ────────────────────────────────────────────────────────
# A restart drops every RTMP/WHIP/WebRTC publisher. Socket activation keeps HTTP accepting, nothing more.
live_count() {
    curl -sf --max-time 5 "${API_URL}/api/streams" 2>/dev/null \
        | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);console.log((j.streams||[]).filter(s=>s.is_live).length)}catch{console.log(0)}})' \
        || echo 0
}
wait_for_idle() {
    [ "$WAIT_IDLE" = true ] || return 0
    local waited=0 quiet=0
    while [ "$waited" -lt "$IDLE_MAX_SECONDS" ]; do
        local n; n=$(live_count)
        if [ "$n" = "0" ]; then quiet=$((quiet+1)); else quiet=0; fi
        [ "$quiet" -ge 2 ] && { say "no one live for two checks — proceeding"; return 0; }
        say "$n live stream(s); holding the restart (${waited}s waited)"
        [ "$DRY_RUN" = "1" ] && return 0
        sleep 60; waited=$((waited+60))
    done
    die "still live after ${IDLE_MAX_SECONDS}s; nothing was restarted" 5
}

wait_ready() {
    local deadline=$(( $(date +%s) + READY_TIMEOUT ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        if curl -sf --max-time 5 "${API_URL}${READY_PATH}" >/dev/null 2>&1; then return 0; fi
        $SYSTEMCTL is-active --quiet "$SERVICE" || { say "service is not running"; return 1; }
        sleep 1; printf '.'
    done
    printf '\n'; return 1
}

notify_chat() {
    local summary="$1"
    curl -sf -X POST "${API_URL}${BROADCAST_ENDPOINT}" \
        -H "Content-Type: application/json" -H "Authorization: Bearer ${ADMIN_TOKEN:-}" \
        -d "{\"type\":\"update\",\"summary\":$(printf '%s' "$summary" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.stringify(d.trim())))'),\"url\":\"${SITE_URL}${UPDATES_PATH}\"}" \
        >/dev/null 2>&1 && say "chat notified" || say "chat notification skipped"
}

install_units() {
    local unit_dir="$1" changed=false
    install_unit() {
        local src="$1" dest="$2"
        [ -f "$src" ] || return 0
        if [ ! -f "$dest" ] || ! cmp -s "$src" "$dest"; then
            say "installing $(basename "$dest")"
            run $SUDO_INSTALL install -m 0644 -D "$src" "$dest"
            changed=true
        fi
    }
    install_unit "$unit_dir/${SERVICE}.service" "$SYSTEMD_DIR/${SERVICE}.service"
    install_unit "$unit_dir/${SERVICE}.socket" "$SYSTEMD_DIR/${SERVICE}.socket"
    install_unit "$unit_dir/${SERVICE}.service.d/socket.conf" "$SYSTEMD_DIR/${SERVICE}.service.d/socket.conf"
    if [ "$changed" = true ]; then
        run $SYSTEMCTL daemon-reload
        run $SYSTEMCTL enable "${SERVICE}.socket" >/dev/null 2>&1 || true
        run $SYSTEMCTL enable "$SERVICE" >/dev/null 2>&1 || true
    fi
}

syntax_check() {
    local dir="$1" files="$2" checked=0
    while IFS= read -r f; do
        case "$f" in
            *.js) [ -f "$dir/$f" ] || continue
                  node --check "$dir/$f" >/dev/null 2>&1 || die "syntax error in $f" 2
                  checked=$((checked+1)) ;;
            *.json) [ -f "$dir/$f" ] || continue
                  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$dir/$f" 2>/dev/null || die "invalid JSON in $f" 2 ;;
        esac
    done <<< "$files"
    say "syntax-checked $checked changed JS file(s)"
}

backup_db() {
    # A schema migration is about to run on restart: take a consistent online copy first.
    local db="$1"
    [ -f "$db" ] || { say "no database at $db to back up"; return 0; }
    local out; out="$(dirname "$db")/backups/live-$(date +%Y%m%d-%H%M%S).db"
    run mkdir -p "$(dirname "$out")"
    say "schema changed — backing up $(basename "$db") to $out"
    if [ "$DRY_RUN" != "1" ]; then
        (cd "$2" && node -e 'const D=require("better-sqlite3");new D(process.argv[1],{readonly:true}).backup(process.argv[2]).then(()=>process.exit(0),e=>{console.error(e.message);process.exit(1)})' "$db" "$out") \
            || die "database backup failed; nothing was restarted" 2
    fi
}

restart_and_verify() {
    local on_fail="$1"
    if $SYSTEMCTL list-unit-files "${SERVICE}.socket" >/dev/null 2>&1 && $SYSTEMCTL is-enabled --quiet "${SERVICE}.socket" 2>/dev/null; then
        $SYSTEMCTL is-active --quiet "${SERVICE}.socket" || $SYSTEMCTL start "${SERVICE}.socket" || true
        say "socket unit active — new HTTP connections queue through the restart"
    fi
    say "restarting ${SERVICE}…"
    local start; start=$(date +%s)
    $SYSTEMCTL restart "$SERVICE" 9>&-
    printf '[Deploy] waiting for readiness'
    if wait_ready; then
        printf '\n'; say "ready after $(( $(date +%s) - start ))s"
        return 0
    fi
    say "✗ not ready within ${READY_TIMEOUT}s"
    journalctl -u "$SERVICE" -n 40 --no-pager 2>/dev/null | sed 's/^/         /' || true
    $on_fail
}

# ═══════════════════════════════════════════════════════════════
# Release layout
# ═══════════════════════════════════════════════════════════════
if [ "$LAYOUT" = release ]; then
    REPO="$BASE_DIR/repo"
    CURRENT=$(readlink -f "$BASE_DIR/current")
    CUR_ID=$(basename "$CURRENT")
    CUR_SHA=$(git -C "$CURRENT" rev-parse HEAD 2>/dev/null || echo none)
    say "current release: $CUR_ID (${CUR_SHA:0:8})"

    switch_to() {
        # Atomic: create the new link beside the old one and rename over it.
        local target="$1"
        run ln -sfn "$target" "$BASE_DIR/.current.tmp"
        run mv -Tf "$BASE_DIR/.current.tmp" "$BASE_DIR/current"
    }

    if [ "$ROLLBACK" = true ]; then
        PREV=$(ls -1dt "$BASE_DIR"/releases/*/ 2>/dev/null | sed 's:/$::' | grep -vx "$CURRENT" | head -1 || true)
        [ -n "$PREV" ] || die "no previous release to roll back to"
        PREV_SHA=$(git -C "$PREV" rev-parse HEAD 2>/dev/null || echo none)
        CATS=$(classify "$(git -C "$REPO" diff --name-only "$PREV_SHA" "$CUR_SHA" 2>/dev/null || echo server/)")
        say "rolling back to $(basename "$PREV") (${PREV_SHA:0:8}); change classes:${CATS}"
        [ "$DRY_RUN" = "1" ] && { say "dry run complete — nothing was changed."; exit 0; }
        switch_to "$PREV"
        if has "$CATS" server || has "$CATS" systemd || [ "$ALWAYS_RESTART" = true ]; then
            install_units "$PREV/deploy/systemd/release"
            wait_for_idle
            restart_and_verify 'die "ROLLBACK RELEASE IS NOT READY — MANUAL INTERVENTION REQUIRED" 4'
        else
            say "static-only difference — switched without a restart"
        fi
        # Keep the release we left so it can be re-selected; just move it out of "newest".
        touch -h "$PREV"
        say "rolled back to $(basename "$PREV") ✅"
        exit 0
    fi

    say "fetching ${GIT_REMOTE}/${GIT_BRANCH}…"
    run git -C "$REPO" fetch --quiet "$GIT_REMOTE" "$GIT_BRANCH"
    TARGET_SHA=$(git -C "$REPO" rev-parse "${GIT_REMOTE}/${GIT_BRANCH}")
    if [ "$TARGET_SHA" = "$CUR_SHA" ] && [ "$ALWAYS_RESTART" != true ]; then
        say "already at ${TARGET_SHA:0:8}; nothing to deploy."
        exit 0
    fi

    CHANGED=$(git -C "$REPO" diff --name-only "$CUR_SHA" "$TARGET_SHA" 2>/dev/null || true)
    CATS=$(classify "$CHANGED")
    [ "$TARGET_SHA" = "$CUR_SHA" ] && CATS=" server"
    COMMIT_LOG=$(git -C "$REPO" --no-pager log --oneline "${CUR_SHA}..${TARGET_SHA}" 2>/dev/null || echo "Restart requested")
    COMMIT_COUNT=$(printf '%s\n' "$COMMIT_LOG" | grep -c . || true)
    say "$COMMIT_COUNT new commit(s); change classes:${CATS:- none}"
    printf '%s\n' "$COMMIT_LOG" | sed 's/^/         /'

    NEW_ID="$(date +%Y%m%d-%H%M%S)-${TARGET_SHA:0:8}"
    NEW="$BASE_DIR/releases/$NEW_ID"
    say "preparing release $NEW_ID while $CUR_ID keeps serving…"
    run git -C "$REPO" worktree add --detach "$NEW" "$TARGET_SHA" >/dev/null
    [ "$DRY_RUN" = "1" ] || syntax_check "$NEW" "$CHANGED"
    run ln -sfn ../../shared/data "$NEW/data"

    if [ "$DRY_RUN" != "1" ] && deps_changed "$CUR_SHA" "$TARGET_SHA" "$REPO"; then
        say "dependencies changed — installing into the new release (nothing interrupted yet)…"
        (cd "$NEW" && $NPM ci --omit=dev --no-audit --no-fund) || { git -C "$REPO" worktree remove --force "$NEW" || true; die "npm ci failed; the current release is untouched" 2; }
    else
        # Same lockfile: hard-link the current release's node_modules — instant, no extra disk, and the
        # new release still owns its own tree (npm never writes into an installed package in place).
        say "dependencies unchanged — linking node_modules from $CUR_ID"
        run cp -al "$CURRENT/node_modules" "$NEW/node_modules"
    fi

    if has "$CATS" nginx; then
        say "note: deploy/nginx changed and is NOT installed by this script — copy it to /etc/nginx/sites-available,"
        say "      run nginx -t and reload (OpenVibe.Network's generator mirrors it)."
    fi

    [ "$DRY_RUN" = "1" ] && { say "dry run complete — nothing was changed."; exit 0; }

    NEEDS_RESTART=false
    if has "$CATS" server || has "$CATS" systemd || [ "$ALWAYS_RESTART" = true ]; then NEEDS_RESTART=true; fi

    if [ "$NEEDS_RESTART" = true ]; then
        wait_for_idle
        has "$CATS" schema && backup_db "$BASE_DIR/shared/data/live.db" "$NEW"
        FIRST_LINE=$(printf '%s\n' "$COMMIT_LOG" | head -1 | sed 's/^[a-f0-9]* //')
        notify_chat "$([ "$COMMIT_COUNT" -le 1 ] && echo "Update: ${FIRST_LINE}" || echo "${COMMIT_COUNT} updates deployed — ${FIRST_LINE}")"
        switch_to "$NEW"
        install_units "$NEW/deploy/systemd/release"
        rollback_release() {
            say "rolling back to $CUR_ID"
            switch_to "$CURRENT"
            install_units "$CURRENT/deploy/systemd/release"
            $SYSTEMCTL restart "$SERVICE" 9>&- || die "ROLLBACK FAILED: service would not restart" 4
            printf '[Deploy] waiting for rollback'
            if wait_ready; then printf '\n'; say "rolled back to $CUR_ID and serving"; exit 3; fi
            die "ROLLBACK FAILED: $CUR_ID is not ready either — MANUAL INTERVENTION REQUIRED" 4
        }
        restart_and_verify rollback_release
        say "note: established WebSocket, WHIP, RTMP and WebRTC sessions were reconnected, not preserved."
    else
        switch_to "$NEW"
        # The running process reads public/ and docs/ through the `current` link (OV_APP_ROOT), and
        # re-hashes assets within ~2s. Confirm the site answers; no process was restarted.
        sleep 3
        curl -sf --max-time 10 "${API_URL}${READY_PATH}" >/dev/null || { switch_to "$CURRENT"; die "site not ready after switching — switched back to $CUR_ID" 3; }
        say "switched to $NEW_ID without a restart (change classes:${CATS})"
    fi

    # Prune old releases (never the current one, never the one we just left).
    ls -1dt "$BASE_DIR"/releases/*/ 2>/dev/null | sed 's:/$::' | tail -n +$((KEEP_RELEASES+1)) | while read -r old; do
        [ "$old" = "$(readlink -f "$BASE_DIR/current")" ] && continue
        [ "$old" = "$CURRENT" ] && continue
        say "pruning $(basename "$old")"
        git -C "$REPO" worktree remove --force "$old" 2>/dev/null || rm -rf "$old"
    done
    git -C "$REPO" worktree prune 2>/dev/null || true
    say "deployed $CUR_ID → $NEW_ID ✅"
    exit 0
fi

# ═══════════════════════════════════════════════════════════════
# Legacy layout (git checkout in place)
# ═══════════════════════════════════════════════════════════════
[ "$ROLLBACK" = true ] && die "--rollback needs the release layout (deploy/scripts/migrate-to-releases.sh)"
REPO_DIR="$BASE_DIR"
cd "$REPO_DIR" || die "repo not found at $REPO_DIR"
OLD_HASH=$(git rev-parse HEAD 2>/dev/null || echo none)
say "current commit: ${OLD_HASH:0:8}"

if [ "$FORCE_DEPLOY" = true ]; then
    say "force: discarding local tracked changes (untracked files are kept)"
    run git reset --hard HEAD
elif ! git diff --quiet || ! git diff --cached --quiet; then
    die "working tree has uncommitted changes — commit them, or re-run with --force"
fi

say "fetching ${GIT_REMOTE}/${GIT_BRANCH}…"
run git fetch --quiet "$GIT_REMOTE" "$GIT_BRANCH"
TARGET_HASH=$(git rev-parse "${GIT_REMOTE}/${GIT_BRANCH}" 2>/dev/null || echo "$OLD_HASH")
if [ "$OLD_HASH" = "$TARGET_HASH" ] && [ "$ALWAYS_RESTART" != true ]; then
    say "already at ${TARGET_HASH:0:8}; nothing to deploy."
    exit 0
fi

CHANGED=""; CATS=" server"
if [ "$OLD_HASH" != "$TARGET_HASH" ]; then
    CHANGED=$(git diff --name-only "$OLD_HASH" "$TARGET_HASH" || true)
    CATS=$(classify "$CHANGED")
    COMMIT_LOG=$(git --no-pager log --oneline "${OLD_HASH}..${TARGET_HASH}" 2>/dev/null || echo "Update deployed")
    COMMIT_COUNT=$(printf '%s\n' "$COMMIT_LOG" | grep -c . || true)
    say "$COMMIT_COUNT new commit(s); change classes:${CATS:- none}"
    printf '%s\n' "$COMMIT_LOG" | sed 's/^/         /'
else
    COMMIT_LOG="Restart requested"; COMMIT_COUNT=0
fi

NEEDS_RESTART=false
if has "$CATS" server || has "$CATS" systemd || [ "$ALWAYS_RESTART" = true ]; then NEEDS_RESTART=true; fi

# In place, the old process keeps running against files that are about to change underneath it, so
# anything that needs a restart waits for idle BEFORE the checkout moves.
[ "$NEEDS_RESTART" = true ] && wait_for_idle

say "validating the target revision…"
run git merge --ff-only "$TARGET_HASH" >/dev/null 2>&1 || { [ "$DRY_RUN" = "1" ] || die "fast-forward to ${TARGET_HASH:0:8} failed — diverged history" 2; }
NEW_HASH=$(git rev-parse HEAD)
[ -n "$CHANGED" ] && [ "$DRY_RUN" != "1" ] && syntax_check "$REPO_DIR" "$CHANGED"

if [ "$DRY_RUN" != "1" ] && [ "$OLD_HASH" != "$TARGET_HASH" ] && deps_changed "$OLD_HASH" "$TARGET_HASH" "$REPO_DIR"; then
    say "dependencies changed — installing (service still running)…"
    say "warning: legacy layout — a rollback would NOT restore the previous node_modules. Migrate to releases."
    run $NPM ci --omit=dev --no-audit --no-fund || die "npm ci failed" 2
fi
has "$CATS" nginx && say "note: deploy/nginx changed — not installed here; copy it, nginx -t, reload (see docs/deploy.md)."

if [ "$DRY_RUN" = "1" ]; then say "dry run complete — nothing was changed. restart needed: $NEEDS_RESTART"; exit 0; fi

if [ "$NEEDS_RESTART" != true ]; then
    say "change classes:${CATS} — no restart needed; the server re-reads public/ and docs/ from disk."
    say "deployed ${OLD_HASH:0:8} → ${NEW_HASH:0:8} without interrupting anyone ✅"
    exit 0
fi

install_units "$REPO_DIR/deploy/systemd"
has "$CATS" schema && backup_db "$REPO_DIR/data/live.db" "$REPO_DIR"
FIRST_LINE=$(printf '%s\n' "$COMMIT_LOG" | head -1 | sed 's/^[a-f0-9]* //')
notify_chat "$([ "$COMMIT_COUNT" -le 1 ] && echo "Update: ${FIRST_LINE}" || echo "${COMMIT_COUNT} updates deployed — ${FIRST_LINE}")"
rollback_legacy() {
    say "rolling back to ${OLD_HASH:0:8}"
    git reset --hard "$OLD_HASH" >/dev/null 2>&1 || die "ROLLBACK FAILED: could not reset to $OLD_HASH" 4
    $SYSTEMCTL restart "$SERVICE" 9>&- || die "ROLLBACK FAILED: service would not restart" 4
    printf '[Deploy] waiting for rollback'
    if wait_ready; then printf '\n'; say "rolled back to ${OLD_HASH:0:8} and serving"; exit 3; fi
    die "ROLLBACK FAILED: ${OLD_HASH:0:8} is not ready either — MANUAL INTERVENTION REQUIRED" 4
}
restart_and_verify rollback_legacy
curl -sf --max-time 5 "${API_URL}/api/health" >/dev/null || die "health endpoint not responding after readiness" 3
say "deployed ${OLD_HASH:0:8} → ${NEW_HASH:0:8} (${COMMIT_COUNT} commit(s))"
say "note: established WebSocket, WHIP, RTMP and WebRTC sessions were reconnected, not preserved."
say "done ✅"
