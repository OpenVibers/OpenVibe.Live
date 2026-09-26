/**
 * Legacy parity (roadmap D20): opt-in audible disconnect and low-bitrate alerts for the broadcaster.
 *
 * Runs the broadcast page's own alert functions (public/js/broadcast.js) against a small fake DOM:
 *   - a browser broadcast's connection dropping shows the banner; the beep sounds only when opted in;
 *   - an encoder's RTMP feed stopping after it was received does the same (before, only browser
 *     connection states raised it, so the encoder settings' "Disconnect Audio" toggle never sounded,
 *     and the banner was put inside the hidden browser section);
 *   - a connected browser broadcast whose upload stays under 30% of its target for three stats samples
 *     warns once per episode, with a lower beep, only when opted in (this alert was missing);
 *   - both preferences are off by default, kept in this browser, and restored into every toggle.
 *
 *   node test/broadcast-alerts.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const bc = read('public/js/broadcast.js');
const fragment = read('public/fragments/broadcast.html');

/** The source of a top-level function declaration, braces matched. */
function extract(src, name) {
    const m = new RegExp(`(?:async )?function ${name}\\(`).exec(src);
    assert.ok(m, `${name}() must exist`);
    let i = src.indexOf('{', m.index);
    let depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(m.index, i + 1);
    }
    throw new Error(`unbalanced ${name}`);
}
const constant = (name) => Number(new RegExp(`const ${name} = ([\\d.]+);`).exec(bc)[1]);

/** A tiny DOM: elements by id, each with style/className/textContent and an insertBefore log. */
function fakeDom(mode) {
    const els = {};
    const inserted = [];
    const parent = { insertBefore: (node, before) => inserted.push([node.id, before.id]) };
    const el = (id, extra = {}) => (els[id] = { id, style: {}, className: '', textContent: '', innerHTML: '', parentElement: parent, previousElementSibling: null, ...extra });
    for (const id of ['bc-rtmp-status', 'bc-rtmp-status-spinner', 'bc-rtmp-status-ok', 'bc-rtmp-status-label', 'bc-rtmp-status-detail', 'bc-live-section', 'bc-connection-status']) el(id);
    el('bc-browser-broadcast', { style: { display: mode === 'browser' ? '' : 'none' } });
    const videoBox = { id: 'bc-video-container', parentElement: parent, previousElementSibling: null };
    const document = {
        getElementById: (id) => els[id] || null,
        createElement: () => ({ id: '', className: '', style: {}, innerHTML: '' }),
        querySelector: (sel) => (sel === '.bc-video-container' ? videoBox : null),
    };
    return { els, inserted, document };
}

const NAMES = ['_alertOptIn', '_playDisconnectBeep', 'showDisconnectAlert', 'dismissDisconnectAlert', '_checkLowBitrate',
    'setRtmpStatusUI', 'stopRtmpStatusPoll', 'updateBroadcastStatus'];
const SRC = NAMES.map((n) => extract(bc, n)).join('\n');

function page({ mode = 'browser', stored = {} } = {}) {
    const dom = fakeDom(mode);
    const beeps = [];
    const toasts = [];
    const fixtures = {
        document: dom.document,
        localStorage: { getItem: (k) => (k in stored ? stored[k] : null), setItem: (k, v) => { stored[k] = v; } },
        _playAlertBeep: (hz) => beeps.push(hz),
        toast: (msg, kind) => toasts.push([msg, kind]),
        getTargetVideoBitrate: () => 2500 * 1000,
        getActiveStreamState: () => ({ streamData: { id: 5, protocol: mode === 'browser' ? 'webrtc' : 'rtmp' } }),
        startRtmpPreview: () => {}, stopRtmpPreview: () => {},
        clearInterval: () => {},
        LOW_BITRATE_RATIO: constant('LOW_BITRATE_RATIO'),
        LOW_BITRATE_SAMPLES: constant('LOW_BITRATE_SAMPLES'),
        _disconnectAlertShown: false, _rtmpWasReceiving: false, _rtmpFeedLost: false, _rtmpStatusPollTimer: null,
    };
    const scope = new Proxy(fixtures, {
        has: (t, k) => typeof k === 'string',
        get: (t, k) => (k === Symbol.unscopables ? undefined : (k in t ? t[k] : globalThis[k])),
        set: (t, k, v) => { t[k] = v; return true; },
    });
    // eslint-disable-next-line no-new-func
    const fns = new Function('scope', `with (scope) { ${SRC}\n return { ${NAMES.join(', ')} }; }`)(scope);
    // The opt-ins start from what this browser stored, exactly as the page's declarations do.
    fixtures._disconnectAudioEnabled = fns._alertOptIn('bc-disconnect-audio');
    fixtures._lowBitrateAlertEnabled = fns._alertOptIn('bc-lowbitrate-audio');
    const banner = () => fixtures.document.getElementById('bc-disconnect-alert') || dom.inserted.length;
    return { fns, fixtures, dom, beeps, toasts, banner };
}

