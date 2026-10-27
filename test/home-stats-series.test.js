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
// Bob: yesterday, and inside a 2-day window (which starts 24 h ago and moves on while the test runs): halfway
// between 24 h ago and the end of yesterday (UTC), never on the window's moving edge.
const sql = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const startOfToday = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
await db.run('UPDATE users SET created_at = ? WHERE id = ?', [sql(((Date.now() - 86400000) + (startOfToday - 1000)) / 2), b]);
// Alice: 3 days ago, and inside the 2-day window before that one (it starts 3 days back and moves on too): halfway
// between 3 days ago and the end of that calendar day, never on the moving edge (exactly 3 days ago fell out of
// prev_total whenever a second ticked between this line and the query).
await db.run('UPDATE users SET created_at = ? WHERE id = ?', [sql(((Date.now() - 3 * 86400000) + (startOfToday - 2 * 86400000 - 1000)) / 2), a]);

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
// The counters read channel_tips (every tip a channel received, on any rail), not the money ledger.
await db.run("INSERT INTO channel_tips (from_user_id, to_user_id, amount, source, ref, created_at) VALUES (?, ?, 500, 'vibes', 'live-txn:1', datetime('now', '-10 days'))", [a, b]);
await db.run("INSERT INTO channel_tips (from_user_id, to_user_id, amount, source, ref, created_at) VALUES (?, ?, 200, 'vibes', 'live-txn:2', datetime('now', '-2 days'))", [b, a]);
await db.run("INSERT INTO channel_tips (from_user_id, to_user_id, amount, source, ref, created_at) VALUES (?, ?, 50, 'vibes', 'live-txn:3', datetime('now', '-1 hours'))", [b, a]);

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

// ── 2026-10-27 review: new streamers, visitors' running total, hours watched per window ──
// Bob streams three days in a row and Alice once, 2 days ago: the chart counts each person once, on their first
// stream, so its running total is the chip's headcount (summing each day's streamers counted Bob three times).
for (const back of [5, 4, 3]) await db.run("INSERT INTO streams (user_id, title, created_at) VALUES (?, 'b', datetime('now', ?))", [b, `-${back} days`]);
await db.run("INSERT INTO streams (user_id, title, created_at) VALUES (?, 'a', datetime('now', '-2 days'))", [a]);
const streamers7 = await db.getHomeStatSeries('streamers', 7);
assert.strictEqual(streamers7.total, 2, 'two new streamers in the week, Bob once');
assert.strictEqual(streamers7.points[6 - 5].value, 1, 'Bob on his first day only');
assert.strictEqual(streamers7.points[6 - 4].value, 0);
assert.strictEqual(streamers7.before + streamers7.total, 2, 'the running total ends at the headcount');
// Most anon rows predate created_at: they are part of everything before the window, so the running total ends at
// the chip's number (it said 1,812 against 29,144 on production).
await db.run("INSERT INTO anon_ip_mappings (ip, anon_num, created_at) VALUES ('10.0.0.1', 901, NULL), ('10.0.0.2', 902, NULL), ('10.0.0.3', 903, datetime('now', '-1 hours'))");
const visitors7 = await db.getHomeStatSeries('visitors', 7);
assert.strictEqual(visitors7.total, 1);
assert.strictEqual(visitors7.before, 2, 'rows with no date count before the window');
// Hours watched over each window, and distinct streamers this week.
await db.run("INSERT INTO watch_time (user_id, stream_id, minutes_watched, created_at) SELECT ?, id, 120, datetime('now', '-2 hours') FROM streams WHERE user_id = ? LIMIT 1", [a, b]);
await db.run("INSERT INTO watch_time (user_id, stream_id, minutes_watched, created_at) SELECT ?, id, 180, datetime('now', '-10 days') FROM streams WHERE user_id = ? LIMIT 1", [b, a]);
stats = await db._computeHomeStats();
assert.deepStrictEqual(stats.recent.hoursWatched, { d: 2, w: 2, m: 5, pw: 3 }, 'hours watched per window, and the week before');
assert.deepStrictEqual(stats.recent.streamers, { d: 0, w: 2, m: 2, pw: 0 }, '"+" on Streamers is new streamers');
assert.strictEqual(stats.streamedWeek, 2, 'two people went live this week');
assert.strictEqual((await db.getHomeStatSeries('supporters', 7)).distinct, true, 'supporters per day do not add up');
assert.strictEqual((await db.getHomeStatSeries('users', 7)).distinct, undefined);
console.log('✅ new streamers, visitors before the window, hours watched per window');

console.log('\n✅ All home-stats tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
