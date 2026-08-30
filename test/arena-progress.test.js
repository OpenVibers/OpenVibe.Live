'use strict';
// Growth: tiers from all-time XP, achievements from existing data (XP + coins + history), weekly XP.
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-progress-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
const db = require('../server/db/database'); db.initDb();
const arena = require('../server/arena/arena-service'); const board = require('../server/arena/board'); const beef = require('../server/arena/beef'); const ch = require('../server/arena/chatters'); const pr = require('../server/arena/progress');
arena.ensureTables(); board.ensureTables(); beef.ensureTables(); ch.ensureTables(); pr.ensureTables();

assert.deepStrictEqual([0, 149, 150, 400, 3500, 9000].map(x => pr.tierFor(x).name), ['Bronze', 'Bronze', 'Silver', 'Gold', 'Mythic', 'Mythic']);
assert.strictEqual(pr.tierFor(275).progress, 50, 'halfway from Silver (150) to Gold (400)');
assert.strictEqual(pr.tierFor(9000).next, null);
console.log('✅ tiers');

const mk = (u) => Number(db.createUser({ username: u, email: `${u}@x`, password_hash: 'x', display_name: u, stream_key: u.padEnd(32, '0') }).lastInsertRowid);
const u1 = mk('nova'), u2 = mk('grizzly'), viewer = mk('viewer');
for (const uid of [u1, u2, viewer]) db.ensureChannel(uid);
const stream = (uid, peak, hours, daysAgo) => { const id = Number(db.createStream({ user_id: uid, title: 't', category: 'irl', protocol: 'rtmp' }).lastInsertRowid); db.run(`UPDATE streams SET is_live = 0, started_at = datetime('now', ?), ended_at = datetime('now', ?), duration_seconds = ?, peak_viewers = ? WHERE id = ?`, [`-${daysAgo} days`, `-${daysAgo} days`, hours * 3600, peak, id]); db.run(`INSERT INTO stream_analytics (stream_id, avg_viewers, peak_viewers, unique_chatters, total_messages, total_watch_minutes, new_followers, clips_created, coins_earned) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0)`, [id, peak / 2, peak, peak, peak * 20, peak * 60]); };
stream(u1, 100, 5, 1); stream(u2, 40, 5, 1);
arena.loadRoster(true);

// A chatter earns "Said Something" from their first moment; XP + history + coins attempt.
const t = board.createTopic({ text: 'The baby voice', createdBy: 'community', creatorName: 'chat', keywords: ['baby voice'] });
board.addMoment(t.id, { kind: 'chat', source: 'chat', userId: viewer, username: 'viewer', text: 'baby voice is a war crime' });
let v = pr.view(`user:${viewer}`);
assert.ok(v.achievements.find(a => a.id === 'first_moment').earned_at, 'first moment achievement');
assert.ok(v.history.some(e => e.kind === 'achievement' && /Said Something/.test(e.title)), 'history records it');
assert.ok(!v.achievements.some(a => a.for === 'fighter'), 'a viewer is not shown fighter achievements');
assert.ok(ch.profile(`user:${viewer}`).xp >= 12 + 5, 'achievement XP lands on the same bar');
console.log('✅ chatter achievements from moments');

// A fighter: first blood → win → the beef events + achievements + tier.
beef.recordHit(u1, u2, { quality: 8, best_line: 'grizzly streams to alts', about: 'alts' });
let f = pr.view(`user:${u1}`);
assert.ok(f.achievements.find(a => a.id === 'first_blood').earned_at, 'first blood');
assert.ok(f.history.some(e => e.kind === 'beef'), 'beef in history');
const b = beef.openBeefsFor(u1)[0];
db.run(`UPDATE arena_beefs SET clock_until = datetime('now', '-1 minute') WHERE id = ?`, [b.id]); beef.tick();
f = pr.view(`user:${u1}`);
assert.ok(f.achievements.find(a => a.id === 'first_win').earned_at, 'first win');
assert.ok(f.history.some(e => e.kind === 'beef_over' && /Beat grizzly/.test(e.title)));
assert.ok(f.xp >= 40 + 20 + 30, `xp accrued: ${f.xp}`);
assert.strictEqual(pr.view(`user:${u2}`).history.some(e => /Lost to/.test(e.title)), true);
board.addXp(u1, 200, 'test');
f = pr.view(`user:${u1}`);
assert.strictEqual(f.tier.name, 'Silver'); assert.ok(f.history.some(e => e.kind === 'tier' && /Silver/.test(e.title)), 'tier-up recorded once');
board.addXp(u1, 1, 'test');
assert.strictEqual(pr.view(`user:${u1}`).history.filter(e => e.kind === 'tier').length, 1, 'not re-paid');
assert.ok(f.week_xp >= f.xp - 1, 'weekly XP counts recent gains');
const wk = pr.weeklyFighters(3); assert.strictEqual(wk[0].user.id, u1); assert.strictEqual(wk[0].tier.name, 'Silver');
console.log('✅ fighter achievements, beef history, tiers (paid once), weekly ladder');
console.log('\n✅ All Arena progress tests passed');
process.exit(0);
