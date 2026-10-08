// Preset control profiles for new users
const CONTROL_PRESETS = [
    {
        name: 'Robot Car (WASD)',
        description: 'Basic robot car: forward, back, left, right, stop. Hold-to-drive (key_down/key_up) for smooth continuous movement.',
        buttons: [
            { label: 'Forward', command: 'forward', icon: 'fa-arrow-up', control_type: 'keyboard', key_binding: 'w', cooldown_ms: 100, sort_order: 0 },
            { label: 'Left', command: 'turn_left', icon: 'fa-arrow-left', control_type: 'keyboard', key_binding: 'a', cooldown_ms: 100, sort_order: 1 },
            { label: 'Stop', command: 'stop', icon: 'fa-stop', control_type: 'button', key_binding: '', cooldown_ms: 100, sort_order: 2 },
            { label: 'Right', command: 'turn_right', icon: 'fa-arrow-right', control_type: 'keyboard', key_binding: 'd', cooldown_ms: 100, sort_order: 3 },
            { label: 'Back', command: 'backward', icon: 'fa-arrow-down', control_type: 'keyboard', key_binding: 's', cooldown_ms: 100, sort_order: 4 },
        ]
    },
    {
        name: 'Cozmo Robot',
        description: 'Full Cozmo robot controls: hold-to-drive (WASD), face animations, machine gun lift, mode toggle, emergency stop.',
        buttons: [
            // Drive — keyboard type = sends key_down/key_up for smooth continuous drive
            { label: 'Forward',      command: 'forward',         icon: 'fa-arrow-up',         control_type: 'keyboard', key_binding: 'w',     cooldown_ms: 100, sort_order: 0 },
            { label: 'Left',         command: 'turn_left',       icon: 'fa-arrow-left',       control_type: 'keyboard', key_binding: 'a',     cooldown_ms: 100, sort_order: 1 },
            { label: 'Stop',         command: 'stop',            icon: 'fa-stop',             control_type: 'button',   key_binding: 'space', cooldown_ms: 100, sort_order: 2 },
            { label: 'Right',        command: 'turn_right',      icon: 'fa-arrow-right',      control_type: 'keyboard', key_binding: 'd',     cooldown_ms: 100, sort_order: 3 },
            { label: 'Back',         command: 'backward',        icon: 'fa-arrow-down',       control_type: 'keyboard', key_binding: 's',     cooldown_ms: 100, sort_order: 4 },
            // Face animations — button type = single tap
            { label: 'Machine Gun',  command: 'machine_gun',     icon: 'fa-burst',            control_type: 'button',   key_binding: 'p',     cooldown_ms: 1000, sort_order: 5 },
            { label: 'Otter',        command: 'otter',           icon: 'fa-otter',            control_type: 'button',   key_binding: 'g',     cooldown_ms: 300, sort_order: 6 },
            { label: 'Dual Otter',   command: 'dual_otter',      icon: 'fa-otter',            control_type: 'button',   key_binding: 'y',     cooldown_ms: 300, sort_order: 7 },
            { label: 'Mecha MG',     command: 'mechaMG',         icon: 'fa-robot',            control_type: 'button',   key_binding: 'm',     cooldown_ms: 300, sort_order: 8 },
            { label: 'ArmCat',       command: 'armcat',          icon: 'fa-cat',              control_type: 'button',   key_binding: 'k',     cooldown_ms: 300, sort_order: 9 },
            { label: 'NFlag',        command: 'nflag',           icon: 'fa-flag',             control_type: 'button',   key_binding: 'n',     cooldown_ms: 300, sort_order: 10 },
            { label: 'Glance',       command: 'random_glance',   icon: 'fa-eye',              control_type: 'button',   key_binding: 'h',     cooldown_ms: 300, sort_order: 11 },
            { label: 'Toggle Mode',  command: 'toggle_mode',     icon: 'fa-shuffle',          control_type: 'button',   key_binding: 'x',     cooldown_ms: 500, sort_order: 12 },
        ]
    },
    {
        name: 'Camera PTZ',
        description: 'Pan/tilt/zoom camera controls (ONVIF compatible).',
        buttons: [
            { label: 'Pan Left', command: 'pan_left', icon: 'fa-arrow-left', control_type: 'onvif', key_binding: 'a', cooldown_ms: 300, sort_order: 0 },
            { label: 'Pan Right', command: 'pan_right', icon: 'fa-arrow-right', control_type: 'onvif', key_binding: 'd', cooldown_ms: 300, sort_order: 1 },
            { label: 'Tilt Up', command: 'tilt_up', icon: 'fa-arrow-up', control_type: 'onvif', key_binding: 'w', cooldown_ms: 300, sort_order: 2 },
            { label: 'Tilt Down', command: 'tilt_down', icon: 'fa-arrow-down', control_type: 'onvif', key_binding: 's', cooldown_ms: 300, sort_order: 3 },
            { label: 'Zoom In', command: 'zoom_in', icon: 'fa-magnifying-glass-plus', control_type: 'onvif', key_binding: 'e', cooldown_ms: 300, sort_order: 4 },
            { label: 'Zoom Out', command: 'zoom_out', icon: 'fa-magnifying-glass-minus', control_type: 'onvif', key_binding: 'q', cooldown_ms: 300, sort_order: 5 },
        ]
    },
    {
        name: 'Gamepad (ABXY)',
        description: 'Gamepad-style controls: A, B, X, Y, Start, Select.',
        buttons: [
            { label: 'A', command: 'a', icon: 'fa-circle', control_type: 'button', key_binding: 'j', cooldown_ms: 200, sort_order: 0 },
            { label: 'B', command: 'b', icon: 'fa-circle', control_type: 'button', key_binding: 'k', cooldown_ms: 200, sort_order: 1 },
            { label: 'X', command: 'x', icon: 'fa-circle', control_type: 'button', key_binding: 'u', cooldown_ms: 200, sort_order: 2 },
            { label: 'Y', command: 'y', icon: 'fa-circle', control_type: 'button', key_binding: 'i', cooldown_ms: 200, sort_order: 3 },
            { label: 'Start', command: 'start', icon: 'fa-play', control_type: 'button', key_binding: 'enter', cooldown_ms: 500, sort_order: 4 },
            { label: 'Select', command: 'select', icon: 'fa-stop', control_type: 'button', key_binding: 'shift', cooldown_ms: 500, sort_order: 5 },
        ]
    }
];

function seedControlPresetsForUser(userId) {
    const existing = all('SELECT * FROM control_configs WHERE user_id = ?', [userId]);
    if (existing.length > 0) return;
    for (const preset of CONTROL_PRESETS) {
        const { lastInsertRowid } = run('INSERT INTO control_configs (user_id, name, description) VALUES (?, ?, ?)', [userId, preset.name, preset.description]);
        for (const btn of preset.buttons) {
            run(
                `INSERT INTO control_config_buttons (config_id, label, command, icon, control_type, key_binding, cooldown_ms, sort_order, btn_color, btn_bg, btn_border_color)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', '')`,
                [lastInsertRowid, btn.label, btn.command, btn.icon, btn.control_type, btn.key_binding, btn.cooldown_ms, btn.sort_order]
            );
        }
    }
}
/**
 * OpenVibe.Live — Database Connection & Helpers
 * PostgreSQL through openvibe-sdk/db (ADR-035, plan T4). The schema is migrations/NNNN_*.sql, run with the owner role
 * (DATABASE_DIRECT_URL) when the process boots; this module then opens the serving pool (DATABASE_URL, through
 * PgBouncer). Every helper is async: statements keep better-sqlite3's shape (db.prepare(sql).get/all/run with ?
 * parameters) and must be awaited. SQLite's 'YYYY-MM-DD HH:MM:SS' text timestamps stay as they were (datetime(),
 * julianday() and ov_now() exist in the database: migrations/0002_live.sql).
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createDb } = require('openvibe-sdk/db');
// BILLING_AUTHORITY tripwire: Live's money columns/tables are only written in `live` mode.
const { assertLiveLedger } = require('../monetization/money-authority');

const MIGRATIONS = path.join(__dirname, '..', '..', 'migrations');

let db = null;

/**
 * Open the process-wide database once, at boot (server/index.js, scripts): migrations first, as the owner, then the
 * serving pool. Tests adopt the database test/helpers/pg-preload.mjs migrated. Development without DATABASE_URL gets
 * an embedded PGlite database under the data directory (one process only); production refuses to boot without it.
 */
async function initDb({ log = console } = {}) {
    if (db) return db;
    if (globalThis.__ovLiveTestDb) { db = globalThis.__ovLiveTestDb; return db; }
    const url = process.env.DATABASE_URL;
    if (!url) {
        if (process.env.NODE_ENV === 'production') throw new Error('DATABASE_URL is not set: Live serves from PostgreSQL (OpenVibe.Host roles/data add-service.sh live)');
        const dir = require('../paths').data('pglite');
        log.warn(`[DB] DATABASE_URL unset: embedded PGlite database in ${dir} (development only, one process)`);
        fs.mkdirSync(dir, { recursive: true });
        const dev = createDb({ pglite: dir, service: 'live', log });
        await dev.migrate({ dir: MIGRATIONS, log });
        db = dev;
    } else {
        const directUrl = process.env.DATABASE_DIRECT_URL;
        if (!directUrl) throw new Error('DATABASE_DIRECT_URL is not set: migrations run with the owner role on a direct connection');
        const owner = createDb({ url: directUrl, service: 'live-migrate', max: 1, log });
        try { await owner.migrate({ dir: MIGRATIONS, log }); } finally { await owner.close(); }
        db = createDb({ url, service: 'live', max: Number(process.env.DATABASE_POOL_MAX) || 10, log });
    }
    await bootRecovery();
    // Speech rows are written with vod_id NULL while a stream is live, so there is a fresh backlog after most
    // restarts; adopt it a few seconds after boot. A restore drill starts no timers.
    if (!require('../drill').enabled) setTimeout(() => { adoptOrphanedTimelineRows().catch((e) => console.warn('[DB] timeline orphan adoption skipped:', e.message)); }, 4000).unref?.();
    console.log('[DB] PostgreSQL ready');
    return db;
}

/** The process-wide database initDb() opened. */
function getDb() {
    if (!db && globalThis.__ovLiveTestDb) db = globalThis.__ovLiveTestDb;
    if (!db) throw new Error('the database is not open: await initDb() at boot');
    return db;
}

/**
 * Every boot: transcript jobs a restart interrupted go back to the queue (their progress is kept), exhausted ones get a
 * fresh ladder unless the source itself can never work; and OWNER_USERNAME (default goosely) is the owner.
 */
async function bootRecovery() {
    try {
        for (const t of ['vod_ai_state', 'clip_ai_state']) {
            const p = await run(`UPDATE ${t} SET transcript_status = 'retry', transcript_next_at = NULL WHERE transcript_status = 'processing'`);
            const f = await run(`UPDATE ${t} SET transcript_status = 'retry', transcript_attempts = 0, transcript_next_at = NULL
                WHERE transcript_status = 'failed'
                  AND COALESCE(transcript_error, '') NOT ILIKE 'media reported%'
                  AND COALESCE(transcript_error, '') NOT ILIKE 'no audio stream%'`);
            if (p.changes || f.changes) console.log(`[DB] ${t}: re-queued ${p.changes} interrupted + ${f.changes} previously-failed transcript job(s)`);
        }
    } catch (e) { console.warn('[DB] transcript recovery:', e.message); }
    try {
        const ownerName = (process.env.OWNER_USERNAME || 'goosely').toLowerCase();
        await run("UPDATE users SET is_owner = 1, role = 'admin' WHERE lower(username) = ? AND is_owner != 1", [ownerName]);
    } catch (e) { console.warn('[DB] owner bootstrap:', e.message); }
}

/**
 * Speech rows recorded while a stream is live carry vod_id NULL until the recording exists. If any row for a stream
 * already points at a VOD, the stream's remaining rows belong to that same VOD by construction (one recording per
 * stream). The partial index idx_timeline_null_vod makes "is there anything to adopt?" cheap, so the common case
 * skips the update entirely.
 */
async function adoptOrphanedTimelineRows() {
    const pending = await get('SELECT 1 AS x FROM stream_timeline_events WHERE vod_id IS NULL LIMIT 1');
    if (!pending) return 0;
    const res = await run(`UPDATE stream_timeline_events AS t
        SET vod_id = (SELECT s.vod_id FROM stream_timeline_events s
                      WHERE s.stream_id = t.stream_id AND s.vod_id IS NOT NULL LIMIT 1)
        WHERE t.vod_id IS NULL
          AND EXISTS (SELECT 1 FROM stream_timeline_events s
                      WHERE s.stream_id = t.stream_id AND s.vod_id IS NOT NULL)`);
    if (res.changes) console.log(`[DB] stream_timeline_events: adopted ${res.changes} orphaned row(s) onto their VOD`);
    return res.changes;
}

// ── Generic helpers ──────────────────────────────────────────
//
// Every query in this file (and in every route module) funnels through run/get/all. A statement compiles its ? and
// @name parameters to PostgreSQL's $n once, so the compiled statements are kept in a Map keyed by SQL text (bounded:
// the variable-length IN-list shapes would otherwise fill it with single-use entries). They are bound to the
// process-wide handle and join an ambient db.tx() like every other db call.
const _stmtCache = new Map();
const _STMT_CACHE_MAX = 600;

function stmt(sql) {
    let st = _stmtCache.get(sql);
    if (st) return st;
    st = getDb().prepare(sql);
    if (_stmtCache.size >= _STMT_CACHE_MAX) {
        const oldest = _stmtCache.keys().next().value;
        if (oldest !== undefined) _stmtCache.delete(oldest);
    }
    _stmtCache.set(sql, st);
    return st;
}

/** Statements belong to a handle, so a reopened database must start with an empty cache. */
function clearStatementCache() { _stmtCache.clear(); }

/** → { changes, rows, lastInsertRowid } (lastInsertRowid is the first column of a RETURNING row). */
async function run(sql, params = []) {
    return stmt(sql).run(...(Array.isArray(params) ? params : [params]));
}

async function get(sql, params = []) {
    return stmt(sql).get(...(Array.isArray(params) ? params : [params]));
}

async function all(sql, params = []) {
    return stmt(sql).all(...(Array.isArray(params) ? params : [params]));
}

/** Run fn in one transaction: every db call inside joins it (openvibe-sdk/db ambient transactions). */
async function tx(fn, opts) {
    return getDb().tx(fn, opts);
}

// ── User helpers ─────────────────────────────────────────────

function getUserById(id) {
    return get('SELECT * FROM users WHERE id = ?', [id]);
}

function getUserByUsername(username) {
    return get('SELECT * FROM users WHERE username = ? COLLATE NOCASE', [username]);
}

function getUserByStreamKey(key) {
    return get('SELECT * FROM users WHERE stream_key = ?', [key]);
}

function createUser({ username, email, password_hash, display_name, stream_key }) {
    // Identity is the OpenVibe account's (WS-B task 2): Live stores no password and no email. A real password
    // hash here is a bug, refused before it reaches the table; an email address is never stored.
    if (/^\$(2[abxy]?|argon2|scrypt|pbkdf2)/.test(String(password_hash || ''))) throw new Error('Live stores no passwords: accounts sign in through openvibe.network');
    email = null;
    return run(
        `INSERT INTO users (username, email, password_hash, display_name, stream_key)
         VALUES (?, ?, ?, ?, ?)`,
        [username, email || null, password_hash, display_name || username, stream_key]
    );
}

