'use strict';
// Going live from a phone without draining it (owner, 2026-10-25: "drains less battery while still having the same
// features … high as possible FPS and also adjustable settings for mobile"):
//   - the SFU producer sends H.264 from a phone or tablet (its hardware encoder; VP8, the router's first, is a software
//     encode on most phones), the codec chosen in settings anywhere, and VP8 from a computer as before;
//   - the settings' Max Bitrate and FPS reach the encoder, and it keeps the frame rate under pressure;
//   - battery saver (this device's own setting) holds 480p, 30 fps and 1 Mbps whatever the slot asks;
//   - the browser's fallback VOD recorder (a second encode) starts only when the server is not recording the stream,
//     and stops for good when the server refuses the recording (GET /api/vods/stream/:id/recording, the 403 answer).
//
//   node test/broadcast-mobile-encoder.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const state = read('public/js/broadcast-state.js');
const bc = read('public/js/broadcast.js');

function extract(src, name) {
    const m = new RegExp(`(?:async )?function ${name}\\(`).exec(src);
    assert.ok(m, `${name}() must exist`);
    let i = m.index + m[0].length;
    for (let parens = 1; parens; i++) { if (src[i] === '(') parens++; else if (src[i] === ')') parens--; }
    i = src.indexOf('{', i);
    for (let depth = 0; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(m.index, i + 1);
    }
    throw new Error(`unbalanced ${name}`);
}

