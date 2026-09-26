'use strict';
/**
 * OpenVibe.Live — what Live does once OpenVibe.Media has deleted a VOD or clip for it.
 *
 * Every delete path calls afterDelete() after Media confirmed the delete: the owner's /api/vods and
 * /api/clips routes (one, bulk, older-than) and the admin storage page. It
 *   - hides the item's comment thread on OpenVibe.Community (comments-client.js);
 *   - drops Live's own rows about it: the AI state (vod_ai_state / clip_ai_state), which the AI
 *     backfill (server/ai/backfill-job.js) takes newest-first and would otherwise keep offering for an
 *     id Media no longer has, and the unique-view rows (content_views);
 *   - re-reads its OpenVibe.Search document now (Media's 404 sends the tombstone) instead of leaving
 *     it to the daily refresh.
 * Lists and pages that cached the item (home pool, SSR detail, page status) expire within a minute.
 */
const db = require('../db/database');
const commentsClient = require('../comments-client');

function afterDelete(kind, id) {
    const n = Number(id);
    if ((kind !== 'vod' && kind !== 'clip') || !Number.isInteger(n) || n <= 0) return;
    commentsClient.hideThreadOf(kind, n);
    try { db.forgetMediaItem(kind, n); } catch (err) { console.warn(`[Media] could not drop Live's rows for deleted ${kind} ${n}:`, err.message); }
    try { require('../events/search-media-documents').touchLater(kind, n); } catch { /* search is optional */ }
}

module.exports = { afterDelete };
