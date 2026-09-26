/**
 * Legacy parity (roadmap D20): live thumbnails refresh on a steady cadence.
 *
 *   capture   a browser broadcaster posts a frame about every 2 minutes (115 s, checked on its 30 s
 *             heartbeat, never from a hidden tab); the server's 60 s maintenance loop grabs one for
 *             RTMP, JSMPEG and WebRTC/WHIP streams whose thumbnail is 2 minutes old; writes closer
 *             than 15 s apart are dropped
 *   show      the home live grid re-reads the list at least once a minute and crossfades to the new
 *             file (each capture gets a new name); the broadcaster's RTMP/JSMPEG preview polls every
 *             10 s
 *   clean     a live thumbnail file older than an hour is deleted
 *
 * The fix it came with: that broadcaster preview asked for /thumbnails/stream-<id>-live.jpg, which
 * nothing served (live thumbnails are /api/thumbnails/stream-<id>-<ts>.jpg), and its <img> was
 * loading="lazy" inside a box hidden until the image loads, so it never loaded either way. It now
 * polls /api/thumbnails/stream-<id>-live.jpg, which answers with the stream's current thumbnail.
 *
 *   node test/live-thumb-cadence.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-thumbs-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const db = require('../server/db/database');
db.initDb();
db.getDb().prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role, created_at)
    VALUES (3, 'alice', 'alice', 'alice@x', 'x', 'streamer', '2025-01-01 00:00:00')`).run();
const ch = db.ensureChannel(3);
const sid = Number(db.createStream({ user_id: 3, channel_id: ch.id, title: 'A', protocol: 'rtmp' }).lastInsertRowid);
const other = Number(db.createStream({ user_id: 3, channel_id: ch.id, title: 'B', protocol: 'webrtc' }).lastInsertRowid);

const liveThumbs = require('../server/media-proxy/live-thumbs');
assert.ok(liveThumbs.THUMB_DIR.startsWith(tmp), 'live thumbnails live under DATA_DIR (server/paths.js)');
// A tiny JPEG (SOI marker is all the validator needs).
const jpeg = (tag) => Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.from(tag)]);
const age = (file, ms) => { const t = (Date.now() - ms) / 1000; fs.utimesSync(file, t, t); };
const current = () => liveThumbs.getStreamThumbnailState(sid);

const express = require('express');
const app = express();
app.use('/api/thumbnails', require('../server/media-proxy/thumbnails'));
const server = http.createServer(app).listen(0);
const get = (p) => new Promise((resolve, reject) => {
    http.get({ port: server.address().port, path: p }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
});

(async () => {
    await new Promise((r) => server.once('listening', r));

    // ── capture cadence (server side) ──
    assert.ok(liveThumbs.shouldRefreshLiveThumbnail(sid), 'no thumbnail yet: capture one');
    const first = liveThumbs.saveLiveThumbnail(sid, jpeg('one'));
    assert.match(first, /^\/api\/thumbnails\/stream-\d+-\d+\.jpg$/);
    assert.ok(!liveThumbs.shouldRefreshLiveThumbnail(sid), 'a fresh thumbnail is not replaced');
    age(current().filePath, 119_000);
    assert.ok(!liveThumbs.shouldRefreshLiveThumbnail(sid), 'still kept just under 2 minutes');
    age(current().filePath, 121_000);
    assert.ok(liveThumbs.shouldRefreshLiveThumbnail(sid), 'replaced once 2 minutes old');
    age(current().filePath, 5_000);
    assert.strictEqual(liveThumbs.saveLiveThumbnail(sid, jpeg('two')), first, 'writes closer than 15 s apart are dropped');
    age(current().filePath, 16_000);
    const oldFile = current().filePath;
    await new Promise((r) => setTimeout(r, 5));
    const second = liveThumbs.saveLiveThumbnail(sid, jpeg('two'));
    assert.notStrictEqual(second, first, 'a new capture gets a new file name (cards and caches see a new URL)');
    assert.ok(!fs.existsSync(oldFile), 'and the previous file is removed');
    console.log('OK capture: 2-minute refresh, 15 s write floor, new name per capture');

    // ── the stable name the broadcaster preview polls ──
    let r = await get(`/api/thumbnails/stream-${sid}-live.jpg?t=1`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['cache-control'], 'no-cache');
    assert.strictEqual(r.body.toString('latin1').slice(4), 'two', 'it is the current thumbnail');
    age(current().filePath, 20_000);
    liveThumbs.saveLiveThumbnail(sid, jpeg('three'));
    r = await get(`/api/thumbnails/stream-${sid}-live.jpg?t=2`);
    assert.strictEqual(r.body.toString('latin1').slice(4), 'three', 'and follows each new capture');
    assert.strictEqual((await get(`/api/thumbnails/stream-${other}-live.jpg`)).status, 404, 'none yet: 404, so the preview stays hidden');
    db.run('UPDATE streams SET thumbnail_url = ? WHERE id = ?', ['https://openvibe.media/t/vod-9-1.jpg', other]);
    r = await get(`/api/thumbnails/stream-${other}-live.jpg`);
    assert.deepStrictEqual([r.status, r.headers.location], [302, 'https://openvibe.media/t/vod-9-1.jpg'], 'a Media fallback frame is followed');
    r = await get(`/api/thumbnails/${path.basename(current().thumbUrl)}`);
    assert.strictEqual(r.body.toString('latin1').slice(4), 'three', 'the real file names are still served');
    assert.strictEqual((await get('/api/thumbnails/stream-999-123.jpg')).headers['content-type'], 'image/jpeg', 'a missing card thumbnail is still the placeholder pixel');
    console.log('OK /api/thumbnails/stream-<id>-live.jpg serves the current live thumbnail, uncached');

    // ── clean ──
    age(current().filePath, 3_700_000);
    const stale = current().filePath;
    liveThumbs.cleanupOldThumbnails();
    assert.ok(!fs.existsSync(stale), 'files older than an hour are deleted');
    console.log('OK clean-up after an hour');

    // ── the loops that drive it ──
    const index = read('server/index.js');
    const loop = index.slice(index.indexOf('const maintenanceInterval = setInterval('), index.indexOf("if (typeof maintenanceInterval.unref === 'function')"));
    assert.match(loop, /\}, 60000\);\s*$/, 'the maintenance loop runs every minute');
    assert.match(loop, /liveThumbs\.cleanupOldThumbnails\(\);/);
    assert.match(loop, /shouldRefreshLiveThumbnail\(rs\.id, 120000\)[\s\S]*generateLiveStreamThumbnail\(rs\.id, rs\.stream_key, \{ minAgeMs: 120000 \}\)/, 'RTMP: every 2 minutes');
    assert.match(loop, /shouldRefreshLiveThumbnail\(js\.id, 120000\)[\s\S]*generateJSMPEGThumbnail/, 'JSMPEG: every 2 minutes');
    assert.match(loop, /shouldRefreshLiveThumbnail\(wsStream\.id, 120000\)[\s\S]*generateWebrtcThumbnail\(wsStream\.id, \{ minAgeMs: 120000 \}\)/, 'WebRTC/WHIP: every 2 minutes, from the SFU');

    const state = read('public/js/broadcast-state.js');
    const bc = read('public/js/broadcast.js');
    const interval = Number(/const BROADCAST_THUMBNAIL_INTERVAL_MS = (\d+);/.exec(state)[1]);
    assert.ok(interval >= 15000 && interval < 120000, 'the browser posts before the server would grab a frame for it, never faster than the write floor');
    const capture = /function captureLiveThumbnail\(streamId\) \{[\s\S]*?\n\}/.exec(bc)[0];
    assert.match(capture, /if \(document\.hidden\) return;/, 'a hidden tab posts nothing (the server grabs instead)');
    assert.match(capture, /BROADCAST_THUMBNAIL_INTERVAL_MS/);
    assert.match(capture, /api\(`\/thumbnails\/live\/\$\{sid\}`, \{ method: 'POST'/);
    assert.match(bc, /captureLiveThumbnail\(streamId\);\s*\}, 30000\);/, 'checked on the 30 s heartbeat');

    const preview = /function startRtmpPreview\(streamId\) \{[\s\S]*?\n\}/.exec(bc)[0];
    assert.match(preview, /img\.src = `\/api\/thumbnails\/stream-\$\{streamId\}-live\.jpg\?t=\$\{Date\.now\(\)\}`;/, 'the preview polls the served name');
    assert.match(preview, /setInterval\(update, 10000\)/);
    const fragment = read('public/fragments/broadcast.html');
    const img = /<img id="bc-rtmp-preview-img"[^>]*>/.exec(fragment)[0];
    assert.ok(!/loading="lazy"/.test(img), 'the preview image is not lazy: its box is hidden until it loads');

    const home = read('public/js/app-home.js');
    assert.match(home, /_homeLiveTimer = setInterval\(_homeLiveTick, 12000\);/);
    assert.match(home, /OVLiveRealtime\.connected && Date\.now\(\) - _homeLastLiveRefresh < 60000\) return;/, 'live cards re-read at least once a minute');
    assert.match(home, /_crossfadeThumb\(img, s\.thumbnail_url\);/, 'and crossfade to the new thumbnail');
    console.log('OK the capture and display loops keep that cadence');

    server.close();
    console.log('\n✅ live thumbnail cadence checks passed');
    process.exit(0);
})().catch((e) => { quiet(e); process.exit(1); });