// ── the declarations: off by default, from this browser's storage ──
assert.match(bc, /let _disconnectAudioEnabled = _alertOptIn\('bc-disconnect-audio'\);/);
assert.match(bc, /let _lowBitrateAlertEnabled = _alertOptIn\('bc-lowbitrate-audio'\);/);
let p = page();
assert.deepStrictEqual([p.fixtures._disconnectAudioEnabled, p.fixtures._lowBitrateAlertEnabled], [false, false], 'both off by default');
p = page({ stored: { 'bc-disconnect-audio': '1', 'bc-lowbitrate-audio': '1' } });
assert.deepStrictEqual([p.fixtures._disconnectAudioEnabled, p.fixtures._lowBitrateAlertEnabled], [true, true], 'an opt-in survives a reload');
console.log('OK both alerts are opt-in, remembered in this browser');

// ── browser broadcast disconnects ──
p = page();
p.fns.updateBroadcastStatus('disconnected');
assert.ok(p.fixtures._disconnectAlertShown, 'the banner shows without the opt-in');
assert.deepStrictEqual(p.dom.inserted[0], ['bc-disconnect-alert', 'bc-video-container'], 'above the browser preview');
assert.deepStrictEqual(p.beeps, [], 'but no sound');
p.fns.updateBroadcastStatus('connected');
assert.ok(!p.fixtures._disconnectAlertShown, 'reconnecting clears it');

p = page({ stored: { 'bc-disconnect-audio': '1' } });
p.fns.updateBroadcastStatus('failed');
p.fns.updateBroadcastStatus('disconnected');
assert.deepStrictEqual(p.beeps, [800], 'opted in: one disconnect beep per drop, not one per status update');
p.fns.updateBroadcastStatus('connected');
p.fns.updateBroadcastStatus('disconnected');
assert.deepStrictEqual(p.beeps, [800, 800], 'and again on the next drop');
console.log('OK a browser broadcast\'s drop: banner always, beep when opted in');

// ── encoder (RTMP) feed ──
p = page({ mode: 'rtmp', stored: { 'bc-disconnect-audio': '1' } });
p.fns.setRtmpStatusUI(false);
assert.ok(!p.fixtures._disconnectAlertShown, 'waiting for the encoder is not a disconnect');
p.fns.setRtmpStatusUI(true, new Date().toISOString());
assert.ok(!p.fixtures._disconnectAlertShown);
p.fns.setRtmpStatusUI(false);
assert.ok(p.fixtures._disconnectAlertShown, 'the feed stopping after it was received is');
assert.deepStrictEqual(p.beeps, [800], 'with the same opt-in beep');
assert.deepStrictEqual(p.dom.inserted[0], ['bc-disconnect-alert', 'bc-rtmp-status'], 'shown above the RTMP feed status (the browser section is hidden)');
p.fns.setRtmpStatusUI(false);
assert.deepStrictEqual(p.beeps, [800], 'polls while it stays down do not beep again');
p.fns.setRtmpStatusUI(true, new Date().toISOString());
assert.ok(!p.fixtures._disconnectAlertShown, 'the feed coming back clears it');
p.fns.setRtmpStatusUI(false);
p.fns.stopRtmpStatusPoll();
assert.ok(!p.fixtures._disconnectAlertShown, 'ending the stream (or leaving the page) clears it');
p.fns.setRtmpStatusUI(false);
assert.deepStrictEqual(p.beeps, [800, 800], 'and a new poll starts from "waiting", not from "lost"');
console.log('OK an encoder\'s RTMP feed stopping raises the same alert');

