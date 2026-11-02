'use strict';
/**
 * The browse tag filters (market outcome 2 in research-2026-10-30/market/outcomes/live.md), backend only.
 *
 * GET /api/streams?tag=…&tag=… narrows the live list to streams carrying ANY of the tags (at most 10, each
 * lowercased/trimmed and 1–32 letters, digits, spaces or dashes; anything else is a 400), ?category= keeps one
 * category (the effective one the API returns: AI's if set), and a request without either is the unchanged list
 * in its own order. A stream's tags are its own plus the AI's (`ai_tags`), normalized and minus the stop list, so
 * an AI-only tag filters too. GET /api/streams/tags lists the tags in use with live/recent counts and where each
 * came from, most live first then most recent, capped at 30 and cached 60 s; only values that pass TAG_FILTER_RE
 * are listed, so every chip can be sent back as ?tag=.
 *
 *   node --import ./test/helpers/pg-preload.mjs test/stream-tag-filters.test.js
 */
const assert = require('assert');
const http = require('http');
const express = require('express');

process.env.NODE_ENV = 'test';
console.warn = () => {};
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };

const db = require('../server/db/database');
const { TAG_FILTER_RE, TAG_STOP_WORDS } = require('../server/streaming/tags');

(async () => {
    await db.initDb();
    const mk = async (username) => {
        await db.createUser({ username, display_name: username, stream_key: username.padEnd(32, '0') });
        return Number((await db.get('SELECT id FROM users WHERE username = ?', [username])).id);
    };
    // UTC text, the format ov_now() writes (migrations/0002_live.sql), so the seven-day window compares as text.
    const ts = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ');
    const DAY = 86400000;
    const stream = async (userId, { live, startedAgo, endedAgo = null, viewers = 0, tags = [], aiTags = [], category = null, aiCategory = null }) => Number((await db.run(
        `INSERT INTO streams (user_id, title, protocol, is_live, viewer_count, category, ai_category, tags, ai_tags, started_at, ended_at, created_at)
         VALUES (?, ?, 'webrtc', ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [userId, `${userId} stream`, live ? 1 : 0, viewers, category, aiCategory,
            typeof tags === 'string' ? tags : JSON.stringify(tags),
            typeof aiTags === 'string' ? aiTags : JSON.stringify(aiTags),
            ts(startedAgo), live ? null : ts(endedAgo === null ? startedAgo : endedAgo), ts(startedAgo)]
    )).lastInsertRowid);

    const alice = await mk('alice'), bob = await mk('bob'), carol = await mk('carol');
    const dave = await mk('dave'), erin = await mk('erin'), frank = await mk('frank');
    // Alice and Bob are live and share gaming; Bob's chosen category is irl but the AI's gaming is what the API
    // returns, so category=gaming includes him and category=irl does not. Carol is music+irl, Dave ended 2 days
    // ago (counts as recent), Erin ended 10 days ago (outside the window), Frank has been live 9 days (live only).
    // The AI adds its own tags: cozy/fortnite/nature/outdoors are useful, overlay/live/stream are stop words, and
    // c++ must never become a chip. Dave has gaming in both columns: one stream, one count, source both.
    await stream(alice, { live: true, startedAgo: 60000, viewers: 50, tags: ['Gaming', 'music'], aiTags: ['cozy', 'live'], category: 'gaming' });
    await stream(bob, { live: true, startedAgo: 300000, viewers: 100, tags: ['gaming'], aiTags: ['fortnite', 'overlay'], category: 'irl', aiCategory: 'gaming' });
    await stream(carol, { live: true, startedAgo: 600000, viewers: 5, tags: ['music', 'irl'], aiTags: ['nature', 'c++'], category: 'music' });
    await stream(dave, { live: false, startedAgo: 2 * DAY, endedAgo: 2 * DAY - 3600000, tags: ['gaming', 'irl'], aiTags: ['cozy', 'stream', 'gaming'], category: 'music' });
    await stream(erin, { live: false, startedAgo: 10 * DAY, endedAgo: 10 * DAY - 3600000, tags: ['retro'], aiTags: ['kitchen'], category: 'music' });
    await stream(frank, { live: true, startedAgo: 9 * DAY, viewers: 2, tags: ['marathon'], aiTags: ['outdoors'], category: 'other' });

    const app = express();
    app.use('/api/streams', require('../server/streaming/routes'));
    const server = await new Promise((resolve) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (path) => {
        const res = await fetch(base + path);
        return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() };
    };
    try {
        // ── The unchanged default ───────────────────────────────
        const all = await get('/api/streams');
        assert.strictEqual(all.status, 200);
        assert.deepStrictEqual(all.body.streams.map((s) => s.username), ['bob', 'alice', 'carol', 'frank'],
            'no filters: every live stream, in the list\'s own order (viewers, then start)');
        assert.deepStrictEqual(all.body.streams.map((s) => s.category), ['gaming', 'gaming', 'music', 'other'],
            'the category returned is the effective one');
        assert.strictEqual(all.body.streams[0].username, 'bob', 'the biggest crowd stays first');

        // ── Tags: one, several, and normalized query values ─────
        const one = await get('/api/streams?tag=gaming');
        assert.strictEqual(one.status, 200);
        assert.deepStrictEqual(one.body.streams.map((s) => s.username), ['bob', 'alice'], 'one tag keeps its streams in order');
        const folded = await get('/api/streams?tag=%20GAMING%20');
        assert.deepStrictEqual(folded.body.streams.map((s) => s.username), ['bob', 'alice'], 'the query is trimmed and lowercased');
        const several = await get('/api/streams?tag=gaming&tag=music');
        assert.deepStrictEqual(several.body.streams.map((s) => s.username), ['bob', 'alice', 'carol'], 'several tags keep ANY of them');
        const overlap = await get('/api/streams?tag=music&tag=irl');
        assert.deepStrictEqual(overlap.body.streams.map((s) => s.username), ['alice', 'carol'], 'a stream is listed once');
        const none = await get('/api/streams?tag=retro');
        assert.deepStrictEqual(none.body.streams, [], 'a tag only on an old stream matches no live stream');

        // ── Tags the AI inferred count and filter too ───────────
        const aiOnly = await get('/api/streams?tag=fortnite');
        assert.strictEqual(aiOnly.status, 200);
        assert.deepStrictEqual(aiOnly.body.streams.map((s) => s.username), ['bob'], 'a tag only in ai_tags matches ?tag=');
        const aiCozy = await get('/api/streams?tag=cozy');
        assert.deepStrictEqual(aiCozy.body.streams.map((s) => s.username), ['alice'], 'an AI tag on an ended stream does not make it live');
        const aiOldLive = await get('/api/streams?tag=outdoors');
        assert.deepStrictEqual(aiOldLive.body.streams.map((s) => s.username), ['frank'], 'a live stream carries its AI tags whatever its start time');
        const stopWord = await get('/api/streams?tag=live');
        assert.deepStrictEqual(stopWord.body.streams, [], 'a stop word matches nothing even though the AI emitted it');
        const outsideWindow = await get('/api/streams?tag=kitchen');
        assert.deepStrictEqual(outsideWindow.body.streams, [], 'an AI tag only on an old stream matches no live stream');

        // ── Category: the effective category, case-folded ───────
        const music = await get('/api/streams?category=music');
        assert.deepStrictEqual(music.body.streams.map((s) => s.username), ['carol'], 'one category');
        const gaming = await get('/api/streams?category=GAMING');
        assert.deepStrictEqual(gaming.body.streams.map((s) => s.username), ['bob', 'alice'], 'category is case-folded');
        const chosenIrl = await get('/api/streams?category=irl');
        assert.deepStrictEqual(chosenIrl.body.streams, [], 'the AI category wins over the chosen one here');
        const combined = await get('/api/streams?tag=music&category=gaming');
        assert.deepStrictEqual(combined.body.streams.map((s) => s.username), ['alice'], 'tag and category narrow together');

        // ── Bad filters are 400s ────────────────────────────────
        for (const path of [
            '/api/streams?tag=lofi_beats',
            '/api/streams?tag=c%2B%2B',
            '/api/streams?tag=',
            '/api/streams?tag=' + 'a'.repeat(33),
            '/api/streams?tag=' + Array.from({ length: 11 }, (_, i) => `t${i}`).join('&tag='),
            '/api/streams?tag=gaming&tag=',
            '/api/streams?tag=gaming&tag=lofi_beats',
            '/api/streams?tag[bad]=1',
            '/api/streams?category=',
            '/api/streams?category[a]=b',
        ]) {
            const bad = await get(path);
            assert.strictEqual(bad.status, 400, `${path} is a 400`);
        }
        const ten = await get('/api/streams?' + Array.from({ length: 10 }, (_, i) => `tag=t${i}`).join('&'));
        assert.strictEqual(ten.status, 200, 'ten tags is the maximum, not one over');
        assert.deepStrictEqual(ten.body.streams, []);

        // ── The tags list: counts, order, source, cache ─────────
        const tags = await get('/api/streams/tags');
        assert.strictEqual(tags.status, 200);
        assert.strictEqual(tags.cache, 'public, max-age=60', 'the list is public and cached for a minute');
        assert.deepStrictEqual(tags.body.tags, [
            { tag: 'gaming', live: 2, recent: 3, source: 'both' },
            { tag: 'music', live: 2, recent: 2, source: 'streamer' },
            { tag: 'cozy', live: 1, recent: 2, source: 'ai' },
            { tag: 'irl', live: 1, recent: 2, source: 'streamer' },
            { tag: 'fortnite', live: 1, recent: 1, source: 'ai' },
            { tag: 'nature', live: 1, recent: 1, source: 'ai' },
            { tag: 'marathon', live: 1, recent: 0, source: 'streamer' },
            { tag: 'outdoors', live: 1, recent: 0, source: 'ai' },
        ], 'own+AI tags, stop words dropped, live/recent counts, source, and the old stream left out');
        assert.ok(!tags.body.tags.some((t) => t.tag === 'c++'), 'an AI tag outside the filter grammar is not listed');
        for (const t of tags.body.tags) {
            assert.ok(TAG_FILTER_RE.test(t.tag), `${t.tag} is filterable`);
            const back = await get(`/api/streams?tag=${encodeURIComponent(t.tag)}`);
            assert.strictEqual(back.status, 200, `every listed tag round-trips as ?tag= (${t.tag})`);
        }

        // The stop list is exported and holds the meta words that say nothing about the stream. It covers
        // the home UI's _TOPIC_STOP (Live #520) too, so the browse chips and the home topics agree.
        const meta = ['live', 'streaming', 'stream', 'livestream', 'chat', 'livechat', 'overlay', 'ui',
            'setup', 'lobby', 'facecam', 'multicam', 'multiframe', 'gameplay', 'commentary', 'surveillance',
            'live stream', 'stream overlay', 'streamer', 'webcam', 'camera', 'screen', 'desktop', 'browser',
            'pc', 'obs'];
        for (const word of meta) assert.ok(TAG_STOP_WORDS.has(word), `${word} is a stop word`);
        for (const word of ['gaming', 'outdoors', 'fortnite', 'cozy', 'music', 'nature']) {
            assert.ok(!TAG_STOP_WORDS.has(word), `${word} is a useful tag`);
        }

        // A malformed tags value is no tags, never a failed list.
        await stream(alice, { live: true, startedAgo: 3 * DAY, viewers: 1, tags: 'not json', aiTags: 'also not json', category: 'other' });
        const still = await get('/api/streams/tags');
        assert.strictEqual(still.status, 200, 'malformed tags/ai_tags JSON does not break the list');
        assert.deepStrictEqual(still.body.tags, tags.body.tags, 'and adds no tag');

        // At most 30, however many tags are in use.
        await stream(bob, { live: true, startedAgo: 60000, viewers: 0, tags: Array.from({ length: 35 }, (_, i) => `cap-${String(i + 1).padStart(2, '0')}`), category: 'other' });
        const capped = await get('/api/streams/tags');
        assert.strictEqual(capped.body.tags.length, 30, 'at most 30 tags');
        assert.strictEqual(new Set(capped.body.tags.map((t) => t.tag)).size, 30, 'no duplicate tags');
        assert.deepStrictEqual(capped.body.tags.slice(0, 3).map((t) => t.tag), ['gaming', 'music', 'cozy'], 'the order survives the cap');
        for (let i = 1; i < capped.body.tags.length; i++) {
            const a = capped.body.tags[i - 1], b = capped.body.tags[i];
            assert.ok(a.live > b.live || (a.live === b.live && a.recent >= b.recent), `${a.tag} sorts before ${b.tag}`);
        }
        console.log('stream-tag-filters: all checks passed');
    } finally { server.close(); }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
