/**
 * What OpenVibe.Video's Download menu reads from Live.
 *
 * - GET /api/vods/:id/download-url and /api/clips/:id/download-url: Media's bytes route with ?download=1&name=… (Media
 *   answers it as an attachment); a private item only for who may see it, as a short-lived signed URL; anyone else gets
 *   the missing-item answer.
 * - A VOD that is one part of its stream (the broadcaster reconnected) says where it starts (stream_offset_sec, part),
 *   and its moments (chapters) are the ones inside it, in its own time: part 2 of stream 2795 pointed 11 minutes late.
 *
 *   node test/vod-downloads.test.js
 */
'use strict';
const assert = require('assert');
const http = require('http');

process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

let failures = 0;
async function check(name, fn) {
    try { await fn(); quiet('  ✓', name); }
    catch (e) { failures++; quiet('  ✗', name, '\n     ', e.stack || e.message); }
}

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    const raw = db.getDb();

    const auth = require('../server/auth/auth');
    const signIn = async (req) => {
        const id = Number(req.headers['x-test-user'] || 0);
        const u = id ? await db.getUserById(id) : null;
        if (u) { req.user = u; req.authSource = 'network'; }
        return u;
    };
    auth.requireAuth = async (req, res, next) => ((await signIn(req)) ? next() : res.status(401).json({ error: 'Authentication required' }));
    auth.optionalAuth = async (req, res, next) => { await signIn(req); next(); };

    for (const [id, name] of [[80, 'maticus'], [81, 'someone']]) {
        await raw.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role, created_at) OVERRIDING SYSTEM VALUE
                           VALUES (?, ?, ?, ?, 'x', 'user', '2025-01-01 00:00:00')`).run(id, name, name, `${name}@x`);
    }
    await db.ensureChannel(80);
    const chan = await db.getChannelByUserId(80);
    const sid = Number((await db.createStream({ user_id: 80, channel_id: chan.id, title: 'BIRD DRAMA', protocol: 'webrtc' })).lastInsertRowid);
    const startMs = Math.floor(Date.now() / 1000) * 1000 - 2000 * 1000;
    await raw.prepare('UPDATE streams SET started_at = ?, ended_at = ? WHERE id = ?')
        .run(new Date(startMs).toISOString().slice(0, 19).replace('T', ' '), new Date(startMs + 1930000).toISOString().slice(0, 19).replace('T', ' '), sid);
    const stream = await db.getStreamById(sid);
    const history = require('../server/streaming/stream-history');
    await history.partStarted(stream, { vodId: 6025, part: 1, atMs: startMs + 28000 });
    await history.partEnded(sid, 6025, startMs + 706000);
    await history.partStarted(stream, { vodId: 6026, part: 2, atMs: startMs + 709000 });
    await history.partEnded(sid, 6026, startMs + 1930000);
    for (const [off, text] of [[100, 'birds in part one'], [900, 'robot in part two'], [1500, 'squirrels in part two']]) {
        await raw.prepare('INSERT INTO stream_memories (stream_id, user_id, offset_seconds, description) VALUES (?, 80, ?, ?)').run(sid, off, text);
    }

    const media = require('../server/media-client');
    const VODS = {
        6025: { id: 6025, user_id: 80, stream_id: sid, title: 'BIRD DRAMA', visibility: 'public', is_public: 1, status: 'ready' },
        6026: { id: 6026, user_id: 80, stream_id: sid, title: 'BIRD DRAMA (Part 2)', visibility: 'public', is_public: 1, status: 'ready' },
        6030: { id: 6030, user_id: 80, title: 'Private one', visibility: 'private', is_public: 0, status: 'ready' },
    };
    const CLIPS = {
        505: { id: 505, user_id: 81, vod_id: 6026, stream_id: sid, title: 'Clip', visibility: 'public', is_public: 1, status: 'ready' },
        506: { id: 506, user_id: 81, channel_user_id: 80, vod_id: 6030, title: 'Hidden clip', visibility: 'private', is_public: 0, status: 'ready' },
    };
    const missing = (what) => new media.MediaApiError(`${what} not found`, 404, { error: `${what} not found` });
    media.getVod = async (id) => { const v = VODS[Number(id)]; if (!v) throw missing('VOD'); return { ...v }; };
    media.getClip = async (id) => { const c = CLIPS[Number(id)]; if (!c) throw missing('Clip'); return { ...c }; };
    media.listClips = async () => ({ clips: [] });
    const signedFor = [];
    media.signedMediaUrl = async (kind, id, ttl) => { signedFor.push([kind, id, ttl]); return { url: `/${kind === 'clip' ? 'c' : 'v'}/${id}?exp=99&sig=abc`, expires_at: '2026-10-27T00:00:00Z' }; };

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/vods', require('../server/media-proxy/vods'));
    app.use('/api/clips', require('../server/media-proxy/clips'));
    const server = http.createServer(app).listen(0);
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    let ip = 0;
    const call = (p, user) => new Promise((resolve, reject) => {
        const headers = { 'cf-connecting-ip': `10.2.0.${++ip}` };
        if (user) headers['x-test-user'] = String(user);
        http.get({ port: server.address().port, path: p, headers }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode, json, text, headers: res.headers }); });
        }).on('error', reject);
    });
    const media0 = media.vodPlaybackUrl(1).replace(/\/v\/1$/, '');

    await check('a public VOD: Media\'s bytes route as an attachment with the asked-for name', async () => {
        const r = await call('/api/vods/6026/download-url?name=' + encodeURIComponent('BIRD DRAMA (Part 2) - Maticus/2026-10-26'));
        assert.strictEqual(r.status, 200, r.text);
        const u = new URL(r.json.url);
        assert.strictEqual(`${u.origin}${u.pathname}`, `${media0}/v/6026`);
        assert.strictEqual(u.searchParams.get('download'), '1');
        assert.strictEqual(u.searchParams.get('name'), 'BIRD DRAMA (Part 2) - Maticus 2026-10-26', 'no path separators in a name');
        assert.strictEqual(r.headers['cache-control'], 'private, no-store');
        assert.strictEqual(signedFor.length, 0, 'nothing signed for a public VOD');
    });

    await check('a private VOD: missing to others, a signed attachment URL for its owner', async () => {
        assert.strictEqual((await call('/api/vods/6030/download-url')).status, 404);
        assert.strictEqual((await call('/api/vods/6030/download-url', 81)).status, 404);
        const r = await call('/api/vods/6030/download-url?name=Private', 80);
        assert.strictEqual(r.status, 200, r.text);
        const u = new URL(r.json.url);
        assert.deepStrictEqual([u.pathname, u.searchParams.get('exp'), u.searchParams.get('sig'), u.searchParams.get('download'), u.searchParams.get('name')], ['/v/6030', '99', 'abc', '1', 'Private']);
        assert.deepStrictEqual(signedFor.pop(), ['vod', 6030, 900]);
        assert.strictEqual(r.json.expires_at, '2026-10-27T00:00:00Z');
    });

    await check('clips: the same, a private one for the clipped streamer', async () => {
        const pub = await call('/api/clips/505/download-url?name=Clip');
        assert.strictEqual(pub.status, 200, pub.text);
        assert.ok(/\/c\/505\?download=1&name=Clip$/.test(pub.json.url), pub.json.url);
        assert.strictEqual((await call('/api/clips/506/download-url')).status, 404);
        const own = await call('/api/clips/506/download-url', 80);
        assert.strictEqual(own.status, 200, own.text);
        assert.ok(/\/c\/506\?exp=99&sig=abc&download=1$/.test(own.json.url), own.json.url);
        assert.strictEqual((await call('/api/clips/99999/download-url')).status, 404);
    });

    await check('a part of a stream says where it starts; its moments are its own, in its time', async () => {
        const v = await call('/api/vods/6026');
        assert.strictEqual(v.status, 200, v.text);
        assert.deepStrictEqual([v.json.vod.stream_offset_sec, v.json.vod.part], [709, 2]);
        const m2 = await call('/api/vods/6026/memories');
        assert.deepStrictEqual(m2.json.memories.map((m) => [m.offset_seconds, m.description]), [[191, 'robot in part two'], [791, 'squirrels in part two']]);
        const m1 = await call('/api/vods/6025/memories');
        assert.deepStrictEqual(m1.json.memories.map((m) => [m.offset_seconds, m.description]), [[72, 'birds in part one']]);
    });

    server.close();
    if (failures) { quiet(`vod downloads: ${failures} failed`); process.exit(1); }
    quiet('vod downloads: ok');
    process.exit(0);
})().catch((err) => { quiet(err); process.exit(1); });
