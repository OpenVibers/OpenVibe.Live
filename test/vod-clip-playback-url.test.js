/**
 * VOD and clip playback goes to HLS when Media has a playlist (T4 step 5).
 *
 * The media proxies set playback_url from the Media row: the object's hls_url (Media's timeline playlist) when it
 * has one, the byte route (/v/:id, /c/:id) when it does not (old objects, MP4-only). file_url is always the byte
 * route, for anything that needs a real file. (The watch pages are OpenVibe.Video's: /vod/:id and /clip/:id 301 there.)
 *
 * The real routers run on the test database with Media stubbed in-process.
 *
 *   node test/vod-clip-playback-url.test.js
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
    catch (e) { failures++; quiet('  ✗', name, '\n     ', e.message); }
}

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    const raw = db.getDb();
    await raw.prepare(
        `INSERT INTO users (id, username, display_name, email, password_hash, role, created_at) OVERRIDING SYSTEM VALUE
         VALUES (3, 'alice', 'alice', 'alice@x', 'x', 'streamer', '2025-01-01 00:00:00') ON CONFLICT (id) DO NOTHING`).run();

    const media = require('../server/media-client');
    const HLS = 'https://media.test/o/obj_1/master.m3u8';
    const SIGNED = 'https://media.test/o/obj_3/master.m3u8?t=tok&e=1';
    const VODS = {
        // Media answers its byte route relative; the playlist absolute (relative is absolutized too).
        100: { id: 100, user_id: 3, title: 'HLS VOD', visibility: 'public', is_public: 1, status: 'ready', playback_url: '/v/100', hls_url: HLS },
        101: { id: 101, user_id: 3, title: 'MP4 VOD', visibility: 'public', is_public: 1, status: 'ready', playback_url: '/v/101' },
        102: { id: 102, user_id: 3, title: 'Bare VOD', visibility: 'public', is_public: 1, status: 'ready' },
        103: { id: 103, user_id: 3, title: 'Relative HLS', visibility: 'public', is_public: 1, status: 'ready', playback_url: '/v/103', hls_url: '/o/obj_103/master.m3u8' },
    };
    const CLIPS = {
        200: { id: 200, user_id: 3, vod_id: 100, title: 'HLS clip', visibility: 'public', is_public: 1, status: 'ready', playback_url: '/c/200', hls_url: SIGNED, hls_expires_at: '2026-10-13T12:00:00Z' },
        201: { id: 201, user_id: 3, vod_id: 101, title: 'MP4 clip', visibility: 'public', is_public: 1, status: 'ready', playback_url: '/c/201' },
    };
    const missing = (what) => new media.MediaApiError(`${what} not found`, 404, { error: `${what} not found` });
    media.getVod = async (id) => { const v = VODS[Number(id)]; if (!v) throw missing('VOD'); return { ...v }; };
    media.getClip = async (id) => { const c = CLIPS[Number(id)]; if (!c) throw missing('Clip'); return { ...c }; };
    media.listVods = async () => ({ vods: Object.values(VODS).map((v) => ({ ...v })) });
    media.listClips = async () => ({ clips: Object.values(CLIPS).map((c) => ({ ...c })) });

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/vods', require('../server/media-proxy/vods'));
    app.use('/api/clips', require('../server/media-proxy/clips'));
    const server = http.createServer(app).listen(0);
    const get = (p) => new Promise((resolve, reject) => {
        http.get({ port: server.address().port, path: p, headers: { 'cf-connecting-ip': '10.0.0.9' } }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text || 'null'), headers: res.headers }));
        }).on('error', reject);
    });

    await check('VOD detail with hls_url: playback_url is the playlist, file_url the byte route', async () => {
        const r = await get('/api/vods/100');
        assert.strictEqual(r.status, 200);
        const v = r.json.vod;
        assert.strictEqual(v.playback_url, HLS);
        assert.strictEqual(v.hls_url, HLS);
        assert.strictEqual(v.file_url, media.vodPlaybackUrl(100));
        assert.match(v.file_url, /\/v\/100$/);
    });

    await check('VOD detail without hls_url: playback_url and file_url are the byte route', async () => {
        for (const id of [101, 102]) {
            const r = await get(`/api/vods/${id}`);
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.json.vod.playback_url, media.vodPlaybackUrl(id), `VOD ${id}`);
            assert.strictEqual(r.json.vod.file_url, media.vodPlaybackUrl(id), `VOD ${id}`);
            assert.ok(!r.json.vod.hls_url);
        }
    });

    await check('a relative hls_url is absolutized onto Media', async () => {
        const r = await get('/api/vods/103');
        assert.strictEqual(r.json.vod.playback_url, media.publicUrl('/o/obj_103/master.m3u8'));
        assert.match(r.json.vod.playback_url, /^https?:\/\/.+\.m3u8$/);
    });

    await check('VOD list: each row picks its own URL', async () => {
        const r = await get('/api/vods');
        const by = Object.fromEntries(r.json.vods.map((v) => [v.id, v]));
        assert.strictEqual(by[100].playback_url, HLS);
        assert.strictEqual(by[100].file_url, media.vodPlaybackUrl(100));
        assert.strictEqual(by[101].playback_url, media.vodPlaybackUrl(101));
    });

    await check('clip detail: a signed playlist is passed through per response, the file stays reachable', async () => {
        const r = await get('/api/clips/200');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.clip.playback_url, SIGNED);
        assert.strictEqual(r.json.clip.hls_expires_at, '2026-10-13T12:00:00Z');
        assert.strictEqual(r.json.clip.file_url, media.clipUrl(200));
        const b = await get('/api/clips/201');
        assert.strictEqual(b.json.clip.playback_url, media.clipUrl(201));
        assert.strictEqual(b.json.clip.file_url, media.clipUrl(201));
    });

    await check('clip list: playlist when present, byte route otherwise', async () => {
        const r = await get('/api/clips');
        const by = Object.fromEntries(r.json.clips.map((c) => [c.id, c]));
        assert.strictEqual(by[200].playback_url, SIGNED);
        assert.strictEqual(by[201].playback_url, media.clipUrl(201));
        assert.strictEqual(by[201].file_url, media.clipUrl(201));
    });

    await check('the file routes still redirect to the byte route', async () => {
        const v = await new Promise((resolve) => http.get({ port: server.address().port, path: '/api/vods/100/file' }, resolve));
        assert.strictEqual(v.statusCode, 302);
        assert.strictEqual(v.headers.location, media.vodPlaybackUrl(100));
        v.resume();
        const c = await new Promise((resolve) => http.get({ port: server.address().port, path: '/api/clips/200/file' }, resolve));
        assert.strictEqual(c.headers.location, media.clipUrl(200));
        c.resume();
    });

    server.close();
    if (failures) { quiet(`\n${failures} check(s) failed`); process.exit(1); }
    quiet('vod/clip playback url: all checks passed');
    process.exit(0);
})().catch((err) => { quiet(err); process.exit(1); });
