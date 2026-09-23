'use strict';
/**
 * Comments on VODs and clips are OpenVibe.Community threads (roadmap Wave 5: "Live and a second
 * product share one Community thread"). Live keeps no comments of its own any more — the old
 * `comments` table is read-only, kept for the import (OpenVibe.Community
 * scripts/import-live-comments.js) — and /api/comments (media-proxy/comments.js) is an adapter over
 * the thread of EntityRef { service: 'live', type: 'vod'|'clip', id }.
 *
 * Calls go to Community's /api/v1/comments with Live's service token (audience openvibe.community):
 *   community.comment.write     resolve a thread; read, comment, edit and delete as the person
 *                               (X-OV-Subject: their usr_ id)
 *   community.comment.moderate  delete as staff (X-OV-Staff: 1) or as Live itself for the
 *                               VOD's/clip's owner; hide the thread of deleted content
 *
 * Only Live opens these threads (Community refuses browsers for live/vod and live/clip): a private
 * item is Live's call, so Live checks visibility first and hands the thread's unguessable access id
 * only to people who may see the item. Thread ids are remembered in comment_thread_refs.
 *
 * Calls made for a visitor forward their address (X-Forwarded-For, as the paste proxy does), so
 * Community's per-address API limit counts people, not Live's loopback address.
 *
 * Any failure to reach Community (or an answer ≥ 500) is a 503 CommentsError: callers must
 * say "comments are unavailable", never show an empty list that looks real.
 */
const db = require('./db/database');
const principal = require('./net/network-principal');
const { subjectForLiveUser } = require('./pastes-client');

const COMMUNITY_URL = () => (process.env.OV_COMMUNITY_INTERNAL_URL || 'http://127.0.0.1:4200').replace(/\/+$/, '');
const COMMUNITY_PUBLIC_URL = () => (process.env.OV_COMMUNITY_URL || 'https://openvibe.community').replace(/\/+$/, '');
const AUDIENCE = 'openvibe.community';
const TYPES = ['vod', 'clip'];

class CommentsError extends Error {
    constructor(status, message, code) {
        super(message);
        this.name = 'CommentsError';
        this.status = status;
        this.code = code || null;
    }
}
const unavailable = (why) => new CommentsError(503, 'Comments are unavailable right now', `comments_unavailable${why ? `:${why}` : ''}`);

let _tables = false;
function ensureTables() {
    if (_tables) return;
    db.getDb().exec(`CREATE TABLE IF NOT EXISTS comment_thread_refs (
        content_type TEXT NOT NULL,
        content_id INTEGER NOT NULL,
        thread_id INTEGER NOT NULL,
        access_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (content_type, content_id)
    )`);
    _tables = true;
}

/**
 * One call to Community's comment API. act: { subject } acts for a person, { staff: true } adds
 * X-OV-Staff (the person is Live staff), {} is Live itself. ip: the visitor's address.
 */
async function call(method, path, { body, act = {}, ip = null, timeoutMs = 5000, retried = false } = {}) {
    let headers;
    try { headers = { Accept: 'application/json', ...(await principal.serviceHeaders(AUDIENCE)) }; }
    catch (err) { console.warn(`[Comments] no service token for Community: ${err.message}`); throw unavailable('token'); }
    if (act.subject) headers['X-OV-Subject'] = act.subject;
    if (act.staff) headers['X-OV-Staff'] = '1';
    if (ip) headers['X-Forwarded-For'] = String(ip);
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
        res = await fetch(`${COMMUNITY_URL()}/api/v1/comments${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
        console.warn(`[Comments] Community unreachable (${method} ${path}): ${err.message}`);
        throw unavailable('unreachable');
    }
    const out = await res.json().catch(() => null);
    if (res.status === 401 && !retried && !(out && out.code === 'auth.required')) {   // our token was refused: fetch a fresh one once
        principal.invalidate(AUDIENCE);
        return call(method, path, { body, act, ip, timeoutMs, retried: true });
    }
    if (res.status >= 500 || (res.status === 401 && retried)) {
        console.warn(`[Comments] Community answered ${res.status} (${method} ${path})${out && out.code ? ` ${out.code}` : ''}`);
        throw unavailable(String(res.status));
    }
    if (res.status === 403 && out && out.code === 'capability.denied') {
        console.warn(`[Comments] Community refused Live's token for ${method} ${path}: ${out.detail || out.error}`);
        throw unavailable('capability');
    }
    if (!res.ok) throw new CommentsError(res.status, (out && (out.detail || out.error)) || `Community answered ${res.status}`, out && out.code);
    return out;
}

