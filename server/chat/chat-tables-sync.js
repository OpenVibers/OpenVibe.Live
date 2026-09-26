'use strict';
/**
 * Keeping OpenVibe.Chat's copy of the staged tables current while Live writes them, and checking it
 * (roadmap C-04; chat-tables.js says who writes what). Started by chat-tables.init() only.
 *
 * Capture. TEMP triggers on Live's connection record every insert, update and delete on a staged
 * table in chat_staged_outbox, while the table is listed in temp.chat_staged_capture — the tables Live
 * writes. Rows Chat's mirror applies to a table Chat writes are never captured.
 *
 * Relay. Every 2 s the outbox goes to Chat's bridge as `stagedApply` — each row as it is now (so
 * repeated changes to a row collapse into one), in the order of their last change — and leaves the
 * outbox once Chat has acknowledged it. drain(table) empties one table's part before a handoff.
 * Paused (app_state `chat_table_relay_paused`, POST /internal/chat-tables/relay) the capture goes on
 * and nothing is sent: pause, snapshot live.db, import the snapshot into Chat, resume — every change
 * made after the pause then reaches Chat after the import, so the import never undoes one.
 *
 * Dual read. With a table's flag on, Live's reads of it (the database.js readers below, and
 * tags.getUserTags) also ask Chat for the same slice — the rows whose columns equal the read's keys —
 * and compare row count and content hash (Chat's database.js sliceHash, computed the same way here).
 * After the read, in the background, at most once a minute per slice and 30 times a minute in all;
 * inconclusive (not counted as a mismatch) while the table still has changes on their way to Chat
 * or when Live's own rows changed during the comparison. Counts are kept in chat_dual_read_stats.
 * Live's answer is never changed.
 */
const crypto = require('crypto');
const db = require('../db/database');
const chatTables = require('./chat-tables');

const BATCH = 200;
const RELAY_MS = 2000;
const SLICE_EVERY_MS = 60_000;
const COMPARES_PER_MIN = 30;

const relay = { sent: 0, failed: 0, lastError: null, lastSentAt: null };
let started = false;
const PAUSE_KEY = 'chat_table_relay_paused';

function paused() { try { return db.getState(PAUSE_KEY) === '1'; } catch { return false; } }
function setPaused(on) {
    if (on) db.setState(PAUSE_KEY, '1'); else db.deleteState(PAUSE_KEY);
    return paused();
}

