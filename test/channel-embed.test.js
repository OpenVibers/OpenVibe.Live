'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const zlib = require('zlib');
const embed = require('../server/streaming/channel-embed');

assert.ok(embed.html().includes('/js/stream-player.js'));
assert.ok(embed.html().includes('/js/channel-embed.js'));
assert.ok(embed.html(['https://openvibe.live']).includes('https://openvibe.live'));
const clientSource = fs.readFileSync(require('path').join(__dirname, '../public/js/channel-embed.js'), 'utf8');
assert.match(clientSource, /if \(!stream\)/, 'offline channels render an offline state');
assert.match(clientSource, /stream\.is_nsfw/, '18+ streams stop at the age gate');
const scripts = ['public/js/stream-player.js', 'public/js/channel-embed.js'];
const bytes = scripts.reduce((n, f) => n + zlib.brotliCompressSync(fs.readFileSync(require('path').join(__dirname, '..', f))).length, 0);
assert.ok(bytes < 60 * 1024, `embed scripts are ${bytes} bytes brotli`);

let onMessage;
const video = { muted: true, paused: true, play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; }, addEventListener() {} };
const context = {
    window: { __OV_EMBED_ORIGINS: ['https://openvibe.live'] }, parent: { postMessage() {} }, location: { pathname: '/embed/alice' },
    document: { getElementById(id) { return id === 'video-element' ? video : { addEventListener() {}, click() {}, style: {}, set textContent(v) {}, set innerHTML(v) {} }; } },
    addEventListener(type, fn) { if (type === 'message') onMessage = fn; }, setInterval() {}, fetch: async () => ({ ok: false }),
};
vm.runInNewContext(clientSource, context);
onMessage({ origin: 'https://evil.example', source: context.parent, data: { type: 'ov-embed', cmd: 'unmute' } });
assert.strictEqual(video.muted, true, 'untrusted origin cannot control playback');
onMessage({ origin: 'https://openvibe.live', source: context.parent, data: { type: 'ov-embed', cmd: 'unmute' } });
assert.strictEqual(video.muted, false, 'allowlisted parent can control playback');
(async () => {
    const dbPath = require.resolve('../server/db/database');
    const egressPath = require.resolve('../server/net/egress');
    const oldDbModule = require.cache[dbPath];
    const oldEgressModule = require.cache[egressPath];
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
        getChannelByUsername: async (name) => name.toLowerCase() === 'embedcheck' ? { username: name } : null,
        getUserByUsername: async (name) => name.toLowerCase() === 'embedcheck' ? { username: name } : null,
    } };
    require.cache[egressPath] = { id: egressPath, filename: egressPath, loaded: true, exports: { fetchText: async () => ({ status: 200, text: JSON.stringify({ nav: [{ url: 'https://openvibe.live/' }, { url: 'https://openvibe.network/' }] }) }) } };
    const previousFetch = global.fetch;
    const response = () => ({ headers: {}, statusCode: 200, set(k, v) { this.headers[k] = v; return this; }, status(n) { this.statusCode = n; return this; }, sendStatus(n) { this.statusCode = n; return this; }, type() { return this; }, send(body) { this.body = body; return this; } });
    const known = response();
    await embed.page({ params: { username: '@embedcheck' } }, known);
    assert.strictEqual(known.statusCode, 200, 'known channel route is served');
    assert.match(known.headers['Content-Security-Policy'], /frame-ancestors 'self' https:\/\/openvibe\.live https:\/\/openvibe\.network https:\/\/\*\.openvibe\.website/);
    const missing = response();
    await embed.page({ params: { username: 'missing' } }, missing);
    assert.strictEqual(missing.statusCode, 404, 'unknown channel route is 404');
    global.fetch = previousFetch;

    delete require.cache[require.resolve('../server/web/page-status')];
    const status = require('../server/web/page-status').statusFor;
    assert.strictEqual(await status({ path: '/embed/embedcheck' }), 200, 'known channels reach the embed route');
    assert.strictEqual(await status({ path: '/embed/no-such-channel' }), 404, 'unknown channels remain 404');
    delete require.cache[require.resolve('../server/web/page-status')];
    if (oldDbModule) require.cache[dbPath] = oldDbModule; else delete require.cache[dbPath];
    if (oldEgressModule) require.cache[egressPath] = oldEgressModule; else delete require.cache[egressPath];

    const simulate = async (payload) => {
        const elements = Object.fromEntries(['video-element', 'live', 'offline', 'gate', 'continue', 'video-container', 'btn-volume', 'btn-play-pause'].map((id) => [id, { hidden: false, style: {}, addEventListener() {}, click() {} }]));
        const playerCalls = [];
        const sent = [];
        const browser = {
            window: { __OV_EMBED_ORIGINS: ['https://openvibe.live'] },
            parent: { postMessage(data, target) { sent.push({ data, target }); } }, location: { pathname: '/embed/alice' },
            document: { getElementById(id) { return elements[id]; } }, addEventListener() {}, setInterval() {},
            fetch: async () => ({ ok: true, json: async () => payload }), initPlayer(stream) { playerCalls.push(stream); },
        };
        browser.window.parent = browser.parent;
        vm.runInNewContext(clientSource, browser);
        await new Promise((resolve) => setImmediate(resolve));
        return { elements, playerCalls, sent };
    };
    const liveResult = await simulate({ channel: { username: 'alice', display_name: 'Alice' }, streams: [{ id: 2, is_live: true, title: 'Public show' }] });
    assert.strictEqual(liveResult.playerCalls.length, 1, 'live channel starts the shared player');
    assert.strictEqual(liveResult.sent.at(-1).data.live, true, 'live state is announced to the parent');
    const offlineResult = await simulate({ channel: { username: 'alice', display_name: 'Alice' }, streams: [] });
    assert.strictEqual(offlineResult.elements.offline.style.display, 'block', 'offline channel shows the offline card');
    const gatedResult = await simulate({ channel: { username: 'alice' }, streams: [{ id: 3, is_live: true, is_nsfw: true }] });
    assert.strictEqual(gatedResult.elements.gate.style.display, 'grid', '18+ channel shows the age gate');
    assert.strictEqual(gatedResult.playerCalls.length, 0, '18+ player waits for confirmation');
    gatedResult.elements.continue.onclick();
    assert.strictEqual(gatedResult.playerCalls.length, 1, '18+ confirmation starts the player');
    console.log('channel embed route, origin, and size checks passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
