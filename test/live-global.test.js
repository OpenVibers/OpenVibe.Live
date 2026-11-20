'use strict';
// Live's global chat hears who went live (server/streaming/live-global.js; plan 2026-11-13 §H item 14). What this proves,
// on the real schema:
//   - a minute after going live, a stream that is still live puts the go-live row in global chat, the row chat.js draws
//     as the go-live card (its text, metadata live_link, the channel's /@name address), keyed once per stream;
//   - not a word for a stream gone within the minute, an 18+ stream (its own flag or the channel's forced one), a
//     banned account's, or an agent stream's;
//   - global chat hears a channel at most once in 30 minutes, and ten go-lives an hour in all;
//   - schedule waits the minute, on a timer that does not hold the process open.
//   node test/live-global.test.js
const assert = require('assert');
const db = require('../server/db/database');
const { createLiveGlobal, DELAY_MS, GLOBAL_GAP_MS, GLOBAL_PER_HOUR } = require('../server/streaming/live-global');

// public/js/chat.js's go-live row (_CHAT_EV_LIVE_RE): the card is drawn from this text when metadata is missing.
const CARD_RE = /^\s*\u{1F534}\s*(.+?) is live\. Share the stream:\s*(https?:\/\/\S+)\s*$/u;

(async () => {
    let failures = 0;
    const check = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failures++; console.log(`  ✗ ${name}\n    ${err.stack}`); } };
    await db.initDb();
    const d = db.getDb();
    const people = [[30, 'maticus', 'Maticus', 0], [31, 'night', null, 0], [32, 'banned1', null, 1], [33, 'agentowner', null, 0], [34, 'gone', null, 0], [36, 'forced', null, 0]];
    for (let i = 40; i < 52; i++) people.push([i, `cap${i}`, null, 0]);
    for (const [id, username, display, banned] of people) {
        await d.prepare('INSERT INTO users (id, username, display_name, password_hash, is_banned) OVERRIDING SYSTEM VALUE VALUES (?, ?, ?, ?, ?)').run(id, username, display, '$sso$', banned);
    }
    await d.prepare('INSERT INTO channels (user_id, force_nsfw) VALUES (36, 1)').run();
    await d.prepare("INSERT INTO managed_streams (id, user_id, stream_key, kind) OVERRIDING SYSTEM VALUE VALUES (900, 33, 'test-agent-key-900', 'agent')").run();
    const stream = (id, userId, extra = {}) => d.prepare('INSERT INTO streams (id, user_id, title, is_live, is_nsfw, ended_at, managed_stream_id) OVERRIDING SYSTEM VALUE VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, userId, `Stream ${id}`, extra.live === false ? 0 : 1, extra.nsfw ? 1 : 0, extra.ended || null, extra.slot || null);
    await stream(100, 30); await stream(101, 30); await stream(102, 31, { nsfw: true }); await stream(103, 32); await stream(104, 33, { slot: 900 });
    await stream(105, 34, { live: false, ended: new Date().toISOString() }); await stream(106, 36);
    for (let i = 40; i < 52; i++) await stream(100 + i, i);

    let t = 1_800_000_000_000;
    const sent = [];
    const keys = new Set();
    const deliver = async (b) => { if (keys.has(b.key)) return null; keys.add(b.key); sent.push(b); return sent.length; };
    const g = createLiveGlobal({ db, deliver, base: 'https://openvibe.live/', now: () => t, log: { warn() {} } });

    await check('a stream still live after the minute: the go-live row in global chat, the card chat.js draws', async () => {
        assert.deepStrictEqual(await g.post(100), { posted: true });
        const l = sent[0];
        assert.strictEqual(l.message, '\u{1F534} Maticus is live. Share the stream: https://openvibe.live/@maticus');
        assert.ok(CARD_RE.test(l.message), 'chat.js reads it as the go-live card');
        assert.deepStrictEqual(l.metadata, { kind: 'live_link', url: 'https://openvibe.live/@maticus' }, 'no picture yet: no preview');
        assert.deepStrictEqual([l.is_global, l.user_id, l.username, l.message_type, l.key], [true, null, 'OpenVibe.Live', 'system', 'live:link:100:global']);
        assert.strictEqual(l.stream_id, undefined, 'global, not the channel\'s chat');
    });

    await check('a stream with its picture by now: the card carries it for the preview (register #812); never another address', async () => {
        await d.prepare("UPDATE streams SET thumbnail_url = '/api/thumbnails/live_101_1.jpg' WHERE id = 101").run();
        await d.prepare("UPDATE streams SET thumbnail_url = 'https://evil.example/x.jpg' WHERE id = 140").run();
        const mine = [];
        const t2 = createLiveGlobal({ db, deliver: async (b) => { mine.push(b); return 1; }, base: 'https://openvibe.live/', now: () => t, log: { warn() {} } });
        assert.deepStrictEqual(await t2.post(101), { posted: true });
        assert.deepStrictEqual(mine[0].metadata, { kind: 'live_link', url: 'https://openvibe.live/@maticus', thumb: 'https://openvibe.live/api/thumbnails/live_101_1.jpg' });
        assert.deepStrictEqual(await t2.post(140), { posted: true });
        assert.strictEqual(mine[1].metadata.thumb, undefined, 'not a Live picture: no preview');
    });

    await check('not a word for 18+, the channel\'s forced 18+, a banned account, an agent stream, or a stream already gone', async () => {
        assert.deepStrictEqual(await g.post(102), { posted: false, why: '18+' });
        assert.deepStrictEqual(await g.post(106), { posted: false, why: '18+' });
        assert.deepStrictEqual(await g.post(103), { posted: false, why: 'banned' });
        assert.deepStrictEqual(await g.post(104), { posted: false, why: 'an agent stream' });
        assert.deepStrictEqual(await g.post(105), { posted: false, why: 'not live any more' });
        assert.deepStrictEqual(await g.post(99999), { posted: false, why: 'no stream' });
        assert.strictEqual(sent.length, 1);
    });

    await check('global chat hears a channel at most once in 30 minutes', async () => {
        t += 10 * 60 * 1000;
        assert.deepStrictEqual(await g.post(101), { posted: false, why: 'heard lately' });
        t += GLOBAL_GAP_MS;
        assert.deepStrictEqual(await g.post(101), { posted: true });
        assert.strictEqual(sent.at(-1).key, 'live:link:101:global');
    });

    await check(`and ${GLOBAL_PER_HOUR} go-lives an hour in all`, async () => {
        t += 3600_000;
        const out = [];
        for (let i = 40; i < 52; i++) out.push((await g.post(100 + i)).posted);
        assert.strictEqual(out.filter(Boolean).length, GLOBAL_PER_HOUR);
        assert.deepStrictEqual(await g.post(151), { posted: false, why: 'the hour is full' });
        t += 3600_000;
        assert.deepStrictEqual(await g.post(151), { posted: true }, 'the next hour has room');
    });

    await check('schedule waits the minute on a timer that lets the process exit, then posts', async () => {
        const timers = [];
        const sent2 = [];
        const g2 = createLiveGlobal({ db, deliver: async (b) => { sent2.push(b); }, now: () => t, log: { warn() {} },
            setTimer: (fn, ms) => { const tm = { fn, ms, unrefd: false, unref() { this.unrefd = true; } }; timers.push(tm); return tm; } });
        g2.schedule(100);
        assert.strictEqual(timers.length, 1);
        assert.strictEqual(timers[0].ms, DELAY_MS);
        assert.strictEqual(DELAY_MS, 60 * 1000);
        assert.ok(timers[0].unrefd, 'never keeps the server from stopping');
        assert.strictEqual(sent2.length, 0, 'nothing before the minute');
        timers[0].fn();
        for (let i = 0; i < 20 && !sent2.length; i++) await new Promise((r) => setImmediate(r));
        assert.strictEqual(sent2.length, 1);
        assert.strictEqual(sent2[0].key, 'live:link:100:global');
    });

    process.stdout.write(failures ? `\n${failures} failed\n` : '\nall passed\n');
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
