/**
 * Private VODs and clips are missing to everyone but their owners and staff.
 *
 * GET /api/vods/:id used to answer an anonymous caller with a stub carrying a private VOD's title,
 * username and avatar; its companions (live-info, memories, context), the clip-from-VOD, publish,
 * edit and thumbnail routes answered 403, which confirms the id; comments on private items were
 * readable; the batch transcript endpoint returned any VOD's transcript; the server-rendered
 * /vod/:id and /clip/:id pages put a private item's title and overview into shared HTML; and the
 * recently-ended list carried a private legacy VOD's id and thumbnail (it now asks Media, public only). Every one of those now gives
 * the exact answer an unknown id gets.
 *
 * The real routers run on a temp database with Media stubbed in-process and sign-in stubbed by an
 * `x-test-user` header (as in authorization.test.js).
 *
 *   node test/media-privacy.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = path.join(os.tmpdir(), `ov-media-privacy-${process.pid}.db`);
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
     VALUES (?, ?, ?, ?, 'x', ?, '2025-01-01 00:00:00')`).run(id, username, username, `${username}@x`, role);
addUser(1, 'admin', 'admin');
addUser(3, 'alice', 'streamer');      // owns the private VOD; her channel was clipped
addUser(5, 'carol', 'user');          // clipped alice's stream (the private clip's creator)
addUser(6, 'mod', 'global_mod');      // staff
addUser(7, 'mallory', 'user');        // nobody special
addUser(8, 'eve', 'user');            // nobody special, second account (clip cooldowns are per user)
db.ensureChannel(3);
const chanA = db.getChannelByUserId(3);
const streamA = Number(db.createStream({ user_id: 3, channel_id: chanA.id, title: 'A', protocol: 'webrtc' }).lastInsertRowid);

// ── Media stub ──
const media = require('../server/media-client');
const VODS = {
    100: { id: 100, user_id: 3, title: 'Public VOD', visibility: 'public', is_public: 1, status: 'ready' },
    101: { id: 101, user_id: 3, stream_id: streamA, title: 'Secret VOD', visibility: 'private', is_public: 0, status: 'ready', description: 'secret description' },
    102: { id: 102, user_id: 3, title: 'Legacy hidden', is_public: 0, status: 'ready' },          // no visibility: legacy private
    103: { id: 103, user_id: 3, title: 'Unlisted VOD', visibility: 'unlisted', is_public: 0, status: 'ready' },
};
const CLIPS = {
    200: { id: 200, user_id: 5, vod_id: 100, title: 'Public clip', visibility: 'public', is_public: 1, status: 'ready' },
    201: { id: 201, user_id: 5, channel_user_id: 3, stream_id: streamA, vod_id: 101, title: 'Secret clip', visibility: 'private', is_public: 0, status: 'ready' },
};
const missing = (what) => new media.MediaApiError(`${what} not found`, 404, { error: `${what} not found` });
media.getVod = async (id) => { const v = VODS[Number(id)]; if (!v) throw missing('VOD'); return { ...v }; };
media.getClip = async (id) => { const c = CLIPS[Number(id)]; if (!c) throw missing('Clip'); return { ...c }; };
media.listClips = async () => ({ clips: [] });
media.listVods = async () => ({ vods: [] });
media.generateThumbnail = async () => ({ url: '/t/x.jpg' });
media.createClip = async () => ({ id: 999, status: 'processing' });
media.updateVod = async () => ({});
media.updateClip = async () => ({});
media.deleteClip = async () => ({});
// Comments are OpenVibe.Community threads: a stub Community (started below) and a stub service token.
const principal = require('../server/net/network-principal');
principal.serviceHeaders = async () => ({ Authorization: 'Bearer test-service-token' });
const { startCommunityStub } = require('./community-stub');
for (const [id, n] of [[1, 'A'], [3, 'B'], [5, 'C'], [6, 'D'], [7, 'E'], [8, 'F']]) {
    raw.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (?, 'network', ?, ?)").run(id, String(100 + id), `usr_01JAB2C3D4E5F6G7H8J9K0MNP${n}`);
}
const recorder = require('../server/streaming/recorder');
recorder.getActiveRecording = (sid) => (Number(sid) === streamA ? { vodId: 101, startedAt: Date.now() - 60000 } : null);

raw.prepare('INSERT INTO vod_ai_state (vod_id, ai_overview_short, ai_transcript_json) VALUES (?, ?, ?)')
    .run(101, 'secret overview', JSON.stringify([{ start: 0, end: 1, text: 'secret words' }]));
raw.prepare('INSERT INTO vod_ai_state (vod_id, ai_overview_short, ai_transcript_json) VALUES (?, ?, ?)')
    .run(100, 'public overview', JSON.stringify([{ start: 0, end: 1, text: 'public words' }]));

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/vods', require('../server/media-proxy/vods'));
app.use('/api/clips', require('../server/media-proxy/clips'));
app.use('/api/comments', require('../server/media-proxy/comments'));
app.use('/api/thumbnails', require('../server/media-proxy/thumbnails'));
app.use('/api/chat-ai', require('../server/ai/chat-ai-routes'));
const server = http.createServer(app).listen(0);

let ipSeq = 0;
function call(method, p, user, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const headers = { 'content-type': 'application/json', 'cf-connecting-ip': `10.0.0.${++ipSeq}` };
        if (user) headers['x-test-user'] = String(user);
        const req = http.request({ port: server.address().port, path: p, method, headers }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode, json, text, headers: res.headers }); });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}
/** The refused answer must be byte-for-byte the missing-id answer. */
async function sameAsMissing(method, hidden, missingPath, user, body) {
    const a = await call(method, hidden, user, body);
    const b = await call(method, missingPath, user, body);
    assert.deepStrictEqual([a.status, a.text], [b.status, b.text], `${method} ${hidden} (user ${user || 'anon'}) must look like ${missingPath}`);
    assert.strictEqual(a.status, 404, `${method} ${hidden} → 404`);
    assert.ok(!/Secret|secret/.test(a.text), 'nothing of the private item leaks');
    return a;
}

