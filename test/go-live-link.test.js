/**
 * Going live hands over the link to share (the owner, 2026-10-28: streamers copied the studio's /broadcast address):
 * the channel's chat says "… is live. Share the stream: …/@name" once (server/streaming/live-events.js postLiveLink),
 * the studio shows its address as /@name/studio, which opens the channel for anyone else (public/js/app.js), and the
 * studio's go-live card hands over the link (public/js/broadcast-studio.js celebrate).
 *
 *   node test/go-live-link.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';

(async () => {
    let failures = 0;
    const check = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failures++; console.log(`  ✗ ${name}\n    ${err.stack}`); } };

    const lines = [];
    require.cache[require.resolve('../server/chat/chat-delivery')] = {
        id: 'chat-delivery', loaded: true,
        exports: { message: async (line) => { lines.push(line); return 1; }, after: (v, fn) => (v && v.then ? v.then(fn) : fn(v)) },
    };
    const liveEvents = require('../server/streaming/live-events');

    await check('a stream going live puts its plain link in the channel\'s chat, once', async () => {
        liveEvents.announceGoLive({ id: 501, user_id: 9, managed_stream_id: 77, managed_stream_slug: 'my-second-stream' }, { id: 9, username: 'goosely', display_name: 'Goosely' });
        await new Promise((r) => setImmediate(r));
        assert.strictEqual(lines.length, 1);
        const l = lines[0];
        assert.match(l.message, /^🔴 Goosely is live\. Share the stream: https?:\/\/[^ ]+\/@goosely$/);
        assert.ok(!l.message.includes('my-second-stream'), 'never the stream\'s slug');
        assert.deepStrictEqual([l.stream_id, l.channel_user_id, l.user_id, l.message_type, l.key], [501, 9, null, 'system', 'live:link:501']);
        assert.strictEqual(l.metadata.kind, 'live_link');
        liveEvents.announceGoLive({ id: 502, user_id: 9, managed_stream_id: 77 }, { id: 9, username: 'goosely' });
        await new Promise((r) => setImmediate(r));
        assert.strictEqual(lines.length, 1, 'a quick reconnect within the hour says nothing again');
    });

    await check('the studio shows /@name/studio, which opens the studio for its owner and the channel for anyone else', async () => {
        const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
        const fn = /function showStudioAddress\(\) \{[\s\S]*?\n\}/.exec(app);
        assert.ok(fn, 'showStudioAddress is in app.js');
        assert.match(app, /loadBroadcastPage\(\); showStudioAddress\(\);/, 'the studio route shows it');
        const calls = [];
        const run = new Function('location', 'currentUser', 'history', `${fn[0]}; showStudioAddress();`);
        run({ pathname: '/broadcast', search: '', hash: '' }, { username: 'goosely' }, { state: null, replaceState: (s, t, u) => calls.push(u) });
        run({ pathname: '/broadcast/slot-2', search: '', hash: '' }, { username: 'goosely' }, { state: null, replaceState: (s, t, u) => calls.push(u) });
        run({ pathname: '/broadcast', search: '', hash: '' }, null, { state: null, replaceState: (s, t, u) => calls.push(u) });
        assert.deepStrictEqual(calls, ['/@goosely/studio'], 'only the plain studio of a signed-in streamer');
        assert.match(app, /segments\[1\] === 'studio'\) \{[\s\S]{0,400}navigate\(mine \? `\/broadcast\$\{location\.search\}` : `\/@\$\{username\}`, true\)/, 'the route sends everyone else to the channel');
    });

    await check('the studio hands over the link when it goes live, and on the desktop control row', async () => {
        const studio = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'broadcast-studio.js'), 'utf8');
        assert.match(studio, /function celebrate\(streamId\)/);
        assert.match(studio, /window\.bcStudio = \{[^}]*copyLink, celebrate, streamLink/);
        const bc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'broadcast.js'), 'utf8');
        assert.match(bc, /bcStudio\.celebrate\(streamData\.id\)/);
        const frag = fs.readFileSync(path.join(__dirname, '..', 'public', 'fragments', 'broadcast.html'), 'utf8');
        assert.match(frag, /onclick="window\.bcStudio && bcStudio\.copyLink\(this\)"/);
    });

    if (failures) { console.log(`\ngo-live link: ${failures} failed`); process.exit(1); }
    console.log('\ngo-live link: all checks passed');
})();
