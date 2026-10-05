'use strict';
// VOD and clip playback source (public/js/app-media.js): a finished VOD or clip with Media's timeline playlist
// (hls_url) plays HLS, through hls.js or natively; a recording or a VOD without one keeps the file; a failed
// playlist falls back to the file once, at the same position; the clip preview always cuts from the file.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-media.js'), 'utf8');
const between = (startMark, endMark) => { const a = js.indexOf(startMark); const b = js.indexOf(endMark, a); assert.ok(a >= 0 && b > a, startMark); return js.slice(a, b); };
const helpers = between('let _vodHls = null;', 'async function loadVodPlayer(');

assert.match(js, /attachVodSource\(video, v\.is_recording \? null : v\.hls_url, `\/api\/vods\/file\/\$\{filename\}\?t=\$\{Date\.now\(\)\}`\)/, 'a finished VOD prefers its playlist; a recording keeps the file');
assert.match(js, /attachVodSource\(video, cl\.hls_url, `\/api\/vods\/file\/\$\{filename\}`\)/, 'a clip prefers its playlist');
assert.match(js, /\(video\.dataset\.fileUrl \|\| video\.src\)\.split\('\/'\)/, 'the clip preview cuts from the file, not a blob: URL');
assert.match(js, /if \(vodFallBackToFile\(video\)\) return;/, "the clip player's error message waits for the file fallback");

class FakeVideo {
    constructor(native = false) { this.native = native; this.dataset = {}; this.src = ''; this.currentTime = 0; this.listeners = {}; }
    canPlayType(t) { return this.native && t === 'application/vnd.apple.mpegurl' ? 'maybe' : ''; }
    addEventListener(e, f) { (this.listeners[e] = this.listeners[e] || []).push(f); }
    removeEventListener(e, f) { this.listeners[e] = (this.listeners[e] || []).filter((x) => x !== f); }
    fire(e) { for (const f of [...(this.listeners[e] || [])]) f(); }
}
function sandbox({ hlsSupported = true } = {}) {
    const made = [];
    class Hls {
        static isSupported() { return hlsSupported; }
        constructor(opts) { this.opts = opts; this.handlers = {}; this.destroyed = false; made.push(this); }
        on(ev, f) { this.handlers[ev] = f; }
        loadSource(u) { this.url = u; }
        attachMedia(v) { this.media = v; }
        destroy() { this.destroyed = true; }
    }
    Hls.Events = { ERROR: 'hlsError' };
    const ctx = { Hls, document: { createElement() { throw new Error('the script is already loaded'); }, head: {} } };
    vm.runInNewContext(`${helpers}; this.attachVodSource = attachVodSource; this.vodFallBackToFile = vodFallBackToFile;`, ctx);
    return { ctx, made };
}

(async () => {
    {   // hls.js path
        const { ctx, made } = sandbox();
        const v = new FakeVideo();
        assert.strictEqual(await ctx.attachVodSource(v, 'https://openvibe.media/o/obj_1/master.m3u8', '/api/vods/file/a.webm?t=1'), 'hls');
        assert.strictEqual(made[0].url, 'https://openvibe.media/o/obj_1/master.m3u8');
        assert.strictEqual(made[0].media, v);
        assert.strictEqual(v.dataset.fileUrl, '/api/vods/file/a.webm?t=1');
        v.currentTime = 42;
        made[0].handlers.hlsError(null, { fatal: true });   // the playlist fails: the file takes over at the same spot
        assert.strictEqual(made[0].destroyed, true);
        assert.strictEqual(v.src, '/api/vods/file/a.webm?t=1');
        v.fire('loadedmetadata');
        assert.strictEqual(v.currentTime, 42);
        assert.strictEqual(ctx.vodFallBackToFile(v), false, 'it falls back once');
    }
    {   // a non-fatal hls.js error changes nothing
        const { ctx, made } = sandbox();
        const v = new FakeVideo();
        await ctx.attachVodSource(v, 'https://openvibe.media/o/obj_2/master.m3u8', '/api/vods/file/b.webm');
        made[0].handlers.hlsError(null, { fatal: false });
        assert.strictEqual(v.src, '');
        assert.strictEqual(made[0].destroyed, false);
    }
    {   // native HLS (Safari): the playlist is the src; a media error falls back
        const { ctx, made } = sandbox();
        const v = new FakeVideo(true);
        assert.strictEqual(await ctx.attachVodSource(v, 'https://openvibe.media/o/obj_3/master.m3u8', '/api/vods/file/c.webm'), 'hls');
        assert.strictEqual(made.length, 0);
        assert.strictEqual(v.src, 'https://openvibe.media/o/obj_3/master.m3u8');
        assert.strictEqual(ctx.vodFallBackToFile(v), true);
        assert.strictEqual(v.src, '/api/vods/file/c.webm');
    }
    {   // no playlist, or no HLS support: the file
        const { ctx } = sandbox();
        const v = new FakeVideo();
        assert.strictEqual(await ctx.attachVodSource(v, null, '/api/vods/file/d.webm'), 'file');
        assert.strictEqual(v.src, '/api/vods/file/d.webm');
        assert.strictEqual(ctx.vodFallBackToFile(v), false);
        const { ctx: ctx2 } = sandbox({ hlsSupported: false });
        const w = new FakeVideo();
        assert.strictEqual(await ctx2.attachVodSource(w, 'https://openvibe.media/o/obj_4/master.m3u8', '/api/vods/file/e.webm'), 'file');
        assert.strictEqual(w.src, '/api/vods/file/e.webm');
    }
    {   // switching VODs drops the previous hls.js instance
        const { ctx, made } = sandbox();
        const v = new FakeVideo();
        await ctx.attachVodSource(v, 'https://openvibe.media/o/a/master.m3u8', '/f/a');
        await ctx.attachVodSource(v, 'https://openvibe.media/o/b/master.m3u8', '/f/b');
        assert.strictEqual(made[0].destroyed, true);
        assert.strictEqual(made[1].url, 'https://openvibe.media/o/b/master.m3u8');
    }
    // The media proxies keep Media's playlist URL on VOD and clip rows.
    for (const f of ['vods.js', 'clips.js']) {
        const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'media-proxy', f), 'utf8');
        assert.match(src, /hls_url = media\.publicUrl\(/, `${f} keeps hls_url`);
    }
    console.log('vod hls source: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
