/**
 * Legacy parity (roadmap D20): live thumbnails refresh on a steady cadence.
 *
 *   capture   a browser broadcaster posts a frame on its 30 s heartbeat (never from a hidden tab);
 *             the server's 5 s live-picture tick grabs one for RTMP, JSMPEG and WebRTC/WHIP streams
 *             whose thumbnail is 30 s old, always for a stream with no picture yet (a first picture
 *             within 15 s of going live) and only while somebody watches (a viewer socket, Chat's
 *             viewer count, or the stream named in a public live list in the last 90 s); writes
 *             closer than 15 s apart are dropped
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
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const db = require('../server/db/database');
let sid, other;

const liveThumbs = require('../server/media-proxy/live-thumbs');
assert.ok(liveThumbs.THUMB_DIR.startsWith(tmp), 'live thumbnails live under DATA_DIR (server/paths.js)');
// A tiny JPEG (SOI marker is all the validator needs).
const jpeg = (tag) => Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.from(tag)]);
const age = (file, ms) => { const t = (Date.now() - ms) / 1000; fs.utimesSync(file, t, t); };
const current = async () => await liveThumbs.getStreamThumbnailState(sid);

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
    if (!server.listening) await new Promise((r) => server.once('listening', r));

    await db.initDb();
    await db.getDb().prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role, created_at) OVERRIDING SYSTEM VALUE
        VALUES (3, 'alice', 'alice', 'alice@x', 'x', 'streamer', '2025-01-01 00:00:00')`).run();
    const ch = await db.ensureChannel(3);
    sid = Number((await db.createStream({ user_id: 3, channel_id: ch.id, title: 'A', protocol: 'rtmp' })).lastInsertRowid);
    other = Number((await db.createStream({ user_id: 3, channel_id: ch.id, title: 'B', protocol: 'webrtc' })).lastInsertRowid);

    // ── capture cadence (server side) ──
    assert.ok(await liveThumbs.shouldRefreshLiveThumbnail(sid), 'no thumbnail yet: capture one');
    const first = await liveThumbs.saveLiveThumbnail(sid, jpeg('one'));
    assert.match(first, /^\/api\/thumbnails\/stream-\d+-\d+\.jpg$/);
    assert.ok(!await liveThumbs.shouldRefreshLiveThumbnail(sid), 'a fresh thumbnail is not replaced');
    age((await current()).filePath, 25_000);
    assert.ok(!await liveThumbs.shouldRefreshLiveThumbnail(sid), 'still kept just under 30 s');
    age((await current()).filePath, 31_000);
    assert.ok(await liveThumbs.shouldRefreshLiveThumbnail(sid), 'replaced once 30 s old');
    age((await current()).filePath, 5_000);
    assert.strictEqual(await liveThumbs.saveLiveThumbnail(sid, jpeg('two')), first, 'writes closer than 15 s apart are dropped');
    age((await current()).filePath, 16_000);
    const oldFile = (await current()).filePath;
    await new Promise((r) => setTimeout(r, 5));
    const second = await liveThumbs.saveLiveThumbnail(sid, jpeg('two'));
    assert.notStrictEqual(second, first, 'a new capture gets a new file name (cards and caches see a new URL)');
    assert.ok(!fs.existsSync(oldFile), 'and the previous file is removed');
    console.log('OK capture: 30 s refresh, 15 s write floor, new name per capture');

    // ── the stable name the broadcaster preview polls ──
    let r = await get(`/api/thumbnails/stream-${sid}-live.jpg?t=1`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['cache-control'], 'no-cache');
    assert.strictEqual(r.body.toString('latin1').slice(4), 'two', 'it is the current thumbnail');
    age((await current()).filePath, 20_000);
    await liveThumbs.saveLiveThumbnail(sid, jpeg('three'));
    r = await get(`/api/thumbnails/stream-${sid}-live.jpg?t=2`);
    assert.strictEqual(r.body.toString('latin1').slice(4), 'three', 'and follows each new capture');
    assert.strictEqual((await get(`/api/thumbnails/stream-${other}-live.jpg`)).status, 404, 'none yet: 404, so the preview stays hidden');
    await db.run('UPDATE streams SET thumbnail_url = ? WHERE id = ?', ['https://openvibe.media/t/vod-9-1.jpg', other]);
    r = await get(`/api/thumbnails/stream-${other}-live.jpg`);
    assert.deepStrictEqual([r.status, r.headers.location], [302, 'https://openvibe.media/t/vod-9-1.jpg'], 'a Media fallback frame is followed');
    r = await get(`/api/thumbnails/${path.basename((await current()).thumbUrl)}`);
    assert.strictEqual(r.body.toString('latin1').slice(4), 'three', 'the real file names are still served');
    // A card that names an older capture gets the stream's current frame; with no frame at all, a 404 lets the page's
    // fallback show (the 1×1 pixel it used to answer drew an empty box on every card).
    const now = (await db.get('SELECT thumbnail_url FROM streams WHERE id = ?', [sid])).thumbnail_url;
    const old = await get(`/api/thumbnails/stream-${sid}-1000.jpg`);
    assert.strictEqual(old.status, 302);
    assert.strictEqual(old.headers.location, now, 'the name of an old capture answers with the current one');
    assert.strictEqual((await get('/api/thumbnails/stream-999-123.jpg')).status, 404, 'no frame: 404, so the card falls back to the avatar');
    console.log('OK /api/thumbnails/stream-<id>-live.jpg serves the current live thumbnail, uncached');

    // ── clean ──
    age((await current()).filePath, 3_700_000);
    const stale = (await current()).filePath;
    await liveThumbs.cleanupOldThumbnails();
    assert.ok(!fs.existsSync(stale), 'files older than an hour are deleted');
    console.log('OK clean-up after an hour');

    // ── the loops that drive it ──
    const index = read('server/index.js');
    const loop = index.slice(index.indexOf('const maintenanceInterval = setInterval('), index.indexOf("if (typeof maintenanceInterval.unref === 'function')"));
    assert.match(loop, /\}, 60000\);\s*$/, 'the maintenance loop runs every minute');
    assert.match(loop, /liveThumbs\.cleanupOldThumbnails\(\);/);
    assert.ok(!/generateWebrtcThumbnail|generateLiveStreamThumbnail|generateJSMPEGThumbnail/.test(loop), 'the 2-minute grabs are gone from the maintenance loop');
    assert.match(index, /require\('\.\/streaming\/live-thumb-cadence'\)\.tick\(\)/, 'the live-picture timer calls the cadence tick');
    assert.match(index, /\}, require\('\.\/streaming\/live-thumb-cadence'\)\.TICK_MS\)/, 'on its own 5 s interval');

    // The cadence itself: first picture at once, 30 s while watched, nothing while nobody looks, 15 s between attempts.
    const cadence = require('../server/streaming/live-thumb-cadence');
    assert.strictEqual(cadence.TICK_MS, 5000);
    assert.strictEqual(cadence.PICTURE_INTERVAL_MS, 30000);
    assert.strictEqual(cadence.shouldGrab({ hasPicture: false, ageMs: Infinity, watched: false, sinceAttemptMs: Infinity }), true, 'a first picture does not wait for a viewer');
    assert.strictEqual(cadence.shouldGrab({ hasPicture: true, ageMs: 10_000, watched: true, sinceAttemptMs: Infinity }), false, 'a fresh picture is kept');
    assert.strictEqual(cadence.shouldGrab({ hasPicture: true, ageMs: 31_000, watched: true, sinceAttemptMs: Infinity }), true, 'a 30 s old picture is refreshed for a viewer');
    assert.strictEqual(cadence.shouldGrab({ hasPicture: true, ageMs: 31_000, watched: false, sinceAttemptMs: Infinity }), false, 'and left alone for nobody');
    assert.strictEqual(cadence.shouldGrab({ hasPicture: true, ageMs: 31_000, watched: true, sinceAttemptMs: 5_000 }), false, 'a grab that just started is not doubled');
    assert.strictEqual(cadence.isWatched({ viewerCount: 2 }), true, 'Chat’s viewer count is a watcher');
    assert.strictEqual(cadence.isWatched({ socketCount: 1 }), true, 'so is a player socket');
    assert.strictEqual(cadence.isWatched({ listedAt: Date.now() - 30_000 }), true, 'and a stream on the home/list pages a moment ago');
    assert.strictEqual(cadence.isWatched({ listedAt: Date.now() - 120_000 }), false, 'but not an old list');

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

    // ── the live preview and the live-picture fallback (plan 355) ──
    const livePreview = require('../server/media-proxy/live-preview');
    const empty = { activeRecordings: new Map() };
    assert.strictEqual(livePreview.previewUrlFor(sid, { recorder: empty }), null, 'no recording: no live preview');
    const recording = { activeRecordings: new Map([[sid, { vodId: 42, protocol: 'webrtc' }]]) };
    assert.match(livePreview.previewUrlFor(sid, { recorder: recording }), /\/v\/42\/dvr\.m3u8$/, 'a recording in progress: the DVR playlist');
    assert.strictEqual(livePreview.previewUrlFor(sid, { recorder: { activeRecordings: new Map([[sid, { vodId: 42, protocol: 'jsmpeg' }]]) } }), null, 'JSMPEG has no DVR');
    const attached = livePreview.attach([{ id: sid }], { recorder: recording });
    assert.match(attached[0].preview_url, /\/v\/42\/dvr\.m3u8$/, 'the stream row carries it');

    const fallback = require('../server/media-proxy/live-picture-fallback');
    await liveThumbs.saveLiveThumbnail(sid, jpeg('four'));   // the clean-up above removed the last one
    const currentUrl = (await db.get('SELECT thumbnail_url FROM streams WHERE id = ?', [sid])).thumbnail_url;
    assert.strictEqual(fallback.livePictureFile(currentUrl), path.join(liveThumbs.THUMB_DIR, path.basename(currentUrl)),
        'the live stream’s current picture is a local file');
    assert.strictEqual(fallback.livePictureFile('https://openvibe.media/t/vod-9-1.jpg'), null, 'a Media URL is not a live picture');

    server.close();
    console.log('\n✅ live thumbnail cadence checks passed');
    process.exit(0);
})().catch((e) => { quiet(e); process.exit(1); });
