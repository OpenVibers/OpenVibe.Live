/**
 * history-store.js — the one place that answers "what happened in this chat room?".
 *
 * Rooms:  'global' | 'channel:<userId>'        (the stream route keeps its own scope logic)
 * Reads:
 *   page(room, { limit, before })      newest `limit` rows, oldest→newest — the first paint
 *   delta(room, { afterId, limit })    rows with id > afterId, oldest→newest — reopen, reconnect,
 *                                      tab focus. Cheap: a primary-key range scan, no reverse.
 * Every answer carries `latest_id`, the cursor the client stores; `complete:false` on a delta
 * means the gap was bigger than `limit` and the client should take a fresh page instead.
 *
 * Backing store today is SQLite through `db`. `memo` collapses identical page reads inside a
 * short window (a burst of reconnects after a deploy used to run the five-table global join
 * once per socket). Swapping in a ring buffer or Redis later means replacing `readPage` /
 * `readDelta` and calling `invalidate(room)` from the write path — nothing in the routes changes.
 */
const db = require('../db/database');

const PAGE_MEMO_MS = 2000;
const MAX_LIMIT = 500;

const GLOBAL_SELECT = `SELECT cm.*, u.avatar_url, u.profile_color, u.role, u.display_name,
              u.username AS core_username,
              COALESCE(su.username, cu.username) AS stream_channel,
              s.is_live AS source_is_live,
              s.managed_stream_id AS source_managed_id,
              COALESCE(ms.title, s.title) AS source_stream_title,
              ms.slug AS source_slug
       FROM chat_messages cm
       LEFT JOIN users u ON cm.user_id = u.id
       LEFT JOIN streams s ON cm.stream_id = s.id
       LEFT JOIN users su ON s.user_id = su.id
       LEFT JOIN users cu ON cm.channel_user_id = cu.id
       LEFT JOIN managed_streams ms ON s.managed_stream_id = ms.id
       WHERE cm.is_deleted = 0 AND cm.message_type IN ('chat', 'system', 'channel-sound', 'soundboard', 'donation')
         AND (cm.auto_delete_at IS NULL OR datetime(cm.auto_delete_at) > CURRENT_TIMESTAMP)`;

const CHANNEL_SELECT = `SELECT cm.*, u.avatar_url, u.profile_color, u.role, u.display_name,
              u.username AS core_username,
              s.title AS source_stream_title, s.managed_stream_id AS source_managed_id,
              s.is_live AS source_is_live, ms.slug AS source_slug,
              COALESCE(bu.username, cu.username) AS source_channel
       FROM chat_messages cm
       LEFT JOIN users u ON cm.user_id = u.id
       LEFT JOIN streams s ON cm.stream_id = s.id
       LEFT JOIN managed_streams ms ON s.managed_stream_id = ms.id
       LEFT JOIN users bu ON s.user_id = bu.id
       LEFT JOIN users cu ON cm.channel_user_id = cu.id
       WHERE cm.channel_user_id = ? AND cm.is_deleted = 0
         AND (cm.auto_delete_at IS NULL OR datetime(cm.auto_delete_at) > CURRENT_TIMESTAMP)`;

function clampLimit(v, dflt = 500) {
    const n = parseInt(v, 10);
    return Math.min(Number.isFinite(n) && n > 0 ? n : dflt, MAX_LIMIT);
}

function parseRoom(room) {
    if (room === 'global') return { kind: 'global' };
    const m = /^channel:(\d+)$/.exec(String(room || ''));
    if (m) return { kind: 'channel', userId: parseInt(m[1], 10) };
    throw new Error(`history-store: unknown room "${room}"`);
}

function baseSql(r, { channelUsername } = {}) {
    if (r.kind === 'global') {
        const params = [];
        let sql = GLOBAL_SELECT;
        if (channelUsername) { sql += ` AND LOWER(COALESCE(su.username, cu.username)) = LOWER(?)`; params.push(channelUsername); }
        return { sql, params };
    }
    return { sql: CHANNEL_SELECT, params: [r.userId] };
}

function tipId() {
    try { const r = db.get('SELECT MAX(id) AS id FROM chat_messages'); return (r && r.id) || 0; } catch { return Date.now(); }
}
const latestIdOf = (rows) => rows.reduce((m, x) => (x && x.id > m ? x.id : m), 0);

// ── reads ──────────────────────────────────────────────────────────────────────────────────────
const memo = new Map(); // key → { at, value }
function memoGet(key) {
    const hit = memo.get(key);
    if (hit && Date.now() - hit.at < PAGE_MEMO_MS) return hit.value;
    if (hit) memo.delete(key);
    return null;
}
function memoSet(key, value) {
    memo.set(key, { at: Date.now(), value });
    if (memo.size > 64) { const oldest = memo.keys().next().value; memo.delete(oldest); }
}

function readPage(r, { limit, before, channelUsername }) {
    const { sql, params } = baseSql(r, { channelUsername });
    let q = sql;
    if (before) { q += ' AND cm.timestamp < ?'; params.push(before); }
    q += ' ORDER BY cm.timestamp DESC, cm.id DESC LIMIT ?'; params.push(limit);
    return db.all(q, params).reverse();
}

function readDelta(r, { afterId, limit, channelUsername }) {
    const { sql, params } = baseSql(r, { channelUsername });
    // One more than asked: if it comes back, the gap is bigger than the client can splice in.
    const q = `${sql} AND cm.id > ? ORDER BY cm.id ASC LIMIT ?`;
    params.push(afterId, limit + 1);
    return db.all(q, params);
}

/**
 * Newest rows of a room, oldest→newest.
 * @returns {{ messages: object[], latest_id: number }}
 */
function page(room, { limit, before, channelUsername, decorate } = {}) {
    const r = parseRoom(room);
    const lim = clampLimit(limit);
    // The newest row id is part of the memo key, so a memoised page can never miss a message:
    // one primary-key lookup instead of the five-table join for every repeat reader in the window.
    const key = !before ? `${room}|${lim}|${channelUsername || ''}|${tipId()}` : null;
    let rows = key ? memoGet(key) : null;
    if (!rows) {
        rows = readPage(r, { limit: lim, before, channelUsername });
        if (key) memoSet(key, rows);
    }
    const messages = decorate ? decorate(rows.map((x) => ({ ...x }))) : rows;
    return { messages, latest_id: latestIdOf(rows) };
}

/**
 * Everything after a cursor, oldest→newest. `complete:false` = more than `limit` rows were
 * missing; take a fresh page instead of splicing.
 * @returns {{ messages: object[], latest_id: number, complete: boolean }}
 */
function delta(room, { afterId, limit, channelUsername, decorate } = {}) {
    const r = parseRoom(room);
    const lim = clampLimit(limit, 200);
    const after = Math.max(0, parseInt(afterId, 10) || 0);
    let rows = readDelta(r, { afterId: after, limit: lim, channelUsername });
    const complete = rows.length <= lim;
    if (!complete) rows = rows.slice(0, lim);
    const messages = decorate ? decorate(rows.map((x) => ({ ...x }))) : rows;
    return { messages, latest_id: latestIdOf(rows) || after, complete };
}

/** Drop memoised pages for a room (or all rooms). Call from write paths when a tier is added. */
function invalidate(room) {
    if (!room) { memo.clear(); return; }
    for (const k of memo.keys()) if (k.startsWith(`${room}|`)) memo.delete(k);
}

module.exports = { page, delta, invalidate, clampLimit, PAGE_MEMO_MS };
