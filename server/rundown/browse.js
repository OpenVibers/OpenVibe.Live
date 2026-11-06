'use strict';
/**
 * The Rundown's bar: what you can search and narrow (design 2026-11-06, section 4; plan-state-2026-10-22/
 * RUNDOWN-CONTROLS-AND-BROWSE-DESIGN-2026-11-06.md).
 *
 * One endpoint answers every view the bar can be in, so the state of a view is one thing (the query string) and the
 * page never has to piece several answers together:
 *
 *   browse(query, { viewer })   the results the filters ask for, the counts, the closest topics when nothing matches
 *   options()                   the lists the pickers show: the streamers who've been talking, the topics
 *
 * The words come from the tsvector columns the search migration fills (migrations/0030_rundown_search.sql): a take's
 * title, what was said, the desk's quip, its quotes and its topic; an episode's title, logline, recap and chapters; a
 * topic's name, headline and summary. A streamer's name is matched by prefix, not by word, so "goos" finds them.
 *
 * Who may see what is the same rule the gathered pages use (server/rundown/read.js): the reader's own items, or items
 * everyone may see. A search never reaches past it.
 */
const db = require('../db/database');
const read = require('./read');

const { VISIBLE, AUDIENCE_JOINS, SEGMENT_COLS, EPISODE_COLS } = read;

const MAX_TAKES = 40;          // how many takes one page of results holds
const MAX_EPISODES = 20;       // how many episodes one page holds
const MAX_TOPICS = 40;         // how many topics one page holds
const EPISODE_TAKES = 24;      // how many takes of an episode are sent, so "More takes (N)" can open in place
const FOLDED = 3;              // how many takes an episode card shows before it folds
const WHENS = { day: 1, week: 7, month: 30 };
const SHOWS = ['takes', 'episodes', 'topics'];
const SORTS = ['newest', 'reacted', 'takes'];
const ORDER = ['q', 'streamer', 'topic', 'when', 'show', 'sort', 'video', 'following', 'mentions'];

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 19).replace('T', ' ');
const truthy = (v) => v === '1' || v === 'true' || v === 'yes';

/**
 * The bar's state, read from the query string: what was searched, which streamers, which topic, when, what the
 * results are, how they are sorted, and the three switches. Anything unknown is dropped, so a hand-made URL never
 * reaches the database as SQL.
 */
function parse(query = {}) {
    const one = (v) => String(v == null ? '' : v).trim();
    const q = one(query.q).slice(0, 120);
    const streamer = one(query.streamer).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 8);
    const topic = one(query.topic).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 80);
    const when = Object.prototype.hasOwnProperty.call(WHENS, one(query.when).toLowerCase()) ? one(query.when).toLowerCase() : null;
    const show = SHOWS.includes(one(query.show).toLowerCase()) ? one(query.show).toLowerCase() : null;
    const sort = SORTS.includes(one(query.sort).toLowerCase()) ? one(query.sort).toLowerCase() : 'newest';
    return {
        q, streamer, topic, when, show, sort,
        video: truthy(one(query.video)),
        following: truthy(one(query.following)),
        mentions: truthy(one(query.mentions)),
        kind: one(query.kind).toLowerCase().slice(0, 20),
    };
}

/** Is anything narrowed? An empty bar is the plain page, and it is the only one a crawler should keep. */
function isFiltered(st) {
    return !!(st.q || st.streamer.length || st.topic || st.when || st.show || st.sort !== 'newest' || st.video || st.following || st.mentions || st.kind);
}

/** The names of the filters that are on, in the order the bar shows them. */
function activeKeys(st) {
    const keys = [];
    if (st.q) keys.push('q');
    if (st.streamer.length) keys.push('streamer');
    if (st.topic) keys.push('topic');
    if (st.when) keys.push('when');
    if (st.show) keys.push('show');
    if (st.sort !== 'newest') keys.push('sort');
    if (st.video) keys.push('video');
    if (st.following) keys.push('following');
    if (st.mentions) keys.push('mentions');
    if (st.kind) keys.push('kind');
    return keys;
}

