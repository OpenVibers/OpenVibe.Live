'use strict';

// Arena roster regression tests: ratings are fair percentiles (incl. MIC from the transcripts),
// the behaviour-only filter blocks threats/minors/doxxing but never vocabulary, quotes come from
// real transcript lines with VOD links, and the roster/card/stat API works end-to-end on a temp DB
// without any AI configured (personas fall back, no LLM calls). Beefs + the board: arena-beef-board.test.js.

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
const base = { peak_viewers: 10, hours: 5, messages_per_hour: 20, loyalty_score: 30, clutch_per_hour: 0.2, avg_viewers: 4, voice: { voice_score: 5 } };
const ratings = arena._computeRatings({
    1: { ...base, peak_viewers: 100, hours: 50, messages_per_hour: 200, loyalty_score: 300, clutch_per_hour: 2, avg_viewers: 40, voice: { voice_score: 60 } },
    2: { ...base },
    3: { ...base, peak_viewers: 50, hours: 25, messages_per_hour: 100, loyalty_score: 150, clutch_per_hour: 1, avg_viewers: 20, voice: { voice_score: 30 } },
});
assert.strictEqual(ratings[1].hype, 99, 'top of every metric is a 99');
assert.strictEqual(ratings[2].hype, 40, 'bottom is the floor, never 0');
assert.strictEqual(ratings[1].mic, 99, 'MIC ranks the voice score');
assert.strictEqual(ratings[2].mic, 40);
assert.ok(ratings[3].hype > 40 && ratings[3].hype < 99, 'middle sits in between');
assert.ok(ratings[1].power > ratings[3].power && ratings[3].power > ratings[2].power, 'power orders the roster');
assert.ok(Math.abs(Object.values(arena.STAT_WEIGHTS).reduce((a, b) => a + b, 0) - 1) < 1e-9, 'stat weights sum to 1');
const solo = arena._computeRatings({ 7: { ...base } });
assert.strictEqual(solo[7].hype, 70, 'a roster of one is a flat 70 — no population to compare to');
console.log('✅ ratings are percentile-based with a floor (7 stats incl. MIC)');

// ── Filter: behaviour, not vocabulary (the platform does not censor language) ──
for (const bad of ['kys', 'kill yourself', 'go drink bleach', 'I will kill you', "i'm gonna stab him", 'his home address is 12 elm st', 'her phone number is 555 0199', 'child porn link', 'cp links in bio', 'doxxed him already'])
    assert.ok(arena._isBannedText(bad), `banned (behaviour): ${bad}`);
for (const ok of ['that beaner coon nonsense', 'stop being a faggot', 'what up my niggas', "he's a retard", 'such a whore', 'pussy move', 'we got raped in that match', 'this shell script is hell', 'kill the lights', 'his address is wrong on the form? no, the URL address'])
    assert.ok(!arena._isBannedText(ok), `allowed (speech): ${ok}`);
console.log('✅ filter blocks threats / minors / doxxing only — slurs and profanity are speech');

// ── End-to-end on a temp DB (no AI configured → fallback personas/quotes, no LLM calls) ──
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
const s1 = stream(u1, 120, 6, 2); stream(u1, 80, 4, 5);
stream(u2, 30, 10, 1);
stream(u3, 10, 1, 9);
stream(idle, 500, 50, 120); // too old → not on the roster
db.run('INSERT INTO follows (follower_id, streamer_id) VALUES (?, ?), (?, ?), (?, ?)', [u2, u1, u3, u1, u1, u2]);

// Transcript for alpha: 40 lines over the 6 h stream, some hype, all linked to a VOD.
db.run(`INSERT INTO vods (id, user_id, stream_id, title, file_path, is_public, created_at) VALUES (901, ?, ?, 'alpha vod', '/x/alpha.webm', 1, datetime('now', '-2 days'))`, [u1, s1]);
const lines = [];
for (let i = 0; i < 40; i++) {
    const t = i % 4 === 0 ? `Let's go chat, that was insane, no way we just did that number ${i}!` : `Okay so here is the current situation with the setup number ${i}, we are rebuilding it live.`;
    lines.push({ stream_id: s1, user_id: u1, vod_id: 901, kind: 'speech', start_sec: i * 60, end_sec: i * 60 + 20, text: t, label: null, confidence: 0.9 });
}
db.addTimelineEvents(lines);
db.addTimelineEvents([{ stream_id: s1, user_id: u1, vod_id: 901, kind: 'sound', start_sec: 30, end_sec: 33, text: null, label: 'Laughter', confidence: 0.8 }, { stream_id: s1, user_id: u1, vod_id: 901, kind: 'sound', start_sec: 90, end_sec: 93, text: null, label: 'Rock music', confidence: 0.8 }]);

