/**
 * Pages that name nothing answer 404 (server/web/page-status.js), with the same SPA shell.
 *
 * Every page path used to get index.html with 200 — a typo, a deleted VOD, a channel that never
 * existed — so search engines indexed soft 404s and monitors could not see a broken link. The SPA
 * fallback now answers 404 for an unknown route, channel, VOD, clip, paste or stream, and for a
 * private VOD or clip seen by anyone but its owners and staff (the rule in media-proxy/access.js);
 * every real route keeps its 200.
 *
 * The SEO middleware and the real fallback run in an express app on a temp database, with Media and
 * Community stubbed in-process and sign-in stubbed by an `x-test-user` header.
 *
 *   node test/page-status.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = path.join(os.tmpdir(), `ov-page-status-${process.pid}.db`);
process.env.DB_PATH = tmp;
process.env.NODE_ENV = 'test';
delete process.env.PASTES_ON_COMMUNITY;
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

const express = require('express');
const db = require('../server/db/database');
db.initDb();
const raw = db.getDb();

// ── Sign-in stub ──
const auth = require('../server/auth/auth');
auth.optionalAuth = (req, res, next) => {
    const id = Number(req.headers['x-test-user'] || 0);
    const u = id ? db.getUserById(id) : null;
    if (u) req.user = u;
    next();
};

const addUser = (id, username, role) => raw.prepare(
    `INSERT INTO users (id, username, display_name, email, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, 'x', ?, '2025-01-01 00:00:00')`).run(id, username, username, `${username}@x`, role);
addUser(1, 'admin', 'admin');
addUser(3, 'alice', 'streamer');       // owns the private VOD
addUser(4, 'bob', 'user');             // exists, has no channel row yet
addUser(5, 'carol', 'user');           // made the private clip
addUser(7, 'mallory', 'user');         // nobody special
db.ensureChannel(3);
const chanA = db.getChannelByUserId(3);
const streamA = Number(db.createStream({ user_id: 3, channel_id: chanA.id, title: 'A', protocol: 'webrtc' }).lastInsertRowid);

// ── Media + Community stubs ──
const media = require('../server/media-client');
const VODS = {
    100: { id: 100, user_id: 3, title: 'Public VOD', visibility: 'public', is_public: 1, status: 'ready' },
    101: { id: 101, user_id: 3, stream_id: streamA, title: 'Secret VOD', visibility: 'private', is_public: 0, status: 'ready' },
    102: { id: 102, user_id: 3, title: 'Legacy hidden', is_public: 0, status: 'ready' },
    103: { id: 103, user_id: 3, title: 'Unlisted VOD', visibility: 'unlisted', is_public: 0, status: 'ready' },
};
const CLIPS = {
    200: { id: 200, user_id: 5, vod_id: 100, title: 'Public clip', visibility: 'public', is_public: 1, status: 'ready' },
    201: { id: 201, user_id: 5, channel_user_id: 3, vod_id: 101, title: 'Secret clip', visibility: 'private', is_public: 0, status: 'ready' },
};
const PASTES = { abc123: { slug: 'abc123', title: 'Hello', type: 'text', content: 'hi', visibility: 'public' } };
const calls = { vod: 0, clip: 0, paste: 0 };
let mediaMode = 'ok';   // 'ok' | 'down' | 'slow'
const missing = (what) => new media.MediaApiError(`${what} not found`, 404, { error: `${what} not found` });
const upstream = async () => {
    if (mediaMode === 'down') throw new media.MediaApiError('Media unreachable', 0, null);
    if (mediaMode === 'slow') await new Promise((r) => setTimeout(r, 4000));
};
media.getVod = async (id) => { calls.vod++; await upstream(); const v = VODS[Number(id)]; if (!v) throw missing('VOD'); return { ...v }; };
media.getClip = async (id) => { calls.clip++; await upstream(); const c = CLIPS[Number(id)]; if (!c) throw missing('Clip'); return { ...c }; };
media.listVods = async () => ({ vods: [] });
media.listClips = async () => ({ clips: [] });
media.listPastes = async () => ({ pastes: [] });
media.request = async () => { throw new media.MediaApiError('stubbed', 0, null); };
const pastesClient = require('../server/pastes-client');
pastesClient.getPaste = async (slug) => { calls.paste++; const p = PASTES[slug]; if (!p) throw missing('Paste'); return { ...p }; };
pastesClient.listPastes = async () => ({ pastes: [] });

// ── The app: the SEO middleware, then the real SPA fallback (as server/index.js mounts them) ──
const assets = require('../server/web/assets');
const pageStatus = require('../server/web/page-status');
const app = express();
require('../server/seo/seo').register(app);
app.get('*', pageStatus.spaFallback((res, urlPath) => {
    const doc = assets.document('index.html');
    if (!doc) return false;
    res.type('html').send(assets.renderRoute(doc.html, urlPath));
    return true;
}));

let base;
function get(p, { user, html = false, method = 'GET' } = {}) {
    return new Promise((resolve, reject) => {
        const headers = {};
        if (user) headers['x-test-user'] = String(user);
        // A browser's navigation goes through the SEO middleware first; `*/*` (curl, monitors) does not.
        headers.accept = html ? 'text/html,application/xhtml+xml' : '*/*';
        const req = http.request(base + p, { method, headers }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] || '', location: res.headers.location || null }));
        });
        req.on('error', reject);
        req.end();
    });
}

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); }
    catch (e) { failures++; console.log('  ✗', name, '\n     ', e.message); }
}
const statusOf = async (p, opts) => (await get(p, opts)).status;
async function expectAll(paths, want, opts) {
    const wrong = [];
    for (const p of paths) {
        for (const html of [false, true]) {
            const s = await statusOf(p, { ...opts, html });
            if (s !== want) wrong.push(`${p}${html ? ' (html)' : ''} → ${s}`);
        }
    }
    assert.deepStrictEqual(wrong, [], `expected ${want}: ${wrong.join(', ')}`);
}

const server = http.createServer(app);
server.listen(0, '127.0.0.1', async () => {
    base = `http://127.0.0.1:${server.address().port}`;
    console.log('Page status (soft 404s)');

    await check('every real route answers 200', () => expectAll([
        '/', '/content', '/content/', '/moments', '/vods', '/vods/', '/clips', '/pastes', '/updates', '/documentation', '/settings', '/admin', '/themes',
        '/dashboard', '/dashboard/anything', '/broadcast', '/broadcast/slot-2', '/chat', '/chat/voice/lobby',
        '/arena', '/arena/beef/4', '/arena/alice',
        '/@alice', '/@Alice', '/@alice/', '/@alice/main', '/@bob',
        '/vod/100', '/vod/103', '/clip/200', '/p/abc123',
        `/recap/${streamA}`, `/stream/${streamA}`,
    ], 200));

    await check('unknown paths answer 404', () => expectAll([
        '/nope', '/search', '/login', '/wp-login.php', '/favicon-missing.ico', '/Vods', '/vods/extra', '/updates/1', '/content/vods', '/moments/1',
        '/@nobody', '/@ab', '/@alice/main/extra', '/@bad.name', '/nobody', '/nobody/main', '/alice/main/extra', '/alice/bad!slot',
        '/vod', '/vod/999', '/vod/abc', '/vod/100/extra', '/clip/999', '/clip/-1',
        '/p/missing', '/p/bad!slug', '/p/abc123/extra',
        '/recap/999999', '/recap/x', '/stream/999999', '/stream',
    ], 404));

    await check('a channel is only ever /@<username>: a bare username is not a page, even for a user that exists', async () => {
        await expectAll(['/alice', '/Alice/', '/alice/main', '/bob'], 404);
        for (const p of ['/alice', '/alice/main']) assert.strictEqual((await get(p)).location, null, `${p} does not redirect`);
    });

    await check('a private VOD or clip is a 404 to strangers, with or without a sign-in', async () => {
        await expectAll(['/vod/101', '/vod/102', '/clip/201'], 404);
        await expectAll(['/vod/101', '/vod/102', '/clip/201'], 404, { user: 7 });
    });

    await check('its owners and staff still get 200', async () => {
        await expectAll(['/vod/101', '/vod/102'], 200, { user: 3 });            // uploader
        await expectAll(['/clip/201'], 200, { user: 5 });                       // clipper
        await expectAll(['/clip/201'], 200, { user: 3 });                       // clipped channel
        await expectAll(['/vod/101', '/vod/102', '/clip/201'], 200, { user: 1 }); // staff
    });

    await check('a 404 page is the SPA shell (the client renders its not-found view), and leaks nothing', async () => {
        const shell = await get('/vod/101', { html: true });
        assert.strictEqual(shell.status, 404);
        assert.ok(/text\/html/.test(shell.type), shell.type);
        assert.ok(shell.body.includes('id="ov-route-features"'), 'the route boot tag is there');
        assert.ok(shell.body.includes('/js/app.js'), 'the client router is loaded');
        assert.ok(!shell.body.includes('Secret VOD'), 'the private title is not in the page');
        const unknown = await get('/no-such-page', { html: true });
        assert.strictEqual(unknown.status, 404);
        assert.ok(unknown.body.includes('/js/app.js'));
    });

    await check('HEAD matches GET, and API paths keep their JSON 404', async () => {
        assert.strictEqual(await statusOf('/no-such-page', { method: 'HEAD' }), 404);
        assert.strictEqual(await statusOf('/vods', { method: 'HEAD' }), 200);
        const api = await get('/api/definitely-not-a-route');
        assert.strictEqual(api.status, 404);
        assert.deepStrictEqual(JSON.parse(api.body), { error: 'Not found' });
    });

    await check('Media lookups are cached and shared: one fetch per id, however many requests', async () => {
        pageStatus.clearCache();
        const before = calls.vod;
        const all = await Promise.all([1, 2, 3, 4, 5].map(() => statusOf('/vod/999')));
        assert.deepStrictEqual(all, [404, 404, 404, 404, 404]);
        await statusOf('/vod/999');
        assert.strictEqual(calls.vod - before, 1, `Media was asked ${calls.vod - before} times`);
        const pastesBefore = calls.paste;
        await statusOf('/p/missing'); await statusOf('/p/missing');
        assert.strictEqual(calls.paste - pastesBefore, 1);
        // A browser navigation: the SEO renderer asks once and remembers the miss, the fallback asks once.
        const htmlBefore = calls.clip;
        for (let i = 0; i < 5; i++) assert.strictEqual(await statusOf('/clip/998', { html: true }), 404);
        assert.ok(calls.clip - htmlBefore <= 2, `Media was asked ${calls.clip - htmlBefore} times`);
    });

    await check('the home page and fixed routes never wait on a lookup', async () => {
        mediaMode = 'slow';
        pageStatus.clearCache();
        const t0 = Date.now();
        for (const p of ['/', '/vods', '/dashboard', '/@alice', '/nope']) await statusOf(p);
        assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`);
        mediaMode = 'ok';
    });

    await check('when Media is down or slow, VOD and clip pages answer 200 rather than a false 404', async () => {
        mediaMode = 'down';
        pageStatus.clearCache();
        assert.strictEqual(await statusOf('/vod/999'), 200);
        assert.strictEqual(await statusOf('/clip/201'), 200);
        mediaMode = 'slow';
        pageStatus.clearCache();
        const t0 = Date.now();
        assert.strictEqual(await statusOf('/vod/998'), 200);
        const waited = Date.now() - t0;
        assert.ok(waited < pageStatus.LOOKUP_DEADLINE_MS + 800, `waited ${waited}ms`);
        mediaMode = 'ok';
    });

    await check('server/index.js mounts this fallback last', () => {
        const src = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
        const at = src.indexOf("app.get('*', require('./web/page-status').spaFallback(");
        assert.ok(at > 0, 'the SPA fallback is page-status.spaFallback');
        assert.ok(!/app\.get\('\*'/.test(src.slice(at + 10)), 'no second catch-all after it');
    });

    await check('the client router knows the same fixed routes', () => {
        const src = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
        const body = src.slice(src.indexOf('function routeFromURL('), src.indexOf('function showNotFound('));
        const clientRoutes = new Set([...body.matchAll(/segments\[0\] === '([a-z-]+)'/g)].map((m) => m[1]));
        // Server-side routes (legal pages, moved games) never reach the fallback; recap, stream, vod,
        // clip and p are looked up.
        const serverOnly = new Set(['dmca', 'tos', 'terms', 'privacy', 'game', 'canvas']);
        const looked = new Set(['vod', 'clip', 'p', 'recap', 'stream']);
        const known = new Set([...pageStatus.EXACT, ...pageStatus.PREFIX, ...looked]);
        const unknownToServer = [...clientRoutes].filter((r) => !known.has(r) && !serverOnly.has(r));
        assert.deepStrictEqual(unknownToServer, [], 'a client route the server would answer 404');
        assert.ok(body.includes('showNotFound()'), 'unknown paths render the not-found view');
    });

    server.close();
    try { fs.unlinkSync(tmp); } catch { /* */ }
    for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch { /* */ } }
    console.log(failures ? `\n${failures} check(s) failed` : '\npage status: all checks passed');
    process.exit(failures ? 1 : 0);
});
