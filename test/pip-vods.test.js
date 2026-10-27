'use strict';
/**
 * PIPs in VODs (owner, 2026-10-26: "the VODs system should support and handle the PIPs a streamer had configured during
 * that vod"). While a stream is live, server/streaming/pip-history.js keeps when each PIP was on screen (stream_history,
 * kind 'pip'): a span from when its stream started (or the tick before it was seen) to the last tick it was seen, a new
 * span for a new place or a restarted source. GET /api/vods/:id answers `pips`: each span as the PIP stream's public VOD,
 * in this VOD's seconds (`from`, `to`) and the PIP VOD's (`offset` at `from`), for openvibe.video to play over it.
 *
 *   node --import ./test/helpers/pg-preload.mjs test/pip-vods.test.js
 */
const assert = require('assert');

process.env.NODE_ENV = 'test';
console.warn = () => {};

const db = require('../server/db/database');
const pipHistory = require('../server/streaming/pip-history');
const lookups = require('../server/media-proxy/lookups');
const media = require('../server/media-client');

const at = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

(async () => {
    await db.initDb();
    await db.run("INSERT INTO users (id, username, password_hash) OVERRIDING SYSTEM VALUE VALUES (1, 'host', 'x'), (2, 'cohost', 'x')");
    await db.run(`INSERT INTO managed_streams (id, user_id, title, stream_key) OVERRIDING SYSTEM VALUE VALUES
        (10, 1, 'Screen', 'k10'), (11, 1, 'Webcam', 'k11'), (12, 2, 'Co-host', 'k12')`);
    await db.setPipsForManagedStream(10, [{ source_msid: 11, x: 0.73, y: 0.7, w: 0.25 }, { source_msid: 12, x: 0.02, y: 0.02, w: 0.18 }]);
    const T0 = Date.UTC(2026, 9, 27, 12, 0, 0);
    await db.run('INSERT INTO streams (id, user_id, managed_stream_id, is_live, started_at) OVERRIDING SYSTEM VALUE VALUES (600, 1, 10, 1, ?)', [at(T0)]);
    // The webcam starts two minutes in; the co-host is offline for now.
    await db.run('INSERT INTO streams (id, user_id, managed_stream_id, is_live, started_at) OVERRIDING SYSTEM VALUE VALUES (601, 1, 11, 1, ?)', [at(T0 + 120000)]);

    // ── the recorder ──
    assert.strictEqual(await pipHistory.tick(T0 + 130000), 1, 'one live PIP: one span');
    await pipHistory.tick(T0 + 160000);
    let spans = await pipHistory.spansOf(600);
    assert.deepStrictEqual(spans.map((s) => [s.at, s.end, s.source_stream_id, s.title]), [[120, 160, 601, 'Webcam']], 'from the webcam\'s start, grown by the next tick');
    // The streamer moves it: a new span from the tick before.
    await db.setPipsForManagedStream(10, [{ source_msid: 11, x: 0.02, y: 0.7, w: 0.25 }, { source_msid: 12, x: 0.02, y: 0.02, w: 0.18 }]);
    await pipHistory.tick(T0 + 190000);
    // The co-host goes live (a PIP added or a source starting mid-stream starts at its own start).
    await db.run('INSERT INTO streams (id, user_id, managed_stream_id, is_live, started_at) OVERRIDING SYSTEM VALUE VALUES (602, 2, 12, 1, ?)', [at(T0 + 200000)]);
    await pipHistory.tick(T0 + 220000);
    // The webcam ends: its span stops growing.
    await db.run('UPDATE streams SET is_live = 0 WHERE id = 601');
    await pipHistory.tick(T0 + 250000);
    spans = await pipHistory.spansOf(600);
    assert.deepStrictEqual(spans.map((s) => [s.at, s.end, s.source_stream_id, s.x]),
        [[120, 160, 601, 0.73], [160, 220, 601, 0.02], [200, 250, 602, 0.02]], 'a new place is a new span; an ended source stops growing');
    assert.strictEqual(await pipHistory.tick(T0 + 280000), 1, 'the co-host is still on screen at 280 s');
    await db.run('UPDATE streams SET is_live = 0 WHERE id = 600');
    assert.strictEqual(await pipHistory.tick(T0 + 310000), 0, 'nothing is written for a stream that is not live');
    console.log('ok: the recorder keeps when each PIP was on screen, a span per place and per source stream');

    // ── the VOD's pips ──
    const { pipsForVod } = require('../server/media-proxy/vods');
    // The webcam has a public one-part VOD; the co-host's recording is two parts (Media joins them), the second from 260 s.
    lookups.publicVodsForStreams = async (ids) => new Map(ids.filter((id) => id !== 999).map((id) => [id, id === 601 ? { id: 9001, title: 'Webcam' } : { id: 9002, title: 'Co-host', recording: { parts: 2 } }]));
    media.getRecording = async (key) => {
        assert.strictEqual(key, 'stream:602');
        return { id: 'rec_1', vod_id: 9002, duration_ms: 400000, parts: [
            { vod_id: 9002, start_ms: 0, duration_ms: 50000, stream_offset_ms: 0 },
            { vod_id: 9003, start_ms: 50000, duration_ms: 350000, stream_offset_ms: 60000 }] };
    };
    const host = await db.getStreamById(600);
    // A VOD of the host's second part, from stream second 100 (300 s long).
    const part = await pipsForVod({ id: 9000, stream_id: 600, duration_seconds: 300, stream_offset_sec: 100 }, host);
    assert.deepStrictEqual(part.map((p) => [p.vod_id, p.from, p.to, p.offset, p.x]),
        [[9001, 20, 60, 0, 0.73], [9001, 60, 120, 40, 0.02], [9002, 100, 180, 0, 0.02]],
        "in this VOD's seconds; each PIP VOD at its own second (the webcam 40 s in when it moved)");
    // A VOD that starts after the webcam span began: clipped to its start, the PIP VOD's offset moved with it.
    const late = await pipsForVod({ id: 9004, stream_id: 600, duration_seconds: 30, stream_offset_sec: 140 }, host);
    assert.deepStrictEqual(late.map((p) => [p.vod_id, p.from, p.to, p.offset]), [[9001, 0, 20, 20], [9001, 20, 30, 40]], 'clipped to the VOD, offsets moved with it');
    // The whole recording of the host (its first part answers for it): recording time, from the parts.
    const whole = await pipsForVod({ id: 9010, stream_id: 600, duration_seconds: 500, recording: { joined: true, vod_id: 9010,
        parts: [{ vod_id: 9010, start_sec: 0, duration_sec: 90, stream_offset_sec: 0 }, { vod_id: 9011, start_sec: 90, duration_sec: 400, stream_offset_sec: 100 }] } }, host);
    assert.deepStrictEqual(whole.map((p) => [p.from, p.to]), [[110, 150], [150, 210], [190, 270]], 'in the recording\'s time (stream 120 → 90 + 20)');
    // No public recording for a source: that PIP is left out.
    lookups.publicVodsForStreams = async () => new Map();
    assert.deepStrictEqual(await pipsForVod({ id: 9000, stream_id: 600, duration_seconds: 300, stream_offset_sec: 100 }, host), []);
    assert.deepStrictEqual(await pipsForVod({ id: 9100, stream_id: null }, null), [], 'a VOD with no stream has none');
    console.log("ok: a VOD's pips are its PIP streams' public VODs, in both videos' seconds, for a part, a late part and a whole recording");
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