/** LIKE with the user's own % and _ kept as text. */
const likeArg = (s) => String(s || '').toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c);

/** The accounts a search names by prefix ("goos" finds goosely). */
async function prefixUsers(q) {
    if (!q) return [];
    const like = likeArg(q) + '%';
    const rows = await db.all('SELECT id FROM users WHERE lower(username) LIKE ? ESCAPE \'\\\' OR lower(display_name) LIKE ? ESCAPE \'\\\' LIMIT 12', [like, like]);
    return rows.map((r) => Number(r.id));
}

/** The accounts the streamer filter names. */
async function userIds(usernames) {
    if (!usernames || !usernames.length) return [];
    const rows = await db.all('SELECT id FROM users WHERE lower(username) = ANY(?)', [usernames.map((u) => String(u).toLowerCase())]);
    return rows.map((r) => Number(r.id));
}

/** The topic the topic filter names. */
async function topicIdOf(slug) {
    if (!slug) return null;
    const row = await db.get("SELECT id FROM rundown_topics WHERE slug = ? AND status = 'live'", [slug]);
    return row ? Number(row.id) : null;
}

/**
 * The filters, as SQL, for the takes. Every part is a named parameter; the only text that reaches the database as
 * SQL is the sort, which is one of three fixed words.
 */
function takeFilters(st, { users, topicId, prefix, viewer }) {
    const where = ["s.status = 'live'", VISIBLE('s')];
    const params = { viewer: viewer == null ? null : Number(viewer) };
    if (st.q) {
        where.push("(s.search_tsv @@ websearch_to_tsquery('english', @q) OR s.user_id = ANY(@prefix))");
        params.q = st.q;
        params.prefix = prefix;
    }
    if (users && users.length) { where.push('s.user_id = ANY(@users)'); params.users = users; }
    if (topicId) { where.push('s.topic_id = @topic'); params.topic = topicId; }
    if (st.when) { where.push('s.said_at >= @since'); params.since = daysAgo(WHENS[st.when]); }
    if (st.video) where.push('s.vod_id IS NOT NULL');
    if (st.mentions && params.viewer != null) where.push('@viewer = ANY(s.mentions)');
    if (st.following && params.viewer != null) where.push('s.user_id IN (SELECT streamer_id FROM follows WHERE follower_id = @viewer)');
    return { where: where.join(' AND '), params };
}

/** The filters, as SQL, for the episodes. A topic filter asks for the episodes that have a take on it. */
function episodeFilters(st, { users, topicId, prefix, viewer }) {
    const where = ["r.status = 'live'", VISIBLE('r')];
    const params = { viewer: viewer == null ? null : Number(viewer) };
    if (st.q) {
        where.push("(r.search_tsv @@ websearch_to_tsquery('english', @q) OR r.user_id = ANY(@prefix))");
        params.q = st.q;
        params.prefix = prefix;
    }
    if (users && users.length) { where.push('r.user_id = ANY(@users)'); params.users = users; }
    if (topicId) { where.push('EXISTS (SELECT 1 FROM rundown_segments s2 WHERE s2.stream_id = r.stream_id AND s2.topic_id = @topic AND s2.status = \'live\')'); params.topic = topicId; }
    if (st.when) { where.push('r.aired_at >= @since'); params.since = daysAgo(WHENS[st.when]); }
    if (st.video) where.push('r.vod_id IS NOT NULL');
    if (st.following && params.viewer != null) where.push('r.user_id IN (SELECT streamer_id FROM follows WHERE follower_id = @viewer)');
    return { where: where.join(' AND '), params };
}

