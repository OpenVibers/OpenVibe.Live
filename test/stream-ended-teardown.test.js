'use strict';
/**
 * A stream that ends leaves nothing polling behind it. The player's DVR poll asks for the stream's live recording
 * (GET /api/vods/stream/:id/live) every 20 s; after an end the answer is 404, and open tabs kept asking: 1,628
 * requests for one ended stream between its end at 04:47 and the next go-live at 16:38 UTC (nginx log, 2026-10-17).
 *
 *   - stream-player.js: showStreamEnded() stops the DVR poll (the real functions, run with fake timers here);
 *   - app-channel.js: the offline branch of loadChannelPage tears down the old player and forgets the ended stream,
 *     as leaving the page (teardownRoute) already did.
 *
 *   node test/stream-ended-teardown.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
// A top-level declaration's source, from its first line to its matching closing brace.
function extract(src, head) {
    const start = src.indexOf(head);
    assert.ok(start >= 0, `${head} is in the file`);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1) + (src[i + 1] === ';' ? ';' : '');
    }
    throw new Error(`${head} has no end`);
}

const player = read('public/js/stream-player.js');
const code = ['let dvrState = {', 'async function initDVR(', 'async function pollDVR(', 'function destroyDVR(', 'function showStreamEnded('].map((h) => extract(player, h)).join('\n');

// Fake timers, an api that answers 404 like the server does for an ended stream, and the few DOM calls made.
const timers = new Map();
let nextId = 1;
const setTimeout = (fn, ms) => { timers.set(nextId, { fn, ms }); return nextId++; };
const clearTimeout = (id) => { timers.delete(id); };
const asked = [];
const api = async (p) => { asked.push(p); const e = new Error('Not found'); e.status = 404; throw e; };
const el = () => ({ style: {} });
const document = { getElementById: el };
const window = { dispatchEvent() {} };
class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
const noop = () => {};
const env = { setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop, api, document, window, CustomEvent,
    _hideReconnectingIndicator: noop, _resetPlayerRevealState: noop, _setPlayerStatus: noop, showDVRControls: noop,
    playerType: 'webrtc', streamRef: { id: 2615 }, playerLoadState: null };
const run = new Function(...Object.keys(env), `${code}\nreturn { initDVR, showStreamEnded, state: () => dvrState };`);
const dvr = run(...Object.values(env));

(async () => {
    const fire = async () => {
        const [[id, t]] = timers;
        timers.delete(id);
        await t.fn();
    };

    await dvr.initDVR({ id: 2615, started_at: '2026-10-17 02:15:09' });
    assert.strictEqual(timers.size, 1, 'the first check waits for the broadcaster');
    await fire();
    await fire();
    assert.deepStrictEqual(asked, ['/vods/stream/2615/live', '/vods/stream/2615/live'], 'while live it asks every 20 s');
    assert.strictEqual([...timers.values()][0].ms, 20000);

    dvr.showStreamEnded();
    assert.strictEqual(timers.size, 0, 'the end stops the DVR poll');
    assert.strictEqual(dvr.state().pollTimer, null);

    // The channel page: the offline branch tears the old player down before showing the offline card.
    const channel = read('public/js/app-channel.js');
    const offline = channel.slice(channel.indexOf('// ── OFFLINE STATE ──'), channel.indexOf('startOfflineStatusPoll(username);', channel.indexOf('// ── OFFLINE STATE ──')));
    assert.ok(/if \(currentStreamId\) \{\s*if \(typeof destroyPlayer === 'function'\) \{ try \{ destroyPlayer\(\); \}/.test(offline), 'offline after a live stream: the player is destroyed');
    assert.ok(offline.includes('currentStreamId = null;') && offline.includes('currentStreamData = null;'), 'and the ended stream is forgotten');
    // destroyPlayer is what stops the poll there too.
    assert.ok(extract(player, 'function destroyPlayer(').includes('destroyDVR();'));

    console.log('stream-ended teardown: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
