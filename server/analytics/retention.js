'use strict';
/**
 * Raw analytics retention and the one-time scrub (ADR-021).
 *
 *   pruneRawEvents(db, { days })   delete analytics_events rows older than `days` (≤ 30) in bounded
 *                                  batches, yielding to the event loop between batches. Rollups
 *                                  (analytics_hourly / analytics_daily) are never touched. Also clears
 *                                  leftovers: visitor hashes older than yesterday, salts of past days,
 *                                  and analytics_rate_tracking (IP counters live in memory now).
 *   scrubEvents(db)                rewrite the rows written before ADR-021: ip / user_id / city →
 *                                  NULL (authenticated = 1 where a user id was present), path → route
 *                                  template, referer → origin, user_agent → class, session ids that are
 *                                  not rotating ids → NULL.
 *   scrubRollups(db)               the same path/referer reduction inside the rollups' top_paths /
 *                                  top_referers JSON (counts merged, never changed).
 *   inspect(db, { days })          read-only counts for a dry run.
 *   rollupTotals(db)               sums of every rollup counter, to prove a run left them alone.
 *
 * Used by the server (scheduled prune) and scripts/analytics-prune.js (CLI).
 * Same file in OpenVibe.Live (server/analytics/) and OpenVibe.Tools (apps/_shared/analytics/).
 */

const { ensureSchema } = require('./schema');
const privacy = require('./privacy');

const MAX_DAYS = 30;
const DEFAULT_BATCH = 5000;
const ROTATING_SESSION_RE = /^[0-9a-f]{16}$/;

const pad = (n) => String(n).padStart(2, '0');
function sqlTime(ms) {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function checkDays(days) {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) {
        throw new Error(`days must be an integer from 1 to ${MAX_DAYS} (ADR-021 keeps raw analytics at most ${MAX_DAYS} days)`);
    }
    return n;
}

/** The created_at bound: rows strictly older than this are pruned. */
function cutoffFor(days, nowMs = Date.now()) {
    return sqlTime(nowMs - checkDays(days) * 86400000);
}

const tableExists = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const columnExists = (db, table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
const tick = () => new Promise((r) => setImmediate(r));

/**
 * Delete raw events older than `days` in batches of `batchSize` (each batch its own short write
 * transaction). Returns { cutoff, deleted, batches, complete }.
 */
async function pruneRawEvents(db, { days = MAX_DAYS, batchSize = DEFAULT_BATCH, maxBatches = Infinity, now = Date.now } = {}) {
    const cutoff = cutoffFor(days, now());
    const out = { cutoff, deleted: 0, batches: 0, complete: true };
    if (!tableExists(db, 'analytics_events')) return out;
    const del = db.prepare('DELETE FROM analytics_events WHERE id IN (SELECT id FROM analytics_events WHERE created_at < ? LIMIT ?)');
    for (;;) {
        if (out.batches >= maxBatches) { out.complete = false; break; }
        const n = del.run(cutoff, batchSize).changes;
        out.batches++;
        out.deleted += n;
        if (n < batchSize) break;
        await tick();
    }
    const today = sqlTime(now()).slice(0, 10);
    const yesterday = sqlTime(now() - 86400000).slice(0, 10);
    if (tableExists(db, 'analytics_visitor_days')) db.prepare('DELETE FROM analytics_visitor_days WHERE day < ?').run(yesterday);
    if (tableExists(db, 'analytics_day_salts')) db.prepare('DELETE FROM analytics_day_salts WHERE day < ?').run(today);
    if (tableExists(db, 'analytics_rate_tracking')) db.prepare('DELETE FROM analytics_rate_tracking').run();
    return out;
}

/** SQL functions for the scrub and the dry-run counts (connection-scoped, safe on a read-only handle). */
function registerFunctions(db, opts) {
    db.function('ov_route_template', { deterministic: true }, (p) => (p == null ? null : privacy.normalisePath(p, opts)));
    db.function('ov_referer_origin', { deterministic: true }, (r) => (r == null || r === '' ? r : privacy.refererOrigin(r)));
    db.function('ov_ua_class', { deterministic: true }, (u) => privacy.uaClass(u));
    db.function('ov_rotating_session', { deterministic: true }, (s) => (s != null && ROTATING_SESSION_RE.test(String(s)) ? s : null));
}

/** Rewrite every raw row to the ADR-021 fields, in id-range batches. Returns { rows, batches }. */
async function scrubEvents(db, { batchSize = DEFAULT_BATCH, paramPrefixes } = {}) {
    ensureSchema(db);
    registerFunctions(db, paramPrefixes ? { paramPrefixes } : undefined);
    const { lo, hi } = db.prepare('SELECT MIN(id) AS lo, MAX(id) AS hi FROM analytics_events').get();
    const out = { rows: 0, batches: 0 };
    if (lo == null) return out;
    const upd = db.prepare(`
        UPDATE analytics_events SET
            authenticated = CASE WHEN user_id IS NOT NULL THEN 1 ELSE authenticated END,
            ip = NULL, user_id = NULL, city = NULL,
            session_id = ov_rotating_session(session_id),
            path = ov_route_template(path),
            referer = ov_referer_origin(referer),
            user_agent = ov_ua_class(user_agent)
        WHERE id >= ? AND id < ?
    `);
    for (let from = lo; from <= hi; from += batchSize) {
        out.rows += upd.run(from, from + batchSize).changes;
        out.batches++;
        await tick();
    }
    return out;
}

/** Re-template a rollup's top list ([{ path|referer, cnt }]) — counts are summed, never altered. */
function reduceTopList(json, key, fn) {
    let list;
    try { list = JSON.parse(json); } catch { return null; }
    if (!Array.isArray(list)) return null;
    const merged = new Map();
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const k = fn(item[key]);
        if (k == null) continue;
        merged.set(k, (merged.get(k) || 0) + (Number(item.cnt) || 0));
    }
    const next = [...merged].map(([k, cnt]) => ({ [key]: k, cnt })).sort((a, b) => b.cnt - a.cnt);
    const text = JSON.stringify(next);
    return text === json ? null : text;
}