function getOrCreateAnonGameUser(anonId) {
    const normalizedAnonId = String(anonId || 'anon0').trim().toLowerCase();
    const safeAnonKey = normalizedAnonId.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'anon0';
    const username = `__game_${safeAnonKey}`;

    let user = getUserByUsername(username);
    if (user) {
        if (user.display_name !== normalizedAnonId) {
            run('UPDATE users SET display_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [normalizedAnonId, user.id]);
            user = getUserById(user.id);
        }
        return user;
    }

    const passwordHash = `!anon-game:${safeAnonKey}:${crypto.randomBytes(12).toString('hex')}`;
    run(
        `INSERT OR IGNORE INTO users (username, password_hash, display_name, role)
         VALUES (?, ?, ?, 'user')`,
        [username, passwordHash, normalizedAnonId]
    );

    return getUserByUsername(username);
}

// ── Stream helpers ───────────────────────────────────────────

function getLiveStreams() {
    return all(`
        SELECT s.*, COALESCE(NULLIF(s.ai_category, ''), s.category) AS category, s.category AS chosen_category, u.username, u.display_name, u.avatar_url, u.profile_color,
               ms.slug AS managed_stream_slug, ms.id AS managed_stream_id,
               ms.stream_key AS managed_stream_key,
               ms.browser_mode, ms.streaming_method
        FROM streams s
        JOIN users u ON s.user_id = u.id
        LEFT JOIN managed_streams ms ON s.managed_stream_id = ms.id
        WHERE s.is_live = 1
        ORDER BY s.viewer_count DESC, s.started_at DESC
    `);
}

// The latest ended session per streamer. The VOD fields (vod_id, vod_thumbnail_url, …) come from
// OpenVibe.Media: media-proxy/lookups.js attachPublicVods.
function getRecentStreams(limit = 20) {
    return all(`
        SELECT s.*, COALESCE(NULLIF(s.ai_category, ''), s.category) AS category, s.category AS chosen_category, u.username, u.display_name, u.avatar_url, u.profile_color
        FROM streams s
        JOIN (
            SELECT user_id, MAX(ended_at) AS latest_ended_at
            FROM streams
            WHERE is_live = 0 AND ended_at IS NOT NULL
            GROUP BY user_id
        ) latest ON latest.user_id = s.user_id AND latest.latest_ended_at = s.ended_at
        JOIN users u ON s.user_id = u.id
        WHERE s.is_live = 0 AND s.ended_at IS NOT NULL
        ORDER BY s.ended_at DESC
        LIMIT ?
    `, [limit]);
}

function getStreamById(id) {
    return get(`
        SELECT s.*, COALESCE(NULLIF(s.ai_category, ''), s.category) AS category, s.category AS chosen_category, u.username, u.display_name, u.avatar_url, u.profile_color,
               ms.slug AS managed_stream_slug, ms.stream_key AS managed_stream_key,
               ms.title AS managed_stream_title, ms.protocol AS managed_stream_protocol
        FROM streams s
        JOIN users u ON s.user_id = u.id
        LEFT JOIN managed_streams ms ON s.managed_stream_id = ms.id
        WHERE s.id = ?
    `, [id]);
}

function getStreamByUserId(userId) {
    return get(`
        SELECT * FROM streams WHERE user_id = ? AND is_live = 1
        ORDER BY started_at DESC LIMIT 1
    `, [userId]);
}

/**
 * Strip ingest credentials from a stream row before it goes to a client.
 *
 * getLiveStreams() and getLiveStreamsByUserId() both select `ms.stream_key AS managed_stream_key`
 * because the publish and recording paths genuinely need it. That makes every response built from
 * those rows one forgotten `delete` away from handing out a credential that authenticates RTMP
 * publish, WHIP publish and the hardware control bridge — i.e. stream takeover. It has happened
 * twice: GET /api/streams and GET /api/media/channel/:username.
 *
 * Call this on anything derived from those rows that a client will see. It is cheap and it is a
 * lot easier to review than a `delete` three screens away from the query.
 */
function publicStream(row) {
    // One implementation for the whole server — it also drops the attached channel's home ZIP.
    return require('../web/serializers').publicStream(row);
}

function getLiveStreamsByUserId(userId) {
    return all(`
        SELECT s.*, COALESCE(NULLIF(s.ai_category, ''), s.category) AS category, s.category AS chosen_category, u.username, u.display_name, u.avatar_url, u.profile_color,
               ms.slug AS managed_stream_slug, ms.stream_key AS managed_stream_key,
               ms.title AS managed_stream_title
        FROM streams s
        JOIN users u ON s.user_id = u.id
        LEFT JOIN managed_streams ms ON s.managed_stream_id = ms.id
        WHERE s.user_id = ? AND s.is_live = 1
        ORDER BY s.started_at DESC
    `, [userId]);
}

function getLiveStreamsByControlConfigId(controlConfigId) {
    return all(`
        SELECT s.*, COALESCE(NULLIF(s.ai_category, ''), s.category) AS category, s.category AS chosen_category, u.username, u.display_name, u.avatar_url, u.profile_color,
               ms.slug AS managed_stream_slug, ms.stream_key AS managed_stream_key,
               ms.title AS managed_stream_title
        FROM streams s
        JOIN users u ON s.user_id = u.id
        LEFT JOIN managed_streams ms ON s.managed_stream_id = ms.id
        WHERE s.control_config_id = ? AND s.is_live = 1
        ORDER BY s.started_at DESC
    `, [controlConfigId]);
}

function getStreamsByUserId(userId, limit = 50) {
    return all(`
        SELECT s.*, COALESCE(NULLIF(s.ai_category, ''), s.category) AS category, s.category AS chosen_category, u.username, u.display_name, u.avatar_url, u.profile_color,
               ms.slug AS managed_stream_slug, ms.stream_key AS managed_stream_key,
               ms.title AS managed_stream_title, ms.id AS managed_stream_ref_id
        FROM streams s
        JOIN users u ON s.user_id = u.id
        LEFT JOIN managed_streams ms ON s.managed_stream_id = ms.id
        WHERE s.user_id = ?
        ORDER BY s.created_at DESC
        LIMIT ?
    `, [userId, limit]);
}

// A slot's past sessions. Each one's VOD (vod_id, vod_file_path) comes from OpenVibe.Media:
// media-proxy/lookups.js vodsForManagedStream.
function getStreamHistoryByManagedStream(managedStreamId, userId, limit = 20) {
    return all(`
        SELECT s.id, s.title, s.started_at, s.ended_at, s.is_live,
               s.peak_viewers, s.viewer_count, s.duration_seconds,
               s.protocol, s.category
        FROM streams s
        WHERE s.managed_stream_id = ? AND s.user_id = ?
        ORDER BY s.started_at DESC
        LIMIT ?
    `, [managedStreamId, userId, limit]);
}

// Stream lifecycle hook (server/events/stream-events.js registers it at boot). It runs inside the
// same transaction as the write, so the durable event exists if and only if the change committed
// (roadmap Wave 3, ADR-004). A failing hook is logged and never blocks going live or ending.
let streamLifecycleHook = null;
function onStreamLifecycle(fn) { streamLifecycleHook = typeof fn === 'function' ? fn : null; }
function fireStreamLifecycle(kind, streamId) {
    if (!streamLifecycleHook) return;
    try { streamLifecycleHook(kind, streamId); } catch (err) { console.warn(`[Events] stream ${kind} event for ${streamId} not queued:`, err.message); }
}

function createStream({ user_id, channel_id, managed_stream_id, control_config_id, title, description, category, protocol, is_nsfw, thumbnail_url }) {
    return getDb().transaction(() => {
        const result = run(
            `INSERT INTO streams (user_id, channel_id, managed_stream_id, control_config_id, title, description, category, protocol, is_nsfw, thumbnail_url, is_live, started_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)`,
            [user_id, channel_id || null, managed_stream_id || null, control_config_id || null, title || 'Untitled Stream', description || '', category || null, protocol || 'webrtc', is_nsfw ? 1 : 0, thumbnail_url || null]
        );
        fireStreamLifecycle('started', result.lastInsertRowid);
        return result;
    })();
}

function endStream(streamId) {
    return getDb().transaction(() => {
        const stream = get('SELECT started_at, is_live FROM streams WHERE id = ?', [streamId]);
        if (!stream) return null;
        const result = run(
            `UPDATE streams SET is_live = 0, ended_at = CURRENT_TIMESTAMP,
             duration_seconds = CAST((julianday(CURRENT_TIMESTAMP) - julianday(started_at)) * 86400 AS INTEGER)
             WHERE id = ?`,
            [streamId]
        );
        if (stream.is_live) fireStreamLifecycle('ended', streamId);
        return result;
    })();
}

/**
 * End any OTHER live session on the same managed-stream slot (keep the newest).
 * Prevents "going live twice" from leaving a stale/broken duplicate tab.
 * Returns the list of ended stream ids.
 */
function endOtherLiveStreamsForSlot(managedStreamId, keepStreamId) {
    if (!managedStreamId) return [];
    const rows = all('SELECT id FROM streams WHERE managed_stream_id = ? AND is_live = 1 AND id != ?',
        [managedStreamId, keepStreamId || 0]);
    for (const r of rows) endStream(r.id);
    return rows.map(r => r.id);
}

// ── AI analysis helpers ──────────────────────────────────────
function addStreamMemory({ stream_id, user_id = null, offset_seconds = 0, description, tags = null, thumbnail_url = null, transcript_json = null }) {
    // OR IGNORE against idx_stream_memories_moment_unique: re-analysing a stream must not
    // store a second description of a moment already captured.
    return run(`INSERT OR IGNORE INTO stream_memories (stream_id, user_id, offset_seconds, description, tags, thumbnail_url, transcript_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [stream_id, user_id, Math.max(0, Math.round(offset_seconds || 0)), description || '',
         tags ? (typeof tags === 'string' ? tags : JSON.stringify(tags)) : null, thumbnail_url,
         (transcript_json && typeof transcript_json !== 'string') ? JSON.stringify(transcript_json) : (transcript_json || null)]);
}
function getStreamMemories(streamId) {
    return all('SELECT * FROM stream_memories WHERE stream_id = ? ORDER BY offset_seconds ASC', [streamId]);
}
function getLatestStreamMemory(streamId) {
    return get('SELECT * FROM stream_memories WHERE stream_id = ? ORDER BY offset_seconds DESC LIMIT 1', [streamId]);
}
// Derive a concise short overview from a long one — the lead sentence(s), capped
// ~150 chars at a sentence/word boundary. Deterministic + free (no AI call), so it
// can be cached at write time and shown on listing cards.
function _shortOverview(text) {
    const t = (text || '').replace(/\s+/g, ' ').trim();
    // ' ' is the "tried, nothing to say" sentinel the AI jobs store to mark a row done.
    // It must round-trip as a non-empty value — the backfill queues treat NULL/'' as
    // still-pending, so collapsing the sentinel to null meant unprocessable VODs were
    // retried forever. The frontend trims before rendering, so ' ' never displays.
    if (!t) return String(text || '').length ? ' ' : null;
    if (t.length <= 150) return t;
    const m = t.match(/^.*?[.!?](\s|$)/);
    let s = m ? m[0].trim() : '';
    if (s && s.length <= 175) {
        if (s.length < 85) {
            const rest = t.slice(s.length).match(/^\s*.*?[.!?](\s|$)/);
            if (rest && (s.length + rest[0].length) <= 175) s = (s + ' ' + rest[0].trim()).trim();
        }
        return s;
    }
    const cut = t.slice(0, 150);
    const sp = cut.lastIndexOf(' ');
    return (sp > 40 ? cut.slice(0, sp) : cut).trim() + '…';
}
function updateStreamAiOverview(streamId, text) {
    return run('UPDATE streams SET ai_overview = ?, ai_overview_short = ? WHERE id = ?', [text || null, _shortOverview(text), streamId]);
}
/** AI-inferred category/tags for a stream; the channel inherits the latest inferred category. */
function setStreamAiCategory(streamId, category, tags) {
    const cat = category ? String(category).toLowerCase().slice(0, 40) : null;
    const r = run('UPDATE streams SET ai_category = ?, ai_tags = ? WHERE id = ?', [cat, Array.isArray(tags) && tags.length ? JSON.stringify(tags.slice(0, 8)) : null, streamId]);
    if (cat) { const s = get('SELECT user_id FROM streams WHERE id = ?', [streamId]); if (s) run('UPDATE channels SET ai_category = ? WHERE user_id = ?', [cat, s.user_id]); }
    return r;
}
/** What to call a stream's category: the AI's read of the stream beats the self-selected default. */
function effectiveCategory(row) { if (!row) return null; return row.ai_category || row.category || null; }
// AI overview/transcript state lives in vod_ai_state / clip_ai_state (Live-owned,
// keyed by the Media vod/clip id) — the moved vods/clips tables are never written.
function _ensureVodAiState(vodId) {
    run('INSERT OR IGNORE INTO vod_ai_state (vod_id) VALUES (?)', [vodId]);
}
function _ensureClipAiState(clipId) {
    run('INSERT OR IGNORE INTO clip_ai_state (clip_id) VALUES (?)', [clipId]);
}

// ── Clip chat-announce scheduling (clip_ai_state) ────────────
function scheduleClipNotifyState(clipId, graceSeconds = 60) {
    _ensureClipAiState(clipId);
    return run(`UPDATE clip_ai_state SET clip_notify_at = datetime('now', ?) WHERE clip_id = ? AND COALESCE(clip_notified,0) = 0`,
        [`+${Math.max(0, Math.round(graceSeconds))} seconds`, clipId]);
}
function bumpClipNotifyNowState(clipId) {
    _ensureClipAiState(clipId);
    return run('UPDATE clip_ai_state SET clip_notify_at = CURRENT_TIMESTAMP WHERE clip_id = ? AND COALESCE(clip_notified,0) = 0', [clipId]);
}
function markClipNotifiedState(clipId) {
    _ensureClipAiState(clipId);
    return run('UPDATE clip_ai_state SET clip_notified = 1, clip_notify_at = NULL WHERE clip_id = ?', [clipId]);
}
function getDueClipNotifies(limit = 20) {
    return all(`SELECT clip_id FROM clip_ai_state
        WHERE COALESCE(clip_notified,0) = 0 AND clip_notify_at IS NOT NULL AND clip_notify_at <= CURRENT_TIMESTAMP
        LIMIT ?`, [limit]);
}

function getVodAiState(vodId) {
    return get('SELECT * FROM vod_ai_state WHERE vod_id = ?', [vodId]);
}
function getClipAiState(clipId) {
    return get('SELECT * FROM clip_ai_state WHERE clip_id = ?', [clipId]);
}
/** A VOD or clip OpenVibe.Media deleted: Live's own rows about it go (server/media-proxy/purge.js). */
function forgetMediaItem(kind, id) {
    return getDb().transaction(() => {
        const ai = kind === 'clip'
            ? run('DELETE FROM clip_ai_state WHERE clip_id = ?', [id])
            : run('DELETE FROM vod_ai_state WHERE vod_id = ?', [id]);
        const views = run('DELETE FROM content_views WHERE content_type = ? AND content_id = ?', [kind === 'clip' ? 'clip' : 'vod', id]);
        return { ai: ai.changes, views: views.changes };
    })();
}
function setVodAiOverview(vodId, text) {
    _ensureVodAiState(vodId);
    // Store the FULL overview alongside the derived short — the card expander swaps
    // the short teaser for this full text, so losing it makes expansion pointless.
    const full = (text || '').trim() || null;
    return run('UPDATE vod_ai_state SET ai_overview = ?, ai_overview_short = ? WHERE vod_id = ?', [full, _shortOverview(text), vodId]);
}
function setClipAiOverview(clipId, { overview = null, transcript = null, segments = null }) {
    void transcript; // full transcript text lives in the segments JSON now
    _ensureClipAiState(clipId);
    const full = (overview || '').trim() || null;
    return run('UPDATE clip_ai_state SET ai_overview = ?, ai_overview_short = ?, ai_transcript_json = COALESCE(?, ai_transcript_json) WHERE clip_id = ?',
        [full, _shortOverview(overview), _segJson(segments), clipId]);
}
function _segJson(segments) {
    if (!Array.isArray(segments)) return null;   // null = never attempted
    try { return JSON.stringify(segments.slice(0, 2000)); } catch { return null; } // [] = attempted, none found
}
function setVodTranscript(vodId, transcript, segments) {
    _ensureVodAiState(vodId);
    return run('UPDATE vod_ai_state SET ai_transcript_json = ?, transcript_partial_json = NULL, transcript_progress_sec = 0 WHERE vod_id = ?', [_segJson(segments) ?? (transcript ? JSON.stringify([]) : null), vodId]);
}
// Resumable VOD transcription: persist finished windows so a restart continues from here.
function saveVodTranscriptProgress(vodId, progressSec, segments) {
    _ensureVodAiState(vodId);
    return run('UPDATE vod_ai_state SET transcript_partial_json = ?, transcript_progress_sec = ? WHERE vod_id = ?', [_segJson(segments), Math.max(0, Math.floor(progressSec || 0)), vodId]);
}
function getVodTranscriptProgress(vodId) {
    const row = get('SELECT transcript_partial_json, transcript_progress_sec FROM vod_ai_state WHERE vod_id = ?', [vodId]);
    if (!row) return { progressSec: 0, segments: [] };
    let segments = [];
    try { segments = row.transcript_partial_json ? JSON.parse(row.transcript_partial_json) : []; } catch { segments = []; }
    return { progressSec: row.transcript_progress_sec || 0, segments: Array.isArray(segments) ? segments : [] };
}
function setClipTranscript(clipId, transcript, segments) {
    _ensureClipAiState(clipId);
    return run('UPDATE clip_ai_state SET ai_transcript_json = ? WHERE clip_id = ?', [_segJson(segments) ?? (transcript ? JSON.stringify([]) : null), clipId]);
}
function getStreamMemoriesInRange(streamId, startSec, endSec) {
    return all('SELECT * FROM stream_memories WHERE stream_id = ? AND offset_seconds BETWEEN ? AND ? ORDER BY offset_seconds ASC', [streamId, startSec, endSec]);
}
// Backfill queues (items still lacking AI output).
function getVodsNeedingOverview(limit = 4) {
    // Also re-queue rows whose short was truncated ('…') but whose full text was never
    // stored (older builds threw it away) — once regenerated, ai_overview is set and the
    // row drops out of the queue.
    return all(`SELECT vod_id AS id, s.* FROM vod_ai_state s
        WHERE (ai_overview IS NULL OR ai_overview = '')
          AND (ai_overview_short IS NULL OR ai_overview_short = '' OR ai_overview_short LIKE '%…')
        ORDER BY vod_id DESC LIMIT ?`, [limit]);
}
// Finished VODs whose AI timeline has fewer than 2 points — used to backfill the
// start/end coverage guarantee onto existing VODs (not just newly finalized ones).
function getVodsNeedingTimeline(limit = 1) {
    // Timeline coverage for NEW vods is guaranteed on the vod.ready webhook path
    // (generateVodOverview → ensureVodTimeline). There is no per-vod coverage marker
    // in vod_ai_state to drive a re-scan without re-probing every VOD each tick, so
    // the historical timeline backfill is retired with the media split.
    void limit;
    return [];
}
function getClipsNeedingOverview(limit = 4) {
    return all(`SELECT clip_id AS id, s.* FROM clip_ai_state s
        WHERE (ai_overview IS NULL OR ai_overview = '')
          AND (ai_overview_short IS NULL OR ai_overview_short = '' OR ai_overview_short LIKE '%…')
        ORDER BY clip_id DESC LIMIT ?`, [limit]);
}
// Transcript backfill queues — driven by transcript_status (see the migration above).
// Pending = NULL/'pending'/'retry'. 'processing'/'done'/'empty'/'failed' are excluded.
// VODs still recording are skipped.
// Rows come from vod_ai_state/clip_ai_state (state rows are created by the Media
// vod.ready/clip.ready webhook and by the cutover migration). `id` = the Media id;
// callers resolve the vod/clip metadata from OpenVibe.Media.
function getVodsNeedingTranscript(limit = 2) {
    return all(`SELECT vod_id AS id, s.* FROM vod_ai_state s
        WHERE ai_transcript_json IS NULL
          AND (transcript_status IS NULL OR transcript_status IN ('pending','retry'))
          AND (transcript_next_at IS NULL OR transcript_next_at <= CURRENT_TIMESTAMP)
        ORDER BY (transcript_status='retry'), vod_id DESC LIMIT ?`, [limit]);
}
function getClipsNeedingTranscript(limit = 2) {
    return all(`SELECT clip_id AS id, s.* FROM clip_ai_state s
        WHERE ai_transcript_json IS NULL
          AND (transcript_status IS NULL OR transcript_status IN ('pending','retry'))
          AND (transcript_next_at IS NULL OR transcript_next_at <= CURRENT_TIMESTAMP)
        ORDER BY (transcript_status='retry'), clip_id DESC LIMIT ?`, [limit]);
}
// status setter. On a 'retry', pass retryDelayMin to schedule the next eligible attempt
// (exponential backoff); any other status clears the schedule.
function setVodTranscriptStatus(id, status, error = null, retryDelayMin = 0) {
    _ensureVodAiState(id);
    const nextExpr = (status === 'retry' && retryDelayMin > 0) ? `datetime('now','+${Math.round(retryDelayMin)} minutes')` : 'NULL';
    return run(`UPDATE vod_ai_state SET transcript_status = ?, transcript_error = ?, transcript_next_at = ${nextExpr} WHERE vod_id = ?`,
        [status, error ? String(error).slice(0, 300) : null, id]);
}
function setClipTranscriptStatus(id, status, error = null, retryDelayMin = 0) {
    _ensureClipAiState(id);
    const nextExpr = (status === 'retry' && retryDelayMin > 0) ? `datetime('now','+${Math.round(retryDelayMin)} minutes')` : 'NULL';
    return run(`UPDATE clip_ai_state SET transcript_status = ?, transcript_error = ?, transcript_next_at = ${nextExpr} WHERE clip_id = ?`,
        [status, error ? String(error).slice(0, 300) : null, id]);
}
// Increment the attempt counter and return the new count (drives retry-vs-fail).
function bumpVodTranscriptAttempt(id) {
    _ensureVodAiState(id);
    run('UPDATE vod_ai_state SET transcript_attempts = COALESCE(transcript_attempts,0)+1 WHERE vod_id = ?', [id]);
    const r = get('SELECT transcript_attempts AS a FROM vod_ai_state WHERE vod_id = ?', [id]);
    return r ? r.a : 0;
}
function bumpClipTranscriptAttempt(id) {
    _ensureClipAiState(id);
    run('UPDATE clip_ai_state SET transcript_attempts = COALESCE(transcript_attempts,0)+1 WHERE clip_id = ?', [id]);
    const r = get('SELECT transcript_attempts AS a FROM clip_ai_state WHERE clip_id = ?', [id]);
    return r ? r.a : 0;
}
// deleteAiMomentTextPastes() removed — the media subsystem (vods/clips/pastes writes) moved to OpenVibe.Media.
// ── One-time cleanup: earlier builds stored raw (often malformed) model JSON like
// `{"description":"…","tags":[…]}` directly into text columns. Extract just the
// human description so cards/overviews stop showing JSON. Idempotent; cheap to re-run.
function _extractDescFromMaybeJson(text) {
    if (!text || typeof text !== 'string') return text;
    const t = text.trim();
    if (!/^[{[]/.test(t) || !/"description"\s*:/.test(t)) return text; // not a JSON blob
    const dm = t.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
    if (dm) { try { return JSON.parse(`"${dm[1]}"`); } catch { return dm[1]; } }
    return text;
}
function cleanupMalformedAiText() {
    // Only Live-owned tables — the moved vods/clips/pastes tables are frozen for
    // the OpenVibe.Media migration and must never be written.
    const jobs = [
        ['stream_memories', 'description', 'id'],
        ['streams', 'ai_overview', 'id'],
        ['streams', 'ai_overview_short', 'id'],
        ['vod_ai_state', 'ai_overview_short', 'vod_id'],
        ['clip_ai_state', 'ai_overview_short', 'clip_id'],
    ];
    let fixed = 0;
    for (const [table, col, key] of jobs) {
        try {
            const rows = all(`SELECT ${key} AS k, ${col} AS v FROM ${table} WHERE ${col} LIKE '{%"description"%'`);
            for (const r of rows) {
                const clean = _extractDescFromMaybeJson(r.v);
                if (clean && clean !== r.v) { run(`UPDATE ${table} SET ${col} = ? WHERE ${key} = ?`, [clean, r.k]); fixed++; }
            }
        } catch { /* table/column may not exist on older DBs */ }
    }
    // streamer_overviews uses different column names.
    try {
        const rows = all(`SELECT user_id AS k, overview AS v FROM streamer_overviews WHERE overview LIKE '{%"description"%'`);
        for (const r of rows) {
            const clean = _extractDescFromMaybeJson(r.v);
            if (clean && clean !== r.v) { run('UPDATE streamer_overviews SET overview = ? WHERE user_id = ?', [clean, r.k]); fixed++; }
        }
    } catch { /* */ }
    if (fixed) console.log(`[AI] Cleaned ${fixed} malformed JSON AI text value(s)`);
    return fixed;
}
function recordAiUsage({ kind, model, input_tokens = 0, output_tokens = 0, cached_tokens = 0, cost_usd = 0, owner_user_id = null, source = null, role = null, provider = null, latency_ms = null }) {
    return run('INSERT INTO ai_usage (kind, model, input_tokens, output_tokens, cached_tokens, cost_usd, owner_user_id, source, role, provider, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [kind || null, model || null, input_tokens || 0, output_tokens || 0, cached_tokens || 0, cost_usd || 0, owner_user_id || null, source || null, role || null, provider || null, latency_ms == null ? null : Math.round(latency_ms)]);
}
function getAiCostToday() {
    const r = get("SELECT COALESCE(SUM(cost_usd),0) AS c FROM ai_usage WHERE created_at >= date('now')");
    return r ? r.c : 0;
}
// Today's spend attributed to one streamer (optionally within a single feature bucket).
function getAiCostTodayForUser(userId, source = null) {
    if (!userId) return 0;
    let sql = "SELECT COALESCE(SUM(cost_usd),0) AS c FROM ai_usage WHERE owner_user_id = ? AND created_at >= date('now')";
    const params = [userId];
    if (source) { sql += ' AND source = ?'; params.push(source); }
    const r = get(sql, params);
    return r ? r.c : 0;
}
function getAiUsageSummary(days = 30) {
    const byDay = all(`SELECT date(created_at) AS day, COUNT(*) AS calls, SUM(input_tokens) AS input_tokens,
                       SUM(output_tokens) AS output_tokens, SUM(cost_usd) AS cost_usd
                       FROM ai_usage WHERE created_at >= date('now', ?) GROUP BY day ORDER BY day DESC`, [`-${days} days`]);
    const byKind = all(`SELECT kind, COUNT(*) AS calls, SUM(cost_usd) AS cost_usd
                        FROM ai_usage WHERE created_at >= date('now', ?) GROUP BY kind ORDER BY cost_usd DESC`, [`-${days} days`]);
    const totals = get(`SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS input_tokens,
                        COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(cached_tokens),0) AS cached_tokens,
                        COALESCE(SUM(cost_usd),0) AS cost_usd
                        FROM ai_usage WHERE created_at >= date('now', ?)`, [`-${days} days`]);
    const byRole = all(`SELECT COALESCE(role,'legacy') AS role, COUNT(*) AS calls, SUM(input_tokens) AS input_tokens, SUM(cached_tokens) AS cached_tokens,
                        SUM(output_tokens) AS output_tokens, SUM(cost_usd) AS cost_usd, AVG(latency_ms) AS avg_latency_ms
                        FROM ai_usage WHERE created_at >= date('now', ?) GROUP BY role ORDER BY cost_usd DESC`, [`-${days} days`]);
    const bySource = all(`SELECT COALESCE(source,'platform') AS source, COALESCE(provider,'shared') AS provider, COUNT(*) AS calls, SUM(cost_usd) AS cost_usd, SUM(input_tokens) AS input_tokens, SUM(cached_tokens) AS cached_tokens
                          FROM ai_usage WHERE created_at >= date('now', ?) GROUP BY source, provider ORDER BY cost_usd DESC`, [`-${days} days`]);
    const byOwner = all(`SELECT a.owner_user_id AS user_id, u.username, COUNT(*) AS calls, SUM(a.cost_usd) AS cost_usd,
                         SUM(a.input_tokens) AS input_tokens, SUM(a.cached_tokens) AS cached_tokens, SUM(a.output_tokens) AS output_tokens,
                         SUM(CASE WHEN a.created_at >= date('now') THEN a.cost_usd ELSE 0 END) AS cost_today,
                         SUM(CASE WHEN a.provider = 'byo' THEN a.cost_usd ELSE 0 END) AS cost_byo
                         FROM ai_usage a LEFT JOIN users u ON u.id = a.owner_user_id
                         WHERE a.created_at >= date('now', ?) AND a.owner_user_id IS NOT NULL
                         GROUP BY a.owner_user_id ORDER BY cost_usd DESC LIMIT 100`, [`-${days} days`]);
    const byModel = all(`SELECT model, COUNT(*) AS calls, SUM(cost_usd) AS cost_usd, SUM(input_tokens) AS input_tokens, SUM(cached_tokens) AS cached_tokens, SUM(output_tokens) AS output_tokens
                         FROM ai_usage WHERE created_at >= date('now', ?) GROUP BY model ORDER BY cost_usd DESC`, [`-${days} days`]);
    const cachedShare = totals.input_tokens ? totals.cached_tokens / totals.input_tokens : 0;
    return { byDay, byKind, byRole, bySource, byOwner, byModel, totals, cachedShare, today: getAiCostToday() };
}

// Memories across ALL of a streamer's streams (for the per-streamer AI overview + explorer).
function getStreamMemoriesByUser(userId, limit = 60) {
    return all('SELECT * FROM stream_memories WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', [userId, limit]);
}
// Total AI "events" (captured memory moments) for a user — powers the AI Timeline tab badge.
function countStreamMemoriesByUser(userId) {
    try { return get('SELECT COUNT(*) AS count FROM stream_memories WHERE user_id = ?', [userId])?.count || 0; }
    catch { return 0; }
}

// Flattened audio-transcript segments for a whole stream (from its memories), ordered by time.
// Used by the AI Timeline transcript viewer; each segment deep-links to the VOD at its start.
// ── Timeline accessors ────────────────────────────────────────────────────────
/**
 * Bulk-insert timeline rows.
 * @param {Array<{stream_id,user_id?,vod_id?,kind,start_sec,end_sec?,text?,label?,confidence?}>} rows
 */
function addTimelineEvents(rows) {
    if (!Array.isArray(rows) || !rows.length) return 0;
    const stmt = db.prepare(`INSERT INTO stream_timeline_events
        (stream_id, user_id, vod_id, kind, start_sec, end_sec, text, label, confidence, lang, text_en)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const tx = db.transaction((list) => {
        for (const r of list) {
            if (!r || !r.stream_id || !r.kind || r.start_sec == null) continue;
            stmt.run(r.stream_id, r.user_id || null, r.vod_id || null, r.kind,
                Number(r.start_sec) || 0, r.end_sec == null ? null : Number(r.end_sec),
                r.text || null, r.label || null, r.confidence == null ? null : Number(r.confidence),
                r.lang || null, r.text_en || null);
        }
    });
    try { tx(rows); return rows.length; } catch { return 0; }
}

/** Newest speech rows for a live stream after a given row id (live captions feed). */
function getTimelineSpeechSince(streamId, afterId = 0, limit = 40) {
    return all(`SELECT id, start_sec, end_sec, text, lang, text_en, created_at
                FROM stream_timeline_events
                WHERE stream_id = ? AND kind = 'speech' AND id > ?
                ORDER BY id DESC LIMIT ?`, [streamId, afterId || 0, Math.min(200, Math.max(1, limit))]).reverse();
}

/** Read a stream's timeline, optionally filtered by kind and time window. */
function getTimeline(streamId, { kind = null, from = null, to = null, limit = 5000 } = {}) {
    let sql = 'SELECT kind, start_sec, end_sec, text, label, confidence FROM stream_timeline_events WHERE stream_id = ?';
    const params = [streamId];
    if (kind) { sql += ' AND kind = ?'; params.push(kind); }
    if (from != null) { sql += ' AND start_sec >= ?'; params.push(Number(from)); }
    if (to != null) { sql += ' AND start_sec <= ?'; params.push(Number(to)); }
    sql += ' ORDER BY start_sec ASC LIMIT ?';
    params.push(Math.max(1, Math.min(20000, limit)));
    try { return all(sql, params); } catch { return []; }
}

/** Flat transcript text for a stream, speech rows only, in time order. */
function getTimelineText(streamId) {
    try {
        return getTimeline(streamId, { kind: 'speech' })
            .map(r => String(r.text || '').trim()).filter(Boolean).join(' ');
    } catch { return ''; }
}

/** How many seconds of a stream the timeline actually covers (union of speech spans). */
function getTimelineCoverage(streamId) {
    const rows = getTimeline(streamId, { kind: 'speech' });
    let covered = 0, lastEnd = -1;
    for (const r of rows) {
        const st = Number(r.start_sec) || 0;
        const en = r.end_sec == null ? st : Number(r.end_sec);
        if (en <= lastEnd) continue;
        covered += en - Math.max(st, lastEnd);
        lastEnd = en;
    }
    return Math.round(covered);
}

/** Timeline rows for a finished VOD (set by linkTimelineToVod when the recording lands). */
function getTimelineByVod(vodId) {
    try {
        return all(`SELECT kind, start_sec, end_sec, text, label, confidence
                    FROM stream_timeline_events WHERE vod_id = ? ORDER BY start_sec ASC LIMIT 20000`, [vodId]);
    } catch { return []; }
}

/**
 * The vod_id already stamped on this stream's timeline, if any.
 *
 * Transcription of spooled audio keeps running for a while after the vod.ready webhook
 * fires, and linkTimelineToVod() is a one-shot UPDATE — so those late rows used to stay
 * vod_id NULL forever and never appear in the VOD's transcript. (Stream 2128: 11 speech
 * rows orphaned against 2 linked; vod 2163 served 426 characters when the full
 * transcript was 3548.) Late writers call this to stamp themselves correctly.
 */
function getTimelineVodId(streamId) {
    try {
        const r = get('SELECT vod_id FROM stream_timeline_events WHERE stream_id = ? AND vod_id IS NOT NULL LIMIT 1', [streamId]);
        return r ? r.vod_id : null;
    } catch { return null; }
}

/** Attach a vod_id to a finished stream's rows so VOD views can reuse the timeline. */
function linkTimelineToVod(streamId, vodId) {
    try { return run('UPDATE stream_timeline_events SET vod_id = ? WHERE stream_id = ? AND vod_id IS NULL', [vodId, streamId]); }
    catch { return null; }
}

function getStreamTranscriptSegments(streamId) {
    // Prefer the timeline when it has rows — it keeps `end` and covers the whole stream.
    // Fall back to the legacy per-memory blobs so old streams keep rendering; no migration.
    try {
        const tl = getTimeline(streamId, { kind: 'speech' });
        if (tl.length) {
            return tl.map(r => ({
                start: Math.floor(Number(r.start_sec) || 0),
                end: r.end_sec == null ? null : Math.round(Number(r.end_sec) * 100) / 100,
                text: String(r.text || '').trim(),
            })).filter(s => s.text);
        }
    } catch { /* fall through to legacy */ }
    const out = [];
    try {
        const rows = all('SELECT offset_seconds, transcript_json FROM stream_memories WHERE stream_id = ? AND transcript_json IS NOT NULL ORDER BY offset_seconds ASC', [streamId]);
        for (const r of rows) {
            try {
                const segs = JSON.parse(r.transcript_json);
                for (const sg of (Array.isArray(segs) ? segs : [])) {
                    const text = String((sg && (sg.text || sg.t)) || '').trim();
                    if (!text) continue;
                    let start = sg && (sg.start != null ? sg.start : (sg.offset != null ? sg.offset : sg.s));
                    if (start == null || isNaN(Number(start))) start = r.offset_seconds || 0;
                    out.push({ start: Math.floor(Number(start) || 0), text });
                }
            } catch { /* */ }
        }
    } catch { /* */ }
    out.sort((a, b) => a.start - b.start);
    return out;
}

// getRecentAutoClips() removed — the media subsystem (vods/clips/pastes writes) moved to OpenVibe.Media.

// countAutoClipsSince() removed — the media subsystem (vods/clips/pastes writes) moved to OpenVibe.Media.

function upsertStreamerOverview(userId, { overview, model = null, sources = null }) {
    return run(`INSERT INTO streamer_overviews (user_id, overview, overview_short, model, sources, generated_at)
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(user_id) DO UPDATE SET
                    overview = excluded.overview, overview_short = excluded.overview_short, model = excluded.model,
                    sources = excluded.sources, generated_at = CURRENT_TIMESTAMP`,
        [userId, overview || '', _shortOverview(overview), model, sources]);
}
function getStreamerOverview(userId) {
    return get('SELECT * FROM streamer_overviews WHERE user_id = ?', [userId]);
}

// Assemble the full AI timeline for a streamer from already-generated AI data (no LLM cost):
// the whole-streamer overview + every session that has an AI overview or captured memories,
// newest first, each with its VOD (for timestamped links) and its ordered memory moments.
// vodIdByStream: Map(stream id → public VOD id) from OpenVibe.Media (lookups.publicVodIdsByStream).
function assembleStreamerAiTimeline(userId, vodIdByStream = null) {
    let overview = null;
    try { overview = get('SELECT overview, overview_short, generated_at FROM streamer_overviews WHERE user_id = ?', [userId]) || null; } catch { /* */ }

    let sessions = [];
    try {
        const streams = all(`
            SELECT s.id, s.title, s.ai_title, s.started_at, s.ended_at, s.created_at, s.duration_seconds,
                   s.ai_overview, s.ai_overview_short, s.thumbnail_url, s.peak_viewers, s.category,
                   (SELECT COUNT(*) FROM stream_memories m WHERE m.stream_id = s.id) AS memory_count
            FROM streams s
            WHERE s.user_id = ?
              AND (s.ai_overview IS NOT NULL OR EXISTS (SELECT 1 FROM stream_memories m WHERE m.stream_id = s.id))
            ORDER BY COALESCE(s.started_at, s.created_at) DESC
            LIMIT 300
        `, [userId]);
        sessions = streams.map(s => {
            let memories = [];
            try {
                memories = all(`SELECT offset_seconds, description, tags, thumbnail_url, captured_at, transcript_json
                                FROM stream_memories WHERE stream_id = ? ORDER BY offset_seconds ASC LIMIT 400`, [s.id]);
            } catch { /* */ }
            // Compute the session's total spoken-word count from the transcripts, then DROP the
            // (heavy) transcript_json from the payload — the full transcript loads on demand.
            let wordCount = 0, hasTranscript = false;
            for (const m of memories) {
                if (m.transcript_json) {
                    hasTranscript = true;
                    try {
                        const segs = JSON.parse(m.transcript_json);
                        for (const sg of (Array.isArray(segs) ? segs : [])) {
                            const txt = (sg && (sg.text || sg.t)) || '';
                            wordCount += String(txt).trim().split(/\s+/).filter(Boolean).length;
                        }
                    } catch { /* */ }
                }
                delete m.transcript_json;
            }
            const vodId = vodIdByStream && vodIdByStream.get(Number(s.id));
            return { ...s, vod_id: vodId || null, memories, word_count: wordCount, has_transcript: hasTranscript };
        });
    } catch { /* */ }

    return {
        overview,
        sessions,
        sessionCount: sessions.length,
        momentCount: sessions.reduce((n, s) => n + (s.memories?.length || 0), 0),
        generatedAt: new Date().toISOString(),
    };
}

function setStreamAiTitle(streamId, title) {
    try { return run('UPDATE streams SET ai_title = ? WHERE id = ?', [String(title || '').slice(0, 80), streamId]); } catch { return null; }
}
// Sessions that have an AI overview but no short AI title yet (for background titling).
function getUntitledAiSessions(userId, limit = 20) {
    try {
        return all(`SELECT id, ai_overview_short, ai_overview, title FROM streams
                    WHERE user_id = ? AND (ai_title IS NULL OR ai_title = '')
                      AND (ai_overview_short IS NOT NULL OR ai_overview IS NOT NULL)
                    ORDER BY COALESCE(started_at, created_at) DESC LIMIT ?`, [userId, limit]) || [];
    } catch { return []; }
}
function clearAiTimelineCache(userId) {
    try { return run('DELETE FROM ai_timeline_cache WHERE user_id = ?', [userId]); } catch { return null; }
}

// Lazy, TTL-cached timeline: re-assemble only when the tab is viewed AND the cache is stale.
// The route (ai/chat-ai-routes.js) reads the cache first, asks Media for the VOD ids only on a
// miss, then builds; `store: false` skips caching a timeline built while Media was unreachable.
function readStreamerAiTimelineCache(userId, ttlMs = 15 * 60 * 1000) {
    try {
        const row = get('SELECT payload, generated_at FROM ai_timeline_cache WHERE user_id = ?', [userId]);
        if (row && row.payload) {
            const age = Date.now() - Date.parse((row.generated_at || '').replace(' ', 'T') + 'Z');
            if (!(age > ttlMs) && !Number.isNaN(age)) {
                try { return { ...JSON.parse(row.payload), cached: true }; } catch { /* rebuild */ }
            }
        }
    } catch { /* rebuild */ }
    return null;
}
function buildStreamerAiTimeline(userId, vodIdByStream = null, { store = true } = {}) {
    const fresh = assembleStreamerAiTimeline(userId, vodIdByStream);
    if (store) {
        try {
            run(`INSERT INTO ai_timeline_cache (user_id, payload, generated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, generated_at = CURRENT_TIMESTAMP`,
                [userId, JSON.stringify(fresh)]);
        } catch { /* cache is best-effort */ }
    }
    return { ...fresh, cached: false };
}
function getAllStreamerOverviews(limit = 100) {
    return all(`SELECT o.*, u.username, u.display_name
                FROM streamer_overviews o JOIN users u ON u.id = o.user_id
                ORDER BY o.generated_at DESC LIMIT ?`, [limit]);
}
// Streamers whose aggregate AI overview is DUE for (re)generation. A "decent"
// overview (>= decentLen chars) refreshes at most every 12h; a sparse/missing one
// retries hourly until it fills out. Only streamers with stream memories are considered,
// so we never spend calls on users with nothing to summarize. (VODs used to count too,
// through Live's frozen vods table, whose rows moved to OpenVibe.Media at the split.)
function getStreamersNeedingOverview({ decentLen = 220, limit = 4 } = {}) {
    return all(`
        SELECT u.id AS user_id
        FROM users u
        LEFT JOIN streamer_overviews o ON o.user_id = u.id
        WHERE EXISTS (SELECT 1 FROM stream_memories m WHERE m.user_id = u.id)
          AND (
                o.user_id IS NULL
             OR (LENGTH(TRIM(COALESCE(o.overview,''))) >= ? AND o.generated_at <= datetime('now','-12 hours'))
             OR (LENGTH(TRIM(COALESCE(o.overview,''))) <  ? AND o.generated_at <= datetime('now','-1 hours'))
              )
        ORDER BY (o.generated_at IS NULL) DESC, o.generated_at ASC
        LIMIT ?
    `, [decentLen, decentLen, limit]);
}

function updateViewerCount(streamId, count) {
    run(`UPDATE streams SET viewer_count = ?, peak_viewers = MAX(peak_viewers, ?) WHERE id = ?`,
        [count, count, streamId]);
}

// ── Managed Stream helpers ───────────────────────────────────

function createManagedStream({ user_id, channel_id, slug, title, description, category, protocol, streaming_method, stream_key, is_nsfw, control_config_id }) {
    return run(
        `INSERT INTO managed_streams (user_id, channel_id, slug, title, description, category, protocol, streaming_method, stream_key, is_nsfw, control_config_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [user_id, channel_id || null, slug || null, title || 'Untitled Stream', description || '', category || null, protocol || 'webrtc', streaming_method || null, stream_key, is_nsfw ? 1 : 0, control_config_id || null]
    );
}

function getManagedStreamById(id) {
    return get(`
        SELECT ms.*, u.username, u.display_name, u.avatar_url, u.profile_color
        FROM managed_streams ms
        JOIN users u ON ms.user_id = u.id
        WHERE ms.id = ?
    `, [id]);
}

function getManagedStreamsByUserId(userId) {
    return all(`
        SELECT ms.*,
               (SELECT COUNT(*) FROM streams s WHERE s.managed_stream_id = ms.id) AS session_count,
               (SELECT MAX(s.ended_at) FROM streams s WHERE s.managed_stream_id = ms.id AND s.ended_at IS NOT NULL) AS last_live_at,
               (SELECT s.is_live FROM streams s WHERE s.managed_stream_id = ms.id AND s.is_live = 1 LIMIT 1) AS is_currently_live,
               (SELECT s.id FROM streams s WHERE s.managed_stream_id = ms.id AND s.is_live = 1 LIMIT 1) AS live_session_id
        FROM managed_streams ms
        WHERE ms.user_id = ?
        ORDER BY ms.sort_order ASC, ms.created_at ASC
    `, [userId]);
}

function getManagedStreamBySlug(userId, slug) {
    return get(`
        SELECT ms.*, u.username, u.display_name, u.avatar_url, u.profile_color
        FROM managed_streams ms
        JOIN users u ON ms.user_id = u.id
        WHERE ms.user_id = ? AND ms.slug = ? COLLATE NOCASE
    `, [userId, slug]);
}

function getManagedStreamByStreamKey(streamKey) {
    return get(`
        SELECT ms.*, u.username, u.display_name, u.avatar_url, u.profile_color, u.stream_key AS user_stream_key
        FROM managed_streams ms
        JOIN users u ON ms.user_id = u.id
        WHERE ms.stream_key = ?
    `, [streamKey]);
}

function getManagedStreamByIdOrSlug(userId, idOrSlug) {
    // Try numeric ID first
    const numId = parseInt(idOrSlug, 10);
    if (!isNaN(numId) && String(numId) === String(idOrSlug)) {
        return get(`
            SELECT ms.*, u.username, u.display_name, u.avatar_url, u.profile_color
            FROM managed_streams ms
            JOIN users u ON ms.user_id = u.id
            WHERE ms.id = ? AND ms.user_id = ?
        `, [numId, userId]);
    }
    // Try slug
    return getManagedStreamBySlug(userId, idOrSlug);
}

function updateManagedStream(managedStreamId, userId, fields) {
    const allowed = new Set([
        'slug', 'title', 'description', 'category', 'tags', 'protocol',
        'is_nsfw', 'control_config_id', 'sort_order',
        'streaming_method', 'browser_mode',
        'default_vod_visibility', 'default_clip_visibility', 'slot_vod_recording_enabled', 'slot_clip_recording_enabled',
        'slot_clip_notify_enabled', 'slot_powerchat_relay', 'slot_powerchat_count_rs_views',
        'weather_zip', 'weather_detail', 'weather_show_location', 'mic_only_image',
        'pip_source_msid', 'pip_defaults',
    ]);
    const updates = [];
    const params = [];
    for (const [key, val] of Object.entries(fields)) {
        if (val !== undefined && allowed.has(key)) {
            updates.push(`${key} = ?`);
            params.push(['tags', 'pip_defaults'].includes(key)
                ? (typeof val === 'string' ? val : JSON.stringify(val))
                : val);
        }
    }
    if (updates.length === 0) return;
    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(managedStreamId, userId);
    return run(`UPDATE managed_streams SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, params);
}

/**
 * Resolve the picture-in-picture camera overlay for a slot.
 *
 * Returns the CURRENTLY LIVE session of the slot this one points at, or null. The
 * camera is an ordinary slot publishing an ordinary stream, so it already has its own
 * VOD, clips, transcript and restreams; all the viewer needs is which live stream to
 * play in the overlay and where to put it by default.
 *
 * Self-reference is rejected: a slot pointing at itself would ask the player to render
 * a stream inside itself.
 */
function getPipOverlayForManagedStream(managedStreamId) {
    try {
        const ms = get('SELECT id, pip_source_msid, pip_defaults FROM managed_streams WHERE id = ?', [managedStreamId]);
        if (!ms || !ms.pip_source_msid || ms.pip_source_msid === ms.id) return null;
        const src = get(`SELECT m.id AS msid, m.title, m.slug, m.user_id,
                                s.id AS stream_id, s.is_live
                         FROM managed_streams m
                         LEFT JOIN streams s ON s.managed_stream_id = m.id AND s.is_live = 1
                         WHERE m.id = ?`, [ms.pip_source_msid]);
        if (!src) return null;
        let defaults = {};
        try { defaults = ms.pip_defaults ? JSON.parse(ms.pip_defaults) : {}; } catch { defaults = {}; }
        return {
            source_msid: src.msid,
            title: src.title || 'Camera',
            slug: src.slug || null,
            stream_id: src.stream_id || null,
            live: !!src.stream_id,
            defaults,
        };
    } catch { return null; }
}

/** Slots that could serve as a PiP source for this user (everything except `excludeId`). */
function getPipCandidateSlots(userId, excludeId = null) {
    try {
        return all(`SELECT id, title, slug FROM managed_streams
                    WHERE user_id = ? AND (? IS NULL OR id != ?)
                    ORDER BY sort_order ASC, id ASC`, [userId, excludeId, excludeId]);
    } catch { return []; }
}

function deleteManagedStream(managedStreamId, userId) {
    // Unlink sessions first (don't delete them — they're historical)
    run('UPDATE streams SET managed_stream_id = NULL WHERE managed_stream_id = ?', [managedStreamId]);
    return run('DELETE FROM managed_streams WHERE id = ? AND user_id = ?', [managedStreamId, userId]);
}

function getManagedStreamBroadcastSettings(managedStreamId, userId) {
    const row = get('SELECT broadcast_settings FROM managed_streams WHERE id = ? AND user_id = ?', [managedStreamId, userId]);
    if (!row || !row.broadcast_settings) return {};
    try { return JSON.parse(row.broadcast_settings); } catch { return {}; }
}

function updateManagedStreamBroadcastSettings(managedStreamId, userId, settings) {
    const json = typeof settings === 'string' ? settings : JSON.stringify(settings || {});
    return run(
        'UPDATE managed_streams SET broadcast_settings = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
        [json, managedStreamId, userId]
    );
}

function countManagedStreamsByUser(userId) {
    return get('SELECT COUNT(*) AS count FROM managed_streams WHERE user_id = ?', [userId])?.count || 0;
}

function getManagedStreamLimit(user) {
    // Admin override takes priority
    if (user.max_managed_streams != null && user.max_managed_streams > 0) {
        return user.max_managed_streams;
    }
    // Level-based expansion: base 3, +1 per 10 levels, max 10
    const level = getUserTotalGameLevel(user.id);
    const bonus = Math.floor(level / 10);
    return Math.min(3 + bonus, 10);
}

function ensureStreamerRoleOnFeed(userId) {
    const user = getUserById(userId);
    if (user && user.role === 'user') {
        run('UPDATE users SET role = ? WHERE id = ?', ['streamer', userId]);
        console.log(`[DB] Promoted user ${userId} to streamer on first real feed`);
        return true;
    }
    return false;
}

function isValidManagedStreamSlug(slug) {
    if (!slug || typeof slug !== 'string') return false;
    const cleaned = slug.trim();
    if (cleaned.length < 2 || cleaned.length > 32) return false;
    // Must not be purely numeric
    if (/^\d+$/.test(cleaned)) return false;
    // Alphanumeric, hyphens, underscores only
    if (!/^[a-zA-Z0-9_-]+$/.test(cleaned)) return false;
    // Must start with a letter
    if (!/^[a-zA-Z]/.test(cleaned)) return false;
    return true;
}

function isManagedStreamSlugTaken(userId, slug, excludeId = null) {
    const params = [userId, slug];
    let sql = 'SELECT id FROM managed_streams WHERE user_id = ? AND slug = ? COLLATE NOCASE';
    if (excludeId) {
        sql += ' AND id != ?';
        params.push(excludeId);
    }
    return !!get(sql, params);
}

function getRecentlyOnlineStreamers(limit = 20, offset = 0) {
    // Use a correlated subquery to aggregate managed streams per user — avoids session-row
    // duplication that occurred when LEFT JOIN managed_streams was used in the outer query.
    return all(`
        SELECT u.id AS user_id, u.username, u.display_name, u.avatar_url, u.profile_color,
               MAX(s.ended_at) AS last_online_at,
               o.overview AS ai_overview, o.overview_short AS ai_overview_short,
               (
                   SELECT json_group_array(json_object(
                       'managed_stream_id', ms2.id,
                       'slug', ms2.slug,
                       'title', ms2.title,
                       'protocol', ms2.protocol,
                       'last_live_at', (SELECT MAX(s2.ended_at) FROM streams s2 WHERE s2.managed_stream_id = ms2.id AND s2.ended_at IS NOT NULL),
                       -- filled by the route from OpenVibe.Media (GET /vods/latest-thumbs)
                       'vod_thumbnail', NULL
                   ))
                   FROM managed_streams ms2
                   WHERE ms2.user_id = u.id
                     AND EXISTS (SELECT 1 FROM streams sx WHERE sx.managed_stream_id = ms2.id AND sx.ended_at IS NOT NULL)
               ) AS managed_streams_json
        FROM streams s
        JOIN users u ON s.user_id = u.id
        LEFT JOIN streamer_overviews o ON o.user_id = u.id
        WHERE s.is_live = 0 AND s.ended_at IS NOT NULL
        GROUP BY u.id
        ORDER BY last_online_at DESC
        LIMIT ? OFFSET ?
    `, [limit, offset]);
}

function countRecentlyOnlineStreamers() {
    return get(`
        SELECT COUNT(DISTINCT user_id) AS count
        FROM streams
        WHERE is_live = 0 AND ended_at IS NOT NULL
    `)?.count || 0;
}

// Public-facing site totals for the home hero stats bar.
let _homeStatsCache = null;
let _homeStatsCacheAt = 0;
const _HOME_STATS_TTL = 30 * 1000; // 30s memo so the windowed COUNTs don't hammer SQLite

// ── Viewer trend sampling (home hero sparkline) ──────────────
// One row every ~5 minutes: total native viewers + live stream count.
function _ensureViewerSamples() {
    try {
        getDb().exec(`CREATE TABLE IF NOT EXISTS viewer_samples (
            sampled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            viewers INTEGER NOT NULL DEFAULT 0,
            live_streams INTEGER NOT NULL DEFAULT 0
        )`);
        getDb().exec('CREATE INDEX IF NOT EXISTS idx_viewer_samples_at ON viewer_samples(sampled_at)');
    } catch { /* */ }
}
function recordViewerSample() {
    _ensureViewerSamples();
    const r = get(`SELECT COALESCE(SUM(viewer_count),0) AS v, COUNT(*) AS n FROM streams WHERE is_live = 1`) || { v: 0, n: 0 };
    run('INSERT INTO viewer_samples (viewers, live_streams) VALUES (?, ?)', [r.v || 0, r.n || 0]);
    // A year of five-minute samples is ~105k small rows; it is what the "over time" charts for the
    // two live readings are drawn from.
    run(`DELETE FROM viewer_samples WHERE sampled_at < datetime('now', '-400 days')`);
    return r;
}
/**
 * What "normal" looks like for the two instantaneous numbers.
 *
 * Live streams and current viewers have no seven-day total — they are readings, not counters, so
 * "+2 in 7d" is meaningless for them. What is meaningful is whether right now is busier or
 * quieter than usual, and the five-minute sampler has been recording exactly that for a week.
 * Averages are taken over samples where anything was happening, so a quiet night does not drag
 * the baseline to zero and make every daytime reading look like a record.
 */
function getConcurrencyBaseline() {
    _ensureViewerSamples();
    const row = get(`
        SELECT
            AVG(CASE WHEN sampled_at >= datetime('now','-1 day') AND viewers > 0 THEN viewers END)      AS vAvg24,
            MAX(CASE WHEN sampled_at >= datetime('now','-1 day') THEN viewers END)                      AS vPeak24,
            AVG(CASE WHEN viewers > 0 THEN viewers END)                                                 AS vAvg7,
            AVG(CASE WHEN sampled_at >= datetime('now','-1 day') AND live_streams > 0 THEN live_streams END) AS lAvg24,
            MAX(CASE WHEN sampled_at >= datetime('now','-1 day') THEN live_streams END)                 AS lPeak24,
            AVG(CASE WHEN live_streams > 0 THEN live_streams END)                                       AS lAvg7,
            COUNT(*)                                                                                    AS samples
        FROM viewer_samples WHERE sampled_at >= datetime('now','-7 days')`) || {};
    const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : null);
    return {
        viewersAvg24h: num(row.vAvg24), viewersPeak24h: num(row.vPeak24), viewersAvg7d: num(row.vAvg7),
        liveAvg24h: num(row.lAvg24), livePeak24h: num(row.lPeak24), liveAvg7d: num(row.lAvg7),
        samples: Number(row.samples) || 0,
    };
}

