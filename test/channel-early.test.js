/**
 * A channel page asks for its own data while it is still being read (server/seo/pages.js CHANNEL_EARLY; 2026-11-19: on a
 * phone the channel's data was asked only after every script ran, and its content painted at 3.1 s at 4x CPU):
 *   - for a visitor with no stored sign-in on /@name, the page's head asks exactly the two paths loadChannelPage asks
 *     (the channel with its first videos and clips, and its most watched), with the page sizes app-channel.js uses;
 *   - with any stored sign-in (token, ov_token, the ov_token cookie), on any other path, or with a name the router would
 *     not take, it asks nothing;
 *   - app-channel.js takes an early answer once, for the same path, while fresh (20 s), and asks itself otherwise.
 *
 *   node test/channel-early.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

process.env.NODE_ENV = 'test';
const { CHANNEL_EARLY } = require('../server/seo/pages');
const appChannel = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-channel.js'), 'utf8');

let failures = 0;
const check = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failures++; console.log(`  ✗ ${name}\n    ${err.stack}`); } };

/** Run the head's script in a stand-in window: { asked: [paths], early: window.__ovEarly }. */
function runEarly({ pathname = '/@maticus', storage = {}, cookie = '' } = {}) {
    const asked = [];
    const win = {
        location: { pathname },
        localStorage: { getItem: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null) },
        document: { cookie },
        fetch: (url, opts) => { asked.push({ url, opts }); return Promise.resolve({ ok: true, json: () => Promise.resolve({ channel: { username: 'maticus' }, url }) }); },
        Date, Math, encodeURIComponent,
    };
    win.window = win;
    const body = CHANNEL_EARLY.replace(/^<script>/, '').replace(/<\/script>$/, '');
    vm.runInNewContext(body, win);
    return { asked: asked.map((a) => a.url), opts: asked.map((a) => a.opts), early: win.__ovEarly };
}

(async () => {
    await check('the page sizes and paths are the ones loadChannelPage asks', async () => {
        const vods = Number((/const CHANNEL_VODS_PAGE_SIZE = (\d+);/.exec(appChannel) || [])[1]);
        const clips = Number((/const CHANNEL_CLIPS_PAGE_SIZE = (\d+);/.exec(appChannel) || [])[1]);
        assert.ok(vods > 0 && clips > 0, 'app-channel.js page sizes');
        assert.ok(CHANNEL_EARLY.includes(`'?vodLimit=${vods}&vodOffset=0&clipLimit=${clips}&clipOffset=0'`), 'the channel path with the same sizes');
        assert.match(appChannel, /const channelPath = `\/streams\/channel\/\$\{username\}\?vodLimit=\$\{CHANNEL_VODS_PAGE_SIZE\}&vodOffset=\$\{channelVodOffset\}&clipLimit=\$\{CHANNEL_CLIPS_PAGE_SIZE\}&clipOffset=\$\{channelClipOffset\}\$\{initialVodExtra\}`;/);
        assert.match(appChannel, /const popularPath = `\/streams\/channel\/\$\{encodeURIComponent\(username\)\}\/popular`;/);
        assert.match(appChannel, /const earlyChannel = isNewChannel \? _takeEarly\(channelPath\) : null;/);
    });

    await check('a visitor with no stored sign-in on /@name: the two answers are asked at once', async () => {
        const r = runEarly();
        assert.deepStrictEqual(r.asked, ['/api/streams/channel/maticus?vodLimit=12&vodOffset=0&clipLimit=12&clipOffset=0', '/api/streams/channel/maticus/popular']);
        assert.ok(!r.opts.some((o) => o.headers && o.headers.Authorization), 'never with a credential');
        assert.deepStrictEqual(Object.keys(r.early).sort(), ['/streams/channel/maticus/popular', '/streams/channel/maticus?vodLimit=12&vodOffset=0&clipLimit=12&clipOffset=0']);
        assert.strictEqual((await r.early['/streams/channel/maticus/popular'].p).channel.username, 'maticus');
        assert.deepStrictEqual(runEarly({ pathname: '/@maticus/' }).asked.length, 2, 'a trailing slash is the same page');
    });

    await check('a stored sign-in, another path or a name the router refuses: nothing is asked', async () => {
        assert.deepStrictEqual(runEarly({ storage: { token: 'a.b.c' } }).asked, []);
        assert.deepStrictEqual(runEarly({ storage: { ov_token: 'a.b.c' } }).asked, []);
        assert.deepStrictEqual(runEarly({ cookie: 'x=1; ov_token=a.b.c' }).asked, []);
        for (const p of ['/', '/@maticus/videos', '/@maticus/studio', '/@ab', '/@this_name_is_far_too_long_x', '/@bad%20name', '/vod/12']) {
            assert.deepStrictEqual(runEarly({ pathname: p }).asked, [], p);
        }
    });

    await check('app-channel.js takes an early answer once, for the same path, while fresh', async () => {
        const src = /function _takeEarly\(path\) \{[\s\S]*?\n\}/.exec(appChannel);
        assert.ok(src, '_takeEarly is in app-channel.js');
        const now = { t: 1_000_000 };
        const ctx = { window: {}, Date: { now: () => now.t } };
        vm.runInNewContext(`${src[0]}; this.take = _takeEarly;`, ctx);
        const p = Promise.resolve({ channel: {} });
        ctx.window.__ovEarly = { '/a': { at: now.t, p }, '/b': { at: now.t - 25000, p } };
        assert.strictEqual(ctx.take('/a'), p, 'the same path, fresh');
        assert.strictEqual(ctx.take('/a'), null, 'once');
        assert.strictEqual(ctx.take('/b'), null, 'a stale one is not used');
        assert.strictEqual(ctx.take('/c'), null, 'another path');
        ctx.window.__ovEarly = undefined;
        assert.strictEqual(ctx.take('/a'), null, 'no early answers at all');
    });

    process.stdout.write(failures ? `\n${failures} failed\n` : '\nall passed\n');
    process.exit(failures ? 1 : 0);
})();
