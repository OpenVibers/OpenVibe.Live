'use strict';
/**
 * What The Rundown's pages read (server/rundown/routes.js, docs/rundown.md). Rows come out through allow-listed shapes:
 * a person is { id, username, display_name, avatar_url, profile_color }, never a users row.
 *
 *   home({ viewer })                on air now, the lead take, stream by stream, trending topics, who's been talking
 *   streamsFeed({ before, viewer }) stream by stream: each recent stream with its episode and its best takes, newest first
 *   topics({ sort, kind })          every topic
 *   topic(slug)                     one topic and every take on it
 *   episode(streamId)               one stream written up, with its segments and the streamer's other episodes
 *   streamer(username)              their episodes, topics, lines and crossovers
 *   react(type, id, voter, r)       one reaction per reader per item (a reader is their account, else a salted address hash)
 */
const db = require('../db/database');

const REACTIONS = ['fire', 'lol', 'dead', 'cap', 'facts'];
const FEED_MIN_SCORE = 4;       // the front page: a take scored 4 or 5, a crossover or an episode
const STREAM_TAKES = 3;         // stream by stream: a stream's best takes on the front page (the episode page has them all)
const STREAMS_PAGE = 8;
const parseJson = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 19).replace('T', ' ');

function person(u) {
    return u ? { id: Number(u.id), username: u.username, display_name: u.display_name || u.username, avatar_url: u.avatar_url || null, profile_color: u.profile_color || null } : null;
}
async function people(ids) {
    const list = [...new Set(ids.map(Number).filter(Boolean))];
    if (!list.length) return new Map();
    const rows = await db.all('SELECT id, username, display_name, avatar_url, profile_color FROM users WHERE id = ANY(?)', [list]);
    return new Map(rows.map((r) => [Number(r.id), person(r)]));
}
async function topicsById(ids) {
    const list = [...new Set(ids.map(Number).filter(Boolean))];
    if (!list.length) return new Map();
    const rows = await db.all("SELECT id, slug, title, kind FROM rundown_topics WHERE id = ANY(?) AND status = 'live'", [list]);
    return new Map(rows.map((r) => [Number(r.id), { slug: r.slug, title: r.title, kind: r.kind }]));
}
async function reactionsFor(type, ids, voter) {
    const list = [...new Set(ids.map(Number).filter(Boolean))];
    const counts = new Map(), mine = new Map();
    if (!list.length) return { counts, mine };
    for (const r of await db.all('SELECT item_id, reaction, COUNT(*) AS n FROM rundown_reactions WHERE item_type = ? AND item_id = ANY(?) GROUP BY item_id, reaction', [type, list])) {
        const c = counts.get(Number(r.item_id)) || {};
        c[r.reaction] = Number(r.n);
        counts.set(Number(r.item_id), c);
    }
    if (voter) for (const r of await db.all('SELECT item_id, reaction FROM rundown_reactions WHERE item_type = ? AND item_id = ANY(?) AND voter = ?', [type, list, voter])) mine.set(Number(r.item_id), r.reaction);
    return { counts, mine };
}

