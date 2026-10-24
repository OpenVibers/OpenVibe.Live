'use strict';
// The AI backfill drops the state of a VOD or clip OpenVibe.Media no longer has (deleted on openvibe.video or by Media's
// own tools, so Live's purge never ran), instead of offering it again every minute: newest first, eight such rows kept
// every older clip waiting (2026-10-24: 49 clips). A Media that is down or slow (a 5xx, no answer) drops nothing.
const assert = require('assert');
const os = require('os');
const db = require('../server/db/database');
const media = require('../server/media-client');
const local = require('../server/ai/ai-analysis');
const comments = require('../server/comments-client');
const search = require('../server/events/search-media-documents');
const backfill = require('../server/ai/backfill-job');

(async () => {
    await db.initDb();
    delete process.env.LIVE_MEDIA_ANALYSIS;   // the local path (production's), where the transcript queue runs
    os.loadavg = () => [0, 0, 0];             // headroom, whatever the machine running the test is doing
    const gone = new Set([951, 952, 953, 954, 955, 956, 957, 958, 959, 811]);
    let mediaDown = false;
    const lookup = (kind) => async (id) => {
        if (mediaDown && id === 940) throw new media.MediaApiError('Media API 503', 503, null);
        if (gone.has(Number(id))) throw new media.MediaApiError(`${kind} not found`, 404, { error: `${kind} not found` });
        return { id, status: 'ready', user_id: 7, duration_seconds: 30 };
    };
    media.getClip = lookup('Clip');
    media.getVod = lookup('VOD');
    const hidden = [];
    comments.hideThreadOf = (kind, id) => { hidden.push(`${kind}:${id}`); };
    search.touchLater = () => {};
    const transcribed = [];
    local.transcriptionEnabled = async () => true;
    local.generateClipTranscript = async (clip) => {
        transcribed.push(`clip:${clip.id}`);
        await db.setClipTranscriptStatus(clip.id, 'done');
        await db.run("UPDATE clip_ai_state SET ai_transcript_json = '[]' WHERE clip_id = ?", [clip.id]);
    };
    local.generateVodTranscript = async (vod) => {
        transcribed.push(`vod:${vod.id}`);
        await db.setVodTranscriptStatus(vod.id, 'done');
        await db.run("UPDATE vod_ai_state SET ai_transcript_json = '[]' WHERE vod_id = ?", [vod.id]);
    };
    local.isEnabled = async () => false;

    await db.run("INSERT INTO clip_ai_state (clip_id, transcript_status) VALUES (940, 'pending')");
    for (const id of [951, 952, 953, 954, 955, 956, 957, 958, 959]) await db.run("INSERT INTO clip_ai_state (clip_id, transcript_status) VALUES (?, 'pending')", [id]);
    await db.run("INSERT INTO vod_ai_state (vod_id, transcript_status) VALUES (810, 'pending')");
    await db.run("INSERT INTO vod_ai_state (vod_id, transcript_status) VALUES (811, 'pending')");

    // A Media that cannot answer keeps the row: only a 404 means the item is gone.
    mediaDown = true;
    await backfill.tick();
    assert.ok(await db.getClipAiState(940), 'a clip Media could not look up stays queued');
    assert.ok(!transcribed.includes('clip:940'));
    mediaDown = false;

    await backfill.tick();
    await backfill.tick();
    for (const id of [951, 952, 953, 954, 955, 956, 957, 958, 959]) assert.ok(!(await db.getClipAiState(id)), `deleted clip ${id}'s state is dropped`);
    assert.ok(!(await db.getVodAiState(811)), 'a deleted VOD\'s state is dropped');
    assert.ok(transcribed.includes('clip:940'), 'the clip behind the deleted ones is transcribed');
    assert.ok(transcribed.includes('vod:810'), 'the VOD behind the deleted one is transcribed');
    assert.ok(hidden.includes('clip:951') && hidden.includes('vod:811'), 'the deleted items\' comment threads are hidden, as after a delete through Live');
    console.log('backfill-deleted-media: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
