'use strict';
// Yapper profiles: one key for accounts / anon / relay chatters, XP from board moments, levels,
// titles, streaks, lore quotes, leaderboards — and level-up coins only for accounts.
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-yap-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
const db = require('../server/db/database'); db.initDb();
const ch = require('../server/arena/chatters');
const board = require('../server/arena/board');
const arena = require('../server/arena/arena-service');
arena.ensureTables(); board.ensureTables(); ch.ensureTables();

assert.strictEqual(ch.keyFor({ user_id: 7, username: 'Goosely' }), 'user:7');
assert.strictEqual(ch.keyFor({ user_id: null, anon_id: 'anon4412', username: 'anon4412' }), 'anon:4412');
assert.strictEqual(ch.keyFor({ user_id: null, username: 'anon99' }), 'anon:99', 'anon without anon_id column still keys');
assert.strictEqual(ch.keyFor({ user_id: null, username: '[Twitch] BobLol', source_platform: 'twitch' }), 'relay:twitch:boblol');
assert.strictEqual(ch.keyFor({ user_id: null, username: '[RS] dan' }), 'relay:rs:dan', 'label alone identifies the platform');
assert.deepStrictEqual(ch.parseKey('relay:kick:some:name'), { kind: 'relay', platform: 'kick', username: 'some:name' });
assert.deepStrictEqual([0, 24, 25, 100, 400, 2500].map(ch.levelFor), [1, 1, 2, 3, 5, 11]);
assert.deepStrictEqual([1, 3, 5, 12, 20].map(ch.titleFor), ['Lurker', 'Yapper', 'Instigator', 'Main Character', 'Final Boss']);
console.log('✅ chatter keys, level curve, titles');

const uid = Number(db.createUser({ username: 'viewer', email: 'v@x', password_hash: 'x', display_name: 'Viewer', stream_key: 'v'.repeat(32) }).lastInsertRowid);
const t = board.createTopic({ text: 'The baby voice', createdBy: 'community', creatorName: 'global chat', keywords: ['baby voice'] });
const say = (uid2, uname, msg, extra = {}) => board.addMoment(t.id, { kind: 'chat', source: 'chat', userId: uid2, username: uname, text: msg, ...extra });
say(uid, 'viewer', 'the baby voice is a war crime');
let p = ch.profile('user:viewer'.replace('viewer', uid));
assert.strictEqual(p.xp, ch.XP_MOMENT + ch.XP_FIRST_ON_SUBJECT + 5, 'moment + first-on-subject + day-1 streak');
assert.strictEqual(p.streak, 1); assert.strictEqual(p.subjects, 1); assert.strictEqual(p.moments, 1);
say(uid, 'viewer', 'baby voice again');
p = ch.profile(`user:${uid}`);
assert.strictEqual(p.xp, 12 + ch.XP_MOMENT, 'second line: just the moment (streak already paid today)');
say(null, 'anon4412', 'baby voice enjoyers rise', { anonId: 'anon4412' });
say(null, '[Twitch] BobLol', 'the baby voice guy again', { platform: 'twitch' });
assert.strictEqual(ch.profile('anon:4412').kind, 'anon'); assert.strictEqual(ch.profile('relay:twitch:boblol').name, '[Twitch] BobLol');
assert.strictEqual(ch.profile('anon:4412').coins, false, 'anon: level + title, no coins');
db.run(`UPDATE arena_topics SET heat = 50 WHERE id = ?`, [t.id]);
say(uid, 'viewer', 'HOT take on the baby voice');
assert.strictEqual(ch.profile(`user:${uid}`).xp, 15 + ch.XP_MOMENT_HOT, 'hot subjects pay double');
assert.strictEqual(db.get('SELECT chatter_key FROM arena_topic_moments ORDER BY id DESC LIMIT 1').chatter_key, `user:${uid}`);
console.log('✅ moments → XP for accounts, anon and relay chatters');

(async () => {
    const before = ch.profile(`user:${uid}`).xp;
    const lore = await board.buildLore(t.id, { force: true });
    assert.ok(/viewer/.test(lore.lore), 'template lore names the chatter');
    assert.strictEqual(ch.profile(`user:${uid}`).xp, before + ch.XP_QUOTED_IN_LORE, 'quoted in the lore → XP');
    assert.strictEqual(ch.profile(`user:${uid}`).quoted, 1);
    ch.onHype(`user:${uid}`, t.id); assert.strictEqual(ch.profile(`user:${uid}`).hypes, 1);
    ch.onSubjectStarted(`user:${uid}`, t.id, { display: 'Viewer' }); assert.strictEqual(ch.profile(`user:${uid}`).subjects_started, 1);
    // Level up: force XP over the level-3 line; coins are attempted once per level (wallet is unlinked here → no-op, but marked paid).
    const r = ch.addXp(`user:${uid}`, 200, 'test');
    assert.ok(r.leveled_up && r.level >= 3, JSON.stringify(r));
    await new Promise(res => setTimeout(res, 20));
    assert.strictEqual(ch.row(`user:${uid}`).coins_paid_level, 0, 'wallet unlinked here → not marked paid (housekeeping retries)');
    assert.strictEqual(await ch.settleCoins(), 0, 'retry is safe when the wallet cannot credit');
    const r2 = ch.addXp(`user:${uid}`, 1, 'test'); assert.strictEqual(r2.leveled_up, false);
    const lb = ch.leaderboard(5);
    assert.strictEqual(lb[0].key, `user:${uid}`); assert.ok(lb.length === 3 && lb[0].title === ch.titleFor(lb[0].level));
    assert.strictEqual(ch.leaderboard(5, { days: 7 })[0].gained, ch.profile(`user:${uid}`).xp, 'weekly board sums the log');
    const prof = ch.profile(`user:${uid}`);
    assert.ok(prof.recent_moments.length === 3 && prof.top_subjects[0].id === t.id && prof.rank === 1 && prof.titles.length === ch.TITLES.length);
    assert.deepStrictEqual(await ch.buildCard(`user:${uid}`), { skipped: 'ai off' }, 'no AI → no card call');
    assert.strictEqual(await ch.cardSweep(), 0);
    const c1 = ch.checkin(uid, { display: 'Viewer' });
    assert.strictEqual(c1.already, false); assert.ok(c1.gained >= 5, 'daily check-in pays');
    const c2 = ch.checkin(uid); assert.strictEqual(c2.already, true, 'once a day');
    console.log('✅ lore quotes, hype, subjects, level-ups (coins once per level), leaderboards, profile, daily check-in');
    console.log('\n✅ All chatter tests passed');
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
