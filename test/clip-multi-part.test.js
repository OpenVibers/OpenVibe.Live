/**
 * A clip of a stream recorded in parts: the recording's page lists it, and a private clip's bytes are reachable.
 *
 * Clip 505 (stream 2795, cut from part 2 = VOD 6026 while the recording's page is part 1 = VOD 6025) answered
 * 404: the VOD context route listed only the clips of that one VOD (so the recording's page listed none), and a
 * private clip's playback URL was Media's plain /c/:id, which Media answers with the missing-clip 404 for every
 * reader but the owning app (only a signed URL opens a private clip's bytes).
 *
 * The real routers run on the test database with Media stubbed in-process and sign-in stubbed by an
 * `x-test-user` header (as in media-privacy.test.js).
 *
 *   node test/clip-multi-part.test.js
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
    try { await fn(); quiet('  \u2713', name); }
    catch (e) { failures++; quiet('  \u2717', name, '\n     ', e.message); }
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

    const addUser = (id, username, role) => raw.prepare(
        `INSERT INTO users (id, username, display_name, email, password_hash, role, created_at) OVERRIDING SYSTEM VALUE
         VALUES (?, ?, ?, ?, 'x', ?, '2025-01-01 00:00:00')`).run(id, username, username, `${username}@x`, role);
    await addUser(1, 'admin', 'admin');
    await addUser(3, 'alice', 'streamer');   // the streamer: her channel's clips, her recording
    await addUser(5, 'carol', 'user');       // a viewer who cut a clip of alice's stream
    await addUser(7, 'mallory', 'user');
    await db.ensureChannel(3);
    const chanA = await db.getChannelByUserId(3);
    const streamA = Number((await db.createStream({ user_id: 3, channel_id: chanA.id, title: 'A', protocol: 'webrtc' })).lastInsertRowid);

    // ── Media stub: a stream recorded in parts (6025 = part 1, the recording's page; 6026 = part 2) ──
    const media = require('../server/media-client');
    const VODS = {
        6025: { id: 6025, user_id: 3, stream_id: streamA, title: 'Part 1', visibility: 'public', is_public: 1, status: 'ready', duration_seconds: 679 },
        6026: { id: 6026, user_id: 3, stream_id: streamA, title: 'Part 2', visibility: 'public', is_public: 1, status: 'ready', duration_seconds: 1921 },
    };
    // Clip 505: cut from part 2, private (the clipper's own).
    const CLIPS = {
        505: { id: 505, user_id: 5, channel_user_id: 3, stream_id: streamA, vod_id: 6026, title: 'A moment', visibility: 'private', is_public: 0, status: 'ready', start_time: 871.5, end_time: 901.499, duration_seconds: 29.999 },
        506: { id: 506, user_id: 5, channel_user_id: 3, stream_id: streamA, vod_id: 6025, title: 'A public moment', visibility: 'public', is_public: 1, status: 'ready' },
    };
    const missing = (what) => new media.MediaApiError(`${what} not found`, 404, { error: `${what} not found` });
    media.getVod = async (id) => { const v = VODS[Number(id)]; if (!v) throw missing('VOD'); return { ...v }; };
    media.getClip = async (id) => { const c = CLIPS[Number(id)]; if (!c) throw missing('Clip'); return { ...c }; };
    media.listClips = async (q) => {
        const all = Object.values(CLIPS).map((c) => ({ ...c }));
        const out = all.filter((c) => {
            if (q.vod_id != null && Number(c.vod_id) !== Number(q.vod_id)) return false;
            if (q.stream_id != null && Number(c.stream_id) !== Number(q.stream_id)) return false;
            if (!q.include_private && c.visibility === 'private') return false;
            return true;
        });
        return { clips: out, total: out.length };
    };
    media.listVods = async () => ({ vods: [] });
    media.signedMediaUrl = async (kind, id) => ({ url: `/c/${id}?exp=9999999999&sig=stub`, expires_at: '9999-01-01T00:00:00Z' });
    media.updateClip = async () => ({});

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/vods', require('../server/media-proxy/vods'));
    app.use('/api/clips', require('../server/media-proxy/clips'));
    const server = http.createServer(app).listen(0);
    if (!server.listening) await new Promise((r) => server.once('listening', r));

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

    await check('the recording\u2019s page (part 1) lists the clip cut from part 2', async () => {
        const r = await call('GET', '/api/vods/6025/context', 3);
        assert.strictEqual(r.status, 200, `context → ${r.status} ${r.text}`);
        const ids = (r.json?.clips || []).map((c) => Number(c.id));
        assert.ok(ids.includes(505), `clip 505 must be listed on the recording\u2019s page, got ${JSON.stringify(ids)}`);
    });

    await check('a stranger does not see the recording\u2019s private clip', async () => {
        const r = await call('GET', '/api/vods/6025/context', 7);
        assert.strictEqual(r.status, 200, `context → ${r.status}`);
        const ids = (r.json?.clips || []).map((c) => Number(c.id));
        assert.ok(!ids.includes(505), `a private clip must not be listed to a stranger, got ${JSON.stringify(ids)}`);
    });

    await check('a private clip\u2019s file URL is signed for the streamer (it was a 404)', async () => {
        const r = await call('GET', '/api/clips/505/file', 3);
        assert.strictEqual(r.status, 302, `file → ${r.status}`);
        const loc = String(r.headers.location || '');
        assert.ok(/[?&]sig=/.test(loc), `the owner must get a signed URL, got ${loc}`);
    });

    await check('a private clip\u2019s file URL is not handed to someone else', async () => {
        const r = await call('GET', '/api/clips/505/file', 7);
        assert.strictEqual(r.status, 404, `a stranger must get the missing-clip answer, got ${r.status}`);
    });

    await check('a private clip\u2019s detail carries a signed playback URL', async () => {
        const r = await call('GET', '/api/clips/505', 3);
        assert.strictEqual(r.status, 200, `clip → ${r.status} ${r.text}`);
        const clip = r.json?.clip || r.json || {};
        assert.ok(/[?&]sig=/.test(String(clip.playback_url || '')), `playback_url must be signed, got ${clip.playback_url}`);
    });

    await check('a public clip keeps its plain file URL', async () => {
        const r = await call('GET', '/api/clips/506/file');
        assert.strictEqual(r.status, 302, `file → ${r.status}`);
        assert.ok(!/[?&]sig=/.test(String(r.headers.location || '')), 'a public clip needs no signature');
    });

    server.close();
    quiet(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
    process.exit(failures ? 1 : 0);
})().catch((e) => { quiet('test error:', e && e.stack || e); process.exit(1); });