function getViewerTrend(hours = 24, maxPoints = 48) {
    _ensureViewerSamples();
    const rows = all(`SELECT strftime('%s', sampled_at) AS t, viewers, live_streams FROM viewer_samples
        WHERE sampled_at >= datetime('now', ?) ORDER BY sampled_at ASC`, [`-${Math.max(1, hours)} hours`]) || [];
    if (rows.length <= maxPoints) return rows;
    const step = rows.length / maxPoints;
    const out = [];
    for (let i = 0; i < maxPoints; i++) out.push(rows[Math.floor(i * step)]);
    return out;
}

// ── Home "pulse": goals near completion, latest activity, weekly leaders ──────
function getHomePulse() {
    const safe = (fn, dflt) => { try { return fn() ?? dflt; } catch { return dflt; } };
    return {
        // Active goals closest to completion, site-wide.
        goals: safe(() => all(`SELECT g.id, g.title, g.current_amount, g.target_amount, g.image_url,
                u.username, u.display_name
            FROM donation_goals g JOIN users u ON u.id = g.user_id
            WHERE g.is_active = 1 AND g.target_amount > 0
            ORDER BY (CAST(g.current_amount AS REAL) / g.target_amount) DESC, g.current_amount DESC LIMIT 3`), []),
        latestTip: safe(() => get(`SELECT t.amount, t.created_at,
                fu.username AS from_username, fu.display_name AS from_display,
                tu.username AS to_username, tu.display_name AS to_display
            FROM transactions t
            LEFT JOIN users fu ON fu.id = t.from_user_id
            JOIN users tu ON tu.id = t.to_user_id
            WHERE t.type = 'donation' ORDER BY t.id DESC LIMIT 1`), null),
        newestFollow: safe(() => get(`SELECT f.created_at,
                fu.username AS follower_username, fu.display_name AS follower_display,
                su.username AS streamer_username, su.display_name AS streamer_display
            FROM follows f
            JOIN users fu ON fu.id = f.follower_id
            JOIN users su ON su.id = f.streamer_id
            ORDER BY f.id DESC LIMIT 1`), null),
        // This week's leaders.
        topSupporters: safe(() => all(`SELECT u.username, u.display_name, u.avatar_url, SUM(t.amount) AS total
            FROM transactions t JOIN users u ON u.id = t.from_user_id
            WHERE t.type = 'donation' AND t.created_at >= datetime('now', '-7 days')
            GROUP BY t.from_user_id ORDER BY total DESC LIMIT 3`), []),
        topEarners: safe(() => all(`SELECT u.username, u.display_name, u.avatar_url, SUM(c.amount) AS total
            FROM coin_transactions c JOIN users u ON u.id = c.user_id
            WHERE c.amount > 0 AND c.created_at >= datetime('now', '-7 days')
            GROUP BY c.user_id ORDER BY total DESC LIMIT 3`), []),
    };
}

// Nearest active goal per streamer (for Recently Online cards) — one query.
function getActiveGoalsForUsers(userIds) {
    if (!userIds || !userIds.length) return {};
    const ph = userIds.map(() => '?').join(',');
    const rows = all(`SELECT user_id, title, current_amount, target_amount FROM donation_goals
        WHERE is_active = 1 AND target_amount > 0 AND user_id IN (${ph})
        ORDER BY (CAST(current_amount AS REAL) / target_amount) DESC`, userIds) || [];
    const out = {};
    for (const r of rows) if (!out[r.user_id]) out[r.user_id] = r;
    return out;
}

/** ISO cutoff for Vibes stats (setting `stats_vibes_reset_at`), or the epoch when unset. */
function vibesStatsSince() {
    try {
        const v = String(getSetting('stats_vibes_reset_at') || '').trim();
        if (v && !isNaN(Date.parse(v))) return new Date(v).toISOString().replace('T', ' ').slice(0, 19);
    } catch { /* */ }
    return '1970-01-01 00:00:00';
}

