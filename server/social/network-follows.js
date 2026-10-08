'use strict';
/**
 * Follows on OpenVibe.Network (ADR-030; plan T2). Network owns the follow graph, keyed by subjects. Live's
 * `follows` table is only its projection, written by Network's events alone (in revision order) and kept for
 * Live's own bulk reads (go-live notices, Chat's context route, activity numbers); nothing on Live follows or
 * unfollows on its own, and what a person sees (a follow button, a follower count) comes from Network.
 *
 *   set(followerId, streamerId, following)   a follow button: PUT / DELETE /internal/follows/channel/<streamer
 *       subject> on Network (Live's service token, network.follows.write). Network's answer
 *       (network.follow-status-result@1: following, the follower count) is what the button shows, and Live
 *       remembers it (ANSWER_TTL_MS) so a reload or a second click sees it before the event arrives. The answer
 *       carries no revision, so it never touches the projection: an older event delivered late cannot undo it.
 *       `started` is Network's own word that this request started the follow: 201 (the pair's first follow),
 *       or a `since` no older than the request (a follow that starts again starts its since again); an
 *       idempotent repeat of a follow Network already had is not started, whatever the projection says.
 *       Both sides need a Network subject: a side without one cannot follow (409). Network unreachable,
 *       refusing Live's token, or answering a malformed document: 503. A request Network refuses for what it
 *       is (following oneself, the follow limit, an unknown channel) keeps Network's status and reason.
 *   isFollowing(followerId, streamerId)   the button state: Network's recent answer for the pair, else the
 *       projection.
 *   followerCount(streamerId)   GET /api/v1/follows/channel/<subject> on Network (the public count), cached
 *       COUNT_TTL_MS and refreshed by every write answer; the projection's count only while Network cannot
 *       answer (or the channel has no subject).
 *   apply(event)   network.follow.created / .deleted from OpenVibe.Events (server/auth/network-events.js):
 *       follows made anywhere (the buttons here, my.openvibe.network, another product, the API) reach Live's
 *       table. Idempotent and ordered: the highest revision applied per pair is kept
 *       (follow_projection_revisions), and an older one is `stale`. A pair whose side has no Live account is
 *       `ignored:unmapped`. An applied event that agrees with Network's remembered answer retires the answer.
 *
 * Network tells the followed person (FOLLOW) itself; Live sends no follow notification.
 */
const db = require('../db/database');

