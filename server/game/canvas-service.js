const { EventEmitter } = require('events');
const db = require('../db/database');
const game = require('./game-engine');
const { isStaff } = require('../auth/permissions');

const BOARD_WIDTH = 512;
const BOARD_HEIGHT = 512;
const DEFAULT_PALETTE = ['#101418','#232a31','#3a4651','#57697a','#7f95a6','#d6dde3','#ffffff','#ffd9b3','#ffbf7f','#ff9a57','#ff6d3a','#e13f2b','#8b1e24','#5a1120','#3b1f15','#6d3a1d','#9b5d27','#d18c3e','#f0c85a','#fff38f','#a7d948','#58b64c','#2f7f4c','#16594d','#15324b','#215b88','#2f90d8','#72c8ff','#7d6ee7','#b27cff','#ff74c8','#ff9fda'];
const DEFAULT_LEVEL_TIERS = [
    { min_level: 0, max_level: 24, cooldown_seconds: 10 },
    { min_level: 25, max_level: 74, cooldown_seconds: 8 },
    { min_level: 75, max_level: 149, cooldown_seconds: 7 },
    { min_level: 150, max_level: 299, cooldown_seconds: 6 },
    { min_level: 300, max_level: null, cooldown_seconds: 5 },
];

function toIso(value) {
    if (!value) return null;
    return value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
}

function toMs(value) {
    const iso = toIso(value);
    return iso ? new Date(iso).getTime() : 0;
}

class CanvasService extends EventEmitter {
    constructor() {
        super();
        this.initialized = false;
    }

    initDb() {
        if (this.initialized) return;
        db.getDb().exec(`
            CREATE TABLE IF NOT EXISTS canvas_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                type TEXT DEFAULT 'json',
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS canvas_tiles (
                x INTEGER NOT NULL,
                y INTEGER NOT NULL,
                color_index INTEGER NOT NULL,
                user_id INTEGER,
                username TEXT,
                ip_address TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (x, y),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
            );
            CREATE TABLE IF NOT EXISTS canvas_actions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action_type TEXT NOT NULL,
                x INTEGER,
                y INTEGER,
                prev_color_index INTEGER,
                color_index INTEGER,
                user_id INTEGER,
                username TEXT,
                ip_address TEXT,
                meta TEXT DEFAULT '{}',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
            );
            CREATE INDEX IF NOT EXISTS idx_canvas_actions_created ON canvas_actions(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_canvas_actions_user ON canvas_actions(user_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_canvas_actions_tile ON canvas_actions(x, y, created_at DESC);
            CREATE TABLE IF NOT EXISTS canvas_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                board_data TEXT NOT NULL,
                metadata TEXT DEFAULT '{}',
                created_by INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
            );
            CREATE TABLE IF NOT EXISTS canvas_region_locks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                label TEXT DEFAULT '',
                mode TEXT NOT NULL DEFAULT 'locked' CHECK(mode IN ('locked', 'protected')),
                x1 INTEGER NOT NULL,
                y1 INTEGER NOT NULL,
                x2 INTEGER NOT NULL,
                y2 INTEGER NOT NULL,
                reason TEXT DEFAULT '',
                expires_at DATETIME,
                created_by INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
            );
            CREATE TABLE IF NOT EXISTS canvas_bans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                ip_address TEXT,
                action_type TEXT NOT NULL DEFAULT 'mute' CHECK(action_type IN ('mute', 'ban')),
                reason TEXT DEFAULT '',
                expires_at DATETIME,
                created_by INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
                FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
            );
            CREATE TABLE IF NOT EXISTS canvas_user_overrides (
                user_id INTEGER PRIMARY KEY,
                cooldown_seconds INTEGER,
                placements_per_minute INTEGER,
                bypass_read_only INTEGER DEFAULT 0,
                note TEXT DEFAULT '',
                updated_by INTEGER,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
            );
        `);
        this.seedSetting('board_width', BOARD_WIDTH, 'number');
        this.seedSetting('board_height', BOARD_HEIGHT, 'number');
        this.seedSetting('palette', DEFAULT_PALETTE, 'json');
        this.seedSetting('frozen', false, 'boolean');
        this.seedSetting('read_only', false, 'boolean');
        this.seedSetting('tile_cooldown_seconds', 20, 'number');
        this.seedSetting('new_account_cooldown_seconds', 12, 'number');
        this.seedSetting('level_cooldowns', DEFAULT_LEVEL_TIERS, 'json');
        this.initialized = true;
    }

