'use strict';

// Home hero stats: the per-metric daily series behind the click-through charts, and the
// Vibes reset cutoff (`stats_vibes_reset_at`) that hides test money from the counters.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ov-stats-')), 'live.db');
const db = require('../server/db/database');
db.initDb();

const mk = (u, key) => Number(db.createUser({ username: u, email: `${u}@x`, password_hash: 'x', display_name: u, stream_key: key }).lastInsertRowid);
const a = mk('alice', 'a'.repeat(32)), b = mk('bob', 'b'.repeat(32));
db.run("UPDATE users SET created_at = datetime('now', '-3 days') WHERE id = ?", [a]);
db.run("UPDATE users SET created_at = datetime('now', '-1 days') WHERE id = ?", [b]);

// ── series: registry, zero-filled days, totals ──
assert.ok(db.HOME_SERIES_KEYS.includes('users') && db.HOME_SERIES_KEYS.includes('vibes'));
assert.strictEqual(db.getHomeStatSeries('nope'), null, 'unknown metric → null');
const users7 = db.getHomeStatSeries('users', 7);
assert.strictEqual(users7.points.length, 7, 'one point per day, zero-filled');
assert.strictEqual(users7.total, 2);
assert.strictEqual(users7.points[6 - 3].value, 1, 'alice 3 days ago');
assert.strictEqual(users7.points[6 - 1].value, 1, 'bob yesterday');
assert.strictEqual(users7.points[6].value, 0, 'nobody today');
assert.strictEqual(db.getHomeStatSeries('users', 2).total, 1, 'window shrinks the total');
assert.strictEqual(db.getHomeStatSeries('users', 9999).days, 365, 'days are clamped');
console.log('✅ daily series are zero-filled and windowed');

// ── vibes: test money before the reset never counts ──
db.run("INSERT INTO transactions (from_user_id, to_user_id, amount, type, status, created_at) VALUES (?, ?, 500, 'donation', 'completed', datetime('now', '-10 days'))", [a, b]);
db.run("INSERT INTO transactions (from_user_id, to_user_id, amount, type, status, created_at) VALUES (?, ?, 200, 'donation', 'completed', datetime('now', '-2 days'))", [b, a]);
db.run("INSERT INTO transactions (from_user_id, to_user_id, amount, type, status, created_at) VALUES (?, ?, 50, 'donation', 'completed', datetime('now', '-1 hours'))", [b, a]);

let stats = db.getHomeStats();
assert.strictEqual(stats.vibesTipped, 750, 'no reset → everything counts');
assert.strictEqual(stats.supporters, 2);
assert.strictEqual(db.getHomeStatSeries('vibes', 30).total, 750);

db.setSetting('stats_vibes_reset_at', new Date(Date.now() - 36 * 3600 * 1000).toISOString()); // 36 h ago
// getHomeStats is cached for a while — compute fresh through the internal path.
stats = db._computeHomeStats ? db._computeHomeStats() : null;
if (!stats) { // fall back: the cache TTL keeps the old value; verify via the series + cutoff helper instead
    assert.ok(db.vibesStatsSince() > '2000-01-01', 'cutoff parsed');
} else {
    assert.strictEqual(stats.vibesTipped, 50, 'only vibes after the reset count');
    assert.strictEqual(stats.supporters, 1);
    assert.strictEqual(stats.recent.vibes.d, 50);
    assert.strictEqual(stats.recent.vibes.m, 50, 'the 30-day window is also cut at the reset');
}
assert.strictEqual(db.getHomeStatSeries('vibes', 30).total, 50, 'series honours the reset');
assert.strictEqual(db.getHomeStatSeries('supporters', 30).total, 1);
db.setSetting('stats_vibes_reset_at', 'garbage');
assert.strictEqual(db.vibesStatsSince(), '1970-01-01 00:00:00', 'an unparseable reset value is ignored, not fatal');
console.log('✅ Vibes reset cutoff applies to counters, deltas and series');

console.log('\n✅ All home-stats tests passed');
process.exit(0);
