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
 * SQLite3 via better-sqlite3
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || './data/live.db';
const dbDir = path.dirname(path.resolve(DB_PATH));

// Ensure data directory exists
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

let db;

function getDb() {
    if (!db) {
        db = new Database(path.resolve(DB_PATH));
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
        db.pragma('busy_timeout = 5000');
        // Perf tuning: under WAL, synchronous=NORMAL is still crash-safe (only risks the
        // last txn on a power/OS crash) and avoids an fsync on every one of the many small
        // writes (chat inserts, viewer-count updates). Bigger page cache + in-memory temp
        // tables + mmap cut disk I/O for the hot read paths.
        try {
            db.pragma('synchronous = NORMAL');
            db.pragma('cache_size = -65536');   // ~64 MB page cache
            db.pragma('temp_store = MEMORY');
            db.pragma('mmap_size = 268435456'); // 256 MB
        } catch (e) { console.warn('[DB] pragma tuning:', e.message); }
    }
    return db;
}

/**
 * Collapse duplicate rows in an AI-state table down to one row per id and put a UNIQUE
 * index on the key so `INSERT OR IGNORE` behaves as its callers assume.
 *
 * Values are merged per column rather than by keeping a single "best" row: duplicates
 * were created at different times, so the transcript may sit on one row and the overview
 * on another. Longest wins for text we accumulate; for transcript_status the most
 * settled state wins, so a stray 'pending' duplicate cannot resurrect finished work.
 */
function _dedupeKeyedTable(database, table, key) {
    try {
        const idx = `idx_${table}_${key}_unique`;
        const has = database.prepare(
            "SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(idx);
        if (has) return;                                  // already repaired
        // Column-driven, never a hardcoded list: clip_ai_state carries clip_notified /
        // clip_notify_at that vod_ai_state does not, and a fixed column list would drop
        // them on the floor during the rebuild.
        const cols = database.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
        if (!cols.includes(key)) return;
        const others = cols.filter(c => c !== key);
        const dupes = database.prepare(
            `SELECT COUNT(*) - COUNT(DISTINCT ${key}) AS extra FROM ${table}`).get();
        if (dupes && dupes.extra > 0) {
            // Merge per column, preferring the richest value: duplicates were written at
            // different times, so a transcript can sit on one row and an overview on
            // another — keeping a single "best" row wholesale would discard the other.
            const pick = (c) => {
                if (c === 'transcript_status') {
                    // Most-settled state wins, so a stray 'pending' duplicate cannot
                    // resurrect work that already finished.
                    return `(SELECT x.${c} FROM ${table} x WHERE x.${key} = k.${key} AND x.${c} IS NOT NULL
                             ORDER BY CASE x.${c} WHEN 'done' THEN 0 WHEN 'empty' THEN 1 WHEN 'failed' THEN 2
                                                  WHEN 'processing' THEN 3 WHEN 'retry' THEN 4 ELSE 5 END LIMIT 1)`;
                }
                if (c === 'transcript_next_at') {
                    return `(SELECT MIN(x.${c}) FROM ${table} x WHERE x.${key} = k.${key} AND x.${c} IS NOT NULL)`;
                }
                if (c === 'transcript_attempts') {
                    return `(SELECT MAX(COALESCE(x.${c},0)) FROM ${table} x WHERE x.${key} = k.${key})`;
                }
                // Everything else: any non-null value, longest first. For accumulated text
                // (transcripts, overviews) longest is the most complete; for flags and
                // timestamps it just means "a real value beats NULL".
                return `(SELECT x.${c} FROM ${table} x WHERE x.${key} = k.${key} AND x.${c} IS NOT NULL
                         ORDER BY LENGTH(CAST(x.${c} AS TEXT)) DESC LIMIT 1)`;
            };
            const selects = [`k.${key} AS ${key}`, ...others.map(c => `${pick(c)} AS ${c}`)].join(',\n                      ');
            database.exec('BEGIN');
            try {
                database.exec(`CREATE TEMP TABLE _merge_${table} AS
                    SELECT ${selects}
                    FROM (SELECT DISTINCT ${key} FROM ${table}) k`);
                database.exec(`DELETE FROM ${table}`);
                database.exec(`INSERT INTO ${table} (${cols.join(', ')})
                               SELECT ${cols.join(', ')} FROM _merge_${table}`);
                database.exec(`DROP TABLE _merge_${table}`);
                database.exec('COMMIT');
                console.log(`[DB] ${table}: merged ${dupes.extra} duplicate row(s) down to one per ${key}`);
            } catch (e) {
                try { database.exec('ROLLBACK'); } catch { /* */ }
                console.warn(`[DB] ${table} dedupe failed, leaving as-is:`, e.message);
                return;                                    // never index over dirty data
            }
        }
        database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${idx} ON ${table}(${key})`);
    } catch (e) {
        console.warn(`[DB] ${table} integrity repair skipped:`, e.message);
    }
}

/**
 * One memory per (stream, offset). Re-analysing a stream used to append a second
 * description of the very same moment, so a viewer's memory list read as near-duplicate
 * pairs a minute apart. Keep the longest description (the richest capture, e.g. the one
 * that also carries the "heard:" transcript clause) and let the UNIQUE index make
 * addStreamMemory's INSERT OR IGNORE actually ignore.
 */
function _dedupeStreamMemories(database) {
    try {
        const idx = 'idx_stream_memories_moment_unique';
        if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(idx)) return;
        const extra = database.prepare(`SELECT COUNT(*) - COUNT(DISTINCT stream_id || ':' || offset_seconds) AS extra
                                        FROM stream_memories`).get();
        if (extra && extra.extra > 0) {
            const res = database.prepare(`DELETE FROM stream_memories WHERE id NOT IN (
                SELECT id FROM (
                    SELECT id, ROW_NUMBER() OVER (
                        PARTITION BY stream_id, offset_seconds
                        ORDER BY LENGTH(COALESCE(description,'')) DESC,
                                 (transcript_json IS NOT NULL) DESC, id DESC) AS rn
                    FROM stream_memories) WHERE rn = 1)`).run();
            console.log(`[DB] stream_memories: removed ${res.changes} duplicate moment(s)`);
        }
        database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${idx} ON stream_memories(stream_id, offset_seconds)`);
    } catch (e) {
        console.warn('[DB] stream_memories dedupe skipped:', e.message);
    }
}

/**
 * Adopt timeline rows left behind by the one-shot vod.ready link.
 *
 * linkTimelineToVod() is a single UPDATE fired when Media says the recording is ready,
 * but transcription of spooled audio keeps running for a while afterwards. Those later
 * rows were written with vod_id NULL and nothing ever came back for them, so the VOD's
 * transcript silently stopped at whatever had been transcribed by the webhook — stream
 * 2128 ended up with 11 orphaned speech rows against 2 linked ones.
 *
 * If any row for a stream already points at a VOD, the stream's remaining rows belong to
 * that same VOD by construction: one recording per stream. New writes stamp themselves
 * (see timeline-job), so this only has to clean up the existing backlog.
 */
function _adoptOrphanedTimelineRows(database) {
    try {
        const res = database.prepare(`UPDATE stream_timeline_events AS t
            SET vod_id = (SELECT s.vod_id FROM stream_timeline_events s
                          WHERE s.stream_id = t.stream_id AND s.vod_id IS NOT NULL LIMIT 1)
            WHERE t.vod_id IS NULL
              AND EXISTS (SELECT 1 FROM stream_timeline_events s
                          WHERE s.stream_id = t.stream_id AND s.vod_id IS NOT NULL)`).run();
        if (res.changes) console.log(`[DB] stream_timeline_events: adopted ${res.changes} orphaned row(s) onto their VOD`);
    } catch (e) {
        console.warn('[DB] timeline orphan adoption skipped:', e.message);
    }
}

