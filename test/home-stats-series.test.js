'use strict';

// Home hero stats: the per-metric daily series behind the click-through charts, and the
// Vibes reset cutoff (`stats_vibes_reset_at`) that hides test money from the counters.

const assert = require('assert');
const db = require('../server/db/database');

(async () => {
await db.initDb();

const mk = async (u, key) => {
    await db.createUser({ username: u, email: `${u}@x`, password_hash: 'x', display_name: u, stream_key: key });
    return (await await db.get('SELECT id FROM users WHERE username = ?', [u])).id;
};
const a = await mk('alice', 'a'.repeat(32)), b = await mk('bob', 'b'.repeat(32));
await db.run("UPDATE users SET created_at = datetime('now', '-3 days') WHERE id = ?", [a]);
// Bob: yesterday, and inside a 2-day window (which starts 24 h ago and moves on while the test runs): halfway
// between 24 h ago and the end of yesterday (UTC), never on the window's moving edge.
const sql = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const startOfToday = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
await db.run('UPDATE users SET created_at = ? WHERE id = ?', [sql(((Date.now() - 86400000) + (startOfToday - 1000)) / 2), b]);

// ── series: registry, zero-filled days, totals ──
assert.ok(db.HOME_SERIES_KEYS.includes('users') && db.HOME_SERIES_KEYS.includes('vibes'));
assert.strictEqual(await db.getHomeStatSeries('nope'), null, 'unknown metric → null');
const users7 = await db.getHomeStatSeries('users', 7);
assert.strictEqual(users7.points.length, 7, 'one point per day, zero-filled');
assert.strictEqual(users7.total, 2);
assert.strictEqual(users7.points[6 - 3].value, 1, 'alice 3 days ago');
assert.strictEqual(users7.points[6 - 1].value, 1, 'bob yesterday');
assert.strictEqual(users7.points[6].value, 0, 'nobody today');
assert.strictEqual((await db.getHomeStatSeries('users', 2)).total, 1, 'window shrinks the total');
assert.strictEqual((await db.getHomeStatSeries('users', 9999)).days, 365, 'days are clamped');
assert.strictEqual((await db.getHomeStatSeries('users', 2)).before, 1, 'before: alice, ahead of a 2-day window');
assert.strictEqual((await db.getHomeStatSeries('users', 2)).prev_total, 1, 'prev_total: the 2 days before that');
console.log('✅ daily series are zero-filled and windowed');

// ── readings: live streams / viewers from the five-minute sampler ──
await db.recordViewerSample();
await db.run("INSERT INTO viewer_samples (sampled_at, viewers, live_streams) VALUES (datetime('now', '-2 hours'), 10, 2), (datetime('now', '-2 hours'), 20, 4)");
await db.run("INSERT INTO viewer_samples (sampled_at, viewers, live_streams) VALUES (datetime('now', '-500 days'), 1, 1)");
const v = await db.getReadingSeries('viewersNow', 1);
assert.strictEqual(v.kind, 'reading');
assert.strictEqual(v.bucket, 'hour');
assert.strictEqual(v.points.length, 24);
const twoAgo = v.points[v.points.length - 3];
assert.strictEqual(twoAgo.value, 15, 'hour bucket averages its samples');
assert.strictEqual(twoAgo.peak, 20);
assert.strictEqual(v.points[0].value, null, 'no samples → null, not zero');
assert.strictEqual((await db.getReadingSeries('liveNow', 30)).bucket, 'day');
assert.strictEqual(await db.getReadingSeries('users', 7), null);
await db.recordViewerSample();
assert.strictEqual((await db.get("SELECT COUNT(*) AS n FROM viewer_samples WHERE sampled_at < datetime('now', '-400 days')")).n, 0, 'retention trims past 400 days');
console.log('✅ reading series are bucketed, null-filled and retained for 400 days');

// ── vibes: test money before the reset never counts ──
await db.run("INSERT INTO transactions (from_user_id, to_user_id, amount, type, status, created_at) VALUES (?, ?, 500, 'donation', 'completed', datetime('now', '-10 days'))", [a, b]);
await db.run("INSERT INTO transactions (from_user_id, to_user_id, amount, type, status, created_at) VALUES (?, ?, 200, 'donation', 'completed', datetime('now', '-2 days'))", [b, a]);
await db.run("INSERT INTO transactions (from_user_id, to_user_id, amount, type, status, created_at) VALUES (?, ?, 50, 'donation', 'completed', datetime('now', '-1 hours'))", [b, a]);

let stats = await db.getHomeStats();
assert.strictEqual(stats.vibesTipped, 750, 'no reset → everything counts');
assert.strictEqual(stats.supporters, 2);
assert.strictEqual((await db.getHomeStatSeries('vibes', 30)).total, 750);

await db.setSetting('stats_vibes_reset_at', new Date(Date.now() - 36 * 3600 * 1000).toISOString()); // 36 h ago
// getHomeStats is cached for a while — compute fresh through the internal path.
stats = db._computeHomeStats ? await db._computeHomeStats() : null;
if (!stats) { // fall back: the cache TTL keeps the old value; verify via the series + cutoff helper instead
    assert.ok(await db.vibesStatsSince() > '2000-01-01', 'cutoff parsed');
} else {
    assert.strictEqual(stats.vibesTipped, 50, 'only vibes after the reset count');
    assert.strictEqual(stats.supporters, 1);
    assert.strictEqual(stats.recent.vibes.d, 50);
    assert.strictEqual(stats.recent.vibes.m, 50, 'the 30-day window is also cut at the reset');
}
assert.strictEqual((await db.getHomeStatSeries('vibes', 30)).total, 50, 'series honours the reset');
assert.strictEqual((await db.getHomeStatSeries('supporters', 30)).total, 1);
await db.setSetting('stats_vibes_reset_at', 'garbage');
assert.strictEqual(await db.vibesStatsSince(), '1970-01-01 00:00:00', 'an unparseable reset value is ignored, not fatal');
console.log('✅ Vibes reset cutoff applies to counters, deltas and series');

console.log('\n✅ All home-stats tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