const NETWORK_INTERNAL_URL = (process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const ANSWER_TTL_MS = 10 * 60 * 1000;
const COUNT_TTL_MS = 30 * 1000;      // Network's own public max-age for the count
const COUNT_DOWN_MS = 10 * 1000;     // after a failed count read, the projection answers for this long
const stats = { written: 0, no_subject: 0, refused: 0, failed: 0, applied: 0, stale: 0, ignored: 0, count_read: 0, count_fallback: 0 };
const answers = new Map();           // `${followerId}>${streamerId}` → { following, at }
const counts = new Map();            // streamer subject → { n, at } | { down: until }

async function subjectOf(liveUserId) {
    const r = await db.getDb().prepare("SELECT subject_id FROM linked_accounts WHERE service = 'network' AND user_id = ?").get(liveUserId);
    return r && SUBJECT_RE.test(String(r.subject_id || '')) ? r.subject_id : null;
}
async function userOf(subject) {
    const r = await db.getDb().prepare("SELECT user_id FROM linked_accounts WHERE service = 'network' AND subject_id = ? ORDER BY id LIMIT 1").get(subject);
    return r ? r.user_id : null;
}

async function project(followerId, streamerId, following) {
    if (following) await db.getDb().prepare('INSERT INTO follows (follower_id, streamer_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(followerId, streamerId);
    else await db.getDb().prepare('DELETE FROM follows WHERE follower_id = ? AND streamer_id = ?').run(followerId, streamerId);
}

/** A network.follow-status-result@1 for `target` with a valid count (and `following`, when `viewer`). */
function validStatus(body, target, viewer) {
    return !!body && typeof body === 'object' && body.target_id === target && Number.isInteger(body.followers) && body.followers >= 0
        && (!viewer || typeof body.following === 'boolean');
}

/**
 * Follow (following = true) or unfollow on Network.
 * → { ok: true, following, count, started }, or { ok: false, status, error } (the caller answers that status).
 */
async function set(followerId, streamerId, following, { fetchImpl = globalThis.fetch } = {}) {
    const follower = await subjectOf(followerId);
    const target = await subjectOf(streamerId);
    if (!follower || !target) {
        stats.no_subject++;
        return { ok: false, status: 409, error: follower ? 'This channel cannot be followed yet' : 'Sign out and back in to follow channels' };
    }
    let res, body;
    const sentAt = Date.now();
    try {
        const principal = require('../net/network-principal');
        const headers = { Accept: 'application/json', ...(await principal.serviceHeaders('openvibe.network')) };
        const url = `${NETWORK_INTERNAL_URL}/internal/follows/channel/${target}`;
        res = following
            ? await fetchImpl(url, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ follower }), signal: AbortSignal.timeout(5000) })
            : await fetchImpl(`${url}?follower=${follower}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(5000) });
        if (res.status === 401) principal.invalidate('openvibe.network');
        body = await res.json().catch(() => null);
    } catch (err) {
        stats.failed++;
        return { ok: false, status: 503, error: 'Could not update the follow right now; try again in a moment', detail: err.message };
    }
    if ([400, 404, 409].includes(res.status)) {
        stats.refused++;
        return { ok: false, status: res.status, error: (body && typeof body.detail === 'string' && body.detail) || 'Could not update the follow' };
    }
    if (res.status < 200 || res.status >= 300 || !validStatus(body, target, true)) {
        stats.failed++;
        return { ok: false, status: 503, error: 'Could not update the follow right now; try again in a moment', detail: `Network answered ${res.status} without a valid follow status` };
    }
    stats.written++;
    const now = Date.now();
    if (answers.size > 5000) for (const [k, a] of answers) if (now - a.at >= ANSWER_TTL_MS) answers.delete(k);
    answers.set(`${followerId}>${streamerId}`, { following: body.following, at: now });
    counts.set(target, { n: body.followers, at: now });
    const since = typeof body.since === 'string' ? Date.parse(body.since) : NaN;
    return {
        ok: true,
        following: body.following,
        count: body.followers,
        started: body.following && (res.status === 201 || since >= sentAt),
    };
}

/** Whether followerId follows streamerId, as the button shows it (sync). */
async function isFollowing(followerId, streamerId) {
    if (followerId == null) return false;
    const key = `${followerId}>${streamerId}`;
    const a = answers.get(key);
    if (a && Date.now() - a.at < ANSWER_TTL_MS) return a.following;
    if (a) answers.delete(key);
    return await db.isFollowing(followerId, streamerId);
}

/** streamerId's follower count, from Network (cached), or the projection's while Network cannot answer. */
async function followerCount(streamerId, { fetchImpl = globalThis.fetch } = {}) {
    const target = await subjectOf(streamerId);
    const local = async () => { stats.count_fallback++; return await db.getFollowerCount(streamerId); };
    if (!target) return await local();
    const now = Date.now();
    const c = counts.get(target);
    if (c && c.down > now) return await local();
    if (c && c.n != null && now - c.at < COUNT_TTL_MS) return c.n;
    try {
        const res = await fetchImpl(`${NETWORK_INTERNAL_URL}/api/v1/follows/channel/${target}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(1500) });
        const body = res.status === 200 ? await res.json().catch(() => null) : null;
        if (!validStatus(body, target, false)) throw new Error(`Network answered ${res.status} without a valid follow status`);
        stats.count_read++;
        counts.set(target, { n: body.followers, at: Date.now() });
        return body.followers;
    } catch (err) {
        console.warn('[Follows] follower count from the projection:', err.message);
        counts.set(target, { down: Date.now() + COUNT_DOWN_MS });
        return await local();
    }
}

/** Apply network.follow.created / .deleted. → 'followed' | 'unfollowed' | 'stale' | 'ignored:<why>' */
async function apply(ev) {
    const p = ev && ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
    if (p.target_type !== 'channel' || !SUBJECT_RE.test(String(p.follower || '')) || !SUBJECT_RE.test(String(p.target_id || '')) || !Number.isInteger(p.revision)) { stats.ignored++; return 'ignored:payload'; }
    const d = db.getDb();
    return await d.tx(async () => {
        const prev = await d.prepare('SELECT revision FROM follow_projection_revisions WHERE follower_subject = ? AND target_subject = ?').get(p.follower, p.target_id);
        if (prev && prev.revision >= p.revision) { stats.stale++; return 'stale'; }
        const followerId = await userOf(p.follower);
        const streamerId = await userOf(p.target_id);
        if (followerId == null || streamerId == null) { stats.ignored++; return 'ignored:unmapped'; }
        await d.prepare('INSERT INTO follow_projection_revisions (follower_subject, target_subject, revision) VALUES (?, ?, ?) ON CONFLICT (follower_subject, target_subject) DO UPDATE SET revision = excluded.revision')
            .run(p.follower, p.target_id, p.revision);
        stats.applied++;
        const following = ev.event_type === 'network.follow.created';
        await project(followerId, streamerId, following);
        const key = `${followerId}>${streamerId}`;
        if (answers.has(key) && answers.get(key).following === following) answers.delete(key);
        counts.delete(p.target_id);
        return following ? 'followed' : 'unfollowed';
    });
}

module.exports = { set, apply, isFollowing, followerCount, stats, _reset: () => { answers.clear(); counts.clear(); } };
