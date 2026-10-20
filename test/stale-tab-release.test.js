/**
 * A tab left open across a deploy loads its next page in full (public/js/app.js, _ovRelease and navigate()).
 *
 * On 2026-10-20 a phone tab opened before recordings moved to openvibe.video got https://openvibe.video/v/5857 as a VOD's
 * link from the new API, and its old navigate() put that under Live's address: openvibe.live/https://openvibe.video/v/…,
 * "Page not found". The shell now carries its client release (the ov-assets block, server/web/assets.js) and the tab
 * compares it with GET /api/client-release when it comes back into view or changes route. Runs app.js's release block
 * and navigate() in a sandbox with a fake document, history, location and fetch.
 *
 *   node test/stale-tab-release.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const start = src.indexOf('const _ovRelease = ');
const end = src.indexOf('const DEFAULT_PAGE_TITLE');
assert.ok(start > 0 && end > start, 'the release block and navigate() are in app.js, in that order');
const block = src.slice(start, end);

function sandbox({ loaded = 'aaaaaaaaaaaa', current = 'bbbbbbbbbbbb', stored = null } = {}) {
    const calls = [];
    const listeners = {};
    const store = new Map(stored ? [['ov-release-load', stored]] : []);
    const ctx = {
        calls,
        console,
        Date,
        document: {
            visibilityState: 'visible',
            getElementById: (id) => (id === 'ov-assets' && loaded ? { textContent: JSON.stringify({ v: {}, release: loaded }) } : null),
            addEventListener: (type, fn) => { listeners[type] = fn; },
        },
        window: { addEventListener: (type, fn) => { listeners[`window:${type}`] = fn; } },
        location: {
            origin: 'https://openvibe.live',
            assign: (u) => calls.push(['assign', u]),
            replace: (u) => calls.push(['replace', u]),
            set href(u) { calls.push(['href', u]); },
        },
        history: {
            pushState: (s, t, u) => calls.push(['push', u]),
            replaceState: (s, t, u) => calls.push(['replaceState', u]),
        },
        sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
        fetch: async (url) => { calls.push(['fetch', url]); return { ok: true, json: async () => ({ release: current }) }; },
        teardownRoute: () => calls.push(['teardown']),
        routeFromURL: () => calls.push(['route']),
    };
    vm.createContext(ctx);
    vm.runInContext(block, ctx);
    return {
        ctx, calls, listeners, store,
        run: (code) => vm.runInContext(code, ctx),
        // As if five minutes had gone by since the last check.
        later: () => vm.runInContext('_ovRelease.checkedAt = 0', ctx),
        settle: () => new Promise((r) => setImmediate(r)),
    };
}

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); } catch (e) { failures++; console.log('  ✗', name, '\n     ', e.stack); }
}

(async () => {
    await check('an up-to-date tab switches routes in place, and off-site links leave', async () => {
        const t = sandbox({ current: 'aaaaaaaaaaaa' });
        t.later();
        t.listeners.visibilitychange();
        await t.settle();
        t.run("navigate('/content?type=vods')");
        t.run("navigate('https://openvibe.video/v/5857')");
        assert.deepStrictEqual(t.calls, [['fetch', '/api/client-release'], ['teardown'], ['push', '/content?type=vods'], ['route'], ['href', 'https://openvibe.video/v/5857']]);
    });

    await check('a tab that comes back into view running an older client loads its next page in full, once', async () => {
        const t = sandbox();
        t.later();
        t.listeners.visibilitychange();
        await t.settle();
        t.run("navigate('/@goosely')");
        assert.deepStrictEqual(t.calls.slice(1), [['assign', '/@goosely']], 'no route switch on old code');
        assert.strictEqual(t.store.get('ov-release-load'), 'bbbbbbbbbbbb');
        t.calls.length = 0;
        t.run("navigate('/vods', true)");
        assert.deepStrictEqual(t.calls, [['replace', '/vods']]);
    });

    await check('it asks at most every five minutes, and not while hidden', async () => {
        const t = sandbox();
        t.listeners.visibilitychange();
        t.run("navigate('/a')");
        await t.settle();
        assert.ok(!t.calls.some((c) => c[0] === 'fetch'), 'just loaded: no check');
        t.later();
        t.ctx.document.visibilityState = 'hidden';
        t.listeners.visibilitychange();
        await t.settle();
        assert.ok(!t.calls.some((c) => c[0] === 'fetch'), 'hidden: no check');
        t.ctx.document.visibilityState = 'visible';
        t.run("navigate('/b')");
        await t.settle();
        assert.strictEqual(t.calls.filter((c) => c[0] === 'fetch').length, 1, 'a route change checks too');
        t.calls.length = 0;
        t.run("navigate('/c')");
        assert.deepStrictEqual(t.calls, [['assign', '/c']]);
    });

    await check('never while the tab holds a broadcast or a call', async () => {
        for (const holder of [
            'var broadcastState = { streams: new Map([[1, { localStream: {} }]]) };',
            'var callState = { joined: true, connecting: false };',
        ]) {
            const t = sandbox();
            t.run(holder);
            t.later();
            t.listeners.visibilitychange();
            await t.settle();
            t.calls.length = 0;
            t.run("navigate('/chat')");
            assert.deepStrictEqual(t.calls, [['teardown'], ['push', '/chat'], ['route']], holder);
        }
    });

    await check('a shell that still disagrees after the full load is not reloaded again', async () => {
        const t = sandbox({ stored: 'bbbbbbbbbbbb' });
        t.later();
        t.listeners.visibilitychange();
        await t.settle();
        t.calls.length = 0;
        t.run("navigate('/moments')");
        assert.deepStrictEqual(t.calls, [['teardown'], ['push', '/moments'], ['route']]);
    });

    await check('a page without the manifest never asks', async () => {
        const t = sandbox({ loaded: null });
        t.later();
        t.listeners.visibilitychange();
        t.listeners['window:pageshow']({ persisted: true });
        await t.settle();
        assert.deepStrictEqual(t.calls, []);
    });

    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
    console.log('\nstale tab release: all checks passed');
})();
