'use strict';
/**
 * Deleting The Rundown (design 2026-11-06).
 *
 * Deleted is deleted: the rows are removed, not hidden. Topics recount, a topic left with nothing is removed, the
 * sharing row goes with the episode, and the desk does not write that stream up again unless the streamer asks
 * ("Write this stream up again"). The recording stays: deleting a write-up never touches the VOD.
 *
 * Staff hiding (status 'hidden') is a moderation tool and stays as it is.
 */
const db = require('../db/database');

/** The receipt: "Deleted 1 episode and 12 takes". */
function receipt(episodes, takes) {
    const e = Number(episodes) || 0, t = Number(takes) || 0;
    const parts = [];
    if (e) parts.push(`${e} episode${e === 1 ? '' : 's'}`);
    if (t) parts.push(`${t} take${t === 1 ? '' : 's'}`);
    return { episodes: e, takes: t, message: parts.length ? `Deleted ${parts.join(' and ')}` : 'Nothing to delete' };
}

/** The topics these takes were filed under, recounted; a topic left with nothing is removed. */
async function recountTopics(topicIds) {
    const ids = [...new Set((topicIds || []).map(Number).filter(Boolean))];
    for (const id of ids) {
        await db.run(`UPDATE rundown_topics SET
            takes = (SELECT COUNT(*) FROM rundown_segments WHERE topic_id = ? AND status = 'live'),
            streamers = (SELECT COUNT(DISTINCT user_id) FROM rundown_segments WHERE topic_id = ? AND status = 'live'),
            last_seen_at = COALESCE((SELECT MAX(said_at) FROM rundown_segments WHERE topic_id = ? AND status = 'live'), last_seen_at)
            WHERE id = ?`, [id, id, id, id]);
        // The page of a topic was written from takes that are gone: it is cleared, so the desk writes it again from
        // what is left (two takes or more) or leaves it empty.
        await db.run('UPDATE rundown_topics SET headline = NULL, summary = NULL, summary_takes = 0, summary_at = NULL WHERE id = ?', [id]);
        const left = await db.get('SELECT COUNT(*) AS n FROM rundown_segments WHERE topic_id = ? AND status = \'live\'', [id]);
        if (!Number(left && left.n)) await db.run('DELETE FROM rundown_topics WHERE id = ?', [id]);
    }
}

/** The sharing row of an episode goes with it: there is nothing left to share. */
async function forgetShare(streamId) {
    const id = String(streamId);
    await db.run("DELETE FROM share_members WHERE service = 'live' AND kind = 'rundown-episode' AND resource_id = ?", [id]);
    await db.run("DELETE FROM shares WHERE service = 'live' AND kind = 'rundown-episode' AND resource_id = ?", [id]);
}

/** The desk must not write that stream up again on its own. */
async function markDeleted(streamId, userId) {
    await db.run(`INSERT INTO rundown_deleted (stream_id, user_id, deleted_at) VALUES (?, ?, ov_now())
        ON CONFLICT (stream_id) DO UPDATE SET user_id = excluded.user_id, deleted_at = excluded.deleted_at`, [Number(streamId), Number(userId)]);
    await db.run('UPDATE rundown_progress SET done = 1, updated_at = ov_now() WHERE stream_id = ?', [Number(streamId)]);
}

/** One take: the segment, its reactions, and its topic's summary (rewritten from what is left at the next desk pass). */
async function deleteTake(segmentId, user) {
    const seg = await db.get('SELECT id, stream_id, user_id, topic_id FROM rundown_segments WHERE id = ?', [Number(segmentId)]);
    if (!seg) throw Object.assign(new Error('No such take'), { status: 404 });
    if (Number(seg.user_id) !== Number(user.id)) throw Object.assign(new Error('Not your take'), { status: 403 });
    await db.run("DELETE FROM rundown_reactions WHERE item_type = 'segment' AND item_id = ?", [seg.id]);
    await db.run('DELETE FROM rundown_segments WHERE id = ?', [seg.id]);
    await recountTopics(seg.topic_id ? [seg.topic_id] : []);
    // The episode the take was part of stays, with one take less.
    return receipt(0, 1);
}