// ── Home stat series (click a hero stat → "over time" chart) ────────────────
// One registry entry per metric: the table, its timestamp column, what to aggregate and
// an optional WHERE. `days` buckets are computed in SQL by date(); missing days are
// filled with 0 so charts never skip a day.
const HOME_SERIES = {
    users:       { table: 'users',             ts: 'created_at',  agg: 'COUNT(*)',              where: 'COALESCE(is_banned, 0) = 0' },
    anons:       { table: 'anon_ip_mappings',  ts: 'created_at',  agg: 'COUNT(*)' },
    visitors:    { table: 'anon_ip_mappings',  ts: 'created_at',  agg: 'COUNT(*)' },
    follows:     { table: 'follows',           ts: 'created_at',  agg: 'COUNT(*)' },
    // No chat series here: OpenVibe.Chat owns chat_messages. `messages` and `active` are answered by
    // getHomeStatSeries from Chat's `site-daily` stats read; there is no Live-table fallback any more
    // (since 2026-10-05 Live keeps no copy of Chat's tables), so outside chat mode they answer null.
    sessions:    { table: 'streams',           ts: 'created_at',  agg: 'COUNT(*)' },
    streamers:   { table: 'streams',           ts: 'created_at',  agg: 'COUNT(DISTINCT user_id)' },
    // vods, clips, hours and pastes are OpenVibe.Media's series (home/routes.js MEDIA_SERIES).
    hoursWatched:{ table: 'watch_time',        ts: 'created_at',  agg: 'COALESCE(SUM(minutes_watched), 0) / 60.0' },
    aiMoments:   { table: 'stream_memories',   ts: 'created_at',  agg: 'COUNT(*)' },
    vibes:       { table: 'transactions',      ts: 'created_at',  agg: 'COALESCE(SUM(amount), 0)', where: "type = 'donation'", vibesReset: true },
    supporters:  { table: 'transactions',      ts: 'created_at',  agg: 'COUNT(DISTINCT from_user_id)', where: "type = 'donation' AND from_user_id IS NOT NULL", vibesReset: true },
    vibesBought: { table: 'payment_orders',    ts: 'updated_at',  agg: 'COALESCE(SUM(bucks), 0)', where: "kind = 'bucks' AND status = 'credited'" },
    subs:        { table: 'subscriptions',     ts: 'created_at',  agg: 'COUNT(*)' },
    points:      { table: 'coin_transactions', ts: 'created_at',  agg: 'COALESCE(SUM(amount), 0)', where: 'amount > 0' },
    pointsSpent: { table: 'coin_transactions', ts: 'created_at',  agg: 'COALESCE(-SUM(amount), 0)', where: 'amount < 0' },
    redemptions: { table: 'coin_redemptions',  ts: 'created_at',  agg: 'COUNT(*)',              where: "status NOT IN ('rejected', 'refunded')" },
    // No `emotes` series: OpenVibe.Chat owns that table (roadmap T3) and Live's copy is dropped
    // since N+2 (unlike the table itself, which N-1 still prepares against — see schema.sql).
};
const HOME_SERIES_KEYS = [...Object.keys(HOME_SERIES), 'messages', 'active', 'liveNow', 'viewersNow'];

/**
 * The daily series for one metric from Live's own tables. The two chat metrics (`messages`,
 * `active`) have no entry here: OpenVibe.Chat owns chat_messages, so getHomeStatSeries answers
 * them from Chat, and with Chat unreachable they answer null rather than a Live-table number.
 */
function homeSeriesLocal(metric, days = 30) {
    const def = HOME_SERIES[metric];
    if (!def) return null;
    days = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
    const where = [`${def.ts} >= datetime('now', ?)`];
    if (def.where) where.push(def.where);
    if (def.vibesReset) where.push(`${def.ts} >= '${vibesStatsSince()}'`);
    let rows = [];
    try {
        rows = all(`SELECT date(${def.ts}) AS day, ${def.agg} AS value FROM ${def.table} WHERE ${where.join(' AND ')} GROUP BY day ORDER BY day ASC`, [`-${days - 1} days`]);
    } catch { rows = []; }
    const byDay = new Map(rows.map(r => [r.day, Number(r.value) || 0]));
    const points = [];
    for (let i = days - 1; i >= 0; i--) {
        const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        points.push({ day, value: Number((byDay.get(day) || 0).toFixed(2)) });
    }
    const total = Number(points.reduce((a, p) => a + p.value, 0).toFixed(2));
    // `before`: everything up to the window, so a running total starts at the real all-time figure.
    // `prev_total`: the same-length window just before this one, for "vs previous period".
    const scalar = (extra, params) => {
        const w = [...(def.where ? [def.where] : []), ...(def.vibesReset ? [`${def.ts} >= '${vibesStatsSince()}'`] : []), extra];
        try { return Number(get(`SELECT ${def.agg} AS value FROM ${def.table} WHERE ${w.join(' AND ')}`, params)?.value) || 0; } catch { return 0; }
    };
    const before = scalar(`${def.ts} < datetime('now', ?)`, [`-${days - 1} days`]);
    const prevTotal = scalar(`${def.ts} >= datetime('now', ?) AND ${def.ts} < datetime('now', ?)`, [`-${2 * days - 1} days`, `-${days - 1} days`]);
    return { metric, kind: 'count', days, points, total, peak: Math.max(0, ...points.map(p => p.value)),
        before: Number(before.toFixed(2)), prev_total: Number(prevTotal.toFixed(2)) };
}

/**
 * The daily series behind a hero stat. With CHAT_AUTHORITY=chat the two chat metrics (`messages`,
 * `active`) answer from Chat's site-wide per-day read (chat-reads.homeSeriesPeek — a cached
 * stale-while-revalidate peek that falls back to Live's own tables when Chat is unreachable);
 * every other metric is Live's own.
 */
function getHomeStatSeries(metric, days = 30) {
    if (metric === 'messages' || metric === 'active') {
        try {
            const s = require('../chat/chat-reads').homeSeriesPeek(metric, days);
            if (s) return s;
        } catch { /* fall through to Live's own tables */ }
    }
    return homeSeriesLocal(metric, days);
}

/**
 * The two live readings (streams live, people watching) over time, from the five-minute sampler.
 * Unlike counters they do not add up across a day, so each bucket carries the average reading
 * and the peak. Up to a week is shown per hour, longer ranges per day. Buckets with no samples
 * (before the sampler existed, or while the server was down) are null, not zero.
 */
const READING_SERIES = { liveNow: 'live_streams', viewersNow: 'viewers' };
function getReadingSeries(metric, days = 7) {
    const col = READING_SERIES[metric];
    if (!col) return null;
    _ensureViewerSamples();
    days = Math.max(1, Math.min(365, parseInt(days, 10) || 7));
    const hourly = days <= 7;
    const fmt = hourly ? '%Y-%m-%dT%H:00:00Z' : '%Y-%m-%d';
    let rows = [];
    try {
        rows = all(`SELECT strftime('${fmt}', sampled_at) AS b, AVG(${col}) AS avg, MAX(${col}) AS peak, COUNT(*) AS n
            FROM viewer_samples WHERE sampled_at >= datetime('now', ?) GROUP BY b`, [hourly ? `-${days * 24 - 1} hours` : `-${days - 1} days`]);
    } catch { rows = []; }
    const byB = new Map(rows.map(r => [r.b, r]));
    const points = [];
    const now = Date.now();
    const n = hourly ? days * 24 : days;
    for (let i = n - 1; i >= 0; i--) {
        const d = new Date(now - i * (hourly ? 3600000 : 86400000));
        const key = hourly ? d.toISOString().slice(0, 13) + ':00:00Z' : d.toISOString().slice(0, 10);
        const r = byB.get(key);
        points.push({ t: key, value: r ? Math.round(Number(r.avg) * 10) / 10 : null, peak: r ? Number(r.peak) : null });
    }
    const have = points.filter(p => p.value != null);
    return {
        metric, kind: 'reading', bucket: hourly ? 'hour' : 'day', days, points,
        peak: have.length ? Math.max(...have.map(p => p.peak)) : 0,
        avg: have.length ? Math.round(have.reduce((a, p) => a + p.value, 0) / have.length * 10) / 10 : 0,
        coverage: Math.round((have.length / points.length) * 100),
    };
}

function getHomeStats() {
    const now = Date.now();
    if (_homeStatsCache && (now - _homeStatsCacheAt) < _HOME_STATS_TTL) return _homeStatsCache;
    _homeStatsCache = _computeHomeStats();
    _homeStatsCacheAt = now;
    return _homeStatsCache;
}

function _computeHomeStats() {
    // Each stat is isolated so a missing table / column can never blank the whole hero.
    const c = (sql, p = []) => { try { return get(sql, p)?.count || 0; } catch { return 0; } };
    const nowMs = Date.now();   // the home-stats snapshot's windows are relative to this instant
    // Vibes tipped before this instant were test money (site setting `stats_vibes_reset_at`,
    // ISO timestamp). Everything Vibes-related on the hero starts counting from it.
    const vibesSince = vibesStatsSince();
    // Rolling day/week/month counts for a table by its timestamp column.
    // Rolling day/week/month counts, plus `pw`: the same seven-day window shifted back a week.
    // Without a previous period, "+2 in 7d" is a number with nothing to compare it to — you can't
    // tell whether things are speeding up or slowing down, which is the only interesting part.
    const winCount = (table, col, extra = '') => {
        const q = (w) => c(`SELECT COUNT(*) AS count FROM ${table} WHERE ${col} >= datetime('now', ?)${extra ? ' AND ' + extra : ''}`, [w]);
        const prev = c(`SELECT COUNT(*) AS count FROM ${table} WHERE ${col} >= datetime('now', '-14 days') AND ${col} < datetime('now', '-7 days')${extra ? ' AND ' + extra : ''}`);
        return { d: q('-1 day'), w: q('-7 days'), m: q('-30 days'), pw: prev };
    };
    // Rolling day/week/month SUMS (for value metrics like Vibes tipped).
    const winSum = (table, col, tsCol, extra = '') => {
        const q = (w) => c(`SELECT COALESCE(SUM(${col}), 0) AS count FROM ${table} WHERE ${tsCol} >= datetime('now', ?)${extra ? ' AND ' + extra : ''}`, [w]);
        const prev = c(`SELECT COALESCE(SUM(${col}), 0) AS count FROM ${table} WHERE ${tsCol} >= datetime('now', '-14 days') AND ${tsCol} < datetime('now', '-7 days')${extra ? ' AND ' + extra : ''}`);
        return { d: q('-1 day'), w: q('-7 days'), m: q('-30 days'), pw: prev };
    };
    // Distinct people who went live in a window — "streamers" is a headcount, not a stream count.
    const streamersWin = () => {
        const q = (a, b) => c(`SELECT COUNT(DISTINCT user_id) AS count FROM streams WHERE user_id IS NOT NULL AND created_at >= datetime('now', ?)${b ? " AND created_at < datetime('now', ?)" : ''}`, b ? [a, b] : [a]);
        return { d: q('-1 day'), w: q('-7 days'), m: q('-30 days'), pw: q('-14 days', '-7 days') };
    };
    return {
        // ── Right-now + community-economy metrics ────────────────
        // Native viewers across everything currently live.
        viewersNow: c(`SELECT COALESCE(SUM(viewer_count), 0) AS count FROM streams WHERE is_live = 1`),
        // Community time actually spent watching (watch-time heartbeats → hours).
        hoursWatched: Math.round(c(`SELECT COALESCE(SUM(minutes_watched), 0) AS count FROM watch_time`) / 60),
        // Vibes tipped between people (donation ledger; bit-style, 100 = $1).
        vibesTipped: c(`SELECT COALESCE(SUM(amount), 0) AS count FROM transactions WHERE type = 'donation' AND created_at >= ?`, [vibesSince]),
        // Live channel subscriptions.
        activeSubs: c(`SELECT COUNT(*) AS count FROM subscriptions WHERE status = 'active' AND (current_period_end IS NULL OR datetime(current_period_end) > CURRENT_TIMESTAMP)`),
        // Channel points earned by viewers across every channel (watch/chat/follow bonuses).
        pointsEarned: c(`SELECT COALESCE(SUM(amount), 0) AS count FROM coin_transactions WHERE amount > 0`),
        // …and spent back on channel rewards.
        pointsSpent: c(`SELECT COALESCE(-SUM(amount), 0) AS count FROM coin_transactions WHERE amount < 0`),
        // Reward redemptions that stuck (not rejected / refunded).
        redemptions: c(`SELECT COUNT(*) AS count FROM coin_redemptions WHERE status NOT IN ('rejected', 'refunded')`),
        // Distinct people who have tipped Vibes to someone.
        supporters: c(`SELECT COUNT(DISTINCT from_user_id) AS count FROM transactions WHERE type = 'donation' AND from_user_id IS NOT NULL AND created_at >= ?`, [vibesSince]),
        // Vibes bought with real money (credited purchase orders, any provider).
        vibesBought: c(`SELECT COALESCE(SUM(bucks), 0) AS count FROM payment_orders WHERE kind = 'bucks' AND status = 'credited'`),
        // Donation goals: currently running + ever reached.
        goalsActive: c(`SELECT COUNT(*) AS count FROM donation_goals WHERE is_active = 1`),
        goalsReached: c(`SELECT COUNT(*) AS count FROM donation_goals WHERE reached_at IS NOT NULL OR current_amount >= target_amount`),
        // VODs, clips, pastes and archived hours are counted by OpenVibe.Media and OpenVibe.Community
        // (media-proxy/lookups.js withArchiveStats fills these); null until one of them answers.
        vods: null,
        clips: null,
        liveSessions: c(`SELECT COUNT(*) AS count FROM streams`),
        streamers: c(`SELECT COUNT(DISTINCT user_id) AS count FROM streams WHERE user_id IS NOT NULL`),
        // OpenVibe.Chat owns chat_messages (roadmap T3): the total comes from Chat's read API.
        // A Chat outage answers the cache, else null — never a 500 for the home page.
        chatMessages: (() => { try { const s = require('../chat/chat-reads').siteStatsPeek(); return s && s.messages != null ? s.messages : null; } catch { return null; } })(),
        users: c(`SELECT COUNT(*) AS count FROM users WHERE COALESCE(is_banned, 0) = 0`),
        anons: c(`SELECT COUNT(*) AS count FROM anon_ip_mappings`),
        follows: c(`SELECT COUNT(*) AS count FROM follows`),
        // No platform-wide emote total: OpenVibe.Chat owns `emotes` (roadmap T3) and exposes counts
        // per channel only (server/chat/moderation-client.js getEmoteCount), so there is nothing but
        // the old table to answer a site-wide number. null (as the other external figures above); the
        // key stays for the mixed-version window (test/n-1.test.js: the old client reads stats.emotes).
        emotes: null,
        pastes: null,
        aiMemories: c(`SELECT COUNT(*) AS count FROM stream_memories`),
        pasteImages: null,
        pasteText: null,
        // Total hours of video the platform has archived (OpenVibe.Media's figure).
        streamHours: null,
        // Active chatters this week across EVERYONE — registered users, anons, and relay chatters.
        // OpenVibe.Chat counts them (stats kind 'site' over the window); Live's own tables when Live
        // runs chat. The peek answers the last good count or null (never a mirror scan or a 500);
        // the hero treats null as unknown.
        weeklyActive: (() => { try { const s = require('../chat/chat-reads').windowStatsPeek({ since: nowMs - 7 * 86400000 }); return s && s.chatters != null ? s.chatters : null; } catch { return null; } })(),
        // New unique visitors this week (first-seen anon fingerprints) — a proxy for people who
        // showed up, not just those who chatted.
        weeklyVisitors: c(`SELECT COUNT(*) AS count FROM anon_ip_mappings WHERE created_at >= datetime('now', '-7 days')`),
        // The same two windows again, shifted back a week, so the hero can say whether this week
        // beat last week rather than just how big it was.
        prevWeeklyVisitors: c(`SELECT COUNT(*) AS count FROM anon_ip_mappings WHERE created_at >= datetime('now', '-14 days') AND created_at < datetime('now', '-7 days')`),
        prevWeeklyActive: (() => { try { const s = require('../chat/chat-reads').windowStatsPeek({ since: nowMs - 14 * 86400000, until: nowMs - 7 * 86400000 }); return s && s.chatters != null ? s.chatters : null; } catch { return null; } })(),
        liveNow: c(`SELECT COUNT(*) AS count FROM streams WHERE is_live = 1`),
        // Rolling last-day / week / month deltas ({ d, w, m }) for the hero stat tooltips + subs.
        recent: {
            users: winCount('users', 'created_at', 'COALESCE(is_banned, 0) = 0'),
            anons: winCount('anon_ip_mappings', 'created_at'),
            sessions: winCount('streams', 'created_at'),
            vods: null,     // OpenVibe.Media (withArchiveStats)
            clips: null,
            aiMoments: winCount('stream_memories', 'created_at'),
            // OpenVibe.Chat's message counts over each window (Live's own tables when Live runs chat).
            messages: (() => {
                const w = (o) => { try { const s = require('../chat/chat-reads').windowStatsPeek(o); return s && s.messages != null ? s.messages : null; } catch { return null; } };
                return {
                    d: w({ since: nowMs - 86400000 }),
                    w: w({ since: nowMs - 7 * 86400000 }),
                    m: w({ since: nowMs - 30 * 86400000 }),
                    pw: w({ since: nowMs - 14 * 86400000, until: nowMs - 7 * 86400000 }),
                };
            })(),
            hours: null,    // OpenVibe.Media
            streamers: streamersWin(),
            // Live's `emotes` copy was unread since N+2 and is now dropped, so the
            // deltas are zero. The key stays for the N-1 client, which reads stats.recent.emotes.
            emotes: { d: 0, w: 0, m: 0, pw: 0 },
            goals: winCount('donation_goals', 'created_at'),
            // Distinct people who tipped in each window — a headcount, like streamers.
            supporters: (() => {
                const q = (a, b) => c(`SELECT COUNT(DISTINCT from_user_id) AS count FROM transactions WHERE type = 'donation' AND from_user_id IS NOT NULL AND created_at >= datetime('now', ?)${b ? " AND created_at < datetime('now', ?)" : ''}`, b ? [a, b] : [a]);
                return { d: q('-1 day'), w: q('-7 days'), m: q('-30 days'), pw: q('-14 days', '-7 days') };
            })(),
            vibes: winSum('transactions', 'amount', 'created_at', `type = 'donation' AND created_at >= '${vibesSince}'`),
            points: winSum('coin_transactions', 'amount', 'created_at', 'amount > 0'),
            pointsSpent: winSum('coin_transactions', '-amount', 'created_at', 'amount < 0'),
            redemptions: winCount('coin_redemptions', 'created_at', "status NOT IN ('rejected', 'refunded')"),
            vibesBought: winSum('payment_orders', 'bucks', 'updated_at', "kind = 'bucks' AND status = 'credited'"),
            subs: winCount('subscriptions', 'created_at'),
            follows: winCount('follows', 'created_at'),
        },
    };
}

// ── Channel helpers ──────────────────────────────────────────

function getChannelByUserId(userId) {
    return get('SELECT * FROM channels WHERE user_id = ?', [userId]);
}
/**
 * Whether OpenVibe's AI may derive Moments (auto-clips, AI moment pastes, AI-written recaps) from
 * this account's streams: the channel's ai_derivation_enabled, on by default and for an account
 * with no channel row. Read by every job that makes them (roadmap 33.7).
 */
function isAiDerivationEnabled(userId) {
    if (userId == null || userId === '') return true;
    try {
        const row = get('SELECT ai_derivation_enabled FROM channels WHERE user_id = ?', [userId]);
        return !row || row.ai_derivation_enabled == null || Number(row.ai_derivation_enabled) !== 0;
    } catch { return true; }
}
// Batched lookup → { userId: channelRow }. Avoids the N+1 in the live-streams list
// (one query for all channels instead of one per stream).
function getChannelsByUserIds(userIds) {
    const ids = [...new Set((userIds || []).filter(v => v != null))];
    if (!ids.length) return {};
    const rows = all(`SELECT * FROM channels WHERE user_id IN (${ids.map(() => '?').join(',')})`, ids);
    const map = {};
    for (const r of rows) map[r.user_id] = r;
    return map;
}

// A streamer's Channel Points config (custom name/icon + earn/game intervals), with defaults.
function getChannelPointsConfig(streamerId) {
    const ch = getChannelByUserId(streamerId) || {};
    const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    return {
        name: (ch.cp_name || 'Channel Points').toString().slice(0, 32),
        icon: (ch.cp_icon || 'fa-coins').toString(),
        watch_interval_min: Math.max(1, n(ch.cp_watch_interval_min, 5)),
        watch_amount: Math.max(0, n(ch.cp_watch_amount, 10)),
        game_interval_min: Math.max(0, n(ch.cp_game_interval_min, 0)),
    };
}
function setChannelPointsConfig(streamerId, fields) {
    const ch = ensureChannel(streamerId);
    if (!ch) return;
    const map = { name: 'cp_name', icon: 'cp_icon', watch_interval_min: 'cp_watch_interval_min', watch_amount: 'cp_watch_amount', game_interval_min: 'cp_game_interval_min' };
    const cols = [], vals = [];
    for (const k in map) if (fields[k] !== undefined) { cols.push(`${map[k]} = ?`); vals.push(fields[k]); }
    if (!cols.length) return;
    vals.push(ch.id);
    run(`UPDATE channels SET ${cols.join(', ')} WHERE id = ?`, vals);
}

function getChannelByUsername(username) {
    return get(`
        SELECT c.*, u.username, u.display_name, u.avatar_url, u.profile_color, u.bio, u.stream_key, u.role, u.is_owner
        FROM channels c
        JOIN users u ON c.user_id = u.id
        WHERE u.username = ? COLLATE NOCASE
    `, [username]);
}

function createChannel({ user_id, title, description, category, protocol }) {
    return run(
        `INSERT OR IGNORE INTO channels (user_id, title, description, category, protocol)
         VALUES (?, ?, ?, ?, ?)`,
        [user_id, title || 'Untitled Channel', description || '', category || null, protocol || 'webrtc']
    );
}

function updateChannel(userId, fields) {
    const updates = [];
    const params = [];
    for (const [key, val] of Object.entries(fields)) {
        if (val !== undefined && ['title', 'description', 'category', 'tags', 'protocol', 'is_nsfw', 'force_nsfw', 'auto_record', 'vod_recording_enabled', 'force_vod_recording_disabled', 'offline_banner_url', 'panels', 'emote_sources', 'weather_zip', 'weather_detail', 'weather_show_location', 'control_mode', 'anon_controls_enabled', 'control_rate_limit_ms', 'active_control_config_id', 'video_click_enabled', 'offline_screen_type', 'offline_screen_url', 'offline_html', 'offline_css', 'hide_ai_overview', 'ai_overview_pref', 'chat_language', 'ai_derivation_enabled', 'social_links', 'bot_robot_id'].includes(key)) {
            updates.push(`${key} = ?`);
            params.push(['tags', 'panels', 'emote_sources'].includes(key) ? (typeof val === 'string' ? val : JSON.stringify(val)) : val);
        }
    }
    if (updates.length === 0) return;
    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(userId);
    return run(`UPDATE channels SET ${updates.join(', ')} WHERE user_id = ?`, params);
}

// Set a user's bio (profile blurb). Used by the About-tab editor, including mods
// editing a streamer's About when the streamer has allowed it.
function setUserBio(userId, bio) {
    return run('UPDATE users SET bio = ? WHERE id = ?', [String(bio == null ? '' : bio).slice(0, 500), userId]);
}

function ensureChannel(userId) {
    let ch = getChannelByUserId(userId);
    if (!ch) {
        const user = getUserById(userId);
        createChannel({ user_id: userId, title: `${user?.display_name || user?.username}'s Channel` });
        ch = getChannelByUserId(userId);
    }
    return ch;
}

function getChannelVodRecordingPolicyByUserId(userId, managedStreamId = null) {
    const channel = getChannelByUserId(userId);
    let recordingEnabled = !channel
        ? true
        : !!channel.vod_recording_enabled && !channel.force_vod_recording_disabled;
    // Per-stream override: a slot can disable VOD recording for just that stream.
    if (recordingEnabled && managedStreamId) {
        try {
            const ms = get('SELECT slot_vod_recording_enabled FROM managed_streams WHERE id = ?', [managedStreamId]);
            if (ms && ms.slot_vod_recording_enabled === 0) recordingEnabled = false;
        } catch { /* keep channel-level */ }
    }
    return {
        channel,
        recordingEnabled,
        forcedDisabled: !!channel?.force_vod_recording_disabled,
    };
}
// Resolve what (if anything) the server should record for a live stream, from the per-slot
// VOD + clip toggles:
//   'vod'   → VOD recording is on: record + publish a full VOD (clips cut from it too).
//   'clips' → VOD off but clipping on: record an EPHEMERAL rolling file just to serve clips;
//             never published, deleted when the stream ends.
//   'none'  → both off: don't record at all. (Live thumbnails, AI vision and audio memories
//             still run — they tap the live feed directly, not the VOD recording.)
function resolveStreamRecordingMode(stream) {
    if (!stream) return 'none';
    let vodEnabled = false;
    try { vodEnabled = getChannelVodRecordingPolicyByUserId(stream.user_id, stream.managed_stream_id).recordingEnabled; } catch { /* */ }
    if (vodEnabled) return 'vod';
    let clipsEnabled = true;
    try { clipsEnabled = isStreamClipRecordingEnabled(stream); } catch { /* */ }
    return clipsEnabled ? 'clips' : 'none';
}
// Effective VOD/clip visibility for a stream: per-slot setting first, else channel, else public.
function resolveStreamVodVisibility(stream) {
    try {
        if (stream && stream.managed_stream_id) {
            const ms = get('SELECT default_vod_visibility FROM managed_streams WHERE id = ?', [stream.managed_stream_id]);
            if (ms && ms.default_vod_visibility) return ms.default_vod_visibility;
        }
        const ch = stream && getChannelByUserId(stream.user_id);
        if (ch && ch.default_vod_visibility) return ch.default_vod_visibility;
    } catch { /* fall through */ }
    return 'public';
}
function resolveStreamClipVisibility(stream) {
    try {
        if (stream && stream.managed_stream_id) {
            const ms = get('SELECT default_clip_visibility, slot_clip_recording_enabled FROM managed_streams WHERE id = ?', [stream.managed_stream_id]);
            if (ms && ms.default_clip_visibility) return ms.default_clip_visibility;
        }
        const ch = stream && getChannelByUserId(stream.user_id);
        if (ch && ch.default_clip_visibility) return ch.default_clip_visibility;
    } catch { /* fall through */ }
    return 'public';
}
// Whether clip creation is enabled for a stream's slot (per-stream toggle).
function isStreamClipRecordingEnabled(stream) {
    try {
        if (stream && stream.managed_stream_id) {
            const ms = get('SELECT slot_clip_recording_enabled FROM managed_streams WHERE id = ?', [stream.managed_stream_id]);
            if (ms && ms.slot_clip_recording_enabled === 0) return false;
        }
    } catch { /* default enabled */ }
    return true;
}

// ── RobotStreamer integration helpers ───────────────────────