/** The Community thread of a VOD/clip (resolved once, then remembered). → { id, access_id } */
async function threadFor(type, id, label, { timeoutMs, ip } = {}) {
    if (!TYPES.includes(type)) throw new CommentsError(400, 'Invalid content type');
    ensureTables();
    const known = db.getDb().prepare('SELECT thread_id, access_id FROM comment_thread_refs WHERE content_type = ? AND content_id = ?').get(type, Number(id));
    if (known) return { id: known.thread_id, access_id: known.access_id };
    const ref = { service: 'live', type, id: String(id) };
    if (label) ref.label = String(label).slice(0, 200);
    const out = await call('POST', '/threads/resolve', { body: { ref }, timeoutMs, ip });
    const t = out && out.thread;
    if (!t || !Number.isInteger(t.id) || !t.access_id) throw unavailable('resolve');
    db.getDb().prepare('INSERT OR IGNORE INTO comment_thread_refs (content_type, content_id, thread_id, access_id) VALUES (?, ?, ?, ?)').run(type, Number(id), t.id, t.access_id);
    return { id: t.id, access_id: t.access_id };
}

/** Read a thread page (as the viewer, if signed in). q: { sort, after, limit, parent } */
function readThread(threadId, { subject = null, timeoutMs, ip, ...q } = {}) {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)])).toString();
    return call('GET', `/threads/${encodeURIComponent(threadId)}${qs ? `?${qs}` : ''}`, { act: { subject }, timeoutMs, ip });
}

function addComment(threadId, subject, { message, parentId = null }, { ip } = {}) {
    return call('POST', `/threads/${encodeURIComponent(threadId)}/comments`, { act: { subject }, ip, body: { message, ...(parentId ? { parent_id: parentId } : {}) } });
}

/** One comment and its thread (with the ref). null when Community has no such (visible) comment. */
async function getComment(commentId, subject = null, { ip } = {}) {
    if (!/^\d{1,15}$/.test(String(commentId))) return null;
    try { return await call('GET', `/${commentId}`, { act: { subject }, ip }); }
    catch (err) { if (err.status === 404) return null; throw err; }
}

function editComment(commentId, subject, message, { ip } = {}) {
    return call('PATCH', `/${encodeURIComponent(commentId)}`, { act: { subject }, ip, body: { message } });
}

/** as: 'author' (the person), 'staff' (the person, vouched as staff), 'owner' (Live itself, moderating for the content's owner). */
function deleteComment(commentId, { subject = null, as = 'author', ip = null } = {}) {
    const act = as === 'owner' ? {} : { subject, staff: as === 'staff' };
    return call('DELETE', `/${encodeURIComponent(commentId)}`, { act, ip });
}

// Hiding threads of deleted content runs one at a time in the background, paced under Community's
// per-address API limit (bulk deletes queue hundreds, all from Live's own address).
const HIDE_GAP_MS = process.env.NODE_ENV === 'test' ? 0 : 1100;
let _hideQueue = Promise.resolve();
/** Best effort: hide the thread of a VOD/clip that was deleted. Never throws. */
function hideThreadOf(type, id) {
    if (!TYPES.includes(type) || !(Number(id) > 0)) return _hideQueue;
    _hideQueue = _hideQueue.then(async () => {
        try {
            const t = await threadFor(type, id);
            await call('PUT', `/threads/${t.id}/visibility`, { body: { visibility: 'hidden' } });
        } catch (err) {
            console.warn(`[Comments] could not hide the comment thread of ${type} ${id}: ${err.message}`);
        }
        if (HIDE_GAP_MS) await new Promise((r) => setTimeout(r, HIDE_GAP_MS).unref());
    });
    return _hideQueue;
}

/** Live user id for a Network subject, when that person has a Live account linked. */
function liveUserForSubject(subject) {
    if (!subject) return null;
    try {
        const row = db.getDb().prepare("SELECT user_id FROM linked_accounts WHERE service = 'network' AND subject_id = ? ORDER BY id LIMIT 1").get(subject);
        return row ? row.user_id : null;
    } catch { return null; }
}

const threadUrl = (accessId) => `${COMMUNITY_PUBLIC_URL()}/c/${encodeURIComponent(accessId)}`;

module.exports = {
    CommentsError, TYPES, threadFor, readThread, addComment, getComment, editComment, deleteComment,
    hideThreadOf, liveUserForSubject, subjectForLiveUser, threadUrl, ensureTables,
};