/** Segments as the pages show them, with their people, topics and reactions resolved in three queries. */
async function segmentsOut(rows, voter) {
    const ppl = await people(rows.flatMap((r) => [r.user_id, ...(r.mentions || [])]));
    const tps = await topicsById(rows.map((r) => r.topic_id));
    const rx = await reactionsFor('segment', rows.map((r) => r.id), voter);
    // Segment and quote times are stream time; `sec` links into vod_id, which for a stream recorded in parts (its
    // broadcaster reconnected) starts later than the stream (streaming/stream-history.js).
    const history = require('../streaming/stream-history');
    const offsets = await history.vodOffsets(rows.map((r) => r.vod_id));
    const inVod = (r, sec) => Math.max(0, Math.floor(history.vodTime(sec, r.vod_id ? offsets.get(Number(r.vod_id)) : 0)));
    return rows.map((r) => ({
        type: 'segment', id: Number(r.id), title: r.title, what: r.what, take: r.take || null, quip: r.quip || null, score: Number(r.score),
        quotes: parseJson(r.quotes_json, []).map((q) => ({ text: q.text, en: q.en || null, sec: inVod(r, q.sec) })),
        topic: tps.get(Number(r.topic_id)) || null, user: ppl.get(Number(r.user_id)) || null,
        mentions: (r.mentions || []).map((id) => ppl.get(Number(id))).filter(Boolean),
        stream_id: Number(r.stream_id), vod_id: r.vod_id ? Number(r.vod_id) : null, sec: inVod(r, r.start_sec),
        said_at: r.said_at, reactions: rx.counts.get(Number(r.id)) || {}, my_reaction: rx.mine.get(Number(r.id)) || null,
    }));
}
async function episodesOut(rows, voter) {
    const ppl = await people(rows.map((r) => r.user_id));
    const rx = await reactionsFor('episode', rows.map((r) => r.stream_id), voter);
    const ids = rows.map((r) => Number(r.stream_id));
    const topicRows = ids.length ? await db.all(`SELECT DISTINCT ON (s.stream_id, t.id) s.stream_id, t.slug, t.title FROM rundown_segments s JOIN rundown_topics t ON t.id = s.topic_id
        WHERE s.stream_id = ANY(?) AND s.status = 'live' AND t.status = 'live' ORDER BY s.stream_id, t.id`, [ids]) : [];
    const byStream = new Map();
    for (const t of topicRows) { const l = byStream.get(Number(t.stream_id)) || []; if (l.length < 6) l.push({ slug: t.slug, title: t.title }); byStream.set(Number(t.stream_id), l); }
    return rows.map((r) => ({
        type: 'episode', stream_id: Number(r.stream_id), title: r.title, logline: r.logline || null, recap: r.recap || null,
        chapters: parseJson(r.chapters_json, []).map((c) => ({ sec: Math.max(0, Math.floor(Number(c.sec) || 0)), title: c.title, segment_id: c.segment_id ? Number(c.segment_id) : null })),
        user: ppl.get(Number(r.user_id)) || null, vod_id: r.vod_id ? Number(r.vod_id) : null, minutes: r.minutes == null ? null : Number(r.minutes),
        aired_at: r.aired_at, topics: byStream.get(Number(r.stream_id)) || [],
        reactions: rx.counts.get(Number(r.stream_id)) || {}, my_reaction: rx.mine.get(Number(r.stream_id)) || null,
    }));
}

const SEGMENT_COLS = 'id, stream_id, user_id, topic_id, start_sec, title, what, take, quip, score, quotes_json, mentions, vod_id, said_at';
const EPISODE_COLS = 'stream_id, user_id, title, logline, recap, chapters_json, vod_id, minutes, aired_at';

async function onAir() {
    const rows = await db.all(`SELECT s.id AS stream_id, s.user_id, s.title AS stream_title,
            (SELECT g.title FROM rundown_segments g WHERE g.stream_id = s.id AND g.status = 'live' ORDER BY g.start_sec DESC LIMIT 1) AS talking_about,
            (SELECT t.slug FROM rundown_segments g JOIN rundown_topics t ON t.id = g.topic_id WHERE g.stream_id = s.id AND g.status = 'live' ORDER BY g.start_sec DESC LIMIT 1) AS topic_slug,
            (SELECT t.title FROM rundown_segments g JOIN rundown_topics t ON t.id = g.topic_id WHERE g.stream_id = s.id AND g.status = 'live' ORDER BY g.start_sec DESC LIMIT 1) AS topic_title
        FROM streams s WHERE s.is_live = 1 AND s.user_id NOT IN (SELECT user_id FROM arena_opt_outs) ORDER BY s.viewer_count DESC NULLS LAST LIMIT 12`);
    const ppl = await people(rows.map((r) => r.user_id));
    return rows.map((r) => ({ stream_id: Number(r.stream_id), user: ppl.get(Number(r.user_id)) || null, stream_title: r.stream_title || null, talking_about: r.talking_about || null, topic: r.topic_slug ? { slug: r.topic_slug, title: r.topic_title } : null })).filter((r) => r.user);
}

