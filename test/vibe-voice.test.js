'use strict';
// Vibe on stream (server/ai/vibe-voice.js): a streamer's call word in the live timeline wakes Vibe. "… clip that" clips
// the 45 s before the call word and posts the link; anything else is answered in the stream's chat from the stream's
// context, read aloud only when the streamer turned that on. Off by default; one
// wake per 8 s of stream time; the request may be the next phrase; the call word is the streamer's own.
const assert = require('assert');
const db = require('../server/db/database');
const voice = require('../server/ai/vibe-voice');

(async () => {
    await db.initDb();

    // ── The call word, heard the way speech-to-text writes it ──
    assert.strictEqual(voice.matchCallWord('Hey, Vibe, clip that.', 'hey vibe'), 'clip that.');
    assert.strictEqual(voice.matchCallWord('so hey vibes what is the score', 'hey vibe'), 'what is the score');
    assert.strictEqual(voice.matchCallWord('Hi Vibe!', 'hey vibe'), '', 'a greeting stands for another greeting');
    assert.strictEqual(voice.matchCallWord('that was a vibe check', 'hey vibe'), null, 'the call word is whole, greeting included');
    assert.strictEqual(voice.matchCallWord('nothing to see here', 'hey vibe'), null);
    assert.strictEqual(voice.matchCallWord('Okay, robot! Jump twice', 'okay robot'), 'Jump twice', 'a call word of their own');
    assert.strictEqual(voice.validCallWord('  Hey   VIBE '), 'hey vibe');
    assert.strictEqual(voice.validCallWord('yo'), null, 'too short');
    assert.strictEqual(voice.validCallWord('a b c d e'), null, 'too many words, none of three letters');
    for (const r of ['clip that', 'Please clip it!', 'make a clip of that', 'save that', 'clip']) assert.ok(voice.isClipRequest(r), r);
    for (const r of ['what is the clip count', 'how many viewers']) assert.ok(!voice.isClipRequest(r), r);

    // ── Wiring: fakes for the recorder, Media, the model and chat delivery ──
    const NOW = 1_800_000_000_000;
    const posted = [], clips = [], asked = [];
    const deps = {
        now: () => NOW,
        recorder: { getActiveRecording: () => ({ vodId: 9, startedAt: NOW - 600_000 }) },
        media: { createClip: async (o) => { clips.push(o); return { id: 77 }; } },
        videoUrl: (kind, id) => `https://openvibe.video/${kind}/${id}`,
        delivery: { message: (m) => m, after: (m) => { posted.push(m); } },
        llm: { complete: async (o) => { asked.push(o); return { text: '"It is Minecraft, a survival world. She has long blonde hair."' }; } },
    };
    const stream = { id: 501, user_id: 42, title: 'Building a castle', category: 'Minecraft' };
    const speech = (start_sec, text) => ({ kind: 'speech', start_sec, text });

    voice._reset();
    assert.deepStrictEqual(await voice.onSpeech(stream, [speech(100, 'hey vibe clip that')], deps), [], 'off unless the streamer turns it on');
    assert.strictEqual(posted.length, 0);

    assert.ok((await voice.saveSettings(42, { call_word: 'x' })).error, 'a call word that breaks the rule is refused');
    const saved = await voice.saveSettings(42, { enabled: true });
    assert.deepStrictEqual(saved.settings, { enabled: true, call_word: 'hey vibe', speak: false });

    // Clip: the 45 s before the call word, from the recording, linked in chat.
    let done = await voice.onSpeech(stream, [speech(100, 'Hey Vibe, clip that!')], deps);
    assert.deepStrictEqual(done.map((d) => d.action), ['clip']);
    assert.deepStrictEqual([clips[0].vod_id, clips[0].start_s, clips[0].end_s, clips[0].auto_generated], [9, 56, 101, false]);
    assert.strictEqual(posted[0].username, 'Vibe');
    assert.strictEqual(posted[0].frame.is_ai, true);
    assert.ok(posted[0].message.includes('https://openvibe.video/clip/77'), posted[0].message);

    // Within the wake gap: ignored. After it: an answer, from the stream's context.
    done = await voice.onSpeech(stream, [speech(104, 'hey vibe what game is this')], deps);
    assert.deepStrictEqual(done, [], 'one wake per 8 s of stream time');
    done = await voice.onSpeech(stream, [speech(130, 'hey vibe what game is this')], deps);
    assert.deepStrictEqual(done.map((d) => [d.action, d.request]), [['answer', 'what game is this']]);
    assert.ok(asked[0].user.includes('Stream title: Building a castle') && asked[0].user.includes('The streamer asked you: what game is this'));
    const answer = posted[posted.length - 1];
    assert.ok(answer.message.includes('Minecraft'), answer.message);
    assert.strictEqual(answer.tts, undefined, 'not read aloud unless asked');

    // Read aloud when turned on; the request may be the next phrase ("Hey Vibe." … "clip that").
    await voice.saveSettings(42, { speak: true });
    await voice.onSpeech(stream, [speech(200, 'hey vibe how long have I been live')], deps);
    assert.deepStrictEqual(posted[posted.length - 1].tts, { identity_key: 'aibot:vibe' });
    done = await voice.onSpeech(stream, [speech(300, 'Hey Vibe.'), speech(302, 'clip that')], deps);
    assert.deepStrictEqual(done.map((d) => [d.action, d.request]), [['clip', 'clip that']]);

    // No recording: says so instead of clipping.
    const noRec = { ...deps, recorder: { getActiveRecording: () => null } };
    await voice.onSpeech(stream, [speech(400, 'hey vibe clip it')], noRec);
    assert.ok(/isn't being recorded/.test(posted[posted.length - 1].message));

    // Their own call word.
    await voice.saveSettings(42, { call_word: 'Okay Robot' });
    done = await voice.onSpeech(stream, [speech(500, 'hey vibe clip that'), speech(520, 'okay robot, clip that')], deps);
    assert.deepStrictEqual(done.map((d) => d.start_sec), [520], 'only their word wakes it');

    console.log('vibe voice: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