/** The filters, as SQL, for the topics. A topic is only there when a take everyone may see is on it. */
function topicFilters(st, { users, prefix, viewer }) {
    const where = ["t.status = 'live'", VISIBLE('s')];
    const params = { viewer: viewer == null ? null : Number(viewer) };
    if (st.q) {
        where.push("(t.search_tsv @@ websearch_to_tsquery('english', @q) OR s.user_id = ANY(@prefix))");
        params.q = st.q;
        params.prefix = prefix;
    }
    if (users && users.length) { where.push('s.user_id = ANY(@users)'); params.users = users; }
    if (st.when) { where.push('s.said_at >= @since'); params.since = daysAgo(WHENS[st.when]); }
    if (st.kind) { where.push('t.kind = @kind'); params.kind = st.kind; }
    if (st.following && params.viewer != null) where.push('s.user_id IN (SELECT streamer_id FROM follows WHERE follower_id = @viewer)');
    return { where: where.join(' AND '), params };
}

/** The takes, the episodes and the topics the filters ask for, and how many of each there are. */
async function results(st, { users, topicId, prefix, viewer }) {
    const tf = takeFilters(st, { users, topicId, prefix, viewer });
    const ef = episodeFilters(st, { users, topicId, prefix, viewer });
    const topf = topicFilters(st, { users, prefix, viewer });

    const takeOrder = st.sort === 'reacted' ? 'reacts DESC, s.said_at DESC' : 's.said_at DESC, s.id DESC';
    const takeRows = await db.all(`SELECT ${SEGMENT_COLS}, COALESCE(rx.n, 0) AS reacts FROM rundown_segments s
        ${AUDIENCE_JOINS('s')} LEFT JOIN (SELECT item_id, COUNT(*) AS n FROM rundown_reactions WHERE item_type = 'segment' GROUP BY item_id) rx ON rx.item_id = s.id
        WHERE ${tf.where} ORDER BY ${takeOrder} LIMIT ${MAX_TAKES}`, tf.params);

    const epOrder = st.sort === 'reacted' ? 'reacts DESC, r.aired_at DESC' : 'r.aired_at DESC';
    const epRows = await db.all(`SELECT ${EPISODE_COLS}, COALESCE(rx.n, 0) AS reacts FROM rundown_episodes r
        ${AUDIENCE_JOINS('r')} LEFT JOIN (SELECT item_id, COUNT(*) AS n FROM rundown_reactions WHERE item_type = 'episode' GROUP BY item_id) rx ON rx.item_id = r.stream_id
        WHERE ${ef.where} ORDER BY ${epOrder} LIMIT ${MAX_EPISODES}`, ef.params);

    const topOrder = st.sort === 'takes' || st.sort === 'reacted' ? 'takes DESC, last_seen_at DESC' : 'last_seen_at DESC';
    const topRows = await db.all(`SELECT t.id, t.slug, t.title, t.kind, t.headline, t.summary, t.first_seen_at, t.last_seen_at,
            COUNT(s.id) AS takes, COUNT(DISTINCT s.user_id) AS streamers, array_agg(DISTINCT s.user_id) AS users
        FROM rundown_topics t JOIN rundown_segments s ON s.topic_id = t.id AND s.status = 'live' ${AUDIENCE_JOINS('s')}
        WHERE ${topf.where} GROUP BY t.id ORDER BY ${topOrder} LIMIT ${MAX_TOPICS}`, topf.params);

    return { takeRows, epRows, topRows, tf, ef, topf };
}

/** How many of each there are: the count line says "34 takes from 6 streamers". */
async function counts(st, { users, topicId, prefix, viewer }) {
    const tf = takeFilters(st, { users, topicId, prefix, viewer });
    const ef = episodeFilters(st, { users, topicId, prefix, viewer });
    const topf = topicFilters(st, { users, prefix, viewer });
    const t = await db.get(`SELECT COUNT(*) AS n, COUNT(DISTINCT s.user_id) AS people FROM rundown_segments s ${AUDIENCE_JOINS('s')} WHERE ${tf.where}`, tf.params);
    const e = await db.get(`SELECT COUNT(*) AS n, COUNT(DISTINCT r.user_id) AS people FROM rundown_episodes r ${AUDIENCE_JOINS('r')} WHERE ${ef.where}`, ef.params);
    const p = await db.get(`SELECT COUNT(DISTINCT t.id) AS n FROM rundown_topics t JOIN rundown_segments s ON s.topic_id = t.id AND s.status = 'live' ${AUDIENCE_JOINS('s')} WHERE ${topf.where}`, topf.params);
    return { takes: Number(t.n), take_people: Number(t.people), episodes: Number(e.n), episode_people: Number(e.people), topics: Number(p.n) };
}

