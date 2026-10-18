/**
 * An RTMP recording starts once the publisher has sent video (server/streaming/rtmp-server.js waitForVideo).
 * Media's ffmpeg maps only the streams it sees in its first seconds; it was asked 2 s after the publish, and an OBS
 * whose encoder starts late sends audio first, so 8 of iZoR_One's 13 recordings (2026-10-08..18) had no picture while
 * the live stream did (its live thumbnails were fine).
 *
 *   node test/rtmp-record-after-video.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'streaming', 'rtmp-server.js'), 'utf8');

/** The source of a top-level function declaration, braces matched (after its parameter list). */
function extract(name) {
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

const ctx = vm.createContext({ setTimeout, Date, Promise, RECORD_WAIT_VIDEO_MS: 20000 });
vm.runInContext(extract('waitForVideo'), ctx);
const waitForVideo = (nms, id, o) => vm.runInContext('waitForVideo', ctx)(nms, id, o);

(async () => {
    // Audio first, video 120 ms later: it waits for the video.
    const session = { videoCodec: 0 };
    const nms = { getSession: (id) => (id === 'p1' ? session : undefined) };
    setTimeout(() => { session.videoCodec = 12; }, 120);
    const t0 = Date.now();
    assert.strictEqual(await waitForVideo(nms, 'p1', { timeoutMs: 2000, stepMs: 20 }), 'video');
    assert.ok(Date.now() - t0 >= 100, 'it waited for the first video packet');

    // An audio-only stream still records, after the wait.
    assert.strictEqual(await waitForVideo({ getSession: () => ({ videoCodec: 0 }) }, 'p2', { timeoutMs: 80, stepMs: 20 }), 'timeout');
    // The publisher left: nothing to record.
    assert.strictEqual(await waitForVideo(nms, 'gone', { timeoutMs: 80, stepMs: 20 }), 'gone');

    // The publish handler asks for the recording only after the wait, and not when the publisher has gone.
    const start = src.indexOf("const seen = await waitForVideo(this.nms, id);");
    assert.ok(start > 0, 'the recording start waits for video');
    assert.ok(src.indexOf("if (seen === 'gone') return;", start) > start);
    assert.ok(src.indexOf("recorder.startRecording(streamId, 'rtmp'", start) > start, 'and asks for the recording after it');
    console.log('rtmp record after video: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