async function trending(limit = 12, days = 7) {
    const rows = await db.all(`SELECT t.id, t.slug, t.title, t.kind, t.headline, t.summary, t.last_seen_at,
            COUNT(s.id) AS week_takes, COUNT(DISTINCT s.user_id) AS week_streamers, array_agg(DISTINCT s.user_id) AS users
        FROM rundown_topics t JOIN rundown_segments s ON s.topic_id = t.id AND s.status = 'live' AND s.said_at >= ?
        WHERE t.status = 'live' GROUP BY t.id ORDER BY COUNT(DISTINCT s.user_id) DESC, COUNT(s.id) DESC, MAX(s.said_at) DESC LIMIT ?`, [daysAgo(days), limit]);
    const ppl = await people(rows.flatMap((r) => (r.users || []).slice(0, 4)));
    return rows.map((r) => ({ slug: r.slug, title: r.title, kind: r.kind, headline: r.headline || null, summary: r.summary || null, last_seen_at: r.last_seen_at,
        takes: Number(r.week_takes), streamers: Number(r.week_streamers), people: (r.users || []).slice(0, 4).map((id) => ppl.get(Number(id))).filter(Boolean) }));
}

async function voices(days = 7) {
    const rows = await db.all(`SELECT s.user_id, COUNT(*) AS segments, COUNT(DISTINCT s.topic_id) AS topics, MAX(s.said_at) AS last_seen
        FROM rundown_segments s WHERE s.status = 'live' AND s.said_at >= ? GROUP BY s.user_id ORDER BY MAX(s.said_at) DESC LIMIT 16`, [daysAgo(days)]);
    const ppl = await people(rows.map((r) => r.user_id));
    const tops = rows.length ? await db.all(`SELECT s.user_id, t.slug, t.title, COUNT(*) AS n FROM rundown_segments s JOIN rundown_topics t ON t.id = s.topic_id
        WHERE s.status = 'live' AND t.status = 'live' AND s.said_at >= ? AND s.user_id = ANY(?) GROUP BY s.user_id, t.slug, t.title ORDER BY COUNT(*) DESC`, [daysAgo(days), rows.map((r) => Number(r.user_id))]) : [];
    const byUser = new Map();
    for (const t of tops) { const l = byUser.get(Number(t.user_id)) || []; if (l.length < 3) l.push({ slug: t.slug, title: t.title }); byUser.set(Number(t.user_id), l); }
    return rows.map((r) => ({ user: ppl.get(Number(r.user_id)) || null, segments: Number(r.segments), topics: Number(r.topics), last_seen: r.last_seen, top_topics: byUser.get(Number(r.user_id)) || [] })).filter((v) => v.user);
}

/** The lead: the best take of the last day (else the week), a quoted one first. */
async function lead({ viewer = null } = {}) {
    for (const days of [1, 7]) {
        const rows = await db.all(`SELECT ${SEGMENT_COLS} FROM rundown_segments WHERE status = 'live' AND said_at >= ? AND score >= ?
            ORDER BY score DESC, (quotes_json <> '[]') DESC, said_at DESC LIMIT 1`, [daysAgo(days), FEED_MIN_SCORE]);
        if (rows.length) return (await segmentsOut(rows, viewer))[0];
    }
    return null;
}

/**
 * Stream by stream: the streams the desk wrote about, newest first, each with its episode (when it has ended and been
 * written up) and its best STREAM_TAKES takes in the order they were said. `skip` leaves out the lead take. Paged by the
 * time of a stream's latest take.
 */
