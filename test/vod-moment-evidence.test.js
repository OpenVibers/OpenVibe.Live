'use strict';
// The VOD-moment clip cutter scores what it has before it cuts, and may abstain (item 151, C08):
//   - the AI's own clips are not "people clipped here" (lookups.clipStartTimes);
//   - a clip never re-cuts footage a person already clipped, and never comes from a long scene note alone;
//   - the AI may say nothing is worth it, and no weaker signal is tried in its place;
//   - the moment's evidence (chat bucket against the stream's zero-filled average, people, sounds, words) goes through
//     clip-score.js: thin → not cut, kept → unlisted, a reacted room → public; no evidence → not cut;
//   - the clip log and Bench name the policy that cut it.
const assert = require('assert');
const db = require('../server/db/database');
console.warn = () => {};

(async () => {
    await db.initDb();
    const media = require('../server/media-client');
    const lookups = require('../server/media-proxy/lookups');
    const chatReads = require('../server/chat/chat-reads');
    const registry = require('../server/ai/moment-registry');
    const ai = require('../server/ai/ai-analysis');
    const aiService = require('../server/ai/ai-service');
    const autoClip = require('../server/ai/auto-clip-job');
    const moments = require('../server/ai/ai-moments-job');
    const evaluation = require('../server/ai/clip-evaluation');
    const log = []; const logs = console.log; console.log = (...a) => log.push(a.join(' '));

    // ── People's clips only ───────────────────────────────────────────────
    media.listClips = async () => ({ clips: [
        { id: 1, start_time: 600, auto_generated: false },
        { id: 2, start_time: 1200, auto_generated: true },
        { id: 3, start_time: 1800 },
    ] });
    assert.deepStrictEqual(await lookups.clipStartTimes(91, 92), [600, 1800], 'the AI\'s clip at 1200 s is not a person choosing a moment');

    // ── The score at the cutter ───────────────────────────────────────────
    const rate = autoClip._internals.rateVodMoment;
    assert.strictEqual(rate(undefined).verdict, 'skip', 'no evidence, no clip');
    const quiet = rate({ picked_by: 'ai', spike: { peak: 0, avg: 0 }, chatters: null, sounds: [{ label: 'Laughter', confidence: 0.8 }], speechWords: 30 });
    assert.strictEqual(quiet.verdict, 'unlisted', 'a quiet channel\'s laugh the AI picked is kept: a small audience is not a poor moment');
    assert.strictEqual(quiet.bucket, 'A');
    const talk = rate({ picked_by: 'ai', spike: { peak: 0, avg: 0 }, chatters: null, sounds: [], speechWords: 30 });
    assert.strictEqual(talk.verdict, 'skip', 'talk the AI liked, with nothing heard or typed, is not cut: no quota to fill');
    const room = rate({ picked_by: 'ai', spike: { peak: 22, avg: 1.5 }, chatters: 7, sounds: [], speechWords: 25 });
    assert.strictEqual(room.verdict, 'public', 'a reacted room (22 messages from 7 people) can be public');
    const unknown = rate({ picked_by: 'ai', spike: { peak: 22, avg: 1.5 }, chatters: null, sounds: [], speechWords: 25 });
    assert.strictEqual(unknown.verdict, 'unlisted', 'the same spike with nobody counted is kept unlisted');
    const signals = rate({ picked_by: 'chat', spike: { peak: 9, avg: 3 }, chatters: 2, sounds: [], speechWords: 5 });
    assert.strictEqual(signals.verdict, 'skip', 'a small spike with no AI opinion is not cut (both bars rise without the AI)');

    // ── clipVodMoment: the verdict is the visibility, and the log keeps the provenance ──
    const created = [];
    media.createClip = async (body) => { created.push(body); return { id: 9100 + created.length }; };
    media.getVod = async () => ({ id: 1, visibility: 'public' });
    await db.setState('auto_clip_log', '[]');
    await registry._clear();
    const vod = (id) => ({ vod_id: id, id, user_id: 3, stream_id: id, visibility: 'public' });
    assert.strictEqual(await autoClip.clipVodMoment({ vod: vod(501), offset: 300, title: 'Just talking', desc: 'A person talks to the camera about lunch', evidence: { picked_by: 'ai', spike: { peak: 0, avg: 0 }, chatters: null, sounds: [], speechWords: 30 } }), null);
    assert.strictEqual(created.length, 0, 'the thin moment never reached Media');
    assert.ok(log.some((l) => /VOD 501 @300s not cut — score/.test(l)), 'the abstention is logged with its score');
    // The verifier (C09) answers for public clips only; each call is recorded.
    const verifyCalls = [];
    let verdictFor = () => ({ verdict: 'supported', unsupported: [], why: 'it happens' });
    aiService.structured = async (name, input) => { if (name === 'live.moments.verify') { verifyCalls.push(input); return verdictFor(input); } return null; };
    const lines = { timeline: [{ t: 298, text: 'the streamer trips over a cable' }], transcript: [{ t: 299, text: 'oh no the cable' }], sounds: [] };
    const c1 = await autoClip.clipVodMoment({ vod: vod(502), offset: 300, title: 'The room lost it', desc: 'The streamer trips over the cable mid-sentence', lines, evidence: { picked_by: 'ai', spike: { peak: 22, avg: 1.5 }, chatters: 7, sounds: [], speechWords: 25 } });
    assert.strictEqual(verifyCalls.length, 1, 'a public clip is checked first');
    assert.deepStrictEqual([verifyCalls[0].clip_title, verifyCalls[0].t, verifyCalls[0].timeline[0].text, verifyCalls[0].chat.people], ['The room lost it', 300, 'the streamer trips over a cable', 7]);
    assert.ok(c1 && c1.id);
    const c2 = await autoClip.clipVodMoment({ vod: vod(503), offset: 300, title: 'A laugh', desc: 'A dog barks and the streamer laughs at the window', evidence: { picked_by: 'ai', spike: { peak: 0, avg: 0 }, chatters: null, sounds: [{ label: 'Laughter', confidence: 0.8 }], speechWords: 30 } });
    assert.ok(c2 && c2.id);
    assert.deepStrictEqual(created.map((b) => b.visibility), ['public', 'unlisted'], 'public only for the reacted room');
    assert.strictEqual(verifyCalls.length, 1, 'an unlisted clip is not checked');
    assert.deepStrictEqual([created[0].start_s, created[0].end_s], [284, 309], 'no speech near it: the fixed 16 s before and 9 s after');

    // ── A VOD clip starts and ends on sentences (clip-trim.js), as a live clip does (11-03: it always used the window) ──
    const rows = [
        { start: 120, end: 126, text: 'Long before the moment.' },
        { start: 279.2, end: 286.0, text: 'So I was telling chat about the cable.' },
        { start: 286.4, end: 296.1, text: 'And then I just walked straight into it, look at this.' },
        { start: 296.5, end: 305.8, text: 'Oh no, oh no, the whole desk is going.' },
        { start: 306.2, end: 311.0, text: 'Chat, did you see that?' },
    ];
    const near = moments._internals.rowsNear(rows, 300);
    const ln = moments._internals.linesNear({ memories: [{ offset_seconds: 295, description: 'a desk tips over' }, { offset_seconds: 900, description: 'far' }], said: rows, heard: [{ start_sec: 301, label: 'Laughter' }] }, 300);
    assert.deepStrictEqual([ln.timeline.map((x) => x.text), ln.transcript.length, ln.sounds], [['a desk tips over'], 4, [{ t: 301, label: 'Laughter' }]], 'the verifier reads the minute around the moment');
    assert.deepStrictEqual(near.map((r) => r.start), [279.2, 286.4, 296.5, 306.2], 'the rows within a minute of the moment');
    const c3 = await autoClip.clipVodMoment({ vod: { ...vod(504), duration: 3600 }, offset: 300, title: 'Desk goes down', desc: 'The streamer walks into the cable and the desk tips over', segments: near, evidence: { picked_by: 'ai', spike: { peak: 22, avg: 1.5 }, chatters: 7, sounds: [], speechWords: 25 } });
    assert.ok(c3 && c3.id);
    const b3 = created[created.length - 1];
    assert.deepStrictEqual([b3.start_s, b3.end_s], [278.9, 311.5], 'from the start of the sentence before to the end of the one after, with a little air');
    assert.ok(log.some((l) => /VOD 504 @300s cut .*, on sentences/.test(l)));
    const c4 = await autoClip.clipVodMoment({ vod: { ...vod(505), duration: 304 }, offset: 300, title: 'At the end', desc: 'The streamer says goodbye as the stream ends abruptly', segments: near, evidence: { picked_by: 'ai', spike: { peak: 22, avg: 1.5 }, chatters: 7, sounds: [], speechWords: 25 } });
    assert.ok(c4 && c4.id);
    assert.ok(created[created.length - 1].end_s <= 303.5, 'never past the end of the recording');
    const entries = JSON.parse(await db.getState('auto_clip_log'));
    const e1 = entries.find((e) => e.clip_id === c1.id);
    assert.deepStrictEqual(e1.policy, { selector: 'vod-moment', version: '2026-11-03' });
    assert.strictEqual(e1.picked_by, 'ai');
    assert.strictEqual(e1.bucket, 'D');
    assert.ok(e1.score >= 0.7);

    assert.strictEqual(e1.verified, 'supported');

    // ── C09: an unbacked title is not cut; "unsure" or a failed check keeps the clip unlisted ──
    const reacted = { picked_by: 'ai', spike: { peak: 22, avg: 1.5 }, chatters: 7, sounds: [], speechWords: 25 };
    verdictFor = () => ({ verdict: 'unsupported', unsupported: ['a dragon explodes'], why: 'no dragon' });
    const before = created.length;
    assert.strictEqual(await autoClip.clipVodMoment({ vod: vod(510), offset: 300, title: 'Dragon Eruption', desc: 'A dragon explodes on screen', lines, evidence: reacted }), null);
    assert.strictEqual(created.length, before, 'not cut');
    assert.ok(log.some((l) => /VOD 510 @300s not cut — the title or description is not backed by the moment \(a dragon explodes\)/.test(l)));
    verdictFor = () => ({ verdict: 'unsure', unsupported: [], why: 'too little' });
    assert.ok(await autoClip.clipVodMoment({ vod: vod(511), offset: 300, title: 'Cable Trip', desc: 'The streamer trips', lines, evidence: reacted }));
    assert.strictEqual(created[created.length - 1].visibility, 'unlisted', 'unsure: kept unlisted');
    verdictFor = () => { throw new Error('AI down'); };
    assert.ok(await autoClip.clipVodMoment({ vod: vod(512), offset: 300, title: 'Cable Trip Again', desc: 'The streamer trips twice', lines, evidence: reacted }));
    assert.strictEqual(created[created.length - 1].visibility, 'unlisted', 'a failed check is not a yes');
    verdictFor = () => ({ verdict: 'yes!' });
    assert.ok(await autoClip.clipVodMoment({ vod: vod(513), offset: 300, title: 'Cable Trip Thrice', desc: 'The streamer trips thrice', lines, evidence: reacted }));
    assert.strictEqual(created[created.length - 1].visibility, 'unlisted', 'an answer outside the set is not a yes');
    const logged = JSON.parse(await db.getState('auto_clip_log'));
    assert.strictEqual(logged.find((e) => e.vod_id === 512).verified, 'failed');
    assert.strictEqual(logged.find((e) => e.vod_id === 512).visibility, 'unlisted', 'the log records what was published');
    verdictFor = () => ({ verdict: 'supported', unsupported: [], why: 'it happens' });

    // ── Bench names the policy that cut the clip ──
    assert.deepStrictEqual(evaluation.policyOf({ id: c1.id }, entries), { selector: 'vod-moment', version: '2026-11-03', models: [] });
    assert.deepStrictEqual(evaluation.policyOf({ id: 4242 }, entries), { selector: 'auto-clip', version: evaluation.AUTO_CLIP_POLICY, models: [] }, 'an older clip keeps the old label');

    // ── The picker, AI off: a clip needs something people or the room did ──
    ai.isEnabled = async () => false;
    await db.run(`INSERT INTO users (id, username, display_name, email, password_hash, role, created_at) OVERRIDING SYSTEM VALUE
                  VALUES (3, 'eve', 'eve', 'eve@x', 'x', 'streamer', '2025-01-01 00:00:00') ON CONFLICT DO NOTHING`);
    const sid = (await db.get(`INSERT INTO streams (user_id, title, started_at, ended_at) VALUES (3, 'evidence', '2026-11-01 10:00:00', '2026-11-01 12:00:00') RETURNING id`)).id;
    db.getStreamMemories = async () => [
        { offset_seconds: 400, description: 'A very long and detailed scene note about the streamer sitting at a desk with a lamp and a plant and a poster' },
        { offset_seconds: 1500, description: 'The streamer laughs at a clip on the second monitor' },
        { offset_seconds: 3000, description: 'The streamer reads chat' },
    ];
    db.getStreamTranscriptSegments = async () => [{ start: 1495, end: 1505, text: 'oh no that is the funniest thing I have seen all week honestly' }];
    db.getTimeline = async () => [];
    chatReads.spikeOffsets = async () => [];
    chatReads.streamStats = async () => ({ messages: 240, chatters: 9, sounds: 0 });
    media.listClips = async () => ({ clips: [{ id: 11, start_time: 3000, auto_generated: false }] });
    const v = { vod_id: 600, stream_id: sid, duration: 7200, title: 'Evidence' };
    assert.strictEqual(await moments.findBestMoment(v, { flavor: 'clip' }), null,
        'scene notes alone, and the second a person already clipped, give no clip');
    const paste = await moments.findBestMoment(v, { flavor: 'paste' });
    assert.ok(paste && paste.offset === 3000 && paste.evidence.picked_by === 'people', 'a paste may still use the second people chose');

    db.getTimeline = async () => [{ start_sec: 1500, end_sec: 1503, label: 'Laughter', confidence: 0.85 }];
    chatReads.spikeOffsets = async () => [{ offset: 1500, count: 14, people: 5 }];
    const clip = await moments.findBestMoment(v, { flavor: 'clip' });
    assert.ok(clip, 'a laugh and a chat spike make a clip moment');
    assert.strictEqual(clip.offset, 1500);
    assert.strictEqual(clip.evidence.spike.peak, 14);
    assert.strictEqual(clip.evidence.chatters, 5);
    assert.ok(clip.evidence.spike.avg > 0.9 && clip.evidence.spike.avg < 1.1, 'the average counts the quiet stretches: 240 messages over 240 buckets');
    assert.ok(clip.evidence.speechWords >= 10, 'the words come from the whole transcript near the moment, not a sample');
    assert.strictEqual(clip.evidence.sounds[0].label, 'laughter', 'the sound is said by its tag (sound-captions.evidence)');

    // ── The AI may abstain: no weaker signal is tried in its place ──
    ai.isEnabled = async () => true; ai.withinBudget = async () => true;
    aiService.structured = async () => ({ abstain: true, why: 'nothing stands out' });
    assert.strictEqual(await moments.findBestMoment(v, { flavor: 'clip' }), null, 'the AI said nothing is worth it');
    aiService.structured = async () => ({ t: null });
    assert.strictEqual(await moments.findBestMoment(v, { flavor: 'clip' }), null, 't: null is an abstention too');
    // A paste is never left empty by a declined pick: the signals choose its frame (11-03).
    aiService.structured = async () => ({ abstain: true, why: 'nothing stands out' });
    const pasteBack = await moments.findBestMoment(v, { flavor: 'paste' });
    assert.ok(pasteBack && Number.isFinite(pasteBack.offset), 'a declined paste falls back to the signals');
    assert.notStrictEqual(pasteBack.evidence.picked_by, 'ai');
    let asked = null;
    aiService.structured = async (_name, input) => { asked = input; return { t: 1500, title: 'Lost it', desc: 'The streamer laughs at a clip on the second monitor' }; };
    const picked = await moments.findBestMoment(v, { flavor: 'clip' });
    assert.ok(picked && picked.evidence.picked_by === 'ai');
    assert.deepStrictEqual(asked.clipped, [], 'a clip pick is not steered to the second people already clipped');
    assert.ok(asked.avoid.includes(3000), '…it is told to stay away from it');

    console.log = logs;
    console.log('vod moment evidence: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