/** The topics whose names are closest to what was searched: the way out of an empty search. */
async function closestTopics(st, { topicId }) {
    const rows = await db.all("SELECT slug, title, kind, takes FROM rundown_topics WHERE status = 'live' ORDER BY last_seen_at DESC LIMIT 200");
    const words = new Set(String(st.q || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
    const scored = rows.map((r) => {
        const title = String(r.title || '').toLowerCase();
        let score = 0;
        for (const w of words) if (title.includes(w)) score += 1;
        if (st.topic && r.slug === st.topic) score += 10;
        return { ...r, score };
    }).filter((r) => r.score > 0);
    const best = (scored.length ? scored : rows.map((r) => ({ ...r, score: 0 })))
        .sort((a, b) => b.score - a.score || Number(b.takes) - Number(a.takes))
        .slice(0, 6);
    return best.map((r) => ({ slug: r.slug, title: r.title, kind: r.kind, takes: Number(r.takes) }));
}

/**
 * The bar's answer: what the filters ask for. The counts are always there (the count line), the results are what the
 * Show chip asks for, and when nothing matches the page is told which filter to drop and which topics are closest.
 */
async function browse(query = {}, { viewer = null } = {}) {
    const st = parse(query);
    const v = read.who(viewer);
    const users = await userIds(st.streamer);
    const topicId = await topicIdOf(st.topic);
    const prefix = await prefixUsers(st.q);

    const r = await results(st, { users, topicId, prefix, viewer: v.userId });
    const c = await counts(st, { users, topicId, prefix, viewer: v.userId });

    const takes = await read.segmentsOut(r.takeRows, v.key);
    const episodes = await read.episodesOut(r.epRows, v.key);
    const topicPeople = await read.people(r.topRows.flatMap((t) => (t.users || []).slice(0, 4)));
    const topics = r.topRows.map((t) => ({
        slug: t.slug, title: t.title, kind: t.kind, headline: t.headline || null, summary: t.summary || null,
        takes: Number(t.takes), streamers: Number(t.streamers),
        first_seen_at: t.first_seen_at, last_seen_at: t.last_seen_at,
        people: (t.users || []).slice(0, 4).map((id) => topicPeople.get(Number(id))).filter(Boolean),
    }));

    // The takes of the episodes on this page: an episode card is folded to its top ones, and the rest is sent so
    // "More takes (N)" can open in place, without asking the server again.
    const epIds = r.epRows.map((e) => Number(e.stream_id));
    let epTakes = new Map();
    if (epIds.length) {
        const rows = await db.all(`SELECT ${SEGMENT_COLS}, ROW_NUMBER() OVER (PARTITION BY s.stream_id ORDER BY s.score DESC, s.said_at DESC) AS rn
            FROM rundown_segments s WHERE s.stream_id = ANY(@ids) AND s.status = 'live' ORDER BY s.stream_id, s.score DESC, s.said_at DESC`, { ids: epIds });
        const keep = rows.filter((x) => Number(x.rn) <= EPISODE_TAKES);
        const shaped = await read.segmentsOut(keep, v.key);
        for (const s of shaped) { const l = epTakes.get(s.stream_id) || []; l.push(s); epTakes.set(s.stream_id, l); }
    }
    const totals = new Map();
    if (epIds.length) {
        for (const row of await db.all("SELECT stream_id, COUNT(*) AS n FROM rundown_segments WHERE stream_id = ANY(?) AND status = 'live' GROUP BY stream_id", [epIds])) totals.set(Number(row.stream_id), Number(row.n));
    }

    // The people a search named by prefix: the streamers the words could have meant.
    const named = prefix.length ? await read.people(prefix) : new Map();

    const empty = st.show === 'topics' ? c.topics === 0 : (st.show === 'episodes' ? c.episodes === 0 : (st.show === 'takes' ? c.takes === 0 : (c.takes === 0 && c.episodes === 0)));
    let suggestion = null;
    if (empty) {
        const drop = await bestDrop(st, { prefix, viewer: v.userId });
        suggestion = { drop, topics: await closestTopics(st, { topicId }) };
    }

    // The Show chip asks for one kind of result: the others are counted (the count line needs them) but not sent.
    const show = st.show;
    const withTakes = (e) => ({ ...e, takes: epTakes.get(e.stream_id) || [], takes_total: totals.get(e.stream_id) || 0, folded: FOLDED });
    return {
        filters: st,
        active: activeKeys(st),
        counts: c,
        takes: show === 'episodes' || show === 'topics' ? [] : takes,
        episodes: show === 'takes' || show === 'topics' ? [] : episodes.map(withTakes),
        topics: show === 'topics' ? topics : [],
        streamers: [...named.values()].filter(Boolean),
        suggestion,
        on_air: await read.onAir(),
        trending: await read.trending(),
        voices: await read.voices(),
    };
}

/**
 * Which filter to drop when nothing matches: the one whose removal brings the most back. The page offers it as
 * "drop the last filter", because that is the one a reader least wants to keep.
 */
async function bestDrop(st, { prefix, viewer }) {
    const keys = activeKeys(st);
    if (!keys.length) return null;
    let best = null;
    for (const key of keys) {
        const without = { ...st };
        if (key === 'q') without.q = '';
        else if (key === 'streamer') without.streamer = [];
        else if (key === 'topic') without.topic = '';
        else if (key === 'when') without.when = null;
        else if (key === 'show') without.show = null;
        else if (key === 'sort') without.sort = 'newest';
        else if (key === 'video') without.video = false;
        else if (key === 'following') without.following = false;
        else if (key === 'mentions') without.mentions = false;
        else if (key === 'kind') without.kind = '';
        // The names and the topic of the state without this filter are the state's own: dropping a streamer
        // filter means the takes of every streamer again.
        const users = await userIds(without.streamer);
        const topicId = await topicIdOf(without.topic);
        const c = await counts(without, { users, topicId, prefix, viewer });
        const n = without.show === 'topics' ? c.topics : (without.show === 'episodes' ? c.episodes : c.takes + c.episodes);
        if (!best || n > best.n) best = { key, n };
    }
    return best && best.n > 0 ? best.key : null;
}

/**
 * The lists the pickers show: the streamers who have been talking (with their avatars) and the topics, trending
 * first. The pickers search inside these, so they are one answer and not a question per keystroke.
 */
async function options() {
    const rows = await db.all(`SELECT s.user_id, COUNT(*) AS takes, MAX(s.said_at) AS last_at FROM rundown_segments s ${AUDIENCE_JOINS('s')}
        WHERE s.status = 'live' AND s.said_at >= @since AND ${VISIBLE('s')} GROUP BY s.user_id ORDER BY COUNT(*) DESC, MAX(s.said_at) DESC LIMIT 60`,
    { since: daysAgo(30), viewer: null });
    const ppl = await read.people(rows.map((r) => r.user_id));
    const trending = await read.trending(12, 7);
    const rest = await read.topics({ limit: 120 });
    const seen = new Set(trending.map((t) => t.slug));
    const topics = [...trending.map((t) => ({ slug: t.slug, title: t.title, kind: t.kind, takes: t.takes, trending: true })),
        ...rest.topics.filter((t) => !seen.has(t.slug)).map((t) => ({ slug: t.slug, title: t.title, kind: t.kind, takes: t.takes, trending: false }))];
    return {
        streamers: rows.map((r) => ({ user: ppl.get(Number(r.user_id)) || null, takes: Number(r.takes), last_at: r.last_at })).filter((s) => s.user),
        topics,
        kinds: read.KINDS,
    };
}

module.exports = { browse, options, parse, isFiltered, activeKeys, ORDER };