function getRobotStreamerIntegrationByUserId(userId) {
    // A legacy account-level row (no slot binding). It applies to no stream any more:
    // scripts/rs-integrations-to-slots.js moves these onto slots. Read only to report them.
    return get('SELECT * FROM robotstreamer_integrations WHERE user_id = ? AND managed_stream_id IS NULL', [userId]);
}

function getRobotStreamerIntegrationBySlot(userId, managedStreamId) {
    if (!managedStreamId) return null;
    return get('SELECT * FROM robotstreamer_integrations WHERE user_id = ? AND managed_stream_id = ?', [userId, managedStreamId]);
}

// Users already warned about an unmigrated account-level row (once per process each).
const _rsAccountRowWarned = new Set();

/**
 * The RobotStreamer config a stream on this slot uses: the slot's own row, and nothing else.
 * No slot (a legacy session) or a slot without a row means no RobotStreamer. An account-level
 * row that has not been moved onto a slot yet is logged and skipped, never used: that fallback
 * sent every slot without its own row to the same robot.
 */
function getRobotStreamerIntegrationForStream(userId, managedStreamId) {
    const row = managedStreamId ? getRobotStreamerIntegrationBySlot(userId, managedStreamId) : null;
    if (row) return row;
    try {
        if (!_rsAccountRowWarned.has(userId)) {
            const legacy = getRobotStreamerIntegrationByUserId(userId);
            if (legacy) {
                _rsAccountRowWarned.add(userId);
                console.warn(`[RS] User ${userId} has an account-level RobotStreamer row (${legacy.id}) that applies to no stream; skipped. Bind it to a slot with scripts/rs-integrations-to-slots.js.`);
            }
        }
    } catch { /* reporting only */ }
    return null;
}

function deleteRobotStreamerIntegrationForSlot(userId, managedStreamId) {
    if (!managedStreamId) return;
    run('DELETE FROM robotstreamer_integrations WHERE user_id = ? AND managed_stream_id = ?', [userId, managedStreamId]);
}

function upsertRobotStreamerIntegration(userId, fields, managedStreamId = null) {
    const allowed = new Set([
        'enabled',
        'mirror_chat',
        'token',
        'robot_id',
        'owner_id',
        'chat_url',
        'control_url',
        'rtc_sfu_url',
        'stream_name',
        'owner_name',
        'last_validated_at',
    ]);
    // RobotStreamer is configured per stream slot; account-level rows are no longer written.
    const slotId = managedStreamId || null;
    if (!slotId) throw new Error('RobotStreamer settings belong to a stream slot (managed_stream_id is required)');
    const existing = getRobotStreamerIntegrationBySlot(userId, slotId);
    const filtered = Object.entries(fields || {}).filter(([key, val]) => allowed.has(key) && val !== undefined);

    if (!filtered.length) return existing;

    if (existing) {
        const updates = [];
        const params = [];
        for (const [key, val] of filtered) {
            updates.push(`${key} = ?`);
            params.push(val);
        }
        updates.push('updated_at = CURRENT_TIMESTAMP');
        params.push(userId, slotId);
        run(`UPDATE robotstreamer_integrations SET ${updates.join(', ')} WHERE user_id = ? AND managed_stream_id IS ?`, params);
    } else {
        const keys = ['user_id', 'managed_stream_id', ...filtered.map(([key]) => key), 'updated_at'];
        const placeholders = keys.map(() => '?').join(', ');
        const params = [userId, slotId, ...filtered.map(([, val]) => val), new Date().toISOString()];
        run(
            `INSERT INTO robotstreamer_integrations (${keys.join(', ')}) VALUES (${placeholders})`,
            params,
        );
    }

    return getRobotStreamerIntegrationBySlot(userId, slotId);
}

// ── Restream Destination helpers ─────────────────────────────

function getRestreamDestinationsByUserId(userId) {
    return all('SELECT * FROM restream_destinations WHERE user_id = ? ORDER BY created_at', [userId]);
}

// Circuit breaker: escalating cooldown after repeated go-live failures for a destination.
// 1st → 15m, 2nd → 1h, 3rd → 6h, 4th+ → 24h. Returns the new cooldown_until (ms epoch).
function markRestreamDestinationFailure(id, error) {
    try {
        const row = get('SELECT consecutive_failures FROM restream_destinations WHERE id = ?', [id]);
        const n = ((row && row.consecutive_failures) || 0) + 1;
        const mins = n <= 1 ? 15 : n === 2 ? 60 : n === 3 ? 360 : 1440;
        run(`UPDATE restream_destinations SET consecutive_failures = ?, last_error = ?, last_failed_at = CURRENT_TIMESTAMP,
             cooldown_until = datetime('now', ?) WHERE id = ?`,
            [n, String(error || 'restream failed to go live').slice(0, 300), `+${mins} minutes`, id]);
        return { failures: n, cooldownMinutes: mins };
    } catch { return null; }
}
function clearRestreamDestinationCooldown(id) {
    try { run('UPDATE restream_destinations SET consecutive_failures = 0, cooldown_until = NULL, last_error = NULL WHERE id = ?', [id]); } catch { /* */ }
}
// Remaining cooldown in ms (0 if not cooling down).
function restreamDestinationCooldownMs(dest) {
    try {
        if (!dest || !dest.cooldown_until) return 0;
        const until = new Date(String(dest.cooldown_until).replace(' ', 'T') + 'Z').getTime();
        return until > Date.now() ? (until - Date.now()) : 0;
    } catch { return 0; }
}

function getRestreamDestinationById(id) {
    return get('SELECT * FROM restream_destinations WHERE id = ?', [id]);
}

function createRestreamDestination(userId, fields) {
    const result = run(
        `INSERT INTO restream_destinations (user_id, managed_stream_id, platform, name, server_url, stream_key, enabled, auto_start, quality_preset,
         custom_video_bitrate, custom_audio_bitrate, custom_fps, custom_encoder_preset, srt_latency_ms, srt_passphrase, channel_url, chat_relay, powerchat_relay, powerchat_count_views)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, fields.managed_stream_id || null, fields.platform, fields.name || null, fields.server_url || null,
         fields.stream_key || null, fields.enabled ?? 1, fields.auto_start ?? 0,
         fields.quality_preset || 'auto',
         fields.custom_video_bitrate ?? null, fields.custom_audio_bitrate ?? null,
         fields.custom_fps ?? null, fields.custom_encoder_preset || null,
         fields.srt_latency_ms ?? null, fields.srt_passphrase || null,
         fields.channel_url || null, fields.chat_relay ? 1 : 0, fields.powerchat_relay === 0 ? 0 : 1, fields.powerchat_count_views === 0 ? 0 : 1]
    );
    return get('SELECT * FROM restream_destinations WHERE id = ?', [result.lastInsertRowid]);
}

function updateRestreamDestination(id, fields) {
    const allowed = new Set(['name', 'server_url', 'stream_key', 'enabled', 'auto_start', 'quality_preset',
        'custom_video_bitrate', 'custom_audio_bitrate', 'custom_fps', 'custom_encoder_preset', 'srt_latency_ms', 'srt_passphrase',
        'channel_url', 'chat_relay', 'powerchat_relay', 'powerchat_count_views', 'managed_stream_id', 'connection_id']);
    const filtered = Object.entries(fields || {}).filter(([key]) => allowed.has(key));
    if (!filtered.length) return getRestreamDestinationById(id);

    const updates = filtered.map(([key]) => `${key} = ?`);
    updates.push('updated_at = CURRENT_TIMESTAMP');
    const params = [...filtered.map(([, val]) => val), id];

    run(`UPDATE restream_destinations SET ${updates.join(', ')} WHERE id = ?`, params);
    return getRestreamDestinationById(id);
}

function deleteRestreamDestination(id) {
    return run('DELETE FROM restream_destinations WHERE id = ?', [id]);
}

function getRestreamDestinationsByManagedStream(managedStreamId) {
    return all('SELECT * FROM restream_destinations WHERE managed_stream_id = ? ORDER BY created_at', [managedStreamId]);
}

/**
 * The destinations a stream on this slot may use, and nothing else: a slot gets only the
 * destinations bound to it; no slot (a legacy session) gets only the owner's unbound rows.
 * There is no fallback to every destination the account owns: that fallback started one
 * slot's auto-start destinations when the streamer went live on another slot.
 */
function getRestreamDestinationsForSlot(userId, managedStreamId) {
    if (managedStreamId) {
        return all('SELECT * FROM restream_destinations WHERE user_id = ? AND managed_stream_id = ? ORDER BY created_at', [userId, managedStreamId]);
    }
    return all('SELECT * FROM restream_destinations WHERE user_id = ? AND managed_stream_id IS NULL ORDER BY created_at', [userId]);
}

// ── Platform OAuth connection helpers ────────────────────────

// ── Per-streamer channel points ("OpenCoins") ──
function getChannelPoints(userId, streamerId) {
    if (!userId || !streamerId) return 0;
    const r = get('SELECT balance FROM channel_points WHERE user_id = ? AND streamer_id = ?', [userId, streamerId]);
    return r ? r.balance : 0;
}
/**
 * Apply one channel-points event, keyed (ADR-012 rule 5): { applied, replayed, balance }.
 * A key seen before is a replay: nothing moves, and the same key for a different user, channel or
 * amount is refused. A debit (delta < 0) only happens when the balance covers it; a refused debit
 * leaves no log row, so the same key can be tried again later.
 */
function applyChannelPoints({ userId, streamerId, delta, key, reason = null }) {
    if (!key || typeof key !== 'string') throw new TypeError('channel points: an idempotency key is required for every debit and credit');
    if (!userId || !streamerId || !Number.isInteger(delta) || delta === 0) {
        return { applied: false, replayed: false, balance: getChannelPoints(userId, streamerId) };
    }
    return getDb().transaction(() => {
        const seen = get('SELECT user_id, streamer_id, delta FROM channel_points_log WHERE idempotency_key = ?', [key]);
        if (seen) {
            if (seen.user_id !== userId || seen.streamer_id !== streamerId || seen.delta !== delta) {
                throw new Error(`channel points: idempotency key ${key} was already used for a different event`);
            }
            return { applied: false, replayed: true, balance: getChannelPoints(userId, streamerId) };
        }
        if (delta < 0) {
            const res = run(`UPDATE channel_points SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP
                             WHERE user_id = ? AND streamer_id = ? AND balance >= ?`, [delta, userId, streamerId, -delta]);
            if (!res.changes) return { applied: false, replayed: false, balance: getChannelPoints(userId, streamerId) };
        } else {
            run(`INSERT INTO channel_points (user_id, streamer_id, balance, updated_at)
                 VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(user_id, streamer_id) DO UPDATE SET
                    balance = balance + excluded.balance, updated_at = CURRENT_TIMESTAMP`, [userId, streamerId, delta]);
        }
        run('INSERT INTO channel_points_log (idempotency_key, user_id, streamer_id, delta, reason) VALUES (?, ?, ?, ?, ?)',
            [key, userId, streamerId, delta, reason ? String(reason).slice(0, 200) : null]);
        return { applied: true, replayed: false, balance: getChannelPoints(userId, streamerId) };
    })();
}
/** Credit channel points for one event (key required). Returns the new balance. */
function addChannelPoints(userId, streamerId, amount, key, reason) {
    return applyChannelPoints({ userId, streamerId, delta: amount, key, reason }).balance;
}
/** Atomic spend for one event (key required): true if taken now or already taken under this key. */
function deductChannelPoints(userId, streamerId, amount, key, reason) {
    if (!userId || !streamerId) return false;
    const r = applyChannelPoints({ userId, streamerId, delta: -amount, key, reason });
    return r.applied || r.replayed;
}

// ── Kick chatroom-id cache (survives the Cloudflare-blocked v2 API) ──
function getKickChannelCache(slug) {
    if (!slug) return null;
    return get('SELECT * FROM kick_channel_cache WHERE slug = ?', [String(slug).toLowerCase()]);
}
function setKickChannelCache(slug, chatroomId, kickChannelId) {
    if (!slug || !chatroomId) return;
    run(`INSERT INTO kick_channel_cache (slug, chatroom_id, kick_channel_id, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(slug) DO UPDATE SET
            chatroom_id = excluded.chatroom_id,
            kick_channel_id = COALESCE(excluded.kick_channel_id, kick_channel_cache.kick_channel_id),
            updated_at = CURRENT_TIMESTAMP`,
        [String(slug).toLowerCase(), chatroomId, kickChannelId || null]);
}

function getPlatformConnection(userId, platform) {
    return get('SELECT * FROM platform_connections WHERE user_id = ? AND platform = ?', [userId, platform]);
}

function getPlatformConnectionById(id) {
    return get('SELECT * FROM platform_connections WHERE id = ?', [id]);
}

function getPlatformConnectionsByUserId(userId) {
    return all('SELECT * FROM platform_connections WHERE user_id = ? ORDER BY platform', [userId]);
}

/** Insert-or-update a user's connection for a platform (UNIQUE user_id+platform). */
function upsertPlatformConnection(userId, platform, fields) {
    const existing = getPlatformConnection(userId, platform);
    if (existing) {
        run(`UPDATE platform_connections SET
                platform_user_id = ?, platform_username = ?, channel_url = ?,
                access_token = ?, refresh_token = COALESCE(?, refresh_token),
                token_expires_at = ?, scope = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [fields.platform_user_id || null, fields.platform_username || null, fields.channel_url || null,
             fields.access_token || null, fields.refresh_token || null,
             fields.token_expires_at || null, fields.scope || null, existing.id]);
        return getPlatformConnectionById(existing.id);
    }
    const res = run(`INSERT INTO platform_connections
            (user_id, platform, platform_user_id, platform_username, channel_url, access_token, refresh_token, token_expires_at, scope)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, platform, fields.platform_user_id || null, fields.platform_username || null, fields.channel_url || null,
         fields.access_token || null, fields.refresh_token || null, fields.token_expires_at || null, fields.scope || null]);
    return getPlatformConnectionById(res.lastInsertRowid);
}

/** Persist refreshed tokens for a connection. */
function updatePlatformConnectionTokens(id, { access_token, refresh_token, token_expires_at, scope }) {
    run(`UPDATE platform_connections SET
            access_token = ?, refresh_token = COALESCE(?, refresh_token),
            token_expires_at = ?, scope = COALESCE(?, scope), updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [access_token || null, refresh_token || null, token_expires_at || null, scope || null, id]);
    return getPlatformConnectionById(id);
}

function deletePlatformConnection(userId, platform) {
    return run('DELETE FROM platform_connections WHERE user_id = ? AND platform = ?', [userId, platform]);
}

// ── PowerChat connections (per-streamer OAuth grant) ─────────
function getPowerchatConnection(userId) {
    return get('SELECT * FROM powerchat_connections WHERE user_id = ?', [userId]) || null;
}
function getPowerchatConnectionByUsername(username) {
    if (!username) return null;
    return get('SELECT * FROM powerchat_connections WHERE LOWER(powerchat_username) = LOWER(?)', [String(username)]) || null;
}
function getPowerchatConnectionByPcUserId(pcUserId) {
    if (!pcUserId) return null;
    return get('SELECT * FROM powerchat_connections WHERE powerchat_user_id = ?', [String(pcUserId)]) || null;
}
function upsertPowerchatConnection(userId, fields = {}) {
    const cols = ['powerchat_username', 'powerchat_user_id', 'access_token', 'refresh_token', 'token_expires_at', 'scope', 'tip_page_url', 'last_error'];
    const set = {};
    for (const c of cols) if (fields[c] !== undefined) set[c] = fields[c];
    const existing = getPowerchatConnection(userId);
    if (existing) {
        const keys = Object.keys(set);
        if (!keys.length) return existing;
        run(`UPDATE powerchat_connections SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
            [...keys.map(k => set[k]), userId]);
    } else {
        const keys = Object.keys(set);
        run(`INSERT INTO powerchat_connections (user_id${keys.length ? ', ' + keys.join(', ') : ''}) VALUES (?${keys.map(() => ', ?').join('')})`,
            [userId, ...keys.map(k => set[k])]);
    }
    return getPowerchatConnection(userId);
}
// Atomically persist a rotated token pair. Reuse of an old refresh token revokes the
// whole family, so we always overwrite with the newest pair in one statement.
function updatePowerchatTokens(userId, { access_token, refresh_token, token_expires_at, scope }) {
    return run(
        `UPDATE powerchat_connections
         SET access_token = ?, refresh_token = COALESCE(?, refresh_token),
             token_expires_at = ?, scope = COALESCE(?, scope), last_error = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ?`,
        [access_token, refresh_token || null, token_expires_at || null, scope || null, userId]
    );
}
function setPowerchatConnectionError(userId, err) {
    return run('UPDATE powerchat_connections SET last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
        [err ? String(err).slice(0, 300) : null, userId]);
}
function deletePowerchatConnection(userId) {
    return run('DELETE FROM powerchat_connections WHERE user_id = ?', [userId]);
}
// Webhook dedupe: returns true the FIRST time a delivery id is seen, false on repeats.
function powerchatDeliveryIsNew(deliveryId, eventType) {
    if (!deliveryId) return true; // no id → can't dedupe; process (rare)
    const r = run('INSERT OR IGNORE INTO powerchat_webhook_deliveries (delivery_id, event_type) VALUES (?, ?)', [String(deliveryId), eventType || null]);
    return r.changes > 0;
}
function cleanupPowerchatDeliveries(days = 3) {
    try { return run(`DELETE FROM powerchat_webhook_deliveries WHERE received_at < datetime('now', ?)`, [`-${Math.max(1, days)} days`]); }
    catch { return null; }
}

// ── Daily easter egg solves ──────────────────────────────────
function recordEasterEggSolve(eggDate, solverKey, userId) {
    try {
        const res = run('INSERT OR IGNORE INTO easter_egg_solves (egg_date, solver_key, user_id) VALUES (?, ?, ?)',
            [eggDate, String(solverKey).slice(0, 80), userId || null]);
        return !!(res && res.changes); // true = newly solved (first time today)
    } catch { return false; }
}
function hasSolvedEasterEgg(eggDate, solverKey) {
    try { return !!get('SELECT 1 FROM easter_egg_solves WHERE egg_date = ? AND solver_key = ?', [eggDate, String(solverKey).slice(0, 80)]); } catch { return false; }
}
function countEasterEggSolves(eggDate) {
    try { return get('SELECT COUNT(*) AS n FROM easter_egg_solves WHERE egg_date = ?', [eggDate])?.n || 0; } catch { return 0; }
}

function getUserProfile(userId) {
    const user = get(`SELECT id, username, display_name, avatar_url, profile_color, role,
                      openvibe_bucks_balance, openvibe_coins_balance, created_at, last_seen
                      FROM users WHERE id = ?`, [userId]);
    if (!user) return null;
    // The user's chat total is OpenVibe.Chat's; a synchronous peek answers the last good count, else
    // null while Chat refreshes in the background. The profile card omits the count when it is null.
    user.messageCount = (() => { try { return require('../chat/chat-reads').userMessageCountPeek(userId); } catch { return null; } })();
    user.followerCount = get('SELECT COUNT(*) as c FROM follows WHERE streamer_id = ?', [userId])?.c || 0;
    user.followingCount = get('SELECT COUNT(*) as c FROM follows WHERE follower_id = ?', [userId])?.c || 0;
    return user;
}

function updateUserAvatar(userId, avatarUrl, pasteId = null) {
    return run('UPDATE users SET avatar_url = ?, avatar_paste_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [avatarUrl, pasteId, userId]);
}

// resetAvatarsForPaste() removed — the media subsystem (vods/clips/pastes writes) moved to OpenVibe.Media.

// ── Follow helpers ───────────────────────────────────────────
// Reads of the projection of Network's follow graph; only server/social/network-follows.js writes it.

function getFollowerCount(streamerId) {
    const row = get('SELECT COUNT(*) as count FROM follows WHERE streamer_id = ?', [streamerId]);
    return row ? row.count : 0;
}

function isFollowing(followerId, streamerId) {
    const row = get('SELECT id FROM follows WHERE follower_id = ? AND streamer_id = ?',
        [followerId, streamerId]);
    return !!row;
}

function getFollowerIds(streamerId) {
    return all('SELECT follower_id FROM follows WHERE streamer_id = ?', [streamerId])
        .map(r => r.follower_id);
}

// ── Transaction helpers ──────────────────────────────────────

function createTransaction({ from_user_id, to_user_id, stream_id, amount, type, status, message }) {
    assertLiveLedger('transactions insert');
    return run(
        `INSERT INTO transactions (from_user_id, to_user_id, stream_id, amount, type, status, message)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [from_user_id || null, to_user_id || null, stream_id || null, amount, type, status || 'completed', message || null]
    );
}

function addVibes(userId, amount) {
    assertLiveLedger('openvibe_bucks_balance credit');
    return run(`UPDATE users SET openvibe_bucks_balance = openvibe_bucks_balance + ? WHERE id = ?`,
        [amount, userId]);
}

function deductVibes(userId, amount) {
    assertLiveLedger('openvibe_bucks_balance debit');
    const user = getUserById(userId);
    if (!user || user.openvibe_bucks_balance < amount) return false;
    run(`UPDATE users SET openvibe_bucks_balance = openvibe_bucks_balance - ? WHERE id = ?`,
        [amount, userId]);
    return true;
}

// Streamer cashout balance (received donations; the only cashout-able balance).
function addVibesCashout(userId, amount) {
    assertLiveLedger('openvibe_bucks_cashout_balance credit');
    return run(`UPDATE users SET openvibe_bucks_cashout_balance = openvibe_bucks_cashout_balance + ? WHERE id = ?`,
        [amount, userId]);
}
function deductVibesCashout(userId, amount) {
    assertLiveLedger('openvibe_bucks_cashout_balance debit');
    const user = getUserById(userId);
    if (!user || (user.openvibe_bucks_cashout_balance || 0) < amount) return false;
    run(`UPDATE users SET openvibe_bucks_cashout_balance = openvibe_bucks_cashout_balance - ? WHERE id = ?`,
        [amount, userId]);
    return true;
}

// ── Payment orders (idempotent purchase tracking) ────────────

function createPaymentOrder({ user_id, provider, provider_ref = null, kind = 'bucks', amount_cents = 0, currency = 'usd', bucks = 0, streamer_id = null, status = 'pending' }) {
    assertLiveLedger('payment_orders insert');
    const res = run(
        `INSERT INTO payment_orders (user_id, provider, provider_ref, kind, amount_cents, currency, bucks, streamer_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [user_id, provider, provider_ref, kind, amount_cents, currency, bucks, streamer_id, status]
    );
    return get('SELECT * FROM payment_orders WHERE id = ?', [res.lastInsertRowid]);
}

function getPaymentOrderById(id) {
    return get('SELECT * FROM payment_orders WHERE id = ?', [id]);
}

function getPaymentOrderByRef(provider, ref) {
    if (!ref) return null;
    return get('SELECT * FROM payment_orders WHERE provider = ? AND provider_ref = ? ORDER BY id DESC LIMIT 1', [provider, ref]);
}

// PowerChat checkouts still waiting for their donation.completed webhook — the
// reconciliation sweep's work list (recent only: an intent lives an hour, and an
// order nobody paid within days is an abandoned cart, not a missed webhook).
function getPendingPowerchatOrders(days = 3) {
    return all(`SELECT * FROM payment_orders
                WHERE provider = 'powerchat' AND status = 'pending'
                  AND created_at >= datetime('now', ?)
                ORDER BY id ASC`, [`-${Math.max(1, Math.round(days))} days`]);
}

function updatePaymentOrder(id, fields) {
    assertLiveLedger('payment_orders update');
    const allowed = new Set(['provider_ref', 'status', 'amount_cents', 'bucks', 'currency', 'streamer_id']);
    const entries = Object.entries(fields || {}).filter(([k]) => allowed.has(k));
    if (!entries.length) return getPaymentOrderById(id);
    const sets = entries.map(([k]) => `${k} = ?`);
    sets.push('updated_at = CURRENT_TIMESTAMP');
    run(`UPDATE payment_orders SET ${sets.join(', ')} WHERE id = ?`, [...entries.map(([, v]) => v), id]);
    return getPaymentOrderById(id);
}

// ── Subscription helpers ─────────────────────────────────────

function upsertSubscription({ subscriber_id, streamer_id, tier = 1, provider = null, provider_ref = null, price_cents = 0, currency = 'usd', status = 'active', current_period_end = null, auto_renew = null }) {
    assertLiveLedger('subscriptions upsert');
    // Reuse an existing (subscriber,streamer) row if present, else insert.
    // auto_renew: null = leave as-is on update (0 on insert); 0/1 = set explicitly.
    const existing = get('SELECT * FROM subscriptions WHERE subscriber_id = ? AND streamer_id = ?', [subscriber_id, streamer_id]);
    if (existing) {
        run(`UPDATE subscriptions SET tier=?, provider=?, provider_ref=COALESCE(?, provider_ref), price_cents=?, currency=?,
                status=?, is_active=?, current_period_end=?, auto_renew=COALESCE(?, auto_renew),
                cancel_at_period_end=0, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
            [tier, provider, provider_ref, price_cents, currency, status, status === 'active' ? 1 : 0, current_period_end,
                auto_renew === null ? null : (auto_renew ? 1 : 0), existing.id]);
        return get('SELECT * FROM subscriptions WHERE id = ?', [existing.id]);
    }
    const res = run(`INSERT INTO subscriptions (subscriber_id, streamer_id, tier, provider, provider_ref, price_cents, currency, status, is_active, current_period_end, auto_renew)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [subscriber_id, streamer_id, tier, provider, provider_ref, price_cents, currency, status, status === 'active' ? 1 : 0, current_period_end, auto_renew ? 1 : 0]);
    return get('SELECT * FROM subscriptions WHERE id = ?', [res.lastInsertRowid]);
}

// Active subs whose paid period has lapsed — the renewal sweeper's work list.
function getSubscriptionsDueRenewal(limit = 50) {
    return all(`SELECT * FROM subscriptions
        WHERE status = 'active' AND current_period_end IS NOT NULL
          AND datetime(current_period_end) <= CURRENT_TIMESTAMP
        ORDER BY datetime(current_period_end) ASC LIMIT ?`, [limit]);
}

function getSubscriptionByProviderRef(provider, ref) {
    if (!ref) return null;
    return get('SELECT * FROM subscriptions WHERE provider = ? AND provider_ref = ? ORDER BY id DESC LIMIT 1', [provider, ref]);
}

function getActiveSubscription(subscriberId, streamerId) {
    return get(`SELECT * FROM subscriptions WHERE subscriber_id = ? AND streamer_id = ? AND status = 'active'
                AND (current_period_end IS NULL OR datetime(current_period_end) > CURRENT_TIMESTAMP) LIMIT 1`,
        [subscriberId, streamerId]);
}

function isActiveSubscriber(subscriberId, streamerId) {
    if (!subscriberId || !streamerId) return false;
    // BILLING_AUTHORITY=billing: subscriber perks follow Billing's entitlements (short-lived cache;
    // legacy subscriptions rows are not consulted).
    if (process.env.BILLING_AUTHORITY && require('../monetization/money-authority').onBilling()) {
        return require('../monetization/billing-actions').isSubscriberCached(subscriberId, streamerId);
    }
    return !!getActiveSubscription(subscriberId, streamerId);
}

function getSubscriptionsByStreamer(streamerId) {
    return all(`SELECT s.*, u.username AS subscriber_username, u.display_name AS subscriber_display, u.avatar_url AS subscriber_avatar
                FROM subscriptions s LEFT JOIN users u ON s.subscriber_id = u.id
                WHERE s.streamer_id = ? AND s.status = 'active' ORDER BY s.started_at DESC`, [streamerId]);
}

function getSubscriptionsBySubscriber(subscriberId) {
    return all(`SELECT s.*, u.username AS streamer_username, u.display_name AS streamer_display, u.avatar_url AS streamer_avatar
                FROM subscriptions s LEFT JOIN users u ON s.streamer_id = u.id
                WHERE s.subscriber_id = ? ORDER BY s.started_at DESC`, [subscriberId]);
}

function getActiveSubscriberCount(streamerId) {
    const r = get(`SELECT COUNT(*) AS n FROM subscriptions WHERE streamer_id = ? AND status = 'active'
                   AND (current_period_end IS NULL OR datetime(current_period_end) > CURRENT_TIMESTAMP)`, [streamerId]);
    return r ? r.n : 0;
}

function setSubscriptionStatus(id, status, fields = {}) {
    assertLiveLedger('subscriptions status');
    const cpe = fields.current_period_end !== undefined ? fields.current_period_end : null;
    const cape = fields.cancel_at_period_end !== undefined ? (fields.cancel_at_period_end ? 1 : 0) : 0;
    run(`UPDATE subscriptions SET status=?, is_active=?, cancel_at_period_end=?,
            current_period_end=COALESCE(?, current_period_end), updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        [status, status === 'active' ? 1 : 0, cape, cpe, id]);
    return get('SELECT * FROM subscriptions WHERE id = ?', [id]);
}
// ── VODs and clips ───────────────────────────────────────────
// They live in OpenVibe.Media. Live asks for them through server/media-client.js and
// server/media-proxy/lookups.js; Live's own AI state for them is vod_ai_state / clip_ai_state.
// The legacy local vods/clips tables are frozen and unread: test/frozen-tables.test.js fails on
// a new write or read (register C-73; the drop procedure is in docs/vods-and-clips.md).

