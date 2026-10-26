'use strict';
// Sound on the stream page (the owner, 2026-10-26: people "having to refresh the stream page over and over again, or
// click or something like that, to get audio to come back properly … so that people don't even realize they're
// enabling it").
//
// Two causes:
//   1. A broadcaster whose network drops produces again on a new transport while the old producers stay open on the
//      dead one. Viewers already watching kept consuming those: a frozen picture and no sound until a reload. A
//      re-watch only asked the dead producer for a keyframe. Now the server moves them: a re-watch on a stale
//      producer gets a fresh consume of the current ones, a new producer taking over sends `sfu-source-moved`
//      (the player watches again), and a viewer is given one producer per kind, the current one.
//   2. Sound the browser held back came on only from a pill on the picture. Now the first tap, click or key anywhere
//      on the page turns it on; a mute the person chose is kept and gets a short hint instead.
//
//   node test/viewer-follow-sound.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = () => {};
console.warn = () => {};

(async () => {
    // ── 1. The server follows the broadcaster's current producers ──
    const sfu = require('../server/streaming/webrtc-sfu');
    const bs = require('../server/streaming/broadcast-server');
    const current = { video: 'v-new', audio: 'a-new' };
    sfu.findProducerByKind = (roomId, kind) => (current[kind] ? { id: current[kind], kind } : null);
    const consumers = new Map([
        ['c1', { consumer: { kind: 'video', producerId: 'v-old', closed: false } }],
        ['c2', { consumer: { kind: 'audio', producerId: 'a-old', closed: false } }],
        ['c3', { consumer: { kind: 'video', producerId: 'v-new', closed: false } }],
        ['c4', { consumer: { kind: 'audio', producerId: 'a-new', closed: false } }],
    ]);
    sfu.rooms = new Map([['stream-9', { consumers, transports: new Map(), producers: new Map() }]]);
    const stale = { streamId: 9, role: 'viewer', peerId: 'p1', _sfuViewerRoomId: 'stream-9', _sfuViewerTransportId: 't1', _sfuViewerConsumerIds: ['c1', 'c2'] };
    const fresh = { streamId: 9, role: 'viewer', peerId: 'p2', _sfuViewerRoomId: 'stream-9', _sfuViewerTransportId: 't2', _sfuViewerConsumerIds: ['c3', 'c4'] };
    const videoOnly = { ...fresh, peerId: 'p3', _sfuViewerConsumerIds: ['c3'] };
    assert.strictEqual(bs._viewerOnStaleProducers(stale), true, 'consuming the producers a reconnect left behind');
    assert.strictEqual(bs._viewerOnStaleProducers(fresh), false, 'on the current ones');
    assert.strictEqual(bs._viewerOnStaleProducers(videoOnly), true, 'audio arrived later and this viewer has none');
    assert.strictEqual(bs._viewerOnStaleProducers({ ...stale, _sfuViewerConsumerIds: [] }), false, 'nothing consumed yet: not this check');

    const sent = [];
    const ws = (name) => ({ name, readyState: 1, send: (m) => sent.push([name, JSON.parse(m).type]) });
    const wsStale = ws('stale'), wsFresh = ws('fresh');
    const realClients = bs.clients;
    bs.clients = new Map([[wsStale, stale], [wsFresh, fresh], [ws('other'), { ...stale, streamId: 10 }]]);
    bs.safeSend = (w, msg) => w.send(JSON.stringify(msg));
    bs._moveViewersToCurrent(9);
    assert.deepStrictEqual(sent, [['stale', 'sfu-source-moved']], 'only the viewer on old producers is asked to watch again');
    bs.clients = realClients;

    // The server code: a re-watch on a stale producer is a fresh consume (not a keyframe nudge), one producer per kind,
    // and a producer added in the room checks the viewers.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'streaming', 'broadcast-server.js'), 'utf8');
    assert.match(src, /activeConsumerIds\.length > 0 && this\._viewerOnStaleProducers\(client\)\) \{[\s\S]{0,400}this\._cleanupSfuViewerTransport\(client\);\s*\} else if \(activeConsumerIds\.length > 0\)/);
    assert.match(src, /const chosen = \['video', 'audio'\]\.map\(\(kind\) => \{[\s\S]{0,800}producers: chosen\.map/);
    assert.match(src, /webrtcSFU\.on\('producer-added'[\s\S]{0,700}this\._moveViewersToCurrent\(streamId\)/);

    // ── 2. Sound on with the first touch ──
    const player = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'stream-player.js'), 'utf8');
    assert.match(player, /case 'sfu-source-moved':[\s\S]{0,1200}sendPlayerSignal\(\{ type: 'watch' \}\)/, 'the player watches again when told');
    const block = player.slice(player.indexOf('let _soundHeldBack = false;'), player.indexOf('/* ── Player stats overlay'));
    function page({ muted = false, volume = 80 } = {}) {
        const store = { openvibe_player_muted: muted ? '1' : '0', openvibe_player_volume: String(volume) };
        const listeners = {};
        const els = {};
        const el = (id, extra = {}) => (els[id] = Object.assign({ id, innerHTML: '', value: 0, children: [], appendChild(c) { this.children.push(c); els[c.id] = c; c.parent = this; }, remove() { delete els[this.id]; }, addEventListener(t, f) { (this.l ||= {})[t] = f; }, setAttribute() {}, click() { this.l && this.l.click && this.l.click({ stopPropagation() {} }); } }, extra));
        const video = el('video-element', { srcObject: {}, muted: true, volume: 0, plays: 0, play() { this.plays++; return Promise.resolve(); } });
        el('video-container'); el('volume-slider'); el('btn-volume');
        const ctx = {
            console, Promise, setTimeout: (f) => f && 0, JSON, Math, String, Number,
            localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
            document: {
                getElementById: (id) => els[id] || null,
                createElement: () => el('new-' + Math.random(), {}),
                addEventListener: (t, f, o) => (listeners[t] ||= []).push(f),
            },
            player: null, playerType: 'webrtc',
            PLAYER_MUTED_KEY: 'openvibe_player_muted',
            getSavedMuted: () => store.openvibe_player_muted === '1',
            getSavedVolume: () => Number(store.openvibe_player_volume),
            setVolume: (v, o) => { video.volume = o.muted ? 0 : v; video.muted = !!o.muted; store.openvibe_player_muted = o.muted ? '1' : '0'; },
        };
        vm.createContext(ctx);
        vm.runInContext(block, ctx);
        const fire = (type, target = { closest: () => null }, extra = {}) => (listeners[type] || []).forEach((f) => f({ target, key: 'a', ...extra }));
        return { ctx, video, store, els, fire };
    }
    // Held back by the browser: a tap anywhere turns the sound on, at the saved level.
    let p = page();
    p.ctx.showUnmuteOverlay(p.video);
    assert.ok(p.els['unmute-overlay'], 'the pill shows');
    p.fire('pointerup');
    assert.deepStrictEqual([p.video.muted, p.video.volume, p.store.openvibe_player_muted], [false, 0.8, '0'], 'a tap on the chat, the page, anything');
    assert.ok(!p.els['unmute-overlay'], 'and the pill goes');
    // A key does it too (not Escape, Tab or a shortcut).
    p = page();
    p.ctx.showUnmuteOverlay(p.video);
    p.fire('keydown', undefined, { key: 'Escape' });
    assert.strictEqual(p.video.muted, true, 'Escape is not "turn the sound on"');
    p.fire('keydown', undefined, { key: 'k' });
    assert.strictEqual(p.video.muted, false);
    // The volume control decides for itself: a click on the mute button is a mute, not an unmute.
    p = page();
    p.ctx.showUnmuteOverlay(p.video);
    p.fire('click', { closest: (sel) => (sel.includes('#btn-volume') ? {} : null) });
    assert.strictEqual(p.video.muted, true, 'the mute button is left alone');
    // A mute the person chose: no pill, no unmute on a tap; the short hint instead.
    p = page({ muted: true });
    p.ctx.showUnmuteOverlay(p.video);
    assert.ok(!p.els['unmute-overlay'], 'no "tap for sound" for a chosen mute');
    p.fire('pointerup');
    assert.strictEqual(p.video.muted, true, 'their mute stands');
    p.ctx.showMutedHint();
    assert.ok(p.els['muted-hint'], 'a short "sound is off" hint');
    p.els['muted-hint'].click();
    assert.deepStrictEqual([p.video.muted, p.store.openvibe_player_muted], [false, '0'], 'one tap on it turns the sound on');

    // HLS and FLV start muted, then turn the sound on when they may (no more silent playback with no pill).
    assert.strictEqual((player.match(/playThenSound\(video, \(\) => (video|flvPlayer)\.play\(\)\)/g) || []).length, 4);
    assert.ok(!/video\.muted = true;\n\s*video\.play\(\)\.catch\(\(\) => \{\n\s*showUnmuteOverlay\(video\);/.test(player), 'no start path left that stays muted without a word');

    quiet('viewer follow + sound: all checks passed');
    process.exit(0);
})().catch((err) => { quiet(err); process.exit(1); });
