'use strict';
/**
 * What The Rundown's pages read (server/rundown/routes.js, docs/rundown.md). Rows come out through allow-listed shapes:
 * a person is { id, username, display_name, avatar_url, profile_color }, never a users row.
 *
 *   home({ viewer })                on air now, the lead take, stream by stream, trending topics, who's been talking
 *   streamsFeed({ before, viewer }) stream by stream: each recent stream with its episode and its best takes, newest first
 *   topics({ sort, kind })          every topic
 *   topic(slug)                     one topic and every take on it
 *   episode(streamId)               one stream written up, with its segments
 *   streamer(username)              their episodes, topics, lines and crossovers
 *   react(type, id, voter, r)       one reaction per reader per item (a reader is their account, else a salted address hash)
 *
 * Who sees what (design 2026-11-06): the gathered pages show Everyone only — the front page, the topics, the topic
 * pages, trending, who's been talking, the streamer list and the counts. The streamer sees all their own items
 * everywhere, each non-public one marked with a small audience chip. The recording decides first: an item is Everyone
 * only when its episode is Everyone and its VOD is not stricter than that.
 */
const db = require('../db/database');
const config = require('../config');
const visibility = require('./visibility');
const sharing = require('./sharing');

const REACTIONS = ['fire', 'lol', 'dead', 'cap', 'facts'];
const FEED_MIN_SCORE = 4;       // the front page: a take scored 4 or 5, a crossover or an episode
const STREAM_TAKES = 3;         // stream by stream: a stream's best takes on the front page (the episode page has them all)
const STREAMS_PAGE = 8;
const parseJson = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 19).replace('T', ' ');