    seedSetting(key, value, type) {
        if (!db.get('SELECT key FROM canvas_settings WHERE key = ?', [key])) {
            db.run('INSERT INTO canvas_settings (key, value, type) VALUES (?, ?, ?)', [key, type === 'json' ? JSON.stringify(value) : String(value), type]);
        }
    }

    parseSetting(row) {
        if (!row) return null;
        if (row.type === 'number') return Number(row.value);
        if (row.type === 'boolean') return row.value === 'true';
        if (row.type === 'json') {
            try { return JSON.parse(row.value); } catch { return row.value; }
        }
        return row.value;
    }

    getSettings() {
        this.initDb();
        const rows = db.all('SELECT * FROM canvas_settings');
        const settings = {};
        for (const row of rows) settings[row.key] = this.parseSetting(row);
        return {
            board_width: BOARD_WIDTH,
            board_height: BOARD_HEIGHT,
            palette: DEFAULT_PALETTE,
            frozen: false,
            read_only: false,
            tile_cooldown_seconds: 20,
            new_account_cooldown_seconds: 12,
            level_cooldowns: DEFAULT_LEVEL_TIERS,
            ...settings,
        };
    }

    updateSettings(updates, actor) {
        const allowed = ['palette', 'frozen', 'read_only', 'tile_cooldown_seconds', 'new_account_cooldown_seconds', 'level_cooldowns'];
        for (const key of allowed) {
            if (updates[key] === undefined) continue;
            const value = updates[key];
            const type = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'json';
            db.run(`
                INSERT INTO canvas_settings (key, value, type, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, type = excluded.type, updated_at = CURRENT_TIMESTAMP
            `, [key, type === 'json' ? JSON.stringify(value) : String(value), type]);
        }
        db.logModerationAction({ scope_type: 'canvas', actor_user_id: actor?.id || null, action_type: 'canvas_settings_update', details: updates });
        const settings = this.getSettings();
        this.emit('board_state', settings);
        return settings;
    }

    safeJson(value, fallback) {
        try { return JSON.parse(value || '{}'); } catch { return fallback; }
    }

    sanitizeTile(row, { includeIp = false } = {}) {
        if (!row) return null;
        const tile = {
            x: Number(row.x),
            y: Number(row.y),
            color_index: Number(row.color_index || 0),
            user_id: row.user_id ?? null,
            username: row.username || null,
            updated_at: row.updated_at || null,
        };
        if (row.prev_color_index != null) tile.prev_color_index = Number(row.prev_color_index || 0);
        if (includeIp && row.ip_address) tile.ip_address = row.ip_address;
        return tile;
    }

    sanitizeAction(row, { includeIp = false } = {}) {
        if (!row) return null;
        const action = {
            id: row.id,
            action_type: row.action_type,
            x: row.x ?? null,
            y: row.y ?? null,
            prev_color_index: row.prev_color_index != null ? Number(row.prev_color_index || 0) : null,
            color_index: row.color_index != null ? Number(row.color_index || 0) : null,
            user_id: row.user_id ?? null,
            username: row.username || null,
            created_at: row.created_at || null,
            meta: this.safeJson(row.meta, {}),
        };
        if (includeIp && row.ip_address) action.ip_address = row.ip_address;
        return action;
    }

    sanitizeSnapshot(row, { includeBoardData = false } = {}) {
        if (!row) return null;
        const snapshot = {
            id: row.id,
            name: row.name,
            metadata: this.safeJson(row.metadata, {}),
            created_at: row.created_at || null,
            created_by: row.created_by ?? null,
            created_by_username: row.created_by_username || null,
        };
        if (includeBoardData) snapshot.board_data = this.safeJson(row.board_data, []);
        return snapshot;
    }