function ensureTables() {
    db.getDb().exec(`
        CREATE TABLE IF NOT EXISTS chat_staged_outbox (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            tbl TEXT NOT NULL,
            op TEXT NOT NULL,
            pk TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS chat_dual_read_stats (
            tbl TEXT PRIMARY KEY,
            compared INTEGER NOT NULL DEFAULT 0,
            matched INTEGER NOT NULL DEFAULT 0,
            mismatched INTEGER NOT NULL DEFAULT 0,
            inconclusive INTEGER NOT NULL DEFAULT 0,
            errors INTEGER NOT NULL DEFAULT 0,
            last_mismatch_at DATETIME,
            last_mismatch TEXT,
            since DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
}

// ── Capture ─────────────────────────────────────────────────────

function installCapture() {
    const d = db.getDb();
    d.exec('CREATE TEMP TABLE IF NOT EXISTS chat_staged_capture (tbl TEXT PRIMARY KEY)');
    for (const [table, pk] of Object.entries(chatTables.TABLES)) {
        const obj = (alias) => `json_object(${pk.map((c) => `'${c}', ${alias}.${c}`).join(', ')})`;
        const when = `WHEN EXISTS (SELECT 1 FROM temp.chat_staged_capture WHERE tbl = '${table}')`;
        try {
            d.exec(`
                CREATE TEMP TRIGGER IF NOT EXISTS chat_staged_${table}_ins AFTER INSERT ON main.${table} ${when}
                BEGIN INSERT INTO chat_staged_outbox (tbl, op, pk) VALUES ('${table}', 'upsert', ${obj('NEW')}); END;
                CREATE TEMP TRIGGER IF NOT EXISTS chat_staged_${table}_upd AFTER UPDATE ON main.${table} ${when}
                BEGIN INSERT INTO chat_staged_outbox (tbl, op, pk) VALUES ('${table}', 'upsert', ${obj('NEW')}); END;
                CREATE TEMP TRIGGER IF NOT EXISTS chat_staged_${table}_del AFTER DELETE ON main.${table} ${when}
                BEGIN INSERT INTO chat_staged_outbox (tbl, op, pk) VALUES ('${table}', 'delete', ${obj('OLD')}); END;
            `);
        } catch (err) { console.warn(`[ChatTables] capture for ${table}: ${err.message}`); }
        setCapture(table, chatTables.authority(table) === 'live');
    }
}

function setCapture(table, on) {
    const d = db.getDb();
    if (on) d.prepare('INSERT OR IGNORE INTO temp.chat_staged_capture (tbl) VALUES (?)').run(table);
    else d.prepare('DELETE FROM temp.chat_staged_capture WHERE tbl = ?').run(table);
}

function pending(table = null) {
    try {
        return table
            ? db.get('SELECT COUNT(*) AS n FROM chat_staged_outbox WHERE tbl = ?', [table]).n
            : db.get('SELECT COUNT(*) AS n FROM chat_staged_outbox').n;
    } catch { return 0; }   // no outbox: nothing was ever captured
}

// ── Relay ───────────────────────────────────────────────────────

/** The outbox rows as changes: each row as it is now, ordered by its last change. */
function buildChanges(rows) {
    const last = new Map();
    for (const r of rows) last.set(`${r.tbl}|${r.pk}`, r);
    const changes = [];
    for (const r of [...last.values()].sort((a, b) => a.seq - b.seq)) {
        const cols = chatTables.TABLES[r.tbl];
        if (!cols) continue;
        let pk;
        try { pk = JSON.parse(r.pk); } catch { continue; }
        const row = r.op === 'delete' ? null : db.get(`SELECT * FROM ${r.tbl} WHERE ${cols.map((c) => `${c} = ?`).join(' AND ')}`, cols.map((c) => pk[c]));
        changes.push(row ? { table: r.tbl, op: 'upsert', row } : { table: r.tbl, op: 'delete', pk });
    }
    return changes;
}

let busy = null;
/** Send the outbox (or only one table's rows) to Chat. → { sent, pending, error } */
function flush(table = null) {
    if (busy) return busy.then(() => flush(table));
    if (paused()) return Promise.resolve({ sent: 0, pending: pending(table), error: 'relay paused' });
    busy = (async () => {
        let sent = 0;
        for (;;) {
            const rows = table
                ? db.all('SELECT seq, tbl, op, pk FROM chat_staged_outbox WHERE tbl = ? ORDER BY seq LIMIT ?', [table, BATCH])
                : db.all('SELECT seq, tbl, op, pk FROM chat_staged_outbox ORDER BY seq LIMIT ?', [BATCH]);
            if (!rows.length) break;
            const changes = buildChanges(rows);
            let out;
            try {
                out = await chatTables.callChat('stagedApply', [changes]);
            } catch (err) {
                relay.failed++;
                if (relay.lastError !== err.message) console.warn(`[ChatTables] relay to Chat waiting (${pending()} queued): ${err.message}`);
                relay.lastError = err.message;
                break;
            }
            // Chat refusing a change means it thinks it writes that table: keep those rows (never lose
            // Live's write), report it, and stop until an operator makes both sides agree.
            const refused = new Set((out.skipped || []).filter((s) => /table_authority chat/.test(s.reason || '')).map((s) => s.table));
            const done = rows.filter((r) => !refused.has(r.tbl)).map((r) => r.seq);
            for (let i = 0; i < done.length; i += 500) {
                const part = done.slice(i, i + 500);
                db.run(`DELETE FROM chat_staged_outbox WHERE seq IN (${part.map(() => '?').join(',')})`, part);
            }
            sent += changes.length;
            relay.sent += changes.length;
            relay.lastSentAt = new Date().toISOString();
            if (refused.size) {
                relay.lastError = `OpenVibe.Chat writes ${[...refused].join(', ')} but Live does too: run the handoff again (POST /internal/chat-tables/:table)`;
                console.warn(`[ChatTables] ${relay.lastError}`);
                break;
            }
            relay.lastError = null;
            const other = (out.skipped || []).filter((s) => !refused.has(s.table));
            if (other.length) console.warn(`[ChatTables] Chat skipped ${other.length} change(s):`, JSON.stringify(other.slice(0, 3)));
        }
        return { sent, pending: pending(table), error: relay.lastError };
    })().finally(() => { busy = null; });
    return busy;
}

/** Before a handoff to Chat: every captured change of the table acknowledged, or throw. */
async function drain(table, { timeoutMs = 20000 } = {}) {
    const until = Date.now() + timeoutMs;
    while (pending(table) > 0) {
        const r = await flush(table);
        if (!pending(table)) break;
        if (r.error || Date.now() > until) {
            throw Object.assign(new Error(`${pending(table)} change(s) to ${table} not in OpenVibe.Chat yet${r.error ? `: ${r.error}` : ''}`), { status: 503 });
        }
    }
}

function relayStats() { return { ...relay, paused: paused(), pending: pending() }; }

// ── Dual read ───────────────────────────────────────────────────

const num = (v) => (typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v);
// Live's readers of the staged tables and the slices each read touches.
const READERS = [
    ['getChannelModerationSettings', 'channel_moderation_settings', (a) => [{ channel_id: num(a[0]) }]],
    ['getChannelModerators', 'channel_moderators', (a) => [{ channel_id: num(a[0]) }]],
    ['isChannelModerator', 'channel_moderators', (a) => [{ channel_id: num(a[1]) }]],
    ['getChannelsByModerator', 'channel_moderators', (a) => [{ user_id: num(a[0]) }]],
    ['getEmoteById', 'emotes', (a) => [{ id: num(a[0]) }]],
    ['getEmotesByUser', 'emotes', (a) => [{ user_id: num(a[0]) }]],
    ['getChannelEmotes', 'emotes', (a) => [{ channel_owner_id: num(a[0]) }, { user_id: num(a[0]), channel_owner_id: null }]],
    ['getGlobalEmotes', 'emotes', () => [{ is_global: 1 }]],
    ['getChatAiSummary', 'chat_ai_summaries', (a) => [{ scope: a[0], subject_id: num(a[1]) || 0, window: a[2] }]],
    ['getChatAiSummaries', 'chat_ai_summaries', (a) => [{ scope: a[0], subject_id: num(a[1]) || 0 }]],
    ['getChatTimelineEvents', 'chat_timeline_events', (a) => [{ scope: (a[0] && a[0].scope) || 'global', subject_id: num(a[0] && a[0].subjectId) || 0 }]],
];

/** Chat's sliceHash (OpenVibe.Chat server/db/database.js): sha256 of the rows as arrays in column order. */
function sliceHash(columns, rows) {
    const body = JSON.stringify(rows.map((r) => columns.map((c) => (r[c] === undefined ? null : r[c]))));
    return crypto.createHash('sha256').update(body).digest('hex');
}
const _cols = new Map();
function liveColumns(table) {
    if (!_cols.has(table)) _cols.set(table, db.getDb().prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name).sort());
    return _cols.get(table);
}
function localSlice(table, where, columns) {
    const keys = Object.keys(where);
    const rows = db.all(`SELECT ${columns.join(', ')} FROM ${table} WHERE ${keys.map((k) => `${k} IS ?`).join(' AND ') || '1'} ORDER BY ${chatTables.TABLES[table].join(', ')}`, keys.map((k) => where[k]));
    return { count: rows.length, hash: sliceHash(columns, rows), rows };
}

function bump(table, field, mismatch = null) {
    try {
        db.run(`INSERT INTO chat_dual_read_stats (tbl, compared, ${field}) VALUES (?, 1, 1)
            ON CONFLICT(tbl) DO UPDATE SET compared = compared + 1, ${field} = ${field} + 1`, [table]);
        if (mismatch) db.run('UPDATE chat_dual_read_stats SET last_mismatch_at = CURRENT_TIMESTAMP, last_mismatch = ? WHERE tbl = ?', [JSON.stringify(mismatch).slice(0, 2000), table]);
    } catch { /* counting must never break a read */ }
}

function dualReadStats(table) {
    try {
        const r = db.get('SELECT compared, matched, mismatched, inconclusive, errors, last_mismatch_at, last_mismatch, since FROM chat_dual_read_stats WHERE tbl = ?', [table]);
        if (!r) return { compared: 0, matched: 0, mismatched: 0, inconclusive: 0, errors: 0, last_mismatch_at: null, last_mismatch: null, since: null };
        let last = null; try { last = r.last_mismatch ? JSON.parse(r.last_mismatch) : null; } catch { last = r.last_mismatch; }
        return { ...r, last_mismatch: last };
    } catch { return null; }
}
function resetDualReadStats(table) { try { db.run('DELETE FROM chat_dual_read_stats WHERE tbl = ?', [table]); } catch { /* */ } }

const lastSlice = new Map();   // `${table}|${where}` → when last compared
let budget = { minute: 0, used: 0 };

/** Compare one slice with Chat's copy (in the background). → 'matched' | 'mismatched' | 'inconclusive' | 'error' */
async function compare(table, where) {
    const columns = liveColumns(table);
    if (pending(table) > 0) { bump(table, 'inconclusive'); return 'inconclusive'; }
    const before = localSlice(table, where, columns);
    let theirs;
    try {
        theirs = await chatTables.callChat('stagedSlice', [table, where, columns], { timeoutMs: 5000 });
    } catch (err) {
        bump(table, 'errors');
        return 'error';
    }
    const cols = Array.isArray(theirs.columns) ? theirs.columns : columns;
    const mine = localSlice(table, where, cols);
    // Live's rows changed meanwhile, or a change is on its way: no verdict.
    if (mine.count !== before.count || localSlice(table, where, columns).hash !== before.hash || pending(table) > 0) { bump(table, 'inconclusive'); return 'inconclusive'; }
    if (mine.count === theirs.count && mine.hash === theirs.hash) { bump(table, 'matched'); return 'matched'; }
    const key = (r) => JSON.stringify(chatTables.TABLES[table].map((k) => r[k]));
    const sample = { where, live: { count: mine.count, hash: mine.hash.slice(0, 16) }, chat: { count: theirs.count, hash: String(theirs.hash).slice(0, 16) } };
    if (Array.isArray(theirs.rows) && mine.rows.length <= 50) {
        const a = new Map(mine.rows.map((r) => [key(r), JSON.stringify(cols.map((c) => r[c] ?? null))]));
        const b = new Map(theirs.rows.map((r) => [key(r), JSON.stringify(cols.map((c) => r[c] ?? null))]));
        sample.only_live = [...a.keys()].filter((k) => !b.has(k)).slice(0, 5);
        sample.only_chat = [...b.keys()].filter((k) => !a.has(k)).slice(0, 5);
        sample.differ = [...a.keys()].filter((k) => b.has(k) && a.get(k) !== b.get(k)).slice(0, 5);
    }
    bump(table, 'mismatched', sample);
    console.warn(`[ChatTables] dual read: ${table} ${JSON.stringify(where)} differs — Live ${mine.count} row(s), Chat ${theirs.count}`);
    return 'mismatched';
}

/** A read of `table` touched these slices: compare them later, within the rate limits. */
function observe(table, slices) {
    if (chatTables.authority(table) !== 'live' || !chatTables.dualRead(table)) return;
    const now = Date.now();
    const minute = Math.floor(now / 60_000);
    if (budget.minute !== minute) budget = { minute, used: 0 };
    for (const where of slices) {
        const k = `${table}|${JSON.stringify(where)}`;
        if (now - (lastSlice.get(k) || 0) < SLICE_EVERY_MS || budget.used >= COMPARES_PER_MIN) continue;
        lastSlice.set(k, now);
        if (lastSlice.size > 5000) lastSlice.delete(lastSlice.keys().next().value);
        budget.used++;
        setImmediate(() => { compare(table, where).catch(() => {}); });
    }
}

const originals = {};
function installDualRead() {
    for (const [fn, table, slices] of READERS) {
        if (typeof db[fn] !== 'function' || originals[fn]) continue;
        const orig = originals[fn] = db[fn];
        db[fn] = function dualReadObserved(...args) {
            const out = orig.apply(this, args);
            try { observe(table, slices(args)); } catch { /* never breaks the read */ }
            return out;
        };
    }
    try {
        const tags = require('./tags');
        if (!originals.getUserTags) {
            const orig = originals.getUserTags = tags.getUserTags;
            tags.getUserTags = function dualReadObserved(userId) {
                const out = orig(userId);
                try { observe('user_tags', [{ user_id: num(userId) }]); } catch { /* */ }
                return out;
            };
        }
    } catch { /* no tags module */ }
}

// ── Start ───────────────────────────────────────────────────────

function start() {
    if (started) return;
    started = true;
    ensureTables();
    installCapture();
    installDualRead();
    require('../utils/jobs').every('chat-staged-relay', RELAY_MS, () => flush(), { initialDelayMs: RELAY_MS });
    const queued = pending();
    console.log(`[ChatTables] staged tables: ${Object.keys(chatTables.TABLES).map((t) => `${t}=${chatTables.authority(t)}${chatTables.dualRead(t) ? '+dual-read' : ''}`).join(', ')}${queued ? ` (${queued} change(s) queued for Chat)` : ''}`);
}

module.exports = {
    start, ensureTables, installCapture, setCapture, pending, flush, drain, buildChanges, relayStats, paused, setPaused,
    compare, observe, dualReadStats, resetDualReadStats, sliceHash, READERS,
    _restore() { for (const [fn, orig] of Object.entries(originals)) { if (fn === 'getUserTags') require('./tags').getUserTags = orig; else db[fn] = orig; delete originals[fn]; } started = false; },
};