/** Live's public base, never localhost in a URL a browser would get. */
function siteBase() {
    let b = config.baseUrl || 'https://openvibe.live';
    if (/localhost|127\.0\.0\.1/.test(b)) b = 'https://openvibe.live';
    return b.replace(/\/+$/, '');
}
function absolute(url) {
    if (!url) return null;
    if (/^https?:\/\//i.test(url)) return url;
    return `${siteBase()}${String(url).startsWith('/') ? '' : '/'}${url}`;
}
const isNsfw = (row) => !!(Number(row && row.is_nsfw) || Number(row && row.channel_force_nsfw));

/**
 * The reader: their account (when signed in) and their voter key. The voter key is what reactions are counted by; the
 * account is what the audience rule is counted by.
 */
function who(viewer) {
    if (!viewer) return { key: null, userId: null, subject: null };
    if (typeof viewer === 'string') return { key: viewer, userId: null, subject: null };
    return { key: viewer.key || null, userId: viewer.userId == null ? null : Number(viewer.userId), subject: viewer.subject || null };
}

/**
 * Who may see an item on a gathered page: the reader's own items, or items that are Everyone. "Everyone" means the
 * episode's own setting is Everyone and the recording is not stricter than that (the recording decides first).
 */
const VISIBLE = (alias) => `(${alias}.user_id = @viewer OR (COALESCE(sh.audience, 'public') = 'public' AND COALESCE(v.vod_audience, 'public') = 'public'))`;
const AUDIENCE_JOINS = (alias) => `LEFT JOIN shares sh ON sh.service = 'live' AND sh.kind = 'rundown-episode' AND sh.resource_id = CAST(${alias}.stream_id AS text)
    LEFT JOIN rundown_visibility v ON v.stream_id = ${alias}.stream_id`;

/**
 * stream id → card picture. A live stream shows its live frame; an ended one asks Media for its public VOD's
 * thumbnail (one batched, five-minute-cached lookup per call, media-proxy/lookups.js). NSFW channels and streams
 * never get a picture, and a Media failure leaves the ended ones null instead of failing the page.
 */
async function thumbnailsFor(rows) {
    const out = new Map();
    const vodIds = [];
    for (const r of rows || []) {
        if (!r) continue;
        const id = Number(r.id ?? r.stream_id);
        if (!Number.isSafeInteger(id) || id <= 0) continue;
        if (isNsfw(r)) { out.set(id, null); continue; }
        if (Number(r.is_live)) { out.set(id, absolute(r.thumbnail_url)); continue; }
        vodIds.push(id);
    }
    if (!vodIds.length) return out;
    try {
        const vods = await require('../media-proxy/lookups').publicVodsForStreams(vodIds);
        const media = require('../media-client');
        for (const id of vodIds) out.set(id, media.publicUrl(vods.get(id) && vods.get(id).thumbnail_url));
    } catch {
        for (const id of vodIds) out.set(id, null);
    }
    return out;
}

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

/**
 * The audience of every stream on this page, in one batch: the episode's own setting and what the recording decides.
 * The chip a streamer sees on their own items comes from here.
 */
async function audiencesFor(streamIds) {
    const ids = [...new Set((streamIds || []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
    const out = new Map();
    if (!ids.length) return out;
    let own = [], vod = [];
    try {
        own = await db.all("SELECT resource_id, audience FROM shares WHERE service = 'live' AND kind = 'rundown-episode' AND resource_id = ANY(?)",
            [ids.map((n) => String(n))]);
    } catch { own = []; }
    try {
        vod = await db.all('SELECT stream_id, vod_audience FROM rundown_visibility WHERE stream_id = ANY(?)', [ids]);
    } catch { vod = []; }
    const ownBy = new Map(own.map((r) => [Number(r.resource_id), r.audience]));
    const vodBy = new Map(vod.map((r) => [Number(r.stream_id), r.vod_audience]));
    for (const id of ids) {
        const o = ownBy.get(id) || visibility.DEFAULT_AUDIENCE;
        const w = vodBy.get(id) || visibility.DEFAULT_AUDIENCE;
        const audience = visibility.stricter(o, w);
        out.set(id, {
            own: o, vod: w, audience,
            chip: audience === visibility.DEFAULT_AUDIENCE ? null : visibility.label(audience),
            following_vod: audience !== o,
            following_vod_label: audience !== o ? visibility.mediaWord(w) : null,
        });
    }
    return out;
}

/** Segments as the pages show them, with their people, topics and reactions resolved in three queries. */
async function segmentsOut(rows, voter) {
    if (!rows.length) return [];
    const ppl = await people(rows.flatMap((r) => [r.user_id, ...(r.mentions || [])]));
    const tps = await topicsById(rows.map((r) => r.topic_id));
    const rx = await reactionsFor('segment', rows.map((r) => r.id), voter);
    const aud = await audiencesFor(rows.map((r) => r.stream_id));
    // Segment and quote times are stream time; `sec` links into vod_id, which for a stream recorded in parts (its
    // broadcaster reconnected) starts later than the stream (streaming/stream-history.js).
    const history = require('../streaming/stream-history');
    const offsets = await history.vodOffsets(rows.map((r) => r.vod_id));
    const inVod = (r, sec) => Math.max(0, Math.floor(history.vodTime(sec, r.vod_id ? offsets.get(Number(r.vod_id)) : 0)));
    return rows.map((r) => {
        const a = aud.get(Number(r.stream_id)) || {};
        return {
            type: 'segment', id: Number(r.id), title: r.title, what: r.what, take: r.take || null, quip: r.quip || null, score: Number(r.score),
            quotes: parseJson(r.quotes_json, []).map((q) => ({ text: q.text, en: q.en || null, sec: inVod(r, q.sec) })),
            topic: tps.get(Number(r.topic_id)) || null, user: ppl.get(Number(r.user_id)) || null,
            mentions: (r.mentions || []).map((id) => ppl.get(Number(id))).filter(Boolean),
            stream_id: Number(r.stream_id), vod_id: r.vod_id ? Number(r.vod_id) : null, sec: inVod(r, r.start_sec),
            said_at: r.said_at, reactions: rx.counts.get(Number(r.id)) || {}, my_reaction: rx.mine.get(Number(r.id)) || null,
            audience: a.audience || 'public', audience_chip: a.chip || null,
        };
    });
}
async function episodesOut(rows, voter) {
    if (!rows.length) return [];
    const ppl = await people(rows.map((r) => r.user_id));
    const rx = await reactionsFor('episode', rows.map((r) => r.stream_id), voter);
    const ids = rows.map((r) => Number(r.stream_id));
    const aud = await audiencesFor(ids);
    const topicRows = ids.length ? await db.all(`SELECT DISTINCT ON (s.stream_id, t.id) s.stream_id, t.slug, t.title FROM rundown_segments s JOIN rundown_topics t ON t.id = s.topic_id
        WHERE s.stream_id = ANY(?) AND s.status = 'live' AND t.status = 'live' ORDER BY s.stream_id, t.id`, [ids]) : [];
    const byStream = new Map();
    for (const t of topicRows) { const l = byStream.get(Number(t.stream_id)) || []; if (l.length < 6) l.push({ slug: t.slug, title: t.title }); byStream.set(Number(t.stream_id), l); }
    return rows.map((r) => {
        const a = aud.get(Number(r.stream_id)) || {};
        return {
            type: 'episode', stream_id: Number(r.stream_id), title: r.title, logline: r.logline || null, recap: r.recap || null,
            chapters: parseJson(r.chapters_json, []).map((c) => ({ sec: Math.max(0, Math.floor(Number(c.sec) || 0)), title: c.title, segment_id: c.segment_id ? Number(c.segment_id) : null })),
            user: ppl.get(Number(r.user_id)) || null, vod_id: r.vod_id ? Number(r.vod_id) : null, minutes: r.minutes == null ? null : Number(r.minutes),
            aired_at: r.aired_at, topics: byStream.get(Number(r.stream_id)) || [],
            reactions: rx.counts.get(Number(r.stream_id)) || {}, my_reaction: rx.mine.get(Number(r.stream_id)) || null,
            audience: a.audience || 'public', audience_chip: a.chip || null,
            following_vod: !!a.following_vod, following_vod_label: a.following_vod_label || null,
        };
    });
}

// The columns are qualified: the audience joins bring a second table with the same names.
const SEGMENT_COLS = 's.id, s.stream_id, s.user_id, s.topic_id, s.start_sec, s.title, s.what, s.take, s.quip, s.score, s.quotes_json, s.mentions, s.vod_id, s.said_at';
const EPISODE_COLS = 'r.stream_id, r.user_id, r.title, r.logline, r.recap, r.chapters_json, r.vod_id, r.minutes, r.aired_at';

async function onAir() {
    const rows = await db.all(`SELECT s.id AS stream_id, s.user_id, s.title AS stream_title, s.is_nsfw, s.thumbnail_url,
            COALESCE(c.force_nsfw, 0) AS channel_force_nsfw,
            (SELECT g.title FROM rundown_segments g WHERE g.stream_id = s.id AND g.status = 'live' ORDER BY g.start_sec DESC LIMIT 1) AS talking_about,
            (SELECT t.slug FROM rundown_segments g JOIN rundown_topics t ON t.id = g.topic_id WHERE g.stream_id = s.id AND g.status = 'live' ORDER BY g.start_sec DESC LIMIT 1) AS topic_slug,
            (SELECT t.title FROM rundown_segments g JOIN rundown_topics t ON t.id = g.topic_id WHERE g.stream_id = s.id AND g.status = 'live' ORDER BY g.start_sec DESC LIMIT 1) AS topic_title
        FROM streams s LEFT JOIN channels c ON c.user_id = s.user_id
        WHERE s.is_live = 1 AND s.user_id NOT IN (SELECT user_id FROM arena_opt_outs) ORDER BY s.viewer_count DESC NULLS LAST LIMIT 12`);
    const ppl = await people(rows.map((r) => r.user_id));
    const thumbs = await thumbnailsFor(rows.map((r) => ({ stream_id: r.stream_id, is_live: 1, is_nsfw: r.is_nsfw, channel_force_nsfw: r.channel_force_nsfw, thumbnail_url: r.thumbnail_url })));
    return rows.map((r) => ({ stream_id: Number(r.stream_id), user: ppl.get(Number(r.user_id)) || null, stream_title: r.stream_title || null, thumbnail_url: thumbs.get(Number(r.stream_id)) || null, talking_about: r.talking_about || null, topic: r.topic_slug ? { slug: r.topic_slug, title: r.topic_title } : null })).filter((r) => r.user);
}

/** Trending topics: only what everyone may see is counted. */
async function trending(limit = 12, days = 7) {
    const rows = await db.all(`SELECT t.id, t.slug, t.title, t.kind, t.headline, t.summary, t.last_seen_at,
            COUNT(s.id) AS week_takes, COUNT(DISTINCT s.user_id) AS week_streamers, array_agg(DISTINCT s.user_id) AS users
        FROM rundown_topics t JOIN rundown_segments s ON s.topic_id = t.id AND s.status = 'live' AND s.said_at >= @since
        ${AUDIENCE_JOINS('s')}
        WHERE t.status = 'live' AND ${VISIBLE('s')} GROUP BY t.id ORDER BY COUNT(DISTINCT s.user_id) DESC, COUNT(s.id) DESC, MAX(s.said_at) DESC LIMIT @limit`,
    { since: daysAgo(days), limit, viewer: null });
    const ppl = await people(rows.flatMap((r) => (r.users || []).slice(0, 4)));
    return rows.map((r) => ({ slug: r.slug, title: r.title, kind: r.kind, headline: r.headline || null, summary: r.summary || null, last_seen_at: r.last_seen_at,
        takes: Number(r.week_takes), streamers: Number(r.week_streamers), people: (r.users || []).slice(0, 4).map((id) => ppl.get(Number(id))).filter(Boolean) }));
}

/** Who's been talking: only what everyone may see is counted. */
async function voices(days = 7) {
    const rows = await db.all(`SELECT s.user_id, COUNT(*) AS segments, COUNT(DISTINCT s.topic_id) AS topics, MAX(s.said_at) AS last_seen
        FROM rundown_segments s ${AUDIENCE_JOINS('s')}
        WHERE s.status = 'live' AND s.said_at >= @since AND ${VISIBLE('s')} GROUP BY s.user_id ORDER BY MAX(s.said_at) DESC LIMIT 16`, { since: daysAgo(days), viewer: null });
    const ppl = await people(rows.map((r) => r.user_id));
    const tops = rows.length ? await db.all(`SELECT s.user_id, t.slug, t.title, COUNT(*) AS n FROM rundown_segments s JOIN rundown_topics t ON t.id = s.topic_id
        WHERE s.status = 'live' AND t.status = 'live' AND s.said_at >= @since AND s.user_id = ANY(@users) GROUP BY s.user_id, t.slug, t.title ORDER BY COUNT(*) DESC`, { since: daysAgo(days), users: rows.map((r) => Number(r.user_id)) }) : [];
    const byUser = new Map();
    for (const t of tops) { const l = byUser.get(Number(t.user_id)) || []; if (l.length < 3) l.push({ slug: t.slug, title: t.title }); byUser.set(Number(t.user_id), l); }
    return rows.map((r) => ({ user: ppl.get(Number(r.user_id)) || null, segments: Number(r.segments), topics: Number(r.topics), last_seen: r.last_seen, top_topics: byUser.get(Number(r.user_id)) || [] })).filter((v) => v.user);
}

/** The lead: the best take of the last day (else the week), a quoted one first. */
async function lead({ viewer = null } = {}) {
    const v = who(viewer);
    for (const days of [1, 7]) {
        const rows = await db.all(`SELECT ${SEGMENT_COLS} FROM rundown_segments s ${AUDIENCE_JOINS('s')}
            WHERE s.status = 'live' AND s.said_at >= @since AND s.score >= @score AND ${VISIBLE('s')}
            ORDER BY s.score DESC, (s.quotes_json <> '[]') DESC, s.said_at DESC LIMIT 1`, { since: daysAgo(days), score: FEED_MIN_SCORE, viewer: v.userId });
        if (rows.length) return (await segmentsOut(rows, v.key))[0];
    }
    return null;
}

/**
 * Stream by stream: the streams the desk wrote about, newest first, each with its episode (when it has ended and been
 * written up) and its best STREAM_TAKES takes in the order they were said. `skip` leaves out the lead take. Paged by the
 * time of a stream's latest take.
 */
async function streamsFeed({ before = null, limit = STREAMS_PAGE, viewer = null, skip = null } = {}) {
    const v = who(viewer);
    const cut = before ? String(before).slice(0, 19) : '9999-12-31 00:00:00';
    const groups = await db.all(`SELECT s.stream_id, MAX(s.said_at) AS last_at, COUNT(*) AS takes FROM rundown_segments s ${AUDIENCE_JOINS('s')}
        WHERE s.status = 'live' AND ${VISIBLE('s')} GROUP BY s.stream_id HAVING MAX(s.said_at) < @cut ORDER BY MAX(s.said_at) DESC LIMIT @limit`, { cut, limit, viewer: v.userId });
    const ids = groups.map((g) => Number(g.stream_id));
    if (!ids.length) return { streams: [], next: null };
    const segs = await db.all(`SELECT ${SEGMENT_COLS} FROM rundown_segments s ${AUDIENCE_JOINS('s')}
        WHERE s.status = 'live' AND s.stream_id = ANY(@ids) AND ${VISIBLE('s')}
        ORDER BY s.score DESC, cardinality(s.mentions) DESC, (s.quotes_json <> '[]') DESC, s.start_sec ASC`, { ids, viewer: v.userId });
    const best = new Map();
    for (const s of segs) {
        const l = best.get(Number(s.stream_id)) || [];
        if (l.length < STREAM_TAKES && Number(s.id) !== Number(skip)) l.push(s);
        best.set(Number(s.stream_id), l);
    }
    const chosen = [...best.values()].flat().sort((a, b) => Number(a.start_sec) - Number(b.start_sec));
    const takes = new Map();
    for (const t of await segmentsOut(chosen, v.key)) { const l = takes.get(t.stream_id) || []; l.push(t); takes.set(t.stream_id, l); }
    const eps = new Map((await episodesOut(await db.all(`SELECT ${EPISODE_COLS} FROM rundown_episodes r ${AUDIENCE_JOINS('r')}
        WHERE r.status = 'live' AND r.stream_id = ANY(@ids) AND ${VISIBLE('r')}`, { ids, viewer: v.userId }), v.key))
        .map((e) => [e.stream_id, { title: e.title, logline: e.logline, minutes: e.minutes, aired_at: e.aired_at, topics: e.topics, reactions: e.reactions, my_reaction: e.my_reaction, audience: e.audience, audience_chip: e.audience_chip }]));
    const streams = new Map((await db.all(`SELECT s.id, s.user_id, s.title, s.is_live, s.started_at, s.ended_at, s.duration_seconds,
            s.is_nsfw, s.thumbnail_url, COALESCE(c.force_nsfw, 0) AS channel_force_nsfw
        FROM streams s LEFT JOIN channels c ON c.user_id = s.user_id WHERE s.id = ANY(@ids)`, { ids })).map((s) => [Number(s.id), s]));
    const ppl = await people([...streams.values()].map((s) => s.user_id));
    const thumbs = await thumbnailsFor([...streams.values()]);
    const out = groups.map((g) => {
        const s = streams.get(Number(g.stream_id));
        if (!s) return null;
        return { stream_id: Number(g.stream_id), user: ppl.get(Number(s.user_id)) || null, title: s.title || null, thumbnail_url: thumbs.get(Number(g.stream_id)) || null,
            live: !!Number(s.is_live), started_at: s.started_at, minutes: s.duration_seconds ? Math.round(Number(s.duration_seconds) / 60) : null, last_at: g.last_at, takes_total: Number(g.takes),
            episode: eps.get(Number(g.stream_id)) || null, takes: takes.get(Number(g.stream_id)) || [] };
    }).filter((x) => x && x.user && x.takes.length);
    return { streams: out, next: groups.length >= limit ? groups[groups.length - 1].last_at : null };
}

async function home({ viewer = null } = {}) {
    const v = who(viewer);
    const top = await lead({ viewer });
    const [air, feed, topics, talk] = await Promise.all([onAir(), streamsFeed({ viewer, skip: top ? top.id : null }), trending(), voices()]);
    const counts = await db.get(`SELECT
        (SELECT COUNT(DISTINCT t.id) FROM rundown_topics t JOIN rundown_segments s ON s.topic_id = t.id AND s.status = 'live' ${AUDIENCE_JOINS('s')} WHERE t.status = 'live' AND ${VISIBLE('s')}) AS topics,
        (SELECT COUNT(*) FROM rundown_episodes r ${AUDIENCE_JOINS('r')} WHERE r.status = 'live' AND ${VISIBLE('r')}) AS episodes,
        (SELECT COUNT(*) FROM rundown_segments s ${AUDIENCE_JOINS('s')} WHERE s.status = 'live' AND ${VISIBLE('s')}) AS takes`, { viewer: v.userId });
    return { on_air: air, lead: top, streams: feed.streams, streams_next: feed.next, trending: topics, voices: talk,
        // Empty, with no query behind them: the N-1 fixture's reply still has the old river's keys (gone once it is re-recorded).
        latest: [], next: null,
        counts: { topics: Number(counts.topics), episodes: Number(counts.episodes), takes: Number(counts.takes) } };
}

const KINDS = ['news', 'games', 'tech', 'life', 'music', 'sports', 'money', 'internet', 'chat', 'other'];
/** Every topic, with the takes everyone may see counted (a topic whose takes are all non-public disappears). */
async function topics({ sort = 'recent', kind = null, limit = 60, offset = 0 } = {}) {
    const order = sort === 'most' ? 'streamers DESC, takes DESC, last_seen_at DESC' : 'last_seen_at DESC';
    const k = KINDS.includes(kind) ? kind : null;
    const rows = await db.all(`SELECT t.id, t.slug, t.title, t.kind, t.headline, t.summary, t.first_seen_at, t.last_seen_at,
            COUNT(s.id) AS takes, COUNT(DISTINCT s.user_id) AS streamers, array_agg(DISTINCT s.user_id) AS users
        FROM rundown_topics t JOIN rundown_segments s ON s.topic_id = t.id AND s.status = 'live' ${AUDIENCE_JOINS('s')}
        WHERE t.status = 'live' AND ${VISIBLE('s')} AND (@kind::text IS NULL OR t.kind = @kind)
        GROUP BY t.id ORDER BY ${order} LIMIT @limit OFFSET @offset`, { kind: k, limit: Math.min(100, limit), offset: Math.max(0, offset), viewer: null });
    const byTopic = new Map(rows.map((u) => [Number(u.id), (u.users || []).slice(0, 4)]));
    const ppl = await people([...byTopic.values()].flat());
    return { topics: rows.map((r) => ({ slug: r.slug, title: r.title, kind: r.kind, headline: r.headline || null, summary: r.summary || null, takes: Number(r.takes), streamers: Number(r.streamers),
        first_seen_at: r.first_seen_at, last_seen_at: r.last_seen_at, people: (byTopic.get(Number(r.id)) || []).map((id) => ppl.get(Number(id))).filter(Boolean) })), kinds: KINDS };
}

/** One topic and the takes on it that everyone may see. */
async function topic(slug, { viewer = null } = {}) {
    const v = who(viewer);
    const t = await db.get("SELECT id, slug, title, kind, headline, summary, takes, streamers, first_seen_at, last_seen_at FROM rundown_topics WHERE slug = ? AND status = 'live'", [String(slug || '').slice(0, 80)]);
    if (!t) return null;
    const rows = await db.all(`SELECT ${SEGMENT_COLS} FROM rundown_segments s ${AUDIENCE_JOINS('s')}
        WHERE s.topic_id = @topic AND s.status = 'live' AND ${VISIBLE('s')} ORDER BY s.said_at DESC LIMIT 100`, { topic: t.id, viewer: v.userId });
    if (!rows.length) return null;   // every take on it is non-public: the topic is not there for this reader
    const counts = await db.get(`SELECT COUNT(*) AS takes, COUNT(DISTINCT s.user_id) AS streamers FROM rundown_segments s ${AUDIENCE_JOINS('s')}
        WHERE s.topic_id = @topic AND s.status = 'live' AND ${VISIBLE('s')}`, { topic: t.id, viewer: v.userId });
    const related = await db.all(`SELECT DISTINCT t2.slug, t2.title, t2.last_seen_at FROM rundown_segments s JOIN rundown_segments s2 ON s2.stream_id = s.stream_id AND s2.topic_id <> s.topic_id
        JOIN rundown_topics t2 ON t2.id = s2.topic_id AND t2.status = 'live' WHERE s.topic_id = @topic ORDER BY t2.last_seen_at DESC LIMIT 8`, { topic: t.id });
    return { topic: { slug: t.slug, title: t.title, kind: t.kind, headline: t.headline || null, summary: t.summary || null, takes: Number(counts.takes), streamers: Number(counts.streamers), first_seen_at: t.first_seen_at, last_seen_at: t.last_seen_at },
        takes: await segmentsOut(rows, v.key), related: related.map((r) => ({ slug: r.slug, title: r.title })) };
}

/**
 * One stream written up: the episode, its segments and the streamer's other episodes. The episode's own audience
 * decides who may open it: anybody with the link, the people it is shared with, or the streamer.
 */
async function episode(streamId, { viewer = null } = {}) {
    const id = parseInt(streamId, 10);
    if (!(id > 0)) return null;
    const v = who(viewer);
    const e = await db.get(`SELECT ${EPISODE_COLS} FROM rundown_episodes r ${AUDIENCE_JOINS('r')} WHERE r.stream_id = @id AND r.status = 'live'`, { id });
    const stream = await db.get('SELECT id, user_id, title, is_live, started_at, ended_at FROM streams WHERE id = ?', [id]);
    if (!stream) return null;
    // Until Media's event lands, the episode page re-checks the recording (cached 60 s).
    await visibility.recheck(id);
    const eff = await visibility.effective(id);
    const ownerUserId = e ? e.user_id : stream.user_id;
    if (!sharing.maySee(eff, { ownerUserId, viewer: v })) return null;
    const segs = await db.all(`SELECT ${SEGMENT_COLS} FROM rundown_segments s WHERE s.stream_id = @id AND s.status = 'live' ORDER BY s.start_sec ASC LIMIT 60`, { id });
    if (!e && !segs.length) return null;
    const others = await db.all(`SELECT ${EPISODE_COLS} FROM rundown_episodes r ${AUDIENCE_JOINS('r')}
        WHERE r.user_id = @user AND r.status = 'live' AND r.stream_id <> @id AND ${VISIBLE('r')} ORDER BY r.aired_at DESC LIMIT 6`, { user: stream.user_id, id, viewer: v.userId });
    const ppl = await people([stream.user_id]);
    const eps = e ? await episodesOut([e], v.key) : [];
    const episodeOut = eps[0] || null;
    if (episodeOut) {
        episodeOut.following_vod = eff.following_vod;
        episodeOut.following_vod_label = eff.following_vod ? visibility.mediaWord(eff.vod) : null;
        episodeOut.audience = eff.audience;
        episodeOut.audience_chip = eff.audience === 'public' ? null : visibility.label(eff.audience, eff.member_count);
    }
    return { episode: episodeOut, stream: { id: Number(stream.id), title: stream.title || null, is_live: !!Number(stream.is_live), started_at: stream.started_at, ended_at: stream.ended_at, user: ppl.get(Number(stream.user_id)) || null },
        segments: await segmentsOut(segs, v.key), more: await episodesOut(others, v.key) };
}

/** A streamer's own page: their episodes, topics, lines and the crossovers (takes that name them). */
async function streamer(username, { viewer = null } = {}) {
    const v = who(viewer);
    const u = await db.get('SELECT id, username, display_name, avatar_url, profile_color FROM users WHERE lower(username) = lower(?)', [String(username || '').replace(/^@/, '').slice(0, 64)]);
    if (!u) return null;
    const out = !!await db.get('SELECT 1 FROM arena_opt_outs WHERE user_id = ?', [u.id]);
    if (out) return { user: person(u), opted_out: true, episodes: [], topics: [], lines: [], crossovers: [] };
    const eps = await db.all(`SELECT ${EPISODE_COLS} FROM rundown_episodes r ${AUDIENCE_JOINS('r')}
        WHERE r.user_id = @user AND r.status = 'live' AND ${VISIBLE('r')} ORDER BY r.aired_at DESC LIMIT 30`, { user: u.id, viewer: v.userId });
    const tops = await db.all(`SELECT t.slug, t.title, t.kind, COUNT(*) AS n, MAX(s.said_at) AS last FROM rundown_segments s JOIN rundown_topics t ON t.id = s.topic_id
        ${AUDIENCE_JOINS('s')}
        WHERE s.user_id = @user AND s.status = 'live' AND t.status = 'live' AND ${VISIBLE('s')} GROUP BY t.slug, t.title, t.kind ORDER BY COUNT(*) DESC, MAX(s.said_at) DESC LIMIT 24`, { user: u.id, viewer: v.userId });
    const lines = await db.all(`SELECT ${SEGMENT_COLS} FROM rundown_segments s ${AUDIENCE_JOINS('s')}
        WHERE s.user_id = @user AND s.status = 'live' AND s.quotes_json <> '[]' AND ${VISIBLE('s')} ORDER BY s.score DESC, s.said_at DESC LIMIT 12`, { user: u.id, viewer: v.userId });
    // A take that names them is a crossover — but only when everyone may see it. A non-public take never reaches
    // another streamer's page and never tells them they were named.
    const cross = await db.all(`SELECT ${SEGMENT_COLS} FROM rundown_segments s ${AUDIENCE_JOINS('s')}
        WHERE s.status = 'live' AND (@user = ANY(s.mentions) OR (s.user_id = @user AND cardinality(s.mentions) > 0)) AND ${VISIBLE('s')} ORDER BY s.said_at DESC LIMIT 12`, { user: u.id, viewer: v.userId });
    return { user: person(u), opted_out: false, episodes: await episodesOut(eps, v.key), topics: tops.map((t) => ({ slug: t.slug, title: t.title, kind: t.kind, takes: Number(t.n), last_seen_at: t.last })),
        lines: await segmentsOut(lines, v.key), crossovers: await segmentsOut(cross, v.key) };
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

// The bar's own module (server/rundown/browse.js) reads with the same rules as the pages: the same visibility
// helpers, the same columns and the same people.
module.exports = { home, lead, streamsFeed, topics, topic, episode, streamer, react, hide, optedOut, setOptOut, trending, voices, onAir, audiencesFor, who, REACTIONS, KINDS, person,
    VISIBLE, AUDIENCE_JOINS, SEGMENT_COLS, EPISODE_COLS, people, segmentsOut, episodesOut };
