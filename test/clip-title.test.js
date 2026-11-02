'use strict';
// AI titles for untitled clips (server/ai/clip-title.js, migration 0019): a clip still named by a placeholder is titled
// from its overview through live.stream.titles, once; a title a person gave is kept; a slur
// one gives way to a safe one; a person who names the clip while the AI writes wins. A clip's chat announcement waits a
// little for the AI title (clip-notify _waitForTitle), and the title route marks a person's title kept.
//
//   node test/clip-title.test.js
const assert = require('assert');

process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

(async () => {
    const titles = require('../server/ai/clip-title');

    // ── What counts as a title nobody chose ──
    for (const t of ['', null, 'Untitled Clip', 'untitled clip.', 'Clip from stream', '  clip  ', 'New clip']) assert.ok(titles.isPlaceholder(t), `placeholder: ${t}`);
    assert.ok(titles.isPlaceholder('Clip: Friday ranked', ['Friday ranked']), "vods.js's default for a clip without a title");
    assert.ok(titles.isPlaceholder('Clip: Stream Recording'), 'the default when the stream had no title');
    for (const t of ['test', 'Clip: what a save', 'Triple kill', 'Untitled Clip 2']) assert.ok(!titles.isPlaceholder(t, ['Friday ranked']), `chosen: ${t}`);

    const db = require('../server/db/database');
    await db.initDb();
    const media = require('../server/media-client');
    const ai = require('../server/ai/ai-analysis');
    const aiService = require('../server/ai/ai-service');

    let enabled = true;
    ai.isEnabled = async () => enabled;
    ai.withinBudget = async () => true;
    db.getStreamById = async (id) => ({ id, title: 'Friday ranked', username: 'alice', category: 'Shooters', is_live: 1 });

    const now = () => new Date().toISOString();
    const clips = new Map();
    const reads = new Map();     // clip id → titles to answer on later reads (a person renaming it mid-run)
    const put = (id, title, extra = {}) => clips.set(id, { id, title, stream_id: 9, user_id: 7, start_time: 42, status: 'ready', created_at: now(), ...extra });
    media.getClip = async (id) => {
        id = Number(id);
        if (id === 607) { const e = new Error('Not found'); e.status = 404; throw e; }
        const later = reads.get(id);
        if (later && later.length > 1) clips.get(id).title = later.shift();
        else if (later && later.length === 1) { clips.get(id).title = later.shift(); reads.delete(id); }
        return clips.has(id) ? { ...clips.get(id) } : null;
    };
    const updates = [];
    media.updateClip = async (id, fields) => { updates.push([Number(id), fields.title]); clips.get(Number(id)).title = fields.title; return { id }; };

    const calls = [];
    const answers = { 'triple kill': 'Triple Kill Final Round Clutch', 'dress': 'Woman In Red Dress Dances', 'painted': 'Boobs by Bobs Chalk Talk', 'rough clutch': 'Fucking Insane Clutch', 'rename': 'Late Game Comeback', 'default': 'Shotgun Rush Through Hallway' };
    aiService.structured = async (workflow, input, opts) => {
        calls.push({ workflow, input, opts });
        return { titles: input.summaries.map((s, index) => {
            const key = Object.keys(answers).find((k) => s.toLowerCase().includes(k)) || 'default';
            return { index, title: answers[key] };
        }) };
    };

    const seed = async (id, overview, extra = {}) => {
        await db.run('INSERT INTO clip_ai_state (clip_id, ai_overview, clip_notified, ai_transcript_json) VALUES (?, ?, ?, ?)',
            [id, overview, extra.notified ?? 1, extra.transcript ? JSON.stringify([{ start: 0, end: 2, text: extra.transcript }]) : null]);
    };
    const status = async (id) => ((await db.getClipAiState(id)) || {}).title_status || null;

    put(601, 'Untitled Clip');            await seed(601, 'The streamer lands a triple kill in the final round.', { transcript: 'no way, no way!', notified: 0 });
    put(602, 'My epic moment');           await seed(602, 'A quiet walk through the market.');
    put(603, 'Clip: Friday ranked');      await seed(603, 'A shotgun rush through a narrow hallway.');
    put(604, 'Clip from stream');         await seed(604, '   ');
    put(605, 'Clip from stream');         await seed(605, 'Someone in a red dress dances on the stage while chat cheers.');
    put(606, 'Untitled Clip');            await seed(606, 'A rough clutch play in the last seconds.');
                                          await seed(607, 'Overview of a clip Media no longer has.');
    put(612, 'Clip from stream');         await seed(612, 'A streamer shows chalkboard signs for "Boobs Painted by Bobs", an art collection.');
    put(608, 'Untitled Clip');            await seed(608, 'A rename test: a late game comeback.');
    reads.set(608, ['Untitled Clip', 'What a comeback']);  // the person names it before the AI's title is saved

    // ── One run titles every waiting clip with one AI call ──
    const n = await titles.titleClips();
    assert.strictEqual(calls.length, 1, 'one AI call for the batch');
    assert.strictEqual(calls[0].workflow, 'live.stream.titles');
    assert.strictEqual(calls[0].opts.meter.kind, 'clip_titles');
    const summaries = calls[0].input.summaries;
    assert.ok(summaries.length === 6 && summaries.every((s) => s.length <= 1000), 'one summary per placeholder clip with an overview');
    const s601 = summaries.find((s) => s.includes('triple kill'));
    assert.ok(s601.includes('Said: "no way, no way!"') && s601.includes('From the stream "Friday ranked" (Shooters)'), s601);

    const byId = new Map(updates);
    assert.strictEqual(byId.get(601), 'Triple Kill Final Round Clutch');
    assert.strictEqual(byId.get(603), 'Shotgun Rush Through Hallway', '"Clip: <stream title>" is a placeholder');
    assert.strictEqual(byId.get(605), 'Woman In Red Dress Dances', 'describing someone is fine (2026-10-31)');
    assert.strictEqual(byId.get(606), 'Fucking Insane Clutch', 'swearing is fine in a title (2026-10-31)');
    assert.strictEqual(byId.get(612), 'Boobs by Bobs Chalk Talk', 'body words are fine (2026-10-31)');
    assert.ok(!byId.has(602) && !byId.has(604) && !byId.has(607) && !byId.has(608), 'nothing else is written to Media');
    assert.strictEqual(n, 5);

    assert.deepStrictEqual(
        [await status(601), await status(602), await status(603), await status(604), await status(605), await status(606), await status(607), await status(608)],
        ['titled', 'kept', 'titled', null, 'titled', 'titled', 'failed', 'kept']);
    assert.strictEqual(clips.get(608).title, 'What a comeback', "the person's name for it stands");
    assert.ok((await db.getClipAiState(601)).clip_notify_at, 'a pending chat announcement goes out with the new title');

    // ── Each clip is decided once ──
    assert.strictEqual(await titles.titleClips(), 0);
    assert.strictEqual(calls.length, 1, 'nothing left to ask about');

    // ── 2026-10-27: an auto-clip's first-guess title, a clip whose analysis gave up, a clip of an upload ──
    media.getVod = async (id) => ({ 6010: { id: 6010, title: 'Seattle' }, 7000: { id: 7000, title: 'My upload' } })[Number(id)] || null;
    put(620, 'A Person Is Standing In A Living Room, Facing', { auto_generated: 1 });
    await seed(620, 'A triple kill in the final round, clean.');
    put(621, 'Clip: Seattle', { vod_id: 6010, start_time: 1873.5, end_time: 1903.5 });
    await seed(621, '');
    await db.run("UPDATE clip_ai_state SET transcript_status = 'failed' WHERE clip_id = 621");
    await db.run('INSERT INTO vod_ai_state (vod_id, ai_transcript_json) VALUES (6010, ?) ON CONFLICT (vod_id) DO UPDATE SET ai_transcript_json = excluded.ai_transcript_json',
        [JSON.stringify([{ start: 100, end: 104, text: 'way before the clip' }, { start: 1880, end: 1884, text: 'we need a rename right now' }])]);
    put(622, 'Clip: My upload', { stream_id: null, vod_id: 7000 });
    await seed(622, 'A shotgun rush down the stairs.');
    put(623, 'Clip: Seattle', { vod_id: 6010 });
    await seed(623, '');   // analysis still running: waits
    const before = calls.length;
    assert.strictEqual(await titles.titleClips(), 3);
    const asked = calls[before].input.summaries;
    assert.ok(asked.some((x) => x.includes('Said in the clip: "we need a rename right now"') && !x.includes('way before')), 'the failed one is named from its window of the transcript');
    assert.strictEqual(clips.get(620).title, 'Triple Kill Final Round Clutch', 'an auto-clip\'s caption title is renamed from its overview');
    assert.strictEqual(clips.get(621).title, 'Late Game Comeback', '"Clip: <the video\'s title>" with no overview, named from what was said');
    assert.strictEqual(clips.get(622).title, 'Shotgun Rush Through Hallway', 'a clip of an upload is a placeholder too');
    assert.strictEqual(await status(623), null, 'a clip still being analysed waits');

    // ── A clip whose overview just landed is titled by id; nothing runs while the AI is off ──
    put(609, 'Untitled Clip');            await seed(609, 'A speedrun skip through the castle wall.');
    enabled = false;
    const callsBefore = calls.length;
    assert.strictEqual(await titles.titleClips({ ids: [609] }), 0);
    assert.strictEqual(calls.length, callsBefore, 'no AI call with the AI off');
    enabled = true;
    assert.strictEqual(await titles.titleClips({ ids: [609] }), 1);
    assert.strictEqual(clips.get(609).title, 'Shotgun Rush Through Hallway');

    // ── The chat announcement waits for the AI title, briefly ──
    const notify = require('../server/media-proxy/clip-notify');
    const stream = { title: 'Friday ranked' };
    put(610, 'Clip: Friday ranked');      await seed(610, ' ');
    assert.strictEqual(await notify._waitForTitle(clips.get(610), stream), true, 'a fresh untitled clip waits');
    const old = new Date(Date.now() - (notify.TITLE_WAIT_SECONDS + 5) * 1000).toISOString();
    assert.strictEqual(await notify._waitForTitle({ ...clips.get(610), created_at: old }, stream), false, 'not past the wait');
    assert.strictEqual(await notify._waitForTitle({ ...clips.get(610), created_at: old.replace('T', ' ').replace(/\.\d+Z$/, '') }, stream), false, "Media's SQL-style time is read too");
    assert.strictEqual(await notify._waitForTitle(clips.get(601), stream), false, 'a titled clip goes out');
    assert.strictEqual(await notify._waitForTitle(clips.get(602), stream), false, "a person's title goes out");
    enabled = false;
    assert.strictEqual(await notify._waitForTitle(clips.get(610), stream), false, 'no wait with the AI off');
    enabled = true;
    await db.run("UPDATE clip_ai_state SET title_status = 'failed' WHERE clip_id = 610");
    assert.strictEqual(await notify._waitForTitle(clips.get(610), stream), false, 'no wait once the AI gave up');

    // ── A person's title from the title route is kept, even with no clip_ai_state row yet ──
    const auth = require('../server/auth/auth');
    auth.requireAuth = (req, _res, next) => { req.user = { id: 7, username: 'alice', role: 'streamer' }; next(); };
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/clips', require('../server/media-proxy/clips'));
    const server = require('http').createServer(app).listen(0);
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    put(611, 'Untitled Clip');
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/clips/611/title`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Big brain play' }),
    });
    server.close();
    assert.strictEqual(res.status, 200, await res.clone().text());
    assert.strictEqual(clips.get(611).title, 'Big brain play');
    assert.strictEqual(await status(611), 'kept', 'the AI leaves a named clip alone');

    quiet('clip titles: all checks passed');
    process.exit(0);
})().catch((err) => { quiet(err); process.exit(1); });
