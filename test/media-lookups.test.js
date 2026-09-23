/**
 * The readers that used to query Live's frozen vods/clips/pastes tables now ask OpenVibe.Media and
 * OpenVibe.Community (register C-73 step 2, server/media-proxy/lookups.js). This runs them against
 * in-process stand-ins for both and checks what they ask for (hidden items only on owner/staff paths),
 * what they answer, and that the routes built on them keep their response shapes.
 *
 *   node test/media-lookups.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = path.join(os.tmpdir(), `ov-media-lookups-${process.pid}.db`);
process.env.DB_PATH = tmp;
process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

const db = require('../server/db/database');
db.initDb();
const raw = db.getDb();

// ── Sign-in stub (before any router captures the middleware) ──
const auth = require('../server/auth/auth');
const signIn = (req) => {
    const id = Number(req.headers['x-test-user'] || 0);
    const u = id ? db.getUserById(id) : null;
    if (u) { req.user = u; req.authSource = 'network'; }
    return u;
};
auth.requireAuth = (req, res, next) => (signIn(req) ? next() : res.status(401).json({ error: 'Authentication required' }));
auth.optionalAuth = (req, res, next) => { signIn(req); next(); };

const addUser = (id, username, role) => raw.prepare(
    `INSERT INTO users (id, username, display_name, email, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, 'x', ?, '2025-01-01 00:00:00')`).run(id, username, username.toUpperCase(), `${username}@x`, role);
addUser(1, 'admin', 'admin');
addUser(3, 'alice', 'streamer');
addUser(7, 'mallory', 'user');
db.ensureChannel(3);
const chanA = db.getChannelByUserId(3);
raw.prepare("INSERT INTO managed_streams (user_id, channel_id, slug, title, protocol, stream_key) VALUES (3, ?, 'main', 'Main', 'rtmp', ?)").run(chanA.id, 'k'.repeat(40));
const msA = raw.prepare('SELECT id FROM managed_streams WHERE user_id = 3').get().id;
const mkStream = (title) => {
    const id = Number(db.createStream({ user_id: 3, channel_id: chanA.id, managed_stream_id: msA, title, protocol: 'rtmp' }).lastInsertRowid);
    db.endStream(id);
    return id;
};
const s1 = mkStream('first'), s2 = mkStream('second');

// ── OpenVibe.Media stand-in (the media-client functions lookups.js calls) ──
const media = require('../server/media-client');
const asked = [];
const day = (n) => new Date(Date.now() - n * 86400_000).toISOString().replace('T', ' ').slice(0, 19);
let VODS = [], CLIPS = [];
const matches = (row, q) => ['user_id', 'stream_id', 'vod_id', 'managed_stream_id', 'channel_user_id']
    .every((k) => q[k] == null || String(row[k]) === String(q[k]));
const visible = (row, q) => q.include_private || row.visibility === 'public';
media.listVods = async (q = {}) => {
    asked.push({ kind: 'vods', ...q });
    let rows = VODS.filter((v) => matches(v, q) && visible(v, q) && (q.include_recording || !v.is_recording));
    if (q.order === 'views') rows = rows.sort((a, b) => b.view_count - a.view_count);
    return { vods: rows.slice(q.offset || 0, (q.offset || 0) + (q.limit || 50)), total: rows.length };
};
media.listClips = async (q = {}) => {
    asked.push({ kind: 'clips', ...q });
    let rows = CLIPS.filter((c) => matches(c, q) && visible(c, q) && (!q.hide_self || c.channel_user_id !== c.user_id));
    if (q.order === 'views') rows = rows.sort((a, b) => b.view_count - a.view_count);
    return { clips: rows.slice(0, q.limit || 50), total: rows.length };
};
media.request = async (method, p) => {
    if (p === '/stats') return { vods: 11, clips: 22, pastes: 33, pasteImages: 3, pasteText: 30, durationSeconds: 7200, recent: { vods: { d: 1, w: 2, m: 3 } } };
    throw new media.MediaApiError('unexpected', 500);
};
media.listPastes = async (q = {}) => { asked.push({ kind: 'media-pastes', ...q }); return { pastes: [{ slug: 'm1', visibility: 'public' }, { slug: 'm2', visibility: 'private' }], total: 2 }; };

// ── OpenVibe.Community stand-in (pastes-client.request) ──
const pastesClient = require('../server/pastes-client');
const PASTES = [
    { id: 1, slug: 'pub', type: 'paste', title: 'Public', visibility: 'public', ai_summary: 'about cats', created_at: day(1) },
    { id: 2, slug: 'hid', type: 'paste', title: 'Hidden', visibility: 'private', ai_summary: 'secret', created_at: day(2) },
    { id: 3, slug: 'ava', type: 'screenshot', title: 'Avatar upload', visibility: 'unlisted', screenshot_url: 'https://media.test/f/a.png', metadata: '{"kind":"avatar"}', created_at: day(3) },
    { id: 4, slug: 'shot', type: 'screenshot', title: 'Shot', visibility: 'public', screenshot_url: 'https://media.test/f/s.png', metadata: null, created_at: day(4) },
];
const communityCalls = [];
pastesClient.request = async (method, p, { query = {}, act = {} } = {}) => {
    communityCalls.push({ method, path: p, query, act });
    if (p === '/admin/stats') return { stats: { total: 44, textPastes: 40, screenshots: 4 } };
    if (query.username !== 'alice') return { pastes: [], total: 0 };
    const hidden = query.include_unlisted && (act.staff || act.liveUserId === 3);
    const rows = PASTES.filter((x) => (hidden || x.visibility === 'public') && (!query.type || x.type === query.type));
    return { pastes: rows.slice(0, query.limit || 50), total: rows.length };
};

const lookups = require('../server/media-proxy/lookups');

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/streams', require('../server/streaming/routes'));
app.use('/api/auth', require('../server/auth/routes'));
app.use('/api/chat-ai', require('../server/ai/chat-ai-routes'));
app.use('/api/admin', require('../server/admin/routes'));
const server = http.createServer(app).listen(0);
function call(method, p, user) {
    return new Promise((resolve, reject) => {
        const headers = { 'content-type': 'application/json' };
        if (user) headers['x-test-user'] = String(user);
        const req = http.request({ port: server.address().port, path: p, method, headers }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode, json, text }); });
        });
        req.on('error', reject);
        req.end();
    });
}

let failures = 0;
async function check(name, fn) {
    try { asked.length = 0; communityCalls.length = 0; lookups._resetCaches(); await fn(); quiet('  ✓', name); }
    catch (e) { failures++; quiet('  ✗', name, '\n     ', e.stack.split('\n').slice(0, 3).join('\n      ')); }
}

(async () => {
    await new Promise((r) => server.once('listening', r));

    VODS = [
        { id: 10, user_id: 3, stream_id: s1, managed_stream_id: msA, visibility: 'public', is_public: true, view_count: 5, created_at: day(2), thumbnail_url: 'https://media.test/t/10.jpg', duration_seconds: 60, file_path: 'a.webm' },
        { id: 11, user_id: 3, stream_id: s1, managed_stream_id: msA, visibility: 'private', is_public: false, view_count: 99, created_at: day(1), thumbnail_url: 'https://media.test/t/11.jpg' },
        { id: 12, user_id: 3, stream_id: s2, managed_stream_id: msA, visibility: 'unlisted', is_public: false, view_count: 1, created_at: day(40) },
        { id: 13, user_id: 3, stream_id: s2, managed_stream_id: msA, visibility: 'public', is_public: true, view_count: 50, created_at: day(40), thumbnail_url: 'https://media.test/t/13.jpg' },
    ];
    CLIPS = [
        { id: 20, user_id: 7, channel_user_id: 3, stream_id: s1, vod_id: 10, visibility: 'public', start_time: 42.7, view_count: 3, created_at: day(1) },
        { id: 21, user_id: 3, channel_user_id: 3, stream_id: s2, vod_id: 13, visibility: 'private', start_time: 0, view_count: 0, created_at: day(1) },
        { id: 22, user_id: 3, channel_user_id: 9, stream_id: 999, vod_id: 10, visibility: 'public', start_time: 7.2, view_count: 9, created_at: day(20) },
        { id: 23, user_id: 3, channel_user_id: 9, stream_id: 998, visibility: 'private', start_time: 1, view_count: 0, created_at: day(2) },
    ];

    await check('stream VODs: public only, newest per stream; hidden ones never asked for on public paths', async () => {
        const m = await lookups.publicVodIdsByStream(3);
        assert.strictEqual(m.complete, true);
        assert.deepStrictEqual([...m.byStream.entries()].sort(), [[s1, 10], [s2, 13]]);
        assert.ok(asked.every((q) => !q.include_private));
        const saved = media.listVods;
        media.listVods = async () => { throw new media.MediaApiError('down', 0); };
        try { assert.strictEqual((await lookups.publicVodIdsByStream(3)).complete, false, 'Media down is reported'); }
        finally { media.listVods = saved; }
    });

    await check('GET /api/streams/recent keeps its VOD fields, filled from Media (public VOD only)', async () => {
        const r = await call('GET', '/api/streams/recent');
        assert.strictEqual(r.status, 200);
        const row = r.json.streams.find((s) => s.user_id === 3);
        assert.strictEqual(row.id, s2, 'the latest ended session');
        assert.strictEqual(row.vod_id, 13);
        assert.strictEqual(row.vod_is_public, 1);
        assert.strictEqual(row.vod_thumbnail_url, 'https://media.test/t/13.jpg');
        assert.ok('vod_duration' in row);
    });

    await check('workspace history: each session gets its VOD (private included, owner only)', async () => {
        const r = await call('GET', `/api/streams/managed/${msA}/history`, 3);
        assert.strictEqual(r.status, 200);
        const byId = Object.fromEntries(r.json.sessions.map((s) => [s.id, s]));
        assert.strictEqual(byId[s1].vod_id, 11, 'newest VOD of the session, private included');
        assert.strictEqual(byId[s2].vod_id, 13);
        assert.ok('vod_file_path' in byId[s1]);
        assert.ok(asked.some((q) => q.managed_stream_id === msA && q.include_private && q.include_recording));
        assert.deepStrictEqual((await call('GET', `/api/streams/managed/${msA}/history`, 7)).json.sessions, [], 'someone else sees no sessions');
    });

    await check('clip start times: by stream and by VOD, any visibility, sorted, zero dropped', async () => {
        assert.deepStrictEqual(await lookups.clipStartTimes(s1, 10), [7, 42]);
        assert.ok(asked.every((q) => q.include_private), 'an internal signal: all clips');
    });

    await check('stream analytics: the clip count arrives from Media after the stream ends', async () => {
        db.computeAndCacheStreamAnalytics(s1);
        assert.strictEqual(db.getStreamAnalytics(s1).clips_created, 0, 'the synchronous pass keeps the last value');
        await new Promise((r) => setTimeout(r, 30));
        assert.strictEqual(db.getStreamAnalytics(s1).clips_created, 1, 'Media counted one clip of the stream');
    });

    await check('clips taken: counted like the tab lists them, private only when asked', async () => {
        assert.strictEqual(await lookups.countClipsTaken(3), 1);
        assert.strictEqual(await lookups.countClipsTaken(3, { includePrivate: true }), 2);
        assert.ok(asked.every((q) => String(q.hide_self) === '1'));
    });

    await check('channel badges: pastes from Community, taken clips from Media; hidden ones for owner/staff only', async () => {
        process.env.PASTES_AUTHORITY = 'community';
        try {
            const anon = await call('GET', '/api/streams/channel/alice');
            assert.strictEqual(anon.status, 200, anon.text.slice(0, 200));
            assert.strictEqual(anon.json.pasteTotal, 2);
            assert.strictEqual(anon.json.clipsTakenTotal, 1);
            lookups._resetCaches();
            const owner = await call('GET', '/api/streams/channel/alice', 3);
            assert.strictEqual(owner.json.pasteTotal, 4);
            assert.strictEqual(owner.json.clipsTakenTotal, 2);
            assert.ok(communityCalls.some((c) => c.act.liveUserId === 3 && c.query.include_unlisted === 1), 'the owner is asked as themselves');
            lookups._resetCaches();
            const staff = await call('GET', '/api/streams/channel/alice', 1);
            assert.strictEqual(staff.json.pasteTotal, 4);
            assert.ok(communityCalls.some((c) => c.act.staff && c.query.include_unlisted === 1), 'staff are vouched for with X-OV-Staff');
            lookups._resetCaches();
            communityCalls.length = 0;
            await call('GET', '/api/streams/channel/alice', 7);
            assert.ok(communityCalls.every((c) => !c.query.include_unlisted && !c.act.staff && !c.act.liveUserId), 'anyone else: public only');
            const poll = await call('GET', '/api/streams/channel/alice?pollOnly=1');
            assert.strictEqual(poll.json.pasteTotal, 0, 'the status poll asks nobody');
        } finally { delete process.env.PASTES_AUTHORITY; }
    });

    await check('pastes while Media still holds them (PASTES_AUTHORITY unset): Media list, public filter', async () => {
        const out = await lookups.userPastes(db.getUserById(3));
        assert.deepStrictEqual(out.pastes.map((p) => p.slug), ['m1']);
        assert.ok(asked.some((q) => q.kind === 'media-pastes' && q.user_id === 3 && q.include_unlisted === undefined));
    });

    await check('setup hub: the paste task counts the person\'s own pastes', async () => {
        process.env.PASTES_AUTHORITY = 'community';
        try {
            const r = await call('GET', '/api/streams/setup-progress', 3);
            assert.strictEqual(r.status, 200);
            const task = r.json.tasks.find((t) => t.id === 'paste');
            assert.strictEqual(task.count, 4);
            assert.strictEqual(task.done, true);
        } finally { delete process.env.PASTES_AUTHORITY; }
    });

    await check('avatar history: the avatar-tagged screenshots, from Community', async () => {
        process.env.PASTES_AUTHORITY = 'community';
        try {
            raw.prepare("UPDATE users SET avatar_url = 'https://media.test/f/a.png' WHERE id = 3").run();
            const r = await call('GET', '/api/auth/avatar/history', 3);
            assert.strictEqual(r.status, 200, r.text);
            assert.deepStrictEqual(r.json.avatars.map((a) => [a.slug, a.url, a.active]), [['ava', 'https://media.test/f/a.png', true]]);
            assert.ok(communityCalls.every((c) => c.query.type === 'screenshot' && c.act.liveUserId === 3));
        } finally { delete process.env.PASTES_AUTHORITY; }
    });

    await check('offline-screen ranges: most-viewed public VOD and clip per window', async () => {
        const r = await call('GET', '/api/streams/channel/alice/popular');
        assert.strictEqual(r.status, 200);
        const { ranges } = r.json;
        assert.strictEqual(ranges.week.vod.id, 10, 'this week: the private 11 is never a candidate');
        assert.strictEqual(ranges.all.vod.id, 13, 'all time: 13 has the most views');
        assert.strictEqual(ranges.month.vod.id, 10, 'the 40-day-old VOD is outside the month');
        assert.strictEqual(ranges.week.clip.id, 20);
        assert.strictEqual(ranges.all.vod.username, 'alice', "the streamer's name rides along");
    });

    await check('AI timeline: session VOD links from Media; not cached while Media is down', async () => {
        db.addStreamMemory({ stream_id: s1, user_id: 3, offset_seconds: 5, description: 'a memory', tags: '[]' });
        raw.prepare("UPDATE streams SET ai_overview = 'what happened' WHERE id IN (?, ?)").run(s1, s2);
        const saved = media.listVods;
        media.listVods = async () => { throw new media.MediaApiError('down', 0); };
        try {
            const r = await call('GET', '/api/chat-ai/timeline/alice');
            assert.strictEqual(r.status, 200, r.text.slice(0, 200));
            assert.ok(r.json.sessions.every((s) => s.vod_id === null));
            assert.strictEqual(db.readStreamerAiTimelineCache(3), null, 'nothing cached');
        } finally { media.listVods = saved; }
        const r = await call('GET', '/api/chat-ai/timeline/alice');
        const byId = Object.fromEntries(r.json.sessions.map((s) => [s.id, s]));
        assert.strictEqual(byId[s1].vod_id, 10, 'the public VOD, never the private 11');
        assert.strictEqual(byId[s2].vod_id, 13);
        assert.ok(db.readStreamerAiTimelineCache(3), 'cached once Media answered');
    });

    await check('admin: VOD counts from Media; AI explorer pastes from Community and VODs/clips from Media', async () => {
        process.env.PASTES_AUTHORITY = 'community';
        try {
            raw.prepare('INSERT INTO vod_ai_state (vod_id, ai_overview, ai_transcript_json) VALUES (11, ?, ?)').run('private overview', JSON.stringify([{ start: 0, text: 'hello' }, { start: 2, text: 'there' }]));
            const st = await call('GET', '/api/admin/stats', 1);
            assert.strictEqual(st.status, 200, st.text.slice(0, 200));
            assert.deepStrictEqual(st.json.vods, { total: 4, public: 2 });
            const ex = await call('GET', '/api/admin/ai/explorer/3', 1);
            assert.strictEqual(ex.status, 200, ex.text.slice(0, 200));
            assert.deepStrictEqual(ex.json.pastes.map((p) => p.slug), ['pub', 'hid', 'ava', 'shot'], 'staff see every visibility');
            const v11 = ex.json.vods.find((v) => v.id === 11);
            assert.strictEqual(v11.ai_overview, 'private overview');
            assert.strictEqual(v11.ai_transcript, 'hello there');
            assert.strictEqual(ex.json.counts.clips, 3);
            assert.strictEqual((await call('GET', '/api/admin/stats', 7)).status, 403, 'still admin-only');
        } finally { delete process.env.PASTES_AUTHORITY; }
    });

    await check('home stats: Live counts none of the archive itself; Media and Community fill it in', async () => {
        const local = db._computeHomeStats();
        for (const k of ['vods', 'clips', 'pastes', 'pasteImages', 'pasteText', 'streamHours']) assert.strictEqual(local[k], null, k);
        assert.strictEqual(db.getHomeStatSeries('vods'), null, 'the vods series is Media\'s');
        process.env.PASTES_AUTHORITY = 'community';
        try {
            const s = await lookups.withArchiveStats({ ...local });
            assert.strictEqual(s.vods, 11);
            assert.strictEqual(s.streamHours, 2);
            assert.strictEqual(s.pastes, 44, 'Community owns the paste count');
            assert.strictEqual(s.pasteImages, 4);
            assert.strictEqual(s.recent.vods.w, 2);
        } finally { delete process.env.PASTES_AUTHORITY; }
    });

    await check('streamer overview job: memories are the signal', async () => {
        const due = db.getStreamersNeedingOverview({ limit: 10 }).map((r) => r.user_id);
        assert.deepStrictEqual(due, [3], 'alice has a memory; nobody else has any signal');
    });

    await check('recently online: the slot thumbnail comes from Media (null in SQL)', async () => {
        const rows = db.getRecentlyOnlineStreamers(10, 0);
        const slots = JSON.parse(rows.find((r) => r.user_id === 3).managed_streams_json);
        assert.ok(slots.length && slots.every((s) => 'vod_thumbnail' in s && s.vod_thumbnail === null));
    });

    server.close();
    for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch { /* */ } }
    if (failures) { quiet(`\n${failures} check(s) failed`); process.exit(1); }
    quiet('media lookups: all checks passed');
    process.exit(0);
})().catch((err) => { quiet(err); server.close(); process.exit(1); });
