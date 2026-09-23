/**
 * The Content (people's work) and Moments (AI's) feeds: GET /api/content/feed and /api/content/moments
 * (server/content/feed.js), against in-process stand-ins for OpenVibe.Media and OpenVibe.Community.
 *
 * Checks: who made what is decided by the stores (Media's auto_generated, Community's origin; AI
 * recaps are Live's own), and each feed shows only its kind even when an upstream ignores the
 * filter; private, unlisted, burn-after-read and banned accounts' items never appear, and nothing
 * asks for hidden items; cursor paging walks the merged order exactly (New and Top, with a fixed
 * window); a slow upstream is left out within the deadline and asked again on the next page; pages
 * are cached; the answer's shape is the allow-listed one; and the auto-clip flag sync marks only
 * the AI's own clips in Media.
 *
 *   node test/content-feed.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = path.join(os.tmpdir(), `ov-content-feed-${process.pid}.db`);
process.env.DB_PATH = tmp;
process.env.NODE_ENV = 'test';
process.env.PASTES_AUTHORITY = 'community';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

const db = require('../server/db/database');
db.initDb();
const raw = db.getDb();
const addUser = (id, username, banned = 0) => raw.prepare(
    `INSERT INTO users (id, username, display_name, email, password_hash, role, is_banned, avatar_url, created_at)
     VALUES (?, ?, ?, ?, 'x', 'streamer', ?, ?, '2025-01-01 00:00:00')`).run(id, username, username.toUpperCase(), `${username}@x`, banned, `https://media.test/a/${username}.png`);
addUser(3, 'alice');
addUser(4, 'bob');
addUser(9, 'banned', 1);
db.ensureChannel(3);
const chan = db.getChannelByUserId(3);
const streamId = Number(db.createStream({ user_id: 3, channel_id: chan.id, title: 'Night stream', protocol: 'rtmp' }).lastInsertRowid);
db.endStream(streamId);

const MIN = 60_000;
const at = (minsAgo) => new Date(Date.now() - minsAgo * MIN).toISOString().replace('T', ' ').slice(0, 19);

// ── OpenVibe.Media stand-in ──
const media = require('../server/media-client');
const asked = [];
let mediaMode = 'ok';          // 'ok' | 'stall' | 'down' | 'ignore-filters'
let VODS = [], CLIPS = [];
const vod = (id, mins, extra = {}) => ({ id, user_id: 3, title: `VOD ${id}`, visibility: 'public', is_public: true, status: 'ready', duration_seconds: 600, view_count: 0, created_at: at(mins), thumbnail_url: `/t/vod-${id}.jpg`, file_path: `vod-${id}.webm`, storage_key: 'secret/key', ...extra });
const clip = (id, mins, extra = {}) => ({ id, user_id: 4, channel_user_id: 3, vod_id: 1, title: `Clip ${id}`, visibility: 'public', is_public: true, status: 'ready', auto_generated: false, duration_seconds: 20, view_count: 0, created_at: at(mins), thumbnail_url: `/t/clip-${id}.jpg`, playback_url: `https://media.test/c/${id}`, file_path: `clip-${id}.webm`, ...extra });
VODS = [
    vod(1, 10, { view_count: 50 }), vod(2, 30, { view_count: 5 }), vod(3, 50, { view_count: 500 }), vod(4, 70),
    vod(5, 90, { visibility: 'private', is_public: false, title: 'SECRET VOD' }),
    vod(6, 95, { visibility: 'unlisted', is_public: false, title: 'UNLISTED VOD' }),
    vod(7, 100, { user_id: 9, title: 'Banned streamer VOD' }),
    vod(8, 60 * 24 * 20, { view_count: 9000, title: 'Old popular VOD' }),     // 20 days ago
];
CLIPS = [
    clip(11, 5, { view_count: 30 }), clip(12, 25), clip(13, 45, { view_count: 300 }),
    clip(14, 15, { auto_generated: true, user_id: 3, title: 'AI clip A', view_count: 7 }),
    clip(15, 35, { auto_generated: true, user_id: 3, title: 'AI clip B' }),
    clip(16, 40, { visibility: 'private', is_public: false, title: 'SECRET CLIP' }),
    clip(17, 42, { status: 'failed', title: 'Failed cut' }),
    clip(18, 44, { auto_generated: true, user_id: 3, visibility: 'private', is_public: false, title: 'SECRET AI CLIP' }),
];
const since = (row, q) => !q.since || new Date(row.created_at.replace(' ', 'T') + 'Z') >= new Date(q.since.replace(' ', 'T') + 'Z');
const order = (rows, q) => rows.sort((a, b) => (q.order === 'views' ? (b.view_count - a.view_count) : 0) || (b.created_at < a.created_at ? -1 : b.created_at > a.created_at ? 1 : 0));
const gate = async () => {
    if (mediaMode === 'stall') await new Promise((r) => setTimeout(r, 6000));
    if (mediaMode === 'down') throw new media.MediaApiError('Media unreachable', 0);
};
media.listVods = async (q = {}) => {
    asked.push({ kind: 'vods', ...q });
    await gate();
    const leaky = mediaMode === 'ignore-filters';
    const rows = order(VODS.filter((v) => leaky || ((q.include_private || v.is_public) && since(v, q))), q);
    return { vods: rows.slice(q.offset || 0, (q.offset || 0) + (q.limit || 50)), total: rows.length };
};
media.listClips = async (q = {}) => {
    asked.push({ kind: 'clips', ...q });
    await gate();
    const leaky = mediaMode === 'ignore-filters';
    const rows = order(CLIPS.filter((c) => leaky || ((q.include_private || c.is_public) && since(c, q)
        && (q.auto_generated == null || Number(c.auto_generated) === Number(q.auto_generated))
        && (q.status !== 'ready' || c.status === 'ready'))), q);
    return { clips: rows.slice(q.offset || 0, (q.offset || 0) + (q.limit || 50)), total: rows.length };
};

// ── OpenVibe.Community stand-in ──
const pastesClient = require('../server/pastes-client');
const paste = (slug, mins, extra = {}) => ({ id: slug.length, slug, origin: 'user', type: 'paste', title: `Paste ${slug}`, content: `print("${slug}")`, language: 'python', visibility: 'public', burn_after_read: false, views: 0, likes: 0, username: 'bob', display_name: 'Bob', avatar_url: 'https://media.test/a/bob.png', owner_subject: 'usr_bob', created_at: at(mins), ...extra });
const PASTES = [
    paste('p-one', 8, { likes: 20 }), paste('p-two', 28), paste('p-three', 48, { views: 10 }),
    paste('p-private', 12, { visibility: 'private', title: 'SECRET PASTE' }),
    paste('p-burn', 14, { burn_after_read: true, title: 'BURN PASTE' }),
    paste('p-banned', 16, { username: 'banned', title: 'Banned author paste' }),
    paste('ai-shot', 20, { origin: 'ai', type: 'screenshot', title: 'AI shot', content: 'long text', username: null, display_name: 'OpenVibe AI', owner_subject: null, stream_id: streamId, screenshot_url: 'https://media.test/f/s.jpg', ai_summary: 'Everyone laughed', metadata: JSON.stringify({ ai_moment: true, vod_link: '/vod/1?t=42', username: 'alice' }) }),
    paste('ai-live', 38, { origin: 'ai', type: 'screenshot', title: 'Caught live', username: null, owner_subject: null, stream_id: streamId, screenshot_url: 'https://media.test/f/l.jpg', metadata: JSON.stringify({ ai_moment: true, live: true, vod_link: 'javascript:alert(1)' }) }),
];
let communityMode = 'ok';
const communityCalls = [];
pastesClient.request = async (method, p, { query = {}, act = {} } = {}) => {
    communityCalls.push({ method, path: p, query, act });
    if (communityMode === 'down') throw Object.assign(new Error('down'), { status: 502 });
    if (communityMode === 'lying-total') return { pastes: [], total: 999 };
    const leaky = communityMode === 'ignore-filters';
    const rows = PASTES.filter((x) => leaky || (x.visibility === 'public' && !x.burn_after_read && (!query.origin || x.origin === query.origin) && since(x, query)))
        .sort((a, b) => (query.sort === 'top' ? (b.views + 5 * b.likes) - (a.views + 5 * a.likes) : 0) || (b.created_at < a.created_at ? -1 : b.created_at > a.created_at ? 1 : 0));
    const off = Number(query.offset) || 0;
    return { pastes: rows.slice(off, off + (Number(query.limit) || 50)), total: rows.length };
};

// ── Live's own AI recaps ──
require('../server/recap/recap').ensureTable();
const recapJson = (headline, peak) => JSON.stringify({ stream: { id: streamId, title: 'Night stream', duration_seconds: 3600, peak_viewers: peak }, write: { headline, summary: 'A good night.', grade: 'A' }, vod: { id: 1, thumbnail_url: 'https://media.test/t/vod-1.jpg' } });
raw.prepare('INSERT INTO stream_recaps (stream_id, user_id, json, ai, created_at) VALUES (?, 3, ?, 1, ?)').run(streamId, recapJson('What a night', 12), at(33));
raw.prepare('INSERT INTO stream_recaps (stream_id, user_id, json, ai, created_at) VALUES (?, 3, ?, 0, ?)').run(streamId + 1000, recapJson('Template recap', 99), at(3));

const feed = require('../server/content/feed');
const { findSecrets } = require('../server/web/serializers');
const express = require('express');
const app = express();
app.use('/api/content', require('../server/content/routes'));
const server = http.createServer(app).listen(0);
function get(p) {
    return new Promise((resolve, reject) => {
        http.get({ port: server.address().port, path: p }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode, headers: res.headers, json }); });
        }).on('error', reject);
    });
}
async function walk(base, limit) {
    const keys = [];
    let cursor = null, pages = 0;
    do {
        const r = await get(`${base}${base.includes('?') ? '&' : '?'}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        keys.push(...r.json.items.map((i) => i.key));
        cursor = r.json.next;
        assert.ok(++pages < 50, 'paging never ends');
    } while (cursor);
    return keys;
}

let failures = 0;
async function check(name, fn) {
    feed._reset();
    asked.length = 0; communityCalls.length = 0;
    mediaMode = 'ok'; communityMode = 'ok';
    try { await fn(); quiet(`  ok - ${name}`); }
    catch (e) { failures++; quiet(`  FAIL - ${name}\n    ${e.stack.split('\n').slice(0, 4).join('\n    ')}`); }
}

server.on('listening', async () => {
    await check('Content lists people\'s work only; the stores are asked for it by name', async () => {
        const r = await get('/api/content/feed?limit=30');
        assert.strictEqual(r.status, 200);
        const keys = r.json.items.map((i) => i.key);
        assert.deepStrictEqual(keys, ['clip:11', 'paste:p-one', 'vod:1', 'clip:12', 'paste:p-two', 'vod:2', 'clip:13', 'paste:p-three', 'vod:3', 'vod:4', 'vod:8']);
        assert.ok(r.json.items.every((i) => i.ai === false), 'nothing on Content is marked AI');
        const clipAsks = asked.filter((a) => a.kind === 'clips');
        assert.ok(clipAsks.length && clipAsks.every((a) => a.auto_generated === 0 && a.status === 'ready'), 'Media is asked for people\'s playable clips');
        assert.ok(communityCalls.every((c) => c.query.origin === 'user' && String(c.query.pinned_first) === '0'), 'Community is asked for people\'s pastes, pinned in date order');
        assert.deepStrictEqual(r.json.sources, { vods: 'ok', clips: 'ok', pastes: 'ok' });
        assert.strictEqual(r.json.partial, false);
        assert.strictEqual(r.json.next, null, 'everything fit on one page');
    });

    await check('Moments lists the AI\'s work only: auto-clips, AI pastes and AI-written recaps, each labelled', async () => {
        const r = await get('/api/content/moments?limit=30');
        assert.strictEqual(r.status, 200);
        const byKey = Object.fromEntries(r.json.items.map((i) => [i.key, i]));
        assert.deepStrictEqual(r.json.items.map((i) => i.key), ['clip:14', 'paste:ai-shot', 'recap:' + streamId, 'clip:15', 'paste:ai-live']);
        assert.ok(r.json.items.every((i) => i.ai === true && i.ai_label), 'every Moments card says it is AI');
        assert.strictEqual(byKey['paste:ai-shot'].ai_label, 'AI moment');
        assert.strictEqual(byKey['paste:ai-shot'].moment_href, '/vod/1?t=42');
        assert.strictEqual(byKey['paste:ai-shot'].channel.username, 'alice', 'an AI paste belongs to the stream it came from');
        assert.strictEqual(byKey['paste:ai-live'].ai_label, 'Caught live');
        assert.strictEqual(byKey['paste:ai-live'].moment_href, null, 'only a /vod/<id>?t= link is passed on');
        assert.strictEqual(byKey['clip:14'].ai_label, 'Auto-clip');
        assert.strictEqual(byKey['recap:' + streamId].href, `/recap/${streamId}`);
        assert.ok(!r.json.items.some((i) => /Template recap/.test(i.title)), 'a template recap is not AI content');
        assert.ok(asked.filter((a) => a.kind === 'clips').every((a) => a.auto_generated === 1));
        assert.ok(communityCalls.every((c) => c.query.origin === 'ai'));
        assert.ok(!asked.some((a) => a.kind === 'vods'), 'VODs are never AI content');
    });

    await check('an upstream that ignores the filters still cannot mix the feeds or leak hidden items', async () => {
        mediaMode = 'ignore-filters'; communityMode = 'ignore-filters';
        const content = await get('/api/content/feed?limit=30');
        const moments = await get('/api/content/moments?limit=30');
        const all = [...content.json.items, ...moments.json.items];
        const text = JSON.stringify(all);
        for (const secret of ['SECRET', 'UNLISTED', 'BURN PASTE', 'Banned', 'Failed cut']) assert.ok(!text.includes(secret), `${secret} leaked`);
        assert.ok(content.json.items.every((i) => !i.ai) && moments.json.items.every((i) => i.ai));
        assert.ok(!content.json.items.some((i) => i.key === 'clip:14' || i.key === 'paste:ai-shot'));
        assert.ok(!moments.json.items.some((i) => i.key === 'clip:11' || i.key === 'paste:p-one'));
    });

    await check('privacy: nothing asks for hidden items; answers carry only the public card fields', async () => {
        await get('/api/content/feed?limit=30');
        await get('/api/content/moments?limit=30');
        assert.ok(asked.every((a) => !a.include_private && !a.include_unlisted), 'no include_private/include_unlisted upstream');
        assert.ok(communityCalls.every((c) => !c.query.include_unlisted && !c.act.staff && c.act.liveUserId == null), 'Community is read as nobody in particular');
        const r = await get('/api/content/feed?limit=30');
        assert.deepStrictEqual(findSecrets(r.json), []);
        const allowed = new Set(['key', 'kind', 'id', 'href', 'title', 'created_at', 'views', 'likes', 'duration_seconds', 'thumbnail_url', 'preview_url', 'image_url', 'excerpt', 'paste_type', 'language', 'nsfw', 'ai', 'ai_label', 'moment_href', 'grade', 'stream_title', 'channel', 'by']);
        for (const it of r.json.items) for (const k of Object.keys(it)) assert.ok(allowed.has(k), `unexpected field ${k} on ${it.key}`);
        const v1 = r.json.items.find((i) => i.key === 'vod:1');
        assert.strictEqual(v1.thumbnail_url, `${media.MEDIA_PUBLIC_URL}/t/vod-1.jpg`, 'Media paths become absolute');
        assert.deepStrictEqual(v1.channel, { username: 'alice', display_name: 'ALICE', avatar_url: 'https://media.test/a/alice.png', profile_color: '#8b5cf6', href: '/@alice' });
        assert.ok(!('file_path' in v1) && !('storage_key' in v1));
        const c11 = r.json.items.find((i) => i.key === 'clip:11');
        assert.strictEqual(c11.channel.username, 'alice', 'a clip belongs to the clipped channel');
        assert.strictEqual(c11.by.username, 'bob', 'and names who clipped it');
        assert.strictEqual(c11.preview_url, 'https://media.test/c/11');
        assert.match(r.headers['cache-control'], /public, max-age=\d+/);
    });

    await check('cursor paging walks the merged New order exactly, every page size', async () => {
        const full = (await get('/api/content/feed?limit=30')).json.items.map((i) => i.key);
        for (const size of [1, 2, 3, 5]) {
            feed._reset();
            assert.deepStrictEqual(await walk('/api/content/feed', size), full, `limit=${size}`);
        }
        const moments = (await get('/api/content/moments?limit=30')).json.items.map((i) => i.key);
        assert.deepStrictEqual(await walk('/api/content/moments', 2), moments);
    });

    await check('Top ranks by score inside a fixed window, and pages the same way', async () => {
        const r = await get('/api/content/feed?sort=top&window=week&limit=30');
        assert.strictEqual(r.status, 200);
        const keys = r.json.items.map((i) => i.key);
        assert.deepStrictEqual(keys.slice(0, 3), ['vod:3', 'clip:13', 'paste:p-one'], 'views, a paste like worth five');
        assert.ok(!keys.includes('vod:8'), 'the 20-day-old VOD is outside the week');
        const sinces = new Set([...asked.map((a) => a.since), ...communityCalls.map((c) => c.query.since)]);
        assert.strictEqual(sinces.size, 1, 'every source gets the same window');
        const s = [...sinces][0];
        assert.match(s, /^\d{4}-\d{2}-\d{2} \d{2}:00:00$/, 'the window starts on the hour');
        assert.ok(Math.abs(Date.parse(s.replace(' ', 'T') + 'Z') - (Date.now() - 7 * 86400_000)) < 3600_000 + 5000);
        feed._reset();
        assert.deepStrictEqual(await walk('/api/content/feed?sort=top&window=week', 2), keys);
        const allTime = await get('/api/content/feed?sort=top&window=all&limit=30');
        assert.strictEqual(allTime.json.items[0].key, 'vod:8', 'all time has no window');
    });

    await check('the window stays put across pages (it travels in the cursor)', async () => {
        const first = await get('/api/content/feed?sort=top&window=month&limit=2');
        const c = JSON.parse(Buffer.from(first.json.next, 'base64url').toString());
        c.s = '2026-01-01 00:00:00';
        const forged = Buffer.from(JSON.stringify(c)).toString('base64url');
        asked.length = 0;
        await get(`/api/content/feed?sort=top&window=month&limit=2&cursor=${forged}`);
        assert.ok(asked.length && asked.every((a) => a.since === '2026-01-01 00:00:00'), 'the next page asks for the same window');
    });

    await check('filters read only their sources', async () => {
        const vods = await get('/api/content/feed?type=vods&limit=30');
        assert.ok(vods.json.items.every((i) => i.kind === 'vod'));
        assert.deepStrictEqual(Object.keys(vods.json.sources), ['vods']);
        assert.strictEqual(communityCalls.length, 0);
        const shots = await get('/api/content/moments?type=shots');
        assert.deepStrictEqual(shots.json.items.map((i) => i.key), ['paste:ai-shot', 'paste:ai-live']);
        const recaps = await get('/api/content/moments?type=recaps');
        assert.deepStrictEqual(recaps.json.items.map((i) => i.kind), ['recap']);
    });

    await check('bad requests are 400: unknown type/sort/window, a cursor from another feed or damaged', async () => {
        assert.strictEqual((await get('/api/content/feed?type=recaps')).status, 400);
        assert.strictEqual((await get('/api/content/feed?sort=hot')).status, 400);
        assert.strictEqual((await get('/api/content/feed?sort=top&window=decade')).status, 400);
        const other = (await get('/api/content/moments?limit=1')).json.next;
        assert.ok(other);
        assert.strictEqual((await get(`/api/content/feed?cursor=${other}`)).status, 400);
        assert.strictEqual((await get('/api/content/feed?cursor=%%%nope')).status, 400);
    });

    await check('a slow Media is left out within the deadline and asked again on the next page', async () => {
        mediaMode = 'stall';
        const t0 = Date.now();
        const r = await get('/api/content/feed?limit=3');
        const took = Date.now() - t0;
        assert.ok(took < feed.DEADLINE_MS + 1000, `took ${took}ms`);
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.json.sources, { vods: 'timeout', clips: 'timeout', pastes: 'ok' });
        assert.strictEqual(r.json.partial, true);
        assert.deepStrictEqual(r.json.items.map((i) => i.key), ['paste:p-one', 'paste:p-two', 'paste:p-three']);
        assert.strictEqual(r.headers['cache-control'], 'no-store', 'a partial page is not cached downstream');
        const c = JSON.parse(Buffer.from(r.json.next, 'base64url').toString());
        assert.strictEqual(c.o.vods, 0, 'the VOD offset did not move');
        mediaMode = 'ok';
        feed._reset();
        const next = await get(`/api/content/feed?limit=3&cursor=${r.json.next}`);
        assert.ok(next.json.items.some((i) => i.kind === 'vod'), 'the next page has the VODs');
        assert.strictEqual(next.json.partial, false);
    });

    await check('Media down: the other sources still answer; everything down: an empty partial page, not an error', async () => {
        mediaMode = 'down';
        const r = await get('/api/content/feed?limit=30');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.sources.vods, 'error');
        assert.ok(r.json.items.length && r.json.items.every((i) => i.kind === 'paste'));
        communityMode = 'down';
        feed._reset();
        const none = await get('/api/content/feed?limit=30');
        assert.strictEqual(none.status, 200);
        assert.deepStrictEqual(none.json.items, []);
        assert.strictEqual(none.json.partial, true);
        assert.ok(none.json.next, 'the client may try again');
    });

    await check('pastes are listed only when Community owns them', async () => {
        process.env.PASTES_AUTHORITY = '';
        try {
            const r = await get('/api/content/feed?limit=30');
            assert.strictEqual(r.json.sources.pastes, 'unavailable');
            assert.strictEqual(r.json.partial, false, 'not a failure to retry');
            assert.ok(!r.json.items.some((i) => i.kind === 'paste'));
            assert.strictEqual(communityCalls.length, 0);
        } finally { process.env.PASTES_AUTHORITY = 'community'; }
    });

    await check('an upstream that answers no rows but claims more cannot keep the feed paging forever', async () => {
        communityMode = 'lying-total';
        const r = await get('/api/content/feed?type=pastes&limit=5');
        assert.deepStrictEqual(r.json.items, []);
        assert.strictEqual(r.json.next, null);
    });

    await check('source pages are cached and shared by concurrent requests', async () => {
        await Promise.all([get('/api/content/feed?limit=4'), get('/api/content/feed?limit=4'), get('/api/content/feed?limit=4')]);
        const n = asked.length + communityCalls.length;
        assert.strictEqual(n, 3, `one call per source, got ${n}`);
        await get('/api/content/feed?limit=4');
        assert.strictEqual(asked.length + communityCalls.length, 3, 'a repeat within the TTL is served from the cache');
    });

    await check('the auto-clip flag sync marks only the AI\'s own clips in Media', async () => {
        const job = require('../server/ai/auto-clip-job');
        db.setState('auto_clip_log', JSON.stringify([
            { clip_id: 101, stream_id: streamId, ts: Date.now() },
            { clip_id: 102, stream_id: streamId, ts: Date.now(), dedup: true },           // someone else's clip handed back
            { clip_id: 103, stream_id: streamId, ts: Date.now() },                        // a viewer's clip under the AI's log entry
            { clip_id: 104, stream_id: streamId, ts: Date.now() },                        // deleted since
            { clip_id: 105, stream_id: streamId, ts: Date.now() },                        // already marked
        ]));
        const media2 = { 101: { id: 101, user_id: 3, channel_user_id: 3, auto_generated: false }, 102: { id: 102, user_id: 4, channel_user_id: 3, auto_generated: false }, 103: { id: 103, user_id: 4, channel_user_id: 3, auto_generated: false }, 105: { id: 105, user_id: 3, channel_user_id: 3, auto_generated: true } };
        const puts = [];
        media.getClip = async (id) => { if (!media2[id]) throw new media.MediaApiError('Clip not found', 404); return media2[id]; };
        let upgraded = false;
        media.updateClip = async (id, body) => { puts.push({ id: Number(id), body }); const c = media2[id]; if (upgraded) c.auto_generated = body.auto_generated; return { clip: c }; };
        let out = await job.syncAutoClipFlags();
        assert.strictEqual(out.marked, 0, 'an old Media that drops the flag is not taken as done');
        assert.ok(out.pending > 0);
        upgraded = true;
        out = await job.syncAutoClipFlags();
        assert.deepStrictEqual(puts.map((p) => p.id), [101, 101], 'only 101 is written (once per run until it sticks)');
        assert.ok(!puts.some((p) => p.id === 102 || p.id === 103), 'a person\'s clip is never relabelled');
        assert.deepStrictEqual({ marked: out.marked, gone: out.gone, skipped: out.skipped, pending: out.pending }, { marked: 2, gone: 1, skipped: 1, pending: 0 });
        puts.length = 0;
        out = await job.syncAutoClipFlags();
        assert.deepStrictEqual(puts, [], 'a second run has nothing left to do');
    });

    server.close();
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) { try { fs.unlinkSync(f); } catch { /* */ } }
    quiet(failures ? `\n${failures} check(s) failed` : '\ncontent feed: all checks passed');
    process.exit(failures ? 1 : 0);
});
