'use strict';
// /replay/:streamId (server/streaming/replay-link.js; the owner's register #331, 2026-11-20): Network's "X is live"
// notice points here once the stream ends, so the bell opens the recording. On the real schema:
//   - a stream still live opens its channel;
//   - an ended stream with a public, finished recording opens /vod/<id>;
//   - an ended stream with no public recording yet (or Media not answering) opens the channel;
//   - an unknown stream opens the home page; the answer is never cached.
//   node test/replay-link.test.js
const assert = require('assert');
const db = require('../server/db/database');
const { replayTarget, handler } = require('../server/streaming/replay-link');

(async () => {
    let failures = 0;
    const check = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failures++; console.log(`  ✗ ${name}\n    ${err.stack}`); } };
    await db.initDb();
    const d = db.getDb();
    await d.prepare('INSERT INTO users (id, username, display_name, password_hash) OVERRIDING SYSTEM VALUE VALUES (?, ?, ?, ?)').run(70, 'replayer', 'Replayer', '$sso$');
    const stream = (id, live) => d.prepare('INSERT INTO streams (id, user_id, title, is_live, ended_at) OVERRIDING SYSTEM VALUE VALUES (?, ?, ?, ?, ?)')
        .run(id, 70, `Stream ${id}`, live ? 1 : 0, live ? null : new Date().toISOString());
    await stream(700, true); await stream(701, false); await stream(702, false);
    const asked = [];
    const lookups = { publicVodsForStreams: async (ids) => { asked.push(...ids); return new Map([[701, { id: 9001 }]]); } };

    await check('a stream still live opens its channel (and Media is not asked)', async () => {
        assert.strictEqual(await replayTarget(700, { lookups }), '/@replayer');
        assert.deepStrictEqual(asked, []);
    });
    await check('an ended stream with a public recording opens it', async () => {
        assert.strictEqual(await replayTarget(701, { lookups }), '/vod/9001');
    });
    await check('no public recording yet: the channel', async () => {
        assert.strictEqual(await replayTarget(702, { lookups }), '/@replayer');
    });
    await check('Media not answering: the channel', async () => {
        const down = { publicVodsForStreams: async () => { throw new Error('timeout'); } };
        assert.strictEqual(await replayTarget(701, { lookups: down }), '/@replayer');
    });
    await check('an unknown stream: the home page, never cached', async () => {
        assert.strictEqual(await replayTarget(999999, { lookups }), '/');
        const res = { headers: {}, set(k, v) { this.headers[k] = v; }, redirect(code, to) { this.code = code; this.to = to; } };
        await handler({ params: ['999999'] }, res);
        assert.deepStrictEqual([res.code, res.to, res.headers['Cache-Control']], [302, '/', 'no-store']);
    });
    if (failures) { console.log(`replay link: ${failures} failed`); process.exit(1); }
    console.log('replay link: an ended stream opens its recording, else its channel');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
