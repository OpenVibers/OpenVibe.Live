'use strict';
/**
 * Unresolved references, for operators (roadmap D20 remaining 2: "an operator view of unresolved
 * references"). Every unresolved answer of the canonical resolver — to another service through
 * /internal/lineage/resolve (./routes.js) or to Live's own clip-owner check (media-proxy/clips.js) — is
 * counted here by its inputs and reason: a conflict, a source that could not be read, a record whose
 * owner is gone, a display name offered alone. `no_input` is not a reference and is not kept.
 *
 *   lineage_unresolved  (ref, reason) → detail, last caller, count, first and last seen
 *   ref                 the inputs, canonical and sorted: "clip_id=123 slug=alice" (ids and slugs only;
 *                       a display name is recorded as display_name=… because that is what was offered)
 *
 * Rows not seen for 30 days are dropped (checked at most once an hour, on a write). Staff read them at
 * GET /api/admin/lineage/unresolved (admin/routes.js); a failure to record never changes an answer.
 */
const db = require('../db/database');

const KEEP_DAYS = 30;
const PRUNE_EVERY_MS = 3600 * 1000;
let ensured = false;
let lastPrune = 0;

function ensureTable() {
    if (ensured) return;
    const d = db.getDb();
    d.exec(`CREATE TABLE IF NOT EXISTS lineage_unresolved (
        ref         TEXT NOT NULL,
        reason      TEXT NOT NULL,
        detail      TEXT,
        last_caller TEXT,
        count       INTEGER NOT NULL DEFAULT 1,
        first_at    TEXT NOT NULL,
        last_at     TEXT NOT NULL,
        PRIMARY KEY (ref, reason)
    )`);
    d.exec('CREATE INDEX IF NOT EXISTS idx_lineage_unresolved_last ON lineage_unresolved(last_at DESC)');
    ensured = true;
}

/** A normalized request (resolver.normalizeRequest) → "k=v k=v", sorted; legacy_ids flattened. */
function refOf(input) {
    const parts = [];
    for (const [k, v] of Object.entries(input || {})) {
        if (v == null) continue;
        if (k === 'legacy_ids' && typeof v === 'object') { for (const [lk, lv] of Object.entries(v)) if (lv != null) parts.push(`${lk}=${lv}`); continue; }
        parts.push(`${k}=${String(v).replace(/\s+/g, ' ').slice(0, 80)}`);
    }
    return parts.sort().join(' ').slice(0, 500);
}

/** Count one unresolved answer. result: { status, reason, detail }; caller: 'svc:media', 'live:clip-owner'… */
function record(input, result, caller, { now = Date.now() } = {}) {
    try {
        if (!result || result.status === 'resolved' || !result.reason || result.reason === 'no_input') return false;
        const ref = refOf(input);
        if (!ref) return false;
        ensureTable();
        const at = new Date(now).toISOString();
        db.run(`INSERT INTO lineage_unresolved (ref, reason, detail, last_caller, count, first_at, last_at) VALUES (?, ?, ?, ?, 1, ?, ?)
                ON CONFLICT (ref, reason) DO UPDATE SET detail = excluded.detail, last_caller = excluded.last_caller, count = count + 1, last_at = excluded.last_at`,
        [ref, String(result.reason).slice(0, 60), result.detail ? String(result.detail).slice(0, 500) : null, caller ? String(caller).slice(0, 60) : null, at, at]);
        if (now - lastPrune > PRUNE_EVERY_MS) {
            lastPrune = now;
            db.run('DELETE FROM lineage_unresolved WHERE last_at < ?', [new Date(now - KEEP_DAYS * 86400000).toISOString()]);
        }
        return true;
    } catch (err) {
        console.warn('[Lineage] could not record an unresolved reference:', err.message);
        return false;
    }
}

/** For staff: the newest first, optionally one reason; plus counts per reason. */
function list({ reason = null, limit = 100 } = {}) {
    ensureTable();
    const n = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const rows = reason
        ? db.all('SELECT * FROM lineage_unresolved WHERE reason = ? ORDER BY last_at DESC LIMIT ?', [reason, n])
        : db.all('SELECT * FROM lineage_unresolved ORDER BY last_at DESC LIMIT ?', [n]);
    const byReason = {};
    for (const r of db.all('SELECT reason, COUNT(*) AS refs, SUM(count) AS answers FROM lineage_unresolved GROUP BY reason')) byReason[r.reason] = { refs: r.refs, answers: r.answers };
    return { unresolved: rows, by_reason: byReason, keep_days: KEEP_DAYS };
}

module.exports = { record, list, refOf, KEEP_DAYS };