// ── low bitrate ──
const target = 2500;
const low = Math.floor(target * constant('LOW_BITRATE_RATIO')) - 1;
p = page();
let ss = {};
for (let i = 0; i < 6; i++) p.fns._checkLowBitrate(ss, low, 'connected');
assert.deepStrictEqual([p.toasts.length, p.beeps.length], [0, 0], 'not opted in: nothing');

p = page({ stored: { 'bc-lowbitrate-audio': '1' } });
ss = {};
p.fns._checkLowBitrate(ss, low, 'connected');
p.fns._checkLowBitrate(ss, low, 'connected');
assert.strictEqual(p.toasts.length, 0, 'one or two low samples are a blip');
p.fns._checkLowBitrate(ss, low, 'connected');
assert.strictEqual(p.toasts.length, 1, 'three in a row (≈18 s) warn');
assert.match(p.toasts[0][0], new RegExp(`Low bitrate: ${low} kbps of ${target} kbps`));
assert.deepStrictEqual(p.beeps, [440], 'with a lower beep than a disconnect');
for (let i = 0; i < 5; i++) p.fns._checkLowBitrate(ss, low, 'connected');
assert.strictEqual(p.toasts.length, 1, 'once per episode');
p.fns._checkLowBitrate(ss, 2400, 'connected');
for (let i = 0; i < 3; i++) p.fns._checkLowBitrate(ss, low, 'connected');
assert.strictEqual(p.toasts.length, 2, 'a new episode after it recovered warns again');

p = page({ stored: { 'bc-lowbitrate-audio': '1' } });
ss = {};
for (let i = 0; i < 4; i++) p.fns._checkLowBitrate(ss, 0, 'connected');                                 // still measuring
for (let i = 0; i < 4; i++) p.fns._checkLowBitrate(ss, low, 'checking');                                // (re)connecting
for (let i = 0; i < 4; i++) p.fns._checkLowBitrate(ss, Math.ceil(target * constant('LOW_BITRATE_RATIO')) + 1, 'connected');
assert.strictEqual(p.toasts.length, 0, 'no warning while measuring, while not connected, or at 30% and above');
console.log('OK low bitrate: opt-in, after ~18 s under 30% of target, once per episode');

// ── wiring ──
assert.match(bc, /_checkLowBitrate\(ss, hasStats \? bitrateKbps : 0, connState\);\s*\} finally \{/, 'every stats sample of the active stream is checked');
assert.match(fragment, /id="bc-disconnectAudio" onchange="_disconnectAudioEnabled = this\.checked; try \{ localStorage\.setItem\('bc-disconnect-audio'/);
assert.match(fragment, /id="bc-ext-disconnectAudio" onchange="_disconnectAudioEnabled = this\.checked; localStorage\.setItem\('bc-disconnect-audio'/);
assert.match(fragment, /id="bc-lowBitrateAudio" onchange="_lowBitrateAlertEnabled = this\.checked; try \{ localStorage\.setItem\('bc-lowbitrate-audio'/);
const sync = extract(bc, 'syncSettingsUI');
for (const id of ['bc-disconnectAudio', 'bc-ext-disconnectAudio', 'bc-lowBitrateAudio']) {
    assert.ok(sync.includes(`setCheck('${id}'`), `the settings sync shows the stored preference in #${id}`);
}
console.log('OK toggles in both settings panels, restored on load');

console.log('\n✅ broadcaster alert checks passed');
process.exit(0);