    getTiles({ includeIp = false } = {}) {
        return db.all('SELECT * FROM canvas_tiles ORDER BY y ASC, x ASC').map((row) => this.sanitizeTile(row, { includeIp }));
    }

    getRecentActions(limit = 50, { includeIp = false } = {}) {
        return db.all('SELECT * FROM canvas_actions ORDER BY created_at DESC LIMIT ?', [limit]).map((row) => this.sanitizeAction(row, { includeIp }));
    }

    getActiveRegions() {
        return db.all(`
            SELECT crl.*, u.username AS created_by_username
            FROM canvas_region_locks crl
            LEFT JOIN users u ON crl.created_by = u.id
            WHERE crl.expires_at IS NULL OR crl.expires_at > CURRENT_TIMESTAMP
            ORDER BY crl.created_at DESC
        `);
    }

    getBans() {
        return db.all(`
            SELECT cb.*, u.username, u.display_name, actor.username AS created_by_username
            FROM canvas_bans cb
            LEFT JOIN users u ON cb.user_id = u.id
            LEFT JOIN users actor ON cb.created_by = actor.id
            ORDER BY cb.created_at DESC
        `);
    }

    getOverrides() {
        return db.all(`
            SELECT cuo.*, u.username, u.display_name, actor.username AS updated_by_username
            FROM canvas_user_overrides cuo
            JOIN users u ON cuo.user_id = u.id
            LEFT JOIN users actor ON cuo.updated_by = actor.id
            ORDER BY u.username COLLATE NOCASE
        `);
    }

    getSnapshots() {
        return db.all(`
            SELECT cs.*, u.username AS created_by_username
            FROM canvas_snapshots cs
            LEFT JOIN users u ON cs.created_by = u.id
            ORDER BY cs.created_at DESC
        `).map((row) => this.sanitizeSnapshot(row));
    }

    getUserOverride(userId) {
        return userId ? db.get('SELECT * FROM canvas_user_overrides WHERE user_id = ?', [userId]) : null;
    }

    getDerivedCooldown(user) {
        const settings = this.getSettings();
        const override = this.getUserOverride(user?.id);
        const totalLevel = user?.id ? (game.getPlayer(user.id)?.total_level || 0) : 0;
        const tier = (settings.level_cooldowns || DEFAULT_LEVEL_TIERS).find((row) => totalLevel >= row.min_level && (row.max_level == null || totalLevel <= row.max_level)) || DEFAULT_LEVEL_TIERS[0];
        let cooldownSeconds = Number(tier.cooldown_seconds || 10);
        if (user?.created_at && Date.now() - new Date(user.created_at).getTime() < 24 * 3600000) {
            cooldownSeconds = Math.max(cooldownSeconds, Number(settings.new_account_cooldown_seconds || 12));
        }
        if (override?.cooldown_seconds != null) cooldownSeconds = Number(override.cooldown_seconds);
        const placementsPerMinute = override?.placements_per_minute != null ? Number(override.placements_per_minute) : Math.max(3, Math.floor(60 / Math.max(1, cooldownSeconds)));
        return { total_level: totalLevel, cooldown_seconds: cooldownSeconds, placements_per_minute: placementsPerMinute, override };
    }

