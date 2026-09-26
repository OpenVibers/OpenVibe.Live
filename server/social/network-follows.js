'use strict';
/**
 * Follows on OpenVibe.Network (ADR-030; roadmap WS-E task 4). Network owns the follow graph, keyed by subjects;
 * Live's `follows` table is its projection, kept for Live's own reads (channel pages, counts, sort orders).
 *
 *   writeThrough(followerId, streamerId, following)   step 4: with FOLLOWS_AUTHORITY=network, a follow button
 *       records the change on Network first (PUT/DELETE /internal/follows/channel/<streamer subject>, Live's
 *       service token, network.follows.write). The route writes Live's row only when Network took it; if
 *       Network cannot answer, the button fails (503) rather than letting the two drift. A side with no
 *       Network subject yet (an account Network never told us about) stays Live-only, as before.
 *   apply(event)   network.follow.created / .deleted from OpenVibe.Events (server/auth/network-events.js):
 *       follows made anywhere else (my.openvibe.network, another product, the API) reach Live's table.
 *       Idempotent and ordered: the highest revision applied per pair is kept (follow_projection_revisions),
 *       and an older one is `stale`. A pair whose side has no Live account is `ignored:unmapped`.
 *
 * Unset FOLLOWS_AUTHORITY: the buttons write Live's table only (the state before step 4); events still apply.
 */
const db = require('../db/database');

const NETWORK_INTERNAL_URL = (process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const stats = { written: 0, local_only: 0, failed: 0, applied: 0, stale: 0, ignored: 0 };

const authority = () => (process.env.FOLLOWS_AUTHORITY === 'network' ? 'network' : 'live');

function subjectOf(liveUserId) {
    const r = db.getDb().prepare("SELECT subject_id FROM linked_accounts WHERE service = 'network' AND user_id = ?").get(liveUserId);
    return r && SUBJECT_RE.test(String(r.subject_id || '')) ? r.subject_id : null;
}
function userOf(subject) {
    const r = db.getDb().prepare("SELECT user_id FROM linked_accounts WHERE service = 'network' AND subject_id = ? ORDER BY id LIMIT 1").get(subject);
    return r ? r.user_id : null;
}

/**
 * Record a follow change on Network before Live writes its row. → { ok: true, network: true } when Network took it,
 * { ok: true, network: false, reason } when it stays Live-only (authority live, or a side without a subject),
 * { ok: false, error } when Network could not take it (the caller answers 503 and changes nothing).
 */
async function writeThrough(followerId, streamerId, following, { fetchImpl = globalThis.fetch } = {}) {
    if (authority() !== 'network') return { ok: true, network: false, reason: 'authority_live' };
    const follower = subjectOf(followerId);
    const target = subjectOf(streamerId);
    if (!follower || !target) { stats.local_only++; return { ok: true, network: false, reason: 'no_subject' }; }
    try {
        const principal = require('../net/network-principal');
        const headers = { Accept: 'application/json', ...(await principal.serviceHeaders('openvibe.network')) };
        const url = `${NETWORK_INTERNAL_URL}/internal/follows/channel/${target}`;
        const res = following
            ? await fetchImpl(url, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ follower }), signal: AbortSignal.timeout(5000) })
            : await fetchImpl(`${url}?follower=${follower}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(5000) });
        if (res.status === 401) principal.invalidate('openvibe.network');
        if (res.status < 200 || res.status >= 300) { stats.failed++; return { ok: false, error: `Network answered ${res.status}` }; }
        stats.written++;
        return { ok: true, network: true };
    } catch (err) {
        stats.failed++;
        return { ok: false, error: err.message };
    }
}

function ensureTable() {
    db.getDb().exec(`CREATE TABLE IF NOT EXISTS follow_projection_revisions (
        follower_subject TEXT NOT NULL,
        target_subject   TEXT NOT NULL,
        revision         INTEGER NOT NULL,
        PRIMARY KEY (follower_subject, target_subject)
    )`);
}

/** Apply network.follow.created / .deleted. → 'followed' | 'unfollowed' | 'stale' | 'ignored:<why>' */
function apply(ev) {
    const p = ev && ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
    if (p.target_type !== 'channel' || !SUBJECT_RE.test(String(p.follower || '')) || !SUBJECT_RE.test(String(p.target_id || '')) || !Number.isInteger(p.revision)) { stats.ignored++; return 'ignored:payload'; }
    ensureTable();
    const d = db.getDb();
    return d.transaction(() => {
        const prev = d.prepare('SELECT revision FROM follow_projection_revisions WHERE follower_subject = ? AND target_subject = ?').get(p.follower, p.target_id);
        if (prev && prev.revision >= p.revision) { stats.stale++; return 'stale'; }
        const followerId = userOf(p.follower);
        const streamerId = userOf(p.target_id);
        if (followerId == null || streamerId == null) { stats.ignored++; return 'ignored:unmapped'; }
        d.prepare('INSERT INTO follow_projection_revisions (follower_subject, target_subject, revision) VALUES (?, ?, ?) ON CONFLICT (follower_subject, target_subject) DO UPDATE SET revision = excluded.revision')
            .run(p.follower, p.target_id, p.revision);
        stats.applied++;
        if (ev.event_type === 'network.follow.created') {
            d.prepare('INSERT OR IGNORE INTO follows (follower_id, streamer_id) VALUES (?, ?)').run(followerId, streamerId);
            return 'followed';
        }
        d.prepare('DELETE FROM follows WHERE follower_id = ? AND streamer_id = ?').run(followerId, streamerId);
        return 'unfollowed';
    })();
}

module.exports = { writeThrough, apply, authority, stats };