let failures = 0;
async function check(name, fn) {
    try { await fn(); quiet('  ✓', name); }
    catch (e) { failures++; quiet('  ✗', name, '\n     ', e.message); }
}

(async () => {
    await new Promise((r) => server.once('listening', r));
    const community = await startCommunityStub();
    process.env.OV_COMMUNITY_INTERNAL_URL = community.url;

    await check('VOD detail: private and legacy-private look missing to anonymous and other users', async () => {
        for (const user of [null, 7, 5]) {
            await sameAsMissing('GET', '/api/vods/101', '/api/vods/999', user);
            await sameAsMissing('GET', '/api/vods/102', '/api/vods/999', user);
        }
    });

    await check('VOD detail: owner and staff see a private VOD, with a non-shareable Cache-Control', async () => {
        for (const user of [3, 6, 1]) {
            const r = await call('GET', '/api/vods/101', user);
            assert.strictEqual(r.status, 200, `user ${user}`);
            assert.strictEqual(r.json.vod.title, 'Secret VOD');
            assert.strictEqual(r.headers['cache-control'], 'private, no-store');
        }
        assert.strictEqual((await call('GET', '/api/vods/100')).status, 200, 'public VOD');
        assert.strictEqual((await call('GET', '/api/vods/103')).status, 200, 'unlisted VOD by direct link');
    });

    await check('VOD companions: live-info, memories, context look missing', async () => {
        for (const sub of ['live-info', 'memories', 'context']) {
            await sameAsMissing('GET', `/api/vods/101/${sub}`, `/api/vods/999/${sub}`, null);
            await sameAsMissing('GET', `/api/vods/102/${sub}`, `/api/vods/999/${sub}`, 7);
            assert.strictEqual((await call('GET', `/api/vods/101/${sub}`, 3)).status, 200, `owner: ${sub}`);
        }
    });

    await check('live recording of a stream: a private VOD is not handed to viewers', async () => {
        const anon = await call('GET', `/api/vods/stream/${streamA}/live`);
        const none = await call('GET', '/api/vods/stream/424242/live');
        assert.deepStrictEqual([anon.status, anon.text], [none.status, none.text]);
        assert.strictEqual((await call('GET', `/api/vods/stream/${streamA}/live`, 3)).status, 200, 'the streamer still gets it');
    });

    await check('VOD writes by strangers: 404 (not 403) for a private VOD', async () => {
        await sameAsMissing('PUT', '/api/vods/101', '/api/vods/999', 7, { title: 'x' });
        await sameAsMissing('DELETE', '/api/vods/101', '/api/vods/999', 7);
        await sameAsMissing('POST', '/api/vods/101/publish', '/api/vods/999/publish', 7);
        assert.strictEqual((await call('PUT', '/api/vods/100', 7, { title: 'x' })).status, 403, 'a public VOD may still say 403');
    });

    await check('clipping someone else\'s private VOD looks like clipping a missing one', async () => {
        const a = await call('POST', '/api/vods/clips', 7, { vod_id: 101, start_time: 0, end_time: 5 });
        const b = await call('POST', '/api/vods/clips', 8, { vod_id: 999, start_time: 0, end_time: 5 });
        assert.deepStrictEqual([a.status, a.text], [b.status, b.text]);
        assert.strictEqual(a.status, 404);
        assert.strictEqual((await call('POST', '/api/vods/clips', 3, { vod_id: 101, start_time: 0, end_time: 5 })).status, 201, 'the owner may clip it');
    });

    await check('clip detail: private looks missing; clipper, channel owner and staff see it', async () => {
        for (const user of [null, 7]) await sameAsMissing('GET', '/api/clips/201', '/api/clips/999', user);
        for (const user of [5, 3, 6]) {
            const r = await call('GET', '/api/clips/201', user);
            assert.strictEqual(r.status, 200, `user ${user}`);
            assert.strictEqual(r.json.clip.title, 'Secret clip');
        }
        const pub = await call('GET', '/api/clips/200', 7);
        assert.strictEqual(pub.status, 200);
        assert.strictEqual(pub.json.clip.vod_available, true);
        const own = await call('GET', '/api/clips/201', 5);
        assert.strictEqual(own.json.clip.vod_available, false, 'the clipper may not see the source VOD, so it is not offered');
    });

    await check('clip writes by strangers: 404 (not 403) for a private clip', async () => {
        await sameAsMissing('PUT', '/api/clips/201/title', '/api/clips/999/title', 7, { title: 'x' });
        await sameAsMissing('PUT', '/api/clips/201/visibility', '/api/clips/999/visibility', 7, { visibility: 'public' });
        await sameAsMissing('DELETE', '/api/clips/201', '/api/clips/999', 7);
        await sameAsMissing('POST', '/api/clips/201/recut', '/api/clips/999/recut', 7);
    });

    await check('thumbnail regeneration: a private item looks missing', async () => {
        await sameAsMissing('POST', '/api/thumbnails/generate/vod/101', '/api/thumbnails/generate/vod/999', null);
        await sameAsMissing('POST', '/api/thumbnails/generate/clip/201', '/api/thumbnails/generate/clip/999', 7);
    });

    await check('comments on a private item: unreadable and unpostable for strangers', async () => {
        const posted = await call('POST', '/api/comments/vod/101', 3, { message: 'secret note' });
        assert.strictEqual(posted.status, 201, 'the owner may comment');
        await sameAsMissing('GET', '/api/comments/vod/101', '/api/comments/vod/999', null);
        await sameAsMissing('GET', '/api/comments/clip/201', '/api/comments/clip/999', 7);
        await sameAsMissing('POST', '/api/comments/vod/101', '/api/comments/vod/999', 7, { message: 'hi' });
        await sameAsMissing('GET', `/api/comments/${posted.json.comment.id}/replies`, '/api/comments/999999/replies', null);
        await sameAsMissing('PUT', `/api/comments/${posted.json.comment.id}`, '/api/comments/999999', 7, { message: 'mine now' });
        await sameAsMissing('DELETE', `/api/comments/${posted.json.comment.id}`, '/api/comments/999999', 7);
        assert.strictEqual((await call('GET', `/api/comments/${posted.json.comment.id}/replies`, 3)).status, 200, 'the owner reads them');
        const own = await call('GET', '/api/comments/vod/101', 3);
        assert.strictEqual(own.json.thread, undefined, 'a private item\'s thread is never linked on Community');
        assert.strictEqual((await call('GET', '/api/comments/vod/101', 6)).status, 200, 'staff read them');
        assert.strictEqual((await call('GET', '/api/comments/vod/100')).status, 200, 'public item comments stay open');
    });

    await check('batch transcripts leave private VODs out', async () => {
        const r = await call('GET', '/api/chat-ai/vod-transcripts?ids=100,101,102,999');
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(Object.keys(r.json.transcripts), ['100']);
        assert.ok(!/secret/.test(r.text));
    });

    await check('server-rendered /vod/:id and /clip/:id: private is the unknown-id fall-through', async () => {
        const seo = require('../server/seo/seo');
        assert.strictEqual(await seo._pageMeta('/vod/101'), null);
        assert.strictEqual(await seo._pageMeta('/vod/102'), null);
        assert.strictEqual(await seo._pageMeta('/clip/201'), null);
        assert.strictEqual(await seo._pageMeta('/vod/999'), null);
        assert.ok(await seo._pageMeta('/vod/100'), 'public VODs still render');
        assert.ok(await seo._pageMeta('/clip/200'), 'public clips still render');
    });

    await check('recently-ended streams: only a public VOD from Media rides along', async () => {
        db.endStream(streamA);
        const lookups = require('../server/media-proxy/lookups');
        const saved = media.listVods;
        const asked = [];
        let answer = [
            { id: 101, stream_id: streamA, user_id: 3, visibility: 'private', is_public: 0, thumbnail_url: 'https://media.test/t/secret.jpg', duration_seconds: 9 },
            { id: 103, stream_id: streamA, user_id: 3, visibility: 'unlisted', is_public: 0, thumbnail_url: 'https://media.test/t/unlisted.jpg', duration_seconds: 9 },
            { id: 102, stream_id: streamA, user_id: 3, is_public: 0, thumbnail_url: 'https://media.test/t/legacy.jpg' },   // legacy private
        ];
        media.listVods = async (q) => { asked.push(q); return { vods: answer }; };
        try {
            let row = (await lookups.attachPublicVods(db.getRecentStreams(10))).find((s) => s.id === streamA);
            assert.ok(row, 'the stream is listed');
            assert.strictEqual(row.vod_id, null, 'no private or unlisted VOD id');
            assert.strictEqual(row.vod_thumbnail_url, null, 'no private or unlisted VOD thumbnail');
            assert.ok(asked.length && asked.every((q) => !q.include_private), 'never asks Media for hidden VODs');
            lookups._resetCaches();
            answer = [{ id: 100, stream_id: streamA, user_id: 3, visibility: 'public', is_public: 1, thumbnail_url: 'https://media.test/t/pub.jpg', duration_seconds: 42 }];
            row = (await lookups.attachPublicVods(db.getRecentStreams(10))).find((s) => s.id === streamA);
            assert.strictEqual(row.vod_id, 100, 'a public VOD is attached');
            assert.strictEqual(row.vod_is_public, 1);
            assert.strictEqual(row.vod_thumbnail_url, 'https://media.test/t/pub.jpg');
            assert.strictEqual(row.vod_duration, 42);
        } finally { media.listVods = saved; lookups._resetCaches(); }
    });

    server.close();
    await community.close();
    for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch { /* */ } }
    if (failures) { quiet(`\n${failures} check(s) failed`); process.exit(1); }
    quiet('media privacy: all checks passed');
    process.exit(0);
})().catch((err) => { quiet(err); server.close(); process.exit(1); });
