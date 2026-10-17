'use strict';
/**
 * db.getHomeStats once a snapshot exists: an expired snapshot is answered at once and recomputed behind the answer,
 * one recompute for everyone (whoever came after each 30 s expiry used to wait for dozens of COUNTs, ~1 s: the home
 * hero's p95 on 2026-10-17). Only the first call waits.
 *
 *   node --import ./test/helpers/pg-preload.mjs test/home-stats-swr.test.js
 */
const assert = require('assert');
const db = require('../server/db/database');

(async () => {
    await db.initDb();
    const realNow = Date.now;
    let skew = 0;
    Date.now = () => realNow() + skew;

    await db.createUser({ username: 'ann', email: 'ann@x', password_hash: 'x', display_name: 'ann', stream_key: 'a'.repeat(32) });
    const first = await db.getHomeStats();
    assert.strictEqual(first.users, 1, 'the first call waits for a snapshot');
    assert.strictEqual(await db.getHomeStats(), first, 'fresh: the same snapshot');

    await db.createUser({ username: 'bob', email: 'bob@x', password_hash: 'x', display_name: 'bob', stream_key: 'b'.repeat(32) });
    skew = 31_000;   // past the 30 s memo
    const [a, b] = await Promise.all([db.getHomeStats(), db.getHomeStats()]);
    assert.strictEqual(a, first, 'expired: the last snapshot at once');
    assert.strictEqual(b, first);

    // The recompute lands behind the answers; the next call sees it.
    let next = first;
    for (let i = 0; i < 50 && next === first; i++) {
        await new Promise((r) => setTimeout(r, 20));
        next = await db.getHomeStats();
    }
    assert.notStrictEqual(next, first, 'the recompute landed');
    assert.strictEqual(next.users, 2);

    Date.now = realNow;
    console.log('home stats: stale-while-revalidate checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
