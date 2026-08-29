'use strict';

// Arena regression tests: ratings are fair percentiles, battles are deterministic per
// day and order-independent, the crowd vote is the last round, and the roster/API works
// end-to-end on a temp DB without any AI configured (personas fall back, no LLM calls).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-arena-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.ARENA_IMAGE_PATH = path.join(tmp, 'arena');

const db = require('../server/db/database');
db.initDb();
const arena = require('../server/arena/arena-service');

// ── Pure helpers ──
const ratings = arena._computeRatings({
    1: { peak_viewers: 100, hours: 50, messages_per_hour: 200, loyalty_score: 300, clutch_per_hour: 2, avg_viewers: 40 },
    2: { peak_viewers: 10, hours: 5, messages_per_hour: 20, loyalty_score: 30, clutch_per_hour: 0.2, avg_viewers: 4 },
    3: { peak_viewers: 50, hours: 25, messages_per_hour: 100, loyalty_score: 150, clutch_per_hour: 1, avg_viewers: 20 },
});
assert.strictEqual(ratings[1].hype, 99, 'top of every metric is a 99');
assert.strictEqual(ratings[2].hype, 40, 'bottom is the floor, never 0');
assert.ok(ratings[3].hype > 40 && ratings[3].hype < 99, 'middle sits in between');
assert.ok(ratings[1].power > ratings[3].power && ratings[3].power > ratings[2].power, 'power orders the roster');
const solo = arena._computeRatings({ 7: { peak_viewers: 1, hours: 1, messages_per_hour: 1, loyalty_score: 1, clutch_per_hour: 0, avg_viewers: 1 } });
assert.strictEqual(solo[7].hype, 70, 'a roster of one is a flat 70 — no population to compare to');
console.log('✅ ratings are percentile-based with a floor');

const A = { hype: 90, grind: 60, chat: 70, loyalty: 80, clutch: 50, vibe: 85, power: 80 };
const B = { hype: 60, grind: 90, chat: 65, loyalty: 70, clutch: 95, vibe: 60, power: 70 };
const r1 = arena._simulateRounds(A, B, '1:2:2026-08-29');
const r2 = arena._simulateRounds(A, B, '1:2:2026-08-29');
const r3 = arena._simulateRounds(A, B, '1:2:2026-08-30');
assert.deepStrictEqual(r1, r2, 'same pair + same day → identical rounds');
assert.notDeepStrictEqual(r1.map(r => r.a), r3.map(r => r.a), 'a new day rolls new rounds');
assert.strictEqual(r1.length, 4);
for (const r of r1) assert.ok(['a', 'b'].includes(r.winner) && r.a >= 40 && r.b >= 40);
console.log('✅ battles are seeded per day');

const roundsAll = [{ winner: 'a' }, { winner: 'a' }, { winner: 'b' }, { winner: 'a' }];
assert.deepStrictEqual(arena._scoreBattle(roundsAll, { a: 0, b: 0 }, 80, 70), { a: 3, b: 1, crowd: null, winner: 'a', tiebreak: null });
const even = [{ winner: 'a' }, { winner: 'a' }, { winner: 'b' }, { winner: 'b' }];
assert.strictEqual(arena._scoreBattle(even, { a: 0, b: 0 }, 80, 70).tiebreak, 'power', '2–2 with no votes → Power tiebreak');
assert.strictEqual(arena._scoreBattle(even, { a: 3, b: 1 }, 70, 80).winner, 'a', 'the crowd round breaks a 2–2');
assert.strictEqual(arena._scoreBattle(even, { a: 1, b: 3 }, 80, 70).winner, 'b', 'even against the higher Power');
console.log('✅ crowd vote is the last round');

