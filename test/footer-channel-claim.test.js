/**
 * A channel's footer: compact while its stream plays, full while it is offline (owner, 2026-10-27: "you can use compact
 * footer on the live streamer channel when they are live only like openvibe.live/@goosely but it should be full mode
 * when not live"). The channel page claims compact from the shared footer (openvibe-shared 4.15 claim()) when it shows the
 * live state and releases it when it shows the offline state or the page is left; the page's own variant for a channel
 * is full. With an older shared footer (no claim) a channel stays compact, as before.
 *
 *   node test/footer-channel-claim.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('public/js/app-channel.js');
const fn = app.slice(app.indexOf('function _channelFooter('), app.indexOf('\n}\n', app.indexOf('function _channelFooter(')) + 3);

// The claim, run against a fake shared footer.
const calls = [];
const disposers = [];
const ctx = vm.createContext({
    window: { OpenVibeFooter: { claim: (v, k) => { calls.push(['claim', v, k]); return () => calls.push(['release', k]); } }, ov: true },
    ov: { scope: () => ({ onDispose: (f) => disposers.push(f) }) },
});
vm.runInContext(`let _footerRelease = null;\n${fn}\nthis._channelFooter = _channelFooter;`, ctx);
ctx._channelFooter(true);
ctx._channelFooter(true);
assert.deepStrictEqual(calls, [['claim', 'compact', 'channel-live']], 'one claim while live, however often the live state is drawn');
ctx._channelFooter(false);
assert.deepStrictEqual(calls.at(-1), ['release', 'channel-live'], 'released when the channel goes offline');
ctx._channelFooter(true);
disposers.forEach((d) => d());
assert.deepStrictEqual(calls.at(-1), ['release', 'channel-live'], 'released when the page is left');

// Both states draw it; the channel's own variant is full only when the footer can be claimed.
assert.ok(/\/\/ ── LIVE STATE ──[\s\S]{0,300}_channelFooter\(true\);/.test(app), 'the live state claims');
assert.ok(/getElementById\('ch-offline-area'\)\.style\.display = '';\n\s*_channelFooter\(false\);/.test(app), 'the offline state releases');
assert.ok(read('public/js/footer-live.js').includes("if (/^\\/@/.test(p)) return window.OpenVibeFooter && typeof OpenVibeFooter.claim === 'function' ? 'full' : 'compact';"));

console.log('channel footer: compact while live, full while offline');
