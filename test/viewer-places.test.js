/**
 * Where a live stream is watched (owner, 2026-10-26: on a phone the viewer count left out Twitch, Kick, YouTube and
 * RobotStreamer, and "tapping it should show the different viewer counts across all platforms … and includes natural
 * openvibe viewers too").
 *
 * - server/streaming/viewer-places.js: OpenVibe first, then RobotStreamer, then the slot's platforms; a place with no
 *   number (count null) is listed and adds nothing.
 * - The channel route gives each live stream its viewer_places.
 * - The broadcaster's count comes from that same answer, not from the restream panel's destination list (empty when the
 *   go-live page loaded before a slot was picked: no count was asked for at all during the 10-26 phone stream).
 * - The channel player's count is the sum, and the player socket's and chat's live counts both feed OpenVibe's.
 *
 *   node test/viewer-places.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const { viewerPlaces, placeUrl } = require('../server/streaming/viewer-places');

// ── The list ──
let v = viewerPlaces({ native: 4 });
assert.deepStrictEqual(v, { total: 4, places: [{ key: 'openvibe', name: 'OpenVibe', count: 4, url: null }] }, 'OpenVibe alone');

v = viewerPlaces({
    native: 3,
    rs: { viewer_count: 2, robot_id: 'r 1' },
    platforms: [
        { platform: 'twitch', name: 'my twitch', count: 5, url: 'https://twitch.tv/goosely' },
        { platform: 'kick', name: 'Kick', count: 0, url: 'https://kick.com/goosely' },
        { platform: 'youtube', name: 'YT', count: null, url: 'https://youtube.com/@goosely/live' },
        { platform: 'custom', name: 'My relay', count: 1, url: null },
    ],
});
assert.deepStrictEqual(v.places.map((p) => [p.key, p.name, p.count]), [
    ['openvibe', 'OpenVibe', 3], ['robotstreamer', 'RobotStreamer', 2], ['twitch', 'Twitch', 5], ['kick', 'Kick', 0],
    ['youtube', 'YouTube', null], ['custom', 'My relay', 1],
], 'OpenVibe, RobotStreamer, then each platform by its own name');
assert.strictEqual(v.total, 11, 'the total adds every number; YouTube without a count adds nothing');
assert.strictEqual(v.places[1].url, 'https://robotstreamer.com/robot/r%201');
assert.strictEqual(viewerPlaces({ native: -2, platforms: [{ platform: 'openvibe', count: 9 }] }).places[1].key, 'custom', 'a destination cannot pose as OpenVibe');
assert.strictEqual(viewerPlaces({ native: -2 }).total, 0);

assert.strictEqual(placeUrl('youtube', 'https://www.youtube.com/@goosely/'), 'https://www.youtube.com/@goosely/live', 'YouTube goes to the live stream');
assert.strictEqual(placeUrl('youtube', 'https://www.youtube.com/watch?v=abc'), 'https://www.youtube.com/watch?v=abc');
assert.strictEqual(placeUrl('twitch', 'https://twitch.tv/goosely'), 'https://twitch.tv/goosely');
for (const bad of ['javascript:alert(1)', 'twitch.tv/x', '', null, 'https://x.tv/a b', 'https://x.tv/"onmouseover=1']) assert.strictEqual(placeUrl('twitch', bad), null, `${bad} is no link`);

// ── The channel route ──
const routes = read('server/streaming/routes.js');
assert.match(routes, /ls\.viewer_places = viewerPlaces\(\{ native: Math\.max\(ls\.viewer_count \|\| 0, sockets\), rs: rsInfo\[ls\.id\] \|\| null, platforms: ext\.breakdown \}\);/);
assert.match(routes, /ls\.total_viewer_count = ls\.viewer_places\.total;/);

// ── The broadcaster: one poll of the channel's answer, merged over its streams ──
const bc = read('public/js/broadcast.js');
assert.ok(!/_pollRestreamViewerCounts|_startRsViewerPoll|integration\/validate', \{ method: 'POST', body: \{ robot_input: rs\.robotId/.test(bc), 'the old destination-list and RobotStreamer polls are gone');
assert.match(bc, /api\(`\/streams\/channel\/\$\{encodeURIComponent\(currentUser\.username\)\}\?pollOnly=1`\)/);
const fnSrc = (src, name) => {
    const m = new RegExp(`\\n((?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\})\\n`).exec(src);
    assert.ok(m, `${name}() is there`);
    return m[1];
};
const ctx = { Map, Number, Math, String, Array, Object, window: {}, document: { getElementById: () => null } };
vm.createContext(ctx);
vm.runInContext(`const _perStreamViewerCounts = new Map(); let _serverViewerPlaces = [];
${fnSrc(bc, '_mergeViewerPlaces')}
${fnSrc(bc, 'broadcastViewerPlaces')}
this.merge = _mergeViewerPlaces; this.places = broadcastViewerPlaces;
this.setServer = (p) => { _serverViewerPlaces = p; }; this.signal = (id, n) => _perStreamViewerCounts.set(id, n);`, ctx);
const merged = ctx.merge([
    [{ key: 'openvibe', name: 'OpenVibe', count: 2 }, { key: 'twitch', name: 'Twitch', count: 5, url: null }, { key: 'youtube', name: 'YouTube', count: null }],
    [{ key: 'openvibe', name: 'OpenVibe', count: 1 }, { key: 'twitch', name: 'Twitch', count: 1, url: 'https://twitch.tv/b' }, { key: 'youtube', name: 'YouTube', count: null }],
]);
assert.deepStrictEqual(JSON.parse(JSON.stringify(merged)), [
    { key: 'openvibe', name: 'OpenVibe', count: 3 }, { key: 'twitch', name: 'Twitch', count: 6, url: 'https://twitch.tv/b' }, { key: 'youtube', name: 'YouTube', count: null },
], 'two streams: the same platform adds up, no-count stays no-count');
ctx.setServer(merged);
ctx.signal(7, 1);
assert.deepStrictEqual(Array.from(ctx.places(), (p) => p.count), [3, 6, null], "OpenVibe: the server's count when it is larger");
ctx.signal(8, 4);
assert.strictEqual(ctx.places()[0].count, 5, "…and signaling's when that is larger (instant)");
assert.match(bc, /for \(const id of \['bc-viewer-count', 'bc-rtmp-viewer-count', 'bc-jsmpeg-viewer-count', 'bc-whip-viewer-count'\]\)/, 'the OBS, JSMPEG and WHIP panels show it too (they said 0)');

// ── The phone studio: the pill shows that total, and a tap lists the places under it ──
const studio = read('public/js/broadcast-studio.js');
assert.match(studio, /el\('button', \{ type: 'button', class: 'bcs-pill bcs-viewers', id: 'bcs-viewers', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: toggleViewers \}/);
assert.match(studio, /OVViewerPlaces\.toggle\(\$\('bcs-viewers'\), viewerPlaces, \{ below: true \}\)/);

// ── The channel player: the sum, fed live by the socket and by chat ──
const ch = read('public/js/app-channel.js');
const painted = { text: null, title: null };
const badge = { dataset: {}, title: '', setAttribute() {}, addEventListener() {} };
const cctx = {
    Math, Number, String, Object, Array,
    window: { OVViewerPlaces: { summary: (p) => p.map((x) => `${x.count} on ${x.name}`).join(', '), update() {} } },
    document: { getElementById: (id) => (id === 'vc-viewers' ? { set textContent(t) { painted.text = t; } } : id === 'viewer-count-badge' ? badge : null) },
};
cctx.OVViewerPlaces = cctx.window.OVViewerPlaces;
vm.createContext(cctx);
const block = /\nconst _viewerCount = [\s\S]*?\nfunction _paintViewerCount\(\) \{[\s\S]*?\n\}\n/.exec(ch);
assert.ok(block, 'the viewer count block is in app-channel.js');
vm.runInContext(`${block[0]}; this.setPlaces = _setWatchedViewerPlaces; this.live = setLiveViewerCount; this.places = _watchedViewerPlaces;`, cctx);
cctx.setPlaces({ id: 41, viewer_places: { total: 9, places: [{ key: 'openvibe', name: 'OpenVibe', count: 2 }, { key: 'twitch', name: 'Twitch', count: 5 }, { key: 'kick', name: 'Kick', count: 2 }] } });
assert.strictEqual(painted.text, 9, 'the badge adds OpenVibe, Twitch and Kick');
assert.strictEqual(badge.title, '9 watching now: 2 on OpenVibe, 5 on Twitch, 2 on Kick');
cctx.live('socket', 6);
assert.strictEqual(painted.text, 13, 'a live socket count above the server\'s takes OpenVibe\'s place');
cctx.live('chat', 3, 99);
assert.strictEqual(painted.text, 13, 'a count for another stream of the channel is not this one\'s');
cctx.live('socket', 1);
cctx.live('chat', 1, 41);
assert.strictEqual(painted.text, 8, 'both down to 1: 1 + 5 + 2');
cctx.setPlaces({ id: 42, viewer_count: 4, external_viewer_count: 3 });
assert.strictEqual(painted.text, 7, 'another stream starts over; an older server\'s answer still adds up');
assert.match(read('public/js/stream-player.js'), /case 'viewer-count':\n\s+\/\/[^\n]*\n\s+if \(typeof setLiveViewerCount === 'function'\) setLiveViewerCount\('socket', msg\.count \|\| 0\);/);
assert.match(read('public/js/chat.js'), /updateViewerCount\(msg\.count, msg\.stream_id\);/);
assert.match(read('public/fragments/channel.html'), /<button type="button" class="viewer-badge" id="viewer-count-badge" aria-haspopup="dialog" aria-expanded="false"/);

// ── The panel loads with both pages ──
const features = JSON.parse(read('public/features.json')).features;
assert.deepStrictEqual(features.viewerPlaces, { css: ['/css/features/viewer-places.css'], js: ['/js/viewer-places.js'] });
assert.ok(features.channel.deps.includes('viewerPlaces') && features.broadcast.deps.includes('viewerPlaces'));
const panel = read('public/js/viewer-places.js');
const pctx = { window: {}, document: {}, Number, Object };
vm.createContext(pctx);
vm.runInContext(panel, pctx);
const P = pctx.window.OVViewerPlaces;
const sample = [{ key: 'openvibe', name: 'OpenVibe', count: 3 }, { key: 'twitch', name: 'Twitch', count: 1400 }, { key: 'youtube', name: 'YouTube', count: null }];
assert.strictEqual(P.total(sample), 1403);
assert.strictEqual(P.summary(sample), `3 on OpenVibe, ${(1400).toLocaleString()} on Twitch, live on YouTube`, 'the count\'s label names each place');
assert.strictEqual(P.isOpen(), false);
assert.ok(!/innerHTML/.test(panel), 'the panel builds nodes (destination names are the streamer\'s own text)');
assert.match(panel, /document\.fullscreenElement \|\| document\.webkitFullscreenElement/, 'in fullscreen the panel goes inside the fullscreen player');

console.log('✅ viewer places: one list for the channel player and the broadcaster, added up, OpenVibe first');