const PHONE = { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36', maxTouchPoints: 5 };
const IPAD = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', maxTouchPoints: 5 };
const DESKTOP = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', maxTouchPoints: 0 };

/** broadcast-state.js in a page-like context: navigator, localStorage. */
function page(navigator, stored = {}) {
    const ctx = {
        navigator, console: { log() {}, warn() {} },
        localStorage: { getItem: (k) => (k in stored ? stored[k] : null), setItem: (k, v) => { stored[k] = String(v); } },
        document: { addEventListener() {}, hidden: false },
    };
    vm.createContext(ctx);
    vm.runInContext(`${state}\nthis.broadcastState = broadcastState;`, ctx);
    return { ctx, stored };
}

const codec = (mimeType) => ({ kind: 'video', mimeType, clockRate: 90000 });
const both = { rtpCapabilities: { codecs: [codec('video/VP8'), codec('video/rtx'), codec('video/H264'), { kind: 'audio', mimeType: 'audio/opus' }] } };
const vp8only = { rtpCapabilities: { codecs: [codec('video/VP8')] } };
const track = { kind: 'video' };

(async () => {
    // ── The codec ──
    let p = page(PHONE);
    assert.ok(p.ctx.isMobileBroadcaster());
    let o = p.ctx.sfuVideoProduceOptions(both, track);
    assert.strictEqual(o.codec.mimeType, 'video/H264', 'a phone sends H.264');
    assert.strictEqual(o.stopTracks, false, 'the broadcast owns its tracks');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(o.encodings)), [{ maxBitrate: 2500000, maxFramerate: 30 }], "the settings' Max Bitrate and FPS reach the encoder");
    assert.strictEqual(o.codecOptions.videoGoogleStartBitrate, 2500, 'H.264 starts near the target too (the router gives only VP8 a start bitrate)');
    assert.strictEqual(page(IPAD).ctx.sfuVideoProduceOptions(both, track).codec.mimeType, 'video/H264', 'an iPad (it says Macintosh, with touch)');
    assert.strictEqual(p.ctx.sfuVideoProduceOptions(vp8only, track).codec, undefined, 'a phone that cannot send H.264 sends the default');
    p.ctx.broadcastState.settings.screenShare = true;
    assert.strictEqual(p.ctx.sfuVideoProduceOptions(both, track).codec, undefined, 'a screen share keeps the default');
    p.ctx.broadcastState.settings.screenShare = false;
    p.ctx.broadcastState.settings.broadcastCodec = 'vp8';
    assert.strictEqual(p.ctx.sfuVideoProduceOptions(both, track).codec.mimeType, 'video/VP8', "the settings' Codec Preference wins");

    let d = page(DESKTOP);
    assert.ok(!d.ctx.isMobileBroadcaster());
    assert.strictEqual(d.ctx.sfuVideoProduceOptions(both, track).codec, undefined, 'a computer sends the router default (VP8) as before');
    d.ctx.broadcastState.settings.broadcastCodec = 'h264';
    assert.strictEqual(d.ctx.sfuVideoProduceOptions(both, track).codec.mimeType, 'video/H264');
    d.ctx.broadcastState.settings.broadcastBps = '4000';
    d.ctx.broadcastState.settings.broadcastFps = '60';
    assert.deepStrictEqual(JSON.parse(JSON.stringify(d.ctx.sfuVideoProduceOptions(both, track).encodings)), [{ maxBitrate: 4000000, maxFramerate: 60 }]);

    // ── Battery saver: this device's own setting ──
    p = page(PHONE);
    Object.assign(p.ctx.broadcastState.settings, { broadcastRes: '1080', broadcastFps: '60', broadcastBps: '6800' });
    assert.deepStrictEqual([p.ctx.getBroadcastResolution(), p.ctx.getBroadcastFrameRate(), p.ctx.getTargetVideoBitrate()], ['1080', 60, 6800000]);
    p.ctx.setBatterySaver(true);
    assert.deepStrictEqual([p.ctx.getBroadcastResolution(), p.ctx.getBroadcastFrameRate(), p.ctx.getTargetVideoBitrate()], ['480', 30, 1000000]);
    assert.strictEqual(p.ctx.sfuVideoProduceOptions(both, track).codecOptions.videoGoogleStartBitrate, 1000);
    assert.strictEqual(p.stored.openvibe_battery_saver, '1');
    assert.ok(!('batterySaver' in p.ctx.broadcastState.settings), 'not in the settings that go to the slot');
    assert.strictEqual(page(PHONE, { openvibe_battery_saver: '1' }).ctx.batterySaverOn(), true, 'remembered on this device');
    p.ctx.setBatterySaver(false);
    assert.strictEqual(p.ctx.getBroadcastResolution(), '1080', 'off again: the slot choice is back');

    // ── The sender keeps the frame rate (a camera) or the detail (a screen share) ──
    const sender = { params: { encodings: [{}] }, getParameters() { return { ...this.params }; }, async setParameters(x) { this.params = x; } };
    await p.ctx.applyVideoSenderPrefs({ rtpSender: sender });
    assert.strictEqual(sender.params.degradationPreference, 'maintain-framerate');
    p.ctx.broadcastState.settings.screenShare = true;
    await p.ctx.applyVideoSenderPrefs({ rtpSender: sender });
    assert.strictEqual(sender.params.degradationPreference, 'maintain-resolution');
    await p.ctx.applyVideoSenderPrefs({ rtpSender: { getParameters() { throw new Error('old browser'); } } });
    await p.ctx.applyVideoSenderPrefs(null);

    // ── The browser's fallback recorder asks the server first ──
    const recorderRun = async (answers) => {
        const made = [];
        const timers = [];
        const ss = { localStream: { id: 'cam' }, streamData: { id: 42 } };
        const ctx = {
            console: { log() {}, warn() {} },
            getStreamState: () => ss,
            setTimeout: (fn) => { timers.push(fn); return timers.length; },
            api: async (url) => { assert.strictEqual(url, '/vods/stream/42/recording'); const a = answers.shift(); if (a instanceof Error) throw a; return a; },
            MediaRecorder: Object.assign(function (stream, opts) { made.push(opts); this.state = 'recording'; this.start = () => {}; }, { isTypeSupported: () => true }),
            getTargetVideoBitrate: () => 2500000,
            uploadVodChunk() {},
        };
        vm.createContext(ctx);
        const consts = ['VOD_ASK_TRIES', 'VOD_ASK_EVERY_MS'].map((n) => new RegExp(`const ${n} = [^;]+;`).exec(bc)[0]).join('\n');
        vm.runInContext(`${consts}\n${extract(bc, 'startVodRecording')}\n${extract(bc, '_vodAskServer')}`, ctx);
        ctx.startVodRecording(7);
        ctx.startVodRecording(7);   // a second start while asking (a media recovery) waits for the answer
        for (let i = 0; i < 10; i++) {
            await new Promise((r) => setImmediate(r));
            const next = timers.shift();
            if (next) next();
        }
        await new Promise((r) => setImmediate(r));
        return { made: made.length, ss };
    };
    let r = await recorderRun([{ recording: true, server: false }, { recording: true, server: true }]);
    assert.deepStrictEqual([r.made, r.ss.vodServerRecording], [0, true], 'the server records it: no second encode on the phone');
    r = await recorderRun([{ recording: false, server: false }]);
    assert.deepStrictEqual([r.made, r.ss.vodOff], [0, true], 'the channel records nothing: neither does the browser');
    r = await recorderRun([{ recording: true, server: false }, { recording: true, server: false }, { recording: true, server: false }, { recording: true, server: false }]);
    assert.strictEqual(r.made, 1, 'the server never started recording: the browser records, once');
    r = await recorderRun([new Error('404 (an older server)')]);
    assert.strictEqual(r.made, 1, 'the server could not be asked: the browser records, as before');
    assert.ok(/resp\.status === 403\)[\s\S]{0,400}ss\.vodOff = true/.test(bc), 'a refused recording (403) stops the recorder for good');

    // ── The route the browser asks ──
    const db = require('../server/db/database');
    await db.initDb();
    const raw = db.getDb();
    await raw.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role, created_at) OVERRIDING SYSTEM VALUE
        VALUES (5, 'alice', 'Alice', 'alice@x', 'x', 'streamer', '2025-01-01 00:00:00'), (6, 'bob', 'Bob', 'bob@x', 'x', 'user', '2025-01-01 00:00:00')`).run();
    const sid = (await db.get(`INSERT INTO streams (user_id, title, protocol, is_live) VALUES (5, 'Phone stream', 'webrtc', 1) RETURNING id`)).id;
    const auth = require('../server/auth/auth');
    auth.requireAuth = async (req, res, next) => { const u = await db.getUserById(Number(req.headers['x-test-user'] || 0)); if (!u) return res.status(401).json({}); req.user = u; next(); };
    const recorder = require('../server/streaming/recorder');
    let active = null;
    recorder.getActiveRecording = () => active;
    let enabled = true;
    db.getChannelVodRecordingPolicyByUserId = async () => ({ recordingEnabled: enabled });
    const express = require('express');
    const app = express();
    app.use('/api/vods', require('../server/media-proxy/vods'));
    const server = require('http').createServer(app).listen(0);
    if (!server.listening) await new Promise((res) => server.once('listening', res));
    const ask = async (user, id = sid) => { const res = await fetch(`http://127.0.0.1:${server.address().port}/api/vods/stream/${id}/recording`, { headers: { 'x-test-user': String(user) } }); return [res.status, await res.json()]; };
    assert.deepStrictEqual(await ask(5), [200, { recording: true, server: false }], 'nothing records it yet');
    active = { type: 'rtp', vodId: 9 };
    assert.deepStrictEqual(await ask(5), [200, { recording: true, server: true }], 'Media ingest records it');
    active = { type: 'chunks', vodId: 9 };
    assert.deepStrictEqual((await ask(5))[1].server, false, "the browser's own chunks are not the server recording");
    enabled = false;
    assert.deepStrictEqual((await ask(5))[1].recording, false);
    assert.strictEqual((await ask(6))[0], 403, "someone else's stream");
    assert.strictEqual((await ask(5, 999999))[0], 404);
    server.close();

    quiet('broadcast mobile encoder: all checks passed');
    process.exit(0);
})().catch((err) => { quiet(err); process.exit(1); });
