/**
 * Own-channel TTS: one speaking tab per browser, chosen among the tabs that show the streamer's OWN channel chat (or
 * their live broadcast page). Owner, 2026-10-18: "i still dont hear my own tts in my own popout chat". Every tab used
 * to ask for the Web Lock when chat.js loaded, so a home-page or other-channel tab opened first held it for good and
 * the own-channel popout never spoke (Chat queued and sent the audio; the popout dropped it as "not the speaker").
 *
 *   node test/own-channel-tts-speaker.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chat.js'), 'utf8');

/** The source of a top-level function declaration, braces matched (after its parameter list). */
function extract(name) {
    const m = new RegExp(`function ${name}\\(`).exec(src);
    assert.ok(m, `${name}() must exist`);
    let i = m.index + m[0].length;
    for (let parens = 1; parens; i++) { if (src[i] === '(') parens++; else if (src[i] === ')') parens--; }
    i = src.indexOf('{', i);
    for (let depth = 0; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(m.index, i + 1);
    }
    throw new Error(`unbalanced ${name}`);
}
const from = src.indexOf('const _ownTtsLocks');
const to = src.indexOf("window.addEventListener('openvibe-auth-changed', () => { try { _syncOwnTtsLeadership(); }");
assert.ok(from > 0 && to > from, 'the speaker election block exists');
const election = src.slice(from, src.indexOf('\n', to) + 1);

/** One browser's Web Locks: exclusive, queued, granted asynchronously like the real thing. */
function lockManager() {
    const queues = new Map();
    const pump = (name) => {
        const q = queues.get(name);
        if (!q || q.busy || !q.waiting.length) return;
        q.busy = true;
        const { cb, done } = q.waiting.shift();
        queueMicrotask(async () => {
            try { done(await cb({ name })); } finally { q.busy = false; pump(name); }
        });
    };
    return {
        request(name, cb) {
            if (!queues.has(name)) queues.set(name, { busy: false, waiting: [] });
            return new Promise((done) => { queues.get(name).waiting.push({ cb, done }); pump(name); });
        },
    };
}

function tab(locks, { userId = 1, channelUserId = null, streaming = false } = {}) {
    const ctx = vm.createContext({ navigator: { locks }, window: { addEventListener() {} }, queueMicrotask, Promise, currentUser: { id: userId }, chatChannelUserId: channelUserId, streamingNow: streaming });
    vm.runInContext(`${extract('isBroadcastingLiveForTTS')}\n${extract('_isOwnChannelChat')}\nfunction isStreaming() { return streamingNow; }\n${election}`, ctx);
    return {
        speaker: () => vm.runInContext('isOwnChannelTtsSpeaker()', ctx),
        show: (channelUserId) => { ctx.chatChannelUserId = channelUserId; vm.runInContext('_syncOwnTtsLeadership()', ctx); },
        live: (on) => { ctx.streamingNow = on; vm.runInContext('_syncOwnTtsLeadership()', ctx); },
    };
}
const settle = () => new Promise((r) => setImmediate(r));

(async () => {
    const locks = lockManager();
    // The streamer (user 1) has the home page open, then someone else's channel, then their own popout.
    const home = tab(locks);
    home.show(null);
    const other = tab(locks);
    other.show(42);
    await settle();
    const popout = tab(locks);
    popout.show(1);
    await settle();
    assert.strictEqual(popout.speaker(), true, 'the own-channel popout speaks: tabs that are not on the own channel never took the lock');
    assert.strictEqual(other.speaker(), false);

    // A second own-channel surface waits its turn, and takes over the moment the speaker moves to another channel.
    const channelPage = tab(locks);
    channelPage.show(1);
    await settle();
    assert.strictEqual(channelPage.speaker(), false, 'one speaker per browser');
    popout.show(42);
    await settle();
    assert.strictEqual(popout.speaker(), false, 'leaving the own channel gives the lock up');
    assert.strictEqual(channelPage.speaker(), true, 'and the next own-channel tab speaks at once');

    // The broadcast page joins the chat without a channel id: live there counts as the own channel.
    channelPage.show(null);
    const studio = tab(locks, { streaming: true });
    studio.show(null);
    await settle();
    assert.strictEqual(studio.speaker(), true, 'the live broadcast page speaks');
    studio.live(false);
    await settle();
    assert.strictEqual(studio.speaker(), false, 'and stops competing once the stream ends');

    // A request still queued when its tab leaves is dropped when it is finally granted.
    const a = tab(locks), b = tab(locks);
    a.show(1); b.show(1);
    b.show(null);
    await settle();
    assert.strictEqual(a.speaker(), true);
    a.show(null);
    await settle();
    const c = tab(locks);
    c.show(1);
    await settle();
    assert.strictEqual(c.speaker(), true, "a left tab's late grant never blocks the next speaker");

    console.log('own-channel TTS speaker: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
