/**
 * Legacy parity (roadmap D20): a VOD can be watched while its stream records (the live tail), is
 * finalised when the stream ends, and seeks correctly once finished.
 *
 * Recording, storage and cutting are OpenVibe.Media's; this pins Live's side of it: the recorder's
 * calls into Media for every ingest type, the live-VOD endpoints the VOD page polls, the playback URL
 * it builds, and the page's tail/finalise/seek wiring (public/js/app-media.js).
 *
 * The fix it came with: /api/vods/:id/live-info reported `seekable: false` for every recording,
 * because it only trusted a `seekable` field Media's rows do not have. The VOD page refreshes its
 * source (and so extends the timeline towards the live edge) only when that is true, so a viewer
 * stayed at the length the recording had when they opened it.
 *
 *   node test/vod-tail-finalize.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-vod-tail-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = 'test';
process.env.MEDIA_PUBLIC_URL = 'https://media.test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

const db = require('../server/db/database');
db.initDb();
const raw = db.getDb();

const auth = require('../server/auth/auth');
const signIn = (req) => {
    const id = Number(req.headers['x-test-user'] || 0);
    const u = id ? db.getUserById(id) : null;
    if (u) { req.user = u; req.authSource = 'network'; }
    return u;
};
auth.requireAuth = (req, res, next) => (signIn(req) ? next() : res.status(401).json({ error: 'Authentication required' }));
auth.optionalAuth = (req, res, next) => { signIn(req); next(); };

raw.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role, created_at)
    VALUES (3, 'alice', 'alice', 'alice@x', 'x', 'streamer', '2025-01-01 00:00:00')`).run();
db.ensureChannel(3);
const chan = db.getChannelByUserId(3);
const newStream = (protocol) => Number(db.createStream({ user_id: 3, channel_id: chan.id, title: `A ${protocol}`, protocol }).lastInsertRowid);

// ── Media stub: records every call; VOD rows are whatever the test says Media holds ──
const media = require('../server/media-client');
const calls = [];
const VODS = {};
let nextVod = 500;
const note = (name, ...args) => { calls.push([name, ...args]); };
const callsFor = (vodId) => calls.filter((c) => c[1] === vodId).map((c) => c[0]);
media.createVod = async (body) => { const id = nextVod++; note('createVod', id, body); VODS[id] = { id, user_id: body.user_id, stream_id: body.stream_id, status: 'pending', is_recording: false, visibility: 'public', is_public: true, file_path: null, file_size: 0, duration: 0 }; return { id }; };
media.ingestRtmp = async (id, url) => { note('ingestRtmp', id, url); Object.assign(VODS[id], { status: 'recording', is_recording: true, file_path: `vod-${id}.mp4` }); };
media.ingestRtpStart = async (id, codecs) => { note('ingestRtpStart', id, codecs); Object.assign(VODS[id], { status: 'recording', is_recording: true, file_path: `vod-${id}.webm` }); return { videoPort: 12000, audioPort: 12002 }; };
media.ingestRtpStop = async (id) => { note('ingestRtpStop', id); };
media.completeVodChunks = async (id) => { note('completeVodChunks', id); };
media.finalizeVod = async (id) => { note('finalizeVod', id); };
media.deleteVod = async (id) => { note('deleteVod', id); delete VODS[id]; };
media.getVod = async (id) => {
    const v = VODS[Number(id)];
    if (!v) throw new media.MediaApiError('VOD not found', 404, { error: 'VOD not found' });
    return { ...v };
};
media.listClips = async () => ({ clips: [] });
const comments = require('../server/media-proxy/comments');
comments.commentCount = async () => 0;

// ── SFU stub for the WebRTC/WHIP ingest (PlainRTP consumers pointed at Media's ports) ──
const sfu = require('../server/streaming/webrtc-sfu');
const plain = { opened: [], closed: [] };
sfu.waitForProducer = async (roomId, kind) => ({ id: `${roomId}-${kind}` });
sfu.findProducerByKind = (roomId, kind) => ({ id: `${roomId}-${kind}` });
sfu.rooms = new Map();
const room = (roomId) => ({
    router: { rtpCapabilities: { codecs: [{ mimeType: 'video/VP8', preferredPayloadType: 96 }, { mimeType: 'audio/opus', preferredPayloadType: 100 }] } },
    producers: new Map([
        [`${roomId}-video`, { producer: { rtpParameters: { codecs: [{ mimeType: 'video/VP8', clockRate: 90000, payloadType: 96 }] } }, transportId: 't1' }],
        [`${roomId}-audio`, { producer: { rtpParameters: { codecs: [{ mimeType: 'audio/opus', clockRate: 48000, channels: 2, payloadType: 100 }] } }, transportId: 't1' }],
    ]),
});
sfu.createPlainConsumer = async (roomId, producerId, ip, rtpPort) => {
    plain.opened.push({ producerId, ip, rtpPort });
    return { transportId: `plain-${rtpPort}`, payloadType: producerId.endsWith('video') ? 96 : 100 };
};
sfu.closePlainConsumer = (roomId, transportId) => { plain.closed.push(transportId); };

const recorder = require('../server/streaming/recorder');

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/vods', require('../server/media-proxy/vods'));
const server = http.createServer(app).listen(0);

function call(method, p, user) {
    return new Promise((resolve, reject) => {
        const headers = {};
        if (user) headers['x-test-user'] = String(user);
        const req = http.request({ port: server.address().port, path: p, method, headers }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode, json, headers: res.headers }); });
        });
        req.on('error', reject);
        req.end();
    });
}
const until = async (cond, what) => {
    for (let i = 0; i < 200; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 5)); }
    throw new Error(`timed out waiting for ${what}`);
};

let failures = 0;
async function check(name, fn) {
    try { await fn(); quiet('  ✓', name); } catch (e) { failures++; quiet('  ✗', name, '\n     ', e.stack || e.message); }
}

(async () => {
    await new Promise((r) => server.once('listening', r));
    const config = require('../server/config');

    const rtmpSid = newStream('rtmp');
    let rtmpVod;

    await check('RTMP: a live stream gets a Media VOD, and Media pulls the local RTMP endpoint', async () => {
        recorder.startRecording(rtmpSid, 'rtmp', { streamKey: 'slotkey123' }, { mode: 'vod' });
        await until(() => calls.some((c) => c[0] === 'ingestRtmp'), 'the RTMP ingest');
        const created = calls.find((c) => c[0] === 'createVod');
        rtmpVod = created[1];
        assert.strictEqual(created[2].stream_id, rtmpSid);
        assert.strictEqual(created[2].user_id, 3);
        assert.strictEqual(created[2].stream_key, 'slotkey123');
        assert.deepStrictEqual(calls.find((c) => c[0] === 'ingestRtmp').slice(1), [rtmpVod, `rtmp://127.0.0.1:${config.rtmp.port}/live/slotkey123`]);
        assert.ok(recorder.isRecording(rtmpSid));
        assert.strictEqual(recorder.getActiveRecording(rtmpSid).vodId, rtmpVod);
    });

    await check('live tail: the stream\'s recording is found while it records', async () => {
        const r = await call('GET', `/api/vods/stream/${rtmpSid}/live`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.vod.id, rtmpVod);
        assert.strictEqual(r.json.vod.is_recording, true);
    });

    await check('live tail: live-info says recording, and seekable only once Media has written bytes', async () => {
        let r = await call('GET', `/api/vods/${rtmpVod}/live-info`);
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual([r.json.isRecording, r.json.seekable, r.json.duration], [true, false, 0],
            'before Media\'s first pass there is nothing to refresh to');
        // Media's periodic pass: duration + file_size move, the indexed copy is served at /v/<id>.
        Object.assign(VODS[rtmpVod], { duration: 30, duration_seconds: 30, file_size: 4_000_000 });
        r = await call('GET', `/api/vods/${rtmpVod}/live-info`);
        assert.deepStrictEqual([r.json.isRecording, r.json.seekable, r.json.duration, r.json.fileSize], [true, true, 30, 4_000_000],
            'a growing recording with bytes is seekable, so the page refreshes toward the live edge');
    });

    await check('live tail: the page plays the recording through /api/vods/file/<basename> → Media /v/<basename>', async () => {
        const detail = await call('GET', `/api/vods/${rtmpVod}`);
        assert.strictEqual(detail.status, 200);
        assert.strictEqual(detail.json.vod.file_path, `vod-${rtmpVod}.mp4`);
        const r = await call('GET', `/api/vods/file/${detail.json.vod.file_path}?t=123`);
        assert.strictEqual(r.status, 302);
        assert.strictEqual(r.headers.location, `https://media.test/v/vod-${rtmpVod}.mp4`);
        assert.match(r.headers['cache-control'], /max-age=0/, 'the redirect is never cached: the tail refresh must reach Media');
        const sneaky = await call('GET', '/api/vods/file/..%2F..%2Fetc%2Fpasswd');
        assert.strictEqual(sneaky.headers.location, 'https://media.test/v/passwd', 'only a basename is forwarded');
    });

    await check('finalise: stream end stops the RTMP recording once, and Media finalises it', async () => {
        const first = await recorder.finalizeStream(rtmpSid);
        assert.deepStrictEqual(first, { vodId: rtmpVod });
        assert.strictEqual(await recorder.finalizeStream(rtmpSid), null, 'a second end (stale sweep, donePublish) is a no-op');
        await until(() => !recorder.isFinalizingStream(rtmpSid), 'the finalise');
        assert.deepStrictEqual(callsFor(rtmpVod), ['createVod', 'ingestRtmp', 'finalizeVod']);
        assert.ok(!recorder.isRecording(rtmpSid));
        assert.strictEqual((await call('GET', `/api/vods/stream/${rtmpSid}/live`)).status, 404, 'no live recording any more');
    });

    await check('seek: a finished VOD reports its real duration and is seekable', async () => {
        Object.assign(VODS[rtmpVod], { status: 'ready', is_recording: false, duration: 3600, duration_seconds: 3600, file_size: 9e8 });
        const r = await call('GET', `/api/vods/${rtmpVod}/live-info`);
        assert.deepStrictEqual([r.json.isRecording, r.json.seekable, r.json.duration], [false, true, 3600]);
    });

    await check('WebRTC/WHIP: PlainRTP consumers feed Media\'s ports; stream end stops the RTP ingest and closes them', async () => {
        const sid = newStream('webrtc');
        sfu.rooms.set(`stream-${sid}`, room(`stream-${sid}`));
        recorder.startRecording(sid, 'whip', {}, { mode: 'vod' });
        await until(() => recorder.getActiveRecording(sid)?.webrtcState, 'the RTP wiring');
        const vodId = recorder.getActiveRecording(sid).vodId;
        const start = calls.find((c) => c[0] === 'ingestRtpStart' && c[1] === vodId);
        assert.deepStrictEqual(start[2].video, { payloadType: 96, codec: 'VP8', clockRate: 90000 });
        assert.deepStrictEqual(start[2].audio, { payloadType: 100, codec: 'opus', clockRate: 48000, channels: 2 });
        assert.deepStrictEqual(plain.opened.map((o) => [o.ip, o.rtpPort]), [['127.0.0.1', 12000], ['127.0.0.1', 12002]]);
        recorder.stopRecording(sid);
        await until(() => !recorder.isFinalizingStream(sid), 'the RTP stop');
        assert.deepStrictEqual(callsFor(vodId), ['createVod', 'ingestRtpStart', 'ingestRtpStop'], 'Media finalises an RTP ingest itself when it stops');
        assert.deepStrictEqual(plain.closed.sort(), ['plain-12000', 'plain-12002']);
    });

    await check('browser chunks: stream end completes the chunk session and finalises it', async () => {
        const sid = newStream('webrtc');
        recorder.registerChunkSession(sid, 900);
        recorder.stopRecording(sid);
        await until(() => !recorder.isFinalizingStream(sid), 'the chunk finalise');
        assert.deepStrictEqual(callsFor(900), ['completeVodChunks', 'finalizeVod']);
    });

    await check('clips-only recording (VOD-disabled slot) is finalised and then discarded', async () => {
        const sid = newStream('rtmp');
        recorder.startRecording(sid, 'rtmp', { streamKey: 'clipsonly1' }, { mode: 'clips' });
        await until(() => calls.some((c) => c[0] === 'ingestRtmp' && c[2].endsWith('/clipsonly1')), 'the clips-only ingest');
        const vodId = recorder.getActiveRecording(sid).vodId;
        assert.strictEqual((await call('GET', `/api/vods/stream/${sid}/live`)).status, 404, 'a clips-only recording is not a live VOD');
        recorder.stopRecording(sid);
        await until(() => !recorder.isFinalizingStream(sid), 'the clips-only stop');
        assert.deepStrictEqual(callsFor(vodId), ['createVod', 'ingestRtmp', 'finalizeVod', 'deleteVod']);
    });

    await check('Media reporting the VOD ready (or failed) clears a recording Live still thought active', async () => {
        const sid = newStream('rtmp');
        recorder.startRecording(sid, 'rtmp', { streamKey: 'settled01' }, { mode: 'vod' });
        await until(() => calls.some((c) => c[0] === 'ingestRtmp' && c[2].endsWith('/settled01')), 'the ingest');
        recorder.onVodSettled(recorder.getActiveRecording(sid).vodId);
        assert.ok(!recorder.isRecording(sid));
    });

    await check('the VOD page wires tail, finalise and seek to those endpoints', async () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-media.js'), 'utf8');
        const player = src.slice(src.indexOf('async function loadVodPlayer('), src.indexOf('// Navigate to streamer on click'));
        assert.match(player, /const filename = v\.file_path\.split\('\/'\)\.pop\(\);/, 'playback is by the basename Media returns');
        assert.match(player, /video\.src = `\/api\/vods\/file\/\$\{filename\}\?t=\$\{Date\.now\(\)\}`/, 'and through Live\'s redirect, cache-busted');
        assert.match(player, /api\(`\/vods\/\$\{v\.id\}\/live-info`\)/, 'a recording is polled through live-info');
        assert.match(player, /if \(!info\.isRecording\) \{[\s\S]{0,400}loadVodPlayer\(v\.id\);/, 'finalisation reloads it as a finished VOD');
        assert.match(player, /if \(info\.seekable\) \{[\s\S]{0,1400}video\.currentTime = Math\.min\(currentTime, dur\);/, 'the tail refresh keeps the viewer\'s position');
        assert.match(player, /if \(dur > 2\) video\.currentTime = dur - 1;/, '"Jump to live" goes to the newest second');
        assert.match(player, /video\.dataset\.serverDuration = \(serverDur > 0 && !v\.is_recording\) \? String\(serverDur\) : '';/, 'the probed duration is trusted only once finished');
        assert.match(player, /if \(seekTo && seekTo > 0\) \{\s*target = seekTo;/, 'a ?t= deep link seeks the finished VOD');
        assert.match(src, /if \(vd > 0 && sd > 0\) return \(vd > sd \* 1\.5\) \? sd : vd;/, 'an inflated container duration is clamped to the probed one');
        const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
        assert.match(appSrc, /loadVodPlayer\(segments\[1\], Number\.isFinite\(_t\) && _t > 0 \? _t : null\)/, '/vod/:id?t= reaches the player');
    });

    server.close();
    if (failures) { quiet(`\n${failures} check(s) failed`); process.exit(1); }
    quiet('\nAll VOD tail/finalise/seek checks passed');
    process.exit(0);
})().catch((e) => { quiet(e); process.exit(1); });
