/**
 * What happened during a live stream (server/streaming/stream-history.js, migration 0020_stream_history), and what uses it.
 *
 * Stream 2795 (Maticus, 2026-10-26): its broadcaster reconnected 11 minutes in, so it was recorded in two parts, VODs
 * 6025 and 6026, and nothing remembered where part 2 began. The studio's clip panel sent stream times to part 1 ("Start
 * time exceeds video duration"), the rewind could not reach part 1, and part 2's transcript pointed 11 minutes late.
 *
 * - Parts, shapes and reconnects are kept in stream time; a burst of shape changes is written at most every 2 s.
 * - A stream-time clip (the studio's) goes to the part that recorded its end, in that part's time; across a reconnect it
 *   keeps the part's side; before any recording it is refused.
 * - GET /api/streams/:id/history lists the parts (a finished one with its source), shapes and reconnects.
 * - Transcript times (stream time) are moved into a part's own time; the stream transcript lists the parts.
 * - The speech capture's segment offsets are stream time across a capture restart.
 *
 *   node test/stream-history.test.js
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

    await raw.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role, created_at) OVERRIDING SYSTEM VALUE
                       VALUES (80, 'maticus', 'Maticus', 'm@x', 'x', 'streamer', '2025-01-01 00:00:00')`).run();
    await db.ensureChannel(80);
    const chan = await db.getChannelByUserId(80);
    const sid = Number((await db.createStream({ user_id: 80, channel_id: chan.id, title: 'BIRD DRAMA', protocol: 'webrtc' })).lastInsertRowid);
    const startMs = Math.floor(Date.now() / 1000) * 1000 - 1600 * 1000;   // whole seconds: started_at keeps no fraction
    const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
    await raw.prepare('UPDATE streams SET is_live = 1, started_at = ? WHERE id = ?').run(stamp(startMs), sid);
    const stream = await db.getStreamById(sid);

    const history = require('../server/streaming/stream-history');
    const recorder = require('../server/streaming/recorder');
    recorder.getActiveRecording = (s) => (Number(s) === sid ? { vodId: 6026, part: 2, startedAt: startMs + 707000, mediaStartedAt: startMs + 709000 } : null);

    // Part 1 from 28 s to 706 s, part 2 from 709 s (the broadcaster re-produced its video), still recording.
    await history.partStarted(stream, { vodId: 6025, part: 1, atMs: startMs + 28000 });
    await history.partEnded(sid, 6025, startMs + 706000);
    await history.partStarted(stream, { vodId: 6026, part: 2, why: 'the broadcaster re-produced video on a new transport', atMs: startMs + 709000 });

    await check('parts are kept in stream time', async () => {
        const h = await history.forStream(sid);
        assert.deepStrictEqual(h.parts.map((p) => [p.part, p.vod_id, p.at, p.end]), [[1, 6025, 28, 706], [2, 6026, 709, null]]);
        assert.strictEqual(h.parts[1].why, 'the broadcaster re-produced video on a new transport');
        assert.strictEqual((await history.partAt(sid, 800)).vod_id, 6026);
        assert.strictEqual((await history.partAt(sid, 100)).vod_id, 6025);
        assert.strictEqual(await history.partAt(sid, 10), null, 'nothing before the first part');
        const off = await history.vodOffsets([6025, 6026, 1]);
        assert.deepStrictEqual([...off.entries()], [[6025, 28], [6026, 709]]);
        assert.deepStrictEqual(await history.partForVod(6026), { stream_id: sid, vod_id: 6026, part: 2, at: 709, end: null });
        assert.strictEqual(history.vodTime(700, 709), 0, 'never before the VOD starts');
    });

    await check('a burst of shape changes is written at most every 2 s, the last one kept; the same shape adds nothing', async () => {
        assert.strictEqual(history.shape(sid, 720, 1280), true);
        await wait(50);
        assert.strictEqual(history.shape(sid, 1280, 720), true);
        assert.strictEqual(history.shape(sid, 960, 540), true);
        assert.strictEqual(history.shape(sid, 'big', 5), false, 'not a size');
        await wait(50);
        assert.strictEqual((await history.forStream(sid)).shapes.length, 1, 'only the first so far');
        await wait(history.SHAPE_MIN_MS + 200);
        history.shape(sid, 960, 540);
        await wait(50);
        const shapes = (await history.forStream(sid)).shapes;
        assert.deepStrictEqual(shapes.map((s) => [s.width, s.height, s.vod_id]), [[720, 1280, 6026], [960, 540, 6026]]);
        assert.ok(shapes.every((s) => s.at >= 1599 && s.at <= 1603), `in stream time (${shapes.map((s) => s.at)})`);
    });

    await check('a reconnect is kept with its gap', async () => {
        history.broadcasterLeft(sid);
        await wait(120);
        assert.strictEqual(await history.broadcasterBack(sid), true);
        assert.strictEqual(await history.broadcasterBack(sid), false, 'once');
        const r = (await history.forStream(sid)).reconnects;
        assert.strictEqual(r.length, 1);
        assert.ok(r[0].gap_s >= 0.1 && r[0].gap_s < 2, `gap ${r[0].gap_s}`);
    });

    // ── Routes ──
    const media = require('../server/media-client');
    const VODS = {
        6025: { id: 6025, user_id: 80, stream_id: sid, title: 'BIRD DRAMA', visibility: 'public', is_public: 1, status: 'ready', hls_url: '/o/med_1/master.m3u8' },
        6026: { id: 6026, user_id: 80, stream_id: sid, title: 'BIRD DRAMA (Part 2)', visibility: 'public', is_public: 1, status: 'recording', is_recording: 1 },
    };
    media.getVod = async (id) => { const v = VODS[Number(id)]; if (!v) throw new media.MediaApiError('VOD not found', 404, { error: 'VOD not found' }); return { ...v }; };
    const made = [];
    media.createClip = async (body) => { made.push(body); return { id: 900 + made.length, status: 'processing' }; };
    media.listVods = async () => ({ vods: [{ id: 6026 }] });

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/vods', require('../server/media-proxy/vods'));
    app.use('/api/streams', require('../server/streaming/routes'));
    app.use('/api/chat-ai', require('../server/ai/chat-ai-routes'));
    const server = http.createServer(app).listen(0);
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    let ip = 0;
    const call = (method, p, user, body) => new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const headers = { 'content-type': 'application/json', 'cf-connecting-ip': `10.1.0.${++ip}` };
        if (user) headers['x-test-user'] = String(user);
        const req = http.request({ port: server.address().port, path: p, method, headers }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode, json, text }); });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
    const clipAt = (start, end) => call('POST', '/api/vods/clips', 80, { stream_id: sid, stream_time: true, start_time: start, end_time: end, title: '' });

    await check('a studio clip in stream time goes to the part recording it, in that part\'s time', async () => {
        const r = await clipAt(1570, 1600);
        assert.strictEqual(r.status, 201, r.text);
        assert.deepStrictEqual([r.json.vod_id, r.json.part], [6026, 2]);
        const c = made[made.length - 1];
        assert.deepStrictEqual([c.vod_id, c.start_s, c.end_s], [6026, 861, 891]);
    });

    await check('across the reconnect: the part that recorded the end, from its start', async () => {
        await wait(2600);   // the per-user live clip cooldown (2.5 s)
        const r = await clipAt(690, 715);
        assert.strictEqual(r.status, 201, r.text);
        const c = made[made.length - 1];
        assert.deepStrictEqual([c.vod_id, c.start_s, c.end_s], [6026, 0, 6]);
    });

    await check('ending in the reconnect\'s gap (after part 1, before part 2): part 1 up to its end, as long as asked', async () => {
        await wait(2600);
        const r = await clipAt(692, 707.5);
        assert.strictEqual(r.status, 201, r.text);
        const c = made[made.length - 1];
        assert.deepStrictEqual([c.vod_id, c.start_s, c.end_s], [6025, 662.5, 678]);
    });

    await check('before anything was recorded: refused, nothing cut', async () => {
        await wait(2600);
        const n = made.length;
        const r = await clipAt(0, 10);
        assert.strictEqual(r.status, 409, r.text);
        assert.strictEqual(r.json.no_recording, true);
        assert.strictEqual(made.length, n);
    });

    await check('GET /api/streams/:id/history: parts with their sources, shapes, reconnects', async () => {
        const r = await call('GET', `/api/streams/${sid}/history`);
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.is_live, true);
        assert.ok(r.json.now_sec >= 1600 && r.json.now_sec < 1700, `now ${r.json.now_sec}`);
        const [p1, p2] = r.json.parts;
        assert.deepStrictEqual([p1.vod_id, p1.at, p1.end, p1.recording, p1.hls], [6025, 28, 706, false, true]);
        assert.ok(/^https:\/\/.+\/o\/med_1\/master\.m3u8$/.test(p1.src), p1.src);
        assert.deepStrictEqual([p2.vod_id, p2.recording, p2.src], [6026, true, null], 'the recording part plays from the live DVR, not a source here');
        assert.strictEqual(r.json.shapes.length, 2);
        assert.strictEqual(r.json.reconnects.length, 1);
        VODS[6025].visibility = 'private'; VODS[6025].is_public = 0;
        const anon = await call('GET', `/api/streams/${sid}/history`);
        assert.deepStrictEqual([anon.json.parts[0].vod_id, anon.json.parts[0].src], [null, null], 'a private part is listed without its VOD');
        VODS[6025].visibility = 'public'; VODS[6025].is_public = 1;
        assert.strictEqual((await call('GET', '/api/streams/999999/history')).status, 404);
    });

    await check('transcripts: stream-time lines in a part\'s own time; the stream transcript lists the parts', async () => {
        await db.addTimelineEvents([
            { stream_id: sid, vod_id: 6025, kind: 'speech', start_sec: 40, end_sec: 42, text: 'what is up guys' },
            { stream_id: sid, vod_id: 6026, kind: 'speech', start_sec: 720, end_sec: 723.5, text: 'test successful' },
        ]);
        const r = await call('GET', '/api/chat-ai/vod-transcripts?ids=6025,6026');
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(r.json.transcripts['6025'].segments.map((s) => [s.start, s.end]), [[12, 14]]);
        assert.deepStrictEqual(r.json.transcripts['6026'].segments.map((s) => [s.start, s.end]), [[11, 14.5]]);
        const t = await call('GET', `/api/chat-ai/transcript/${sid}`);
        assert.deepStrictEqual(t.json.parts.map((p) => [p.vod_id, p.at]), [[6025, 28], [6026, 709]]);
    });

    await check('a VOD without its full transcript yet shows the live captions, in its own time', async () => {
        media.listClips = async () => ({ clips: [] });
        const r = await call('GET', '/api/vods/6026');
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.vod.transcript_source, 'live');
        assert.deepStrictEqual(JSON.parse(r.json.vod.ai_transcript_json), [{ start: 11, end: 14.5, text: 'test successful' }]);
        assert.strictEqual(r.json.vod.ai_transcript, 'test successful');
        await raw.prepare('INSERT INTO vod_ai_state (vod_id, ai_transcript_json, transcript_status) VALUES (?, ?, ?)')
            .run(6026, JSON.stringify([{ start: 11, end: 14.5, text: 'Test successful.' }]), 'done');
        const done = await call('GET', '/api/vods/6026');
        assert.strictEqual(done.json.vod.transcript_source, undefined, 'the full pass wins once it is in');
        assert.strictEqual(done.json.vod.ai_transcript, 'Test successful.');
    });

    await check('speech capture offsets are stream time across a restart', async () => {
        const fs = require('fs');
        const path = require('path');
        const audio = require('../server/ai/stream-audio');
        const dir = audio.spoolDir(sid);
        fs.mkdirSync(dir, { recursive: true });
        for (const i of [0, 1, 2, 69, 70]) fs.writeFileSync(path.join(dir, `seg-${String(i).padStart(6, '0')}.wav`), '');
        audio._noteRun(sid, 0, 5);       // first capture 5 s into the stream
        audio._noteRun(sid, 69, 709.4);  // restarted after the reconnect, numbering on from 69
        const segs = audio.pendingSegments(sid, { includeLast: true });
        assert.deepStrictEqual(segs.map((s) => [s.index, s.offsetSec]), [[0, 5], [1, 15], [2, 25], [69, 709.4], [70, 719.4]]);
        audio.purgeSpool(sid);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'seg-000003.wav'), '');
        assert.deepStrictEqual(audio.pendingSegments(sid, { includeLast: true }).map((s) => s.offsetSec), [3 * audio.SEGMENT_SEC], 'no run on record: the index alone, as before');
        audio.purgeSpool(sid);
    });

    await check('the studio sends stream times and reports the shape it sends', async () => {
        const js = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'js', 'broadcast.js'), 'utf8');
        const body = js.slice(js.indexOf('async function createBroadcastClip'), js.indexOf('function _offerClipName'));
        assert.ok(/stream_time: true/.test(body) && !/vod_id:/.test(body), 'the clip panel sends stream time, no VOD id');
        assert.ok(/type: 'shape', width:/.test(js), 'the studio reports its picture size');
    });

    server.close();
    if (failures) { quiet(`stream history: ${failures} failed`); process.exit(1); }
    quiet('stream history: ok');
    process.exit(0);
})().catch((err) => { quiet(err); process.exit(1); });