// ── Control helpers ──────────────────────────────────────────

function getStreamControls(streamId) {
    return all('SELECT * FROM stream_controls WHERE stream_id = ? ORDER BY sort_order', [streamId]);
}

function createControl({ stream_id, label, command, icon, control_type, key_binding, cooldown_ms, sort_order, btn_color, btn_bg, btn_border_color }) {
    return run(
        `INSERT INTO stream_controls (stream_id, label, command, icon, control_type, key_binding, cooldown_ms, sort_order, btn_color, btn_bg, btn_border_color)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [stream_id, label, command, icon || 'fa-gamepad', control_type || 'button', key_binding || null, cooldown_ms || 100, sort_order || 0, btn_color || '', btn_bg || '', btn_border_color || '']
    );
}

// ── Control Config helpers ──────────────────────────────────

function getControlConfigs(userId) {
    return all('SELECT * FROM control_configs WHERE user_id = ? ORDER BY created_at DESC', [userId]);
}

function getControlConfig(configId) {
    return get('SELECT * FROM control_configs WHERE id = ?', [configId]);
}

function createControlConfig({ user_id, name, description }) {
    return run(
        'INSERT INTO control_configs (user_id, name, description) VALUES (?, ?, ?)',
        [user_id, name, description || '']
    );
}

function updateControlConfig(configId, fields) {
    const updates = [];
    const params = [];
    for (const [key, val] of Object.entries(fields)) {
        if (val !== undefined && ['name', 'description'].includes(key)) {
            updates.push(`${key} = ?`);
            params.push(val);
        }
    }
    if (updates.length === 0) return;
    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(configId);
    return run(`UPDATE control_configs SET ${updates.join(', ')} WHERE id = ?`, params);
}

function deleteControlConfig(configId) {
    return run('DELETE FROM control_configs WHERE id = ?', [configId]);
}

function getConfigButtons(configId) {
    return all('SELECT * FROM control_config_buttons WHERE config_id = ? ORDER BY sort_order', [configId]);
}

function createConfigButton({ config_id, label, command, icon, control_type, key_binding, cooldown_ms, sort_order, btn_color, btn_bg, btn_border_color }) {
    return run(
        `INSERT INTO control_config_buttons (config_id, label, command, icon, control_type, key_binding, cooldown_ms, sort_order, btn_color, btn_bg, btn_border_color)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [config_id, label, command, icon || 'fa-gamepad', control_type || 'button', key_binding || null, cooldown_ms || 100, sort_order || 0, btn_color || '', btn_bg || '', btn_border_color || '']
    );
}

function updateConfigButton(buttonId, fields, configId) {
    const allowed = ['label', 'command', 'icon', 'control_type', 'key_binding', 'cooldown_ms', 'sort_order', 'btn_color', 'btn_bg', 'btn_border_color', 'is_enabled'];
    const updates = [];
    const params = [];
    for (const [key, val] of Object.entries(fields)) {
        if (val !== undefined && allowed.includes(key)) {
            updates.push(`${key} = ?`);
            params.push(val);
        }
    }
    if (updates.length === 0) return;
    params.push(buttonId);
    // Callers that authorised a config pass its id, so a button id from another config matches nothing.
    if (configId != null) { params.push(configId); return run(`UPDATE control_config_buttons SET ${updates.join(', ')} WHERE id = ? AND config_id = ?`, params); }
    return run(`UPDATE control_config_buttons SET ${updates.join(', ')} WHERE id = ?`, params);
}

function deleteConfigButton(buttonId, configId) {
    if (configId != null) return run('DELETE FROM control_config_buttons WHERE id = ? AND config_id = ?', [buttonId, configId]);
    return run('DELETE FROM control_config_buttons WHERE id = ?', [buttonId]);
}

function bindStreamToControlConfig(streamId, controlConfigId) {
    if (controlConfigId === null) {
        return run('UPDATE streams SET control_config_id = NULL WHERE id = ?', [streamId]);
    }
    return run('UPDATE streams SET control_config_id = ? WHERE id = ?', [controlConfigId, streamId]);
}

function applyConfigToStream(configId, streamId) {
    // Delete existing non-ONVIF controls from stream
    run('DELETE FROM stream_controls WHERE stream_id = ? AND (control_type != ? OR control_type IS NULL)', [streamId, 'onvif']);
    // Copy buttons from config into stream_controls
    const buttons = getConfigButtons(configId);
    for (let i = 0; i < buttons.length; i++) {
        const b = buttons[i];
        if (!b.is_enabled) continue;
        createControl({
            stream_id: streamId,
            label: b.label,
            command: b.command,
            icon: b.icon,
            control_type: b.control_type,
            key_binding: b.key_binding,
            cooldown_ms: b.cooldown_ms,
            sort_order: b.sort_order || i,
            btn_color: b.btn_color,
            btn_bg: b.btn_bg,
            btn_border_color: b.btn_border_color,
        });
    }
    bindStreamToControlConfig(streamId, configId);
    return buttons.filter(b => b.is_enabled).length;
}

// ── API Key helpers ──────────────────────────────────────────

function createApiKey({ user_id, key_hash, label, permissions }) {
    return run(
        `INSERT INTO api_keys (user_id, key_hash, label, permissions)
         VALUES (?, ?, ?, ?)`,
        [user_id, key_hash, label || 'Default', JSON.stringify(permissions || ['control', 'stream'])]
    );
}

function getApiKeyByHash(hash) {
    return get('SELECT * FROM api_keys WHERE key_hash = ? AND is_active = 1', [hash]);
}

// ── ONVIF Camera helpers ─────────────────────────────────────

function createCameraProfile({ user_id, stream_id, name, onvif_url, username, password_hash, pan_speed, tilt_speed, zoom_speed }) {
    return run(
        `INSERT INTO camera_profiles (user_id, stream_id, name, onvif_url, username, password_hash, pan_speed, tilt_speed, zoom_speed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [user_id, stream_id || null, name, onvif_url, username, password_hash, pan_speed || 0.5, tilt_speed || 0.5, zoom_speed || 0.5]
    );
}

function getCameraProfile(cameraId) {
    return get('SELECT * FROM camera_profiles WHERE id = ?', [cameraId]);
}

function getCameraProfilesByUser(userId) {
    return all('SELECT * FROM camera_profiles WHERE user_id = ? ORDER BY created_at DESC', [userId]);
}

function getCameraProfilesByStream(streamId) {
    return all('SELECT * FROM camera_profiles WHERE stream_id = ? AND is_active = 1 ORDER BY name', [streamId]);
}

function updateCameraProfile(cameraId, data) {
    const { name, onvif_url, username, password_hash, pan_speed, tilt_speed, zoom_speed, is_active, last_connected } = data;
    return run(
        `UPDATE camera_profiles SET name = ?, onvif_url = ?, username = ?, password_hash = ?, 
         pan_speed = ?, tilt_speed = ?, zoom_speed = ?, is_active = ?, last_connected = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [name, onvif_url, username, password_hash, pan_speed, tilt_speed, zoom_speed, is_active, last_connected, cameraId]
    );
}

function deleteCameraProfile(cameraId) {
    // Cascade delete presets and associated controls
    run('DELETE FROM camera_presets WHERE camera_id = ?', [cameraId]);
    run('UPDATE stream_controls SET camera_id = NULL WHERE camera_id = ?', [cameraId]);
    return run('DELETE FROM camera_profiles WHERE id = ?', [cameraId]);
}

function createCameraPreset({ camera_id, name, pan, tilt, zoom, preset_token }) {
    return run(
        `INSERT INTO camera_presets (camera_id, name, pan, tilt, zoom, preset_token)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [camera_id, name, pan, tilt, zoom, preset_token || null]
    );
}

function getCameraPreset(presetId) {
    return get('SELECT * FROM camera_presets WHERE id = ?', [presetId]);
}

function getCameraPresetsByCamera(cameraId) {
    return all('SELECT * FROM camera_presets WHERE camera_id = ? ORDER BY name', [cameraId]);
}

function deleteCameraPreset(presetId) {
    return run('DELETE FROM camera_presets WHERE id = ?', [presetId]);
}

// ── Ban helpers ──────────────────────────────────────────────

function isUserBanned(userId, streamId) {
    const ban = get(`
        SELECT * FROM bans
        WHERE user_id = ?
        AND (stream_id = ? OR stream_id IS NULL)
        AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)
        LIMIT 1
    `, [userId, streamId]);
    return !!ban;
}

/**
 * IP bans: a `bans.ip_address` value is either one address (exact match) or a CIDR block
 * (`2601:601:9181:bb00::/64`, `203.0.113.0/24`) — a whole home network / carrier prefix.
 * CIDR rows are compiled into net.BlockList and cached briefly; exact rows stay a lookup.
 */
const _net = require('net');
let _cidrBans = { at: 0, list: [] };
function _normalizeBanIp(ip) {
    let s = String(ip || '').trim();
    if (s.startsWith('::ffff:') && _net.isIP(s.slice(7)) === 4) s = s.slice(7);
    return s;
}
function _cidrBanList() {
    if (_cidrBans.list && Date.now() - _cidrBans.at < 15000) return _cidrBans.list;
    const rows = all(`SELECT * FROM bans WHERE ip_address LIKE '%/%' AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)`);
    const list = [];
    for (const r of rows) {
        const [addr, bitsStr] = String(r.ip_address).split('/');
        const fam = _net.isIP(addr), bits = parseInt(bitsStr, 10);
        if (!fam || !Number.isFinite(bits)) continue;
        const bl = new _net.BlockList();
        try { bl.addSubnet(addr, bits, fam === 6 ? 'ipv6' : 'ipv4'); } catch { continue; }
        list.push({ bl, fam, row: r });
    }
    _cidrBans = { at: Date.now(), list };
    return list;
}
function invalidateIpBanCache() { _cidrBans = { at: 0, list: [] }; }

/** The active site-wide (or this stream's) ban row for an IP, or null. */
function getIpBan(ip, streamId) {
    const norm = _normalizeBanIp(ip);
    if (!norm) return null;
    const ban = get(`
        SELECT * FROM bans
        WHERE ip_address IN (?, ?)
        AND (stream_id = ? OR stream_id IS NULL)
        AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)
        LIMIT 1
    `, [String(ip), norm, streamId]);
    if (ban) return ban;
    const fam = _net.isIP(norm);
    if (!fam) return null;
    for (const e of _cidrBanList()) {
        if (e.fam !== fam) continue;
        if (e.row.stream_id !== null && e.row.stream_id !== undefined && e.row.stream_id !== streamId) continue;
        if (e.bl.check(norm, fam === 6 ? 'ipv6' : 'ipv4')) return e.row;
    }
    return null;
}

function isIpBanned(ip, streamId) {
    return !!getIpBan(ip, streamId);
}

/**
 * Lift everything that bans a user: the account flag and every bans row in their name
 * (account rows and any IP / network rows attached to them). Returns the removed rows.
 */
function forgiveBan(userId) {
    // Site-level bans only. Bans a streamer placed on their own stream are theirs to lift, not the
    // site ban page's.
    const rows = all('SELECT id, ip_address, stream_id, reason FROM bans WHERE user_id = ? AND stream_id IS NULL', [userId]);
    run('UPDATE users SET is_banned = 0, ban_reason = NULL WHERE id = ?', [userId]);
    run('DELETE FROM bans WHERE user_id = ? AND stream_id IS NULL', [userId]);
    invalidateIpBanCache();
    return rows;
}

// ── Cleanup ──────────────────────────────────────────────────

async function close() {
    if (db) {
        // Cached statements belong to this handle — they must not outlive it.
        clearStatementCache();
        const d = db;
        db = null;
        if (d !== globalThis.__ovLiveTestDb) await d.close();
    }
}

// ── Site Settings helpers ────────────────────────────────────

function getSetting(key) {
    const row = get('SELECT * FROM site_settings WHERE key = ?', [key]);
    if (!row) return null;
    switch (row.type) {
        case 'number': return Number(row.value);
        case 'boolean': return row.value === 'true';
        case 'json': try { return JSON.parse(row.value); } catch { return row.value; }
        default: return row.value;
    }
}

function getSettingRow(key) {
    return get('SELECT * FROM site_settings WHERE key = ?', [key]);
}

function getAllSettings() {
    return all('SELECT * FROM site_settings ORDER BY key');
}

function setSetting(key, value) {
    const strVal = typeof value === 'object' ? JSON.stringify(value) : String(value);
    const existing = get('SELECT key FROM site_settings WHERE key = ?', [key]);
    if (existing) {
        return run('UPDATE site_settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?', [strVal, key]);
    }
    return run('INSERT INTO site_settings (key, value) VALUES (?, ?)', [key, strVal]);
}

function deleteSetting(key) {
    return run('DELETE FROM site_settings WHERE key = ?', [key]);
}

// ── Internal job/cache state (app_state) ─────────────────────
// Same KV shape as site_settings but for machine state (JSON blobs the AI jobs
// persist across restarts). Never listed in the admin panel — admin-editable
// config belongs in site_settings, job state belongs here.
function getState(key) {
    const row = get('SELECT value FROM app_state WHERE key = ?', [key]);
    return row ? row.value : null;
}
function setState(key, value) {
    const strVal = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return run(`INSERT INTO app_state (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`, [key, strVal]);
}
function deleteState(key) {
    return run('DELETE FROM app_state WHERE key = ?', [key]);
}

// ── Verification Key helpers ─────────────────────────────────

function createVerificationKey({ key, target_username, note, created_by }) {
    return run(
        `INSERT INTO verification_keys (key, target_username, note, created_by) VALUES (?, ?, ?, ?)`,
        [key, target_username, note || '', created_by]
    );
}

function getVerificationKeyByKey(key) {
    return get('SELECT * FROM verification_keys WHERE key = ?', [key]);
}

function getVerificationKeyByUsername(username) {
    return get("SELECT * FROM verification_keys WHERE target_username = ? COLLATE NOCASE AND status = 'active'", [username]);
}

function getAllVerificationKeys() {
    return all(`
        SELECT vk.*, u1.username as created_by_name, u2.username as used_by_name
        FROM verification_keys vk
        LEFT JOIN users u1 ON vk.created_by = u1.id
        LEFT JOIN users u2 ON vk.used_by = u2.id
        ORDER BY vk.created_at DESC
    `);
}

function redeemVerificationKey(key, userId) {
    return run(
        "UPDATE verification_keys SET status = 'used', used_by = ?, used_at = CURRENT_TIMESTAMP WHERE key = ? AND status = 'active'",
        [userId, key]
    );
}

function revokeVerificationKey(id) {
    return run("UPDATE verification_keys SET status = 'revoked' WHERE id = ? AND status = 'active'", [id]);
}

function isUsernameReserved(username) {
    const vk = get("SELECT id FROM verification_keys WHERE target_username = ? COLLATE NOCASE AND status = 'active'", [username]);
    return !!vk;
}

// ── AI chatbot config (per streamer) ─────────────────────────
const AI_CHATBOT_DEFAULTS = {
    enabled: 0,
    base_url: 'https://api.openai.com/v1',
    api_token: '',
    model: 'gpt-4o-mini',
    transcribe_enabled: 0,
    transcribe_model: 'whisper-1',
    num_bots: 3,
    post_interval_seconds: 45,
    persona: '',
    vision_enabled: 0,
};

function getAiChatbotConfig(userId) {
    const row = get('SELECT * FROM ai_chatbot_configs WHERE user_id = ?', [userId]);
    return row || { user_id: userId, ...AI_CHATBOT_DEFAULTS, last_validated_at: null };
}

function upsertAiChatbotConfig(userId, fields) {
    const allowed = {
        enabled: (v) => (v ? 1 : 0),
        base_url: (v) => String(v || '').trim().slice(0, 500) || 'https://api.openai.com/v1',
        api_token: (v) => String(v || '').trim().slice(0, 400),
        model: (v) => String(v || '').trim().slice(0, 120) || 'gpt-4o-mini',
        transcribe_enabled: (v) => (v ? 1 : 0),
        transcribe_model: (v) => String(v || '').trim().slice(0, 120) || 'whisper-1',
        num_bots: (v) => Math.min(12, Math.max(1, parseInt(v, 10) || 3)),
        post_interval_seconds: (v) => Math.min(600, Math.max(10, parseInt(v, 10) || 45)),
        persona: (v) => String(v || '').slice(0, 4000),
        vision_enabled: (v) => (v ? 1 : 0),
        last_validated_at: (v) => v,
    };
    const existing = get('SELECT 1 FROM ai_chatbot_configs WHERE user_id = ?', [userId]);
    if (existing) {
        const sets = [];
        const params = [];
        for (const [col, coerce] of Object.entries(allowed)) {
            if (fields[col] !== undefined) { sets.push(`${col} = ?`); params.push(coerce(fields[col])); }
        }
        if (sets.length) {
            sets.push('updated_at = CURRENT_TIMESTAMP');
            params.push(userId);
            run(`UPDATE ai_chatbot_configs SET ${sets.join(', ')} WHERE user_id = ?`, params);
        }
    } else {
        const merged = { ...AI_CHATBOT_DEFAULTS };
        for (const [col, coerce] of Object.entries(allowed)) {
            if (fields[col] !== undefined) merged[col] = coerce(fields[col]);
        }
        run(
            `INSERT INTO ai_chatbot_configs
                (user_id, enabled, base_url, api_token, model, transcribe_enabled, transcribe_model, num_bots, post_interval_seconds, persona, vision_enabled)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, merged.enabled ? 1 : 0, merged.base_url, merged.api_token, merged.model,
             merged.transcribe_enabled ? 1 : 0, merged.transcribe_model, merged.num_bots,
             merged.post_interval_seconds, merged.persona, merged.vision_enabled ? 1 : 0]
        );
    }
    return getAiChatbotConfig(userId);
}

// ── AI Chat Viewers 2.0: config + roster ─────────────────────
const CHANNEL_AI_CONFIG_DEFAULTS = {
    enabled: 0, num_ambient_bots: 3, pacing_seconds: 45, persona: '',
    transcribe_enabled: 0, vision_enabled: 0, use_shared_key: 1,
    daily_budget_cents: 20, byo_key: '', byo_base_url: '', byo_model: 'gpt-4o-mini',
    settings_json: '{}',
};

function getChannelAiConfig(userId) {
    const row = get('SELECT * FROM channel_ai_config WHERE user_id = ?', [userId]);
    return row || { user_id: userId, ...CHANNEL_AI_CONFIG_DEFAULTS };
}

