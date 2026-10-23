'use strict';
// A clip's overview pass records speech only when speech-to-text heard the clip (ai-analysis.clipOverviewSpeech):
// heard with words → the segments and 'done'; heard, no words → [] and 'empty'; not heard (AI could not read the
// media, whisper down) → nothing, so ai_transcript_json stays NULL and the transcript poller retries the clip. Storing
// [] for a failure took 172 clips out of the queue for good (2026-10-23). Against the database: the stored row, and
// getClipsNeedingTranscript picking the clip up only in the failure case.
const assert = require('assert');
console.warn = () => {};

const db = require('../server/db/database');
const { clipOverviewSpeech } = require('../server/ai/ai-analysis');

(async () => {
    await db.initDb();
    const seg = [{ start: 0, end: 2, text: 'hello chat' }];
    assert.deepStrictEqual(clipOverviewSpeech({ transcriptOk: true, transcript: 'hello chat', segments: seg }), { segments: seg, status: 'done' });
    assert.deepStrictEqual(clipOverviewSpeech({ transcriptOk: true, transcript: '', segments: [] }), { segments: [], status: 'empty' });
    assert.deepStrictEqual(clipOverviewSpeech({ transcriptOk: false, transcript: '', segments: [] }), { segments: null, status: null });
    assert.deepStrictEqual(clipOverviewSpeech(null), { segments: null, status: null });

    // What the overview pass then writes (generateClipOverview's two calls), for three clips.
    const store = async (id, r) => {
        const speech = clipOverviewSpeech(r);
        await db.setClipAiOverview(id, { overview: 'A cooking stream.', segments: speech.segments });
        if (speech.status) await db.setClipTranscriptStatus(id, speech.status);
    };
    await store(9101, { transcriptOk: true, transcript: 'hello chat', segments: seg });
    await store(9102, { transcriptOk: true, transcript: '', segments: [] });
    await store(9103, { transcriptOk: false, transcript: '', segments: [] });
    const row = async (id) => db.get('SELECT ai_transcript_json, transcript_status FROM clip_ai_state WHERE clip_id = ?', [id]);
    assert.deepStrictEqual({ ...await row(9101) }, { ai_transcript_json: JSON.stringify(seg), transcript_status: 'done' });
    assert.deepStrictEqual({ ...await row(9102) }, { ai_transcript_json: '[]', transcript_status: 'empty' });
    assert.strictEqual((await row(9103)).ai_transcript_json, null, 'a failed pass stores no transcript');
    const queued = (await db.getClipsNeedingTranscript(50)).map((r) => Number(r.id));
    assert.ok(queued.includes(9103), 'the poller retries the clip speech-to-text could not hear');
    assert.ok(!queued.includes(9101) && !queued.includes(9102), 'a heard clip is not transcribed again');
    console.log('clip-overview-speech: ok');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