// Offensive lines are fair game for quotes; threats / doxxing never are.
db.addTimelineEvents([
    { stream_id: s1, user_id: u1, vod_id: 901, kind: 'speech', start_sec: 5000, end_sec: 5010, text: "Let's go chat, you absolute clowns, that was insane you retards!", label: null, confidence: 0.9 },
    { stream_id: s1, user_id: u1, vod_id: 901, kind: 'speech', start_sec: 5100, end_sec: 5110, text: 'No way, chat, that guy should kill himself, kys buddy, insane!', label: null, confidence: 0.9 },
    { stream_id: s1, user_id: u1, vod_id: 901, kind: 'speech', start_sec: 5200, end_sec: 5210, text: 'Holy, that was insane, his home address is 12 elm street lol!', label: null, confidence: 0.9 },
]);
const cands = arena._quoteCandidates(u1);
assert.ok(cands.length >= 20, 'has candidates');
assert.ok(cands.some(c => c.text.includes('retards')), 'offensive vocabulary is not filtered out of quotes');
assert.ok(cands.every(c => !/kys|home address/.test(c.text)), 'threats / doxxing never become quotes');
console.log('✅ quote candidates: speech stays, behaviour goes');

const voice = arena._voiceStatsFor(u1, '-90 days');
assert.strictEqual(voice.has_data, true);
assert.strictEqual(voice.lines, 43);
assert.ok(voice.talk_ratio_pct > 0 && voice.talk_ratio_pct <= 100, `talk ratio: ${voice.talk_ratio_pct}`);
assert.ok(voice.hype_hits >= 10, `hype hits counted: ${voice.hype_hits}`);
assert.strictEqual(voice.laughs, 1);
assert.deepStrictEqual(voice.top_sounds.map(s => s.label).sort(), ['Laughter', 'Rock music']);
assert.ok(voice.voice_score > 0);
assert.strictEqual(arena._voiceStatsFor(u2, '-90 days').has_data, false, 'no transcript → no data');
console.log('✅ MIC voice stats from the transcription timeline');

const fighters = arena.listFighters();
assert.deepStrictEqual(fighters.map(f => f.user.username), ['alpha', 'bravo', 'charlie'], `roster ordered by power, idle excluded: ${fighters.map(f => f.user.username)}`);
assert.strictEqual(fighters[0].rank, 1);
assert.strictEqual(fighters[0].ratings.mic, 99, 'the only one with transcripts tops MIC');
assert.strictEqual(fighters[1].ratings.mic, fighters[2].ratings.mic, 'no-transcript fighters tie on MIC (shared rank)');
assert.ok(fighters[0].persona.fighter_name, 'fallback persona has a name even with AI off');
assert.strictEqual(fighters[0].persona_is_fallback, true);
assert.strictEqual(fighters[0].voice.has_data, true);
assert.deepStrictEqual(fighters[0].record, { wins: 0, losses: 0, draws: 0 }, 'beef record starts empty');
assert.deepStrictEqual(fighters[0].level, { level: 1, xp: 0 }, 'Trash Level starts at 1');
assert.strictEqual(fighters[0].ratings.talk_bonus, 0, 'no mouth bonus without XP');
console.log('✅ roster from real stream/analytics/transcript rows, inactive streamers excluded');

(async () => {
    const card = await arena.getFighter('alpha');
    assert.strictEqual(card.user.username, 'alpha');
    assert.strictEqual(card.rank, 1);
    assert.ok(card.raw.hours >= 9.9 && card.raw.hours <= 10.1, `hours aggregated: ${card.raw.hours}`);
    assert.strictEqual(card.raw.followers, 2);
    assert.strictEqual(card.image_url, null);
    assert.strictEqual(card.image_generation, 'off', 'no AI → no image generation');
    assert.ok(card.quotes && card.quotes.picks.length >= 3, 'heuristic quotes without AI');
    assert.ok(card.quotes.picks[0].vod_id === 901 && typeof card.quotes.picks[0].start_sec === 'number', 'quotes link to the VOD second');
    assert.strictEqual(card.quotes._fallback, true);
    assert.deepStrictEqual(card.beefs, []);
    assert.strictEqual(card.active_topic, null);
    assert.strictEqual(card.level.level, 1);
    const off = await arena.getFighter('idle');
    assert.strictEqual(off.not_on_roster, true);
    console.log('✅ fighter card + transcript quotes');

    const detail = arena.getStatDetail(u1, 'hype');
    assert.strictEqual(detail.position, 1);
    assert.strictEqual(detail.series.length, 2, 'one point per stream in the window');
    assert.strictEqual(detail.series[1].value, 120, 'latest stream last');
    assert.strictEqual(detail.top[0].user.username, 'alpha');
    const micDetail = arena.getStatDetail(u1, 'mic');
    assert.ok(micDetail.voice && micDetail.series.some(p => p.value > 0), 'mic series = % of stream talking');
    assert.strictEqual(arena.getStatDetail(u1, 'nope'), null);
    console.log('✅ stat drill-down');

    assert.deepStrictEqual(arena.liveFighters(), [], 'nobody live');
    const st = arena.status();
    assert.strictEqual(st.roster, 3);
    assert.strictEqual(st.with_voice_data, 1);
    assert.strictEqual(st.beefs_open, 0);
    assert.strictEqual(st.listener, 15000, 'listener tick advertised');
    console.log('✅ live fighters + status');

    console.log('\n✅ All Arena roster tests passed');
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
