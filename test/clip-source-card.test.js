/**
 * The clip page's "From this stream" card (public/js/context-cards.js) asks /api/vods/:id/context
 * only when the source VOD can answer: a clip whose VOD is gone or hidden (vod_visible === false
 * from GET /api/clips/:id) makes no request, so the page logs no 404 (browser check, /clip/369).
 * An older answer without vod_visible still asks, as before.
 *
 *   node test/clip-source-card.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'context-cards.js'), 'utf8');

(async () => {
    const calls = [];
    const host = { innerHTML: '', style: {}, classList: { add() {} } };
    const ctx = {
        window: {},
        document: { getElementById: (id) => (id === 'clp-stream-source' ? host : null) },
        api: async (p) => { calls.push(p); return { vod: { id: 7, duration_seconds: 100, visibility: 'public' }, clips: [] }; },
        esc: (s) => String(s), timeAgo: () => '', handleLinkClick: () => false,
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(src, ctx);

    await ctx.renderClipSourceCard({ id: 1, vod_id: 5541, vod_visible: false, vod_available: false });
    assert.deepStrictEqual(calls, [], 'a missing source VOD is not asked for');
    assert.strictEqual(host.innerHTML, '', 'the plain text fallback stays');

    await ctx.renderClipSourceCard({ id: 1, vod_id: 7, vod_visible: true, vod_available: true, start_time: 10, end_time: 20 });
    assert.deepStrictEqual(calls, ['/vods/7/context']);
    assert.match(host.innerHTML, /From this stream/);

    await ctx.renderClipSourceCard({ id: 1, vod_id: 8 });
    assert.deepStrictEqual(calls, ['/vods/7/context', '/vods/8/context'], 'no vod_visible (older server): asks as before');

    console.log('clip source card: no context request for a missing source VOD');
})().catch((e) => { console.error(e); process.exit(1); });
