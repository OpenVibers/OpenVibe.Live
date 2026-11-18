'use strict';
// A finished public recording of a Live stream is said in chat (server/media-proxy/vod-notify.js; plan 2026-11-13 §H
// item 14). What this proves:
//   - a public recording of a Live stream goes to its channel's chat and to global chat, as Live's /vod/<id> with its
//     title and length, keyed so a second vod.ready posts nothing new;
//   - not a word for a private recording, one that is not a stream's, or one under two minutes;
//   - an 18+ stream's recording goes to its channel only;
//   - global chat hears a channel at most once in 30 minutes, and six recordings an hour in all;
//   - a failed channel line does not stop the global one.
//   node test/vod-notify.test.js
const assert = require('assert');
const { createVodNotify, length, GLOBAL_GAP_MS } = require('../server/media-proxy/vod-notify');

const streams = {
    10: { id: 10, user_id: 1, title: 'Robot rally', is_nsfw: 0 },
    11: { id: 11, user_id: 2, title: 'After dark', is_nsfw: 1 },
};
for (let i = 20; i < 30; i++) streams[i] = { id: i, user_id: 100 + i, title: `Stream ${i}`, is_nsfw: 0 };
const users = { 1: { id: 1, username: 'maticus', display_name: 'Maticus' }, 2: { id: 2, username: 'night' } };
const db = { getStreamById: async (id) => streams[id] || null, getUserById: async (id) => users[id] || null };

(async () => {
    let t = 1_800_000_000_000;
    const sent = [];
    const keys = new Set();
    // Chat keeps a line's key: the same key twice is one line.
    const deliver = async (b) => { if (keys.has(b.key)) return null; keys.add(b.key); sent.push(b); return sent.length; };
    const n = createVodNotify({ db, deliver, base: 'https://openvibe.live/', now: () => t, log: { warn() {} } });

    let r = await n.announce({ id: 501, stream_id: 10, visibility: 'public', title: 'Robot rally: the final', duration_seconds: 3725 });
    assert.deepStrictEqual(r.posted, ['channel', 'global']);
    const [channel, global] = sent;
    assert.strictEqual(channel.message, '\u{1F4FC} Maticus saved a broadcast: “Robot rally: the final” (1h 02m) at https://openvibe.live/vod/501');
    assert.deepStrictEqual([channel.stream_id, channel.channel_user_id, channel.key, channel.message_type, channel.user_id], [10, 1, 'vod:link:501', 'system', null]);
    assert.deepStrictEqual(channel.metadata, { kind: 'vod_link', url: 'https://openvibe.live/vod/501', vod_id: 501, title: 'Robot rally: the final', duration: 3725 });
    assert.deepStrictEqual([global.is_global, global.key, global.stream_id], [true, 'vod:link:501:global', undefined]);

    // A repair sends vod.ready again: Chat's keys keep it to the lines already said.
    await n.announce({ id: 501, stream_id: 10, is_public: true, title: 'Robot rally: the final', duration_seconds: 3725 });
    assert.strictEqual(sent.length, 2, 'a second vod.ready posts nothing new');

    for (const [data, why] of [
        [{ id: 502, stream_id: 10, visibility: 'private', duration_seconds: 900 }, 'not public'],
        [{ id: 503, visibility: 'public', duration_seconds: 900 }, 'not a Live stream\'s recording'],
        [{ id: 504, stream_id: 10, visibility: 'public', duration_seconds: 90 }, 'too short'],
        [{ id: 505, stream_id: 999, visibility: 'public', duration_seconds: 900 }, 'no stream'],
    ]) {
        r = await n.announce(data);
        assert.deepStrictEqual([r.posted, r.why], [[], why]);
    }
    assert.strictEqual(sent.length, 2);

    // 18+: the channel only.
    r = await n.announce({ id: 506, stream_id: 11, visibility: 'public', duration_seconds: 600 });
    assert.deepStrictEqual(r.posted, ['channel']);
    assert.ok(sent[sent.length - 1].message.startsWith('\u{1F4FC} night saved a broadcast: “After dark” (10 min)'), 'the stream\'s title when the recording has none');

    // The same channel again within 30 minutes: its own chat, not global.
    t += 10 * 60 * 1000;
    r = await n.announce({ id: 507, stream_id: 10, visibility: 'public', duration_seconds: 600 });
    assert.deepStrictEqual(r.posted, ['channel']);
    t += GLOBAL_GAP_MS;
    r = await n.announce({ id: 508, stream_id: 10, visibility: 'public', duration_seconds: 600 });
    assert.deepStrictEqual(r.posted, ['channel', 'global'], 'after the gap, global again');

    // Six recordings an hour in global chat, whoever made them.
    const globals = () => sent.filter((b) => b.is_global).length;
    const before = globals();
    for (let i = 20; i < 28; i++) await n.announce({ id: 600 + i, stream_id: i, visibility: 'public', duration_seconds: 300 });
    assert.strictEqual(globals() - before, 4, 'the hour already had two (501 and 508): four more, then the cap of six');

    // A failed channel line does not stop the global one.
    t += 2 * 3600_000;
    const flaky = createVodNotify({ db, deliver: async (b) => { if (!b.is_global) throw new Error('Chat away'); return 1; }, now: () => t, log: { warn() {} } });
    r = await flaky.announce({ id: 700, stream_id: 10, visibility: 'public', duration_seconds: 600 });
    assert.deepStrictEqual(r.posted, ['global']);

    assert.deepStrictEqual([length(125), length(3600), length(59)], ['2 min', '1h 00m', '1 min']);
    console.log('vod-notify: channel and global lines once per recording; private, short, non-stream and 18+ (global) held back; 30-minute gap and 6 an hour');
})().catch((e) => { console.error(e); process.exit(1); });