// ── End-to-end on a temp DB (no AI configured → fallback personas, no LLM calls) ──
const mk = (username, key) => Number(db.createUser({ username, email: `${username}@x`, password_hash: 'x', display_name: username.toUpperCase(), stream_key: key }).lastInsertRowid);
const u1 = mk('alpha', 'a'.repeat(32)), u2 = mk('bravo', 'b'.repeat(32)), u3 = mk('charlie', 'c'.repeat(32)), idle = mk('idle', 'd'.repeat(32));
for (const uid of [u1, u2, u3, idle]) db.ensureChannel(uid);
const stream = (uid, peak, hours, daysAgo) => {
    const id = Number(db.createStream({ user_id: uid, title: `${uid} stream`, category: 'irl', protocol: 'rtmp' }).lastInsertRowid);
    db.run(`UPDATE streams SET is_live = 0, started_at = datetime('now', ?), ended_at = datetime('now', ?), duration_seconds = ?, peak_viewers = ? WHERE id = ?`,
        [`-${daysAgo} days`, `-${daysAgo} days`, Math.round(hours * 3600), peak, id]);
    db.run(`INSERT INTO stream_analytics (stream_id, avg_viewers, peak_viewers, unique_chatters, total_messages, total_watch_minutes, new_followers, clips_created, coins_earned)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0)`, [id, peak / 2, peak, peak, peak * 20, peak * 60, Math.round(hours)]);
    return id;
};
stream(u1, 120, 6, 2); stream(u1, 80, 4, 5);
stream(u2, 30, 10, 1);
stream(u3, 10, 1, 9);
stream(idle, 500, 50, 120); // too old → not on the roster
db.run('INSERT INTO follows (follower_id, streamer_id) VALUES (?, ?), (?, ?), (?, ?)', [u2, u1, u3, u1, u1, u2]);

const fighters = arena.listFighters();
assert.deepStrictEqual(fighters.map(f => f.user.username), ['alpha', 'bravo', 'charlie'], `roster ordered by power, idle excluded: ${fighters.map(f => f.user.username)}`);
assert.strictEqual(fighters[0].rank, 1);
assert.ok(fighters[0].ratings.power > fighters[2].ratings.power);
assert.ok(fighters[0].persona.fighter_name, 'fallback persona has a name even with AI off');
assert.strictEqual(fighters[0].persona_is_fallback, true);
console.log('✅ roster from real stream/analytics rows, inactive streamers excluded');

(async () => {
    const card = await arena.getFighter('alpha');
    assert.strictEqual(card.user.username, 'alpha');
    assert.strictEqual(card.rank, 1);
    assert.ok(card.raw.hours >= 9.9 && card.raw.hours <= 10.1, `hours aggregated: ${card.raw.hours}`);
    assert.strictEqual(card.raw.followers, 2);
    assert.strictEqual(card.image_url, null);
    assert.strictEqual(card.image_generation, 'off', 'no AI → no image generation');
    const off = await arena.getFighter('idle');
    assert.strictEqual(off.not_on_roster, true);
    console.log('✅ fighter card');

    const b1 = await arena.getBattle('alpha', 'bravo');
    const b2 = await arena.getBattle('bravo', 'alpha');
    assert.strictEqual(b1.id, b2.id, 'a-vs-b and b-vs-a are the same battle');
    assert.strictEqual(b1.rounds.length, 4);
    assert.ok(b1.commentary.intro && b1.commentary.rounds.length === 4, 'templated commentary without AI');
    assert.strictEqual(b1.commentary_is_fallback, true);
    assert.strictEqual(b1.votes.a + b1.votes.b, 0);

    const v1 = arena.castVote(b1.id, 'user:99', 'b');
    assert.deepStrictEqual(v1.votes, { a: 0, b: 1 });
    const v2 = arena.castVote(b1.id, 'user:99', 'a');
    assert.deepStrictEqual(v2.votes, { a: 1, b: 0 }, 'a voter can change sides, never double-vote');
    arena.castVote(b1.id, 'anon:abc', 'a');
    const after = await arena.getBattle('alpha', 'bravo', { generate: false });
    assert.deepStrictEqual(after.votes, { a: 2, b: 0 });
    assert.strictEqual(after.outcome.crowd, 'a');
    assert.throws(() => arena.castVote(b1.id, 'user:1', 'c'), /side/);
    assert.throws(() => arena.castVote(999999, 'user:1', 'a'), /not found/);
    console.log('✅ battle + votes');

    const rec = arena.listFighters().find(f => f.user.username === (after.winner.username));
    assert.strictEqual(rec.record.wins, 1, 'winner gets the W on the leaderboard');
    const live = arena.getLiveMatchups();
    assert.strictEqual(live.live_count, 0);
    const st = arena.status();
    assert.strictEqual(st.roster, 3);
    assert.strictEqual(st.battles, 1);
    assert.strictEqual(st.votes, 2);
    console.log('✅ records, live matchups, status');

    console.log('\n✅ All Arena tests passed');
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
