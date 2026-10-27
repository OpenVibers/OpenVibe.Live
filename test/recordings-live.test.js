/**
 * A stream recorded in parts is one video (owner, 2026-10-27: "instead of 'The stream was recorded in 2 parts: Part 1 ·
 * Part 2' it should automatically just have them as a single vod"; OpenVibe.Media docs/recordings.md).
 *
 * - streaming/recordings.js sends Media the stream's parts from its history (in order, each one's stream offset and the
 *   gap before it) as PUT /recordings/stream:<id>; one part sends nothing; the sweep closes an ended stream's recording.
 * - toRecordingTime / toStreamTime: the video's time skips the gap between parts.
 * - GET /api/vods/:id for the first part of a joined recording answers the whole video: its length, the joined playlist,
 *   the parts, every part's transcript in the video's time; its memories (chapters) are every part's, in the video's
 *   time. A later part says where it starts in the whole. Before Media joined them, both answer as parts.
 * - Lists people see give the first part the whole video's length (media.listVods whole: true).
 *
 *   node test/recordings-live.test.js
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
    auth.optionalAuth = async (req, res, next) => next();
    await raw.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role, created_at) OVERRIDING SYSTEM VALUE
                       VALUES (90, 'maticus', 'Maticus', 'm@x', 'x', 'user', '2025-01-01 00:00:00')`).run();
    await db.ensureChannel(90);
    const chan = await db.getChannelByUserId(90);
    const sid = Number((await db.createStream({ user_id: 90, channel_id: chan.id, title: 'BIRD DRAMA', protocol: 'webrtc' })).lastInsertRowid);
    const startMs = Math.floor(Date.now() / 1000) * 1000 - 2000 * 1000;
    const iso = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
    await raw.prepare('UPDATE streams SET started_at = ?, ended_at = ?, is_live = 0 WHERE id = ?').run(iso(startMs), iso(startMs + 1930000), sid);

    const media = require('../server/media-client');
    const puts = [];
    media.putRecording = async (key, body) => { puts.push({ key, body }); return { id: 'med_REC', key, parts: body.parts }; };
    const history = require('../server/streaming/stream-history');
    const recordings = require('../server/streaming/recordings');
    const stream = await db.getStreamById(sid);
    await history.partStarted(stream, { vodId: 7025, part: 1, atMs: startMs + 28000 });
    await history.partEnded(sid, 7025, startMs + 706000);

    await check('one part: nothing is sent (that VOD is the video)', async () => {
        assert.strictEqual(await recordings.sync(sid), null);
        assert.strictEqual(puts.length, 0);
    });

    await history.partStarted(stream, { vodId: 7026, part: 2, atMs: startMs + 709000 });
    await history.partEnded(sid, 7026, startMs + 1930000);

    await check('two parts: PUT /recordings/stream:<id> with the parts in order, offsets and the gap', async () => {
        const rec = await recordings.sync(sid);
        assert.strictEqual(rec.id, 'med_REC');
        const put = puts.at(-1);
        assert.strictEqual(put.key, `stream:${sid}`);
        assert.deepStrictEqual(put.body.parts, [
            { vod_id: 7025, gap_before_ms: 0, stream_offset_ms: 28000 },
            { vod_id: 7026, gap_before_ms: 3000, stream_offset_ms: 709000 },
        ]);
        assert.strictEqual(put.body.title, 'BIRD DRAMA');
        assert.ok(!('state' in put.body), 'open while it may go on');
        await recordings.sweep();
        assert.strictEqual(puts.at(-1).body.state, 'closed', 'the sweep closes an ended stream\'s recording');
    });

    const parts = [{ vod_id: 7025, start_sec: 0, duration_sec: 678, stream_offset_sec: 28 }, { vod_id: 7026, start_sec: 678, duration_sec: 1221, stream_offset_sec: 709 }];
    await check('stream time ↔ the video\'s time, the gap skipped', () => {
        assert.strictEqual(recordings.toRecordingTime(parts, 100), 72);
        assert.strictEqual(recordings.toRecordingTime(parts, 900), 869);
        assert.strictEqual(recordings.toRecordingTime(parts, 707.5), null, 'between parts: not recorded');
        assert.strictEqual(recordings.toStreamTime(parts, 869), 900);
        assert.strictEqual(recordings.toStreamTime(parts, 10), 38);
    });

    // The VOD route over Media's answer.
    for (const [off, text] of [[100, 'birds in part one'], [900, 'robot in part two']]) {
        await raw.prepare('INSERT INTO stream_memories (stream_id, user_id, offset_seconds, description) VALUES (?, 90, ?, ?)').run(sid, off, text);
    }
    await raw.prepare(`INSERT INTO vod_ai_state (vod_id, ai_transcript_json) VALUES (7025, ?), (7026, ?)`)
        .run(JSON.stringify([{ start: 10, end: 12, text: 'hello from part one' }]), JSON.stringify([{ start: 5, end: 7, text: 'and part two' }]));
    let joined = true;
    const REC = () => ({ id: 'med_REC', key: `stream:${sid}`, vod_id: 7025, duration_ms: 1899000, ...(joined ? { hls_url: 'https://openvibe.media/o/med_REC/master.m3u8' } : {}),
        parts: [{ seq: 1, vod_id: 7025, start_ms: 0, duration_ms: 678000, gap_before_ms: 0, stream_offset_ms: 28000 },
            { seq: 2, vod_id: 7026, start_ms: 678000, duration_ms: 1221000, gap_before_ms: 3000, stream_offset_ms: 709000 }] });
    const VODS = {
        7025: { id: 7025, user_id: 90, stream_id: sid, title: 'BIRD DRAMA', visibility: 'public', is_public: 1, status: 'ready', duration_seconds: 678 },
        7026: { id: 7026, user_id: 90, stream_id: sid, title: 'BIRD DRAMA (Part 2)', visibility: 'public', is_public: 1, status: 'ready', duration_seconds: 1221 },
    };
    media.getVod = async (id) => ({ ...VODS[Number(id)], recording: { ...REC(), this_part: REC().parts.find((p) => p.vod_id === Number(id)) } });
    media.listClips = async () => ({ clips: [] });
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/vods', require('../server/media-proxy/vods'));
    const server = http.createServer(app).listen(0);
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    let ip = 0;
    const call = (p) => new Promise((resolve, reject) => {
        http.get({ port: server.address().port, path: p, headers: { 'cf-connecting-ip': `10.3.0.${++ip}` } }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode, json, text }); });
        }).on('error', reject);
    });

    await check('the first part of a joined recording answers the whole video', async () => {
        const r = await call('/api/vods/7025');
        assert.strictEqual(r.status, 200, r.text);
        const v = r.json.vod;
        assert.deepStrictEqual([v.duration_seconds, v.part_duration_seconds, v.hls_url], [1899, 678, 'https://openvibe.media/o/med_REC/master.m3u8']);
        assert.deepStrictEqual([v.recording.id, v.recording.joined, v.recording.vod_id, v.recording.parts.length], ['med_REC', true, 7025, 2]);
        assert.deepStrictEqual(v.recording.parts[1], { vod_id: 7026, start_sec: 678, duration_sec: 1221, gap_before_sec: 3, stream_offset_sec: 709 });
        assert.deepStrictEqual(JSON.parse(v.ai_transcript_json).map((s) => [s.start, s.text]), [[10, 'hello from part one'], [683, 'and part two']], 'every part, in the video\'s time');
        assert.ok(!('part' in v), 'not "part 1" any more');
    });

    await check('its chapters are every part\'s, in the video\'s time', async () => {
        const m = await call('/api/vods/7025/memories');
        assert.deepStrictEqual(m.json.memories.map((x) => [x.offset_seconds, x.description]), [[72, 'birds in part one'], [869, 'robot in part two']]);
    });

    await check('a later part says where it starts in the whole', async () => {
        const v = (await call('/api/vods/7026')).json.vod;
        assert.deepStrictEqual([v.recording.vod_id, v.recording.start_sec, v.duration_seconds], [7025, 678, 1221], 'its own length, and where to send people');
    });

    await check('before Media joined them, the first part answers as a part', async () => {
        joined = false;
        const v = (await call('/api/vods/7025')).json.vod;
        assert.deepStrictEqual([v.duration_seconds, v.recording.joined, v.hls_url], [678, false, undefined]);
        joined = true;
    });

    await check('lists people see give the first part the whole video\'s length', async () => {
        const rows = [{ id: 7025, duration_seconds: 678, recording: { recording_id: 'med_REC', parts: 2, duration_ms: 1899000, first_vod_id: 7025 } }, { id: 9, duration_seconds: 50 }];
        assert.deepStrictEqual(rows.map(media.wholeVideo).map((v) => [v.id, v.duration_seconds, v.part_duration_seconds]), [[7025, 1899, 678], [9, 50, undefined]]);
        const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'media-client.js'), 'utf8');
        assert.ok(src.includes('if (whole && out && Array.isArray(out.vods)) out.vods.forEach(wholeVideo);'), 'only with whole: true (jobs inside a part keep the part\'s length)');
        for (const f of ['home/routes.js', 'content/feed.js', 'seo/pages.js', 'media-proxy/lookups.js', 'media-proxy/vods.js']) {
            assert.ok(require('fs').readFileSync(require('path').join(__dirname, '..', 'server', f), 'utf8').includes('whole: true'), f);
        }
    });

    server.close();
    if (failures) { quiet(`recordings-live: ${failures} failed`); process.exit(1); }
    quiet('recordings-live: all passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