/** Scrub top_paths / top_referers in both rollup tables. Returns { hourly, daily } rows changed. */
function scrubRollups(db, { paramPrefixes } = {}) {
    const opts = paramPrefixes ? { paramPrefixes } : undefined;
    const tpl = (p) => (p == null ? null : privacy.normalisePath(p, opts));
    const out = { hourly: 0, daily: 0 };
    for (const table of ['analytics_hourly', 'analytics_daily']) {
        if (!tableExists(db, table)) continue;
        const rows = db.prepare(`SELECT id, top_paths, top_referers FROM ${table}`).all();
        const upd = db.prepare(`UPDATE ${table} SET top_paths = ?, top_referers = ? WHERE id = ?`);
        db.transaction(() => {
            for (const r of rows) {
                const paths = r.top_paths ? reduceTopList(r.top_paths, 'path', tpl) : null;
                const refs = r.top_referers ? reduceTopList(r.top_referers, 'referer', privacy.refererOrigin) : null;
                if (paths == null && refs == null) continue;
                upd.run(paths != null ? paths : r.top_paths, refs != null ? refs : r.top_referers, r.id);
                out[table === 'analytics_hourly' ? 'hourly' : 'daily']++;
            }
        })();
    }
    return out;
}

/** Sums of every rollup counter; equal before and after a prune or scrub. */
function rollupTotals(db) {
    const out = {};
    if (tableExists(db, 'analytics_hourly')) {
        out.hourly = db.prepare(`SELECT COUNT(*) AS rows, TOTAL(pageviews) AS pageviews, TOTAL(api_calls) AS api_calls,
            TOTAL(unique_visitors) AS unique_visitors, TOTAL(unique_users) AS unique_users, TOTAL(bot_hits) AS bot_hits,
            TOTAL(error_count) AS error_count FROM analytics_hourly`).get();
    }
    if (tableExists(db, 'analytics_daily')) {
        out.daily = db.prepare(`SELECT COUNT(*) AS rows, TOTAL(pageviews) AS pageviews, TOTAL(api_calls) AS api_calls,
            TOTAL(unique_visitors) AS unique_visitors, TOTAL(unique_users) AS unique_users, TOTAL(new_users) AS new_users,
            TOTAL(bot_hits) AS bot_hits, TOTAL(error_count) AS error_count FROM analytics_daily`).get();
    }
    return out;
}

/** Read-only counts for a dry run. */
function inspect(db, { days = MAX_DAYS, now = Date.now, paramPrefixes } = {}) {
    const cutoff = cutoffFor(days, now());
    const out = { cutoff, events: 0, older: 0, remaining: 0, oldest: null, newest: null };
    const pageSize = db.pragma('page_size', { simple: true });
    out.bytes = db.pragma('page_count', { simple: true }) * pageSize;
    out.freeBytes = db.pragma('freelist_count', { simple: true }) * pageSize;
    out.rollups = rollupTotals(db);
    if (!tableExists(db, 'analytics_events')) return out;
    registerFunctions(db, paramPrefixes ? { paramPrefixes } : undefined);
    const e = db.prepare('SELECT COUNT(*) AS n, MIN(created_at) AS oldest, MAX(created_at) AS newest FROM analytics_events').get();
    out.events = e.n;
    out.oldest = e.oldest;
    out.newest = e.newest;
    out.older = db.prepare('SELECT COUNT(*) FROM analytics_events WHERE created_at < ?').pluck().get(cutoff);
    out.remaining = out.events - out.older;
    const personal = ['ip', 'user_id', 'city'].filter((c) => columnExists(db, 'analytics_events', c))
        .map((c) => `${c} IS NOT NULL`).join(' OR ') || '0';
    const r = db.prepare(`
        SELECT
            COUNT(*) FILTER (WHERE ${personal}) AS personal,
            COUNT(*) FILTER (WHERE path IS NOT ov_route_template(path)) AS paths,
            COUNT(*) FILTER (WHERE referer IS NOT ov_referer_origin(referer)) AS referers,
            COUNT(*) FILTER (WHERE user_agent IS NOT ov_ua_class(user_agent)) AS user_agents,
            COUNT(*) FILTER (WHERE session_id IS NOT ov_rotating_session(session_id)) AS sessions
        FROM analytics_events WHERE created_at >= ?
    `).get(cutoff);
    out.toScrub = r;
    out.rateRows = tableExists(db, 'analytics_rate_tracking') ? db.prepare('SELECT COUNT(*) FROM analytics_rate_tracking').pluck().get() : 0;
    return out;
}

module.exports = {
    MAX_DAYS,
    DEFAULT_BATCH,
    checkDays,
    cutoffFor,
    pruneRawEvents,
    scrubEvents,
    scrubRollups,
    rollupTotals,
    inspect,
    reduceTopList,
};
