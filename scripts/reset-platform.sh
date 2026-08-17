#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════
#  OpenVibe.Live — Full Platform Reset
# ══════════════════════════════════════════════════════════════
#
#  Wipes ALL persistent data:
#    • SQLite database (users, channels, streams, game, etc.)
#    • VODs, clips, thumbnails, emotes, media
#    • Remux marker files
#    • Optionally rotates JWT secret (invalidates all tokens)
#
#  On next startup the server will:
#    • Rebuild all schemas from scratch
#    • Seed default site_settings + built-in themes
#    • Re-create admin user from .env credentials
#    • Generate a fresh OpenVibeGame world seed
#
#  Usage:
#    ./scripts/reset-platform.sh          # interactive confirmation
#    ./scripts/reset-platform.sh --force  # skip confirmation
#    ./scripts/reset-platform.sh --help   # show this help
#
# ══════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$ROOT_DIR/data"
ENV_FILE="$ROOT_DIR/.env"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

print_banner() {
    echo -e "${RED}"
    echo "  ╔══════════════════════════════════════════╗"
    echo "  ║   ⚠️  FULL PLATFORM RESET  ⚠️              ║"
    echo "  ║   This will DELETE everything.           ║"
    echo "  ╚══════════════════════════════════════════╝"
    echo -e "${NC}"
}

print_help() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --force         Skip confirmation prompt"
    echo "  --rotate-jwt    Also generate a new JWT secret in .env"
    echo "  --keep-media    Keep VODs, clips, and thumbnails"
    echo "  --help          Show this help message"
    echo ""
    echo "What gets deleted:"
    echo "  • Database:     data/live.db (all users, channels, game data)"
    echo "  • VODs:         data/vods/*"
    echo "  • Clips:        data/clips/*"
    echo "  • Thumbnails:   data/thumbnails/*"
    echo "  • Emotes:       data/emotes/*"
    echo "  • Media:        data/media/*"
    echo "  • Markers:      data/vods/.remux-done"
    echo ""
    echo "What is preserved:"
    echo "  • .env config (admin creds, ports, secrets)"
    echo "  • All application code (server/, public/, etc.)"
    echo "  • Node modules"
}

# ── Parse args ────────────────────────────────────────────────

FORCE=false
ROTATE_JWT=false
KEEP_MEDIA=false

for arg in "$@"; do
    case "$arg" in
        --force)      FORCE=true ;;
        --rotate-jwt) ROTATE_JWT=true ;;
        --keep-media) KEEP_MEDIA=true ;;
        --help|-h)    print_help; exit 0 ;;
        *)            echo -e "${RED}Unknown option: $arg${NC}"; print_help; exit 1 ;;
    esac
done

# ── Safety checks ─────────────────────────────────────────────

if [[ ! -f "$ROOT_DIR/package.json" ]]; then
    echo -e "${RED}Error: Cannot find package.json. Run this from the openvibelive directory.${NC}"
    exit 1
fi

# Check if server is running
if pgrep -f "node.*server/index.js" > /dev/null 2>&1; then
    echo -e "${YELLOW}⚠  Server appears to be running! Stop it first (Ctrl+C or kill the process).${NC}"
    if [[ "$FORCE" == false ]]; then
        read -rp "Continue anyway? This may corrupt the database. [y/N] " yn
        [[ "$yn" =~ ^[Yy]$ ]] || exit 1
    fi
fi

# ── Show what will be deleted ─────────────────────────────────

print_banner

echo -e "${BOLD}The following will be permanently deleted:${NC}"
echo ""

# Database
DB_FILE="$DATA_DIR/live.db"
if [[ -f "$DB_FILE" ]]; then
    DB_SIZE=$(du -sh "$DB_FILE" 2>/dev/null | cut -f1)
    echo -e "  ${CYAN}Database${NC}     $DB_FILE ($DB_SIZE)"

    # Count some records if sqlite3 is available
    if command -v sqlite3 &>/dev/null; then
        USERS=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM users;" 2>/dev/null || echo "?")
        GAME_P=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM game_players;" 2>/dev/null || echo "?")
        MSGS=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM chat_messages;" 2>/dev/null || echo "?")
        echo -e "               ${YELLOW}→ $USERS users, $GAME_P game players, $MSGS chat messages${NC}"
    fi
else
    echo -e "  ${CYAN}Database${NC}     (not found — nothing to delete)"
fi

# Media files
if [[ "$KEEP_MEDIA" == false ]]; then
    for dir in vods clips thumbnails emotes media; do
        FULL="$DATA_DIR/$dir"
        if [[ -d "$FULL" ]]; then
            COUNT=$(find "$FULL" -type f ! -name '.gitkeep' 2>/dev/null | wc -l)
            SIZE=$(du -sh "$FULL" 2>/dev/null | cut -f1)
            echo -e "  ${CYAN}$dir/${NC}$(printf '%*s' $((13 - ${#dir})) '') $COUNT files ($SIZE)"
        fi
    done
else
    echo -e "  ${GREEN}(media files will be kept — --keep-media)${NC}"
fi

if [[ "$ROTATE_JWT" == true ]]; then
    echo -e "  ${CYAN}JWT Secret${NC}   Will be rotated (invalidates all existing tokens)"
fi

echo ""

# ── Confirm ───────────────────────────────────────────────────

if [[ "$FORCE" == false ]]; then
    echo -e "${RED}${BOLD}This action cannot be undone!${NC}"
    read -rp "Type 'RESET' to confirm: " confirm
    if [[ "$confirm" != "RESET" ]]; then
        echo "Aborted."
        exit 0
    fi
    echo ""
fi

# ── Execute reset ─────────────────────────────────────────────

echo -e "${BOLD}Resetting platform...${NC}"

# 1. Delete database
echo -n "  Removing database... "
rm -f "$DATA_DIR/live.db" \
      "$DATA_DIR/live.db-wal" \
      "$DATA_DIR/live.db-shm"
echo -e "${GREEN}done${NC}"

# 2. Delete media content
if [[ "$KEEP_MEDIA" == false ]]; then
    for dir in vods clips thumbnails emotes media; do
        FULL="$DATA_DIR/$dir"
        if [[ -d "$FULL" ]]; then
            echo -n "  Clearing $dir/... "
            find "$FULL" -type f ! -name '.gitkeep' -delete 2>/dev/null || true
            echo -e "${GREEN}done${NC}"
        fi
    done
else
    echo -e "  ${GREEN}Skipping media files (--keep-media)${NC}"
fi

# 3. Delete marker files
echo -n "  Removing marker files... "
rm -f "$DATA_DIR/vods/.remux-done"
echo -e "${GREEN}done${NC}"

# 4. Rotate JWT secret (optional)
if [[ "$ROTATE_JWT" == true ]]; then
    echo -n "  Rotating JWT secret... "
    if [[ -f "$ENV_FILE" ]]; then
        NEW_SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | base64 | tr -d '/+=' | head -c 64)
        sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$NEW_SECRET|" "$ENV_FILE"
        echo -e "${GREEN}done${NC}"
    else
        echo -e "${YELLOW}skipped (.env not found)${NC}"
    fi
fi

# ── Done ──────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}${BOLD}✅ Platform reset complete!${NC}"
echo ""
echo "On next startup, the server will:"
echo "  • Rebuild all database schemas"
echo "  • Seed default site settings & themes"
echo "  • Re-create admin user from .env"
echo "  • Generate a fresh OpenVibeGame world"
echo ""
echo -e "Start the server with: ${CYAN}cd $ROOT_DIR && npm start${NC}"