async function streamsFeed({ before = null, limit = STREAMS_PAGE, viewer = null, skip = null } = {}) {
    const cut = before ? String(before).slice(0, 19) : '9999-12-31 00:00:00';
    const groups = await db.all(`SELECT stream_id, MAX(said_at) AS last_at, COUNT(*) AS takes FROM rundown_segments WHERE status = 'live'
        GROUP BY stream_id HAVING MAX(said_at) < ? ORDER BY MAX(said_at) DESC LIMIT ?`, [cut, limit]);
    const ids = groups.map((g) => Number(g.stream_id));
    if (!ids.length) return { streams: [], next: null };
    const segs = await db.all(`SELECT ${SEGMENT_COLS} FROM rundown_segments WHERE status = 'live' AND stream_id = ANY(?)
        ORDER BY score DESC, cardinality(mentions) DESC, (quotes_json <> '[]') DESC, start_sec ASC`, [ids]);
    const best = new Map();
    for (const s of segs) {
        const l = best.get(Number(s.stream_id)) || [];
        if (l.length < STREAM_TAKES && Number(s.id) !== Number(skip)) l.push(s);
        best.set(Number(s.stream_id), l);
    }
    const chosen = [...best.values()].flat().sort((a, b) => Number(a.start_sec) - Number(b.start_sec));
    const takes = new Map();
    for (const t of await segmentsOut(chosen, viewer)) { const l = takes.get(t.stream_id) || []; l.push(t); takes.set(t.stream_id, l); }
    const eps = new Map((await episodesOut(await db.all(`SELECT ${EPISODE_COLS} FROM rundown_episodes WHERE status = 'live' AND stream_id = ANY(?)`, [ids]), viewer))
        .map((e) => [e.stream_id, { title: e.title, logline: e.logline, minutes: e.minutes, aired_at: e.aired_at, topics: e.topics, reactions: e.reactions, my_reaction: e.my_reaction }]));
    const streams = new Map((await db.all('SELECT id, user_id, title, is_live, started_at, ended_at, duration_seconds FROM streams WHERE id = ANY(?)', [ids])).map((s) => [Number(s.id), s]));
    const ppl = await people([...streams.values()].map((s) => s.user_id));
    const out = groups.map((g) => {
        const s = streams.get(Number(g.stream_id));
        if (!s) return null;
        return { stream_id: Number(g.stream_id), user: ppl.get(Number(s.user_id)) || null, title: s.title || null, live: !!Number(s.is_live), started_at: s.started_at,
            minutes: s.duration_seconds ? Math.round(Number(s.duration_seconds) / 60) : null, last_at: g.last_at, takes_total: Number(g.takes),
            episode: eps.get(Number(g.stream_id)) || null, takes: takes.get(Number(g.stream_id)) || [] };
    }).filter((x) => x && x.user && x.takes.length);
    return { streams: out, next: groups.length >= limit ? groups[groups.length - 1].last_at : null };
}

async function home({ viewer = null } = {}) {
    const top = await lead({ viewer });
    const [air, feed, topics, talk] = await Promise.all([onAir(), streamsFeed({ viewer, skip: top ? top.id : null }), trending(), voices()]);
    const counts = await db.get(`SELECT (SELECT COUNT(*) FROM rundown_topics WHERE status = 'live') AS topics,
        (SELECT COUNT(*) FROM rundown_episodes WHERE status = 'live') AS episodes, (SELECT COUNT(*) FROM rundown_segments WHERE status = 'live') AS takes`);
    return { on_air: air, lead: top, streams: feed.streams, streams_next: feed.next, trending: topics, voices: talk,
        // Empty, with no query behind them: the N-1 fixture's reply still has the old river's keys (gone once it is re-recorded).
        latest: [], next: null,
        counts: { topics: Number(counts.topics), episodes: Number(counts.episodes), takes: Number(counts.takes) } };
}

const KINDS = ['news', 'games', 'tech', 'life', 'music', 'sports', 'money', 'internet', 'chat', 'other'];
async function topics({ sort = 'recent', kind = null, limit = 60, offset = 0 } = {}) {
    const order = sort === 'most' ? 'streamers DESC, takes DESC, last_seen_at DESC' : 'last_seen_at DESC';
    const k = KINDS.includes(kind) ? kind : null;
    const rows = await db.all(`SELECT id, slug, title, kind, headline, summary, takes, streamers, first_seen_at, last_seen_at FROM rundown_topics
        WHERE status = 'live' AND takes > 0 AND (?::text IS NULL OR kind = ?) ORDER BY ${order} LIMIT ? OFFSET ?`, [k, k, Math.min(100, limit), Math.max(0, offset)]);
    const users = rows.length ? await db.all(`SELECT topic_id, array_agg(DISTINCT user_id) AS users FROM rundown_segments WHERE status = 'live' AND topic_id = ANY(?) GROUP BY topic_id`, [rows.map((r) => Number(r.id))]) : [];
    const byTopic = new Map(users.map((u) => [Number(u.topic_id), (u.users || []).slice(0, 4)]));
    const ppl = await people([...byTopic.values()].flat());
    return { topics: rows.map((r) => ({ slug: r.slug, title: r.title, kind: r.kind, headline: r.headline || null, summary: r.summary || null, takes: Number(r.takes), streamers: Number(r.streamers),
        first_seen_at: r.first_seen_at, last_seen_at: r.last_seen_at, people: (byTopic.get(Number(r.id)) || []).map((id) => ppl.get(Number(id))).filter(Boolean) })), kinds: KINDS };
}