    getCooldownState(user, ip) {
        const derived = this.getDerivedCooldown(user);
        const lastPlacement = db.get(`
            SELECT created_at
            FROM canvas_actions
            WHERE action_type = 'place'
              AND ((user_id = ? AND ? IS NOT NULL) OR ip_address = ?)
            ORDER BY created_at DESC
            LIMIT 1
        `, [user?.id || null, user?.id || null, ip || null]);
        const placementsLastMinute = db.get(`
            SELECT COUNT(*) AS c
            FROM canvas_actions
            WHERE action_type = 'place'
              AND created_at > datetime('now', '-1 minute')
              AND ((user_id = ? AND ? IS NOT NULL) OR ip_address = ?)
        `, [user?.id || null, user?.id || null, ip || null])?.c || 0;
        const nextPlacementAt = lastPlacement ? new Date(toMs(lastPlacement.created_at) + derived.cooldown_seconds * 1000).toISOString() : null;
        return {
            ...derived,
            last_placement_at: lastPlacement?.created_at || null,
            next_placement_at: nextPlacementAt,
            remaining_ms: nextPlacementAt ? Math.max(0, new Date(nextPlacementAt).getTime() - Date.now()) : 0,
            placements_last_minute: placementsLastMinute,
        };
    }

    recordAction(actionType, payload) {
        db.run(`
            INSERT INTO canvas_actions (action_type, x, y, prev_color_index, color_index, user_id, username, ip_address, meta)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [actionType, payload.x ?? null, payload.y ?? null, payload.prev_color_index ?? null, payload.color_index ?? null, payload.user_id ?? null, payload.username ?? null, payload.ip_address ?? null, JSON.stringify(payload.meta || {})]);
    }

    getBlock(user, ip, x, y, colorIndex) {
        const settings = this.getSettings();
        const override = this.getUserOverride(user?.id);
        const activeBan = db.get(`
            SELECT *
            FROM canvas_bans
            WHERE ((user_id = ? AND ? IS NOT NULL) OR ip_address = ?)
              AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
            ORDER BY created_at DESC
            LIMIT 1
        `, [user?.id || null, user?.id || null, ip || null]);
        if (activeBan) return { status: 403, message: activeBan.reason || 'You are blocked from placing on the canvas.' };
        if ((settings.frozen || settings.read_only) && !(override?.bypass_read_only || isStaff(user))) return { status: 403, message: 'The canvas is currently read-only.' };
        if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= BOARD_WIDTH || y < 0 || y >= BOARD_HEIGHT) return { status: 400, message: 'Tile coordinates are out of bounds.' };
        if (!Number.isInteger(colorIndex) || colorIndex < 0 || colorIndex >= (settings.palette || DEFAULT_PALETTE).length) return { status: 400, message: 'Invalid palette color.' };
        const region = this.getActiveRegions().find((row) => x >= Math.min(row.x1, row.x2) && x <= Math.max(row.x1, row.x2) && y >= Math.min(row.y1, row.y2) && y <= Math.max(row.y1, row.y2));
        if (region && !isStaff(user)) return { status: 403, message: region.reason || 'That region is currently locked.' };
        const tile = db.get('SELECT * FROM canvas_tiles WHERE x = ? AND y = ?', [x, y]);
        if (tile && Number(tile.color_index) === colorIndex) return { status: 400, message: 'That tile is already set to this color.' };
        if (tile && !isStaff(user)) {
            const remaining = Number(settings.tile_cooldown_seconds || 20) * 1000 - (Date.now() - toMs(tile.updated_at));
            if (remaining > 0) return { status: 429, message: 'That tile is temporarily locked from being overwritten.', remaining_ms: remaining };
        }
        const cooldown = this.getCooldownState(user, ip);
        if (cooldown.remaining_ms > 0 && !isStaff(user)) return { status: 429, message: 'You are on cooldown before your next placement.', remaining_ms: cooldown.remaining_ms };
        if (cooldown.placements_last_minute >= cooldown.placements_per_minute && !isStaff(user)) return { status: 429, message: 'You have reached your placement rate limit for this minute.' };
        return null;
    }

    getBoardState(user, ip) {
        const settings = this.getSettings();
        return {
            board: { width: BOARD_WIDTH, height: BOARD_HEIGHT, palette: settings.palette || DEFAULT_PALETTE },
            settings: {
                frozen: !!settings.frozen,
                read_only: !!settings.read_only,
                tile_cooldown_seconds: Number(settings.tile_cooldown_seconds || 20),
                new_account_cooldown_seconds: Number(settings.new_account_cooldown_seconds || 12),
            },
            tiles: this.getTiles(),
            recent_actions: this.getRecentActions(60),
            regions: this.getActiveRegions(),
            cooldown: user ? this.getCooldownState(user, ip) : null,
        };
    }

    placeTile(user, ip, body) {
        this.initDb();
        const x = Number(body.x);
        const y = Number(body.y);
        const colorIndex = Number(body.color_index);
        const block = this.getBlock(user, ip, x, y, colorIndex);
        if (block) {
            this.recordAction('blocked', { x, y, color_index: colorIndex, user_id: user?.id || null, username: user?.username || null, ip_address: ip, meta: block });
            const error = new Error(block.message);
            error.status = block.status;
            error.data = block;
            throw error;
        }
        const existing = db.get('SELECT * FROM canvas_tiles WHERE x = ? AND y = ?', [x, y]);
        const prevColor = existing ? Number(existing.color_index) : 0;
        const username = user.display_name || user.username;
        db.run(`
            INSERT INTO canvas_tiles (x, y, color_index, user_id, username, ip_address, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(x, y) DO UPDATE SET
                color_index = excluded.color_index,
                user_id = excluded.user_id,
                username = excluded.username,
                ip_address = excluded.ip_address,
                updated_at = CURRENT_TIMESTAMP
        `, [x, y, colorIndex, user.id, username, ip]);
        this.recordAction('place', { x, y, prev_color_index: prevColor, color_index: colorIndex, user_id: user.id, username, ip_address: ip, meta: { total_level: this.getDerivedCooldown(user).total_level } });
        const tile = { x, y, color_index: colorIndex, prev_color_index: prevColor, user_id: user.id, username, updated_at: new Date().toISOString() };
        this.emit('tile_patch', tile);
        return { tile, cooldown: this.getCooldownState(user, ip) };
    }

    createSnapshot(name, actor) {
        const tiles = this.getTiles();
        const result = db.run('INSERT INTO canvas_snapshots (name, board_data, metadata, created_by) VALUES (?, ?, ?, ?)', [name || `Snapshot ${new Date().toISOString()}`, JSON.stringify(tiles), JSON.stringify({ tile_count: tiles.length, settings: this.getSettings() }), actor?.id || null]);
        db.logModerationAction({ scope_type: 'canvas', actor_user_id: actor?.id || null, action_type: 'canvas_snapshot_create', details: { snapshot_id: result.lastInsertRowid, tile_count: tiles.length } });
        const snapshot = db.get(`
            SELECT cs.*, u.username AS created_by_username
            FROM canvas_snapshots cs
            LEFT JOIN users u ON cs.created_by = u.id
            WHERE cs.id = ?
        `, [result.lastInsertRowid]);
        return this.sanitizeSnapshot(snapshot);
    }

    restoreSnapshot(snapshotId, actor) {
        const snapshot = db.get('SELECT * FROM canvas_snapshots WHERE id = ?', [snapshotId]);
        if (!snapshot) throw new Error('Snapshot not found');
        const tiles = this.safeJson(snapshot.board_data, []);
        const tx = db.getDb().transaction((rows) => {
            db.run('DELETE FROM canvas_tiles');
            for (const tile of rows) {
                db.run('INSERT INTO canvas_tiles (x, y, color_index, user_id, username, ip_address, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [tile.x, tile.y, tile.color_index, tile.user_id || null, tile.username || null, tile.ip_address || null, tile.updated_at || new Date().toISOString()]);
            }
        });
        tx(tiles);
        this.recordAction('restore_snapshot', { user_id: actor?.id || null, username: actor?.username || null, meta: { snapshot_id: snapshotId, tile_count: tiles.length } });
        db.logModerationAction({ scope_type: 'canvas', actor_user_id: actor?.id || null, action_type: 'canvas_snapshot_restore', details: { snapshot_id: snapshotId, tile_count: tiles.length } });
        this.emit('bulk_patch', tiles.map((tile) => ({ x: tile.x, y: tile.y, color_index: tile.color_index, user_id: tile.user_id || null, username: tile.username || null, updated_at: tile.updated_at || new Date().toISOString() })));
        return { snapshot: this.sanitizeSnapshot(snapshot), tile_count: tiles.length };
    }

    wipeBoard(actor) {
        db.run('DELETE FROM canvas_tiles');
        this.recordAction('wipe', { user_id: actor?.id || null, username: actor?.username || null });
        db.logModerationAction({ scope_type: 'canvas', actor_user_id: actor?.id || null, action_type: 'canvas_wipe' });
        this.emit('bulk_patch', []);
        this.emit('board_reset');
        return { success: true };
    }

    createRegion(region, actor) {
        const result = db.run('INSERT INTO canvas_region_locks (label, mode, x1, y1, x2, y2, reason, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [region.label || '', region.mode || 'locked', Number(region.x1), Number(region.y1), Number(region.x2), Number(region.y2), region.reason || '', region.expires_at || null, actor?.id || null]);
        db.logModerationAction({ scope_type: 'canvas', actor_user_id: actor?.id || null, action_type: 'canvas_region_add', details: { region_id: result.lastInsertRowid, ...region } });
        return db.get('SELECT * FROM canvas_region_locks WHERE id = ?', [result.lastInsertRowid]);
    }

    removeRegion(regionId, actor) {
        db.run('DELETE FROM canvas_region_locks WHERE id = ?', [regionId]);
        db.logModerationAction({ scope_type: 'canvas', actor_user_id: actor?.id || null, action_type: 'canvas_region_remove', details: { region_id: regionId } });
    }

    createBan(payload, actor) {
        const result = db.run('INSERT INTO canvas_bans (user_id, ip_address, action_type, reason, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?)', [payload.user_id || null, payload.ip_address || null, payload.action_type || 'mute', payload.reason || '', payload.expires_at || null, actor?.id || null]);
        db.logModerationAction({ scope_type: 'canvas', actor_user_id: actor?.id || null, target_user_id: payload.user_id || null, action_type: 'canvas_ban_add', details: { ban_id: result.lastInsertRowid, ...payload } });
        return db.get('SELECT * FROM canvas_bans WHERE id = ?', [result.lastInsertRowid]);
    }

    removeBan(banId, actor) {
        db.run('DELETE FROM canvas_bans WHERE id = ?', [banId]);
        db.logModerationAction({ scope_type: 'canvas', actor_user_id: actor?.id || null, action_type: 'canvas_ban_remove', details: { ban_id: banId } });
    }

    upsertOverride(payload, actor) {
        db.run(`
            INSERT INTO canvas_user_overrides (user_id, cooldown_seconds, placements_per_minute, bypass_read_only, note, updated_by, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id) DO UPDATE SET
                cooldown_seconds = excluded.cooldown_seconds,
                placements_per_minute = excluded.placements_per_minute,
                bypass_read_only = excluded.bypass_read_only,
                note = excluded.note,
                updated_by = excluded.updated_by,
                updated_at = CURRENT_TIMESTAMP
        `, [payload.user_id, payload.cooldown_seconds ?? null, payload.placements_per_minute ?? null, payload.bypass_read_only ? 1 : 0, payload.note || '', actor?.id || null]);
        db.logModerationAction({ scope_type: 'canvas', actor_user_id: actor?.id || null, target_user_id: payload.user_id, action_type: 'canvas_override_upsert', details: payload });
        return this.getUserOverride(payload.user_id);
    }

    removeOverride(userId, actor) {
        db.run('DELETE FROM canvas_user_overrides WHERE user_id = ?', [userId]);
        db.logModerationAction({ scope_type: 'canvas', actor_user_id: actor?.id || null, target_user_id: userId, action_type: 'canvas_override_remove' });
    }

    applyRollback(actions, actor, reason, meta = {}) {
        const changed = [];
        for (const action of actions) {
            const current = db.get('SELECT * FROM canvas_tiles WHERE x = ? AND y = ?', [action.x, action.y]);
            if (!current || Number(current.color_index) !== Number(action.color_index)) continue;
            if (Number(action.prev_color_index || 0) === 0) db.run('DELETE FROM canvas_tiles WHERE x = ? AND y = ?', [action.x, action.y]);
            else db.run(`
                INSERT INTO canvas_tiles (x, y, color_index, user_id, username, ip_address, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(x, y) DO UPDATE SET color_index = excluded.color_index, user_id = excluded.user_id, username = excluded.username, ip_address = excluded.ip_address, updated_at = CURRENT_TIMESTAMP
            `, [action.x, action.y, action.prev_color_index, action.user_id || null, action.username || null, action.ip_address || null]);
            this.recordAction('rollback', { x: action.x, y: action.y, prev_color_index: action.color_index, color_index: action.prev_color_index || 0, user_id: actor?.id || null, username: actor?.username || null, meta: { reason, source_action_id: action.id, ...meta } });
            changed.push({ x: action.x, y: action.y, color_index: Number(action.prev_color_index || 0), user_id: action.user_id || null, username: action.username || null, updated_at: new Date().toISOString() });
        }
        if (changed.length) {
            db.logModerationAction({ scope_type: 'canvas', actor_user_id: actor?.id || null, action_type: 'canvas_rollback', details: { reason, count: changed.length, ...meta } });
            this.emit('bulk_patch', changed);
        }
        return { count: changed.length, tiles: changed };
    }

    rollback(params, actor) {
        const mode = params.mode;
        let actions = [];
        if (mode === 'tile') actions = db.all('SELECT * FROM canvas_actions WHERE action_type = ? AND x = ? AND y = ? ORDER BY created_at DESC LIMIT 1', ['place', Number(params.x), Number(params.y)]);
        else if (mode === 'user') actions = db.all('SELECT * FROM canvas_actions WHERE action_type = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?', ['place', Number(params.user_id), Math.min(Number(params.limit || 200), 500)]);
        else if (mode === 'region') actions = db.all('SELECT * FROM canvas_actions WHERE action_type = ? AND x BETWEEN ? AND ? AND y BETWEEN ? AND ? ORDER BY created_at DESC LIMIT 1000', ['place', Math.min(Number(params.x1), Number(params.x2)), Math.max(Number(params.x1), Number(params.x2)), Math.min(Number(params.y1), Number(params.y2)), Math.max(Number(params.y1), Number(params.y2))]);
        else if (mode === 'time_range') actions = db.all('SELECT * FROM canvas_actions WHERE action_type = ? AND created_at BETWEEN ? AND ? ORDER BY created_at DESC LIMIT 1000', ['place', params.start_at, params.end_at]);
        else throw new Error('Unsupported rollback mode');
        return this.applyRollback(actions, actor, mode, params);
    }

    getHeatmap(hours = 12) {
        return {
            buckets: db.all(`
                SELECT CAST(x / 16 AS INTEGER) AS bucket_x, CAST(y / 16 AS INTEGER) AS bucket_y, COUNT(*) AS placements
                FROM canvas_actions
                WHERE action_type = 'place' AND created_at > datetime('now', ?)
                GROUP BY bucket_x, bucket_y
                ORDER BY placements DESC
                LIMIT 80
            `, [`-${Number(hours)} hours`]),
            users: db.all(`
                SELECT user_id, username, COUNT(*) AS placements
                FROM canvas_actions
                WHERE action_type = 'place' AND created_at > datetime('now', ?)
                GROUP BY user_id, username
                ORDER BY placements DESC
                LIMIT 25
            `, [`-${Number(hours)} hours`]),
            ips: db.all(`
                SELECT ip_address, COUNT(*) AS placements
                FROM canvas_actions
                WHERE action_type = 'place' AND created_at > datetime('now', ?)
                GROUP BY ip_address
                ORDER BY placements DESC
                LIMIT 25
            `, [`-${Number(hours)} hours`]),
        };
    }
}

module.exports = new CanvasService();
