'use strict';
/**
 * A stream-backed VOD gets its overview from the stream's memories (server/ai/ai-analysis.js). 11-18: the summary is an
 * object ({ overview, category, tags }) and storing it threw inside setVodAiOverview; the catch hid it, the backfill
 * asked again every minute for the same newest VOD, and no stream-backed VOD got an overview (481 waiting). Checked
 * here with stub modules, no database and no network:
 *   - the overview's text is stored and returned;
 *   - with no summary and AI available, the media pass runs and marks the VOD (it never holds the queue);
 *   - with AI off or over budget, nothing is marked: it waits.
 *
 *   node test/vod-overview-from-memories.test.js
 */
const assert = require('assert');
const path = require('path');

const stored = [];
const analysed = [];
let summaryAnswer = null;
let aiOn = true;

const stub = (rel, exports) => { const file = require.resolve(path.join(__dirname, '..', rel)); require.cache[file] = { id: file, filename: file, loaded: true, exports }; };
stub('server/db/database', {
    getSetting: async (k) => (k === 'ai_enabled' ? aiOn : k === 'ai_max_cost_usd_per_day' ? 0 : null),
    getAiCostToday: async () => 0,
    getStreamMemories: async () => [{ description: 'A cat walks onto the desk.' }, { description: 'The streamer laughs and moves the cat.' }],
    getTimeline: async () => [],
    getVodAiTimelineCount: async () => 2,
    setVodAiOverview: async (id, text) => { if (typeof text !== 'string') throw new TypeError('text.trim is not a function'); stored.push([id, text]); },
    setVodTranscript: async () => {}, setVodTranscriptStatus: async () => {},
    getVod: async () => null,
});
stub('server/ai/llm', { isEnabled: async () => aiOn, withinBudget: async () => true });
stub('server/ai/ai-service', { enabled: () => aiOn, structured: async () => summaryAnswer });
stub('server/ai/ai-media-analyze', { enabled: () => false });
stub('server/ai/media-analysis', {
    analyzeMedia: async (src, o) => { analysed.push([src, o.ref && o.ref.id]); return { overview: 'Made from the picture and sound.', transcript: '' }; },
    extractAnchors: async () => [],
});
stub('server/media-client', { playbackUrl: async () => 'https://openvibe.media/v/vod-9.mp4', signedMediaUrl: async () => ({ url: 'https://openvibe.media/v/vod-9.mp4?sig=x' }) });

const ai = require('../server/ai/ai-analysis');

(async () => {
    const vod = { id: 9, stream_id: 77, user_id: 1, file_path: null };
    // The summary's text is stored, as text.
    summaryAnswer = { overview: 'A relaxed stream with a cat on the desk.', category: 'just-chatting', tags: ['cat'] };
    const text = await ai.generateVodOverview(vod);
    assert.strictEqual(text, 'A relaxed stream with a cat on the desk.');
    assert.deepStrictEqual(stored, [[9, 'A relaxed stream with a cat on the desk.']], 'the overview\'s text, stored');
    assert.strictEqual(analysed.length, 0, 'no media pass when the memories gave a summary');

    // No summary, AI available: the media pass runs and the VOD is marked, so the queue moves on.
    stored.length = 0;
    summaryAnswer = null;
    await ai.generateVodOverview({ ...vod, id: 10, file_path: '/nonexistent' });
    assert.ok(stored.length === 1 && stored[0][0] === 10, `the VOD is marked done either way (${JSON.stringify(stored)})`);

    // AI off: nothing is marked; it waits for AI.
    stored.length = 0;
    aiOn = false;
    await ai.generateVodOverview({ ...vod, id: 11 });
    assert.deepStrictEqual(stored, [], 'AI off: nothing stored, the VOD waits');
    console.log('vod overview from memories: the summary\'s text is stored; no summary falls through to the media pass; AI off waits');
})().catch((e) => { console.error(e); process.exit(1); });