async function topic(slug, { viewer = null } = {}) {
    const t = await db.get("SELECT id, slug, title, kind, headline, summary, takes, streamers, first_seen_at, last_seen_at FROM rundown_topics WHERE slug = ? AND status = 'live'", [String(slug || '').slice(0, 80)]);
    if (!t) return null;
    const rows = await db.all(`SELECT ${SEGMENT_COLS} FROM rundown_segments WHERE topic_id = ? AND status = 'live' ORDER BY said_at DESC LIMIT 100`, [t.id]);
    const related = await db.all(`SELECT DISTINCT t2.slug, t2.title, t2.last_seen_at FROM rundown_segments s JOIN rundown_segments s2 ON s2.stream_id = s.stream_id AND s2.topic_id <> s.topic_id
        JOIN rundown_topics t2 ON t2.id = s2.topic_id AND t2.status = 'live' WHERE s.topic_id = ? ORDER BY t2.last_seen_at DESC LIMIT 8`, [t.id]);
    return { topic: { slug: t.slug, title: t.title, kind: t.kind, headline: t.headline || null, summary: t.summary || null, takes: Number(t.takes), streamers: Number(t.streamers), first_seen_at: t.first_seen_at, last_seen_at: t.last_seen_at },
        takes: await segmentsOut(rows, viewer), related: related.map((r) => ({ slug: r.slug, title: r.title })) };
}

async function episode(streamId, { viewer = null } = {}) {
    const id = parseInt(streamId, 10);
    if (!(id > 0)) return null;
    const e = await db.get(`SELECT ${EPISODE_COLS} FROM rundown_episodes WHERE stream_id = ? AND status = 'live'`, [id]);
    const segs = await db.all(`SELECT ${SEGMENT_COLS} FROM rundown_segments WHERE stream_id = ? AND status = 'live' ORDER BY start_sec ASC LIMIT 60`, [id]);
    if (!e && !segs.length) return null;
    const stream = await db.get('SELECT id, user_id, title, is_live, started_at, ended_at FROM streams WHERE id = ?', [id]);
    if (!stream) return null;
    const others = await db.all(`SELECT ${EPISODE_COLS} FROM rundown_episodes WHERE user_id = ? AND status = 'live' AND stream_id <> ? ORDER BY aired_at DESC LIMIT 6`, [stream.user_id, id]);
    const ppl = await people([stream.user_id]);
    return { episode: e ? (await episodesOut([e], viewer))[0] : null, stream: { id: Number(stream.id), title: stream.title || null, is_live: !!Number(stream.is_live), started_at: stream.started_at, ended_at: stream.ended_at, user: ppl.get(Number(stream.user_id)) || null },
        segments: await segmentsOut(segs, viewer), more: await episodesOut(others, viewer) };
}

async function streamer(username, { viewer = null } = {}) {
    const u = await db.get('SELECT id, username, display_name, avatar_url, profile_color FROM users WHERE lower(username) = lower(?)', [String(username || '').replace(/^@/, '').slice(0, 64)]);
    if (!u) return null;
    const out = !!await db.get('SELECT 1 FROM arena_opt_outs WHERE user_id = ?', [u.id]);
    if (out) return { user: person(u), opted_out: true, episodes: [], topics: [], lines: [], crossovers: [] };
    const eps = await db.all(`SELECT ${EPISODE_COLS} FROM rundown_episodes WHERE user_id = ? AND status = 'live' ORDER BY aired_at DESC LIMIT 30`, [u.id]);
    const tops = await db.all(`SELECT t.slug, t.title, t.kind, COUNT(*) AS n, MAX(s.said_at) AS last FROM rundown_segments s JOIN rundown_topics t ON t.id = s.topic_id
        WHERE s.user_id = ? AND s.status = 'live' AND t.status = 'live' GROUP BY t.slug, t.title, t.kind ORDER BY COUNT(*) DESC, MAX(s.said_at) DESC LIMIT 24`, [u.id]);
    const lines = await db.all(`SELECT ${SEGMENT_COLS} FROM rundown_segments WHERE user_id = ? AND status = 'live' AND quotes_json <> '[]' ORDER BY score DESC, said_at DESC LIMIT 12`, [u.id]);
    const cross = await db.all(`SELECT ${SEGMENT_COLS} FROM rundown_segments WHERE status = 'live' AND (? = ANY(mentions) OR (user_id = ? AND cardinality(mentions) > 0)) ORDER BY said_at DESC LIMIT 12`, [u.id, u.id]);
    return { user: person(u), opted_out: false, episodes: await episodesOut(eps, viewer), topics: tops.map((t) => ({ slug: t.slug, title: t.title, kind: t.kind, takes: Number(t.n), last_seen_at: t.last })),
        lines: await segmentsOut(lines, viewer), crossovers: await segmentsOut(cross, viewer) };
}

