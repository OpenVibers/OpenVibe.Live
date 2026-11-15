'use strict';
/**
 * Flagged speech (plan §AD.11 item 3): a transcribed window whose words read as one of OpenVibe.AI's hard-floor lines.
 * AI delivers the window flagged (output.floor { rule }) instead of dropping it; media-analysis.js records it here and
 * staff review the queue (migration 0043, transcript_flags). Never the words: the recording and the second, so staff
 * open it there and judge what they hear.
 *
 *   GET  /api/mod/transcript-flags?status=open|cleared|handled|all&limit=   the queue, newest first (global mod+)
 *   POST /api/mod/transcript-flags/:id { status: 'cleared'|'handled'|'open' }   staff looked (global mod+)
 *
 * openvibe.network/admin reads both through its /api/admin/streamer-mod proxy.
 */
const db = require('../db/database');

const KINDS = new Set(['vod', 'clip', 'media']);
const STATUSES = new Set(['open', 'cleared', 'handled']);

/** Where a flagged window lies → { source, kind, item_id, user_id, path }: the Media item when the caller named it. */
function placeOf(src, ref) {
    let path = null;
    try { path = new URL(String(src)).pathname.slice(0, 500); } catch { path = null; }
    const kind = ref && KINDS.has(ref.kind) && ref.kind !== 'media' && ref.id != null && String(ref.id).length <= 64 ? ref.kind : 'media';
    const itemId = kind === 'media' ? null : String(ref.id);
    const userId = ref && Number.isSafeInteger(Number(ref.userId)) && Number(ref.userId) > 0 ? Number(ref.userId) : null;
    const source = itemId ? `${kind}:${itemId}` : (path || '(a local file)');
    return { source, kind, item_id: itemId, user_id: userId, path };
}

/** Keep one flagged window (a retried window is the same row). Never throws: the transcript goes on either way. */
async function record({ rule, src, startSec, ref = null }) {
    const name = String(rule || '').replace(/[^a-z_]/g, '').slice(0, 32) || 'unknown';
    const at = Math.max(0, Math.round(Number(startSec) || 0));
    const p = placeOf(src, ref);
    try {
        await db.run(`INSERT INTO transcript_flags (source, kind, item_id, user_id, path, start_sec, rule)
            VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (source, start_sec, rule) DO NOTHING`,
        [p.source, p.kind, p.item_id, p.user_id, p.path, at, name]);
        return true;
    } catch (e) {
        console.warn(`[transcript-flags] could not keep a flagged window of ${p.source}: ${e.message}`);
        return false;
    }
}

const linkOf = (r) => {
    const t = Number(r.start_sec) > 0 ? `?t=${Number(r.start_sec)}` : '';
    if (r.kind === 'vod' && r.item_id) return `/vod/${encodeURIComponent(r.item_id)}${t}`;
    if (r.kind === 'clip' && r.item_id) return `/clip/${encodeURIComponent(r.item_id)}${t}`;
    return null;
};

const view = (r) => ({
    id: Number(r.id), kind: r.kind, item_id: r.item_id || null, start_sec: Number(r.start_sec) || 0, rule: r.rule,
    status: r.status, created_at: r.created_at, reviewed_at: r.reviewed_at || null,
    channel: r.username ? { id: Number(r.user_id), username: r.username } : (r.user_id ? { id: Number(r.user_id), username: null } : null),
    reviewed_by: r.reviewer || null,
    url: linkOf(r), path: r.item_id ? null : (r.path || null),
});

/** The queue → { flags, open }: newest first; open counts every open flag, whatever the filter. */
async function list({ status = 'open', limit = 50 } = {}) {
    const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const filter = STATUSES.has(status) ? status : null;
    const rows = await db.all(`SELECT f.*, u.username, r.username AS reviewer
        FROM transcript_flags f LEFT JOIN users u ON u.id = f.user_id LEFT JOIN users r ON r.id = f.reviewed_by
        ${filter ? 'WHERE f.status = ?' : ''} ORDER BY f.created_at DESC, f.id DESC LIMIT ?`, filter ? [filter, n] : [n]);
    const open = await db.get("SELECT COUNT(*) AS n FROM transcript_flags WHERE status = 'open'");
    return { flags: rows.map(view), open: Number(open && open.n) || 0 };
}

/** Staff looked → the flag, or null when there is none. 'open' puts it back in the queue. */
async function review(id, status, reviewerId) {
    if (!STATUSES.has(status)) { const e = new Error('status must be cleared, handled or open'); e.status = 422; throw e; }
    const n = Number(id);
    if (!Number.isSafeInteger(n) || n <= 0) return null;
    const out = status === 'open'
        ? await db.run("UPDATE transcript_flags SET status = 'open', reviewed_by = NULL, reviewed_at = NULL WHERE id = ?", [n])
        : await db.run('UPDATE transcript_flags SET status = ?, reviewed_by = ?, reviewed_at = ov_now() WHERE id = ?', [status, reviewerId || null, n]);
    if (!out || !out.changes) return null;
    const r = await db.get(`SELECT f.*, u.username, r.username AS reviewer FROM transcript_flags f
        LEFT JOIN users u ON u.id = f.user_id LEFT JOIN users r ON r.id = f.reviewed_by WHERE f.id = ?`, [n]);
    return r ? view(r) : null;
}

module.exports = { record, list, review, placeOf };