function initDb() {
    const database = getDb();
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    database.exec(schema);

    // ── Live-owned AI/transcript state for Media-hosted VODs/clips ─────────────
    // The vods/clips content rows moved to OpenVibe.Media, but Media does not carry
    // the AI columns — that state is Live's. Keyed by the MEDIA vod/clip id; the
    // cutover migration pre-populates these exact tables/columns from the old DB.
    database.exec(`CREATE TABLE IF NOT EXISTS vod_ai_state (
        vod_id INTEGER PRIMARY KEY,
        ai_overview_short TEXT,
        ai_transcript_json TEXT,
        transcript_status TEXT,
        transcript_attempts INTEGER DEFAULT 0,
        transcript_error TEXT,
        transcript_next_at DATETIME
    )`);
    database.exec(`CREATE TABLE IF NOT EXISTS clip_ai_state (
        clip_id INTEGER PRIMARY KEY,
        ai_overview_short TEXT,
        ai_transcript_json TEXT,
        transcript_status TEXT,
        transcript_attempts INTEGER DEFAULT 0,
        transcript_error TEXT,
        transcript_next_at DATETIME,
        clip_notified INTEGER DEFAULT 0,
        clip_notify_at DATETIME
    )`);
    // Full AI overview text. Originally only the ~150-char short was stored, which made
    // the card expander a no-op on VODs/clips: expanding revealed the same truncated
    // "…" string because the full version had been thrown away at write time. Shorts
    // are a derivation, not the source of truth — keep both.
    try {
        for (const t of ['vod_ai_state', 'clip_ai_state']) {
            const cols = database.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
            if (!cols.includes('ai_overview')) database.exec(`ALTER TABLE ${t} ADD COLUMN ai_overview TEXT`);
        }
    } catch (e) { console.warn('[DB] ai-overview column migration:', e.message); }

    // Transcript job-state recovery — on the tables that actually hold it. The older
    // recovery loop above targets the legacy local `vods`/`clips` tables, which moved to
    // OpenVibe.Media; it throws on the first PRAGMA and silently does nothing, which is
    // why rows killed mid-flight by a deploy stayed 'processing' forever and 'failed' was
    // permanent. Also adds resumable-progress columns (finished windows survive restarts).
    try {
        for (const t of ['vod_ai_state', 'clip_ai_state']) {
            const cols = database.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
            if (!cols.includes('transcript_partial_json')) database.exec(`ALTER TABLE ${t} ADD COLUMN transcript_partial_json TEXT`);
            if (!cols.includes('transcript_progress_sec')) database.exec(`ALTER TABLE ${t} ADD COLUMN transcript_progress_sec INTEGER DEFAULT 0`);
            // Mid-flight at shutdown → back to the queue (progress is kept, attempts untouched).
            const p = database.prepare(`UPDATE ${t} SET transcript_status='retry', transcript_next_at=NULL WHERE transcript_status='processing'`).run();
            // Exhausted retries get a fresh ladder after a deploy — except sources that can
            // never work (Media reported the recording itself failed / no audio stream).
            const f = database.prepare(`UPDATE ${t} SET transcript_status='retry', transcript_attempts=0, transcript_next_at=NULL
                WHERE transcript_status='failed'
                  AND COALESCE(transcript_error,'') NOT LIKE 'media reported%'
                  AND COALESCE(transcript_error,'') NOT LIKE 'no audio stream%'`).run();
            if (p.changes || f.changes) console.log(`[DB] ${t}: re-queued ${p.changes} interrupted + ${f.changes} previously-failed transcript job(s)`);
        }
    } catch (e) { console.warn('[DB] transcript recovery:', e.message); }

    // ── Migrations ────────────────────────────────────────────
    try {
        const cols = database.prepare("PRAGMA table_info('channels')").all().map(c => c.name);
        if (!cols.includes('emote_sources')) {
            database.exec(`ALTER TABLE channels ADD COLUMN emote_sources TEXT DEFAULT '{"defaults":true,"custom":true,"ffz":true,"bttv":true,"7tv":true}'`);
            console.log('[DB] Added emote_sources column to channels');
        }
    } catch (e) { console.warn('[DB] Migration note:', e.message); }

    // Migrate camp_funds_balance → openvibe_bucks_balance (REAL for dollar amounts)
    try {
        const userCols = database.prepare("PRAGMA table_info('users')").all().map(c => c.name);
        if (userCols.includes('camp_funds_balance') && !userCols.includes('openvibe_bucks_balance')) {
            database.exec(`ALTER TABLE users ADD COLUMN openvibe_bucks_balance REAL DEFAULT 0.00`);
            // Convert old bits to dollars (100 bits → $1.00)
            database.exec(`UPDATE users SET openvibe_bucks_balance = camp_funds_balance * 0.01`);
            console.log('[DB] Migrated camp_funds_balance → openvibe_bucks_balance');
        }
        if (!userCols.includes('openvibe_coins_balance')) {
            database.exec(`ALTER TABLE users ADD COLUMN openvibe_coins_balance INTEGER DEFAULT 0`);
            console.log('[DB] Added openvibe_coins_balance column to users');
        }
        // Streamer cashout balance: only Vibes RECEIVED (donated to them) land here,
        // and only this balance is cashout-able (bought bucks are not). Separate from the
        // spendable openvibe_bucks_balance.
        if (!userCols.includes('openvibe_bucks_cashout_balance')) {
            database.exec(`ALTER TABLE users ADD COLUMN openvibe_bucks_cashout_balance REAL DEFAULT 0.00`);
            console.log('[DB] Added openvibe_bucks_cashout_balance column to users');
        }
        if (!userCols.includes('token_valid_after')) {
            database.exec(`ALTER TABLE users ADD COLUMN token_valid_after TEXT DEFAULT NULL`);
            console.log('[DB] Added token_valid_after column to users');
        }
    } catch (e) { console.warn('[DB] Migration note:', e.message); }

    // Migrate: create site_settings table if missing (old DB)
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS site_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL DEFAULT '',
            description TEXT DEFAULT '',
            type TEXT DEFAULT 'string' CHECK(type IN ('string', 'number', 'boolean', 'json')),
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    } catch (e) { console.warn('[DB] site_settings migration:', e.message); }

    // Migrate: create verification_keys table if missing (old DB)
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS verification_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT UNIQUE NOT NULL,
            target_username TEXT NOT NULL,
            note TEXT DEFAULT '',
            created_by INTEGER NOT NULL,
            used_by INTEGER,
            status TEXT DEFAULT 'active' CHECK(status IN ('active', 'used', 'revoked')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            used_at DATETIME,
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (used_by) REFERENCES users(id) ON DELETE SET NULL
        )`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_vkeys_key ON verification_keys(key)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_vkeys_target ON verification_keys(target_username)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_vkeys_status ON verification_keys(status)`);
    } catch (e) { console.warn('[DB] verification_keys migration:', e.message); }

    // Migrate: create linked_accounts table for openvibe.network SSO
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS linked_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            service TEXT NOT NULL,
            service_user_id TEXT NOT NULL,
            service_username TEXT,
            linked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(service, service_user_id)
        )`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_linked_service ON linked_accounts(service, service_user_id)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_linked_user ON linked_accounts(user_id)`);
    } catch (e) { console.warn('[DB] linked_accounts migration:', e.message); }

    // Migrate: make chat_messages.stream_id nullable (was NOT NULL, broke global chat saves)
    try {
        const cmCols = database.prepare("PRAGMA table_info('chat_messages')").all();
        const streamIdCol = cmCols.find(c => c.name === 'stream_id');
        if (streamIdCol && streamIdCol.notnull === 1) {
            database.exec(`
                CREATE TABLE chat_messages_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    stream_id INTEGER,
                    user_id INTEGER,
                    anon_id TEXT,
                    username TEXT,
                    message TEXT NOT NULL,
                    message_type TEXT DEFAULT 'chat' CHECK(message_type IN ('chat', 'system', 'donation', 'command', 'tts')),
                    is_global INTEGER DEFAULT 0,
                    is_deleted INTEGER DEFAULT 0,
                    is_filtered INTEGER DEFAULT 0,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
                );
                INSERT INTO chat_messages_new SELECT * FROM chat_messages;
                DROP TABLE chat_messages;
                ALTER TABLE chat_messages_new RENAME TO chat_messages;
                CREATE INDEX IF NOT EXISTS idx_chat_stream ON chat_messages(stream_id);
                CREATE INDEX IF NOT EXISTS idx_chat_user ON chat_messages(user_id);
                CREATE INDEX IF NOT EXISTS idx_chat_timestamp ON chat_messages(timestamp);
            `);
            console.log('[DB] Migrated chat_messages.stream_id to nullable');
        }
    } catch (e) { console.warn('[DB] chat_messages migration:', e.message); }

    // Migrate: add reply_to_id column to chat_messages for threaded replies
    try {
        const cmCols2 = database.prepare("PRAGMA table_info('chat_messages')").all().map(c => c.name);
        if (!cmCols2.includes('reply_to_id')) {
            database.exec(`ALTER TABLE chat_messages ADD COLUMN reply_to_id INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL`);
            console.log('[DB] Added reply_to_id column to chat_messages');
        }
    } catch (e) { console.warn('[DB] chat_messages reply_to_id migration:', e.message); }

    // Migrate: widen the message_type CHECK so sound announces ('channel-sound',
    // 'soundboard') persist to history. SQLite can't alter a CHECK — rebuild the
    // table from its CURRENT definition (columns have grown over time).
    try {
        const tbl = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='chat_messages'").get();
        const REQUIRED_TYPES = ['channel-sound', 'soundboard', 'clip'];
        if (tbl && /message_type IN \([^)]*\)/.test(tbl.sql) && REQUIRED_TYPES.some(t => !tbl.sql.includes(`'${t}'`))) {
            const newSql = tbl.sql
                .replace(/CREATE TABLE ["']?chat_messages["']?/, 'CREATE TABLE chat_messages_new')
                .replace(/message_type IN \([^)]*\)/,
                    "message_type IN ('chat', 'system', 'donation', 'command', 'tts', 'channel-sound', 'soundboard', 'clip')");
            const cols = database.prepare("PRAGMA table_info('chat_messages')").all().map(c => `"${c.name}"`).join(', ');
            const indexes = database.prepare(
                "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='chat_messages' AND sql IS NOT NULL"
            ).all().map(r => r.sql);
            database.pragma('foreign_keys = OFF');
            try {
                database.exec('BEGIN');
                database.exec(newSql);
                database.exec(`INSERT INTO chat_messages_new (${cols}) SELECT ${cols} FROM chat_messages`);
                database.exec('DROP TABLE chat_messages');
                database.exec('ALTER TABLE chat_messages_new RENAME TO chat_messages');
                for (const sql of indexes) { try { database.exec(sql); } catch { /* index name may survive */ } }
                database.exec('COMMIT');
                console.log('[DB] Widened chat_messages.message_type CHECK for sound announces');
            } catch (e2) {
                try { database.exec('ROLLBACK'); } catch { /* no open tx */ }
                throw e2;
            } finally {
                database.pragma('foreign_keys = ON');
            }
        }
    } catch (e) { console.warn('[DB] chat_messages message_type migration:', e.message); }

    // Migrate: add default_vod_visibility / default_clip_visibility to channels
    try {
        const chanCols = database.prepare("PRAGMA table_info('channels')").all().map(c => c.name);
        if (!chanCols.includes('default_vod_visibility')) {
            database.exec(`ALTER TABLE channels ADD COLUMN default_vod_visibility TEXT DEFAULT 'public'`);
            console.log('[DB] Added default_vod_visibility column to channels');
        }
        if (!chanCols.includes('default_clip_visibility')) {
            database.exec(`ALTER TABLE channels ADD COLUMN default_clip_visibility TEXT DEFAULT 'public'`);
            console.log('[DB] Added default_clip_visibility column to channels');
        }
    } catch (e) { console.warn('[DB] Channel visibility migration:', e.message); }

    // Migrate: add weather_zip / weather_detail to channels
    try {
        const wCols = database.prepare("PRAGMA table_info('channels')").all().map(c => c.name);
        if (!wCols.includes('weather_zip')) {
            database.exec(`ALTER TABLE channels ADD COLUMN weather_zip TEXT DEFAULT NULL`);
            console.log('[DB] Added weather_zip column to channels');
        }
        if (!wCols.includes('weather_detail')) {
            database.exec(`ALTER TABLE channels ADD COLUMN weather_detail TEXT DEFAULT 'basic'`);
            console.log('[DB] Added weather_detail column to channels');
        }
        if (!wCols.includes('weather_show_location')) {
            database.exec(`ALTER TABLE channels ADD COLUMN weather_show_location INTEGER DEFAULT 0`);
            console.log('[DB] Added weather_show_location column to channels');
        }
    } catch (e) { console.warn('[DB] Channel weather migration:', e.message); }

    // Per-streamer Channel Points customization.
    try {
        const cpCols = database.prepare("PRAGMA table_info('channels')").all().map(c => c.name);
        const add = (name, ddl) => { if (!cpCols.includes(name)) { database.exec(`ALTER TABLE channels ADD COLUMN ${ddl}`); console.log(`[DB] Added ${name} to channels`); } };
        add('cp_name', "cp_name TEXT DEFAULT 'Channel Points'");
        add('cp_icon', "cp_icon TEXT DEFAULT 'fa-coins'");
        add('cp_watch_interval_min', 'cp_watch_interval_min INTEGER DEFAULT 5');
        add('cp_watch_amount', 'cp_watch_amount INTEGER DEFAULT 10');
        add('cp_game_interval_min', 'cp_game_interval_min INTEGER DEFAULT 0');
        // Clip settings: by default only the streamer/mods/staff can delete clips of the
        // channel; the streamer can opt to let clip creators delete their own clips.
        add('clips_allow_creator_delete', 'clips_allow_creator_delete INTEGER DEFAULT 0');
        // Streamer can hide the AI-generated overview from the top of their About tab.
        add('hide_ai_overview', 'hide_ai_overview INTEGER DEFAULT 0');
        // Tri-state preference for the About-tab AI overview: 'auto' (show only when there's no
        // bio/about yet), 'show' (always), 'hide' (never). Migrate old hide flag → 'hide'.
        add('ai_overview_pref', "ai_overview_pref TEXT DEFAULT 'auto'");
        try { database.exec("UPDATE channels SET ai_overview_pref = 'hide' WHERE hide_ai_overview = 1 AND (ai_overview_pref IS NULL OR ai_overview_pref = 'auto')"); } catch { /* */ }
    } catch (e) { console.warn('[DB] Channel points config migration:', e.message); }

    // Migrate: add VOD health and recording metadata columns
    try {
        const vodCols = database.prepare("PRAGMA table_info('vods')").all().map(c => c.name);
        if (!vodCols.includes('thumbnail_url')) {
            database.exec('ALTER TABLE vods ADD COLUMN thumbnail_url TEXT');
            console.log('[DB] Added thumbnail_url column to vods');
        }
        if (!vodCols.includes('master_file_path')) {
            database.exec('ALTER TABLE vods ADD COLUMN master_file_path TEXT');
            console.log('[DB] Added master_file_path column to vods');
        }
        if (!vodCols.includes('probe_duration_seconds')) {
            database.exec('ALTER TABLE vods ADD COLUMN probe_duration_seconds REAL DEFAULT 0');
            console.log('[DB] Added probe_duration_seconds column to vods');
        }
        if (!vodCols.includes('probe_format_json')) {
            database.exec("ALTER TABLE vods ADD COLUMN probe_format_json TEXT DEFAULT ''");
            console.log('[DB] Added probe_format_json column to vods');
        }
        if (!vodCols.includes('health_status')) {
            database.exec("ALTER TABLE vods ADD COLUMN health_status TEXT DEFAULT 'unknown'");
            console.log('[DB] Added health_status column to vods');
        }
        if (!vodCols.includes('health_score')) {
            database.exec('ALTER TABLE vods ADD COLUMN health_score INTEGER DEFAULT 0');
            console.log('[DB] Added health_score column to vods');
        }
        if (!vodCols.includes('health_issues_json')) {
            database.exec("ALTER TABLE vods ADD COLUMN health_issues_json TEXT DEFAULT '[]'");
            console.log('[DB] Added health_issues_json column to vods');
        }
        if (!vodCols.includes('last_health_scan_at')) {
            database.exec('ALTER TABLE vods ADD COLUMN last_health_scan_at DATETIME');
            console.log('[DB] Added last_health_scan_at column to vods');
        }
        if (!vodCols.includes('quarantined_at')) {
            database.exec('ALTER TABLE vods ADD COLUMN quarantined_at DATETIME');
            console.log('[DB] Added quarantined_at column to vods');
        }
        if (!vodCols.includes('clips_only')) {
            // Ephemeral recording made ONLY to serve the clip system on a slot that has VOD
            // recording disabled but clipping enabled. Never published as a browsable VOD;
            // deleted when the stream ends. Kept short/rolling to bound disk (see recorder).
            database.exec('ALTER TABLE vods ADD COLUMN clips_only INTEGER DEFAULT 0');
            console.log('[DB] Added clips_only column to vods');
        }
        if (!vodCols.includes('is_recording')) {
            database.exec('ALTER TABLE vods ADD COLUMN is_recording INTEGER DEFAULT 0');
            console.log('[DB] Added is_recording column to vods');
        }
    } catch (e) { console.warn('[DB] VOD metadata migration:', e.message); }

    // Migrate: create RobotStreamer integration table if missing
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS robotstreamer_integrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL UNIQUE,
            enabled INTEGER DEFAULT 0,
            mirror_chat INTEGER DEFAULT 1,
            token TEXT,
            robot_id TEXT,
            owner_id TEXT,
            chat_url TEXT,
            control_url TEXT,
            rtc_sfu_url TEXT,
            stream_name TEXT,
            owner_name TEXT,
            last_validated_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);
    } catch (e) { console.warn('[DB] RobotStreamer integration migration:', e.message); }

    // Migrate: native object-storage columns for the VOD storage engine
    // (storage_provider: local|b2|r2, storage_key: object key in the bucket)
    try {
        const vodCols = database.prepare('PRAGMA table_info(vods)').all().map(c => c.name);
        if (!vodCols.includes('storage_provider')) {
            database.exec("ALTER TABLE vods ADD COLUMN storage_provider TEXT DEFAULT 'local'");
            console.log('[DB] Added storage_provider column to vods');
        }
        if (!vodCols.includes('storage_key')) {
            database.exec('ALTER TABLE vods ADD COLUMN storage_key TEXT');
            console.log('[DB] Added storage_key column to vods');
        }
        // Clips use the same local/B2/R2 tiering as VODs.
        const clipCols = database.prepare('PRAGMA table_info(clips)').all().map(c => c.name);
        if (!clipCols.includes('storage_provider')) {
            database.exec("ALTER TABLE clips ADD COLUMN storage_provider TEXT DEFAULT 'local'");
            console.log('[DB] Added storage_provider column to clips');
        }
        if (!clipCols.includes('storage_key')) {
            database.exec('ALTER TABLE clips ADD COLUMN storage_key TEXT');
            console.log('[DB] Added storage_key column to clips');
        }
    } catch (e) { console.warn('[DB] VOD storage engine migration:', e.message); }

    // Migrate: per-slot RobotStreamer integrations — drop the UNIQUE(user_id)
    // constraint (requires a table rebuild in SQLite) and add managed_stream_id
    // so each stream slot can carry its own token + robot.
    try {
        const rsCols = database.prepare('PRAGMA table_info(robotstreamer_integrations)').all().map(c => c.name);
        if (!rsCols.includes('managed_stream_id')) {
            database.exec(`
                CREATE TABLE robotstreamer_integrations_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    managed_stream_id INTEGER,
                    enabled INTEGER DEFAULT 0,
                    mirror_chat INTEGER DEFAULT 1,
                    token TEXT,
                    robot_id TEXT,
                    owner_id TEXT,
                    chat_url TEXT,
                    control_url TEXT,
                    rtc_sfu_url TEXT,
                    stream_name TEXT,
                    owner_name TEXT,
                    last_validated_at DATETIME,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (managed_stream_id) REFERENCES managed_streams(id) ON DELETE CASCADE
                );
                INSERT INTO robotstreamer_integrations_new
                    (id, user_id, enabled, mirror_chat, token, robot_id, owner_id, chat_url, control_url, rtc_sfu_url, stream_name, owner_name, last_validated_at, created_at, updated_at)
                SELECT id, user_id, enabled, mirror_chat, token, robot_id, owner_id, chat_url, control_url, rtc_sfu_url, stream_name, owner_name, last_validated_at, created_at, updated_at
                FROM robotstreamer_integrations;
                DROP TABLE robotstreamer_integrations;
                ALTER TABLE robotstreamer_integrations_new RENAME TO robotstreamer_integrations;
                CREATE UNIQUE INDEX IF NOT EXISTS idx_rs_integrations_user_slot
                    ON robotstreamer_integrations(user_id, IFNULL(managed_stream_id, 0));
            `);
            console.log('[DB] Migrated robotstreamer_integrations to per-slot schema');
        }
    } catch (e) { console.warn('[DB] RobotStreamer per-slot migration:', e.message); }

    // Migrate: create restream_destinations table if missing
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS restream_destinations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            platform TEXT NOT NULL CHECK(platform IN ('youtube', 'twitch', 'kick', 'custom')),
            name TEXT,
            server_url TEXT,
            stream_key TEXT,
            enabled INTEGER DEFAULT 1,
            auto_start INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);
    } catch (e) { console.warn('[DB] Restream destinations migration:', e.message); }

    // Per-user OAuth connections to external streaming platforms (Twitch/YouTube/Kick).
    // Powers the "Connect" buttons that auto-fill ingest URL + stream key per slot.
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS platform_connections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            platform TEXT NOT NULL CHECK(platform IN ('youtube', 'twitch', 'kick')),
            platform_user_id TEXT,
            platform_username TEXT,
            channel_url TEXT,
            access_token TEXT,
            refresh_token TEXT,
            token_expires_at INTEGER,
            scope TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, platform),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);
    } catch (e) { console.warn('[DB] platform_connections migration:', e.message); }

    // PowerChat integration: per-streamer OAuth grant (one grant per streamer) + a
    // dedupe log for at-least-once webhook deliveries. Tokens stored plaintext like
    // platform_connections; refresh tokens ROTATE on every use (never reuse an old one).
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS powerchat_connections (
            user_id INTEGER PRIMARY KEY,
            powerchat_username TEXT,
            powerchat_user_id TEXT,
            access_token TEXT,
            refresh_token TEXT,
            token_expires_at INTEGER,          -- epoch ms
            scope TEXT,
            tip_page_url TEXT,
            last_error TEXT,
            connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_powerchat_conn_username ON powerchat_connections(powerchat_username)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_powerchat_conn_pcuid ON powerchat_connections(powerchat_user_id)`);
        // Webhook delivery dedupe (X-PowerChat-Delivery-Id is at-least-once).
        database.exec(`CREATE TABLE IF NOT EXISTS powerchat_webhook_deliveries (
            delivery_id TEXT PRIMARY KEY,
            event_type TEXT,
            received_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    } catch (e) { console.warn('[DB] powerchat migration:', e.message); }

    // Per-streamer channel points ("OpenCoins"). A viewer holds a separate
    // OpenCoins balance for each streamer they watch (Twitch-channel-points style),
    // spent only on that streamer's rewards. The global users.openvibe_coins_balance
    // is now a decoupled "gold" wallet for OpenVibeGame / cosmetics / media requests.
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS channel_points (
            user_id INTEGER NOT NULL,
            streamer_id INTEGER NOT NULL,
            balance INTEGER NOT NULL DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, streamer_id)
        )`);
    } catch (e) { console.warn('[DB] channel_points migration:', e.message); }

    // Kick chatroom-id cache. Kick's v2 API (which exposes the Pusher chatroom id)
    // is Cloudflare-blocked from datacenter IPs, so resolution fails intermittently.
    // Once we resolve a channel's ids we persist them here and reuse forever — the
    // chatroom id is stable per channel, so the relay survives the API being blocked.
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS kick_channel_cache (
            slug TEXT PRIMARY KEY,
            chatroom_id INTEGER,
            kick_channel_id INTEGER,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    } catch (e) { console.warn('[DB] kick_channel_cache migration:', e.message); }

    // Migrate: link a restream destination to the OAuth connection that provisioned it
    try {
        const cols = database.pragma('table_info(restream_destinations)').map(c => c.name);
        if (!cols.includes('connection_id')) {
            database.exec(`ALTER TABLE restream_destinations ADD COLUMN connection_id INTEGER DEFAULT NULL REFERENCES platform_connections(id) ON DELETE SET NULL`);
            console.log('[DB] Added connection_id column to restream_destinations');
        }
    } catch (e) { console.warn('[DB] Restream connection_id migration:', e.message); }

    // Migrate: add quality_preset column to restream_destinations
    try {
        const cols = database.pragma('table_info(restream_destinations)').map(c => c.name);
        if (!cols.includes('quality_preset')) {
            database.exec(`ALTER TABLE restream_destinations ADD COLUMN quality_preset TEXT DEFAULT 'auto'`);
            console.log('[DB] Added quality_preset column to restream_destinations');
        }
    } catch (e) { console.warn('[DB] Restream quality_preset migration:', e.message); }

    // Migrate: add custom encoding override columns to restream_destinations
    try {
        const cols = database.pragma('table_info(restream_destinations)').map(c => c.name);
        const newCols = [
            { name: 'custom_video_bitrate', def: 'INTEGER DEFAULT NULL' },
            { name: 'custom_audio_bitrate', def: 'INTEGER DEFAULT NULL' },
            { name: 'custom_fps', def: 'INTEGER DEFAULT NULL' },
            { name: 'custom_encoder_preset', def: 'TEXT DEFAULT NULL' },
        ];
        for (const col of newCols) {
            if (!cols.includes(col.name)) {
                database.exec(`ALTER TABLE restream_destinations ADD COLUMN ${col.name} ${col.def}`);
                console.log(`[DB] Added ${col.name} column to restream_destinations`);
            }
        }
    } catch (e) { console.warn('[DB] Restream custom overrides migration:', e.message); }

    // Migrate: add channel_url and chat_relay columns to restream_destinations
    try {
        const cols = database.pragma('table_info(restream_destinations)').map(c => c.name);
        const newCols = [
            { name: 'channel_url', def: 'TEXT DEFAULT NULL' },
            { name: 'chat_relay', def: 'INTEGER DEFAULT 0' },
            // Per-destination: forward this platform's relayed chat to the streamer's
            // PowerChat overlay (default on; only meaningful with chat_relay).
            { name: 'powerchat_relay', def: 'INTEGER DEFAULT 1' },
            // Per-destination: include this platform's viewers in the total viewer count
            // pushed to PowerChat (default on).
            { name: 'powerchat_count_views', def: 'INTEGER DEFAULT 1' },
            // Circuit breaker: persist repeated go-live failures so a broken destination
            // (e.g. a YouTube strike) isn't hammered every time the streamer goes live.
            { name: 'consecutive_failures', def: 'INTEGER DEFAULT 0' },
            { name: 'cooldown_until', def: 'DATETIME DEFAULT NULL' },
            { name: 'last_error', def: 'TEXT DEFAULT NULL' },
            { name: 'last_failed_at', def: 'DATETIME DEFAULT NULL' },
        ];
        for (const col of newCols) {
            if (!cols.includes(col.name)) {
                database.exec(`ALTER TABLE restream_destinations ADD COLUMN ${col.name} ${col.def}`);
                console.log(`[DB] Added ${col.name} column to restream_destinations`);
            }
        }
    } catch (e) { console.warn('[DB] Restream channel_url/chat_relay migration:', e.message); }

    // Migrate: create comments table if missing
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content_type TEXT NOT NULL CHECK(content_type IN ('vod', 'clip')),
            content_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            parent_id INTEGER,
            message TEXT NOT NULL,
            is_deleted INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (parent_id) REFERENCES comments(id) ON DELETE CASCADE
        )`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_comments_content ON comments(content_type, content_id)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_comments_user ON comments(user_id)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id)`);
    } catch (e) { console.warn('[DB] Comments migration:', e.message); }

    // Migrate: create media request tables if missing
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS media_request_settings (
            user_id INTEGER PRIMARY KEY,
            enabled INTEGER DEFAULT 1,
            request_cost INTEGER DEFAULT 25,
            max_per_user INTEGER DEFAULT 3,
            max_duration_seconds INTEGER DEFAULT 600,
            allow_youtube INTEGER DEFAULT 1,
            allow_vimeo INTEGER DEFAULT 1,
            allow_direct_media INTEGER DEFAULT 1,
            auto_advance INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);
        database.exec(`CREATE TABLE IF NOT EXISTS media_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            streamer_id INTEGER NOT NULL,
            stream_id INTEGER,
            user_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            input TEXT NOT NULL,
            canonical_url TEXT NOT NULL,
            embed_url TEXT,
            provider TEXT NOT NULL CHECK(provider IN ('youtube', 'vimeo', 'audio', 'video')),
            title TEXT NOT NULL,
            thumbnail_url TEXT,
            duration_seconds INTEGER,
            cost INTEGER NOT NULL DEFAULT 25,
            queue_position INTEGER DEFAULT 0,
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'playing', 'played', 'skipped', 'removed', 'failed')),
            requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            started_at DATETIME,
            ended_at DATETIME,
            last_error TEXT,
            FOREIGN KEY (streamer_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE SET NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);
        database.exec('CREATE INDEX IF NOT EXISTS idx_media_requests_streamer_status ON media_requests(streamer_id, status, queue_position, requested_at)');
        database.exec('CREATE INDEX IF NOT EXISTS idx_media_requests_user_status ON media_requests(user_id, status, requested_at)');
        database.exec('CREATE INDEX IF NOT EXISTS idx_media_requests_canonical ON media_requests(streamer_id, canonical_url, status)');
    } catch (e) { console.warn('[DB] media requests migration:', e.message); }

    // Migrate: add new media columns for server-side downloading + pricing + playback state
    try {
        const mrCols = database.pragma('table_info(media_requests)').map(c => c.name);
        if (!mrCols.includes('stream_url'))             database.exec('ALTER TABLE media_requests ADD COLUMN stream_url TEXT');
        if (!mrCols.includes('download_status'))        database.exec("ALTER TABLE media_requests ADD COLUMN download_status TEXT DEFAULT 'none' CHECK(download_status IN ('none','extracting','downloading','ready','failed'))");
        if (!mrCols.includes('file_path'))              database.exec('ALTER TABLE media_requests ADD COLUMN file_path TEXT');
        if (!mrCols.includes('playback_position'))      database.exec('ALTER TABLE media_requests ADD COLUMN playback_position REAL DEFAULT 0');
        if (!mrCols.includes('refunded'))               database.exec('ALTER TABLE media_requests ADD COLUMN refunded INTEGER DEFAULT 0');
        // The currency this request was actually charged in, captured at request time. A
        // refund has to give back what was taken, so it cannot read the channel's current
        // setting — a streamer switching from Vibes to points would otherwise refund the
        // wrong currency to everyone still queued.
        if (!mrCols.includes('currency'))               database.exec("ALTER TABLE media_requests ADD COLUMN currency TEXT DEFAULT 'opencoins'");

        const msCols = database.pragma('table_info(media_request_settings)').map(c => c.name);
        if (!msCols.includes('cost_mode'))              database.exec("ALTER TABLE media_request_settings ADD COLUMN cost_mode TEXT DEFAULT 'flat' CHECK(cost_mode IN ('flat','per_minute'))");
        if (!msCols.includes('cost_per_minute'))        database.exec('ALTER TABLE media_request_settings ADD COLUMN cost_per_minute INTEGER DEFAULT 5');
        if (!msCols.includes('allow_live'))             database.exec('ALTER TABLE media_request_settings ADD COLUMN allow_live INTEGER DEFAULT 0');
        if (!msCols.includes('download_mode'))          database.exec("ALTER TABLE media_request_settings ADD COLUMN download_mode TEXT DEFAULT 'stream' CHECK(download_mode IN ('stream','download'))");
        if (!msCols.includes('currency'))               database.exec("ALTER TABLE media_request_settings ADD COLUMN currency TEXT DEFAULT 'opencoins' CHECK(currency IN ('free','vibes','opencoins','points'))");
    } catch (e) { console.warn('[DB] media columns migration:', e.message); }

    // Migrate: create anon IP mapping table for persistent anon numbering
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS anon_ip_mappings (
            ip TEXT PRIMARY KEY,
            anon_num INTEGER NOT NULL UNIQUE
        )`);
        // created_at = when this anon number was first assigned ("first seen"). SQLite
        // can't ADD COLUMN with a CURRENT_TIMESTAMP default, so add it nullable and set it
        // explicitly on insert; existing rows stay NULL and fall back to their first chat.
        const aCols = database.prepare("PRAGMA table_info(anon_ip_mappings)").all().map(c => c.name);
        if (!aCols.includes('created_at')) database.exec('ALTER TABLE anon_ip_mappings ADD COLUMN created_at DATETIME');
    } catch (e) { console.warn('[DB] anon_ip_mappings migration:', e.message); }

    // Seed default site settings if empty
    try {
        const settingsCount = database.prepare("SELECT COUNT(*) as c FROM site_settings").get().c;
        if (settingsCount === 0) {
            const defaults = [
                ['max_video_bitrate', '6000', 'Maximum video bitrate for streamers (kbps)', 'number'],
                ['max_audio_bitrate', '320', 'Maximum audio bitrate for streamers (kbps)', 'number'],
                ['max_vod_size_mb', '5120', 'Maximum VOD file size in MB', 'number'],
                ['max_clip_duration', '60', 'Maximum clip duration in seconds', 'number'],
                ['registration_open', 'true', 'Whether new user registration is open', 'boolean'],
                ['require_email', 'false', 'Require email for registration', 'boolean'],
                ['site_name', 'OpenVibe.Live', 'Public site name', 'string'],
                ['site_description', 'Live streaming for camp culture', 'Site description / tagline', 'string'],
                ['motd', '', 'Message of the day shown on homepage', 'string'],
                ['min_cashout_amount', '500', 'Minimum Vibes for cashout', 'number'],
                ['coins_per_minute', '10', 'OpenCoins earned per minute watching', 'number'],
                ['chat_slowmode_seconds', '0', 'Global chat slow mode (0=off)', 'number'],
                ['max_emotes_per_user', '25', 'Max custom emotes per user', 'number'],
                ['nsfw_enabled', 'true', 'Allow NSFW streams', 'boolean'],
                // TTS settings
                ['tts_enabled', 'true', 'Enable site-wide TTS system', 'boolean'],
                ['tts_provider', 'espeak-ng', 'Default TTS provider (espeak-ng, google-cloud, amazon-polly)', 'string'],
                ['tts_google_api_key', '', 'Google Cloud TTS API key', 'string'],
                ['tts_google_service_account', '', 'Google Cloud service account JSON (paste full JSON or file path)', 'string'],
                ['tts_aws_access_key_id', '', 'Amazon Polly AWS Access Key ID', 'string'],
                ['tts_aws_secret_access_key', '', 'Amazon Polly AWS Secret Access Key', 'string'],
                ['tts_aws_region', 'us-east-1', 'Amazon Polly AWS Region', 'string'],
                ['tts_max_length', '200', 'Maximum TTS message length (characters)', 'number'],
                ['tts_max_queue_per_user', '3', 'Maximum queued TTS messages per user', 'number'],
                ['tts_max_queue_global', '20', 'Maximum global TTS queue size', 'number'],
                ['tts_default_voice', 'gary', 'Default TTS voice ID', 'string'],
                ['gif_tenor_api_key', '', 'Tenor API key for chat GIF picker', 'string'],
                ['gif_giphy_api_key', '', 'Giphy API key for chat GIF picker', 'string'],
                ['soundboard_101_api_key', '', '101soundboards API key for chat soundboard fetches', 'string'],
            ];
            const insert = database.prepare("INSERT OR IGNORE INTO site_settings (key, value, description, type) VALUES (?, ?, ?, ?)");
            for (const [k, v, d, t] of defaults) insert.run(k, v, d, t);
            console.log('[DB] Default site settings seeded');
        }
        // Always seed any NEW TTS settings that may be missing (for existing databases)
        const ttsSeeds = [
            ['tts_enabled', 'true', 'Enable site-wide TTS system', 'boolean'],
            ['tts_provider', 'espeak-ng', 'Default TTS provider (espeak-ng, google-cloud, amazon-polly)', 'string'],
            ['tts_google_api_key', '', 'Google Cloud TTS API key', 'string'],
            ['tts_google_service_account', '', 'Google Cloud service account JSON (paste full JSON or file path)', 'string'],
            ['tts_aws_access_key_id', '', 'Amazon Polly AWS Access Key ID', 'string'],
            ['tts_aws_secret_access_key', '', 'Amazon Polly AWS Secret Access Key', 'string'],
            ['tts_aws_region', 'us-east-1', 'Amazon Polly AWS Region', 'string'],
            ['tts_max_length', '200', 'Maximum TTS message length (characters)', 'number'],
            ['tts_max_queue_per_user', '3', 'Maximum queued TTS messages per user', 'number'],
            ['tts_max_queue_global', '20', 'Maximum global TTS queue size', 'number'],
            ['tts_default_voice', 'gary', 'Default TTS voice ID', 'string'],
            ['gif_tenor_api_key', '', 'Tenor API key for chat GIF picker', 'string'],
            ['gif_giphy_api_key', '', 'Giphy API key for chat GIF picker', 'string'],
            ['soundboard_101_api_key', '', '101soundboards API key for chat soundboard fetches', 'string'],
        ];
        const seedInsert = database.prepare("INSERT OR IGNORE INTO site_settings (key, value, description, type) VALUES (?, ?, ?, ?)");
        for (const [k, v, d, t] of ttsSeeds) seedInsert.run(k, v, d, t);

        // Seed Twitch API settings (for Helix viewer count polling)
        const twitchSeeds = [
            ['twitch_client_id', '', 'Twitch API Client ID (from dev.twitch.tv, used for viewer counts)', 'string'],
            ['twitch_client_secret', '', 'Twitch API Client Secret (from dev.twitch.tv)', 'string'],
        ];
        const seedTwitch = database.prepare("INSERT OR IGNORE INTO site_settings (key, value, description, type) VALUES (?, ?, ?, ?)");
        for (const [k, v, d, t] of twitchSeeds) seedTwitch.run(k, v, d, t);

        // Seed Kick API settings (official Kick Developer API — https://docs.kick.com)
        const kickSeeds = [
            ['kick_client_id', '', 'Kick API Client ID (from kick.com/settings/developer, used for viewer counts)', 'string'],
            ['kick_client_secret', '', 'Kick API Client Secret (from kick.com/settings/developer)', 'string'],
        ];
        const seedKick = database.prepare("INSERT OR IGNORE INTO site_settings (key, value, description, type) VALUES (?, ?, ?, ?)");
        for (const [k, v, d, t] of kickSeeds) seedKick.run(k, v, d, t);

        // Seed Google/YouTube OAuth settings (Google Cloud OAuth client — used for
        // the "Connect YouTube" flow that auto-fetches the RTMP ingest + stream key)
        const googleSeeds = [
            ['google_client_id', '', 'Google OAuth Client ID (Google Cloud Console, for YouTube Connect)', 'string'],
            ['google_client_secret', '', 'Google OAuth Client Secret (Google Cloud Console)', 'string'],
        ];
        const seedGoogle = database.prepare("INSERT OR IGNORE INTO site_settings (key, value, description, type) VALUES (?, ?, ?, ?)");
        for (const [k, v, d, t] of googleSeeds) seedGoogle.run(k, v, d, t);

        // Seed payment-provider + monetization settings (configured in openvibe.network/admin → Payments).
        // Master switch is OFF by default so nothing goes live until an admin enables it.
        const paymentSeeds = [
            ['payments_enabled', 'false', 'Master switch: enable real-money purchases & subscriptions', 'boolean'],
            ['bucks_per_usd', '100', 'Vibes value per 1 USD (100 Bucks = $1.00 cashout). Purchase price adds a margin, see the buy tiers.', 'number'],
            ['bucks_min_purchase_bucks', '100', 'Minimum Vibes purchase (bucks)', 'number'],
            ['sub_price_usd', '4.99', 'Monthly channel subscription price in USD', 'number'],
            ['sub_streamer_share_pct', '70', 'Percent of a subscription that goes to the streamer (as Vibes)', 'number'],
            // PayPal (REST)
            ['paypal_enabled', 'false', 'Enable PayPal', 'boolean'],
            ['paypal_mode', 'sandbox', 'PayPal mode: sandbox | live', 'string'],
            ['paypal_client_id', '', 'PayPal REST client ID', 'string'],
            ['paypal_client_secret', '', 'PayPal REST client secret', 'string'],
            ['paypal_webhook_id', '', 'PayPal webhook ID (for signature verification)', 'string'],
            // Stripe
            ['stripe_enabled', 'false', 'Enable Stripe', 'boolean'],
            ['stripe_secret_key', '', 'Stripe secret key (sk_live_… / sk_test_…)', 'string'],
            ['stripe_publishable_key', '', 'Stripe publishable key (pk_…)', 'string'],
            ['stripe_webhook_secret', '', 'Stripe webhook signing secret (whsec_…)', 'string'],
            // CCBill (FlexForms)
            ['ccbill_enabled', 'false', 'Enable CCBill', 'boolean'],
            ['ccbill_client_account', '', 'CCBill client account number', 'string'],
            ['ccbill_subaccount', '', 'CCBill subaccount', 'string'],
            ['ccbill_flexform_id', '', 'CCBill FlexForms form ID', 'string'],
            ['ccbill_salt', '', 'CCBill FlexForms encryption/salt key', 'string'],
            ['ccbill_webhook_secret', '', 'CCBill webhook shared secret (query token we require)', 'string'],
            // Crypto (NOWPayments hosted)
            ['crypto_enabled', 'false', 'Enable crypto payments', 'boolean'],
            ['crypto_provider', 'nowpayments', 'Crypto provider (nowpayments)', 'string'],
            ['crypto_api_key', '', 'Crypto provider API key', 'string'],
            ['crypto_ipn_secret', '', 'Crypto provider IPN/webhook secret', 'string'],
        ];
        const seedPay = database.prepare("INSERT OR IGNORE INTO site_settings (key, value, description, type) VALUES (?, ?, ?, ?)");
        for (const [k, v, d, t] of paymentSeeds) seedPay.run(k, v, d, t);

        // ── One-time migration: decimal-dollar Vibes → bit-style (×100) ──────────
        // Old model: 1 buck = $1 (stored as decimal dollars). New model: integer bucks,
        // 100 bucks = $1. So existing balances / goals / ledger amounts multiply by 100,
        // and the value rate flips from 1 to 100. Guarded so it runs exactly once.
        try {
            const done = database.prepare("SELECT value FROM site_settings WHERE key = 'bucks_bits_migration_done'").get();
            if (!done) {
                database.exec(`
                    UPDATE users SET
                        openvibe_bucks_balance = ROUND(COALESCE(openvibe_bucks_balance,0) * 100),
                        openvibe_bucks_cashout_balance = ROUND(COALESCE(openvibe_bucks_cashout_balance,0) * 100);
                    UPDATE donation_goals SET
                        target_amount = ROUND(COALESCE(target_amount,0) * 100),
                        current_amount = ROUND(COALESCE(current_amount,0) * 100);
                    UPDATE transactions SET amount = ROUND(COALESCE(amount,0) * 100);
                `);
                // Flip the value rate (used for sub-share + external-tip conversion) 1 → 100.
                database.prepare("UPDATE site_settings SET value = '100' WHERE key = 'bucks_per_usd'").run();
                database.prepare("INSERT OR REPLACE INTO site_settings (key, value, description, type) VALUES ('bucks_bits_migration_done', '1', 'Internal: decimal→bit Vibes migration applied', 'boolean')").run();
                console.log('[DB] Migrated Vibes decimal-dollars → bit-style (×100)');
            }
        } catch (e) { console.warn('[DB] Vibes bit migration:', e.message); }

        // AI analysis subsystem (configured in openvibe.network/admin → AI). Master switch
        // OFF by default so no API calls (or cost) happen until an admin enables it.
        const aiSeeds = [
            ['ai_enabled', 'false', 'Master switch: enable AI analysis (pastes + stream memories)', 'boolean'],
            ['ai_provider', 'anthropic', 'AI provider: anthropic | openai', 'string'],
            ['ai_api_key', '', 'AI API key (Anthropic or OpenAI-compatible)', 'string'],
            ['ai_base_url', '', 'Optional custom base URL (OpenAI-compatible gateway). Blank = provider default', 'string'],
            ['ai_model', 'claude-sonnet-5', 'Vision-capable model id (e.g. claude-sonnet-5)', 'string'],
            ['ai_paste_analysis_enabled', 'true', 'Analyze image + text pastes (when AI is enabled)', 'boolean'],
            ['ai_stream_memory_enabled', 'false', 'Periodically analyze live-stream thumbnails into timestamped memories', 'boolean'],
            ['ai_stream_capture_interval_sec', '120', 'Seconds between live-stream AI memory captures', 'number'],
            ['ai_transcription_enabled', 'true', 'Transcribe live-stream/clip/VOD audio into memories — FREE, runs locally via whisper.cpp (no API/cost). Requires whisper.cpp installed on the server', 'boolean'],
            ['ai_timeline_enabled', 'false', 'CONTINUOUS audio timeline — transcribes the WHOLE live stream (not a 12s sample every 2min) and detects non-speech sounds, into a searchable timestamped timeline. FREE/local, but uses noticeably more CPU than sampling', 'boolean'],
            ['ai_max_cost_usd_per_day', '0', 'Daily AI spend cap in USD (0 = no cap)', 'number'],
            ['ai_input_cost_per_mtok', '3.0', 'Estimated input cost per million tokens (for cost breakdown)', 'number'],
            ['ai_output_cost_per_mtok', '15.0', 'Estimated output cost per million tokens (for cost breakdown)', 'number'],
        ];
        const seedAi = database.prepare("INSERT OR IGNORE INTO site_settings (key, value, description, type) VALUES (?, ?, ?, ?)");
        for (const [k, v, d, t] of aiSeeds) seedAi.run(k, v, d, t);

        // PowerChat monetization (donations/tips). App-level OAuth client + webhook secret
        // are configured here by the owner; each streamer then connects their own PowerChat
        // account from their dashboard. client_id/secret + webhook_secret are auto-treated as
        // secrets (owner-only) by the sensitive-key rules. OFF by default.
        const powerchatSeeds = [
            ['powerchat_enabled', 'false', 'Master switch: enable PowerChat donation/tip integration', 'boolean'],
            ['powerchat_base_url', 'https://powerchatlive.dev', 'PowerChat base URL', 'string'],
            ['powerchat_client_id', '', 'PowerChat OAuth client_id (pca_…) from the PowerChat Developer dashboard', 'string'],
            ['powerchat_client_secret', '', 'PowerChat OAuth client_secret (pcs_…) — shown once; owner-only', 'string'],
            ['powerchat_webhook_secret', '', 'PowerChat webhook signing secret (pcw_…) — shown once; owner-only', 'string'],
            // The scope list MUST include the platform scopes (chat:write, viewcount:write,
            // subscriptions:write, follows:write, currency:write, tips:write) — PowerChat
            // grants exactly what /oauth/authorize REQUESTS, so a narrow list here means
            // every platform push (viewer count, chat, …) 403s even though the app
            // registration has the scopes.
            ['powerchat_scopes', 'profile:read webhooks:events checkout:attribute paid_messages:read alerts:trigger chat:write viewcount:write subscriptions:write follows:write currency:write tips:write', 'OAuth scopes requested from each streamer (space-delimited)', 'string'],
            ['powerchat_sandbox_username', 'alex', 'Sandbox streamer username the app can act on until approved (the app owner’s PowerChat username)', 'string'],
            // Site-wide tips account: the PowerChat USERNAME whose tip page hosts all
            // Vibes purchases and the donation fallback for streamers without their own
            // PowerChat. Just a typed username (the checkout link is a canonical URL) —
            // the app credentials above handle attribution, and that PowerChat account
            // must have the app connected on PowerChat's side so webhooks fire for it.
            ['powerchat_site_tip_username', '', 'PowerChat username whose tip page receives site purchases + fallback donations (that account must have the app connected on PowerChat)', 'string'],
            // isTest deliveries = NO money moved. OFF in production; ON only for
            // dev/sandbox where PowerChat has no payout provider and every checkout
            // delivers as a test — otherwise test tips would mint real Vibes/subs.
            ['powerchat_allow_test_fulfillment', 'false', 'Fulfill PowerChat checkouts from isTest webhook deliveries (dev/sandbox only — test tips move no money)', 'boolean'],
        ];
        const seedPc = database.prepare("INSERT OR IGNORE INTO site_settings (key, value, description, type) VALUES (?, ?, ?, ?)");
        for (const [k, v, d, t] of powerchatSeeds) seedPc.run(k, v, d, t);
        // Upgrade rows still sitting on an OLD seeded default (admin never customized them).
        // The original seed lacked every platform scope, which is why platform pushes 403'd;
        // a later interim default lacked tips:write. Custom values are left untouched.
        const fullScopes = powerchatSeeds.find(r => r[0] === 'powerchat_scopes')[1];
        database.prepare(`UPDATE site_settings SET value = ? WHERE key = 'powerchat_scopes' AND value IN (?, ?)`)
            .run(fullScopes,
                'profile:read webhooks:events checkout:attribute paid_messages:read alerts:trigger',
                'profile:read webhooks:events checkout:attribute paid_messages:read alerts:trigger chat:write viewcount:write subscriptions:write follows:write currency:write');
        database.prepare(`UPDATE site_settings SET value = 'alex' WHERE key = 'powerchat_sandbox_username' AND value = 'n8admin'`).run();
        // powerchat_site_user_id (pointed at an OpenVibe user's connection) is replaced
        // by powerchat_site_tip_username (a directly-typed PowerChat username). Carry
        // the old pointer's resolved PowerChat username over once, then drop it.
        const oldSite = database.prepare(`SELECT value FROM site_settings WHERE key = 'powerchat_site_user_id'`).get();
        if (oldSite) {
            try {
                const uid = parseInt(oldSite.value, 10);
                const conn = uid ? database.prepare('SELECT powerchat_username FROM powerchat_connections WHERE user_id = ?').get(uid) : null;
                if (conn && conn.powerchat_username) {
                    database.prepare(`UPDATE site_settings SET value = ? WHERE key = 'powerchat_site_tip_username' AND (value IS NULL OR value = '')`)
                        .run(conn.powerchat_username);
                }
            } catch { /* best-effort carry-over */ }
            database.prepare(`DELETE FROM site_settings WHERE key = 'powerchat_site_user_id'`).run();
        }
    } catch (e) { console.warn('[DB] Settings seed:', e.message); }

    // Internal job/cache state (JSON blobs the AI jobs persist across restarts).
    // These used to be stashed in site_settings, which made every one of them show up
    // as an editable "setting" in the admin panel — they're machine state, not config.
    // app_state is the same KV shape but never surfaced to (or editable by) admins.
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS app_state (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        // One-time move of the known state keys out of site_settings (idempotent).
        const stateCond = `key IN ('auto_clip_backfill','auto_clip_log','daily_easter_egg','home_hero_moments','home_hero_slogans') OR key LIKE 'ai_whole_overview_%'`;
        database.exec(`INSERT OR IGNORE INTO app_state (key, value, updated_at)
            SELECT key, value, COALESCE(updated_at, CURRENT_TIMESTAMP) FROM site_settings WHERE ${stateCond}`);
        database.exec(`DELETE FROM site_settings WHERE ${stateCond}`);
    } catch (e) { console.warn('[DB] app_state migration:', e.message); }

    // AI subsystem tables + columns.
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS stream_memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            stream_id INTEGER NOT NULL,
            user_id INTEGER,
            offset_seconds INTEGER DEFAULT 0,      -- seconds into the stream when captured
            captured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            description TEXT,
            tags TEXT,                              -- JSON array
            thumbnail_url TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE
        )`);
        database.exec('CREATE INDEX IF NOT EXISTS idx_stream_memories_stream ON stream_memories(stream_id, offset_seconds)');

        // ── Integrity repair: one row per key ────────────────────────────────────
        // These three tables are all written through "insert once, update in place"
        // helpers whose no-op-on-duplicate behaviour depends on a uniqueness
        // constraint. Production drifted: vod_ai_state was created as `vod_id INT`
        // with NO primary key (database.js declares INTEGER PRIMARY KEY, but
        // CREATE TABLE IF NOT EXISTS never repairs an existing table). With nothing to
        // conflict against, `INSERT OR IGNORE INTO vod_ai_state (vod_id)` appended a
        // fresh row on EVERY call — 2818 rows for 487 VODs, one VOD holding 341.
        //
        // That is not just untidy, it silently broke the AI backfill: the work queues
        // are `SELECT ... WHERE ai_overview_short IS NULL ORDER BY vod_id DESC LIMIT 4`,
        // so a VOD with four empty duplicate rows fills the entire batch with itself and
        // no other VOD is ever processed. Every recent VOD had ai_overview null as a
        // result. stream_memories had the same shape of problem for a different reason:
        // no constraint at all, so re-analysing a stream stored the same moment again
        // (the /live/:sel/transcript.json memories list was ~50% duplicates).
        //
        // Merge duplicates field-by-field, preferring the richest value rather than an
        // arbitrary row — a transcript and an overview can live on different duplicates,
        // and picking one row wholesale would throw the other away.
        _dedupeKeyedTable(database, 'vod_ai_state', 'vod_id');
        _dedupeKeyedTable(database, 'clip_ai_state', 'clip_id');
        _dedupeStreamMemories(database);
        _adoptOrphanedTimelineRows(database);

        // ── Unified audio timeline ───────────────────────────────────────────────
        // One time-indexed row per thing heard on a stream: a phrase that was spoken
        // ('speech') or a non-speech sound that was recognised ('sound'). Replaces the
        // old arrangement where transcript segments were buried inside a per-memory JSON
        // blob, which meant timestamps were unusable for anything but display — of ~10
        // consumers only ai-moments-job actually read them, and getStreamTranscriptSegments
        // discarded `end` entirely.
        database.exec(`CREATE TABLE IF NOT EXISTS stream_timeline_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            stream_id INTEGER NOT NULL,
            user_id INTEGER,
            vod_id INTEGER,                         -- set once the session becomes a VOD
            kind TEXT NOT NULL,                     -- 'speech' | 'sound'
            start_sec REAL NOT NULL,                -- absolute seconds into the stream
            end_sec REAL,
            text TEXT,                              -- speech content
            label TEXT,                             -- sound event label
            confidence REAL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE
        )`);
        database.exec('CREATE INDEX IF NOT EXISTS idx_timeline_stream ON stream_timeline_events(stream_id, start_sec)');
        database.exec('CREATE INDEX IF NOT EXISTS idx_timeline_kind ON stream_timeline_events(stream_id, kind, start_sec)');
        database.exec('CREATE INDEX IF NOT EXISTS idx_timeline_vod ON stream_timeline_events(vod_id, start_sec)');

        database.exec(`CREATE TABLE IF NOT EXISTS ai_usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT,                              -- paste_image | paste_text | stream_memory | ai_viewers | ...
            model TEXT,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            cost_usd REAL DEFAULT 0,
            owner_user_id INTEGER,                  -- streamer this spend is attributed to (NULL = platform/global)
            source TEXT,                            -- feature bucket, e.g. 'ai_viewers' (NULL = legacy/global)
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        database.exec('CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at)');
        try {
            const usageCols = database.prepare('PRAGMA table_info(ai_usage)').all().map((c) => c.name);
            if (!usageCols.includes('owner_user_id')) database.exec('ALTER TABLE ai_usage ADD COLUMN owner_user_id INTEGER');
            if (!usageCols.includes('source')) database.exec('ALTER TABLE ai_usage ADD COLUMN source TEXT');
            database.exec('CREATE INDEX IF NOT EXISTS idx_ai_usage_owner_day ON ai_usage(owner_user_id, created_at)');
        } catch (e) { console.warn('[DB] ai_usage attribution migration:', e.message); }

        // AI-generated per-streamer overview (aggregated across their streams/vods/pastes/memories).
        database.exec(`CREATE TABLE IF NOT EXISTS streamer_overviews (
            user_id INTEGER PRIMARY KEY,
            overview TEXT,
            model TEXT,
            sources TEXT,
            generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);

        // Assembled AI Timeline payload per streamer (streamer overview + every session's
        // AI overview + memory moments), cached JSON so the channel tab is cheap to serve and
        // only re-assembled lazily when viewed + stale. No LLM cost — pure join of existing data.
        database.exec(`CREATE TABLE IF NOT EXISTS ai_timeline_cache (
            user_id INTEGER PRIMARY KEY,
            payload TEXT,
            generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);

        // Rolling AI summaries of chat activity — for the global chat overview/timeline
        // and per-user "today vs all-time" insights. scope='global' uses subject_id=0.
        // window: 'rolling' (canonical processing state + condensed memory + timeline),
        // 'recent'/'24h'/'alltime' (rendered overviews). One incremental LLM call folds
        // new messages into memory + refreshes overviews, so cost stays flat with volume.
        database.exec(`CREATE TABLE IF NOT EXISTS chat_ai_summaries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope TEXT NOT NULL,
            subject_id INTEGER NOT NULL DEFAULT 0,
            window TEXT NOT NULL,
            overview TEXT DEFAULT '',
            memory_json TEXT DEFAULT '',
            timeline_json TEXT DEFAULT '[]',
            message_count INTEGER DEFAULT 0,
            window_message_count INTEGER DEFAULT 0,
            last_message_id INTEGER DEFAULT 0,
            window_label TEXT DEFAULT '',
            window_start DATETIME,
            window_end DATETIME,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(scope, subject_id, window)
        )`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_chat_ai_scope ON chat_ai_summaries(scope, subject_id, window)`);
        // Growing log of AI timeline "notable moments" (beyond the 40 kept in the summary JSON),
        // so the global timeline can be browsed/searched/paginated with real history.
        database.exec(`CREATE TABLE IF NOT EXISTS chat_timeline_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope TEXT NOT NULL DEFAULT 'global',
            subject_id INTEGER NOT NULL DEFAULT 0,
            ts DATETIME NOT NULL,
            label TEXT NOT NULL,
            detail TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_chat_tl_scope_ts ON chat_timeline_events(scope, subject_id, ts DESC)`);
        database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_tl_dedup ON chat_timeline_events(scope, subject_id, ts, label)`);
        // Daily easter-egg solves (one per solver per day).
        database.exec(`CREATE TABLE IF NOT EXISTS easter_egg_solves (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            egg_date TEXT NOT NULL,
            solver_key TEXT NOT NULL,
            user_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(egg_date, solver_key)
        )`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_egg_solves_date ON easter_egg_solves(egg_date)`);

        // Admin-set per-user TTS voice overrides (keyed by the same identity key used at
        // synthesis: "user:<username>" / "anon:<id>"). Overrides the auto-assigned voice.
        database.exec(`CREATE TABLE IF NOT EXISTS tts_voice_overrides (
            identity_key TEXT PRIMARY KEY,
            voice TEXT,
            pitch INTEGER,
            speed INTEGER,
            gap INTEGER DEFAULT 0,
            set_by INTEGER,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        const pcols = database.prepare('PRAGMA table_info(pastes)').all().map(c => c.name);
        if (!pcols.includes('ai_summary')) database.exec('ALTER TABLE pastes ADD COLUMN ai_summary TEXT');
        if (!pcols.includes('ai_tags')) database.exec('ALTER TABLE pastes ADD COLUMN ai_tags TEXT');
        if (!pcols.includes('ai_analyzed_at')) database.exec('ALTER TABLE pastes ADD COLUMN ai_analyzed_at DATETIME');

        const scols = database.prepare('PRAGMA table_info(streams)').all().map(c => c.name);
        if (!scols.includes('ai_overview')) database.exec('ALTER TABLE streams ADD COLUMN ai_overview TEXT');
        // Short AI-generated session title for the AI Timeline (streamers reuse literal titles).
        if (!scols.includes('ai_title')) database.exec('ALTER TABLE streams ADD COLUMN ai_title TEXT');

        // AI overview + transcript on VODs and clips.
        const vcols = database.prepare('PRAGMA table_info(vods)').all().map(c => c.name);
        if (!vcols.includes('ai_overview')) database.exec('ALTER TABLE vods ADD COLUMN ai_overview TEXT');
        if (!vcols.includes('ai_transcript')) database.exec('ALTER TABLE vods ADD COLUMN ai_transcript TEXT');
        if (!vcols.includes('ai_analyzed_at')) database.exec('ALTER TABLE vods ADD COLUMN ai_analyzed_at DATETIME');
        const ccols = database.prepare('PRAGMA table_info(clips)').all().map(c => c.name);
        if (!ccols.includes('ai_overview')) database.exec('ALTER TABLE clips ADD COLUMN ai_overview TEXT');
        if (!ccols.includes('ai_transcript')) database.exec('ALTER TABLE clips ADD COLUMN ai_transcript TEXT');
        if (!ccols.includes('ai_analyzed_at')) database.exec('ALTER TABLE clips ADD COLUMN ai_analyzed_at DATETIME');
        // Clip-published chat notification: a deferred "send at" time (grace period so the
        // creator can title it first) + a sent flag so the sweeper fires each clip once.
        if (!ccols.includes('clip_notified')) database.exec('ALTER TABLE clips ADD COLUMN clip_notified INTEGER DEFAULT 0');
        if (!ccols.includes('clip_notify_at')) database.exec('ALTER TABLE clips ADD COLUMN clip_notify_at DATETIME');
    } catch (e) { console.warn('[DB] AI subsystem migration:', e.message); }

    // Visibility (public | unlisted | private) on VODs/clips. `is_public` is kept as
    // a synced mirror (1 iff public) so all existing is_public=1 listing filters keep
    // working; unlisted stays out of listings but reachable by direct link.
    try {
        const vcols = database.prepare('PRAGMA table_info(vods)').all().map(c => c.name);
        if (!vcols.includes('visibility')) {
            database.exec("ALTER TABLE vods ADD COLUMN visibility TEXT DEFAULT 'public'");
            database.exec("UPDATE vods SET visibility = CASE WHEN is_public = 1 THEN 'public' ELSE 'private' END");
        }
        const ccols = database.prepare('PRAGMA table_info(clips)').all().map(c => c.name);
        if (!ccols.includes('visibility')) {
            database.exec("ALTER TABLE clips ADD COLUMN visibility TEXT DEFAULT 'public'");
            database.exec("UPDATE clips SET visibility = CASE WHEN is_public = 1 THEN 'public' ELSE 'unlisted' END");
        }
        if (!ccols.includes('auto_generated')) database.exec('ALTER TABLE clips ADD COLUMN auto_generated INTEGER DEFAULT 0');
        const msCols = database.prepare('PRAGMA table_info(managed_streams)').all().map(c => c.name);
        if (!msCols.includes('slot_clip_recording_enabled')) {
            database.exec('ALTER TABLE managed_streams ADD COLUMN slot_clip_recording_enabled INTEGER DEFAULT 1');
        }
        // Per-slot toggle: announce newly-created clips in the channel's chat (default on).
        if (!msCols.includes('slot_clip_notify_enabled')) {
            database.exec('ALTER TABLE managed_streams ADD COLUMN slot_clip_notify_enabled INTEGER DEFAULT 1');
        }
        // Per-slot master switch: relay this slot's chat (native, RobotStreamer mirror and
        // restream-destination relays) to the streamer's PowerChat overlay (default on).
        if (!msCols.includes('slot_powerchat_relay')) {
            database.exec('ALTER TABLE managed_streams ADD COLUMN slot_powerchat_relay INTEGER DEFAULT 1');
        }
        // Per-slot: count RobotStreamer viewers toward the PowerChat viewer total (default on).
        if (!msCols.includes('slot_powerchat_count_rs_views')) {
            database.exec('ALTER TABLE managed_streams ADD COLUMN slot_powerchat_count_rs_views INTEGER DEFAULT 1');
        }
    } catch (e) { console.warn('[DB] visibility migration:', e.message); }

    // Cached SHORT overview (a concise, locally-derived version of the long AI
    // overview) shown on listing cards — computed once at write time, no extra API.
    try {
        for (const [t, col, scol] of [
            ['streams', 'ai_overview', 'ai_overview_short'],
            ['vods', 'ai_overview', 'ai_overview_short'],
            ['clips', 'ai_overview', 'ai_overview_short'],
            ['streamer_overviews', 'overview', 'overview_short'],
        ]) {
            const cols = database.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
            if (!cols.includes(scol)) database.exec(`ALTER TABLE ${t} ADD COLUMN ${scol} TEXT`);
            // Backfill shorts for existing overviews (one-time; cheap string op).
            const rows = database.prepare(`SELECT rowid AS rid, ${col} AS ov FROM ${t} WHERE ${col} IS NOT NULL AND TRIM(${col}) != '' AND (${scol} IS NULL OR ${scol} = '')`).all();
            const upd = database.prepare(`UPDATE ${t} SET ${scol} = ? WHERE rowid = ?`);
            for (const r of rows) { const s = _shortOverview(r.ov); if (s) upd.run(s, r.rid); }
        }
    } catch (e) { console.warn('[DB] short-overview migration:', e.message); }

    // Chat-relay users (external Twitch/Kick/YouTube handles): record their first
    // message as a "join date" + last-seen + message count, for the context menu.
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS relay_users (
            platform TEXT NOT NULL,
            username TEXT NOT NULL,
            display_name TEXT,
            first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
            message_count INTEGER DEFAULT 0,
            PRIMARY KEY (platform, username)
        )`);
        // One-time backfill: earlier relay sources (notably RobotStreamer) didn't record
        // relay_users, so their existing chatters had no row to hang chat-logs/AI insight
        // off. Seed relay_users from the historical "[Label] name" relay messages. Idempotent
        // (INSERT OR IGNORE keyed on platform+username), guarded so it runs at most once.
        const _relayDone = database.prepare("SELECT value FROM site_settings WHERE key='relay_users_backfilled'").get();
        if (!_relayDone) {
            database.exec(`INSERT OR IGNORE INTO relay_users (platform, username, display_name, first_seen, last_seen, message_count)
                SELECT source_platform,
                       LOWER(TRIM(SUBSTR(username, INSTR(username, '] ') + 2))),
                       TRIM(SUBSTR(username, INSTR(username, '] ') + 2)),
                       MIN(timestamp), MAX(timestamp), COUNT(*)
                FROM chat_messages
                WHERE user_id IS NULL AND source_platform IS NOT NULL
                      AND username LIKE '[%] %' AND INSTR(username, '] ') > 0
                GROUP BY source_platform, LOWER(TRIM(SUBSTR(username, INSTR(username, '] ') + 2)))`);
            database.prepare("INSERT OR REPLACE INTO site_settings (key, value, type) VALUES ('relay_users_backfilled','1','string')").run();
        }
    } catch (e) { console.warn('[DB] relay_users migration:', e.message); }

    // Timestamped transcript segments (JSON) — contextual data for the AI system +
    // clickable timestamps in the VOD/clip transcript UI.
    try {
        for (const [t, col] of [['vods', 'ai_transcript_json'], ['clips', 'ai_transcript_json'], ['stream_memories', 'transcript_json']]) {
            const cols = database.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
            if (!cols.includes(col)) database.exec(`ALTER TABLE ${t} ADD COLUMN ${col} TEXT`);
        }
    } catch (e) { console.warn('[DB] transcript-json migration:', e.message); }

    // Transcription reliability: real job-state so an interrupted or failed run is
    // RETRIED (with a bounded attempt counter) instead of being poisoned to
    // "permanently silent". transcript_status: NULL/'pending'/'retry' = needs work;
    // 'processing' = in flight; 'done' = has speech; 'empty' = ran clean, no speech
    // (terminal); 'failed' = exhausted retries (terminal).
    try {
        for (const t of ['vods', 'clips']) {
            const cols = database.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
            if (!cols.includes('transcript_status')) database.exec(`ALTER TABLE ${t} ADD COLUMN transcript_status TEXT`);
            if (!cols.includes('transcript_attempts')) database.exec(`ALTER TABLE ${t} ADD COLUMN transcript_attempts INTEGER DEFAULT 0`);
            if (!cols.includes('transcript_error')) database.exec(`ALTER TABLE ${t} ADD COLUMN transcript_error TEXT`);
            // Retry backoff: earliest time a 'retry' row may be attempted again, so a
            // persistently-unreadable source doesn't burn all its attempts in minutes.
            if (!cols.includes('transcript_next_at')) database.exec(`ALTER TABLE ${t} ADD COLUMN transcript_next_at DATETIME`);
            // Seed status from the legacy sentinels so the new queue is consistent:
            database.exec(`UPDATE ${t} SET transcript_status='done'
                WHERE transcript_status IS NULL AND ai_transcript IS NOT NULL AND TRIM(ai_transcript) != ''`);
            // Recover RECENTLY-poisoned items (the abruptly-interrupted VODs the user hit):
            // clear the ' ' poison so they re-transcribe with the hardened, retrying pipeline.
            database.exec(`UPDATE ${t} SET transcript_status=NULL, ai_transcript=NULL, ai_transcript_json=NULL
                WHERE transcript_status IS NULL AND ai_transcript = ' ' AND created_at >= datetime('now','-60 days')`);
            // Older poisoned items: assume genuinely silent (terminal) so we don't churn the whole archive.
            database.exec(`UPDATE ${t} SET transcript_status='empty' WHERE transcript_status IS NULL AND ai_transcript = ' '`);
            // (Legacy local tables — see the vod_ai_state/clip_ai_state recovery below.)
            database.exec(`UPDATE ${t} SET transcript_status=NULL, transcript_next_at=NULL WHERE transcript_status='processing'`);
            // Give previously-'failed' rows a fresh chance after a deploy — transient issues
            // (whisper temporarily missing, storage hiccup, a bad build) shouldn't be permanent.
            // Reset the attempt counter so the bounded retry ladder starts over.
            database.exec(`UPDATE ${t} SET transcript_status='retry', transcript_attempts=0, transcript_next_at=NULL WHERE transcript_status='failed'`);
        }
    } catch (e) { console.warn('[DB] transcript-status migration:', e.message); }

    // Donation goals: optional media (image/video → optimized webm/webp), a 1-hour
    // "reached" celebration window (reached_at), and explicit ordering.
    try {
        const cols = database.prepare('PRAGMA table_info(donation_goals)').all().map(c => c.name);
        if (!cols.includes('image_url')) database.exec('ALTER TABLE donation_goals ADD COLUMN image_url TEXT');
        if (!cols.includes('media_type')) database.exec('ALTER TABLE donation_goals ADD COLUMN media_type TEXT');
        if (!cols.includes('reached_at')) database.exec('ALTER TABLE donation_goals ADD COLUMN reached_at DATETIME');
        if (!cols.includes('sort_order')) database.exec('ALTER TABLE donation_goals ADD COLUMN sort_order INTEGER DEFAULT 0');
    } catch (e) { console.warn('[DB] donation_goals media migration:', e.message); }

    // Streamer alert sounds (per channel): a sound played on every donation, plus an
    // optional override that plays when a donation goal is reached.
    try {
        const cols = database.prepare('PRAGMA table_info(channel_moderation_settings)').all().map(c => c.name);
        if (!cols.includes('donation_sound_url')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN donation_sound_url TEXT');
        if (!cols.includes('donation_sound_mime')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN donation_sound_mime TEXT');
        if (!cols.includes('goal_sound_url')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN goal_sound_url TEXT');
        if (!cols.includes('goal_sound_mime')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN goal_sound_mime TEXT');
    } catch (e) { console.warn('[DB] alert-sound settings migration:', e.message); }

    // chat_messages.metadata — JSON sidecar for rich/animated events (donations + goal
    // reached) so they persist in history WITH their structured payload (image, amount,
    // goal title, animation kind) while `message` stays human-readable.
    try {
        const cols = database.prepare('PRAGMA table_info(chat_messages)').all().map(c => c.name);
        if (!cols.includes('metadata')) database.exec('ALTER TABLE chat_messages ADD COLUMN metadata TEXT');
    } catch (e) { console.warn('[DB] chat metadata migration:', e.message); }

    // Migrate: extend the subscriptions table for real recurring billing.
    try {
        const cols = database.pragma('table_info(subscriptions)').map(c => c.name);
        const add = [
            { name: 'provider', def: "TEXT DEFAULT NULL" },            // stripe|paypal|ccbill|crypto|bucks
            { name: 'provider_ref', def: "TEXT DEFAULT NULL" },        // provider subscription/agreement id
            { name: 'price_cents', def: "INTEGER DEFAULT 0" },
            { name: 'currency', def: "TEXT DEFAULT 'usd'" },
            { name: 'status', def: "TEXT DEFAULT 'active'" },          // active|canceled|past_due|expired
            { name: 'cancel_at_period_end', def: "INTEGER DEFAULT 0" },
            { name: 'auto_renew', def: "INTEGER DEFAULT 0" },          // renew from Vibes balance at period end (non-Stripe)
            { name: 'current_period_end', def: "DATETIME DEFAULT NULL" },
            { name: 'created_at', def: "DATETIME DEFAULT CURRENT_TIMESTAMP" },
            { name: 'updated_at', def: "DATETIME DEFAULT CURRENT_TIMESTAMP" },
        ];
        for (const c of add) {
            if (!cols.includes(c.name)) database.exec(`ALTER TABLE subscriptions ADD COLUMN ${c.name} ${c.def}`);
        }
        database.exec('CREATE INDEX IF NOT EXISTS idx_subs_streamer ON subscriptions(streamer_id, status)');
        database.exec('CREATE INDEX IF NOT EXISTS idx_subs_subscriber ON subscriptions(subscriber_id, status)');
        database.exec('CREATE INDEX IF NOT EXISTS idx_subs_provider_ref ON subscriptions(provider, provider_ref)');
    } catch (e) { console.warn('[DB] subscriptions migration:', e.message); }

    // Payment intents/orders — tracks pending purchases so webhooks can credit idempotently.
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS payment_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            provider TEXT NOT NULL,
            provider_ref TEXT,
            kind TEXT NOT NULL DEFAULT 'bucks',        -- bucks | subscription
            amount_cents INTEGER NOT NULL DEFAULT 0,
            currency TEXT DEFAULT 'usd',
            bucks INTEGER DEFAULT 0,
            streamer_id INTEGER,
            status TEXT DEFAULT 'pending',             -- pending | paid | failed | credited
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);
        database.exec('CREATE INDEX IF NOT EXISTS idx_payment_orders_ref ON payment_orders(provider, provider_ref)');
        database.exec('CREATE INDEX IF NOT EXISTS idx_payment_orders_user ON payment_orders(user_id)');
    } catch (e) { console.warn('[DB] payment_orders migration:', e.message); }

    // Migrate: expand role CHECK to include global_mod, migrate 'mod' → 'global_mod'
    try {
        // SQLite cannot ALTER CHECK constraints, but we can migrate data.
        // The schema.sql already has the new CHECK for fresh DBs.
        // For existing DBs, just migrate any 'mod' users to 'global_mod'.
        const modCount = database.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'mod'").get().c;
        if (modCount > 0) {
            database.exec("UPDATE users SET role = 'global_mod' WHERE role = 'mod'");
            console.log(`[DB] Migrated ${modCount} mod(s) → global_mod`);
        }
    } catch (e) { console.warn('[DB] Role migration:', e.message); }

    // Migrate: create channel_moderators table if missing
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS channel_moderators (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            added_by INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(channel_id, user_id),
            FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL
        )`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_channel_mods_channel ON channel_moderators(channel_id)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_channel_mods_user ON channel_moderators(user_id)`);
    } catch (e) { console.warn('[DB] channel_moderators migration:', e.message); }

    // Migrate: create channel_moderation_settings table if missing
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS channel_moderation_settings (
            channel_id INTEGER PRIMARY KEY,
            slow_mode_seconds INTEGER DEFAULT 0,
            followers_only INTEGER DEFAULT 0,
            emote_only INTEGER DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
        )`);
    } catch (e) { console.warn('[DB] channel_moderation_settings migration:', e.message); }

    // Migrate: add extended channel moderation settings columns
    try {
        const cols = database.pragma('table_info(channel_moderation_settings)').map(c => c.name);
        if (!cols.includes('allow_anonymous')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN allow_anonymous INTEGER DEFAULT 1');
        if (!cols.includes('links_allowed')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN links_allowed INTEGER DEFAULT 1');
        if (!cols.includes('gifs_enabled')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN gifs_enabled INTEGER DEFAULT 1');
        if (!cols.includes('account_age_gate_hours')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN account_age_gate_hours INTEGER DEFAULT 0');
        if (!cols.includes('caps_percentage_limit')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN caps_percentage_limit INTEGER DEFAULT 0');
        if (!cols.includes('aggressive_filter')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN aggressive_filter INTEGER DEFAULT 0');
        if (!cols.includes('max_message_length')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN max_message_length INTEGER DEFAULT 500');
        if (!cols.includes('tts_max_length')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN tts_max_length INTEGER DEFAULT 200');
        if (!cols.includes('slur_filter_enabled')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN slur_filter_enabled INTEGER DEFAULT 0');
        if (!cols.includes('slur_filter_use_builtin')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN slur_filter_use_builtin INTEGER DEFAULT 1');
        if (!cols.includes('slur_filter_terms')) database.exec("ALTER TABLE channel_moderation_settings ADD COLUMN slur_filter_terms TEXT DEFAULT ''");
        if (!cols.includes('slur_filter_regexes')) database.exec("ALTER TABLE channel_moderation_settings ADD COLUMN slur_filter_regexes TEXT DEFAULT ''");
        if (!cols.includes('slur_filter_nudge_message')) database.exec("ALTER TABLE channel_moderation_settings ADD COLUMN slur_filter_nudge_message TEXT DEFAULT ''");
        if (!cols.includes('slur_filter_disabled_categories')) database.exec("ALTER TABLE channel_moderation_settings ADD COLUMN slur_filter_disabled_categories TEXT DEFAULT '[]'");
        if (!cols.includes('soundboard_enabled')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN soundboard_enabled INTEGER DEFAULT 1');
        if (!cols.includes('soundboard_allow_pitch')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN soundboard_allow_pitch INTEGER DEFAULT 1');
        if (!cols.includes('soundboard_allow_speed')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN soundboard_allow_speed INTEGER DEFAULT 1');
        if (!cols.includes('soundboard_banned_ids')) database.exec("ALTER TABLE channel_moderation_settings ADD COLUMN soundboard_banned_ids TEXT DEFAULT ''");
        if (!cols.includes('viewer_auto_delete_enabled')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN viewer_auto_delete_enabled INTEGER DEFAULT 1');
        if (!cols.includes('viewer_delete_all_enabled')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN viewer_delete_all_enabled INTEGER DEFAULT 1');
        if (!cols.includes('custom_emotes_enabled')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN custom_emotes_enabled INTEGER DEFAULT 1');
        if (!cols.includes('custom_sounds_enabled')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN custom_sounds_enabled INTEGER DEFAULT 1');
        if (!cols.includes('max_sound_seconds')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN max_sound_seconds INTEGER DEFAULT 10');
        if (!cols.includes('uploads_mods_only')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN uploads_mods_only INTEGER DEFAULT 0');
        if (!cols.includes('emote_scale')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN emote_scale INTEGER DEFAULT 100');
        // Per-channel sound pitch/speed limits (speed as a rate; pitch as cents).
        if (!cols.includes('sound_min_speed')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN sound_min_speed REAL DEFAULT 0.5');
        if (!cols.includes('sound_max_speed')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN sound_max_speed REAL DEFAULT 3.0');
        if (!cols.includes('sound_min_pitch_cents')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN sound_min_pitch_cents INTEGER DEFAULT -1200');
        if (!cols.includes('sound_max_pitch_cents')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN sound_max_pitch_cents INTEGER DEFAULT 1200');
        // Per-channel emote size limits (percent of the base emote height, 100 = default).
        if (!cols.includes('emote_size_min')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN emote_size_min INTEGER DEFAULT 50');
        if (!cols.includes('emote_size_max')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN emote_size_max INTEGER DEFAULT 200');
        // Sounds-only "mods can upload" flag (independent of the emote uploads_mods_only).
        if (!cols.includes('sounds_mods_only')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN sounds_mods_only INTEGER DEFAULT 0');
        // Allow channel mods to edit the streamer's About/panels (off by default).
        if (!cols.includes('mods_can_edit_about')) database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN mods_can_edit_about INTEGER DEFAULT 0');
    } catch (e) { console.warn('[DB] channel_moderation_settings columns migration:', e.message); }

    // Migrate: add channel_owner_id to emotes (viewer uploads targeting a channel) + channel_sounds table
    try {
        const emoteCols = database.prepare('PRAGMA table_info(emotes)').all().map((c) => c.name);
        if (!emoteCols.includes('channel_owner_id')) {
            database.exec('ALTER TABLE emotes ADD COLUMN channel_owner_id INTEGER');
            database.exec('CREATE INDEX IF NOT EXISTS idx_emotes_channel_owner ON emotes(channel_owner_id)');
        }
        // Per-emote display size (percent of base, 100 = default). Clamped to the channel's min/max.
        if (!emoteCols.includes('size')) database.exec('ALTER TABLE emotes ADD COLUMN size INTEGER DEFAULT 100');
    } catch (e) { console.warn('[DB] emotes size/channel_owner_id migration:', e.message); }

    // Migrate: emote code uniqueness is PER-CHANNEL, not per-user. The old UNIQUE(user_id, code)
    // wrongly blocked a user from reusing a code on a different channel. Rebuild the table without
    // that constraint and enforce uniqueness on (effective channel, code) via an index, where the
    // effective channel = channel_owner_id (viewer upload) or the user's own id (own channel).
    try {
        const tbl = get("SELECT sql FROM sqlite_master WHERE type='table' AND name='emotes'");
        if (tbl && /UNIQUE\s*\(\s*user_id\s*,\s*code\s*\)/i.test(tbl.sql)) {
            const rebuild = database.transaction(() => {
                database.exec(`CREATE TABLE emotes_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    code TEXT NOT NULL,
                    url TEXT NOT NULL,
                    animated INTEGER DEFAULT 0,
                    width INTEGER DEFAULT 28,
                    height INTEGER DEFAULT 28,
                    is_global INTEGER DEFAULT 0,
                    is_approved INTEGER DEFAULT 1,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    channel_owner_id INTEGER,
                    size INTEGER DEFAULT 100,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )`);
                database.exec(`INSERT INTO emotes_new (id, user_id, code, url, animated, width, height, is_global, is_approved, created_at, channel_owner_id, size)
                    SELECT id, user_id, code, url, animated, width, height, is_global, is_approved, created_at, channel_owner_id, size FROM emotes`);
                database.exec('DROP TABLE emotes');
                database.exec('ALTER TABLE emotes_new RENAME TO emotes');
                database.exec('CREATE INDEX idx_emotes_user ON emotes(user_id)');
                database.exec('CREATE INDEX idx_emotes_global ON emotes(is_global)');
                database.exec('CREATE INDEX idx_emotes_code ON emotes(code)');
                database.exec('CREATE INDEX idx_emotes_channel_owner ON emotes(channel_owner_id)');
                // Per-channel code uniqueness (channel = channel_owner_id, else the owner's own id).
                database.exec('CREATE UNIQUE INDEX idx_emotes_channel_code ON emotes(COALESCE(channel_owner_id, user_id), code)');
            });
            rebuild();
            console.log('[DB] Rebuilt emotes table: code uniqueness is now per-channel');
        }
    } catch (e) { console.warn('[DB] emotes per-channel uniqueness migration:', e.message); }

    try {
        database.exec(`CREATE TABLE IF NOT EXISTS channel_sounds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_owner_id INTEGER NOT NULL,
            command TEXT NOT NULL,
            url TEXT NOT NULL,
            mime TEXT DEFAULT 'audio/mpeg',
            duration_seconds REAL DEFAULT 0,
            created_by INTEGER,
            created_by_name TEXT DEFAULT '',
            is_approved INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (channel_owner_id) REFERENCES users(id) ON DELETE CASCADE
        )`);
        database.exec('CREATE INDEX IF NOT EXISTS idx_channel_sounds_owner ON channel_sounds(channel_owner_id)');
    } catch (e) { console.warn('[DB] channel_sounds migration:', e.message); }

    // Migrate: allow MULTIPLE sounds per command (random pick on playback).
    // Older DBs created channel_sounds with UNIQUE(channel_owner_id, command);
    // rebuild the table without it. Idempotent — only fires while the constraint exists.
    try {
        const row = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='channel_sounds'").get();
        if (row && /UNIQUE\s*\(\s*channel_owner_id\s*,\s*command\s*\)/i.test(row.sql)) {
            database.exec('PRAGMA foreign_keys=OFF');
            const tx = database.transaction(() => {
                database.exec(`CREATE TABLE channel_sounds_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    channel_owner_id INTEGER NOT NULL,
                    command TEXT NOT NULL,
                    url TEXT NOT NULL,
                    mime TEXT DEFAULT 'audio/mpeg',
                    duration_seconds REAL DEFAULT 0,
                    created_by INTEGER,
                    created_by_name TEXT DEFAULT '',
                    is_approved INTEGER DEFAULT 1,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (channel_owner_id) REFERENCES users(id) ON DELETE CASCADE
                )`);
                database.exec(`INSERT INTO channel_sounds_new
                    (id, channel_owner_id, command, url, mime, duration_seconds, created_by, created_by_name, is_approved, created_at)
                    SELECT id, channel_owner_id, command, url, mime, duration_seconds, created_by, created_by_name, is_approved, created_at
                    FROM channel_sounds`);
                database.exec('DROP TABLE channel_sounds');
                database.exec('ALTER TABLE channel_sounds_new RENAME TO channel_sounds');
                database.exec('CREATE INDEX IF NOT EXISTS idx_channel_sounds_owner ON channel_sounds(channel_owner_id)');
                database.exec('CREATE INDEX IF NOT EXISTS idx_channel_sounds_cmd ON channel_sounds(channel_owner_id, command)');
            });
            tx();
            database.exec('PRAGMA foreign_keys=ON');
            console.log('[DB] Rebuilt channel_sounds without UNIQUE(command) — multiple sounds per command enabled');
        } else {
            database.exec('CREATE INDEX IF NOT EXISTS idx_channel_sounds_cmd ON channel_sounds(channel_owner_id, command)');
        }
    } catch (e) { console.warn('[DB] channel_sounds multi-sound migration:', e.message); }

    // Migrate: optional emote attached to a sound command (shows the emote + "!" in chat).
    try {
        const cols = database.prepare('PRAGMA table_info(channel_sounds)').all().map(c => c.name);
        if (!cols.includes('emote_code')) database.exec("ALTER TABLE channel_sounds ADD COLUMN emote_code TEXT DEFAULT ''");
    } catch (e) { console.warn('[DB] channel_sounds emote_code migration:', e.message); }

    // Migrate: AI chatbot ("fake viewers") config, one row per streamer (user)
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS ai_chatbot_configs (
            user_id INTEGER PRIMARY KEY,
            enabled INTEGER DEFAULT 0,
            base_url TEXT DEFAULT 'https://api.openai.com/v1',
            api_token TEXT DEFAULT '',
            model TEXT DEFAULT 'gpt-4o-mini',
            transcribe_enabled INTEGER DEFAULT 0,
            transcribe_model TEXT DEFAULT 'whisper-1',
            num_bots INTEGER DEFAULT 3,
            post_interval_seconds INTEGER DEFAULT 45,
            persona TEXT DEFAULT '',
            vision_enabled INTEGER DEFAULT 0,
            last_validated_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);
        const aiCols = database.prepare('PRAGMA table_info(ai_chatbot_configs)').all().map((c) => c.name);
        if (!aiCols.includes('vision_enabled')) database.exec('ALTER TABLE ai_chatbot_configs ADD COLUMN vision_enabled INTEGER DEFAULT 0');
    } catch (e) { console.warn('[DB] ai_chatbot_configs migration:', e.message); }

    // ── AI Chat Viewers 2.0 ──────────────────────────────────────
    // Persistent per-channel bot roster ("brains"): one durable identity per row that
    // survives across every stream on that channel.
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS channel_ai_bots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_user_id INTEGER NOT NULL,       -- the streamer (owner)
            username TEXT NOT NULL,
            display_name TEXT,
            avatar_color TEXT DEFAULT '#8a8aff',
            source TEXT DEFAULT 'ambient',          -- 'ambient' | 'clone'
            cloned_from_kind TEXT,                   -- 'user' | 'relay' | NULL
            cloned_from_ref TEXT,                    -- user_id (string) or "platform:username"
            persona_json TEXT DEFAULT '{}',          -- character + typing style + identity
            brain_json TEXT DEFAULT '{}',            -- rolling condensed memory + short timeline
            is_active INTEGER DEFAULT 1,
            msg_count INTEGER DEFAULT 0,
            last_active_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (channel_user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);
        database.exec('CREATE INDEX IF NOT EXISTS idx_channel_ai_bots_channel ON channel_ai_bots(channel_user_id, is_active)');
        database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_ai_bots_uname ON channel_ai_bots(channel_user_id, username)');
    } catch (e) { console.warn('[DB] channel_ai_bots migration:', e.message); }

    // Per-streamer AI-viewer settings (supersedes ai_chatbot_configs; adds budget + BYO key).
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS channel_ai_config (
            user_id INTEGER PRIMARY KEY,
            enabled INTEGER DEFAULT 0,
            num_ambient_bots INTEGER DEFAULT 3,
            pacing_seconds INTEGER DEFAULT 45,
            persona TEXT DEFAULT '',
            transcribe_enabled INTEGER DEFAULT 0,
            vision_enabled INTEGER DEFAULT 0,
            use_shared_key INTEGER DEFAULT 1,        -- 1 = OpenVibe.Live shared key (capped), 0 = BYO
            daily_budget_cents INTEGER DEFAULT 20,   -- shared-key daily cap
            byo_key TEXT DEFAULT '',
            byo_base_url TEXT DEFAULT '',
            byo_model TEXT DEFAULT 'gpt-4o-mini',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);
        // One-time migration of existing ai_chatbot_configs rows into the new table.
        const migrated = database.prepare('SELECT COUNT(*) AS c FROM channel_ai_config').get().c;
        if (!migrated) {
            const old = database.prepare('SELECT * FROM ai_chatbot_configs').all();
            const ins = database.prepare(`INSERT OR IGNORE INTO channel_ai_config
                (user_id, enabled, num_ambient_bots, pacing_seconds, persona, transcribe_enabled, vision_enabled,
                 use_shared_key, daily_budget_cents, byo_key, byo_base_url, byo_model)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
            for (const r of old) {
                const hasByo = !!(r.api_token && String(r.api_token).trim());
                ins.run(
                    r.user_id, r.enabled ? 1 : 0, r.num_bots || 3, r.post_interval_seconds || 45,
                    r.persona || '', r.transcribe_enabled ? 1 : 0, r.vision_enabled ? 1 : 0,
                    hasByo ? 0 : 1, 20, r.api_token || '', r.base_url || '', r.model || 'gpt-4o-mini'
                );
            }
            if (old.length) console.log(`[DB] Migrated ${old.length} ai_chatbot_configs → channel_ai_config`);
        }
    } catch (e) { console.warn('[DB] channel_ai_config migration:', e.message); }

    // Migrate: create moderation_actions table for audit logging
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS moderation_actions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope_type TEXT NOT NULL DEFAULT 'site',
            scope_id INTEGER,
            actor_user_id INTEGER,
            target_user_id INTEGER,
            action_type TEXT NOT NULL,
            details TEXT DEFAULT '{}',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
            FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE SET NULL
        )`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_mod_actions_created ON moderation_actions(created_at DESC)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_mod_actions_actor ON moderation_actions(actor_user_id)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_mod_actions_scope ON moderation_actions(scope_type, scope_id)`);
    } catch (e) { console.warn('[DB] moderation_actions migration:', e.message); }

    // Migrate: create pastes table if missing
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS pastes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT UNIQUE NOT NULL,
            user_id INTEGER,
            type TEXT DEFAULT 'paste' CHECK(type IN ('paste', 'screenshot')),
            title TEXT NOT NULL DEFAULT 'Untitled',
            content TEXT,
            language TEXT DEFAULT 'text',
            visibility TEXT DEFAULT 'public' CHECK(visibility IN ('public', 'unlisted')),
            stream_id INTEGER,
            screenshot_path TEXT,
            metadata TEXT,
            burn_after_read INTEGER DEFAULT 0,
            forked_from INTEGER,
            pinned INTEGER DEFAULT 0,
            views INTEGER DEFAULT 0,
            ip_address TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
            FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE SET NULL,
            FOREIGN KEY (forked_from) REFERENCES pastes(id) ON DELETE SET NULL
        )`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_pastes_slug ON pastes(slug)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_pastes_user ON pastes(user_id)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_pastes_visibility ON pastes(visibility)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_pastes_type ON pastes(type)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_pastes_created ON pastes(created_at)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_pastes_pinned ON pastes(pinned)`);
    } catch (e) { console.warn('[DB] pastes migration:', e.message); }

    // Migrate: add copies + likes columns to pastes, create paste_likes table
    try {
        const cols = database.prepare("PRAGMA table_info(pastes)").all().map(c => c.name);
        if (!cols.includes('copies'))  database.exec("ALTER TABLE pastes ADD COLUMN copies INTEGER DEFAULT 0");
        if (!cols.includes('likes'))   database.exec("ALTER TABLE pastes ADD COLUMN likes INTEGER DEFAULT 0");

        database.exec(`CREATE TABLE IF NOT EXISTS paste_likes (
            paste_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (paste_id, user_id),
            FOREIGN KEY (paste_id) REFERENCES pastes(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);
    } catch (e) { console.warn('[DB] paste_likes migration:', e.message); }

    // Migrate: add is_nsfw column to pastes
    try {
        const cols = database.prepare("PRAGMA table_info(pastes)").all().map(c => c.name);
        if (!cols.includes('is_nsfw')) database.exec("ALTER TABLE pastes ADD COLUMN is_nsfw INTEGER DEFAULT 0");
    } catch (e) { console.warn('[DB] pastes is_nsfw migration:', e.message); }

    // Seed paste-related site settings
    try {
        const pasteSettings = [
            ['paste_max_size_kb', '512', 'Maximum paste content size in KB', 'number'],
            ['paste_screenshot_max_size_mb', '8', 'Maximum screenshot upload size in MB', 'number'],
            ['paste_cooldown_seconds', '30', 'Cooldown between paste submissions in seconds', 'number'],
            ['paste_max_per_user_per_day', '50', 'Maximum pastes per user per day (0 = unlimited)', 'number'],
            ['paste_anon_allowed', 'true', 'Allow anonymous paste creation', 'boolean'],
            ['paste_image_upload_enabled', 'true', 'Allow image uploads in pastes', 'boolean'],
        ];
        const seedPaste = database.prepare("INSERT OR IGNORE INTO site_settings (key, value, description, type) VALUES (?, ?, ?, ?)");
        for (const [k, v, d, t] of pasteSettings) seedPaste.run(k, v, d, t);
    } catch (e) { console.warn('[DB] paste settings seed:', e.message); }

    // Migrate: paste_comments table (separate from vod/clip comments — supports anon)
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS paste_comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            paste_id INTEGER NOT NULL,
            user_id INTEGER,
            parent_id INTEGER,
            anon_name TEXT,
            message TEXT NOT NULL,
            ip_address TEXT,
            is_deleted INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (paste_id) REFERENCES pastes(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
            FOREIGN KEY (parent_id) REFERENCES paste_comments(id) ON DELETE CASCADE
        )`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_paste_comments_paste ON paste_comments(paste_id)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_paste_comments_user ON paste_comments(user_id)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_paste_comments_parent ON paste_comments(parent_id)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_paste_comments_ip ON paste_comments(ip_address)`);

        // Seed paste comment settings
        const commentSettings = [
            ['paste_comment_cooldown_seconds', '10', 'Cooldown between paste comments in seconds', 'number'],
            ['paste_comment_max_length', '2000', 'Maximum paste comment length in characters', 'number'],
            ['paste_comment_anon_allowed', 'true', 'Allow anonymous comments on pastes', 'boolean'],
        ];
        const seedComment = database.prepare("INSERT OR IGNORE INTO site_settings (key, value, description, type) VALUES (?, ?, ?, ?)");
        for (const [k, v, d, t] of commentSettings) seedComment.run(k, v, d, t);
    } catch (e) { console.warn('[DB] paste_comments migration:', e.message); }

    // Migrate: stream_first_chats — tracks first-time chatters per streamer (for welcome messages)
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS stream_first_chats (
            chatter_key TEXT NOT NULL,
            channel_user_id INTEGER NOT NULL,
            first_chat_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (chatter_key, channel_user_id)
        )`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_sfc_channel ON stream_first_chats(channel_user_id)`);
    } catch (e) { console.warn('[DB] stream_first_chats migration:', e.message); }

    // Migrate: ip_log — tracks IP addresses used by users and anons
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS ip_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            anon_id TEXT,
            ip_address TEXT NOT NULL,
            action TEXT NOT NULL DEFAULT 'chat',
            geo_country TEXT,
            geo_region TEXT,
            geo_city TEXT,
            geo_isp TEXT,
            geo_org TEXT,
            geo_ll TEXT,
            user_agent TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
        )`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_ip_log_user ON ip_log(user_id)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_ip_log_ip ON ip_log(ip_address)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_ip_log_created ON ip_log(created_at)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_ip_log_action ON ip_log(action)`);
    } catch (e) { console.warn('[DB] ip_log migration:', e.message); }

    // Migrate: approved_ips — per-channel IP whitelist for anti-VPN mode
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS approved_ips (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id INTEGER NOT NULL,
            ip_address TEXT NOT NULL,
            approved_by INTEGER,
            source TEXT DEFAULT 'auto',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(channel_id, ip_address),
            FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
            FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL
        )`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_approved_ips_channel ON approved_ips(channel_id)`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_approved_ips_ip ON approved_ips(ip_address)`);
    } catch (e) { console.warn('[DB] approved_ips migration:', e.message); }

    // Migrate: pending_ip_messages — messages held for IP approval when anti-VPN mode is on
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS pending_ip_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id INTEGER NOT NULL,
            stream_id INTEGER,
            ip_address TEXT NOT NULL,
            user_id INTEGER,
            anon_id TEXT,
            username TEXT,
            message TEXT NOT NULL,
            status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','denied')),
            reviewed_by INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
            FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
        )`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_pending_ip_channel ON pending_ip_messages(channel_id, status)`);
    } catch (e) { console.warn('[DB] pending_ip_messages migration:', e.message); }

    // Migrate: hidden_relay_users — relayed external users banned/hidden by streamer or admin
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS hidden_relay_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id INTEGER,
            platform TEXT NOT NULL,
            external_username TEXT NOT NULL,
            action TEXT DEFAULT 'hide' CHECK(action IN ('hide','ban')),
            reason TEXT,
            created_by INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
        )`);
        database.exec(`CREATE INDEX IF NOT EXISTS idx_hidden_relay_channel ON hidden_relay_users(channel_id, platform)`);
    } catch (e) { console.warn('[DB] hidden_relay_users migration:', e.message); }

    // Migrate: add ip_approval_mode to channel_moderation_settings
    try {
        const cols = database.pragma('table_info(channel_moderation_settings)').map(c => c.name);
        if (!cols.includes('ip_approval_mode')) {
            database.exec('ALTER TABLE channel_moderation_settings ADD COLUMN ip_approval_mode INTEGER DEFAULT 0');
        }
    } catch (e) { console.warn('[DB] ip_approval_mode migration:', e.message); }

    // Migrate: add deleted_by and deleted_at to chat_messages for soft-delete attribution
    try {
        const cols = database.pragma('table_info(chat_messages)').map(c => c.name);
        if (!cols.includes('deleted_by')) {
            database.exec('ALTER TABLE chat_messages ADD COLUMN deleted_by INTEGER');
        }
        if (!cols.includes('deleted_at')) {
            database.exec("ALTER TABLE chat_messages ADD COLUMN deleted_at DATETIME");
        }
    } catch (e) { console.warn('[DB] chat_messages delete attribution migration:', e.message); }

    // Migrate: add source_platform column to chat_messages for filtering relayed messages
    try {
        const cols = database.pragma('table_info(chat_messages)').map(c => c.name);
        if (!cols.includes('source_platform')) {
            database.exec("ALTER TABLE chat_messages ADD COLUMN source_platform TEXT");
        }
    } catch (e) { console.warn('[DB] chat_messages source_platform migration:', e.message); }

    // Migrate: add auto_delete_at to chat_messages for viewer-controlled history cleanup
    try {
        const cols = database.pragma('table_info(chat_messages)').map(c => c.name);
        if (!cols.includes('auto_delete_at')) {
            database.exec("ALTER TABLE chat_messages ADD COLUMN auto_delete_at DATETIME");
        }
    } catch (e) { console.warn('[DB] chat_messages auto_delete_at migration:', e.message); }

    // Migrate: add channel_user_id to chat_messages — the broadcaster's user id, so
    // a streamer's chat is one persistent room across live slots AND offline periods
    // (history no longer depends on the live-session stream row surviving). Backfill
    // existing rows from their stream's owner.
    try {
        const cols = database.pragma('table_info(chat_messages)').map(c => c.name);
        if (!cols.includes('channel_user_id')) {
            database.exec("ALTER TABLE chat_messages ADD COLUMN channel_user_id INTEGER");
            database.exec("UPDATE chat_messages SET channel_user_id = (SELECT s.user_id FROM streams s WHERE s.id = chat_messages.stream_id) WHERE stream_id IS NOT NULL AND channel_user_id IS NULL");
            console.log('[DB] Added channel_user_id to chat_messages + backfilled');
        }
    } catch (e) { console.warn('[DB] chat_messages channel_user_id migration:', e.message); }

    // Performance indexes — runs EVERY boot (CREATE INDEX IF NOT EXISTS is idempotent), so
    // it also fixes the previously-broken chat index (it referenced a non-existent
    // `created_at` column, so it never got created) and covers hot listing queries whose
    // WHERE + ORDER BY (created_at / view_count) previously did full scans + filesorts.
    try {
        // Chat history: filter by channel_user_id / stream_id, ORDER BY timestamp DESC.
        database.exec('CREATE INDEX IF NOT EXISTS idx_chat_channel_user_ts ON chat_messages(channel_user_id, timestamp)');
        database.exec('CREATE INDEX IF NOT EXISTS idx_chat_stream_ts ON chat_messages(stream_id, timestamp)');
        // VOD/clip listings: filter by owner + visibility, ORDER BY created_at / view_count.
        database.exec('CREATE INDEX IF NOT EXISTS idx_vods_user_created ON vods(user_id, is_public, created_at)');
        database.exec('CREATE INDEX IF NOT EXISTS idx_vods_public_created ON vods(is_public, created_at)');
        database.exec('CREATE INDEX IF NOT EXISTS idx_vods_stream_recording ON vods(stream_id, is_recording)');
        database.exec('CREATE INDEX IF NOT EXISTS idx_clips_user_created ON clips(user_id, is_public, created_at)');
    } catch (e) { console.warn('[DB] performance index migration:', e.message); }

    // Migrate: add force_nsfw column to channels (admin-set, overrides user toggle)
    try {
        const cols = database.pragma('table_info(channels)').map(c => c.name);
        if (!cols.includes('force_nsfw')) {
            database.exec('ALTER TABLE channels ADD COLUMN force_nsfw INTEGER DEFAULT 0');
            console.log('[DB] Added force_nsfw column to channels');
        }
    } catch (e) { console.warn('[DB] channels force_nsfw migration:', e.message); }

    // Migrate: add VOD recording policy columns to channels
    try {
        const cols = database.pragma('table_info(channels)').map(c => c.name);
        if (!cols.includes('vod_recording_enabled')) {
            database.exec('ALTER TABLE channels ADD COLUMN vod_recording_enabled INTEGER DEFAULT 1');
            console.log('[DB] Added vod_recording_enabled column to channels');
        }
        if (!cols.includes('force_vod_recording_disabled')) {
            database.exec('ALTER TABLE channels ADD COLUMN force_vod_recording_disabled INTEGER DEFAULT 0');
            console.log('[DB] Added force_vod_recording_disabled column to channels');
        }
    } catch (e) { console.warn('[DB] channels VOD recording policy migration:', e.message); }

    // Migrate: add control settings to channels
    try {
        const cols = database.pragma('table_info(channels)').map(c => c.name);
        if (!cols.includes('control_mode')) {
            database.exec("ALTER TABLE channels ADD COLUMN control_mode TEXT DEFAULT 'open'");
            console.log('[DB] Added control_mode column to channels');
        }
        if (!cols.includes('anon_controls_enabled')) {
            database.exec('ALTER TABLE channels ADD COLUMN anon_controls_enabled INTEGER DEFAULT 1');
            console.log('[DB] Added anon_controls_enabled column to channels');
        }
        if (!cols.includes('control_rate_limit_ms')) {
            database.exec('ALTER TABLE channels ADD COLUMN control_rate_limit_ms INTEGER DEFAULT 100');
            console.log('[DB] Added control_rate_limit_ms column to channels');
        }
        if (!cols.includes('video_click_rate_limit_ms')) {
            database.exec('ALTER TABLE channels ADD COLUMN video_click_rate_limit_ms INTEGER DEFAULT 0');
            console.log('[DB] Added video_click_rate_limit_ms column to channels');
        }
    } catch (e) { console.warn('[DB] channel control settings migration:', e.message); }

    // Migrate: create control_whitelist table
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS control_whitelist (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            added_by INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(channel_id, user_id),
            FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);
        database.exec('CREATE INDEX IF NOT EXISTS idx_control_whitelist_channel ON control_whitelist(channel_id)');
    } catch (e) { console.warn('[DB] control_whitelist migration:', e.message); }

    // Migrate: create control_configs table (reusable per-channel control profiles)
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS control_configs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);
        database.exec('CREATE INDEX IF NOT EXISTS idx_control_configs_user ON control_configs(user_id)');
    } catch (e) { console.warn('[DB] control_configs migration:', e.message); }

    // Migrate: create control_config_buttons table
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS control_config_buttons (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            config_id INTEGER NOT NULL,
            label TEXT NOT NULL,
            command TEXT NOT NULL,
            icon TEXT DEFAULT 'fa-gamepad',
            control_type TEXT DEFAULT 'button' CHECK(control_type IN ('button','toggle','dpad','keyboard')),
            key_binding TEXT,
            cooldown_ms INTEGER DEFAULT 500,
            sort_order INTEGER DEFAULT 0,
            btn_color TEXT DEFAULT '',
            btn_bg TEXT DEFAULT '',
            btn_border_color TEXT DEFAULT '',
            is_enabled INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (config_id) REFERENCES control_configs(id) ON DELETE CASCADE
        )`);
        database.exec('CREATE INDEX IF NOT EXISTS idx_config_buttons_config ON control_config_buttons(config_id)');
    } catch (e) { console.warn('[DB] control_config_buttons migration:', e.message); }

    // Migrate: add active_control_config_id and video_click_enabled to channels
    try {
        const cols = database.pragma('table_info(channels)').map(c => c.name);
        if (!cols.includes('active_control_config_id')) {
            database.exec('ALTER TABLE channels ADD COLUMN active_control_config_id INTEGER');
            console.log('[DB] Added active_control_config_id column to channels');
        }
        if (!cols.includes('video_click_enabled')) {
            database.exec('ALTER TABLE channels ADD COLUMN video_click_enabled INTEGER DEFAULT 0');
            console.log('[DB] Added video_click_enabled column to channels');
        }
    } catch (e) { console.warn('[DB] channel control config migration:', e.message); }

    // Migrate: customizable offline screen (image / transcoded webm / custom HTML+CSS)
    try {
        const cols = database.pragma('table_info(channels)').map(c => c.name);
        if (!cols.includes('offline_screen_type')) {
            database.exec("ALTER TABLE channels ADD COLUMN offline_screen_type TEXT DEFAULT 'none'"); // none|image|video|html
        }
        if (!cols.includes('offline_screen_url')) {
            database.exec('ALTER TABLE channels ADD COLUMN offline_screen_url TEXT');
        }
        if (!cols.includes('offline_html')) {
            database.exec('ALTER TABLE channels ADD COLUMN offline_html TEXT');
        }
        if (!cols.includes('offline_css')) {
            database.exec('ALTER TABLE channels ADD COLUMN offline_css TEXT');
        }
    } catch (e) { console.warn('[DB] channel offline-screen migration:', e.message); }

    // Migrate: add control_config_id to streams for stream-scoped control profiles
    try {
        const cols = database.pragma('table_info(streams)').map(c => c.name);
        if (!cols.includes('control_config_id')) {
            database.exec('ALTER TABLE streams ADD COLUMN control_config_id INTEGER');
            console.log('[DB] Added control_config_id column to streams');
        }
    } catch (e) { console.warn('[DB] stream control_config_id migration:', e.message); }

    // Migrate: add btn_color, btn_bg, btn_border_color to stream_controls for legacy compat
    try {
        const cols = database.pragma('table_info(stream_controls)').map(c => c.name);
        if (!cols.includes('btn_color')) {
            database.exec("ALTER TABLE stream_controls ADD COLUMN btn_color TEXT DEFAULT ''");
        }
        if (!cols.includes('btn_bg')) {
            database.exec("ALTER TABLE stream_controls ADD COLUMN btn_bg TEXT DEFAULT ''");
        }
        if (!cols.includes('btn_border_color')) {
            database.exec("ALTER TABLE stream_controls ADD COLUMN btn_border_color TEXT DEFAULT ''");
        }
    } catch (e) { console.warn('[DB] stream_controls style migration:', e.message); }

    // Migrate: fix stream_controls CHECK constraint to include 'keyboard' type
    try {
        const tableInfo = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='stream_controls'").get();
        if (tableInfo && tableInfo.sql && !tableInfo.sql.includes("'keyboard'")) {
            console.log('[DB] Migrating stream_controls to support keyboard control_type...');
            database.exec(`
                CREATE TABLE IF NOT EXISTS stream_controls_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    stream_id INTEGER NOT NULL,
                    label TEXT NOT NULL,
                    command TEXT NOT NULL,
                    icon TEXT DEFAULT 'fa-gamepad',
                    control_type TEXT DEFAULT 'button' CHECK(control_type IN ('button', 'toggle', 'slider', 'dpad', 'onvif', 'keyboard')),
                    key_binding TEXT,
                    cooldown_ms INTEGER DEFAULT 500,
                    is_enabled INTEGER DEFAULT 1,
                    sort_order INTEGER DEFAULT 0,
                    camera_id INTEGER,
                    onvif_movement TEXT,
                    btn_color TEXT DEFAULT '',
                    btn_bg TEXT DEFAULT '',
                    btn_border_color TEXT DEFAULT '',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE,
                    FOREIGN KEY (camera_id) REFERENCES camera_profiles(id) ON DELETE SET NULL
                );
                INSERT INTO stream_controls_new
                    SELECT id, stream_id, label, command, icon, control_type, key_binding,
                           cooldown_ms, is_enabled, sort_order, NULL, NULL,
                           btn_color, btn_bg, btn_border_color, created_at
                    FROM stream_controls;
                DROP TABLE stream_controls;
                ALTER TABLE stream_controls_new RENAME TO stream_controls;
            `);
            console.log('[DB] stream_controls migrated — keyboard type now supported');
        }
    } catch (e) { console.warn('[DB] stream_controls keyboard migration:', e.message); }

    // ── Managed Streams Migration ────────────────────────────────
    // Add the persistent managed_streams table and link sessions to it
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS managed_streams (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            channel_id INTEGER,
            slug TEXT,
            title TEXT DEFAULT 'Untitled Stream',
            description TEXT DEFAULT '',
            category TEXT DEFAULT 'irl',
            tags TEXT DEFAULT '[]',
            protocol TEXT DEFAULT 'webrtc' CHECK(protocol IN ('jsmpeg', 'webrtc', 'rtmp')),
            stream_key TEXT UNIQUE NOT NULL,
            is_nsfw INTEGER DEFAULT 0,
            control_config_id INTEGER,
            sort_order INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL,
            FOREIGN KEY (control_config_id) REFERENCES control_configs(id) ON DELETE SET NULL
        )`);
        database.exec('CREATE INDEX IF NOT EXISTS idx_managed_streams_user ON managed_streams(user_id)');
        database.exec('CREATE INDEX IF NOT EXISTS idx_managed_streams_slug ON managed_streams(slug)');
        database.exec('CREATE INDEX IF NOT EXISTS idx_managed_streams_key ON managed_streams(stream_key)');
    } catch (e) { console.warn('[DB] managed_streams table migration:', e.message); }

    // Add managed_stream_id column to streams (session) table
    try {
        const streamCols = database.pragma('table_info(streams)').map(c => c.name);
        if (!streamCols.includes('managed_stream_id')) {
            database.exec('ALTER TABLE streams ADD COLUMN managed_stream_id INTEGER REFERENCES managed_streams(id) ON DELETE SET NULL');
            database.exec('CREATE INDEX IF NOT EXISTS idx_streams_managed ON streams(managed_stream_id)');
            console.log('[DB] Added managed_stream_id column to streams');
        }
    } catch (e) { console.warn('[DB] streams managed_stream_id migration:', e.message); }

    // Add max_managed_streams column to users (admin override for stream limit)
    try {
        const userCols2 = database.pragma('table_info(users)').map(c => c.name);
        if (!userCols2.includes('max_managed_streams')) {
            database.exec('ALTER TABLE users ADD COLUMN max_managed_streams INTEGER DEFAULT 3');
            console.log('[DB] Added max_managed_streams column to users');
        }
    } catch (e) { console.warn('[DB] users max_managed_streams migration:', e.message); }

    // Track which paste (if any) a user's active avatar is sourced from, so that
    // deleting that paste resets the avatar. Avatars are now backed by pastes.
    try {
        const userCols3 = database.pragma('table_info(users)').map(c => c.name);
        if (!userCols3.includes('avatar_paste_id')) {
            database.exec('ALTER TABLE users ADD COLUMN avatar_paste_id INTEGER DEFAULT NULL');
            console.log('[DB] Added avatar_paste_id column to users');
        }
    } catch (e) { console.warn('[DB] users avatar_paste_id migration:', e.message); }

    // Owner rank: an admin with is_owner=1 who alone may view/change API keys, money
    // settings, and grant admin. Regular admins keep moderation powers but not these.
    // Bootstrapped to the network owner (Goosely) via OWNER_USERNAME (default goosely).
    try {
        const userCols4 = database.pragma('table_info(users)').map(c => c.name);
        if (!userCols4.includes('is_owner')) {
            database.exec('ALTER TABLE users ADD COLUMN is_owner INTEGER DEFAULT 0');
            console.log('[DB] Added is_owner column to users');
        }
        const ownerName = (process.env.OWNER_USERNAME || 'goosely').toLowerCase();
        database.prepare("UPDATE users SET is_owner = 1, role = 'admin' WHERE LOWER(username) = ? AND is_owner != 1").run(ownerName);
    } catch (e) { console.warn('[DB] users is_owner migration:', e.message); }

    // Backfill: Create a default managed stream for each streamer who has session history
    // but no managed streams yet. This preserves all existing data.
    try {
        const streamersWithoutManaged = database.prepare(`
            SELECT DISTINCT s.user_id, u.stream_key, u.username, u.display_name,
                   c.id AS channel_id, c.title AS channel_title, c.protocol AS channel_protocol,
                   c.category AS channel_category, c.is_nsfw AS channel_is_nsfw
            FROM streams s
            JOIN users u ON s.user_id = u.id
            LEFT JOIN channels c ON c.user_id = s.user_id
            WHERE s.user_id NOT IN (SELECT user_id FROM managed_streams)
              AND u.stream_key IS NOT NULL
        `).all();

        if (streamersWithoutManaged.length > 0) {
            const insertMs = database.prepare(`
                INSERT INTO managed_streams (user_id, channel_id, title, category, protocol, stream_key, is_nsfw)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `);
            const updateSessions = database.prepare(`
                UPDATE streams SET managed_stream_id = ? WHERE user_id = ? AND managed_stream_id IS NULL
            `);

            const backfill = database.transaction(() => {
                for (const s of streamersWithoutManaged) {
                    const title = s.channel_title || `${s.display_name || s.username}'s Stream`;
                    const result = insertMs.run(
                        s.user_id,
                        s.channel_id || null,
                        title,
                        s.channel_category || 'irl',
                        s.channel_protocol || 'webrtc',
                        s.stream_key,
                        s.channel_is_nsfw || 0
                    );
                    // Link all existing sessions to this managed stream
                    updateSessions.run(result.lastInsertRowid, s.user_id);
                }
            });
            backfill();
            console.log(`[DB] Backfilled ${streamersWithoutManaged.length} managed stream(s) for existing streamers`);
        }
    } catch (e) { console.warn('[DB] managed_streams backfill:', e.message); }

    // Add broadcast_settings JSON column to managed_streams (per-stream broadcast config)
    try {
        const msCols = database.pragma('table_info(managed_streams)').map(c => c.name);
        if (!msCols.includes('broadcast_settings')) {
            database.exec("ALTER TABLE managed_streams ADD COLUMN broadcast_settings TEXT DEFAULT '{}'");
            console.log('[DB] Added broadcast_settings column to managed_streams');
        }
    } catch (e) { console.warn('[DB] managed_streams broadcast_settings migration:', e.message); }

    // ── Slot-Level Settings Migration ────────────────────────────
    // Move per-channel settings down to per-slot (managed_stream) level
    try {
        const msCols2 = database.pragma('table_info(managed_streams)').map(c => c.name);
        if (!msCols2.includes('streaming_method')) {
            database.exec("ALTER TABLE managed_streams ADD COLUMN streaming_method TEXT DEFAULT 'browser'");
            // Backfill: derive streaming_method from protocol
            database.exec("UPDATE managed_streams SET streaming_method = 'browser' WHERE protocol = 'webrtc'");
            database.exec("UPDATE managed_streams SET streaming_method = 'cli' WHERE protocol = 'jsmpeg'");
            database.exec("UPDATE managed_streams SET streaming_method = 'rtmp' WHERE protocol = 'rtmp'");
            console.log('[DB] Added streaming_method column to managed_streams');
        }
        if (!msCols2.includes('browser_mode')) {
            database.exec("ALTER TABLE managed_streams ADD COLUMN browser_mode TEXT DEFAULT 'camera'");
            console.log('[DB] Added browser_mode column to managed_streams');
        }
        if (!msCols2.includes('pip_source_msid')) {
            // The slot whose live stream should appear as a picture-in-picture overlay on
            // THIS slot. Modelling the camera as an ordinary slot rather than a second
            // track inside one stream is what lets it inherit everything the platform
            // already does per stream — its own VOD, clips, transcript, restreams — and
            // lets viewers move and resize it independently of the screen share. It is
            // deliberately a plain slot reference, not "the owner's webcam", so a
            // streamer can point at a co-host's or moderator's slot too.
            database.exec('ALTER TABLE managed_streams ADD COLUMN pip_source_msid INTEGER');
            console.log('[DB] Added pip_source_msid column to managed_streams');
        }
        if (!msCols2.includes('pip_defaults')) {
            // Broadcaster-chosen STARTING geometry for the overlay, as JSON
            // {x,y,w} in fractions of the player. Viewers can move/resize from there and
            // their own choice is remembered locally; this is only the default they land on.
            database.exec("ALTER TABLE managed_streams ADD COLUMN pip_defaults TEXT DEFAULT '{}'");
            console.log('[DB] Added pip_defaults column to managed_streams');
        }
        if (!msCols2.includes('default_vod_visibility')) {
            database.exec("ALTER TABLE managed_streams ADD COLUMN default_vod_visibility TEXT DEFAULT 'public'");
            console.log('[DB] Added default_vod_visibility column to managed_streams');
        }
        if (!msCols2.includes('default_clip_visibility')) {
            database.exec("ALTER TABLE managed_streams ADD COLUMN default_clip_visibility TEXT DEFAULT 'public'");
            console.log('[DB] Added default_clip_visibility column to managed_streams');
        }
        if (!msCols2.includes('slot_vod_recording_enabled')) {
            database.exec('ALTER TABLE managed_streams ADD COLUMN slot_vod_recording_enabled INTEGER DEFAULT 1');
            console.log('[DB] Added slot_vod_recording_enabled column to managed_streams');
        }
        if (!msCols2.includes('weather_zip')) {
            database.exec('ALTER TABLE managed_streams ADD COLUMN weather_zip TEXT DEFAULT NULL');
            console.log('[DB] Added weather_zip column to managed_streams');
        }
        if (!msCols2.includes('weather_detail')) {
            database.exec("ALTER TABLE managed_streams ADD COLUMN weather_detail TEXT DEFAULT 'basic'");
            console.log('[DB] Added weather_detail column to managed_streams');
        }
        if (!msCols2.includes('weather_show_location')) {
            database.exec('ALTER TABLE managed_streams ADD COLUMN weather_show_location INTEGER DEFAULT 0');
            console.log('[DB] Added weather_show_location column to managed_streams');
        }
        if (!msCols2.includes('mic_only_image')) {
            database.exec('ALTER TABLE managed_streams ADD COLUMN mic_only_image TEXT DEFAULT NULL');
            console.log('[DB] Added mic_only_image column to managed_streams');
        }
    } catch (e) { console.warn('[DB] managed_streams slot-level settings migration:', e.message); }

    // Migrate: add managed_stream_id to restream_destinations for slot-level restreaming
    try {
        const rdCols = database.pragma('table_info(restream_destinations)').map(c => c.name);
        if (!rdCols.includes('managed_stream_id')) {
            database.exec('ALTER TABLE restream_destinations ADD COLUMN managed_stream_id INTEGER REFERENCES managed_streams(id) ON DELETE SET NULL');
            database.exec('CREATE INDEX IF NOT EXISTS idx_restream_dest_managed ON restream_destinations(managed_stream_id)');
            console.log('[DB] Added managed_stream_id column to restream_destinations');
        }
    } catch (e) { console.warn('[DB] restream_destinations managed_stream_id migration:', e.message); }

    // Backfill: assign managed_stream_id to restream_destinations that still have NULL.
    // Rule: if a user has exactly ONE managed stream, auto-assign all their unbound destinations
    // to it. If they have 0 or 2+ managed streams, leave unbound rows alone (ambiguous — owner
    // must assign manually via the broadcast settings UI).
    // This is safe and idempotent; existing installs won't lose data.
    try {
        const unbound = database.prepare(`
            SELECT DISTINCT rd.user_id
            FROM restream_destinations rd
            WHERE rd.managed_stream_id IS NULL
        `).all();
        for (const { user_id } of unbound) {
            const managedStreams = database.prepare(
                'SELECT id FROM managed_streams WHERE user_id = ? ORDER BY created_at'
            ).all(user_id);
            if (managedStreams.length === 1) {
                const result = database.prepare(
                    'UPDATE restream_destinations SET managed_stream_id = ? WHERE user_id = ? AND managed_stream_id IS NULL'
                ).run(managedStreams[0].id, user_id);
                if (result.changes > 0) {
                    console.log(`[DB] Backfilled ${result.changes} restream destination(s) for user ${user_id} → managed stream ${managedStreams[0].id}`);
                }
            }
        }
    } catch (e) { console.warn('[DB] Restream destinations backfill:', e.message); }

    // Vibe-coding sessions and events
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS vibe_coding_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            managed_stream_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            session_key TEXT NOT NULL,
            slot_slug TEXT,
            workspace_name TEXT,
            machine_name TEXT,
            extension_version TEXT,
            publisher_id TEXT,
            publisher_label TEXT,
            publisher_vendor TEXT,
            publisher_client_type TEXT,
            publisher_client_name TEXT,
            publisher_client_version TEXT,
            publisher_capabilities_json TEXT,
            publisher_depth TEXT DEFAULT 'standard',
            status TEXT DEFAULT 'active' CHECK(status IN ('active', 'ended')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_event_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            ended_at DATETIME,
            FOREIGN KEY (managed_stream_id) REFERENCES managed_streams(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE (managed_stream_id, session_key)
        )`);
        database.exec('CREATE INDEX IF NOT EXISTS idx_vibe_sessions_managed ON vibe_coding_sessions(managed_stream_id)');
        database.exec('CREATE INDEX IF NOT EXISTS idx_vibe_sessions_user ON vibe_coding_sessions(user_id)');
        const vibeSessionCols = database.prepare("PRAGMA table_info('vibe_coding_sessions')").all().map((column) => column.name);
        if (!vibeSessionCols.includes('publisher_id')) database.exec('ALTER TABLE vibe_coding_sessions ADD COLUMN publisher_id TEXT');
        if (!vibeSessionCols.includes('publisher_label')) database.exec('ALTER TABLE vibe_coding_sessions ADD COLUMN publisher_label TEXT');
        if (!vibeSessionCols.includes('publisher_vendor')) database.exec('ALTER TABLE vibe_coding_sessions ADD COLUMN publisher_vendor TEXT');
        if (!vibeSessionCols.includes('publisher_client_type')) database.exec('ALTER TABLE vibe_coding_sessions ADD COLUMN publisher_client_type TEXT');
        if (!vibeSessionCols.includes('publisher_client_name')) database.exec('ALTER TABLE vibe_coding_sessions ADD COLUMN publisher_client_name TEXT');
        if (!vibeSessionCols.includes('publisher_client_version')) database.exec('ALTER TABLE vibe_coding_sessions ADD COLUMN publisher_client_version TEXT');
        if (!vibeSessionCols.includes('publisher_capabilities_json')) database.exec('ALTER TABLE vibe_coding_sessions ADD COLUMN publisher_capabilities_json TEXT');
        database.exec(`CREATE TABLE IF NOT EXISTS vibe_coding_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            managed_stream_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            stream_id INTEGER,
            session_key TEXT,
            event_id TEXT NOT NULL,
            sequence_num INTEGER DEFAULT 0,
            event_type TEXT NOT NULL,
            visibility TEXT DEFAULT 'public' CHECK(visibility IN ('public', 'streamer')),
            depth TEXT DEFAULT 'standard',
            summary TEXT DEFAULT '',
            payload_json TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (managed_stream_id) REFERENCES managed_streams(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE SET NULL,
            UNIQUE (managed_stream_id, event_id)
        )`);
        database.exec('CREATE INDEX IF NOT EXISTS idx_vibe_events_managed ON vibe_coding_events(managed_stream_id, id DESC)');
        database.exec('CREATE INDEX IF NOT EXISTS idx_vibe_events_stream ON vibe_coding_events(stream_id)');
    } catch (e) { console.warn('[DB] vibe_coding migration:', e.message); }

    console.log('[DB] Schema initialized');
    return database;
}

// ── Generic helpers ──────────────────────────────────────────

function run(sql, params = []) {
    return getDb().prepare(sql).run(...(Array.isArray(params) ? params : [params]));
}

function get(sql, params = []) {
    return getDb().prepare(sql).get(...(Array.isArray(params) ? params : [params]));
}

function all(sql, params = []) {
    return getDb().prepare(sql).all(...(Array.isArray(params) ? params : [params]));
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
        SELECT s.*, u.username, u.display_name, u.avatar_url, u.profile_color,
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

function getRecentStreams(limit = 20) {
    return all(`
        SELECT s.*, u.username, u.display_name, u.avatar_url, u.profile_color,
               v.id AS vod_id, v.is_public AS vod_is_public, v.thumbnail_url AS vod_thumbnail_url,
               v.duration_seconds AS vod_duration
        FROM streams s
        JOIN (
            SELECT user_id, MAX(ended_at) AS latest_ended_at
            FROM streams
            WHERE is_live = 0 AND ended_at IS NOT NULL
            GROUP BY user_id
        ) latest ON latest.user_id = s.user_id AND latest.latest_ended_at = s.ended_at
        JOIN users u ON s.user_id = u.id
        LEFT JOIN vods v ON v.stream_id = s.id AND COALESCE(v.is_recording, 0) = 0
        WHERE s.is_live = 0 AND s.ended_at IS NOT NULL
        ORDER BY s.ended_at DESC
        LIMIT ?
    `, [limit]);
}

function getStreamById(id) {
    return get(`
        SELECT s.*, u.username, u.display_name, u.avatar_url, u.profile_color,
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

function getLiveStreamsByUserId(userId) {
    return all(`
        SELECT s.*, u.username, u.display_name, u.avatar_url, u.profile_color,
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
        SELECT s.*, u.username, u.display_name, u.avatar_url, u.profile_color,
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
        SELECT s.*, u.username, u.display_name, u.avatar_url, u.profile_color,
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

function getStreamHistoryByManagedStream(managedStreamId, userId, limit = 20) {
    return all(`
        SELECT s.id, s.title, s.started_at, s.ended_at, s.is_live,
               s.peak_viewers, s.viewer_count, s.duration_seconds,
               s.protocol, s.category,
               v.id AS vod_id, v.file_path AS vod_file_path
        FROM streams s
        LEFT JOIN vods v ON v.stream_id = s.id
        WHERE s.managed_stream_id = ? AND s.user_id = ?
        ORDER BY s.started_at DESC
        LIMIT ?
    `, [managedStreamId, userId, limit]);
}

function createStream({ user_id, channel_id, managed_stream_id, control_config_id, title, description, category, protocol, is_nsfw, thumbnail_url }) {
    return run(
        `INSERT INTO streams (user_id, channel_id, managed_stream_id, control_config_id, title, description, category, protocol, is_nsfw, thumbnail_url, is_live, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)`,
        [user_id, channel_id || null, managed_stream_id || null, control_config_id || null, title || 'Untitled Stream', description || '', category || 'irl', protocol || 'webrtc', is_nsfw ? 1 : 0, thumbnail_url || null]
    );
}

function endStream(streamId) {
    const stream = get('SELECT started_at FROM streams WHERE id = ?', [streamId]);
    if (!stream) return null;
    return run(
        `UPDATE streams SET is_live = 0, ended_at = CURRENT_TIMESTAMP,
         duration_seconds = CAST((julianday(CURRENT_TIMESTAMP) - julianday(started_at)) * 86400 AS INTEGER)
         WHERE id = ?`,
        [streamId]
    );
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
// ── Streamer alert sounds (donation / goal-reached) ──────────
// Stored on channel_moderation_settings; url is the on-disk path (read server-side and
// broadcast as base64 to viewers, so it isn't publicly served).
function setChannelAlertSound(channelId, kind, url, mime) {
    if (!get('SELECT 1 FROM channel_moderation_settings WHERE channel_id = ?', [channelId])) {
        run('INSERT INTO channel_moderation_settings (channel_id) VALUES (?)', [channelId]);
    }
    const col = kind === 'goal' ? 'goal_sound' : 'donation_sound';
    return run(`UPDATE channel_moderation_settings SET ${col}_url = ?, ${col}_mime = ? WHERE channel_id = ?`, [url || null, mime || null, channelId]);
}
function getChannelAlertSoundsByUser(userId) {
    const ch = getChannelByUserId(userId);
    if (!ch) return {};
    return get('SELECT donation_sound_url, donation_sound_mime, goal_sound_url, goal_sound_mime FROM channel_moderation_settings WHERE channel_id = ?', [ch.id]) || {};
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
function getPastesNeedingAnalysis(limit = 5) {
    return all("SELECT * FROM pastes WHERE ai_summary IS NULL AND type IN ('paste','screenshot') ORDER BY created_at DESC LIMIT ?", [limit]);
}
// deleteAiMomentTextPastes() removed — the media subsystem (vods/clips/pastes writes) moved to OpenVibe.Media.
function updatePasteAi(pasteId, { ai_summary = null, ai_tags = null }) {
    return run('UPDATE pastes SET ai_summary = ?, ai_tags = ?, ai_analyzed_at = CURRENT_TIMESTAMP WHERE id = ?',
        [ai_summary, ai_tags ? (typeof ai_tags === 'string' ? ai_tags : JSON.stringify(ai_tags)) : null, pasteId]);
}
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
function recordAiUsage({ kind, model, input_tokens = 0, output_tokens = 0, cost_usd = 0, owner_user_id = null, source = null }) {
    return run('INSERT INTO ai_usage (kind, model, input_tokens, output_tokens, cost_usd, owner_user_id, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [kind || null, model || null, input_tokens || 0, output_tokens || 0, cost_usd || 0, owner_user_id || null, source || null]);
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
                        COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(cost_usd),0) AS cost_usd
                        FROM ai_usage WHERE created_at >= date('now', ?)`, [`-${days} days`]);
    return { byDay, byKind, totals, today: getAiCostToday() };
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
        (stream_id, user_id, vod_id, kind, start_sec, end_sec, text, label, confidence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const tx = db.transaction((list) => {
        for (const r of list) {
            if (!r || !r.stream_id || !r.kind || r.start_sec == null) continue;
            stmt.run(r.stream_id, r.user_id || null, r.vod_id || null, r.kind,
                Number(r.start_sec) || 0, r.end_sec == null ? null : Number(r.end_sec),
                r.text || null, r.label || null, r.confidence == null ? null : Number(r.confidence));
        }
    });
    try { tx(rows); return rows.length; } catch { return 0; }
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

// ── AI "crazy moments" v2: rank whole VODs by their AI overview, then mine the winner's
// timeline + transcript for its single best moment. ─────────────────────────────────────

// Every public, finished VOD that has an AI overview or a timeline — ordered by an objective
// popularity prior (views, clips taken, peak viewers) so the AI ranker sees the strongest first
// and cost stays bounded when there are many VODs.
function getVodsForMomentRanking(limit = 120) {
    try {
        return all(`
            SELECT v.id AS vod_id, v.stream_id, v.user_id, u.username, v.title,
                   COALESCE(v.ai_overview, '') AS ai_overview,
                   COALESCE(v.ai_overview_short, '') AS ai_overview_short,
                   COALESCE(v.view_count, 0) AS view_count,
                   COALESCE(NULLIF(v.duration_seconds, 0), v.probe_duration_seconds, 0) AS duration,
                   COALESCE(s.peak_viewers, 0) AS peak_viewers, v.created_at,
                   (SELECT COUNT(*) FROM clips c WHERE c.vod_id = v.id OR c.stream_id = v.stream_id) AS clip_count,
                   (SELECT COUNT(*) FROM stream_memories m WHERE m.stream_id = v.stream_id) AS memory_count
            FROM vods v
            JOIN users u ON u.id = v.user_id
            LEFT JOIN streams s ON s.id = v.stream_id
            WHERE v.is_public = 1 AND COALESCE(v.is_recording, 0) = 0 AND COALESCE(v.clips_only, 0) = 0
              AND ( (v.ai_overview IS NOT NULL AND v.ai_overview <> '')
                    OR EXISTS (SELECT 1 FROM stream_memories m WHERE m.stream_id = v.stream_id) )
            ORDER BY COALESCE(v.view_count, 0) DESC, clip_count DESC, COALESCE(s.peak_viewers, 0) DESC, v.created_at DESC
            LIMIT ?
        `, [Math.max(1, limit)]) || [];
    } catch { return []; }
}

// getRecentAutoClips() removed — the media subsystem (vods/clips/pastes writes) moved to OpenVibe.Media.

// countAutoClipsSince() removed — the media subsystem (vods/clips/pastes writes) moved to OpenVibe.Media.

// Live chat-velocity window: message-count buckets over the last `windowSec`, each with a
// representative epoch timestamp — used to detect a "everyone reacted" spike and locate WHEN.
function getLiveChatBuckets(streamId, windowSec = 150, bucketSec = 15) {
    try {
        const rows = all(`
            SELECT CAST(strftime('%s', cm.timestamp) / ? AS INT) AS b,
                   COUNT(*) AS n,
                   MIN(CAST(strftime('%s', cm.timestamp) AS INT)) AS ts
            FROM chat_messages cm
            WHERE cm.stream_id = ? AND COALESCE(cm.is_deleted, 0) = 0
              AND cm.timestamp >= datetime('now', ?)
            GROUP BY b ORDER BY ts ASC`, [bucketSec, streamId, `-${windowSec} seconds`]) || [];
        return rows.map(r => ({ count: r.n, tsEpoch: r.ts }));
    } catch { return []; }
}

// Recent chat message texts for a stream (AI context for the live auto-clipper — what people
// were actually saying/reacting to around a spike).
function getRecentChatText(streamId, sinceSec = 120, limit = 40) {
    try {
        const rows = all(`SELECT message FROM chat_messages
            WHERE stream_id = ? AND COALESCE(is_deleted, 0) = 0 AND message IS NOT NULL AND message <> ''
              AND timestamp >= datetime('now', ?)
            ORDER BY timestamp DESC LIMIT ?`, [streamId, `-${Math.max(1, sinceSec)} seconds`, Math.max(1, limit)]) || [];
        return rows.map(r => String(r.message)).reverse();
    } catch { return []; }
}

// Eligible finished VODs that do NOT yet have an auto-generated clip — the work-list for the
// historical auto-clip backfill. Requires a timeline (memories) so Stage-2 can find a moment.
// Best-first by views so the most-watched history gets clipped first. Idempotent.
function getVodsWithoutAutoClip(limit = 20) {
    try {
        return all(`
            SELECT v.id AS vod_id, v.stream_id, v.user_id, u.username, v.title,
                   COALESCE(NULLIF(v.duration_seconds, 0), v.probe_duration_seconds, 0) AS duration,
                   COALESCE(v.ai_overview, '') AS ai_overview, COALESCE(v.ai_overview_short, '') AS ai_overview_short,
                   COALESCE(v.view_count, 0) AS view_count
            FROM vods v JOIN users u ON u.id = v.user_id
            WHERE v.is_public = 1 AND COALESCE(v.is_recording, 0) = 0 AND COALESCE(v.clips_only, 0) = 0
              AND EXISTS (SELECT 1 FROM stream_memories m WHERE m.stream_id = v.stream_id)
              AND NOT EXISTS (SELECT 1 FROM clips c WHERE (c.vod_id = v.id OR c.stream_id = v.stream_id)
                              AND COALESCE(c.auto_generated, 0) = 1)
            ORDER BY COALESCE(v.view_count, 0) DESC, v.created_at DESC
            LIMIT ?
        `, [Math.max(1, limit)]) || [];
    } catch { return []; }
}

// Timestamps (seconds into the VOD) that viewers CLIPPED — the strongest "this was a moment"
// signal we have.
function getClipStartTimesForStream(streamId, vodId) {
    try {
        return (all(`SELECT start_time FROM clips WHERE (stream_id = ? OR vod_id = ?) AND start_time > 0 ORDER BY start_time`,
            [streamId, vodId || -1]) || []).map(r => Math.floor(r.start_time));
    } catch { return []; }
}

// Chat-message spikes: the busiest time-buckets of a stream (offset seconds → message count),
// a proxy for "everyone reacted here". Offsets are relative to the stream's start.
function getChatSpikeOffsets(streamId, bucketSec = 30, topN = 8) {
    try {
        const rows = all(`
            SELECT CAST((julianday(cm.timestamp) - julianday(s.started_at)) * 86400 / ? AS INT) AS bucket,
                   COUNT(*) AS n
            FROM chat_messages cm JOIN streams s ON s.id = cm.stream_id
            WHERE cm.stream_id = ? AND s.started_at IS NOT NULL AND cm.timestamp >= s.started_at
              AND COALESCE(cm.is_deleted, 0) = 0
            GROUP BY bucket HAVING bucket >= 0 ORDER BY n DESC LIMIT ?`, [bucketSec, streamId, topN]) || [];
        return rows.map(r => ({ offset: r.bucket * bucketSec, count: r.n }));
    } catch { return []; }
}

// Candidate memories for the daily AI "crazy moments" picker: recent, substantive, and from
// a stream that has a public VOD (so we can link + extract the moment frame).
function getAiMomentCandidates(days = 30, limit = 150) {
    try {
        // Only mine FINISHED streams (real VOD history) — never the currently-live
        // stream, so we don't spam the pastes tab with live frames. The picked VOD is the
        // recording of that same session, so offset_seconds lines up with its timeline;
        // vod_duration lets the caller drop offsets that fall past the VOD's end.
        return all(`
            SELECT m.id AS memory_id, m.stream_id, m.offset_seconds, m.description, m.tags,
                   m.thumbnail_url, m.user_id, s.title AS stream_title, s.peak_viewers, u.username,
                   (SELECT v.id FROM vods v WHERE v.stream_id = m.stream_id
                      AND COALESCE(v.is_public, 1) = 1 AND COALESCE(v.is_recording, 0) = 0
                      ORDER BY v.id DESC LIMIT 1) AS vod_id,
                   (SELECT COALESCE(NULLIF(v.duration_seconds, 0), v.probe_duration_seconds, 0)
                      FROM vods v WHERE v.stream_id = m.stream_id
                      AND COALESCE(v.is_recording, 0) = 0 ORDER BY v.id DESC LIMIT 1) AS vod_duration,
                   (SELECT COALESCE(v.view_count, 0) FROM vods v WHERE v.stream_id = m.stream_id
                      AND COALESCE(v.is_recording, 0) = 0 ORDER BY v.id DESC LIMIT 1) AS vod_views
            FROM stream_memories m
            JOIN users u ON u.id = m.user_id
            JOIN streams s ON s.id = m.stream_id
            WHERE m.description IS NOT NULL AND length(m.description) > 45
              AND m.created_at >= datetime('now', ?)
              AND COALESCE(s.is_live, 0) = 0 AND s.ended_at IS NOT NULL
            ORDER BY COALESCE(s.peak_viewers, 0) DESC, length(m.description) DESC, m.created_at DESC
            LIMIT ?
        `, [`-${Math.max(1, days)} days`, limit]) || [];
    } catch { return []; }
}
// A user's pastes including AI fields (the explorer + overview want ai_summary/ai_tags).
function getUserPastesForAi(userId, limit = 30) {
    return all(`SELECT id, slug, type, title, ai_summary, ai_tags, ai_analyzed_at, created_at
                FROM pastes WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`, [userId, limit]);
}
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
function assembleStreamerAiTimeline(userId) {
    let overview = null;
    try { overview = get('SELECT overview, overview_short, generated_at FROM streamer_overviews WHERE user_id = ?', [userId]) || null; } catch { /* */ }

    let sessions = [];
    try {
        const streams = all(`
            SELECT s.id, s.title, s.ai_title, s.started_at, s.ended_at, s.created_at, s.duration_seconds,
                   s.ai_overview, s.ai_overview_short, s.thumbnail_url, s.peak_viewers, s.category,
                   (SELECT v.id FROM vods v WHERE v.stream_id = s.id AND COALESCE(v.is_recording, 0) = 0
                      ORDER BY COALESCE(v.is_public, 1) DESC, v.id DESC LIMIT 1) AS vod_id,
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
            return { ...s, memories, word_count: wordCount, has_transcript: hasTranscript };
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

// Lazy, TTL-cached accessor: re-assemble only when the tab is viewed AND the cache is stale.
function getStreamerAiTimeline(userId, ttlMs = 15 * 60 * 1000) {
    try {
        const row = get('SELECT payload, generated_at FROM ai_timeline_cache WHERE user_id = ?', [userId]);
        if (row && row.payload) {
            const age = Date.now() - Date.parse((row.generated_at || '').replace(' ', 'T') + 'Z');
            if (!(age > ttlMs) && !Number.isNaN(age)) {
                try { return { ...JSON.parse(row.payload), cached: true }; } catch { /* rebuild */ }
            }
        }
    } catch { /* rebuild */ }
    const fresh = assembleStreamerAiTimeline(userId);
    try {
        run(`INSERT INTO ai_timeline_cache (user_id, payload, generated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, generated_at = CURRENT_TIMESTAMP`,
            [userId, JSON.stringify(fresh)]);
    } catch { /* cache is best-effort */ }
    return { ...fresh, cached: false };
}
function getAllStreamerOverviews(limit = 100) {
    return all(`SELECT o.*, u.username, u.display_name
                FROM streamer_overviews o JOIN users u ON u.id = o.user_id
                ORDER BY o.generated_at DESC LIMIT ?`, [limit]);
}
// Streamers whose aggregate AI overview is DUE for (re)generation. A "decent"
// overview (>= decentLen chars) refreshes at most every 12h; a sparse/missing one
// retries hourly until it fills out. Only streamers with some signal (memories or
// VODs) are considered, so we never spend calls on users with nothing to summarize.
function getStreamersNeedingOverview({ decentLen = 220, limit = 4 } = {}) {
    return all(`
        SELECT u.id AS user_id
        FROM users u
        LEFT JOIN streamer_overviews o ON o.user_id = u.id
        WHERE (
                EXISTS (SELECT 1 FROM stream_memories m WHERE m.user_id = u.id)
             OR EXISTS (SELECT 1 FROM vods v WHERE v.user_id = u.id)
              )
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
        [user_id, channel_id || null, slug || null, title || 'Untitled Stream', description || '', category || 'irl', protocol || 'webrtc', streaming_method || null, stream_key, is_nsfw ? 1 : 0, control_config_id || null]
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
                       'vod_thumbnail', (SELECT v.thumbnail_url FROM vods v JOIN streams s3 ON v.stream_id = s3.id WHERE s3.managed_stream_id = ms2.id AND COALESCE(v.is_recording, 0) = 0 AND v.is_public = 1 ORDER BY v.created_at DESC LIMIT 1)
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

function getRecentVods(limit = 12, offset = 0) {
    return all(`
        SELECT v.*, u.username, u.display_name, u.avatar_url, u.profile_color,
               s.protocol AS stream_protocol, s.peak_viewers AS stream_peak_viewers,
               ms.slug AS managed_stream_slug, ms.id AS managed_stream_id
        FROM vods v
        JOIN users u ON v.user_id = u.id
        LEFT JOIN streams s ON v.stream_id = s.id
        LEFT JOIN managed_streams ms ON s.managed_stream_id = ms.id
        WHERE v.is_public = 1 AND COALESCE(v.is_recording, 0) = 0
        ORDER BY v.created_at DESC
        LIMIT ? OFFSET ?
    `, [limit, offset]);
}

function countRecentVods() {
    return get(`
        SELECT COUNT(*) AS count FROM vods
        WHERE is_public = 1 AND COALESCE(is_recording, 0) = 0
    `)?.count || 0;
}

// Public-facing site totals for the home hero stats bar.
let _homeStatsCache = null;
let _homeStatsCacheAt = 0;
const _HOME_STATS_TTL = 30 * 1000; // 30s memo so the windowed COUNTs don't hammer SQLite

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
    // Rolling day/week/month counts for a table by its timestamp column.
    const winCount = (table, col, extra = '') => {
        const q = (w) => c(`SELECT COUNT(*) AS count FROM ${table} WHERE ${col} >= datetime('now', ?)${extra ? ' AND ' + extra : ''}`, [w]);
        return { d: q('-1 day'), w: q('-7 days'), m: q('-30 days') };
    };
    const hoursSince = (w) => Math.round(c(`SELECT COALESCE(SUM(duration_seconds), 0) AS count FROM vods WHERE COALESCE(is_recording, 0) = 0 AND created_at >= datetime('now', ?)`, [w]) / 3600);
    return {
        vods: c(`SELECT COUNT(*) AS count FROM vods WHERE is_public = 1 AND COALESCE(is_recording, 0) = 0`),
        clips: c(`SELECT COUNT(*) AS count FROM clips WHERE COALESCE(is_public, 1) = 1`),
        liveSessions: c(`SELECT COUNT(*) AS count FROM streams`),
        streamers: c(`SELECT COUNT(DISTINCT user_id) AS count FROM streams WHERE user_id IS NOT NULL`),
        chatMessages: c(`SELECT COUNT(*) AS count FROM chat_messages`),
        users: c(`SELECT COUNT(*) AS count FROM users WHERE COALESCE(is_banned, 0) = 0`),
        anons: c(`SELECT COUNT(*) AS count FROM anon_ip_mappings`),
        follows: c(`SELECT COUNT(*) AS count FROM follows`),
        emotes: c(`SELECT COUNT(*) AS count FROM emotes`),
        pastes: c(`SELECT COUNT(*) AS count FROM pastes`),
        aiMemories: c(`SELECT COUNT(*) AS count FROM stream_memories`),
        pasteImages: c(`SELECT COUNT(*) AS count FROM pastes WHERE type = 'screenshot'`),
        pasteText: c(`SELECT COUNT(*) AS count FROM pastes WHERE COALESCE(type, 'paste') <> 'screenshot'`),
        // Total hours of video the platform has archived (VODs, excluding in-progress recordings).
        streamHours: Math.round(c(`SELECT COALESCE(SUM(duration_seconds), 0) AS count FROM vods WHERE COALESCE(is_recording, 0) = 0`) / 3600),
        // Active chatters this week across EVERYONE — registered users, anons, and relay chatters.
        weeklyActive: c(`SELECT COUNT(*) AS count FROM (
                            SELECT DISTINCT 'u' || user_id AS id FROM chat_messages
                              WHERE user_id IS NOT NULL AND COALESCE(is_deleted, 0) = 0 AND timestamp >= datetime('now', '-7 days')
                            UNION
                            SELECT DISTINCT 'a' || anon_id FROM chat_messages
                              WHERE anon_id IS NOT NULL AND COALESCE(is_deleted, 0) = 0 AND timestamp >= datetime('now', '-7 days')
                            UNION
                            SELECT DISTINCT 'r' || source_platform || '|' || username FROM chat_messages
                              WHERE source_platform IS NOT NULL AND source_platform <> '' AND COALESCE(is_deleted, 0) = 0 AND timestamp >= datetime('now', '-7 days')
                         )`),
        // New unique visitors this week (first-seen anon fingerprints) — a proxy for people who
        // showed up, not just those who chatted.
        weeklyVisitors: c(`SELECT COUNT(*) AS count FROM anon_ip_mappings WHERE created_at >= datetime('now', '-7 days')`),
        liveNow: c(`SELECT COUNT(*) AS count FROM streams WHERE is_live = 1`),
        // Rolling last-day / week / month deltas ({ d, w, m }) for the hero stat tooltips + subs.
        recent: {
            users: winCount('users', 'created_at', 'COALESCE(is_banned, 0) = 0'),
            anons: winCount('anon_ip_mappings', 'created_at'),
            sessions: winCount('streams', 'created_at'),
            vods: winCount('vods', 'created_at', 'is_public = 1 AND COALESCE(is_recording, 0) = 0'),
            clips: winCount('clips', 'created_at', 'COALESCE(is_public, 1) = 1'),
            aiMoments: winCount('stream_memories', 'created_at'),
            messages: winCount('chat_messages', 'timestamp', 'COALESCE(is_deleted, 0) = 0'),
            hours: { d: hoursSince('-1 day'), w: hoursSince('-7 days'), m: hoursSince('-30 days') },
        },
    };
}

function getVodsByUserFiltered(userId, { includePrivate = false, managedStreamId = null, orderBy = 'newest', limit = 12, offset = 0 } = {}) {
    // COALESCE(v.clips_only,0)=0 hides ephemeral clips-only recordings (they're deleted on
    // stream end; this guards against a rare orphan surviving a crash before cleanup).
    const conditions = ['v.user_id = ?', 'COALESCE(v.is_recording, 0) = 0', 'COALESCE(v.clips_only, 0) = 0'];
    const params = [userId];

    if (!includePrivate) {
        conditions.push('v.is_public = 1');
    }
    if (managedStreamId) {
        conditions.push('s.managed_stream_id = ?');
        params.push(managedStreamId);
    }

    const orderClauses = {
        newest: 'v.created_at DESC',
        oldest: 'v.created_at ASC',
        views: 'v.view_count DESC, v.created_at DESC',
        peak_viewers: 's.peak_viewers DESC, v.created_at DESC',
    };
    const order = orderClauses[orderBy] || orderClauses.newest;

    params.push(limit, offset);
    return all(`
        SELECT v.*, u.username, u.display_name, u.avatar_url,
               s.protocol AS stream_protocol, s.peak_viewers AS stream_peak_viewers,
               ms.slug AS managed_stream_slug, ms.id AS ms_id, ms.title AS ms_title
        FROM vods v
        JOIN users u ON v.user_id = u.id
        LEFT JOIN streams s ON v.stream_id = s.id
        LEFT JOIN managed_streams ms ON s.managed_stream_id = ms.id
        WHERE ${conditions.join(' AND ')}
        ORDER BY ${order}
        LIMIT ? OFFSET ?
    `, params);
}

// Most-popular RECENT VOD/clip for a streamer — highest view_count within the last
// week, else the last month, else all-time. Powers the offline-screen "explore" cards.
function getPopularVodForUser(userId) {
    const base = `SELECT v.*, u.username, u.display_name, u.avatar_url, u.profile_color
                  FROM vods v JOIN users u ON v.user_id = u.id
                  WHERE v.user_id = ? AND v.is_public = 1 AND COALESCE(v.is_recording,0)=0`;
    for (const win of ['-7 days', '-1 month', null]) {
        const sql = base + (win ? ` AND v.created_at >= datetime('now', ?)` : '') + ` ORDER BY v.view_count DESC, v.created_at DESC LIMIT 1`;
        const row = get(sql, win ? [userId, win] : [userId]);
        if (row) return row;
    }
    return null;
}
function getPopularClipForUser(userId) {
    // Clips taken OF this streamer's streams (regardless of who clipped them).
    const base = `SELECT c.*, su.username, su.display_name, su.avatar_url, su.profile_color
                  FROM clips c
                  JOIN streams s ON c.stream_id = s.id
                  JOIN users su ON s.user_id = su.id
                  WHERE s.user_id = ? AND c.is_public = 1`;
    for (const win of ['-7 days', '-1 month', null]) {
        const sql = base + (win ? ` AND c.created_at >= datetime('now', ?)` : '') + ` ORDER BY c.view_count DESC, c.created_at DESC LIMIT 1`;
        const row = get(sql, win ? [userId, win] : [userId]);
        if (row) return row;
    }
    return null;
}

// Single most-viewed VOD / clip within a time window (win = "-7 days" | "-1 month" | null=all-time).
function _topVodForUser(userId, win) {
    const sql = `SELECT v.*, u.username, u.display_name, u.avatar_url, u.profile_color
                 FROM vods v JOIN users u ON v.user_id = u.id
                 WHERE v.user_id = ? AND v.is_public = 1 AND COALESCE(v.is_recording,0)=0 AND COALESCE(v.clips_only,0)=0`
        + (win ? ` AND v.created_at >= datetime('now', ?)` : '')
        + ` ORDER BY v.view_count DESC, v.created_at DESC LIMIT 1`;
    return get(sql, win ? [userId, win] : [userId]) || null;
}
function _topClipForUser(userId, win) {
    const sql = `SELECT c.*, su.username, su.display_name, su.avatar_url, su.profile_color
                 FROM clips c JOIN streams s ON c.stream_id = s.id JOIN users su ON s.user_id = su.id
                 WHERE s.user_id = ? AND c.is_public = 1`
        + (win ? ` AND c.created_at >= datetime('now', ?)` : '')
        + ` ORDER BY c.view_count DESC, c.created_at DESC LIMIT 1`;
    return get(sql, win ? [userId, win] : [userId]) || null;
}
// Top VOD + top clip for each of week / month / all-time, for the offline-screen cycler.
function getTopContentRanges(userId) {
    const out = {};
    for (const [key, win] of [['week', '-7 days'], ['month', '-1 month'], ['all', null]]) {
        out[key] = { vod: _topVodForUser(userId, win), clip: _topClipForUser(userId, win) };
    }
    return out;
}
function countVodsByUserFiltered(userId, { includePrivate = false, managedStreamId = null } = {}) {
    const conditions = ['v.user_id = ?', 'COALESCE(v.is_recording, 0) = 0', 'COALESCE(v.clips_only, 0) = 0'];
    const params = [userId];
    if (!includePrivate) conditions.push('v.is_public = 1');
    if (managedStreamId) {
        conditions.push('s.managed_stream_id = ?');
        params.push(managedStreamId);
    }
    return get(`
        SELECT COUNT(*) AS count
        FROM vods v
        LEFT JOIN streams s ON v.stream_id = s.id
        WHERE ${conditions.join(' AND ')}
    `, params)?.count || 0;
}

function getClipsOfUserStreamsPaginated(userId, limit = 12, offset = 0) {
    return all(`
        SELECT c.*, u.username AS clip_creator_username, u.display_name AS clip_creator_display_name, u.avatar_url AS clip_creator_avatar,
               s.title AS stream_title, s.started_at AS stream_started_at, s.protocol AS stream_protocol,
               su.username AS streamer_username, su.display_name AS streamer_display_name
        FROM clips c
        JOIN users u ON c.user_id = u.id
        JOIN streams s ON c.stream_id = s.id
        JOIN users su ON s.user_id = su.id
        WHERE s.user_id = ? AND c.is_public = 1
        ORDER BY c.created_at DESC
        LIMIT ? OFFSET ?
    `, [userId, limit, offset]);
}

function countClipsOfUserStreams(userId) {
    return get(`
        SELECT COUNT(*) AS count
        FROM clips c
        JOIN streams s ON c.stream_id = s.id
        WHERE s.user_id = ? AND c.is_public = 1
    `, [userId])?.count || 0;
}

function getClipsByUserPaginated(userId, includePrivate = false, limit = 12, offset = 0) {
    const publicFilter = includePrivate ? '' : 'AND c.is_public = 1';
    return all(`
        SELECT c.*, u.username, u.display_name, u.avatar_url, u.is_owner AS owner_is_owner,
               s.title AS stream_title, s.started_at AS stream_started_at, s.protocol AS stream_protocol,
               su.username AS streamer_username, su.display_name AS streamer_display_name, su.avatar_url AS streamer_avatar_url,
               su.is_owner AS streamer_is_owner
        FROM clips c
        JOIN users u ON c.user_id = u.id
        LEFT JOIN streams s ON c.stream_id = s.id
        LEFT JOIN users su ON s.user_id = su.id
        WHERE c.user_id = ? ${publicFilter}
        ORDER BY c.created_at DESC
        LIMIT ? OFFSET ?
    `, [userId, limit, offset]);
}

// ── Channel helpers ──────────────────────────────────────────

function getChannelByUserId(userId) {
    return get('SELECT * FROM channels WHERE user_id = ?', [userId]);
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
        [user_id, title || 'Untitled Channel', description || '', category || 'irl', protocol || 'webrtc']
    );
}

function updateChannel(userId, fields) {
    const updates = [];
    const params = [];
    for (const [key, val] of Object.entries(fields)) {
        if (val !== undefined && ['title', 'description', 'category', 'tags', 'protocol', 'is_nsfw', 'force_nsfw', 'auto_record', 'vod_recording_enabled', 'force_vod_recording_disabled', 'offline_banner_url', 'panels', 'emote_sources', 'weather_zip', 'weather_detail', 'weather_show_location', 'control_mode', 'anon_controls_enabled', 'control_rate_limit_ms', 'active_control_config_id', 'video_click_enabled', 'offline_screen_type', 'offline_screen_url', 'offline_html', 'offline_css', 'hide_ai_overview', 'ai_overview_pref'].includes(key)) {
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
    // Account-level default row (no slot binding)
    return get('SELECT * FROM robotstreamer_integrations WHERE user_id = ? AND managed_stream_id IS NULL', [userId]);
}

function getRobotStreamerIntegrationBySlot(userId, managedStreamId) {
    if (!managedStreamId) return null;
    return get('SELECT * FROM robotstreamer_integrations WHERE user_id = ? AND managed_stream_id = ?', [userId, managedStreamId]);
}

function getRobotStreamerIntegrationForStream(userId, managedStreamId) {
    // Slot-specific config wins; fall back to the account-level default row
    return (managedStreamId ? getRobotStreamerIntegrationBySlot(userId, managedStreamId) : null)
        || getRobotStreamerIntegrationByUserId(userId);
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
    const slotId = managedStreamId || null;
    const existing = slotId
        ? getRobotStreamerIntegrationBySlot(userId, slotId)
        : getRobotStreamerIntegrationByUserId(userId);
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

    return slotId
        ? getRobotStreamerIntegrationBySlot(userId, slotId)
        : getRobotStreamerIntegrationByUserId(userId);
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
         custom_video_bitrate, custom_audio_bitrate, custom_fps, custom_encoder_preset, channel_url, chat_relay, powerchat_relay, powerchat_count_views)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, fields.managed_stream_id || null, fields.platform, fields.name || null, fields.server_url || null,
         fields.stream_key || null, fields.enabled ?? 1, fields.auto_start ?? 0,
         fields.quality_preset || 'auto',
         fields.custom_video_bitrate ?? null, fields.custom_audio_bitrate ?? null,
         fields.custom_fps ?? null, fields.custom_encoder_preset || null,
         fields.channel_url || null, fields.chat_relay ? 1 : 0, fields.powerchat_relay === 0 ? 0 : 1, fields.powerchat_count_views === 0 ? 0 : 1]
    );
    return get('SELECT * FROM restream_destinations WHERE id = ?', [result.lastInsertRowid]);
}

function updateRestreamDestination(id, fields) {
    const allowed = new Set(['name', 'server_url', 'stream_key', 'enabled', 'auto_start', 'quality_preset',
        'custom_video_bitrate', 'custom_audio_bitrate', 'custom_fps', 'custom_encoder_preset',
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

// ── Platform OAuth connection helpers ────────────────────────

// ── Per-streamer channel points ("OpenCoins") ──
function getChannelPoints(userId, streamerId) {
    if (!userId || !streamerId) return 0;
    const r = get('SELECT balance FROM channel_points WHERE user_id = ? AND streamer_id = ?', [userId, streamerId]);
    return r ? r.balance : 0;
}
function addChannelPoints(userId, streamerId, amount) {
    if (!userId || !streamerId || !amount) return getChannelPoints(userId, streamerId);
    run(`INSERT INTO channel_points (user_id, streamer_id, balance, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id, streamer_id) DO UPDATE SET
            balance = balance + excluded.balance, updated_at = CURRENT_TIMESTAMP`,
        [userId, streamerId, amount]);
    return getChannelPoints(userId, streamerId);
}
// Atomic spend — returns true only if the viewer had enough for this streamer.
function deductChannelPoints(userId, streamerId, amount) {
    if (!userId || !streamerId) return false;
    const res = run(`UPDATE channel_points SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP
                     WHERE user_id = ? AND streamer_id = ? AND balance >= ?`,
        [amount, userId, streamerId, amount]);
    return (res?.changes || 0) > 0;
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

// ── Chat helpers ─────────────────────────────────────────────

function saveChatMessage({ stream_id, channel_user_id, user_id, anon_id, username, message, message_type, is_global, reply_to_id, source_platform, auto_delete_at, metadata }) {
    // channel_user_id = the broadcaster's user id — set for all channel/stream
    // messages so a streamer's chat history survives across sessions AND offline
    // periods (independent of the live-session stream row's lifetime).
    let chanUid = channel_user_id || null;
    if (!chanUid && stream_id) { try { chanUid = getStreamById(stream_id)?.user_id || null; } catch { /* ignore */ } }
    const metaStr = metadata == null ? null : (typeof metadata === 'string' ? metadata : JSON.stringify(metadata));
    return run(
        `INSERT INTO chat_messages (stream_id, channel_user_id, user_id, anon_id, username, message, message_type, is_global, reply_to_id, source_platform, auto_delete_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [stream_id, chanUid, user_id || null, anon_id || null, username, message, message_type || 'chat', is_global ? 1 : 0, reply_to_id || null, source_platform || null, auto_delete_at || null, metaStr]
    );
}

function searchChatMessages({ query, userId, anonId, username, streamId, limit = 50, offset = 0 }) {
    let sql = `SELECT cm.*, u.display_name, u.username as u_username, u.role, u.avatar_url, u.profile_color
               FROM chat_messages cm
               LEFT JOIN users u ON cm.user_id = u.id
               WHERE cm.is_deleted = 0
                 AND (cm.auto_delete_at IS NULL OR datetime(cm.auto_delete_at) > CURRENT_TIMESTAMP)`;
    const params = [];

    if (query) {
        sql += ` AND cm.message LIKE ?`;
        params.push(`%${query}%`);
    }
    if (userId) {
        sql += ` AND cm.user_id = ?`;
        params.push(userId);
    }
    if (anonId) {
        sql += ` AND cm.anon_id = ?`;
        params.push(anonId);
    }
    if (username) {
        sql += ` AND LOWER(u.username) LIKE ?`;
        params.push(`%${username.toLowerCase()}%`);
    }
    if (streamId) {
        sql += ` AND cm.stream_id = ?`;
        params.push(streamId);
    }

    const countSql = sql.replace(/SELECT cm\.\*.*FROM/, 'SELECT COUNT(*) as c FROM');
    const total = get(countSql, params)?.c || 0;

    sql += ` ORDER BY cm.timestamp DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    return { messages: all(sql, params), total };
}

function getUserChatHistory(userId, limit = 50, offset = 0) {
    const sql = `SELECT cm.*, s.title as stream_title
                 FROM chat_messages cm
                 LEFT JOIN streams s ON cm.stream_id = s.id
                 WHERE cm.user_id = ? AND cm.is_deleted = 0
                   AND (cm.auto_delete_at IS NULL OR datetime(cm.auto_delete_at) > CURRENT_TIMESTAMP)
                 ORDER BY cm.timestamp DESC LIMIT ? OFFSET ?`;
    const messages = all(sql, [userId, limit, offset]);
    const total = get(
        `SELECT COUNT(*) as c FROM chat_messages
         WHERE user_id = ? AND is_deleted = 0
           AND (auto_delete_at IS NULL OR datetime(auto_delete_at) > CURRENT_TIMESTAMP)`,
        [userId]
    )?.c || 0;
    return { messages, total };
}

// ── Chat AI summaries (global overview/timeline + per-user insights) ──────────
// Messages worth analyzing: real chat, exclude system noise + deleted + expired.
const _CHAT_AI_WHERE = `cm.is_deleted = 0 AND cm.message_type != 'system'
    AND COALESCE(cm.source_platform,'') != 'ai'
    AND (cm.auto_delete_at IS NULL OR datetime(cm.auto_delete_at) > CURRENT_TIMESTAMP)`;

function getMaxChatMessageId() {
    return get('SELECT MAX(id) AS m FROM chat_messages')?.m || 0;
}

// Count analyzable messages newer than a high-water id (optionally for one user).
function countChatMessagesSince(afterId, userId = null) {
    let sql = `SELECT COUNT(*) AS c FROM chat_messages cm WHERE ${_CHAT_AI_WHERE} AND cm.id > ?`;
    const params = [afterId || 0];
    if (userId) { sql += ' AND cm.user_id = ?'; params.push(userId); }
    return get(sql, params)?.c || 0;
}

// Fetch analyzable messages for AI batching (with the channel/broadcaster label).
// order 'asc' for chronological batches; 'desc'+limit for "most recent N".
function getChatMessagesForAi({ afterId = null, sinceTs = null, userId = null, limit = 400, order = 'asc' } = {}) {
    let sql = `SELECT cm.id, cm.user_id, cm.username, cm.message, cm.message_type, cm.timestamp,
                      cm.stream_id, cm.channel_user_id, cm.is_global,
                      ch.username AS channel_username, ch.display_name AS channel_display
               FROM chat_messages cm
               LEFT JOIN users ch ON cm.channel_user_id = ch.id
               WHERE ${_CHAT_AI_WHERE}`;
    const params = [];
    if (afterId != null) { sql += ' AND cm.id > ?'; params.push(afterId); }
    if (sinceTs != null) { sql += ' AND cm.timestamp >= ?'; params.push(sinceTs); }
    if (userId) { sql += ' AND cm.user_id = ?'; params.push(userId); }
    sql += ` ORDER BY cm.id ${order === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`;
    params.push(Math.max(1, Math.min(2000, limit)));
    const rows = all(sql, params);
    return order === 'desc' ? rows.reverse() : rows;
}

// Timestamp of the Nth-most-recent analyzable message — drives the adaptive
// overview window (busy chat → short window, quiet → wide). Optionally per-user.
function getNthRecentChatTs(n, userId = null) {
    let sql = `SELECT cm.timestamp AS ts FROM chat_messages cm WHERE ${_CHAT_AI_WHERE}`;
    const params = [];
    if (userId) { sql += ' AND cm.user_id = ?'; params.push(userId); }
    sql += ' ORDER BY cm.id DESC LIMIT 1 OFFSET ?';
    params.push(Math.max(0, (n | 0) - 1));
    return get(sql, params)?.ts || null;
}

function getChatAiSummary(scope, subjectId, window) {
    return get('SELECT * FROM chat_ai_summaries WHERE scope = ? AND subject_id = ? AND window = ?',
        [scope, subjectId || 0, window]) || null;
}
// Append AI timeline "notable moments" to the growing log (deduped by scope+ts+label).
// ── Per-user TTS voice overrides (admin-set) ─────────────────
function getTtsVoiceOverride(identityKey) {
    try {
        const k = String(identityKey || '').trim().toLowerCase();
        if (!k) return null;
        const r = get('SELECT voice, pitch, speed, gap FROM tts_voice_overrides WHERE identity_key = ?', [k]);
        if (!r) return null;
        return { voice: r.voice, pitch: r.pitch, speed: r.speed, gap: r.gap || 0 };
    } catch { return null; }
}
function setTtsVoiceOverride(identityKey, params, setBy) {
    const k = String(identityKey || '').trim().toLowerCase();
    if (!k) return false;
    run(`INSERT INTO tts_voice_overrides (identity_key, voice, pitch, speed, gap, set_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(identity_key) DO UPDATE SET voice=excluded.voice, pitch=excluded.pitch,
             speed=excluded.speed, gap=excluded.gap, set_by=excluded.set_by, updated_at=CURRENT_TIMESTAMP`,
        [k, params.voice, params.pitch, params.speed, params.gap || 0, setBy || null]);
    return true;
}
function deleteTtsVoiceOverride(identityKey) {
    try { run('DELETE FROM tts_voice_overrides WHERE identity_key = ?', [String(identityKey || '').trim().toLowerCase()]); return true; } catch { return false; }
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

function addChatTimelineEvents(scope, subjectId, events) {
    if (!Array.isArray(events) || !events.length) return 0;
    let n = 0;
    for (const e of events) {
        if (!e || !e.label || !e.ts) continue;
        try {
            run('INSERT OR IGNORE INTO chat_timeline_events (scope, subject_id, ts, label, detail) VALUES (?, ?, ?, ?, ?)',
                [scope || 'global', subjectId || 0, e.ts, String(e.label).slice(0, 120), String(e.detail || '').slice(0, 400)]);
            n++;
        } catch { /* */ }
    }
    return n;
}
// Paginated + searchable timeline browse. `before` = epoch ms (exclusive upper bound); `q`
// filters label/detail; `since` = epoch ms lower bound (for period jumps). Newest first.
function getChatTimelineEvents({ scope = 'global', subjectId = 0, before = null, since = null, q = null, limit = 25 } = {}) {
    const conds = ['scope = ?', 'subject_id = ?'];
    const params = [scope, subjectId || 0];
    if (before) { conds.push("ts < datetime(?, 'unixepoch')"); params.push(Math.floor(before / 1000)); }
    if (since) { conds.push("ts >= datetime(?, 'unixepoch')"); params.push(Math.floor(since / 1000)); }
    if (q && String(q).trim()) { const like = '%' + String(q).trim().slice(0, 60) + '%'; conds.push('(label LIKE ? OR detail LIKE ?)'); params.push(like, like); }
    params.push(Math.min(60, Math.max(1, limit)));
    try {
        return all(`SELECT id, ts, label, detail FROM chat_timeline_events WHERE ${conds.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT ?`, params) || [];
    } catch { return []; }
}
function getChatAiSummaries(scope, subjectId) {
    return all('SELECT * FROM chat_ai_summaries WHERE scope = ? AND subject_id = ? ORDER BY window',
        [scope, subjectId || 0]);
}
function upsertChatAiSummary(sfx) {
    const {
        scope, subject_id = 0, window, overview = '', memory_json = '', timeline_json = '[]',
        message_count = 0, window_message_count = 0, last_message_id = 0,
        window_label = '', window_start = null, window_end = null,
    } = sfx;
    return run(
        `INSERT INTO chat_ai_summaries
            (scope, subject_id, window, overview, memory_json, timeline_json, message_count,
             window_message_count, last_message_id, window_label, window_start, window_end, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(scope, subject_id, window) DO UPDATE SET
            overview = excluded.overview,
            memory_json = excluded.memory_json,
            timeline_json = excluded.timeline_json,
            message_count = excluded.message_count,
            window_message_count = excluded.window_message_count,
            last_message_id = excluded.last_message_id,
            window_label = excluded.window_label,
            window_start = excluded.window_start,
            window_end = excluded.window_end,
            updated_at = CURRENT_TIMESTAMP`,
        [scope, subject_id || 0, window, overview, memory_json, timeline_json, message_count,
         window_message_count, last_message_id, window_label, window_start, window_end]
    );
}

// Users with enough new chat activity (or a stale summary) to warrant an AI refresh.
// Bounded to recent messages so the GROUP BY stays cheap; caps rows returned.
function getUsersNeedingChatAi({ threshold = 15, staleCutoffIso, sinceTs, limit = 3 } = {}) {
    const sql = `
        SELECT cm.user_id AS uid,
               MAX(cm.id) AS max_id,
               SUM(CASE WHEN cm.id > COALESCE(cs.last_message_id, 0) THEN 1 ELSE 0 END) AS new_msgs,
               COALESCE(cs.last_message_id, 0) AS hw,
               cs.updated_at AS last_update
        FROM chat_messages cm
        LEFT JOIN chat_ai_summaries cs
          ON cs.scope = 'user' AND cs.subject_id = cm.user_id AND cs.window = 'rolling'
        WHERE ${_CHAT_AI_WHERE} AND cm.user_id IS NOT NULL AND cm.timestamp >= ?
        GROUP BY cm.user_id
        HAVING new_msgs > 0
           AND ( new_msgs >= ? OR cs.last_message_id IS NULL OR cs.updated_at IS NULL OR cs.updated_at < ? )
        ORDER BY (cs.updated_at IS NULL) DESC, new_msgs DESC
        LIMIT ?`;
    return all(sql, [sinceTs, threshold, staleCutoffIso, Math.max(1, limit)]);
}

// Record a chat-relay (external platform) user's activity; keeps the earliest
// first_seen as their "join date". Keyed case-insensitively by platform+username.
function recordRelayUser(platform, username) {
    if (!platform || !username) return;
    const key = String(username).toLowerCase();
    try {
        run(`INSERT INTO relay_users (platform, username, display_name, first_seen, last_seen, message_count)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)
             ON CONFLICT(platform, username) DO UPDATE SET
                last_seen = CURRENT_TIMESTAMP,
                message_count = message_count + 1,
                display_name = excluded.display_name`,
            [String(platform).toLowerCase(), key, String(username)]);
    } catch { /* non-critical */ }
}
function getRelayUser(platform, username) {
    if (!platform || !username) return null;
    // rowid is a stable integer id for a relay user (no dedicated id column); used to key
    // their chat-AI insight in chat_ai_summaries.
    return get('SELECT rowid AS id, * FROM relay_users WHERE platform = ? AND username = ?',
        [String(platform).toLowerCase(), String(username).toLowerCase()]) || null;
}
function getRelayUserByRowid(id) {
    return get('SELECT rowid AS id, * FROM relay_users WHERE rowid = ?', [id]) || null;
}

// Relay chat messages are stored with a "[Label] name" username + source_platform and a
// NULL user_id. Match a specific relay user by the trailing "] name" (LIKE is
// case-insensitive for ASCII in SQLite), scoped to their platform.
function _likeEscape(s) { return String(s).replace(/[\\%_]/g, '\\$&'); }
const _RELAY_MATCH = `cm.user_id IS NULL AND cm.source_platform = ? AND cm.username LIKE ? ESCAPE '\\'`;
function _relayMatchParams(platform, rawUsername) {
    return [String(platform).toLowerCase(), '%] ' + _likeEscape(String(rawUsername))];
}

// A relay user's message history (for the "Chat Logs" viewer).
function getRelayUserChatHistory(platform, rawUsername, { limit = 50, offset = 0, query = '' } = {}) {
    let where = `${_RELAY_MATCH} AND cm.is_deleted = 0`;
    const params = _relayMatchParams(platform, rawUsername);
    if (query) { where += ' AND cm.message LIKE ?'; params.push('%' + query + '%'); }
    const total = get(`SELECT COUNT(*) AS c FROM chat_messages cm WHERE ${where}`, params)?.c || 0;
    const rows = all(
        `SELECT cm.id, cm.username, cm.message, cm.message_type, cm.timestamp, cm.stream_id,
                cm.source_platform, s.title AS stream_title
         FROM chat_messages cm LEFT JOIN streams s ON cm.stream_id = s.id
         WHERE ${where} ORDER BY cm.timestamp DESC LIMIT ? OFFSET ?`,
        [...params, Math.max(1, Math.min(200, limit)), Math.max(0, offset)]
    );
    return { messages: rows, total };
}

// Relay messages for AI batching (mirrors getChatMessagesForAi).
function getRelayChatMessagesForAi({ platform, rawUsername, sinceTs = null, limit = 300, order = 'asc' } = {}) {
    let sql = `SELECT cm.id, cm.username, cm.message, cm.message_type, cm.timestamp, cm.source_platform
               FROM chat_messages cm
               WHERE ${_CHAT_AI_WHERE} AND ${_RELAY_MATCH}`;
    const params = _relayMatchParams(platform, rawUsername);
    if (sinceTs != null) { sql += ' AND cm.timestamp >= ?'; params.push(sinceTs); }
    sql += ` ORDER BY cm.id ${order === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`;
    params.push(Math.max(1, Math.min(2000, limit)));
    const rows = all(sql, params);
    return order === 'desc' ? rows.reverse() : rows;
}

// Relay users with new activity since their last AI summary (or never summarised).
// last_seen advances on every message (see recordRelayUser), so last_seen > summary
// updated_at means "chatted since we last analysed them".
function getRelayUsersNeedingChatAi({ lookbackIso, threshold = 8, limit = 2 } = {}) {
    return all(`
        SELECT r.rowid AS id, r.platform, r.username, r.display_name, r.message_count, r.last_seen,
               cs.updated_at AS last_update
        FROM relay_users r
        LEFT JOIN chat_ai_summaries cs
          ON cs.scope = 'relay' AND cs.window = 'rolling' AND cs.subject_id = r.rowid
        WHERE r.last_seen >= ?
          AND r.message_count >= ?
          AND (cs.updated_at IS NULL OR cs.updated_at < r.last_seen)
        ORDER BY (cs.updated_at IS NULL) DESC, r.last_seen DESC
        LIMIT ?`, [lookbackIso, threshold, Math.max(1, limit)]);
}

// ── Anonymous chatters: chat logs + AI insight (mirror the relay path) ──────────
// Anon messages have user_id NULL and a stable anon_id = "anon<N>" (which also equals
// their username). Their chat-AI insight is keyed in chat_ai_summaries by scope='anon',
// subject_id = the numeric N.
function anonSubjectId(anonId) {
    const m = /^anon(\d+)$/i.exec(String(anonId || ''));
    return m ? parseInt(m[1], 10) : 0;
}

// Anon meta for the context menu: first-seen (when their anon number was assigned)
// and first-chat (their earliest chat message), plus total message count.
function getAnonMeta(anonId) {
    const num = anonSubjectId(anonId);
    const map = num ? get('SELECT created_at FROM anon_ip_mappings WHERE anon_num = ?', [num]) : null;
    const firstChat = get(
        `SELECT MIN(timestamp) AS t FROM chat_messages
         WHERE anon_id = ? AND user_id IS NULL AND is_deleted = 0`, [String(anonId)]
    )?.t || null;
    const count = get(
        `SELECT COUNT(*) AS c FROM chat_messages
         WHERE anon_id = ? AND user_id IS NULL AND is_deleted = 0
           AND (auto_delete_at IS NULL OR datetime(auto_delete_at) > CURRENT_TIMESTAMP)`, [String(anonId)]
    )?.c || 0;
    return {
        anon_id: anonId,
        anon_num: num || null,
        first_seen: (map && map.created_at) || firstChat, // fall back to first chat for legacy rows
        first_chat: firstChat,
        message_count: count,
    };
}

// An anon's message history (for the "Chat Logs" viewer).
function getAnonChatHistory(anonId, { limit = 50, offset = 0, query = '' } = {}) {
    let where = `cm.anon_id = ? AND cm.user_id IS NULL AND cm.is_deleted = 0
                 AND (cm.auto_delete_at IS NULL OR datetime(cm.auto_delete_at) > CURRENT_TIMESTAMP)`;
    const params = [String(anonId)];
    if (query) { where += ' AND cm.message LIKE ?'; params.push('%' + query + '%'); }
    const total = get(`SELECT COUNT(*) AS c FROM chat_messages cm WHERE ${where}`, params)?.c || 0;
    const rows = all(
        `SELECT cm.id, cm.username, cm.anon_id, cm.message, cm.message_type, cm.timestamp, cm.stream_id,
                s.title AS stream_title
         FROM chat_messages cm LEFT JOIN streams s ON cm.stream_id = s.id
         WHERE ${where} ORDER BY cm.timestamp DESC LIMIT ? OFFSET ?`,
        [...params, Math.max(1, Math.min(200, limit)), Math.max(0, offset)]
    );
    return { messages: rows, total };
}

// Anon messages for AI batching (mirrors getChatMessagesForAi / getRelayChatMessagesForAi).
function getAnonChatMessagesForAi({ anonId, sinceTs = null, limit = 300, order = 'asc' } = {}) {
    let sql = `SELECT cm.id, cm.username, cm.message, cm.message_type, cm.timestamp
               FROM chat_messages cm
               WHERE ${_CHAT_AI_WHERE} AND cm.user_id IS NULL AND cm.anon_id = ?`;
    const params = [String(anonId)];
    if (sinceTs != null) { sql += ' AND cm.timestamp >= ?'; params.push(sinceTs); }
    sql += ` ORDER BY cm.id ${order === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`;
    params.push(Math.max(1, Math.min(2000, limit)));
    const rows = all(sql, params);
    return order === 'desc' ? rows.reverse() : rows;
}

// Anons with enough new chat activity (or a stale summary) to warrant an AI refresh.
function getAnonsNeedingChatAi({ threshold = 12, staleCutoffIso, sinceTs, limit = 2 } = {}) {
    const sql = `
        SELECT cm.anon_id AS anon_id,
               MAX(cm.id) AS max_id,
               SUM(CASE WHEN cm.id > COALESCE(cs.last_message_id, 0) THEN 1 ELSE 0 END) AS new_msgs
        FROM chat_messages cm
        LEFT JOIN chat_ai_summaries cs
          ON cs.scope = 'anon' AND cs.window = 'rolling'
         AND cs.subject_id = CAST(SUBSTR(cm.anon_id, 5) AS INTEGER)
        WHERE ${_CHAT_AI_WHERE} AND cm.user_id IS NULL AND cm.anon_id IS NOT NULL
          AND cm.anon_id LIKE 'anon%' AND cm.timestamp >= ?
        GROUP BY cm.anon_id
        HAVING new_msgs > 0
           AND ( new_msgs >= ? OR cs.last_message_id IS NULL OR cs.updated_at IS NULL OR cs.updated_at < ? )
        ORDER BY (cs.updated_at IS NULL) DESC, new_msgs DESC
        LIMIT ?`;
    return all(sql, [sinceTs, threshold, staleCutoffIso, Math.max(1, limit)]);
}

function getUserProfile(userId) {
    const user = get(`SELECT id, username, display_name, avatar_url, profile_color, role,
                      openvibe_bucks_balance, openvibe_coins_balance, created_at, last_seen
                      FROM users WHERE id = ?`, [userId]);
    if (!user) return null;
    user.messageCount = get(
        `SELECT COUNT(*) as c FROM chat_messages
         WHERE user_id = ? AND is_deleted = 0
           AND (auto_delete_at IS NULL OR datetime(auto_delete_at) > CURRENT_TIMESTAMP)`,
        [userId]
    )?.c || 0;
    user.followerCount = get('SELECT COUNT(*) as c FROM follows WHERE streamer_id = ?', [userId])?.c || 0;
    user.followingCount = get('SELECT COUNT(*) as c FROM follows WHERE follower_id = ?', [userId])?.c || 0;
    return user;
}

function updateUserAvatar(userId, avatarUrl, pasteId = null) {
    return run('UPDATE users SET avatar_url = ?, avatar_paste_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [avatarUrl, pasteId, userId]);
}

// resetAvatarsForPaste() removed — the media subsystem (vods/clips/pastes writes) moved to OpenVibe.Media.

// A user's avatar-upload history: the screenshot pastes tagged as avatar uploads.
function getUserAvatarPastes(userId, limit = 60) {
    return all(
        `SELECT id, slug, screenshot_path, title, created_at
         FROM pastes
         WHERE user_id = ? AND type = 'screenshot' AND json_extract(metadata, '$.kind') = 'avatar'
         ORDER BY created_at DESC LIMIT ?`,
        [userId, limit]
    );
}

// ── Follow helpers ───────────────────────────────────────────

function followUser(followerId, streamerId) {
    return run(
        `INSERT OR IGNORE INTO follows (follower_id, streamer_id) VALUES (?, ?)`,
        [followerId, streamerId]
    );
}

function unfollowUser(followerId, streamerId) {
    return run(`DELETE FROM follows WHERE follower_id = ? AND streamer_id = ?`,
        [followerId, streamerId]);
}

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
    return run(
        `INSERT INTO transactions (from_user_id, to_user_id, stream_id, amount, type, status, message)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [from_user_id || null, to_user_id || null, stream_id || null, amount, type, status || 'completed', message || null]
    );
}

function addVibes(userId, amount) {
    return run(`UPDATE users SET openvibe_bucks_balance = openvibe_bucks_balance + ? WHERE id = ?`,
        [amount, userId]);
}

function deductVibes(userId, amount) {
    const user = getUserById(userId);
    if (!user || user.openvibe_bucks_balance < amount) return false;
    run(`UPDATE users SET openvibe_bucks_balance = openvibe_bucks_balance - ? WHERE id = ?`,
        [amount, userId]);
    return true;
}

// Streamer cashout balance (received donations; the only cashout-able balance).
function addVibesCashout(userId, amount) {
    return run(`UPDATE users SET openvibe_bucks_cashout_balance = openvibe_bucks_cashout_balance + ? WHERE id = ?`,
        [amount, userId]);
}
function deductVibesCashout(userId, amount) {
    const user = getUserById(userId);
    if (!user || (user.openvibe_bucks_cashout_balance || 0) < amount) return false;
    run(`UPDATE users SET openvibe_bucks_cashout_balance = openvibe_bucks_cashout_balance - ? WHERE id = ?`,
        [amount, userId]);
    return true;
}

// ── Payment orders (idempotent purchase tracking) ────────────

function createPaymentOrder({ user_id, provider, provider_ref = null, kind = 'bucks', amount_cents = 0, currency = 'usd', bucks = 0, streamer_id = null, status = 'pending' }) {
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

function updatePaymentOrder(id, fields) {
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
    const cpe = fields.current_period_end !== undefined ? fields.current_period_end : null;
    const cape = fields.cancel_at_period_end !== undefined ? (fields.cancel_at_period_end ? 1 : 0) : 0;
    run(`UPDATE subscriptions SET status=?, is_active=?, cancel_at_period_end=?,
            current_period_end=COALESCE(?, current_period_end), updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        [status, status === 'active' ? 1 : 0, cape, cpe, id]);
    return get('SELECT * FROM subscriptions WHERE id = ?', [id]);
}

// ── VOD helpers ──────────────────────────────────────────────

// createVod() removed — the media subsystem (vods/clips/pastes writes) moved to OpenVibe.Media.

function updateVodHealth(vodId, { status, score, issues = [], probeDuration, probeFormat, quarantine = false, keepPublic = false }) {
    const updates = [];
    const params = [];
    if (status) {
        updates.push('health_status = ?');
        params.push(status);
    }
    if (typeof score === 'number') {
        updates.push('health_score = ?');
        params.push(score);
    }
    if (issues) {
        updates.push('health_issues_json = ?');
        params.push(JSON.stringify(issues));
    }
    if (typeof probeDuration === 'number') {
        updates.push('probe_duration_seconds = ?');
        params.push(probeDuration);
    }
    if (probeFormat !== undefined) {
        updates.push('probe_format_json = ?');
        params.push(JSON.stringify(probeFormat || {}));
    }
    if (quarantine) {
        updates.push('quarantined_at = datetime(\'now\')');
        if (!keepPublic) {
            updates.push('is_public = 0');
        }
    }
    updates.push('last_health_scan_at = datetime(\'now\')');
    params.push(vodId);
    if (!updates.length) return null;
    return run(`UPDATE vods SET ${updates.join(', ')} WHERE id = ?`, params);
}

function repairVodDuration(vodId, duration, fileSize) {
    return run(
        `UPDATE vods SET duration_seconds = ?, file_size = ?, probe_duration_seconds = ?, last_health_scan_at = datetime('now') WHERE id = ?`,
        [duration, fileSize, duration, vodId]
    );
}

function getVodHealthById(id) {
    return get(`SELECT * FROM vods WHERE id = ?`, [id]);
}

function getVodScanCandidates({ userId, since, limit }) {
    const conditions = ['COALESCE(is_recording, 0) = 0'];
    const params = [];
    if (userId) {
        conditions.push('user_id = ?');
        params.push(userId);
    }
    if (since) {
        conditions.push('created_at >= datetime(?, ?)');
        params.push(since, 'localtime');
    }
    let sql = `SELECT * FROM vods WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`;
    if (limit) {
        sql += ' LIMIT ?';
        params.push(limit);
    }
    return all(sql, params);
}

// VODs the periodic health job should scan: finished (not recording), and either never
// scanned or last scanned longer ago than `staleDays`. Recently-quarantined rows are
// skipped (they were just assessed). Never-scanned + oldest-scanned first.
function getVodsNeedingHealthScan({ staleDays = 30, limit = 3 } = {}) {
    return all(`SELECT * FROM vods
        WHERE COALESCE(is_recording, 0) = 0
          AND (health_status IS NULL OR health_status NOT IN ('corrupt','zero_byte','missing_file'))
          AND (last_health_scan_at IS NULL OR last_health_scan_at <= datetime('now', ?))
        ORDER BY (last_health_scan_at IS NULL) DESC, last_health_scan_at ASC
        LIMIT ?`, [`-${Math.max(1, staleDays)} days`, limit]);
}

// Genuinely-broken VODs quarantined long enough that they should be cleaned up (files
// freed). Only unrecoverably-dead states — never 'needs_review'/'short_duration', which
// may still be watchable.
function getQuarantinedVodsForCleanup({ graceDays = 14, limit = 5 } = {}) {
    return all(`SELECT * FROM vods
        WHERE quarantined_at IS NOT NULL
          AND quarantined_at <= datetime('now', ?)
          AND health_status IN ('corrupt','zero_byte','missing_file')
          AND COALESCE(is_recording, 0) = 0
        ORDER BY quarantined_at ASC
        LIMIT ?`, [`-${Math.max(1, graceDays)} days`, limit]);
}

function getVodById(id) {
    return get(`
        SELECT v.*, COALESCE(v.duration_seconds, v.probe_duration_seconds, 0) AS duration_seconds,
               u.username, u.display_name, u.avatar_url,
               s.title AS stream_title, s.protocol AS stream_protocol
        FROM vods v
        JOIN users u ON v.user_id = u.id
        LEFT JOIN streams s ON v.stream_id = s.id
        WHERE v.id = ?
    `, [id]);
}

function getVodsByUser(userId, includePrivate = false, limit = null, offset = 0) {
    const clause = includePrivate ? '' : ' AND v.is_public = 1';
    const usePaging = Number.isFinite(limit);
    const pagingSql = usePaging ? ' LIMIT ? OFFSET ?' : '';
    const params = [userId];
    if (usePaging) params.push(limit, offset);
    return all(`
        SELECT v.*, COALESCE(v.duration_seconds, v.probe_duration_seconds, 0) AS duration_seconds,
               u.username, u.display_name, u.avatar_url, u.is_owner AS owner_is_owner,
               s.protocol AS stream_protocol
        FROM vods v JOIN users u ON v.user_id = u.id
        LEFT JOIN streams s ON v.stream_id = s.id
        WHERE v.user_id = ?${clause} AND COALESCE(v.is_recording, 0) = 0
        ORDER BY v.created_at DESC${pagingSql}
    `, params);
}

function countVodsByUser(userId, includePrivate = false) {
    const clause = includePrivate ? '' : ' AND v.is_public = 1';
    return get(`
        SELECT COUNT(*) AS count
        FROM vods v
        WHERE v.user_id = ?${clause} AND COALESCE(v.is_recording, 0) = 0
    `, [userId])?.count || 0;
}

function getPublicVods(limit = 50, offset = 0, { username = null, sort = 'newest' } = {}) {
    const conditions = ['v.is_public = 1', 'COALESCE(v.is_recording, 0) = 0'];
    const params = [];

    if (username) {
        conditions.push('LOWER(u.username) = LOWER(?)');
        params.push(String(username).trim());
    }

    const dir = sort === 'oldest' ? 'ASC' : 'DESC';
    params.push(limit, offset);
    return all(`
        SELECT v.*, COALESCE(v.duration_seconds, v.probe_duration_seconds, 0) AS duration_seconds,
               u.username, u.display_name, u.avatar_url, u.is_owner AS owner_is_owner,
               s.protocol AS stream_protocol
        FROM vods v JOIN users u ON v.user_id = u.id
        LEFT JOIN streams s ON v.stream_id = s.id
        WHERE ${conditions.join(' AND ')}
        ORDER BY v.created_at ${dir}
        LIMIT ? OFFSET ?
    `, params);
}

function countPublicVods({ username = null } = {}) {
    const conditions = ['v.is_public = 1', 'COALESCE(v.is_recording, 0) = 0'];
    const params = [];

    if (username) {
        conditions.push('LOWER(u.username) = LOWER(?)');
        params.push(String(username).trim());
    }

    return get(`
        SELECT COUNT(*) AS count
        FROM vods v
        JOIN users u ON v.user_id = u.id
        WHERE ${conditions.join(' AND ')}
    `, params)?.count || 0;
}

function listVodStreamers(includeUserId = null) {
    const params = [];
    let visibilityClause = 'v.is_public = 1';
    if (includeUserId) {
        visibilityClause = '(v.is_public = 1 OR v.user_id = ?)';
        params.push(includeUserId);
    }

    return all(`
        SELECT u.id AS user_id, u.username, u.display_name, COUNT(*) AS vod_count
        FROM vods v
        JOIN users u ON v.user_id = u.id
        WHERE ${visibilityClause}
          AND COALESCE(v.is_recording, 0) = 0
        GROUP BY u.id, u.username, u.display_name
        ORDER BY LOWER(COALESCE(u.display_name, u.username)) ASC
    `, params);
}

function getActiveVodByStream(streamId) {
    return get(`
        SELECT v.*, u.username, u.display_name, u.avatar_url
        FROM vods v JOIN users u ON v.user_id = u.id
        WHERE v.stream_id = ? AND v.is_recording = 1
        ORDER BY v.created_at DESC LIMIT 1
    `, [streamId]);
}

// getOrphanedRecordingVods() removed — the media subsystem (vods/clips/pastes writes) moved to OpenVibe.Media.

// ── Clip helpers ─────────────────────────────────────────────

// createClip() removed — the media subsystem (vods/clips/pastes writes) moved to OpenVibe.Media.

function getClipById(id) {
    return get(`
        SELECT c.*, u.username, u.display_name, u.avatar_url,
               s.title AS stream_title, s.started_at AS stream_started_at, s.protocol AS stream_protocol
        FROM clips c
        JOIN users u ON c.user_id = u.id
        LEFT JOIN streams s ON c.stream_id = s.id
        WHERE c.id = ?
    `, [id]);
}

function getClipsByUser(userId, includePrivate = false, limit = null, offset = 0) {
    const publicFilter = includePrivate ? '' : 'AND c.is_public = 1';
    const usePaging = Number.isFinite(limit);
    const pagingSql = usePaging ? ' LIMIT ? OFFSET ?' : '';
    const params = [userId];
    if (usePaging) params.push(limit, offset);
    return all(`
        SELECT c.*, u.username, u.display_name, u.avatar_url,
               s.title AS stream_title, s.started_at AS stream_started_at, s.protocol AS stream_protocol
        FROM clips c
        JOIN users u ON c.user_id = u.id
        LEFT JOIN streams s ON c.stream_id = s.id
        WHERE c.user_id = ? ${publicFilter}
        ORDER BY c.created_at DESC${pagingSql}
    `, params);
}

// ── "Clips Taken" tab: clips a user CREATED, of various source streamers ──
// Each clip's "source streamer" is the owner of the clipped stream (or VOD). Supports
// sort, filtering by source streamer, and hiding self-clips (of one's own content).
const _CLIPS_TAKEN_ORDER = {
    newest: 'c.created_at DESC',
    oldest: 'c.created_at ASC',
    views: 'c.view_count DESC, c.created_at DESC',
};
function _clipsTakenWhere(userId, { includePrivate = false, sourceStreamerId = null, hideSelf = false }) {
    const conds = ['c.user_id = ?'];
    const params = [userId];
    if (!includePrivate) conds.push('c.is_public = 1');
    if (sourceStreamerId) { conds.push('COALESCE(s.user_id, v.user_id) = ?'); params.push(sourceStreamerId); }
    else if (hideSelf) { conds.push('COALESCE(s.user_id, v.user_id) IS NOT NULL'); conds.push('COALESCE(s.user_id, v.user_id) != ?'); params.push(userId); }
    return { where: conds.join(' AND '), params };
}
const _CLIPS_TAKEN_JOINS = `
    FROM clips c
    JOIN users u ON c.user_id = u.id
    LEFT JOIN streams s ON c.stream_id = s.id
    LEFT JOIN vods v ON c.vod_id = v.id
    LEFT JOIN users su ON s.user_id = su.id
    LEFT JOIN users vu ON v.user_id = vu.id`;
function getClipsTakenByUser(userId, { includePrivate = false, orderBy = 'newest', sourceStreamerId = null, hideSelf = true, limit = 12, offset = 0 } = {}) {
    const order = _CLIPS_TAKEN_ORDER[orderBy] || _CLIPS_TAKEN_ORDER.newest;
    const { where, params } = _clipsTakenWhere(userId, { includePrivate, sourceStreamerId, hideSelf });
    params.push(limit, offset);
    return all(`
        SELECT c.*, u.username, u.display_name, u.avatar_url,
               s.title AS stream_title, s.protocol AS stream_protocol,
               COALESCE(s.user_id, v.user_id) AS source_streamer_id,
               COALESCE(su.username, vu.username) AS source_streamer_username,
               COALESCE(su.display_name, vu.display_name) AS source_streamer_display_name,
               COALESCE(su.avatar_url, vu.avatar_url) AS source_streamer_avatar
        ${_CLIPS_TAKEN_JOINS}
        WHERE ${where}
        ORDER BY ${order}
        LIMIT ? OFFSET ?
    `, params);
}
function countClipsTakenByUser(userId, { includePrivate = false, sourceStreamerId = null, hideSelf = true } = {}) {
    const { where, params } = _clipsTakenWhere(userId, { includePrivate, sourceStreamerId, hideSelf });
    return get(`SELECT COUNT(*) AS count ${_CLIPS_TAKEN_JOINS} WHERE ${where}`, params)?.count || 0;
}
// Facets for the filter badges — every source streamer this user has clipped, with counts.
function getClipsTakenFacets(userId, { includePrivate = false } = {}) {
    const publicFilter = includePrivate ? '' : 'AND c.is_public = 1';
    return all(`
        SELECT COALESCE(s.user_id, v.user_id) AS streamer_id,
               COALESCE(su.username, vu.username) AS username,
               COALESCE(su.display_name, vu.display_name) AS display_name,
               COALESCE(su.avatar_url, vu.avatar_url) AS avatar_url,
               COUNT(*) AS count
        ${_CLIPS_TAKEN_JOINS}
        WHERE c.user_id = ? ${publicFilter}
        GROUP BY streamer_id
        HAVING streamer_id IS NOT NULL
        ORDER BY count DESC, display_name ASC
    `, [userId]);
}

function countClipsByUser(userId, includePrivate = false) {
    const publicFilter = includePrivate ? '' : 'AND c.is_public = 1';
    return get(`
        SELECT COUNT(*) AS count
        FROM clips c
        WHERE c.user_id = ? ${publicFilter}
    `, [userId])?.count || 0;
}

// setClipPublic() removed — the media subsystem (vods/clips/pastes writes) moved to OpenVibe.Media.
const VALID_VISIBILITY = new Set(['public', 'unlisted', 'private']);
function _normVisibility(v) { return VALID_VISIBILITY.has(v) ? v : 'public'; }
// setClipVisibility() removed — the media subsystem (vods/clips/pastes writes) moved to OpenVibe.Media.
// A specific user's pastes for their channel page. Non-owners see public only;
// the owner/admin also sees their unlisted + private. sort: 'newest' | 'oldest'.
function getUserPastesForChannel(userId, { includeHidden = false, sort = 'newest', limit = 30, offset = 0 } = {}) {
    const dir = sort === 'oldest' ? 'ASC' : 'DESC';
    const visClause = includeHidden ? '' : "AND p.visibility = 'public'";
    return all(`
        SELECT p.id, p.slug, p.type, p.title, p.language, p.visibility, p.pinned, p.views, p.copies, p.likes, p.created_at,
               p.screenshot_path, p.ai_summary, substr(p.content, 1, 300) AS content
        FROM pastes p
        WHERE p.user_id = ? ${visClause}
        ORDER BY p.pinned DESC, p.created_at ${dir}
        LIMIT ? OFFSET ?
    `, [userId, limit, offset]);
}
function countUserPastesForChannel(userId, { includeHidden = false } = {}) {
    const visClause = includeHidden ? '' : "AND visibility = 'public'";
    return get(`SELECT COUNT(*) AS count FROM pastes WHERE user_id = ? ${visClause}`, [userId]).count;
}

function getPublicClips(limit = 50, offset = 0, { username = null, sort = 'newest' } = {}) {
    const conditions = ['c.is_public = 1'];
    const params = [];

    if (username) {
        conditions.push('LOWER(COALESCE(su.username, u.username)) = LOWER(?)');
        params.push(String(username).trim());
    }

    const dir = sort === 'oldest' ? 'ASC' : 'DESC';
    params.push(limit, offset);
    return all(`
        SELECT c.*, u.username, u.display_name, u.avatar_url, u.is_owner AS owner_is_owner,
               s.title AS stream_title, s.started_at AS stream_started_at, s.protocol AS stream_protocol,
               su.username AS streamer_username, su.display_name AS streamer_display_name, su.avatar_url AS streamer_avatar_url,
               su.is_owner AS streamer_is_owner
        FROM clips c
        JOIN users u ON c.user_id = u.id
        LEFT JOIN streams s ON c.stream_id = s.id
        LEFT JOIN users su ON s.user_id = su.id
        WHERE ${conditions.join(' AND ')}
        ORDER BY c.created_at ${dir}
        LIMIT ? OFFSET ?
    `, params);
}

function countPublicClips({ username = null } = {}) {
    const conditions = ['c.is_public = 1'];
    const params = [];

    if (username) {
        conditions.push('LOWER(COALESCE(su.username, u.username)) = LOWER(?)');
        params.push(String(username).trim());
    }

    return get(`
        SELECT COUNT(*) AS count
        FROM clips c
        JOIN users u ON c.user_id = u.id
        LEFT JOIN streams s ON c.stream_id = s.id
        LEFT JOIN users su ON s.user_id = su.id
        WHERE ${conditions.join(' AND ')}
    `, params)?.count || 0;
}

function listClipStreamers() {
    return all(`
        SELECT COALESCE(su.id, u.id) AS user_id,
               COALESCE(su.username, u.username) AS username,
               COALESCE(su.display_name, u.display_name) AS display_name,
               COUNT(*) AS clip_count
        FROM clips c
        JOIN users u ON c.user_id = u.id
        LEFT JOIN streams s ON c.stream_id = s.id
        LEFT JOIN users su ON s.user_id = su.id
        WHERE c.is_public = 1
        GROUP BY COALESCE(su.id, u.id), COALESCE(su.username, u.username), COALESCE(su.display_name, u.display_name)
        ORDER BY LOWER(COALESCE(COALESCE(su.display_name, u.display_name), COALESCE(su.username, u.username))) ASC
    `, []);
}

function getClipsByStream(streamId) {
    return all(`
        SELECT c.*, u.username, u.display_name, u.avatar_url,
               s.title AS stream_title, s.started_at AS stream_started_at, s.protocol AS stream_protocol
        FROM clips c
        JOIN users u ON c.user_id = u.id
        LEFT JOIN streams s ON c.stream_id = s.id
        WHERE c.stream_id = ? AND c.is_public = 1
        ORDER BY c.created_at DESC
    `, [streamId]);
}

function getClipsOfUserStreams(userId) {
    return all(`
        SELECT c.*, u.username, u.display_name, u.avatar_url,
               s.title AS stream_title, s.started_at AS stream_started_at, s.protocol AS stream_protocol
        FROM clips c
        JOIN users u ON c.user_id = u.id
        JOIN streams s ON c.stream_id = s.id
        WHERE s.user_id = ?
        ORDER BY c.created_at DESC
    `, [userId]);
}

// findDuplicateClip() removed — the media subsystem (vods/clips/pastes writes) moved to OpenVibe.Media.

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

function updateConfigButton(buttonId, fields) {
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
    return run(`UPDATE control_config_buttons SET ${updates.join(', ')} WHERE id = ?`, params);
}

function deleteConfigButton(buttonId) {
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
        AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
        LIMIT 1
    `, [userId, streamId]);
    return !!ban;
}

function isIpBanned(ip, streamId) {
    const ban = get(`
        SELECT * FROM bans
        WHERE ip_address = ?
        AND (stream_id = ? OR stream_id IS NULL)
        AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
        LIMIT 1
    `, [ip, streamId]);
    return !!ban;
}

// ── Cleanup ──────────────────────────────────────────────────

function close() {
    if (db) {
        db.close();
        db = null;
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

// ── Emote helpers ────────────────────────────────────────────

function createEmote({ user_id, code, url, animated = false, width = 28, height = 28, is_global = false, channel_owner_id = null, size = 100 }) {
    return run(
        `INSERT INTO emotes (user_id, code, url, animated, width, height, is_global, channel_owner_id, size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [user_id, code, url, animated ? 1 : 0, width, height, is_global ? 1 : 0, channel_owner_id || null, Math.min(400, Math.max(25, parseInt(size) || 100))]
    );
}

function getEmoteById(id) {
    return get('SELECT e.*, u.username FROM emotes e JOIN users u ON e.user_id = u.id WHERE e.id = ?', [id]);
}

function getEmotesByUser(userId) {
    return all('SELECT * FROM emotes WHERE user_id = ? ORDER BY code', [userId]);
}

function getGlobalEmotes() {
    return all('SELECT e.*, u.username FROM emotes e JOIN users u ON e.user_id = u.id WHERE e.is_global = 1 AND e.is_approved = 1 ORDER BY code');
}

function getChannelEmotes(userId) {
    // A channel's emotes are those explicitly targeted at this owner (viewer uploads),
    // plus legacy emotes the owner uploaded to their own channel (channel_owner_id NULL).
    return all(
        `SELECT e.*, u.username, up.username AS uploader_username, up.display_name AS uploader_display_name
           FROM emotes e
           JOIN users u ON e.user_id = u.id
           LEFT JOIN users up ON e.user_id = up.id
          WHERE ((e.channel_owner_id = ?) OR (e.channel_owner_id IS NULL AND e.user_id = ?))
            AND e.is_approved = 1
          ORDER BY code`,
        [userId, userId]
    );
}

function countChannelEmotes(ownerId) {
    const row = get(
        'SELECT COUNT(*) as count FROM emotes WHERE (channel_owner_id = ?) OR (channel_owner_id IS NULL AND user_id = ?)',
        [ownerId, ownerId]
    );
    return row ? row.count : 0;
}

function getChannelEmoteByCode(ownerId, code) {
    return get(
        `SELECT * FROM emotes
          WHERE code = ? AND ((channel_owner_id = ?) OR (channel_owner_id IS NULL AND user_id = ?))
          LIMIT 1`,
        [code, ownerId, ownerId]
    );
}

function deleteEmote(id) {
    return run('DELETE FROM emotes WHERE id = ?', [id]);
}

// Edit an emote in place (rename the code and/or change display size %)
// so streamers don't have to delete + re-upload.
function updateEmote(id, { code, size }) {
    const sets = [];
    const params = [];
    if (code !== undefined) { sets.push('code = ?'); params.push(code); }
    if (size !== undefined) { sets.push('size = ?'); params.push(Math.min(400, Math.max(25, parseInt(size) || 100))); }
    if (!sets.length) return { changes: 0 };
    params.push(id);
    return run(`UPDATE emotes SET ${sets.join(', ')} WHERE id = ?`, params);
}

function getEmoteByCode(code, userId) {
    // Check channel emotes first, then global
    return get(
        `SELECT * FROM emotes WHERE code = ? AND (user_id = ? OR is_global = 1) AND is_approved = 1 ORDER BY is_global ASC LIMIT 1`,
        [code, userId]
    );
}

function countUserEmotes(userId) {
    const row = get('SELECT COUNT(*) as count FROM emotes WHERE user_id = ?', [userId]);
    return row ? row.count : 0;
}

// ── Channel sound commands (viewer-uploadable) ───────────────
function createChannelSound({ channel_owner_id, command, url, mime = 'audio/mpeg', duration_seconds = 0, created_by = null, created_by_name = '', emote_code = '' }) {
    return run(
        `INSERT INTO channel_sounds (channel_owner_id, command, url, mime, duration_seconds, created_by, created_by_name, emote_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [channel_owner_id, command, url, mime, duration_seconds, created_by, created_by_name, emote_code || '']
    );
}
// Update the shared emote_code for all sounds under a command (an emote is per-command).
function setChannelSoundEmote(ownerId, command, emoteCode) {
    return run('UPDATE channel_sounds SET emote_code = ? WHERE channel_owner_id = ? AND command = ?',
        [emoteCode || '', ownerId, String(command || '').toLowerCase()]);
}

function getChannelSounds(ownerId) {
    return all(
        'SELECT * FROM channel_sounds WHERE channel_owner_id = ? AND is_approved = 1 ORDER BY command',
        [ownerId]
    );
}

function getChannelSoundByCommand(ownerId, command) {
    // A command may have multiple uploaded sounds — pick one at random each play.
    return get(
        'SELECT * FROM channel_sounds WHERE channel_owner_id = ? AND command = ? AND is_approved = 1 ORDER BY RANDOM() LIMIT 1',
        [ownerId, String(command || '').toLowerCase()]
    );
}

function getChannelSoundById(id) {
    return get('SELECT * FROM channel_sounds WHERE id = ?', [id]);
}

function countChannelSounds(ownerId) {
    const row = get('SELECT COUNT(*) as count FROM channel_sounds WHERE channel_owner_id = ?', [ownerId]);
    return row ? row.count : 0;
}

function countChannelSoundsByUploader(ownerId, uploaderId) {
    const row = get('SELECT COUNT(*) as count FROM channel_sounds WHERE channel_owner_id = ? AND created_by = ?', [ownerId, uploaderId]);
    return row ? row.count : 0;
}

function deleteChannelSound(id) {
    return run('DELETE FROM channel_sounds WHERE id = ?', [id]);
}

// Rename a whole !command group (a command may hold several sounds).
function renameChannelSoundCommand(ownerId, oldCommand, newCommand) {
    return run('UPDATE channel_sounds SET command = ? WHERE channel_owner_id = ? AND command = ?',
        [String(newCommand || '').toLowerCase(), ownerId, String(oldCommand || '').toLowerCase()]);
}

// Sounds attach emotes BY CODE — keep those references alive when an emote
// is renamed so the streamer's emote+sound combos don't silently break.
function updateChannelSoundEmoteRefs(ownerId, oldCode, newCode) {
    return run('UPDATE channel_sounds SET emote_code = ? WHERE channel_owner_id = ? AND emote_code = ?',
        [newCode || '', ownerId, oldCode]);
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

function createMediaRequest({ streamer_id, stream_id, user_id, username, input, canonical_url, embed_url, provider, title, thumbnail_url, duration_seconds, cost, queue_position, currency }) {
    return run(
        `INSERT INTO media_requests (
            streamer_id, stream_id, user_id, username, input, canonical_url, embed_url,
            provider, title, thumbnail_url, duration_seconds, cost, queue_position, currency
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        ]
    );
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
    return all(`SELECT * FROM media_requests WHERE streamer_id = ? AND status IN ('played', 'skipped', 'removed', 'failed') ORDER BY COALESCE(ended_at, requested_at) DESC, id DESC LIMIT ?`, [streamerId, limit]);
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

// ── Comment helpers ──────────────────────────────────────────

function createComment({ content_type, content_id, user_id, parent_id, message }) {
    return run(
        `INSERT INTO comments (content_type, content_id, user_id, parent_id, message)
         VALUES (?, ?, ?, ?, ?)`,
        [content_type, content_id, user_id, parent_id || null, message]
    );
}

function getComments(contentType, contentId, limit = 50, offset = 0) {
    return all(`
        SELECT c.*, u.username, u.display_name, u.avatar_url, u.profile_color, u.role
        FROM comments c
        JOIN users u ON c.user_id = u.id
        WHERE c.content_type = ? AND c.content_id = ? AND c.is_deleted = 0 AND c.parent_id IS NULL
        ORDER BY c.created_at DESC
        LIMIT ? OFFSET ?
    `, [contentType, contentId, limit, offset]);
}

function getCommentReplies(parentId) {
    return all(`
        SELECT c.*, u.username, u.display_name, u.avatar_url, u.profile_color, u.role
        FROM comments c
        JOIN users u ON c.user_id = u.id
        WHERE c.parent_id = ? AND c.is_deleted = 0
        ORDER BY c.created_at ASC
    `, [parentId]);
}

function getCommentById(id) {
    return get('SELECT * FROM comments WHERE id = ?', [id]);
}

function getCommentCount(contentType, contentId) {
    const row = get('SELECT COUNT(*) as c FROM comments WHERE content_type = ? AND content_id = ? AND is_deleted = 0',
        [contentType, contentId]);
    return row ? row.c : 0;
}

function deleteComment(id) {
    return run('UPDATE comments SET is_deleted = 1 WHERE id = ?', [id]);
}

function updateComment(id, message) {
    return run('UPDATE comments SET message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [message, id]);
}

// ── Chat replay helpers ──────────────────────────────────────

function getChatReplay(streamId, fromTime, toTime) {
    let sql = `SELECT cm.*, u.avatar_url, u.profile_color, u.role, u.display_name
               FROM chat_messages cm
               LEFT JOIN users u ON cm.user_id = u.id
               WHERE cm.stream_id = ? AND cm.is_deleted = 0 AND cm.message_type = 'chat'
                 AND (cm.auto_delete_at IS NULL OR datetime(cm.auto_delete_at) > CURRENT_TIMESTAMP)`;
    const params = [streamId];
    if (fromTime) { sql += ` AND cm.timestamp >= ?`; params.push(fromTime); }
    if (toTime) { sql += ` AND cm.timestamp <= ?`; params.push(toTime); }
    sql += ` ORDER BY cm.timestamp ASC`;
    return all(sql, params);
}

// ── Channel lookup by ID ─────────────────────────────────────

function getChannelById(id) {
    return get('SELECT * FROM channels WHERE id = ?', [id]);
}

// ── Channel Moderators ───────────────────────────────────────

function isChannelModerator(userId, channelId) {
    const row = get('SELECT 1 FROM channel_moderators WHERE user_id = ? AND channel_id = ?', [userId, channelId]);
    return !!row;
}

function addChannelModerator(channelId, userId, addedBy) {
    return run(
        'INSERT OR IGNORE INTO channel_moderators (channel_id, user_id, added_by) VALUES (?, ?, ?)',
        [channelId, userId, addedBy]
    );
}

function removeChannelModerator(channelId, userId) {
    return run('DELETE FROM channel_moderators WHERE channel_id = ? AND user_id = ?', [channelId, userId]);
}

function getChannelModerators(channelId) {
    return all(`
        SELECT cm.id, cm.user_id, cm.added_by, cm.created_at,
               u.username, u.display_name, u.avatar_url,
               a.username as added_by_username
        FROM channel_moderators cm
        JOIN users u ON cm.user_id = u.id
        LEFT JOIN users a ON cm.added_by = a.id
        WHERE cm.channel_id = ?
        ORDER BY cm.created_at ASC
    `, [channelId]);
}

function getChannelsByModerator(userId) {
    return all(`
        SELECT cm.channel_id, c.title, c.user_id, u.username as owner_username
        FROM channel_moderators cm
        JOIN channels c ON cm.channel_id = c.id
        JOIN users u ON c.user_id = u.id
        WHERE cm.user_id = ?
    `, [userId]);
}

// ── Channel Moderation Settings ──────────────────────────────

function getChannelModerationSettings(channelId) {
    return get('SELECT * FROM channel_moderation_settings WHERE channel_id = ?', [channelId])
        || {
            channel_id: channelId,
            slow_mode_seconds: 0,
            followers_only: 0,
            emote_only: 0,
            allow_anonymous: 1,
            links_allowed: 1,
            gifs_enabled: 1,
            account_age_gate_hours: 0,
            caps_percentage_limit: 0,
            aggressive_filter: 0,
            max_message_length: 500,
            tts_max_length: 200,
            slur_filter_enabled: 0,
            slur_filter_use_builtin: 1,
            slur_filter_terms: '',
            slur_filter_regexes: '',
            slur_filter_nudge_message: '',
            slur_filter_disabled_categories: '[]',
            ip_approval_mode: 0,
            soundboard_enabled: 1,
            soundboard_allow_pitch: 1,
            soundboard_allow_speed: 1,
            soundboard_banned_ids: '',
            viewer_auto_delete_enabled: 1,
            viewer_delete_all_enabled: 1,
            custom_emotes_enabled: 1,
            custom_sounds_enabled: 1,
            max_sound_seconds: 10,
            uploads_mods_only: 0,
            mods_can_edit_about: 0,
            emote_scale: 100,
            emote_size_min: 50,
            emote_size_max: 200,
            sounds_mods_only: 0,
            sound_min_speed: 0.5,
            sound_max_speed: 3.0,
            sound_min_pitch_cents: -1200,
            sound_max_pitch_cents: 1200,
        };
}

function upsertChannelModerationSettings(channelId, fields) {
    const existing = get('SELECT 1 FROM channel_moderation_settings WHERE channel_id = ?', [channelId]);
    if (existing) {
        const updates = [];
        const params = [];
        if (fields.slow_mode_seconds !== undefined) { updates.push('slow_mode_seconds = ?'); params.push(fields.slow_mode_seconds); }
        if (fields.followers_only !== undefined) { updates.push('followers_only = ?'); params.push(fields.followers_only ? 1 : 0); }
        if (fields.emote_only !== undefined) { updates.push('emote_only = ?'); params.push(fields.emote_only ? 1 : 0); }
        if (fields.allow_anonymous !== undefined) { updates.push('allow_anonymous = ?'); params.push(fields.allow_anonymous ? 1 : 0); }
        if (fields.links_allowed !== undefined) { updates.push('links_allowed = ?'); params.push(fields.links_allowed ? 1 : 0); }
        if (fields.gifs_enabled !== undefined) { updates.push('gifs_enabled = ?'); params.push(fields.gifs_enabled ? 1 : 0); }
        if (fields.account_age_gate_hours !== undefined) { updates.push('account_age_gate_hours = ?'); params.push(Number(fields.account_age_gate_hours) || 0); }
        if (fields.caps_percentage_limit !== undefined) { updates.push('caps_percentage_limit = ?'); params.push(Number(fields.caps_percentage_limit) || 0); }
        if (fields.aggressive_filter !== undefined) { updates.push('aggressive_filter = ?'); params.push(fields.aggressive_filter ? 1 : 0); }
        if (fields.max_message_length !== undefined) { updates.push('max_message_length = ?'); params.push(Math.max(50, Number(fields.max_message_length) || 500)); }
        if (fields.slur_filter_enabled !== undefined) { updates.push('slur_filter_enabled = ?'); params.push(fields.slur_filter_enabled ? 1 : 0); }
        if (fields.slur_filter_use_builtin !== undefined) { updates.push('slur_filter_use_builtin = ?'); params.push(fields.slur_filter_use_builtin ? 1 : 0); }
        if (fields.slur_filter_terms !== undefined) { updates.push('slur_filter_terms = ?'); params.push(String(fields.slur_filter_terms || '').slice(0, 4000)); }
        if (fields.slur_filter_regexes !== undefined) { updates.push('slur_filter_regexes = ?'); params.push(String(fields.slur_filter_regexes || '').slice(0, 8000)); }
        if (fields.slur_filter_nudge_message !== undefined) { updates.push('slur_filter_nudge_message = ?'); params.push(String(fields.slur_filter_nudge_message || '').slice(0, 800)); }
        if (fields.slur_filter_disabled_categories !== undefined) { updates.push('slur_filter_disabled_categories = ?'); params.push(String(fields.slur_filter_disabled_categories || '[]').slice(0, 200)); }
        if (fields.ip_approval_mode !== undefined) { updates.push('ip_approval_mode = ?'); params.push(fields.ip_approval_mode ? 1 : 0); }
        if (fields.soundboard_enabled !== undefined) { updates.push('soundboard_enabled = ?'); params.push(fields.soundboard_enabled ? 1 : 0); }
        if (fields.soundboard_allow_pitch !== undefined) { updates.push('soundboard_allow_pitch = ?'); params.push(fields.soundboard_allow_pitch ? 1 : 0); }
        if (fields.soundboard_allow_speed !== undefined) { updates.push('soundboard_allow_speed = ?'); params.push(fields.soundboard_allow_speed ? 1 : 0); }
        if (fields.soundboard_banned_ids !== undefined) { updates.push('soundboard_banned_ids = ?'); params.push(String(fields.soundboard_banned_ids || '').slice(0, 4000)); }
        if (fields.viewer_auto_delete_enabled !== undefined) { updates.push('viewer_auto_delete_enabled = ?'); params.push(fields.viewer_auto_delete_enabled ? 1 : 0); }
        if (fields.viewer_delete_all_enabled !== undefined) { updates.push('viewer_delete_all_enabled = ?'); params.push(fields.viewer_delete_all_enabled ? 1 : 0); }
        if (fields.custom_emotes_enabled !== undefined) { updates.push('custom_emotes_enabled = ?'); params.push(fields.custom_emotes_enabled ? 1 : 0); }
        if (fields.custom_sounds_enabled !== undefined) { updates.push('custom_sounds_enabled = ?'); params.push(fields.custom_sounds_enabled ? 1 : 0); }
        if (fields.max_sound_seconds !== undefined) { updates.push('max_sound_seconds = ?'); params.push(Math.min(30, Math.max(1, Number(fields.max_sound_seconds) || 10))); }
        if (fields.uploads_mods_only !== undefined) { updates.push('uploads_mods_only = ?'); params.push(fields.uploads_mods_only ? 1 : 0); }
        if (fields.mods_can_edit_about !== undefined) { updates.push('mods_can_edit_about = ?'); params.push(fields.mods_can_edit_about ? 1 : 0); }
        if (fields.emote_scale !== undefined) { updates.push('emote_scale = ?'); params.push(Math.min(300, Math.max(50, Number(fields.emote_scale) || 100))); }
        if (fields.emote_size_min !== undefined) { updates.push('emote_size_min = ?'); params.push(Math.min(200, Math.max(25, Number(fields.emote_size_min) || 50))); }
        if (fields.emote_size_max !== undefined) { updates.push('emote_size_max = ?'); params.push(Math.min(400, Math.max(50, Number(fields.emote_size_max) || 200))); }
        if (fields.sounds_mods_only !== undefined) { updates.push('sounds_mods_only = ?'); params.push(fields.sounds_mods_only ? 1 : 0); }
        if (fields.sound_min_speed !== undefined) { updates.push('sound_min_speed = ?'); params.push(Math.min(1, Math.max(0.1, Number(fields.sound_min_speed) || 0.5))); }
        if (fields.sound_max_speed !== undefined) { updates.push('sound_max_speed = ?'); params.push(Math.min(5, Math.max(1, Number(fields.sound_max_speed) || 3.0))); }
        if (fields.sound_min_pitch_cents !== undefined) { updates.push('sound_min_pitch_cents = ?'); params.push(Math.min(0, Math.max(-2400, Math.round(Number(fields.sound_min_pitch_cents) || -1200)))); }
        if (fields.sound_max_pitch_cents !== undefined) { updates.push('sound_max_pitch_cents = ?'); params.push(Math.max(0, Math.min(2400, Math.round(Number(fields.sound_max_pitch_cents) || 1200)))); }
        if (updates.length > 0) {
            updates.push('updated_at = CURRENT_TIMESTAMP');
            params.push(channelId);
            run(`UPDATE channel_moderation_settings SET ${updates.join(', ')} WHERE channel_id = ?`, params);
        }
    } else {
        run(
            `INSERT INTO channel_moderation_settings (
                channel_id, slow_mode_seconds, followers_only, emote_only,
                allow_anonymous, links_allowed, gifs_enabled, account_age_gate_hours,
                caps_percentage_limit, aggressive_filter, max_message_length,
                slur_filter_enabled, slur_filter_use_builtin, slur_filter_terms, slur_filter_regexes, slur_filter_nudge_message, slur_filter_disabled_categories,
                ip_approval_mode, soundboard_enabled, soundboard_allow_pitch, soundboard_allow_speed, soundboard_banned_ids,
                viewer_auto_delete_enabled, viewer_delete_all_enabled,
                custom_emotes_enabled, custom_sounds_enabled, max_sound_seconds, uploads_mods_only, emote_scale,
                emote_size_min, emote_size_max, sounds_mods_only, mods_can_edit_about
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
            [
                channelId,
                fields.slow_mode_seconds || 0,
                fields.followers_only ? 1 : 0,
                fields.emote_only ? 1 : 0,
                fields.allow_anonymous !== undefined ? (fields.allow_anonymous ? 1 : 0) : 1,
                fields.links_allowed !== undefined ? (fields.links_allowed ? 1 : 0) : 1,
                fields.gifs_enabled !== undefined ? (fields.gifs_enabled ? 1 : 0) : 1,
                Number(fields.account_age_gate_hours) || 0,
                Number(fields.caps_percentage_limit) || 0,
                fields.aggressive_filter ? 1 : 0,
                Math.max(50, Number(fields.max_message_length) || 500),
                fields.slur_filter_enabled ? 1 : 0,
                fields.slur_filter_use_builtin !== undefined ? (fields.slur_filter_use_builtin ? 1 : 0) : 1,
                String(fields.slur_filter_terms || '').slice(0, 4000),
                String(fields.slur_filter_regexes || '').slice(0, 8000),
                String(fields.slur_filter_nudge_message || '').slice(0, 800),
                String(fields.slur_filter_disabled_categories || '[]').slice(0, 200),
                fields.ip_approval_mode ? 1 : 0,
                fields.soundboard_enabled !== undefined ? (fields.soundboard_enabled ? 1 : 0) : 1,
                fields.soundboard_allow_pitch !== undefined ? (fields.soundboard_allow_pitch ? 1 : 0) : 1,
                fields.soundboard_allow_speed !== undefined ? (fields.soundboard_allow_speed ? 1 : 0) : 1,
                String(fields.soundboard_banned_ids || '').slice(0, 4000),
                fields.viewer_auto_delete_enabled !== undefined ? (fields.viewer_auto_delete_enabled ? 1 : 0) : 1,
                fields.viewer_delete_all_enabled !== undefined ? (fields.viewer_delete_all_enabled ? 1 : 0) : 1,
                fields.custom_emotes_enabled !== undefined ? (fields.custom_emotes_enabled ? 1 : 0) : 1,
                fields.custom_sounds_enabled !== undefined ? (fields.custom_sounds_enabled ? 1 : 0) : 1,
                Math.min(30, Math.max(1, Number(fields.max_sound_seconds) || 10)),
                fields.uploads_mods_only ? 1 : 0,
                Math.min(300, Math.max(50, Number(fields.emote_scale) || 100)),
                Math.min(200, Math.max(25, Number(fields.emote_size_min) || 50)),
                Math.min(400, Math.max(50, Number(fields.emote_size_max) || 200)),
                fields.sounds_mods_only ? 1 : 0,
                fields.mods_can_edit_about ? 1 : 0,
            ]
        );
    }
    // tts_max_length is handled here (covers both the UPDATE and freshly-INSERTed row) so we
    // don't have to thread it through the positional INSERT.
    if (fields.tts_max_length !== undefined) {
        try { run('UPDATE channel_moderation_settings SET tts_max_length = ? WHERE channel_id = ?', [Math.min(1000, Math.max(10, Number(fields.tts_max_length) || 200)), channelId]); } catch { /* */ }
    }
    return getChannelModerationSettings(channelId);
}

// ── Paste helpers ────────────────────────────────────────────

// createPaste() removed — the media subsystem (vods/clips/pastes writes) moved to OpenVibe.Media.

function getPasteBySlug(slug) {
    return get(`
        SELECT p.*, u.username, u.avatar_url, u.display_name
        FROM pastes p
        LEFT JOIN users u ON p.user_id = u.id
        WHERE p.slug = ?
    `, [slug]);
}

function getPasteById(id) {
    return get(`
        SELECT p.*, u.username, u.avatar_url, u.display_name
        FROM pastes p
        LEFT JOIN users u ON p.user_id = u.id
        WHERE p.id = ?
    `, [id]);
}

function listPastes({ visibility = 'public', type, search, limit = 30, offset = 0 } = {}) {
    let where = 'WHERE p.visibility = ?';
    const params = [visibility];

    if (type && type !== 'all') {
        where += ' AND p.type = ?';
        params.push(type);
    }
    if (search) {
        where += ' AND (p.title LIKE ? OR p.content LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
    }

    const total = get(`SELECT COUNT(*) as c FROM pastes p ${where}`, params).c;
    const pastes = all(`
        SELECT p.id, p.slug, p.user_id, p.type, p.title, p.language, p.visibility,
               p.screenshot_path, p.burn_after_read, p.pinned, p.views, p.copies, p.likes, p.created_at,
               u.username, u.avatar_url, u.display_name,
               SUBSTR(p.content, 1, 220) as content
        FROM pastes p
        LEFT JOIN users u ON p.user_id = u.id
        ${where}
        ORDER BY p.pinned DESC, p.created_at DESC
        LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    return { pastes, total };
}

function incrementPasteViews(slug) {
    return run('UPDATE pastes SET views = views + 1 WHERE slug = ?', [slug]);
}

function updatePaste(slug, fields) {
    const updates = [];
    const params = [];
    for (const [key, val] of Object.entries(fields)) {
        if (['title', 'content', 'language', 'visibility', 'pinned', 'metadata'].includes(key)) {
            updates.push(`${key} = ?`);
            params.push(val);
        }
    }
    if (updates.length === 0) return;
    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(slug);
    return run(`UPDATE pastes SET ${updates.join(', ')} WHERE slug = ?`, params);
}

function deletePaste(slug) {
    return run('DELETE FROM pastes WHERE slug = ?', [slug]);
}

function getUserPastes(userId, limit = 50) {
    return all(`
        SELECT id, slug, type, title, language, visibility, burn_after_read, pinned, views, copies, likes, created_at
        FROM pastes WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
    `, [userId, limit]);
}

function likePaste(pasteId, userId) {
    run('INSERT OR IGNORE INTO paste_likes (paste_id, user_id) VALUES (?, ?)', [pasteId, userId]);
    run('UPDATE pastes SET likes = (SELECT COUNT(*) FROM paste_likes WHERE paste_id = ?) WHERE id = ?', [pasteId, pasteId]);
    return get('SELECT likes FROM pastes WHERE id = ?', [pasteId]);
}

function unlikePaste(pasteId, userId) {
    run('DELETE FROM paste_likes WHERE paste_id = ? AND user_id = ?', [pasteId, userId]);
    run('UPDATE pastes SET likes = (SELECT COUNT(*) FROM paste_likes WHERE paste_id = ?) WHERE id = ?', [pasteId, pasteId]);
    return get('SELECT likes FROM pastes WHERE id = ?', [pasteId]);
}

function hasUserLikedPaste(pasteId, userId) {
    const row = get('SELECT 1 FROM paste_likes WHERE paste_id = ? AND user_id = ?', [pasteId, userId]);
    return !!row;
}

function incrementPasteCopies(slug) {
    return run('UPDATE pastes SET copies = copies + 1 WHERE slug = ?', [slug]);
}

function countUserPastesToday(userId, ip) {
    if (userId) {
        return get("SELECT COUNT(*) as c FROM pastes WHERE user_id = ? AND created_at > datetime('now', '-1 day')", [userId])?.c || 0;
    }
    if (ip) {
        return get("SELECT COUNT(*) as c FROM pastes WHERE ip_address = ? AND created_at > datetime('now', '-1 day')", [ip])?.c || 0;
    }
    return 0;
}

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

function getLastPasteTime(userId, ip) {
    let row;
    if (userId) {
        row = get('SELECT created_at FROM pastes WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [userId]);
    } else if (ip) {
        row = get('SELECT created_at FROM pastes WHERE ip_address = ? ORDER BY created_at DESC LIMIT 1', [ip]);
    }
    return row ? new Date(row.created_at + (row.created_at.includes('Z') ? '' : 'Z')).getTime() : 0;
}

function deleteAllForks() {
    const forks = all('SELECT id, screenshot_path FROM pastes WHERE forked_from IS NOT NULL');
    // Unlink the fork screenshots so they don't leak on disk.
    for (const f of forks) {
        if (f.screenshot_path) { try { fs.unlinkSync(f.screenshot_path); } catch { /* ignore */ } }
    }
    run('DELETE FROM pastes WHERE forked_from IS NOT NULL');
    return forks.length;
}

function getPasteStats() {
    const total = get('SELECT COUNT(*) as c FROM pastes')?.c || 0;
    const textPastes = get("SELECT COUNT(*) as c FROM pastes WHERE type = 'paste'")?.c || 0;
    const screenshots = get("SELECT COUNT(*) as c FROM pastes WHERE type = 'screenshot'")?.c || 0;
    const forks = get('SELECT COUNT(*) as c FROM pastes WHERE forked_from IS NOT NULL')?.c || 0;
    const totalViews = get('SELECT SUM(views) as s FROM pastes')?.s || 0;
    const totalCopies = get('SELECT SUM(copies) as s FROM pastes')?.s || 0;
    const totalLikes = get('SELECT SUM(likes) as s FROM pastes')?.s || 0;
    return { total, textPastes, screenshots, forks, totalViews, totalCopies, totalLikes };
}

// ── Paste Comment helpers ────────────────────────────────────

function createPasteComment({ paste_id, user_id, parent_id, anon_name, message, ip_address }) {
    return run(
        `INSERT INTO paste_comments (paste_id, user_id, parent_id, anon_name, message, ip_address)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [paste_id, user_id || null, parent_id || null, anon_name || null, message, ip_address || null]
    );
}

function getPasteComments(pasteId, limit = 50, offset = 0) {
    return all(`
        SELECT c.*, u.username, u.display_name, u.avatar_url, u.profile_color, u.role
        FROM paste_comments c
        LEFT JOIN users u ON c.user_id = u.id
        WHERE c.paste_id = ? AND c.is_deleted = 0 AND c.parent_id IS NULL
        ORDER BY c.created_at DESC
        LIMIT ? OFFSET ?
    `, [pasteId, limit, offset]);
}

function getPasteCommentReplies(parentId) {
    return all(`
        SELECT c.*, u.username, u.display_name, u.avatar_url, u.profile_color, u.role
        FROM paste_comments c
        LEFT JOIN users u ON c.user_id = u.id
        WHERE c.parent_id = ? AND c.is_deleted = 0
        ORDER BY c.created_at ASC
    `, [parentId]);
}

function getPasteCommentById(commentId) {
    return get('SELECT * FROM paste_comments WHERE id = ?', [commentId]);
}

function getPasteCommentCount(pasteId) {
    const row = get('SELECT COUNT(*) as count FROM paste_comments WHERE paste_id = ? AND is_deleted = 0', [pasteId]);
    return row ? row.count : 0;
}

function deletePasteComment(commentId) {
    return run('UPDATE paste_comments SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [commentId]);
}

// ── Anon IP Mapping ─────────────────────────────────

/**
 * Get or assign a persistent anon number for a normalized IP.
 * Returns the existing number if the IP was seen before, or assigns
 * the next sequential number. Survives server restarts.
 */
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

// ── Stream First Chats (Welcome Messages) ────────────────────

/**
 * Check if a chatter has ever chatted in this streamer's channel.
 * @param {string} chatterKey - e.g. "user:42" or "anon:anon3" or "ext:[Twitch] foo"
 * @param {number} channelUserId - the streamer's user ID
 * @returns {boolean} true if this is their first time
 */
function isFirstChatInChannel(chatterKey, channelUserId) {
    const row = get(
        'SELECT 1 FROM stream_first_chats WHERE chatter_key = ? AND channel_user_id = ?',
        [chatterKey, channelUserId]
    );
    return !row;
}

/**
 * Record that a chatter has chatted in a streamer's channel.
 */
function recordFirstChat(chatterKey, channelUserId) {
    run(
        'INSERT OR IGNORE INTO stream_first_chats (chatter_key, channel_user_id) VALUES (?, ?)',
        [chatterKey, channelUserId]
    );
}

function getRecentPasteCommentsByIp(ip, seconds = 10) {
    return all(`
        SELECT * FROM paste_comments
        WHERE ip_address = ? AND created_at > datetime('now', '-' || ? || ' seconds')
        ORDER BY created_at DESC
    `, [ip, seconds]);
}

// ── Moderation Action Logging ────────────────────────────────

/**
 * Log a moderation action for auditing.
 * Used by canvas, chat moderation, bans, etc.
 */
function logModerationAction({ scope_type, scope_id, actor_user_id, target_user_id, action_type, details }) {
    return run(`
        INSERT INTO moderation_actions (scope_type, scope_id, actor_user_id, target_user_id, action_type, details)
        VALUES (?, ?, ?, ?, ?, ?)
    `, [scope_type || 'site', scope_id || null, actor_user_id || null, target_user_id || null, action_type, JSON.stringify(details || {})]);
}

/**
 * Get moderation actions with optional filters.
 */
function getModerationActions({ scopeType, scope_type, scopeId, scope_id, actor_user_id, target_user_id, limit = 50, offset = 0 } = {}) {
    const conditions = [];
    const params = [];
    const st = scopeType || scope_type;
    const si = scopeId || scope_id;
    if (st) { conditions.push('ma.scope_type = ?'); params.push(st); }
    if (si) { conditions.push('ma.scope_id = ?'); params.push(si); }
    if (actor_user_id) { conditions.push('ma.actor_user_id = ?'); params.push(actor_user_id); }
    if (target_user_id) { conditions.push('ma.target_user_id = ?'); params.push(target_user_id); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit, offset);
    return all(`
        SELECT ma.*, actor.username AS actor_username, target.username AS target_username
        FROM moderation_actions ma
        LEFT JOIN users actor ON ma.actor_user_id = actor.id
        LEFT JOIN users target ON ma.target_user_id = target.id
        ${where}
        ORDER BY ma.created_at DESC
        LIMIT ? OFFSET ?
    `, params);
}

/**
 * Get a single chat message by ID.
 */
function getChatMessageById(id) {
    return get('SELECT * FROM chat_messages WHERE id = ?', [id]);
}

/**
 * Soft-delete a chat message by ID. Sets is_deleted=1 and records who deleted it.
 */
function deleteChatMessage(id, deletedBy = null) {
    return run(
        'UPDATE chat_messages SET is_deleted = 1, deleted_by = ?, deleted_at = CURRENT_TIMESTAMP WHERE id = ?',
        [deletedBy, id]
    );
}

/**
 * Soft-delete ALL chat messages from a specific user, optionally scoped to a stream.
 * Returns the list of deleted message IDs for real-time broadcast.
 */
function deleteUserChatMessages(userId, { streamId = null, deletedBy = null } = {}) {
    const condition = streamId
        ? 'user_id = ? AND stream_id = ? AND is_deleted = 0'
        : 'user_id = ? AND is_deleted = 0';
    const params = streamId ? [userId, streamId] : [userId];
    const messages = all(`SELECT id FROM chat_messages WHERE ${condition}`, params);
    const ids = messages.map(m => m.id);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    run(
        `UPDATE chat_messages SET is_deleted = 1, deleted_by = ?, deleted_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
        [deletedBy, ...ids]
    );
    return ids;
}

/**
 * Soft-delete ALL chat messages from a specific anon_id, optionally scoped to stream.
 */
function deleteAnonChatMessages(anonId, { streamId = null, deletedBy = null } = {}) {
    const condition = streamId
        ? 'anon_id = ? AND stream_id = ? AND is_deleted = 0'
        : 'anon_id = ? AND is_deleted = 0';
    const params = streamId ? [anonId, streamId] : [anonId];
    const messages = all(`SELECT id FROM chat_messages WHERE ${condition}`, params);
    const ids = messages.map(m => m.id);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    run(
        `UPDATE chat_messages SET is_deleted = 1, deleted_by = ?, deleted_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
        [deletedBy, ...ids]
    );
    return ids;
}

/**
 * Soft-delete ALL messages from a relayed external username (e.g. "[Twitch] foobar")
 */
function deleteRelayUserMessages(username, { streamId = null, deletedBy = null } = {}) {
    const condition = streamId
        ? 'username = ? AND stream_id = ? AND is_deleted = 0'
        : 'username = ? AND is_deleted = 0';
    const params = streamId ? [username, streamId] : [username];
    const messages = all(`SELECT id FROM chat_messages WHERE ${condition}`, params);
    const ids = messages.map(m => m.id);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    run(
        `UPDATE chat_messages SET is_deleted = 1, deleted_by = ?, deleted_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
        [deletedBy, ...ids]
    );
    return ids;
}

function deleteExpiredChatMessages(limit = 500) {
    const rows = all(
        `SELECT id, stream_id
         FROM chat_messages
         WHERE is_deleted = 0
           AND auto_delete_at IS NOT NULL
           AND datetime(auto_delete_at) <= CURRENT_TIMESTAMP
         ORDER BY auto_delete_at ASC
         LIMIT ?`,
        [Math.max(1, Number(limit) || 500)]
    );
    if (!rows.length) return [];

    const ids = rows.map(row => row.id);
    const placeholders = ids.map(() => '?').join(',');
    run(
        `UPDATE chat_messages
         SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP
         WHERE id IN (${placeholders})`,
        ids
    );
    return rows;
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

/**
 * Hold a message for IP approval.
 */
function holdMessageForApproval({ channelId, streamId, ip, userId, anonId, username, message }) {
    return run(
        `INSERT INTO pending_ip_messages (channel_id, stream_id, ip_address, user_id, anon_id, username, message)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [channelId, streamId, ip, userId || null, anonId || null, username, message]
    );
}

/**
 * Get pending messages for a channel.
 */
function getPendingIpMessages(channelId, { limit = 50 } = {}) {
    return all(
        `SELECT * FROM pending_ip_messages WHERE channel_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT ?`,
        [channelId, limit]
    );
}

/**
 * Approve or deny a pending IP message. If approved, auto-approve the IP too.
 */
function reviewPendingIpMessage(id, { status, reviewedBy, channelId }) {
    run('UPDATE pending_ip_messages SET status = ?, reviewed_by = ? WHERE id = ?', [status, reviewedBy, id]);
    if (status === 'approved') {
        const msg = get('SELECT * FROM pending_ip_messages WHERE id = ?', [id]);
        if (msg) approveIp(channelId || msg.channel_id, msg.ip_address, reviewedBy, 'manual');
    }
}

/**
 * Bulk-approve all pending messages from a specific IP in a channel.
 */
function approveAllFromIp(channelId, ip, reviewedBy) {
    approveIp(channelId, ip, reviewedBy, 'manual');
    return run(
        "UPDATE pending_ip_messages SET status = 'approved', reviewed_by = ? WHERE channel_id = ? AND ip_address = ? AND status = 'pending'",
        [reviewedBy, channelId, ip]
    );
}

/**
 * Deny all pending messages from a specific IP in a channel.
 */
function denyAllFromIp(channelId, ip, reviewedBy) {
    return run(
        "UPDATE pending_ip_messages SET status = 'denied', reviewed_by = ? WHERE channel_id = ? AND ip_address = ? AND status = 'pending'",
        [reviewedBy, channelId, ip]
    );
}

// ── Hidden Relay Users ───────────────────────────────────────

/**
 * Hide or ban a relayed external user.
 */
function hideRelayUser({ channelId, platform, externalUsername, action = 'hide', reason, createdBy }) {
    return run(
        `INSERT OR REPLACE INTO hidden_relay_users (channel_id, platform, external_username, action, reason, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [channelId || null, platform, externalUsername, action, reason || null, createdBy]
    );
}

/**
 * Check if a relayed user is hidden/banned.
 * Checks both channel-scoped and site-wide entries (channel_id IS NULL).
 */
function isRelayUserHidden(channelId, platform, externalUsername) {
    return !!get(
        `SELECT 1 FROM hidden_relay_users
         WHERE platform = ? AND external_username = ? AND (channel_id = ? OR channel_id IS NULL)`,
        [platform, externalUsername, channelId]
    );
}

/**
 * Unhide/unban a relayed external user.
 */
function unhideRelayUser(id) {
    return run('DELETE FROM hidden_relay_users WHERE id = ?', [id]);
}

/**
 * Unhide/unban a relayed external user by identity (platform + external username +
 * channel). Scoped to a single relay identity — never touches a registered
 * openvibelive account of the same name. `channel_id IS ?` matches NULL safely.
 */
function unhideRelayUserByIdentity(channelId, platform, externalUsername) {
    return run(
        'DELETE FROM hidden_relay_users WHERE platform = ? AND external_username = ? AND channel_id IS ?',
        [platform, externalUsername, channelId || null]
    );
}

/**
 * Get hidden relay users for a channel (includes site-wide).
 */
function getHiddenRelayUsers(channelId, { limit = 100 } = {}) {
    return all(
        `SELECT hru.*, u.username as created_by_username
         FROM hidden_relay_users hru LEFT JOIN users u ON hru.created_by = u.id
         WHERE hru.channel_id = ? OR hru.channel_id IS NULL
         ORDER BY hru.created_at DESC LIMIT ?`,
        [channelId, limit]
    );
}

/**
 * Search chat messages within a specific channel's streams.
 */
function searchChannelChatMessages(channelId, { query, userId, limit = 50, offset = 0 } = {}) {
    const conditions = [
        'cm.stream_id IN (SELECT id FROM streams WHERE channel_id = ?)',
        'cm.is_deleted = 0',
        '(cm.auto_delete_at IS NULL OR datetime(cm.auto_delete_at) > CURRENT_TIMESTAMP)',
    ];
    const params = [channelId];
    if (query) {
        conditions.push('cm.message LIKE ?');
        params.push(`%${query}%`);
    }
    if (userId) {
        conditions.push('cm.user_id = ?');
        params.push(userId);
    }
    params.push(limit, offset);
    return {
        messages: all(`
            SELECT cm.*, u.username, u.display_name, u.avatar_url
            FROM chat_messages cm
            LEFT JOIN users u ON cm.user_id = u.id
            WHERE ${conditions.join(' AND ')}
            ORDER BY cm.created_at DESC
            LIMIT ? OFFSET ?
        `, params),
    };
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
    const users = all(`
        SELECT DISTINCT il.user_id
        FROM ip_log il
        WHERE il.ip_address = ? AND il.user_id IS NOT NULL
    `, [ip]);

    const bannedIds = [];
    for (const row of users) {
        if (!row.user_id) continue;
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

    // Unique chatters
    const chattersRow = get(
        `SELECT COUNT(DISTINCT COALESCE(user_id, anon_id)) as cnt
         FROM chat_messages WHERE stream_id = ? AND is_deleted = 0 AND is_global = 0`,
        [streamId]
    );
    const uniqueChatters = chattersRow?.cnt || 0;

    // Total messages
    const msgsRow = get(
        `SELECT COUNT(*) as cnt FROM chat_messages
         WHERE stream_id = ? AND is_deleted = 0 AND is_global = 0 AND message_type = 'chat'`,
        [streamId]
    );
    const totalMessages = msgsRow?.cnt || 0;

    // Total watch minutes
    const watchRow = get(
        'SELECT SUM(minutes_watched) as total FROM watch_time WHERE stream_id = ?', [streamId]
    );
    const totalWatchMinutes = watchRow?.total || 0;

    // Clips created during this stream
    const clipsRow = get(
        'SELECT COUNT(*) as cnt FROM clips WHERE stream_id = ?', [streamId]
    );
    const clipsCreated = clipsRow?.cnt || 0;

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

function getRecentChatActivity(streamId, minutes) {
    const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    const row = get(
        `SELECT COUNT(*) as cnt FROM chat_messages
         WHERE stream_id = ? AND timestamp >= ? AND is_deleted = 0 AND is_global = 0 AND message_type = 'chat'`,
        [streamId, cutoff]
    );
    return row?.cnt || 0;
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

/* ── Chat Log Management ──────────────────────────────────── */

function deleteChatMessagesByTimeRange(streamId, fromTime, toTime, deletedBy) {
    if (streamId) {
        return run(
            `UPDATE chat_messages SET is_deleted = 1, deleted_by = ?, deleted_at = CURRENT_TIMESTAMP
             WHERE stream_id = ? AND timestamp >= ? AND timestamp <= ? AND is_deleted = 0`,
            [deletedBy, streamId, fromTime, toTime]
        );
    }
    // Global chat (is_global = 1)
    return run(
        `UPDATE chat_messages SET is_deleted = 1, deleted_by = ?, deleted_at = CURRENT_TIMESTAMP
         WHERE is_global = 1 AND timestamp >= ? AND timestamp <= ? AND is_deleted = 0`,
        [deletedBy, fromTime, toTime]
    );
}

function countChatMessagesByTimeRange(streamId, fromTime, toTime) {
    let row;
    if (streamId) {
        row = get(
            `SELECT COUNT(*) as cnt FROM chat_messages
             WHERE stream_id = ? AND timestamp >= ? AND timestamp <= ? AND is_deleted = 0`,
            [streamId, fromTime, toTime]
        );
    } else {
        row = get(
            `SELECT COUNT(*) as cnt FROM chat_messages
             WHERE is_global = 1 AND timestamp >= ? AND timestamp <= ? AND is_deleted = 0`,
            [fromTime, toTime]
        );
    }
    return row?.cnt || 0;
}

function getChatLogs({ streamId, username, search, from, to, messageType, page = 1, limit = 50, includeDeleted = false } = {}) {
    const conditions = [];
    const params = [];

    if (streamId) { conditions.push('stream_id = ?'); params.push(streamId); }
    if (username) { conditions.push('username LIKE ?'); params.push(`%${username}%`); }
    if (search) { conditions.push('message LIKE ?'); params.push(`%${search}%`); }
    if (from) { conditions.push('timestamp >= ?'); params.push(from); }
    if (to) { conditions.push('timestamp <= ?'); params.push(to); }
    if (messageType) { conditions.push('message_type = ?'); params.push(messageType); }
    if (!includeDeleted) { conditions.push('is_deleted = 0'); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const offset = (page - 1) * limit;

    const countRow = get(`SELECT COUNT(*) as total FROM chat_messages ${where}`, params);
    const total = countRow?.total || 0;
    const rows = all(
        `SELECT * FROM chat_messages ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    );

    return { rows, total, page, limit, totalPages: Math.ceil(total / limit) };
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
        `SELECT t.*, u.id as uid, u.username, u.display_name, u.role, u.profile_color, u.avatar_url
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
    getVodAiState, getClipAiState,
    scheduleClipNotifyState, bumpClipNotifyNowState, markClipNotifiedState, getDueClipNotifies,
    getDb, initDb, run, get, all, close,
    getDonationGoalsForWidget, getAllDonationGoals, getActiveDonationGoals, getDonationGoalById,
    createDonationGoal, updateDonationGoal, deleteDonationGoal, addToDonationGoal,
    setChannelAlertSound, getChannelAlertSoundsByUser,
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
    getLiveStreams, getRecentStreams, getStreamById, getStreamByUserId, getLiveStreamsByUserId, getLiveStreamsByControlConfigId, getStreamsByUserId, getStreamHistoryByManagedStream,
    createStream, endStream, endOtherLiveStreamsForSlot, updateViewerCount,
    addStreamMemory, getStreamMemories, getLatestStreamMemory, updateStreamAiOverview,
    setVodAiOverview, setClipAiOverview, setVodTranscript, setClipTranscript, getStreamMemoriesInRange,
    getVodsNeedingOverview, getClipsNeedingOverview, getVodsNeedingTimeline, getVodsNeedingTranscript, getClipsNeedingTranscript, getPastesNeedingAnalysis,
    setVodTranscriptStatus, setClipTranscriptStatus, bumpVodTranscriptAttempt, bumpClipTranscriptAttempt,
    updatePasteAi, cleanupMalformedAiText,  recordAiUsage, getAiCostToday, getAiCostTodayForUser, getAiUsageSummary,
    getStreamMemoriesByUser, countStreamMemoriesByUser, getAiMomentCandidates, getStreamTranscriptSegments, getUserPastesForAi,
    addTimelineEvents, getTimeline, getTimelineText, getTimelineCoverage, linkTimelineToVod, getTimelineByVod, getTimelineVodId,
    getVodsForMomentRanking, getClipStartTimesForStream, getChatSpikeOffsets,
     getLiveChatBuckets, getRecentChatText, getVodsWithoutAutoClip, 
    upsertStreamerOverview, getStreamerOverview, getAllStreamerOverviews, getStreamersNeedingOverview,
    getStreamerAiTimeline, assembleStreamerAiTimeline, setStreamAiTitle, getUntitledAiSessions, clearAiTimelineCache,
    // Homepage helpers
    getRecentlyOnlineStreamers, countRecentlyOnlineStreamers,
    getRecentVods, countRecentVods, getHomeStats,
    // Filtered VODs/clips
    getVodsByUserFiltered, countVodsByUserFiltered, getPopularVodForUser, getPopularClipForUser, getTopContentRanges,
    getClipsOfUserStreamsPaginated, countClipsOfUserStreams,
    getClipsByUserPaginated,
    // Channels
    getChannelByUserId, getChannelsByUserIds, getChannelByUsername, createChannel, updateChannel, ensureChannel, setUserBio,
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
    createPaymentOrder, getPaymentOrderById, getPaymentOrderByRef, updatePaymentOrder,
    upsertSubscription, getSubscriptionByProviderRef, getActiveSubscription, isActiveSubscriber,
    getSubscriptionsByStreamer, getSubscriptionsBySubscriber, getActiveSubscriberCount, setSubscriptionStatus,
    getSubscriptionsDueRenewal,
    getRestreamDestinationsByManagedStream,
    // Chat
    saveChatMessage, searchChatMessages, getUserChatHistory,
    // Chat AI summaries
    getMaxChatMessageId, countChatMessagesSince, getChatMessagesForAi, getNthRecentChatTs,
    getChatAiSummary, getChatAiSummaries, upsertChatAiSummary, getUsersNeedingChatAi,
    addChatTimelineEvents, getChatTimelineEvents,
    recordEasterEggSolve, hasSolvedEasterEgg, countEasterEggSolves,
    getTtsVoiceOverride, setTtsVoiceOverride, deleteTtsVoiceOverride,
    // Profiles
    getUserProfile, updateUserAvatar,  getUserAvatarPastes,
    getKickChannelCache, setKickChannelCache,
    getChannelPoints, addChannelPoints, deductChannelPoints,
    // Follows
    followUser, unfollowUser, getFollowerCount, isFollowing, getFollowerIds,
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
    createMediaRequest, getMediaRequestById, getMediaRequestByStreamerAndId,
    getActiveMediaRequestByStreamer, getNextPendingMediaRequest,
    getPendingMediaRequestsByStreamer, getRecentMediaRequestsByStreamer,
    countPendingMediaRequestsForUser, getMediaRequestMaxQueuePosition,
    findActiveMediaRequestByCanonicalUrl, updateMediaRequest,
    renormalizePendingMediaRequestPositions,
    // VODs
    getVodById, getVodsByUser, countVodsByUser, getPublicVods, countPublicVods, listVodStreamers, getActiveVodByStream, 
    updateVodHealth, repairVodDuration, getVodHealthById, getVodScanCandidates,
    getVodsNeedingHealthScan, getQuarantinedVodsForCleanup,
    // Clips
    getClipById, getClipsByUser, countClipsByUser, getPublicClips, countPublicClips, listClipStreamers, getClipsByStream,    getClipsOfUserStreams, 
    getClipsTakenByUser, countClipsTakenByUser, getClipsTakenFacets,
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
    isUserBanned, isIpBanned,
    // Emotes
    createEmote, getEmoteById, getEmotesByUser, getGlobalEmotes, getChannelEmotes, updateEmote,
    deleteEmote, getEmoteByCode, countUserEmotes, countChannelEmotes, getChannelEmoteByCode,
    createChannelSound, setChannelSoundEmote, getChannelSounds, getChannelSoundByCommand, getChannelSoundById, renameChannelSoundCommand, updateChannelSoundEmoteRefs,
    countChannelSounds, countChannelSoundsByUploader, deleteChannelSound,
    getAiChatbotConfig, upsertAiChatbotConfig,
    getChannelAiConfig, upsertChannelAiConfig,
    createChannelAiBot, getChannelAiBot, getChannelAiBots, getChannelAiBotByUsername,
    updateChannelAiBot, touchChannelAiBot, deleteChannelAiBot,
    // Site Settings
    getSetting, getSettingRow, getAllSettings, setSetting, deleteSetting,
    saveVodTranscriptProgress, getVodTranscriptProgress,
    getState, setState, deleteState,
    // Verification Keys
    createVerificationKey, getVerificationKeyByKey, getVerificationKeyByUsername,
    getAllVerificationKeys, redeemVerificationKey, revokeVerificationKey, isUsernameReserved,
    // Comments
    createComment, getComments, getCommentReplies, getCommentById, getCommentCount,
    deleteComment, updateComment,
    // Chat Replay
    getChatReplay,
    // Channel lookup
    getChannelById,
    // Channel Moderators
    isChannelModerator, addChannelModerator, removeChannelModerator,
    getChannelModerators, getChannelsByModerator,
    // Channel Moderation Settings
    getChannelModerationSettings, upsertChannelModerationSettings,
    // Pastes
    getPasteBySlug, getPasteById, listPastes,
    incrementPasteViews, updatePaste, deletePaste, getUserPastes, getUserPastesForChannel, countUserPastesForChannel,
    likePaste, unlikePaste, hasUserLikedPaste, incrementPasteCopies,
    countUserPastesToday, getLastPasteTime, deleteAllForks, getPasteStats, getUserTotalGameLevel,
    // Paste Comments
    createPasteComment, getPasteComments, getPasteCommentReplies,
    getPasteCommentById, getPasteCommentCount, deletePasteComment,
    getRecentPasteCommentsByIp,
    // Anon IP Mappings
    getOrCreateAnonNum, loadAnonMappings,
    // Stream first chats (welcome messages)
    isFirstChatInChannel, recordFirstChat,
    // Moderation Action Logging
    logModerationAction, getModerationActions,
    getChatMessageById, deleteChatMessage, searchChannelChatMessages,
    deleteUserChatMessages, deleteAnonChatMessages, deleteRelayUserMessages, deleteExpiredChatMessages,
    // Approved IPs (Anti-VPN)
    isIpApproved, approveIp, revokeIpApproval, getApprovedIps,
    holdMessageForApproval, getPendingIpMessages, reviewPendingIpMessage,
    approveAllFromIp, denyAllFromIp,
    // Hidden Relay Users
    hideRelayUser, isRelayUserHidden, unhideRelayUser, unhideRelayUserByIdentity, getHiddenRelayUsers, recordRelayUser, getRelayUser,
    getRelayUserByRowid, getRelayUserChatHistory, getRelayChatMessagesForAi, getRelayUsersNeedingChatAi,
    anonSubjectId, getAnonMeta, getAnonChatHistory, getAnonChatMessagesForAi, getAnonsNeedingChatAi,
    // IP Tracking
    logIp, getIpsByUser, getUsersByIp, getLinkedAccounts, getLinkedAccountsByAnon,
    getLatestIpForUser, getLatestIpForAnon, getIpLog, banAllAccountsOnIp,
    // Stream Analytics
    insertViewerSnapshot, getViewerSnapshots, computeAndCacheStreamAnalytics,
    getStreamAnalytics, getChannelAnalyticsSummary, getRecentChatActivity,
    // User Preferences
    getUserPreferences, saveUserPreferences,
    // Chat Log Management
    deleteChatMessagesByTimeRange, countChatMessagesByTimeRange, getChatLogs,
    // API Tokens
    createApiToken, listApiTokens, revokeApiToken, validateApiToken,
};