/** One episode: the episode, all its segments, its reactions, and the topics they were filed under. The VOD stays. */
async function deleteEpisode(streamId, user) {
    const id = Number(streamId);
    const ep = await db.get('SELECT stream_id, user_id FROM rundown_episodes WHERE stream_id = ?', [id]);
    const owner = ep ? ep.user_id : (await db.get('SELECT user_id FROM streams WHERE id = ?', [id]) || {}).user_id;
    if (!owner) throw Object.assign(new Error('No such episode'), { status: 404 });
    if (Number(owner) !== Number(user.id)) throw Object.assign(new Error('Not your episode'), { status: 403 });
    const segs = await db.all('SELECT id, topic_id FROM rundown_segments WHERE stream_id = ?', [id]);
    const segIds = segs.map((s) => Number(s.id));
    if (segIds.length) await db.run("DELETE FROM rundown_reactions WHERE item_type = 'segment' AND item_id = ANY(?)", [segIds]);
    await db.run("DELETE FROM rundown_reactions WHERE item_type = 'episode' AND item_id = ?", [id]);
    if (segIds.length) await db.run('DELETE FROM rundown_segments WHERE id = ANY(?)', [segIds]);
    await db.run('DELETE FROM rundown_episodes WHERE stream_id = ?', [id]);
    await db.run('DELETE FROM rundown_pictures WHERE stream_id = ?', [id]);
    await recountTopics(segs.map((s) => s.topic_id).filter(Boolean));
    await forgetShare(id);
    await markDeleted(id, user.id);
    return receipt(1, segIds.length);
}

/** All my Rundown: every episode and take of the streamer's. Their VODs stay. */
async function deleteAll(user, { keepOut = false } = {}) {
    const eps = await db.all('SELECT stream_id FROM rundown_episodes WHERE user_id = ?', [user.id]);
    const segs = await db.all('SELECT id, topic_id, stream_id FROM rundown_segments WHERE user_id = ?', [user.id]);
    const segIds = segs.map((s) => Number(s.id));
    if (segIds.length) await db.run("DELETE FROM rundown_reactions WHERE item_type = 'segment' AND item_id = ANY(?)", [segIds]);
    const epIds = eps.map((e) => Number(e.stream_id));
    if (epIds.length) await db.run("DELETE FROM rundown_reactions WHERE item_type = 'episode' AND item_id = ANY(?)", [epIds]);
    if (segIds.length) await db.run('DELETE FROM rundown_segments WHERE id = ANY(?)', [segIds]);
    if (epIds.length) await db.run('DELETE FROM rundown_episodes WHERE stream_id = ANY(?)', [epIds]);
    if (epIds.length) await db.run('DELETE FROM rundown_pictures WHERE stream_id = ANY(?)', [epIds]);
    await recountTopics(segs.map((s) => s.topic_id).filter(Boolean));
    for (const id of epIds) { await forgetShare(id); await markDeleted(id, user.id); }
    // A take without an episode (a stream still live) is a write-up too: the desk must not make it again.
    for (const s of segs) if (!epIds.includes(Number(s.stream_id))) await markDeleted(s.stream_id, user.id);
    if (keepOut) {
        await db.run('INSERT INTO arena_opt_outs (user_id) VALUES (?) ON CONFLICT DO NOTHING', [user.id]);
    }
    return receipt(epIds.length, segIds.length);
}

/** "Write this stream up again": the desk may read that stream once more. */
async function restore(streamId, user) {
    const id = Number(streamId);
    const row = await db.get('SELECT user_id FROM rundown_deleted WHERE stream_id = ?', [id]);
    if (!row) throw Object.assign(new Error('Nothing to write up again'), { status: 404 });
    if (Number(row.user_id) !== Number(user.id)) throw Object.assign(new Error('Not your stream'), { status: 403 });
    await db.run('DELETE FROM rundown_deleted WHERE stream_id = ?', [id]);
    await db.run('DELETE FROM rundown_progress WHERE stream_id = ?', [id]);
    return { restored: true, stream_id: id };
}

module.exports = { receipt, recountTopics, deleteTake, deleteEpisode, deleteAll, restore, markDeleted, forgetShare };