/** One reaction per reader per item; the same reaction again takes it back. → { reactions, mine } */
async function react(type, id, voter, reaction) {
    if (!['segment', 'episode'].includes(type) || !REACTIONS.includes(reaction) || !voter) throw Object.assign(new Error('Unknown reaction'), { status: 400 });
    const itemId = parseInt(id, 10);
    const exists = type === 'segment' ? await db.get("SELECT 1 FROM rundown_segments WHERE id = ? AND status = 'live'", [itemId]) : await db.get("SELECT 1 FROM rundown_episodes WHERE stream_id = ? AND status = 'live'", [itemId]);
    if (!exists) throw Object.assign(new Error('Not found'), { status: 404 });
    const cur = await db.get('SELECT reaction FROM rundown_reactions WHERE item_type = ? AND item_id = ? AND voter = ?', [type, itemId, voter]);
    if (cur && cur.reaction === reaction) await db.run('DELETE FROM rundown_reactions WHERE item_type = ? AND item_id = ? AND voter = ?', [type, itemId, voter]);
    else await db.run(`INSERT INTO rundown_reactions (item_type, item_id, voter, reaction) VALUES (?, ?, ?, ?)
        ON CONFLICT (item_type, item_id, voter) DO UPDATE SET reaction = excluded.reaction, created_at = ov_now()`, [type, itemId, voter, reaction]);
    const rx = await reactionsFor(type, [itemId], voter);
    return { reactions: rx.counts.get(itemId) || {}, mine: rx.mine.get(itemId) || null };
}

/** Staff take an item down (status hidden); a hidden topic leaves every list. */
async function hide(type, id) {
    if (type === 'segment') await db.run("UPDATE rundown_segments SET status = 'hidden' WHERE id = ?", [parseInt(id, 10)]);
    else if (type === 'episode') await db.run("UPDATE rundown_episodes SET status = 'hidden' WHERE stream_id = ?", [parseInt(id, 10)]);
    else if (type === 'topic') await db.run("UPDATE rundown_topics SET status = 'hidden' WHERE slug = ?", [String(id)]);
    else throw Object.assign(new Error('Unknown item'), { status: 400 });
    return { hidden: true };
}

async function optedOut(userId) { return !!await db.get('SELECT 1 FROM arena_opt_outs WHERE user_id = ?', [userId]); }
/** Keep yourself out (or come back): out hides everything about you and the desk stops reading your streams. */
async function setOptOut(userId, out) {
    if (out) {
        await db.run('INSERT INTO arena_opt_outs (user_id) VALUES (?) ON CONFLICT DO NOTHING', [userId]);
        await db.run("UPDATE rundown_segments SET status = 'out' WHERE user_id = ? AND status = 'live'", [userId]);
        await db.run("UPDATE rundown_episodes SET status = 'out' WHERE user_id = ? AND status = 'live'", [userId]);
    } else {
        await db.run('DELETE FROM arena_opt_outs WHERE user_id = ?', [userId]);
        await db.run("UPDATE rundown_segments SET status = 'live' WHERE user_id = ? AND status = 'out'", [userId]);
        await db.run("UPDATE rundown_episodes SET status = 'live' WHERE user_id = ? AND status = 'out'", [userId]);
    }
    return { opted_out: !!out };
}

module.exports = { home, lead, streamsFeed, topics, topic, episode, streamer, react, hide, optedOut, setOptOut, trending, voices, onAir, REACTIONS, KINDS, person };
