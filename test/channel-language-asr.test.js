/**
 * A channel's speech is heard in its language (item 151, C11): media analysis, clip and VOD transcripts, OpenVibe.AI's
 * runs and the live memory decode in the channel's language (its chat language, set or detected) when a model can,
 * and Japanese speech survives the noise filter while whisper's Japanese inventions over silence do not.
 *
 *   node test/run.js channel-language-asr
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const translate = require('../server/i18n/translate');
const langs = { 7: 'ja', 8: 'de', 9: 'en' };
translate.channelLanguage = async (userId) => langs[userId] || 'en';
const transcribe = require('../server/ai/transcribe');

(async () => {
    // AI's path takes the channel's language as it is.
    assert.strictEqual(await transcribe.speechLanguage(7, { local: false }), 'ja');
    assert.strictEqual(await transcribe.speechLanguage(9, { local: false }), 'en');
    // A local decode: Japanese only with a multilingual whisper; otherwise English (never a model that cannot).
    const multi = Boolean(transcribe.multilingualModel());
    assert.strictEqual(await transcribe.speechLanguage(7), multi ? 'ja' : 'en');
    assert.strictEqual(await transcribe.speechLanguage(null), 'en');

    // Every path passes it on: no hard-coded English left where a channel is known.
    const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'server', 'ai', f), 'utf8');
    const ma = src('media-analysis.js');
    assert.doesNotMatch(ma, /language: 'en', start_sec/, 'AI windows carry the language');
    assert.match(ma, /_transcribeSpan\(src, duration, \{ userId \}\)/, 'analysis passes the channel');
    assert.match(ma, /transcribeWavDetailed\(wav, \{[^}]*language: lang/, 'local windows decode in it');
    assert.doesNotMatch(src('ai-media-analyze.js'), /language: 'en'/, 'AI\'s media.analyze is not forced to English');
    assert.match(src('ai-analysis.js'), /transcribeOnly\(src, \{ userId: clip\.user_id/, 'clip transcripts know their channel');
    assert.match(src('ai-analysis.js'), /userId: vod\.user_id/, 'VOD transcripts know their channel');
    assert.match(src('stream-memory-job.js'), /language: await transcribe\.speechLanguage\(stream\.user_id\)/, 'the live memory hears the channel');

    // Japanese speech is kept whole; whisper's Japanese stock phrases and subtitle credits are noise.
    assert.strictEqual(transcribe._isNoise('今日はマイクラで家を建てます'), false);
    assert.strictEqual(transcribe._isNoise('ありがとうございます、みんな！'), false);
    assert.strictEqual(transcribe._isNoise('ご視聴ありがとうございました。'), true);
    assert.strictEqual(transcribe._isNoise('チャンネル登録よろしくお願いします！'), true);
    assert.strictEqual(transcribe._isNoise('字幕：山田'), true);
    assert.strictEqual(transcribe._isNoise('Thanks for watching!'), true);
    assert.strictEqual(transcribe._isNoise('Let us build a house'), false);
    console.log('channel language asr: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