function upsertChannelAiConfig(userId, fields) {
    const allowed = {
        enabled: (v) => (v ? 1 : 0),
        num_ambient_bots: (v) => Math.min(12, Math.max(0, parseInt(v, 10) || 0)),
        pacing_seconds: (v) => Math.min(600, Math.max(10, parseInt(v, 10) || 45)),
        persona: (v) => String(v || '').slice(0, 4000),
        transcribe_enabled: (v) => (v ? 1 : 0),
        vision_enabled: (v) => (v ? 1 : 0),
        use_shared_key: (v) => (v ? 1 : 0),
        daily_budget_cents: (v) => Math.min(100000, Math.max(0, parseInt(v, 10) || 0)),
        byo_key: (v) => String(v || '').trim().slice(0, 400),
        byo_base_url: (v) => String(v || '').trim().slice(0, 500),
        byo_model: (v) => String(v || '').trim().slice(0, 120) || 'gpt-4o-mini',
        byo_in_ai: (v) => (v ? 1 : 0),
        // Validated/clamped by ai/viewers/settings.js before it gets here; just bound the size.
        settings_json: (v) => { const t = typeof v === 'string' ? v : JSON.stringify(v || {}); return t.length > 40000 ? '{}' : t; },
    };
    const existing = get('SELECT 1 FROM channel_ai_config WHERE user_id = ?', [userId]);
    if (existing) {
        const sets = [];
        const params = [];
        for (const [col, coerce] of Object.entries(allowed)) {
            if (fields[col] !== undefined) { sets.push(`${col} = ?`); params.push(coerce(fields[col])); }
        }
        if (sets.length) {
            sets.push('updated_at = CURRENT_TIMESTAMP');
            params.push(userId);
            run(`UPDATE channel_ai_config SET ${sets.join(', ')} WHERE user_id = ?`, params);
        }
    } else {
        const merged = { ...CHANNEL_AI_CONFIG_DEFAULTS };
        for (const [col, coerce] of Object.entries(allowed)) {
            if (fields[col] !== undefined) merged[col] = coerce(fields[col]);
        }
        run(
            `INSERT INTO channel_ai_config
                (user_id, enabled, num_ambient_bots, pacing_seconds, persona, transcribe_enabled, vision_enabled,
                 use_shared_key, daily_budget_cents, byo_key, byo_base_url, byo_model)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, merged.enabled, merged.num_ambient_bots, merged.pacing_seconds, merged.persona,
             merged.transcribe_enabled, merged.vision_enabled, merged.use_shared_key,
             merged.daily_budget_cents, merged.byo_key, merged.byo_base_url, merged.byo_model]
        );
    }
    return getChannelAiConfig(userId);
}

// Persistent per-channel bot roster ("brains").
function createChannelAiBot({ channel_user_id, username, display_name, avatar_color, source = 'ambient',
                             cloned_from_kind = null, cloned_from_ref = null, persona_json = {}, brain_json = {} }) {
    const info = run(
        `INSERT INTO channel_ai_bots
            (channel_user_id, username, display_name, avatar_color, source, cloned_from_kind, cloned_from_ref, persona_json, brain_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [channel_user_id, username, display_name || username, avatar_color || '#8a8aff', source,
         cloned_from_kind, cloned_from_ref,
         typeof persona_json === 'string' ? persona_json : JSON.stringify(persona_json || {}),
         typeof brain_json === 'string' ? brain_json : JSON.stringify(brain_json || {})]
    );
    return getChannelAiBot(info.lastInsertRowid);
}

function getChannelAiBot(id) {
    return get('SELECT * FROM channel_ai_bots WHERE id = ?', [id]);
}

// ── AI viewers v3: threads + activity log ───────────────────
function createAiViewerThread({ channel_user_id, stream_id = null, kind, participants, topic = null, awaiting = null }) {
    const r = run('INSERT INTO ai_viewer_threads (channel_user_id, stream_id, kind, participants_json, topic, awaiting) VALUES (?, ?, ?, ?, ?, ?)',
        [channel_user_id, stream_id, kind, JSON.stringify(participants || []), topic, awaiting]);
    return get('SELECT * FROM ai_viewer_threads WHERE id = ?', [r.lastInsertRowid]);
}
function getOpenAiViewerThreads(channelUserId, limit = 6) {
    return all("SELECT * FROM ai_viewer_threads WHERE channel_user_id = ? AND state = 'open' ORDER BY updated_at DESC LIMIT ?", [channelUserId, limit]);
}
function getRecentClosedAiViewerThreads(channelUserId, limit = 3) {
    return all("SELECT * FROM ai_viewer_threads WHERE channel_user_id = ? AND state = 'closed' AND topic IS NOT NULL ORDER BY updated_at DESC LIMIT ?", [channelUserId, limit]);
}
function touchAiViewerThread(id, { line, by, awaiting = null, topic = undefined }) {
    const sets = ['turns = turns + 1', 'last_line = ?', 'last_line_by = ?', 'last_line_at = CURRENT_TIMESTAMP', 'awaiting = ?', 'updated_at = CURRENT_TIMESTAMP'];
    const params = [String(line || '').slice(0, 300), by || null, awaiting];
    if (topic !== undefined) { sets.push('topic = ?'); params.push(topic); }
    params.push(id);
    return run(`UPDATE ai_viewer_threads SET ${sets.join(', ')} WHERE id = ?`, params);
}
function closeAiViewerThread(id) { return run("UPDATE ai_viewer_threads SET state = 'closed', awaiting = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id]); }
function closeStaleAiViewerThreads(channelUserId, idleSec, maxTurns) {
    return run(`UPDATE ai_viewer_threads SET state = 'closed', awaiting = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE channel_user_id = ? AND state = 'open' AND (updated_at < datetime('now', ?) OR turns >= ?)`, [channelUserId, `-${Math.max(30, idleSec)} seconds`, maxTurns]).changes;
}
function closeAllAiViewerThreads(channelUserId) { return run("UPDATE ai_viewer_threads SET state = 'closed', awaiting = NULL, updated_at = CURRENT_TIMESTAMP WHERE channel_user_id = ? AND state = 'open'", [channelUserId]).changes; }
function addAiViewerLog(row) {
    return run(`INSERT INTO ai_viewer_log (channel_user_id, stream_id, event, bot_username, target, thread_id, chat_message_id, text, reason, tokens_in, tokens_cached, tokens_out, cost_usd, model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.channel_user_id, row.stream_id || null, row.event, row.bot_username || null, row.target || null, row.thread_id || null, row.chat_message_id || null,
         row.text == null ? null : String(row.text).slice(0, 600), row.reason == null ? null : String(row.reason).slice(0, 300),
         row.tokens_in || null, row.tokens_cached || null, row.tokens_out || null, row.cost_usd || null, row.model || null]);
}
function getAiViewerLog(channelUserId, { afterId = 0, limit = 50, streamId = null } = {}) {
    let sql = 'SELECT * FROM ai_viewer_log WHERE channel_user_id = ?';
    const params = [channelUserId];
    if (afterId) { sql += ' AND id > ?'; params.push(afterId); }
    if (streamId) { sql += ' AND stream_id = ?'; params.push(streamId); }
    sql += ' ORDER BY id DESC LIMIT ?'; params.push(Math.max(1, Math.min(200, limit)));
    return all(sql, params).reverse();
}
function pruneAiViewerLog(days = 7) { return run("DELETE FROM ai_viewer_log WHERE created_at < datetime('now', ?)", [`-${days} days`]).changes; }
function getAiViewerLogStats(channelUserId, sinceMin = 60) {
    return get(`SELECT SUM(CASE WHEN event = 'line' THEN 1 ELSE 0 END) AS lines, SUM(CASE WHEN event = 'tick' THEN 1 ELSE 0 END) AS ticks,
        SUM(CASE WHEN event = 'skip' THEN 1 ELSE 0 END) AS skips, COALESCE(SUM(cost_usd),0) AS cost_usd, COALESCE(SUM(tokens_in),0) AS tokens_in, COALESCE(SUM(tokens_cached),0) AS tokens_cached
        FROM ai_viewer_log WHERE channel_user_id = ? AND created_at > datetime('now', ?)`, [channelUserId, `-${sinceMin} minutes`]);
}
function getChannelAiBots(channelUserId, { activeOnly = false } = {}) {
    let sql = 'SELECT * FROM channel_ai_bots WHERE channel_user_id = ?';
    if (activeOnly) sql += ' AND is_active = 1';
    sql += ' ORDER BY last_active_at DESC, created_at ASC';
    return all(sql, [channelUserId]);
}

function getChannelAiBotByUsername(channelUserId, username) {
    return get('SELECT * FROM channel_ai_bots WHERE channel_user_id = ? AND username = ?', [channelUserId, username]);
}

function updateChannelAiBot(id, fields) {
    const allowed = {
        display_name: (v) => String(v || '').slice(0, 60),
        avatar_color: (v) => String(v || '').slice(0, 20),
        persona_json: (v) => (typeof v === 'string' ? v : JSON.stringify(v || {})),
        brain_json: (v) => (typeof v === 'string' ? v : JSON.stringify(v || {})),
        is_active: (v) => (v ? 1 : 0),
        source: (v) => String(v || '').slice(0, 20),
    };
    const sets = [];
    const params = [];
    for (const [col, coerce] of Object.entries(allowed)) {
        if (fields[col] !== undefined) { sets.push(`${col} = ?`); params.push(coerce(fields[col])); }
    }
    if (sets.length) {
        sets.push('updated_at = CURRENT_TIMESTAMP');
        params.push(id);
        run(`UPDATE channel_ai_bots SET ${sets.join(', ')} WHERE id = ?`, params);
    }
    return getChannelAiBot(id);
}

function touchChannelAiBot(id) {
    return run('UPDATE channel_ai_bots SET msg_count = msg_count + 1, last_active_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
}

function deleteChannelAiBot(id) {
    return run('DELETE FROM channel_ai_bots WHERE id = ?', [id]);
}

// ── OpenCoins helpers ───────────────────────────────────────

function addOpenCoins(userId, amount) {
    return run(`UPDATE users SET openvibe_coins_balance = openvibe_coins_balance + ? WHERE id = ?`,
        [amount, userId]);
}

function deductOpenCoins(userId, amount) {
    const result = run(
        `UPDATE users SET openvibe_coins_balance = openvibe_coins_balance - ? WHERE id = ? AND openvibe_coins_balance >= ?`,
        [amount, userId, amount]
    );
    return result.changes > 0;
}

function createCoinTransaction({ user_id, stream_id, amount, type, reward_id, message }) {
    return run(
        `INSERT INTO coin_transactions (user_id, stream_id, amount, type, reward_id, message)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [user_id, stream_id || null, amount, type, reward_id || null, message || null]
    );
}

function getCoinTransactions(userId, limit = 50) {
    return all(`SELECT * FROM coin_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
        [userId, limit]);
}

// ── Coin Rewards helpers ─────────────────────────────────────

function createCoinReward({ streamer_id, title, description, cost, icon, color, cooldown_seconds, max_per_stream, requires_input, is_global, sort_order }) {
    return run(
        `INSERT INTO coin_rewards (streamer_id, title, description, cost, icon, color, cooldown_seconds, max_per_stream, requires_input, is_global, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [streamer_id, title, description || '', cost || 100, icon || 'fa-star', color || '#8b5cf6',
         cooldown_seconds || 0, max_per_stream || 0, requires_input ? 1 : 0, is_global ? 1 : 0, sort_order || 0]
    );
}

function getCoinRewardsByStreamer(streamerId) {
    return all('SELECT * FROM coin_rewards WHERE streamer_id = ? AND is_enabled = 1 ORDER BY sort_order, cost',
        [streamerId]);
}

function getCoinRewardById(id) {
    return get('SELECT * FROM coin_rewards WHERE id = ?', [id]);
}

function updateCoinReward(id, fields) {
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = ?`);
        vals.push(v);
    }
    vals.push(id);
    return run(`UPDATE coin_rewards SET ${sets.join(', ')} WHERE id = ?`, vals);
}

function deleteCoinReward(id) {
    return run('DELETE FROM coin_rewards WHERE id = ?', [id]);
}

// ── Coin Redemptions helpers ─────────────────────────────────

function createCoinRedemption({ reward_id, user_id, stream_id, user_input }) {
    return run(
        `INSERT INTO coin_redemptions (reward_id, user_id, stream_id, user_input)
         VALUES (?, ?, ?, ?)`,
        [reward_id, user_id, stream_id || null, user_input || null]
    );
}

function getPendingRedemptions(streamerId) {
    return all(`
        SELECT r.*, cr.title as reward_title, cr.cost, cr.icon, cr.color,
               u.username, u.display_name, u.avatar_url
        FROM coin_redemptions r
        JOIN coin_rewards cr ON r.reward_id = cr.id
        JOIN users u ON r.user_id = u.id
        WHERE cr.streamer_id = ? AND r.status = 'pending'
        ORDER BY r.created_at ASC
    `, [streamerId]);
}

function resolveRedemption(id, status) {
    return run(`UPDATE coin_redemptions SET status = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [status, id]);
}

// ── Watch Time helpers ───────────────────────────────────────

function upsertWatchTime(userId, streamId) {
    // Create or update watch time record
    const existing = get('SELECT * FROM watch_time WHERE user_id = ? AND stream_id = ?',
        [userId, streamId]);
    if (existing) {
        return run(
            `UPDATE watch_time SET minutes_watched = minutes_watched + 1, last_heartbeat = CURRENT_TIMESTAMP WHERE id = ?`,
            [existing.id]
        );
    }
    return run(
        'INSERT INTO watch_time (user_id, stream_id, minutes_watched) VALUES (?, ?, 1)',
        [userId, streamId]
    );
}

function getWatchTime(userId, streamId) {
    return get('SELECT * FROM watch_time WHERE user_id = ? AND stream_id = ?',
        [userId, streamId]);
}

function getTotalWatchTime(userId) {
    const row = get('SELECT SUM(minutes_watched) as total FROM watch_time WHERE user_id = ?', [userId]);
    return row ? (row.total || 0) : 0;
}

// ── Media Request helpers ───────────────────────────────────

function getMediaRequestSettingsByUserId(userId) {
    return get('SELECT * FROM media_request_settings WHERE user_id = ?', [userId]);
}

function upsertMediaRequestSettings(userId, fields = {}) {
    const existing = getMediaRequestSettingsByUserId(userId);
    if (!existing) {
        run(`INSERT INTO media_request_settings (
            user_id, enabled, request_cost, max_per_user, max_duration_seconds,
            allow_youtube, allow_vimeo, allow_direct_media, auto_advance,
            cost_mode, cost_per_minute, allow_live, download_mode, currency
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            userId,
            fields.enabled ?? 1,
            fields.request_cost ?? 25,
            fields.max_per_user ?? 3,
            fields.max_duration_seconds ?? 600,
            fields.allow_youtube ?? 1,
            fields.allow_vimeo ?? 1,
            fields.allow_direct_media ?? 1,
            fields.auto_advance ?? 1,
            fields.cost_mode ?? 'flat',
            fields.cost_per_minute ?? 5,
            fields.allow_live ?? 0,
            fields.download_mode ?? 'stream',
            fields.currency ?? 'opencoins',
        ]);
    } else if (Object.keys(fields).length) {
        const sets = [];
        const vals = [];
        for (const [k, v] of Object.entries(fields)) {
            sets.push(`${k} = ?`);
            vals.push(v);
        }
        sets.push('updated_at = CURRENT_TIMESTAMP');
        vals.push(userId);
        run(`UPDATE media_request_settings SET ${sets.join(', ')} WHERE user_id = ?`, vals);
    }
    return getMediaRequestSettingsByUserId(userId);
}

function createMediaRequest({ streamer_id, stream_id, user_id, username, input, canonical_url, embed_url, provider, title, thumbnail_url, duration_seconds, cost, queue_position, currency, status, charge_state }) {
    return run(
        `INSERT INTO media_requests (
            streamer_id, stream_id, user_id, username, input, canonical_url, embed_url,
            provider, title, thumbnail_url, duration_seconds, cost, queue_position, currency, status, charge_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            streamer_id,
            stream_id || null,
            user_id,
            username,
            input,
            canonical_url,
            embed_url || null,
            provider,
            title,
            thumbnail_url || null,
            duration_seconds ?? null,
            cost,
            queue_position ?? 0,
            currency || 'opencoins',
            status || 'pending',
            charge_state || null,
        ]
    );
}

/** Drop a paid request whose charge was refused (nothing was taken); only while it is still 'charging'. */
function removeUnchargedMediaRequest(id) {
    return run("DELETE FROM media_requests WHERE id = ? AND charge_state = 'charging'", [id]);
}

function getMediaRequestById(id) {
    return get('SELECT * FROM media_requests WHERE id = ?', [id]);
}

function getMediaRequestByStreamerAndId(streamerId, id) {
    return get('SELECT * FROM media_requests WHERE streamer_id = ? AND id = ?', [streamerId, id]);
}

function getActiveMediaRequestByStreamer(streamerId) {
    return get(`SELECT * FROM media_requests WHERE streamer_id = ? AND status = 'playing' ORDER BY started_at DESC, id DESC LIMIT 1`, [streamerId]);
}

function getNextPendingMediaRequest(streamerId) {
    return get(`SELECT * FROM media_requests WHERE streamer_id = ? AND status = 'pending' ORDER BY queue_position ASC, requested_at ASC, id ASC LIMIT 1`, [streamerId]);
}

function getPendingMediaRequestsByStreamer(streamerId, limit = 50) {
    return all(`SELECT * FROM media_requests WHERE streamer_id = ? AND status = 'pending' ORDER BY queue_position ASC, requested_at ASC, id ASC LIMIT ?`, [streamerId, limit]);
}

function getRecentMediaRequestsByStreamer(streamerId, limit = 15) {
    return all(`SELECT * FROM media_requests WHERE streamer_id = ? AND status IN ('played', 'skipped', 'removed', 'failed') AND charge_state IS NOT 'charging' ORDER BY COALESCE(ended_at, requested_at) DESC, id DESC LIMIT ?`, [streamerId, limit]);
}

function countPendingMediaRequestsForUser(streamerId, userId) {
    const row = get(`SELECT COUNT(*) AS c FROM media_requests WHERE streamer_id = ? AND user_id = ? AND status IN ('pending', 'playing')`, [streamerId, userId]);
    return row?.c || 0;
}

function getMediaRequestMaxQueuePosition(streamerId) {
    const row = get(`SELECT MAX(queue_position) AS max_pos FROM media_requests WHERE streamer_id = ? AND status = 'pending'`, [streamerId]);
    return row?.max_pos || 0;
}

function findActiveMediaRequestByCanonicalUrl(streamerId, canonicalUrl) {
    return get(`SELECT * FROM media_requests WHERE streamer_id = ? AND canonical_url = ? AND status IN ('pending', 'playing') ORDER BY id DESC LIMIT 1`, [streamerId, canonicalUrl]);
}

function updateMediaRequest(id, fields = {}) {
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = ?`);
        vals.push(v);
    }
    if (!sets.length) return null;
    vals.push(id);
    return run(`UPDATE media_requests SET ${sets.join(', ')} WHERE id = ?`, vals);
}

function renormalizePendingMediaRequestPositions(streamerId) {
    const rows = all(`SELECT id FROM media_requests WHERE streamer_id = ? AND status = 'pending' ORDER BY queue_position ASC, requested_at ASC, id ASC`, [streamerId]);
    const tx = getDb().transaction((list) => {
        list.forEach((row, idx) => {
            run('UPDATE media_requests SET queue_position = ? WHERE id = ?', [idx + 1, row.id]);
        });
    });
    tx(rows);
}

// ── Comments ─────────────────────────────────────────────────
// VOD/clip comments are OpenVibe.Community threads (server/comments-client.js). The `comments`
// table is read-only: the one-time import (OpenVibe.Community scripts/import-live-comments.js)
// reads it; test/frozen-tables.test.js fails if server code writes it again.

// ── Channel lookup by ID ─────────────────────────────────────

function getChannelById(id) {
    return get('SELECT * FROM channels WHERE id = ?', [id]);
}

// ── Pastes ───────────────────────────────────────────────────
// They live in OpenVibe.Community (server/pastes-client.js, media-proxy/lookups.js). The legacy
// local pastes/paste_likes/paste_comments tables are frozen and unread, like vods/clips above.

/**
 * Get a user's total game level (sum of all skill levels).
 * Game has been migrated to openvibe.games — always returns 0 now.
 * Kept for paste upload limit compatibility.
 */
function getUserTotalGameLevel(userId) {
    if (!userId) return 0;
    try {
        const p = get('SELECT mining_xp, fishing_xp, woodcut_xp, farming_xp, combat_xp, crafting_xp, smithing_xp, agility_xp FROM game_players WHERE user_id = ?', [userId]);
        if (!p) return 0;
        const xpToLevel = (xp) => Math.floor(Math.sqrt((xp || 0) / 25)) + 1;
        return xpToLevel(p.mining_xp) + xpToLevel(p.fishing_xp) + xpToLevel(p.woodcut_xp) +
               xpToLevel(p.farming_xp) + xpToLevel(p.combat_xp) + xpToLevel(p.crafting_xp) +
               xpToLevel(p.smithing_xp) + xpToLevel(p.agility_xp);
    } catch {
        return 0; // game_players table may not exist after migration
    }
}

/**
 * The legacy HoboQuest skills a user earned while the game ran inside Live, for the chat profile
 * card: { total_level, <skill>_level, <skill>_xp, total_coins_earned } or null. Read-only: it never
 * creates a game_players row (the old game engine's getPlayer() inserted one for every profile
 * viewed). OpenVibe.Games owns the game now and imports these rows from here.
 */
function getLegacyGameProfile(userId) {
    if (!userId) return null;
    let p;
    try {
        p = get('SELECT * FROM game_players WHERE user_id = ?', [userId]);
    } catch {
        return null; // no game_players table (a fresh install)
    }
    if (!p) return null;
    const xpToLevel = (xp) => Math.floor(Math.sqrt((xp || 0) / 25)) + 1;
    const skills = ['mining', 'fishing', 'woodcut', 'farming', 'combat', 'crafting', 'smithing', 'agility'];
    const out = { total_level: 0, total_coins_earned: p.total_coins_earned || 0 };
    for (const s of skills) {
        const xp = p[`${s}_xp`] || 0;
        out[`${s}_xp`] = xp;
        out[`${s}_level`] = xpToLevel(xp);
        out.total_level += out[`${s}_level`];
    }
    return out;
}

// ── Anon IP Mapping ─────────────────────────────────

/**
 * Get or assign a persistent anon number for a normalized IP.
 * Returns the existing number if the IP was seen before, or assigns
 * the next sequential number. Survives server restarts.
 */
/** When this address was first given an anon number (null for rows from before that was recorded). */
function getAnonFirstSeen(ip) {
    try { return get('SELECT created_at FROM anon_ip_mappings WHERE ip = ?', [ip])?.created_at || null; } catch { return null; }
}

function getOrCreateAnonNum(ip) {
    const existing = get('SELECT anon_num FROM anon_ip_mappings WHERE ip = ?', [ip]);
    if (existing) return existing.anon_num;
    const max = get('SELECT MAX(anon_num) as m FROM anon_ip_mappings');
    const nextNum = (max?.m || 0) + 1;
    try {
        run('INSERT INTO anon_ip_mappings (ip, anon_num, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)', [ip, nextNum]);
    } catch (e) {
        // Race condition: another connection inserted first — re-read
        const retry = get('SELECT anon_num FROM anon_ip_mappings WHERE ip = ?', [ip]);
        if (retry) return retry.anon_num;
        throw e;
    }
    return nextNum;
}

/**
 * Load all existing anon mappings (for in-memory cache warmup).
 * @returns {{ maxNum: number, mappings: Map<string, number> }}
 */
function loadAnonMappings() {
    const rows = all('SELECT ip, anon_num FROM anon_ip_mappings ORDER BY anon_num');
    const mappings = new Map();
    let maxNum = 0;
    for (const row of rows) {
        mappings.set(row.ip, row.anon_num);
        if (row.anon_num > maxNum) maxNum = row.anon_num;
    }
    return { maxNum, mappings };
}

// ── Approved IPs (Anti-VPN Mode) ─────────────────────────────

/**
 * Check if an IP is approved for a channel.
 */
function isIpApproved(channelId, ip) {
    return !!get('SELECT 1 FROM approved_ips WHERE channel_id = ? AND ip_address = ?', [channelId, ip]);
}

/**
 * Auto-approve an IP for a channel (from existing chatter).
 */
function approveIp(channelId, ip, approvedBy = null, source = 'auto') {
    return run(
        'INSERT OR IGNORE INTO approved_ips (channel_id, ip_address, approved_by, source) VALUES (?, ?, ?, ?)',
        [channelId, ip, approvedBy, source]
    );
}

/**
 * Remove an IP approval.
 */
function revokeIpApproval(channelId, ip) {
    return run('DELETE FROM approved_ips WHERE channel_id = ? AND ip_address = ?', [channelId, ip]);
}

/**
 * Get all approved IPs for a channel.
 */
function getApprovedIps(channelId, { limit = 100, offset = 0 } = {}) {
    return all(
        `SELECT ai.*, u.username as approved_by_username
         FROM approved_ips ai LEFT JOIN users u ON ai.approved_by = u.id
         WHERE ai.channel_id = ? ORDER BY ai.created_at DESC LIMIT ? OFFSET ?`,
        [channelId, limit, offset]
    );
}

// ── IP Tracking ──────────────────────────────────────────────

/**
 * Log an IP association. Deduplicates within 10 minutes for the same user+ip+action.
 */
function logIp({ userId, anonId, ip, action = 'chat', geo, userAgent }) {
    if (!ip || ip === 'unknown') return;
    // Deduplicate: skip if same user+ip+action within the last 10 minutes
    const dedupKey = userId
        ? `user_id = ? AND ip_address = ? AND action = ?`
        : `anon_id = ? AND ip_address = ? AND action = ?`;
    const dedupParams = userId ? [userId, ip, action] : [anonId, ip, action];
    const recent = get(
        `SELECT id FROM ip_log WHERE ${dedupKey} AND created_at > datetime('now', '-10 minutes') LIMIT 1`,
        dedupParams
    );
    if (recent) return;

    run(
        `INSERT INTO ip_log (user_id, anon_id, ip_address, action, geo_country, geo_region, geo_city, geo_isp, geo_org, geo_ll, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            userId || null,
            anonId || null,
            ip,
            action,
            geo?.country || null,
            geo?.region || null,
            geo?.city || null,
            geo?.isp || null,
            geo?.org || null,
            geo?.ll || null,
            userAgent || null,
        ]
    );
}

/**
 * Get all IPs used by a user, with geo data and last-seen times.
 */
function getIpsByUser(userId) {
    return all(`
        SELECT ip_address, geo_country, geo_region, geo_city, geo_isp, geo_org, geo_ll,
               COUNT(*) as hit_count,
               MIN(created_at) as first_seen,
               MAX(created_at) as last_seen,
               GROUP_CONCAT(DISTINCT action) as actions
        FROM ip_log
        WHERE user_id = ?
        GROUP BY ip_address
        ORDER BY last_seen DESC
    `, [userId]);
}

/**
 * Get all users (and anons) that have used a specific IP.
 */
function getUsersByIp(ip) {
    return all(`
        SELECT il.user_id, il.anon_id,
               u.username, u.display_name, u.avatar_url, u.role, u.is_banned, u.ban_reason, u.created_at as user_created_at,
               COUNT(*) as hit_count,
               MIN(il.created_at) as first_seen,
               MAX(il.created_at) as last_seen,
               GROUP_CONCAT(DISTINCT il.action) as actions
        FROM ip_log il
        LEFT JOIN users u ON il.user_id = u.id
        WHERE il.ip_address = ?
        GROUP BY COALESCE(il.user_id, il.anon_id)
        ORDER BY last_seen DESC
    `, [ip]);
}

/**
 * Get linked accounts for a user — finds all IPs the user has used, then finds all other
 * accounts sharing any of those IPs. Returns accounts sorted by number of shared IPs.
 */
function getLinkedAccounts(userId) {
    return all(`
        SELECT u.id, u.username, u.display_name, u.avatar_url, u.role, u.is_banned, u.ban_reason,
               u.created_at,
               COUNT(DISTINCT shared.ip_address) as shared_ip_count,
               GROUP_CONCAT(DISTINCT shared.ip_address) as shared_ips,
               MAX(shared.created_at) as last_shared_activity
        FROM ip_log mine
        JOIN ip_log shared ON mine.ip_address = shared.ip_address AND shared.user_id != ?
        JOIN users u ON shared.user_id = u.id
        WHERE mine.user_id = ?
        GROUP BY shared.user_id
        ORDER BY shared_ip_count DESC, last_shared_activity DESC
    `, [userId, userId]);
}

/**
 * Get linked accounts for an anon — same as above but using anon_id.
 */
function getLinkedAccountsByAnon(anonId) {
    return all(`
        SELECT u.id, u.username, u.display_name, u.avatar_url, u.role, u.is_banned, u.ban_reason,
               u.created_at,
               COUNT(DISTINCT shared.ip_address) as shared_ip_count,
               GROUP_CONCAT(DISTINCT shared.ip_address) as shared_ips,
               MAX(shared.created_at) as last_shared_activity
        FROM ip_log mine
        JOIN ip_log shared ON mine.ip_address = shared.ip_address AND (shared.user_id IS NOT NULL OR shared.anon_id != ?)
        LEFT JOIN users u ON shared.user_id = u.id
        WHERE mine.anon_id = ?
        GROUP BY COALESCE(shared.user_id, shared.anon_id)
        ORDER BY shared_ip_count DESC, last_shared_activity DESC
    `, [anonId, anonId]);
}

/**
 * Get the most recent IP for a user.
 */
function getLatestIpForUser(userId) {
    return get(`SELECT ip_address, geo_country, geo_region, geo_city, geo_isp, geo_org, geo_ll, created_at
                FROM ip_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`, [userId]);
}

/**
 * Get the most recent IP for an anon.
 */
function getLatestIpForAnon(anonId) {
    return get(`SELECT ip_address, geo_country, geo_region, geo_city, geo_isp, geo_org, geo_ll, created_at
                FROM ip_log WHERE anon_id = ? ORDER BY created_at DESC LIMIT 1`, [anonId]);
}

/**
 * Get full IP history log (admin search).
 */
function getIpLog({ userId, anonId, ip, action, limit = 100, offset = 0 } = {}) {
    const conditions = [];
    const params = [];
    if (userId) { conditions.push('il.user_id = ?'); params.push(userId); }
    if (anonId) { conditions.push('il.anon_id = ?'); params.push(anonId); }
    if (ip) { conditions.push('il.ip_address = ?'); params.push(ip); }
    if (action) { conditions.push('il.action = ?'); params.push(action); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit, offset);
    return all(`
        SELECT il.*, u.username, u.display_name
        FROM ip_log il
        LEFT JOIN users u ON il.user_id = u.id
        ${where}
        ORDER BY il.created_at DESC
        LIMIT ? OFFSET ?
    `, params);
}

/**
 * Ban all accounts sharing an IP. Returns the list of user IDs banned.
 */
function banAllAccountsOnIp(ip, { reason, bannedBy, expires }) {
    // Staff and the moderator issuing the ban are never swept up. Staff browse from the same shared
    // home and mobile networks as people who get banned, and the IP-ban exemption for admins only
    // covers sessions that are not themselves banned — so banning an admin account by IP would
    // lock them out of the site entirely. On production every admin shares some IP with another
    // account. Returns the banned user ids; `skippedStaff` on the array lists who was left alone.
    const users = all(`
        SELECT DISTINCT il.user_id, u.role
        FROM ip_log il
        JOIN users u ON u.id = il.user_id
        WHERE il.ip_address = ? AND il.user_id IS NOT NULL
    `, [ip]);

    const bannedIds = [];
    const skippedStaff = [];
    for (const row of users) {
        if (!row.user_id) continue;
        if (row.user_id === bannedBy || row.role === 'admin' || row.role === 'global_mod') { skippedStaff.push(row.user_id); continue; }
        // Set is_banned flag
        run('UPDATE users SET is_banned = 1, ban_reason = ? WHERE id = ? AND is_banned = 0', [reason, row.user_id]);
        // Create global user ban
        run(`INSERT INTO bans (user_id, ip_address, reason, banned_by, expires_at) VALUES (?, ?, ?, ?, ?)`,
            [row.user_id, ip, reason, bannedBy, expires || null]);
        bannedIds.push(row.user_id);
    }
    // Also create standalone IP ban
    run(`INSERT INTO bans (ip_address, reason, banned_by, expires_at) VALUES (?, ?, ?, ?)`,
        [ip, reason, bannedBy, expires || null]);

    bannedIds.skippedStaff = skippedStaff;
    return bannedIds;
}

// ── Stream Analytics helpers ─────────────────────────────────

function insertViewerSnapshot(streamId, viewerCount, chatMessages5m) {
    return run(
        `INSERT INTO viewer_snapshots (stream_id, viewer_count, chat_messages_5m)
         VALUES (?, ?, ?)`,
        [streamId, viewerCount, chatMessages5m || 0]
    );
}

function getViewerSnapshots(streamId) {
    return all(
        `SELECT viewer_count, chat_messages_5m, recorded_at
         FROM viewer_snapshots WHERE stream_id = ? ORDER BY recorded_at ASC`,
        [streamId]
    );
}

function computeAndCacheStreamAnalytics(streamId) {
    const stream = get('SELECT * FROM streams WHERE id = ?', [streamId]);
    if (!stream) return null;

    // Average viewers from snapshots
    const avgRow = get(
        'SELECT AVG(viewer_count) as avg_vc FROM viewer_snapshots WHERE stream_id = ?', [streamId]
    );
    const avgViewers = avgRow?.avg_vc || 0;

    // Unique chatters + total messages come from OpenVibe.Chat (Live's own tables when Live runs
    // chat). Chat's stream stats count every message type — Live used to keep only message_type='chat'
    // and is_global=0 — and its numbers are the authority now. This runs synchronously at stream end,
    // when `st:<id>` is still cold, so a peek would answer the mirror (or 0 on a throw): it keeps the
    // totals already stored and asks Chat right after (setStreamAnalyticsChatTotals writes them back),
    // the same pattern as the clip count below.
    const prior = get('SELECT unique_chatters, total_messages FROM stream_analytics WHERE stream_id = ?', [streamId]) || {};
    const uniqueChatters = Number(prior.unique_chatters) || 0;
    const totalMessages = Number(prior.total_messages) || 0;
    setImmediate(() => {
        try {
            require('../chat/chat-reads').streamStats(streamId)
                .then((t) => { if (t) setStreamAnalyticsChatTotals(streamId, t.chatters, t.messages); })
                .catch(() => {});
        } catch { /* */ }
    });

    // Total watch minutes
    const watchRow = get(
        'SELECT SUM(minutes_watched) as total FROM watch_time WHERE stream_id = ?', [streamId]
    );
    const totalWatchMinutes = watchRow?.total || 0;

    // Clips created during this stream: they live in OpenVibe.Media. This runs synchronously when a
    // stream ends, so it keeps the last count it has and asks Media right after (lookups.js
    // refreshStreamClipCount writes the answer back with setStreamAnalyticsClipCount).
    const clipsCreated = get('SELECT clips_created FROM stream_analytics WHERE stream_id = ?', [streamId])?.clips_created || 0;
    setImmediate(() => { try { require('../media-proxy/lookups').refreshStreamClipCount(streamId).catch(() => {}); } catch { /* */ } });

    // Coins earned during this stream
    const coinsRow = get(
        'SELECT SUM(coins_earned) as total FROM watch_time WHERE stream_id = ?', [streamId]
    );
    const coinsEarned = coinsRow?.total || 0;

    // New followers — approximate: follows where created_at is during stream
    let newFollowers = 0;
    if (stream.started_at && stream.ended_at) {
        const fRow = get(
            `SELECT COUNT(*) as cnt FROM follows
             WHERE streamer_id = ? AND created_at >= ? AND created_at <= ?`,
            [stream.user_id, stream.started_at, stream.ended_at]
        );
        newFollowers = fRow?.cnt || 0;
    }

    // Upsert into stream_analytics
    run(
        `INSERT INTO stream_analytics
            (stream_id, avg_viewers, peak_viewers, unique_chatters, total_messages,
             total_watch_minutes, new_followers, clips_created, coins_earned, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(stream_id) DO UPDATE SET
            avg_viewers = excluded.avg_viewers,
            peak_viewers = excluded.peak_viewers,
            unique_chatters = excluded.unique_chatters,
            total_messages = excluded.total_messages,
            total_watch_minutes = excluded.total_watch_minutes,
            new_followers = excluded.new_followers,
            clips_created = excluded.clips_created,
            coins_earned = excluded.coins_earned,
            computed_at = CURRENT_TIMESTAMP`,
        [streamId, avgViewers, stream.peak_viewers || 0, uniqueChatters, totalMessages,
         totalWatchMinutes, newFollowers, clipsCreated, coinsEarned]
    );

    return {
        stream_id: streamId,
        avg_viewers: avgViewers,
        peak_viewers: stream.peak_viewers || 0,
        unique_chatters: uniqueChatters,
        total_messages: totalMessages,
        total_watch_minutes: totalWatchMinutes,
        new_followers: newFollowers,
        clips_created: clipsCreated,
        coins_earned: coinsEarned,
    };
}

function getStreamAnalytics(streamId) {
    return get('SELECT * FROM stream_analytics WHERE stream_id = ?', [streamId]);
}

// The clip count OpenVibe.Media reported for a stream (media-proxy/lookups.js refreshStreamClipCount).
function setStreamAnalyticsClipCount(streamId, count) {
    return run('UPDATE stream_analytics SET clips_created = ? WHERE stream_id = ?', [Math.max(0, Math.floor(Number(count) || 0)), streamId]);
}

// The chat totals OpenVibe.Chat reported for a stream (the setImmediate refresh in
// computeAndCacheStreamAnalytics).
function setStreamAnalyticsChatTotals(streamId, chatters, messages) {
    return run('UPDATE stream_analytics SET unique_chatters = ?, total_messages = ? WHERE stream_id = ?',
        [Math.max(0, Math.floor(Number(chatters) || 0)), Math.max(0, Math.floor(Number(messages) || 0)), streamId]);
}

function getChannelAnalyticsSummary(userId, days) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();

    // Stream history with analytics
    const streams = all(`
        SELECT s.id, s.title, s.category, s.started_at, s.ended_at, s.duration_seconds,
               s.peak_viewers, s.viewer_count,
               sa.avg_viewers, sa.unique_chatters, sa.total_messages,
               sa.total_watch_minutes, sa.new_followers, sa.clips_created, sa.coins_earned
        FROM streams s
        LEFT JOIN stream_analytics sa ON sa.stream_id = s.id
        WHERE s.user_id = ? AND s.started_at >= ? AND s.duration_seconds > 0
        ORDER BY s.started_at DESC
    `, [userId, cutoff]);

    // Aggregate stats
    const agg = get(`
        SELECT COUNT(*) as total_streams,
               SUM(s.duration_seconds) as total_duration,
               MAX(s.peak_viewers) as all_time_peak,
               AVG(sa.avg_viewers) as avg_viewers_per_stream,
               SUM(sa.total_messages) as total_messages,
               SUM(sa.unique_chatters) as total_unique_chatters,
               SUM(sa.total_watch_minutes) as total_watch_minutes,
               SUM(sa.new_followers) as total_new_followers,
               SUM(sa.clips_created) as total_clips
        FROM streams s
        LEFT JOIN stream_analytics sa ON sa.stream_id = s.id
        WHERE s.user_id = ? AND s.started_at >= ? AND s.duration_seconds > 0
    `, [userId, cutoff]);

    // All-time totals
    const allTime = get(`
        SELECT COUNT(*) as total_streams,
               SUM(duration_seconds) as total_duration,
               MAX(peak_viewers) as peak_viewers
        FROM streams WHERE user_id = ? AND duration_seconds > 0
    `, [userId]);

    const followerCount = get(
        'SELECT COUNT(*) as cnt FROM follows WHERE streamer_id = ?', [userId]
    )?.cnt || 0;

    return {
        period_days: days,
        streams,
        summary: {
            total_streams: agg?.total_streams || 0,
            total_duration_seconds: agg?.total_duration || 0,
            peak_viewers: agg?.all_time_peak || 0,
            avg_viewers_per_stream: Math.round((agg?.avg_viewers_per_stream || 0) * 10) / 10,
            total_messages: agg?.total_messages || 0,
            total_unique_chatters: agg?.total_unique_chatters || 0,
            total_watch_minutes: agg?.total_watch_minutes || 0,
            total_new_followers: agg?.total_new_followers || 0,
            total_clips: agg?.total_clips || 0,
        },
        all_time: {
            total_streams: allTime?.total_streams || 0,
            total_duration_seconds: allTime?.total_duration || 0,
            peak_viewers: allTime?.peak_viewers || 0,
            follower_count: followerCount,
        },
    };
}

/* ── User Preferences (server-side settings sync) ─────────── */

function getUserPreferences(userId) {
    const row = get('SELECT chat_settings FROM user_preferences WHERE user_id = ?', [userId]);
    if (!row) return {};
    try { return JSON.parse(row.chat_settings); } catch { return {}; }
}

function saveUserPreferences(userId, chatSettings) {
    const json = JSON.stringify(chatSettings);
    run(
        `INSERT INTO user_preferences (user_id, chat_settings, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO UPDATE SET chat_settings = excluded.chat_settings, updated_at = CURRENT_TIMESTAMP`,
        [userId, json]
    );
}

/* ── API Tokens (Bot / Integration auth) ──────────────────── */

function _hashToken(rawToken) {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function createApiToken(userId, label, scopes, expiresAt) {
    const rawToken = 'hbt_' + crypto.randomBytes(32).toString('hex');
    const hash = _hashToken(rawToken);
    run(
        `INSERT INTO api_tokens (user_id, token_hash, label, scopes, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        [userId, hash, label || 'Bot Token', JSON.stringify(scopes || ['chat', 'read']), expiresAt || null]
    );
    const row = get('SELECT id, created_at FROM api_tokens WHERE token_hash = ?', [hash]);
    return { id: row.id, token: rawToken, created_at: row.created_at };
}

function listApiTokens(userId) {
    return all(
        `SELECT id, label, scopes, created_at, last_used_at, expires_at, is_active
         FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC`,
        [userId]
    );
}

function revokeApiToken(tokenId, userId) {
    return run('UPDATE api_tokens SET is_active = 0 WHERE id = ? AND user_id = ?', [tokenId, userId]);
}

function validateApiToken(rawToken) {
    const hash = _hashToken(rawToken);
    const row = get(
        `SELECT t.*, u.id as uid, u.username, u.display_name, u.role, u.profile_color, u.avatar_url, u.is_banned, u.ban_reason
         FROM api_tokens t JOIN users u ON t.user_id = u.id
         WHERE t.token_hash = ? AND t.is_active = 1`,
        [hash]
    );
    if (!row) return null;
    // Check expiry
    if (row.expires_at && new Date(row.expires_at) < new Date()) return null;
    // Update last used
    run('UPDATE api_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?', [row.id]);
    const scopes = (() => { try { return JSON.parse(row.scopes); } catch { return []; } })();
    return {
        id: row.uid, username: row.username, display_name: row.display_name,
        role: row.role, profile_color: row.profile_color, avatar_url: row.avatar_url,
        is_banned: row.is_banned ? 1 : 0, ban_reason: row.ban_reason || null,
        tokenId: row.id, scopes,
    };
}

// ── Donation goals ───────────────────────────────────────────
// Widget set: active goals + goals reached within the celebration window (default 1h),
// so a met goal celebrates then auto-clears from the viewer widget.
function getDonationGoalsForWidget(userId, windowHours = 1) {
    return all(`SELECT * FROM donation_goals
        WHERE user_id = ?
          AND (is_active = 1 OR (reached_at IS NOT NULL AND reached_at > datetime('now', ?)))
        ORDER BY sort_order ASC, created_at ASC`, [userId, `-${windowHours} hours`]);
}
// Management set: everything the streamer owns (active + completed) for the dashboard.
function getAllDonationGoals(userId) {
    return all('SELECT * FROM donation_goals WHERE user_id = ? ORDER BY is_active DESC, sort_order ASC, created_at ASC', [userId]);
}
function getActiveDonationGoals(userId) {
    return all('SELECT * FROM donation_goals WHERE user_id = ? AND is_active = 1 ORDER BY sort_order ASC, created_at ASC', [userId]);
}
function getDonationGoalById(id) { return get('SELECT * FROM donation_goals WHERE id = ?', [id]); }
function createDonationGoal(userId, { title, target_amount, image_url = null, media_type = null }) {
    const r = get('SELECT COALESCE(MAX(sort_order),-1)+1 AS n FROM donation_goals WHERE user_id = ?', [userId]);
    return run('INSERT INTO donation_goals (user_id, title, target_amount, image_url, media_type, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, title, target_amount, image_url, media_type, r ? r.n : 0]);
}
function updateDonationGoal(id, userId, fields) {
    const allow = ['title', 'target_amount', 'image_url', 'media_type', 'is_active', 'sort_order', 'current_amount', 'reached_at'];
    const sets = [], params = [];
    for (const k of allow) if (fields[k] !== undefined) { sets.push(`${k} = ?`); params.push(fields[k]); }
    if (!sets.length) return null;
    params.push(id, userId);
    return run(`UPDATE donation_goals SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, params);
}
function deleteDonationGoal(id, userId) { return run('DELETE FROM donation_goals WHERE id = ? AND user_id = ?', [id, userId]); }
// Apply an amount to a specific goal; flips it reached (with reached_at) when the
// target is hit. Returns { goal, reached }.
function addToDonationGoal(id, amount) {
    const g = getDonationGoalById(id);
    if (!g || !g.is_active) return { goal: g || null, reached: false };
    const newAmount = Math.min(Math.round((g.current_amount || 0) + amount), g.target_amount);
    const reached = newAmount >= g.target_amount;
    if (reached) run("UPDATE donation_goals SET current_amount = ?, is_active = 0, reached_at = CURRENT_TIMESTAMP WHERE id = ?", [newAmount, id]);
    else run('UPDATE donation_goals SET current_amount = ? WHERE id = ?', [newAmount, id]);
    return { goal: getDonationGoalById(id), reached };
}

module.exports = {
    // Startup repair that initDb() defers by a few seconds; exported so tests can run it directly.
    adoptOrphanedTimelineRows,
    publicStream,
    getConcurrencyBaseline,
    getHomeStatSeries, homeSeriesLocal, HOME_SERIES_KEYS, vibesStatsSince, _computeHomeStats,
    getVodAiState, getClipAiState, forgetMediaItem,
    scheduleClipNotifyState, bumpClipNotifyNowState, markClipNotifiedState, getDueClipNotifies,
    getDb, initDb, run, get, all, tx, close,
    getTimelineSpeechSince,
    getDonationGoalsForWidget, getAllDonationGoals, getActiveDonationGoals, getDonationGoalById,
    recordViewerSample, getViewerTrend, getReadingSeries, getHomePulse, getActiveGoalsForUsers,
    createDonationGoal, updateDonationGoal, deleteDonationGoal, addToDonationGoal,
    // Users
    getUserById, getUserByUsername, getUserByStreamKey, createUser, getOrCreateAnonGameUser,
    // Managed Streams
    createManagedStream, getManagedStreamById, getManagedStreamsByUserId,
    getManagedStreamBySlug, getManagedStreamByStreamKey, getManagedStreamByIdOrSlug,
    updateManagedStream, deleteManagedStream,
    getManagedStreamBroadcastSettings, updateManagedStreamBroadcastSettings,
    getPipOverlayForManagedStream, getPipCandidateSlots,
    countManagedStreamsByUser, getManagedStreamLimit,
    isValidManagedStreamSlug, isManagedStreamSlugTaken,
    ensureStreamerRoleOnFeed,
    // Streams (sessions)
    getLiveStreams, getRecentStreams, getStreamById, setStreamAiCategory, effectiveCategory, getStreamByUserId, getLiveStreamsByUserId, getLiveStreamsByControlConfigId, getStreamsByUserId, getStreamHistoryByManagedStream,
    createStream, endStream, onStreamLifecycle, endOtherLiveStreamsForSlot, updateViewerCount,
    addStreamMemory, getStreamMemories, getLatestStreamMemory, updateStreamAiOverview,
    setVodAiOverview, setClipAiOverview, setVodTranscript, setClipTranscript, getStreamMemoriesInRange,
    getVodsNeedingOverview, getClipsNeedingOverview, getVodsNeedingTimeline, getVodsNeedingTranscript, getClipsNeedingTranscript,
    setVodTranscriptStatus, setClipTranscriptStatus, bumpVodTranscriptAttempt, bumpClipTranscriptAttempt,
    cleanupMalformedAiText, recordAiUsage, getAiCostToday, getAiCostTodayForUser, getAiUsageSummary,
    getStreamMemoriesByUser, countStreamMemoriesByUser, getStreamTranscriptSegments,
    addTimelineEvents, getTimeline, getTimelineText, getTimelineCoverage, linkTimelineToVod, getTimelineByVod, getTimelineVodId,
    upsertStreamerOverview, getStreamerOverview, getAllStreamerOverviews, getStreamersNeedingOverview,
    readStreamerAiTimelineCache, buildStreamerAiTimeline, assembleStreamerAiTimeline, setStreamAiTitle, getUntitledAiSessions, clearAiTimelineCache,
    // Homepage helpers
    getRecentlyOnlineStreamers, countRecentlyOnlineStreamers,
    getHomeStats,
    // Channels
    getChannelByUserId, getChannelsByUserIds, getChannelByUsername, isAiDerivationEnabled, createChannel, updateChannel, ensureChannel, setUserBio,
    getChannelPointsConfig, setChannelPointsConfig,
    getChannelVodRecordingPolicyByUserId, resolveStreamRecordingMode, resolveStreamVodVisibility, resolveStreamClipVisibility, isStreamClipRecordingEnabled,
    // RobotStreamer integration
    getRobotStreamerIntegrationByUserId, upsertRobotStreamerIntegration,
    getRobotStreamerIntegrationBySlot, getRobotStreamerIntegrationForStream,
    deleteRobotStreamerIntegrationForSlot,
    // Restream destinations
    getRestreamDestinationsByUserId, getRestreamDestinationById,
    markRestreamDestinationFailure, clearRestreamDestinationCooldown, restreamDestinationCooldownMs,
    createRestreamDestination, updateRestreamDestination, deleteRestreamDestination,
    getPlatformConnection, getPlatformConnectionById, getPlatformConnectionsByUserId,
    upsertPlatformConnection, updatePlatformConnectionTokens, deletePlatformConnection,
    // PowerChat
    getPowerchatConnection, getPowerchatConnectionByUsername, getPowerchatConnectionByPcUserId,
    upsertPowerchatConnection, updatePowerchatTokens, setPowerchatConnectionError,
    deletePowerchatConnection, powerchatDeliveryIsNew, cleanupPowerchatDeliveries,
    createPaymentOrder, getPaymentOrderById, getPaymentOrderByRef, updatePaymentOrder, getPendingPowerchatOrders,
    upsertSubscription, getSubscriptionByProviderRef, getActiveSubscription, isActiveSubscriber,
    getSubscriptionsByStreamer, getSubscriptionsBySubscriber, getActiveSubscriberCount, setSubscriptionStatus,
    getSubscriptionsDueRenewal,
    getRestreamDestinationsByManagedStream, getRestreamDestinationsForSlot,
    recordEasterEggSolve, hasSolvedEasterEgg, countEasterEggSolves,
    // Profiles
    getUserProfile, updateUserAvatar,
    getKickChannelCache, setKickChannelCache,
    getChannelPoints, addChannelPoints, deductChannelPoints, applyChannelPoints,
    // Follows
    getFollowerCount, isFollowing, getFollowerIds,
    // Transactions (Vibes)
    createTransaction, addVibes, deductVibes, addVibesCashout, deductVibesCashout,
    // OpenCoins
    addOpenCoins, deductOpenCoins, createCoinTransaction, getCoinTransactions,
    // Coin Rewards
    createCoinReward, getCoinRewardsByStreamer, getCoinRewardById, updateCoinReward, deleteCoinReward,
    // Coin Redemptions
    createCoinRedemption, getPendingRedemptions, resolveRedemption,
    // Watch Time
    upsertWatchTime, getWatchTime, getTotalWatchTime,
    // Media Requests
    getMediaRequestSettingsByUserId, upsertMediaRequestSettings,
    createMediaRequest, removeUnchargedMediaRequest, getMediaRequestById, getMediaRequestByStreamerAndId,
    getActiveMediaRequestByStreamer, getNextPendingMediaRequest,
    getPendingMediaRequestsByStreamer, getRecentMediaRequestsByStreamer,
    countPendingMediaRequestsForUser, getMediaRequestMaxQueuePosition,
    findActiveMediaRequestByCanonicalUrl, updateMediaRequest,
    renormalizePendingMediaRequestPositions,
    // Controls
    getStreamControls, createControl, bindStreamToControlConfig,
    // ONVIF Cameras
    createCameraProfile, getCameraProfile, getCameraProfilesByUser, getCameraProfilesByStream,
    updateCameraProfile, deleteCameraProfile,
    createCameraPreset, getCameraPreset, getCameraPresetsByCamera, deleteCameraPreset,
    // API Keys
    createApiKey, getApiKeyByHash,
    // Control Configs
    getControlConfigs, getControlConfig, createControlConfig, updateControlConfig, deleteControlConfig,
    getConfigButtons, createConfigButton, updateConfigButton, deleteConfigButton, applyConfigToStream,
    // Bans
    isUserBanned, isIpBanned, getIpBan, invalidateIpBanCache, forgiveBan,
    getAiChatbotConfig, upsertAiChatbotConfig,
    getChannelAiConfig, upsertChannelAiConfig,
    createChannelAiBot, getChannelAiBot, getChannelAiBots, getChannelAiBotByUsername,
    updateChannelAiBot, touchChannelAiBot, deleteChannelAiBot,
    // Site Settings
    getSetting, getSettingRow, getAllSettings, setSetting, deleteSetting,
    saveVodTranscriptProgress, getVodTranscriptProgress,
    createAiViewerThread, getOpenAiViewerThreads, getRecentClosedAiViewerThreads, touchAiViewerThread, closeAiViewerThread, closeStaleAiViewerThreads, closeAllAiViewerThreads,
    addAiViewerLog, getAiViewerLog, pruneAiViewerLog, getAiViewerLogStats,
    getState, setState, deleteState,
    // Verification Keys
    createVerificationKey, getVerificationKeyByKey, getVerificationKeyByUsername,
    getAllVerificationKeys, redeemVerificationKey, revokeVerificationKey, isUsernameReserved,
    // Channel lookup
    getChannelById,
    getUserTotalGameLevel, getLegacyGameProfile,
    // Anon IP Mappings
    getOrCreateAnonNum, getAnonFirstSeen, loadAnonMappings,
    // Approved IPs (Anti-VPN)
    isIpApproved, approveIp, revokeIpApproval, getApprovedIps,
    // IP Tracking
    logIp, getIpsByUser, getUsersByIp, getLinkedAccounts, getLinkedAccountsByAnon,
    getLatestIpForUser, getLatestIpForAnon, getIpLog, banAllAccountsOnIp,
    // Stream Analytics
    insertViewerSnapshot, getViewerSnapshots, computeAndCacheStreamAnalytics,
    getStreamAnalytics, setStreamAnalyticsClipCount, setStreamAnalyticsChatTotals, getChannelAnalyticsSummary,
    // User Preferences
    getUserPreferences, saveUserPreferences,
    // API Tokens
    createApiToken, listApiTokens, revokeApiToken, validateApiToken,
};
