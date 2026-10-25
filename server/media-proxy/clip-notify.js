/**
 * clip-notify.js — announce newly-created clips in the source channel's chat.
 *
 * Clips live in OpenVibe.Media now; the announce *state* (clip_notified /
 * clip_notify_at) is Live-owned in clip_ai_state. Media's clip.ready webhook
 * schedules the announce with a grace period (so the creator can title the
 * clip); this sweeper fires the chat message once per clip. Titling a clip
 * within the grace window bumps clip_notify_at so it fires on the next tick.
 * Per-slot opt-out: managed_streams.slot_clip_notify_enabled.
 */
'use strict';
const db = require('../db/database');
const media = require('../media-client');

const GRACE_SECONDS = 60;
const SWEEP_INTERVAL_MS = 15000;
// A clip nobody named waits up to this long after it was made for its AI title (server/ai/clip-title.js), so the line
// says what happened instead of "Untitled Clip".
const TITLE_WAIT_SECONDS = 180;

async function scheduleClipNotify(clipId) {
    try { await db.scheduleClipNotifyState(clipId, GRACE_SECONDS); }
    catch (e) { console.warn('[ClipNotify] schedule failed:', e.message); }
}

async function bumpClipNotifyNow(clipId) {
    try { await db.bumpClipNotifyNowState(clipId); } catch { /* best-effort */ }
}

async function _sendOne(clipId) {
    let clip = null;
    try { clip = await media.getClip(clipId); } catch { /* Media hiccup — retry next sweep */ }
    if (!clip) return; // keep pending; a deleted clip 404s forever → mark below

    const streamId = clip.stream_id || null;
    const srcStream = streamId ? await db.getStreamById(streamId) : null;
    // Only announce clips of a CURRENTLY-LIVE stream — that's when there's an audience. Decided before waiting for the
    // cut, so a clip that never becomes ready (a trim whose cut failed for good) stops being asked about once its
    // stream ends.
    if (!srcStream || !srcStream.is_live) { await db.markClipNotifiedState(clipId); return; }
    // Still being cut (a trim from the clip editor makes the clip processing until its new cut is in): wait for it, so
    // the line carries the trimmed clip's length and thumbnail.
    if (clip.status && !['ready', 'done', 'ok'].includes(String(clip.status))) return;
    if (clip.visibility === 'private') { await db.markClipNotifiedState(clipId); return; }
    if (srcStream.managed_stream_id) {
        try {
            const ms = await db.get('SELECT slot_clip_notify_enabled FROM managed_streams WHERE id = ?', [srcStream.managed_stream_id]);
            if (ms && Number(ms.slot_clip_notify_enabled) === 0) { await db.markClipNotifiedState(clipId); return; }
        } catch { /* fall through and notify */ }
    }

    if (await _waitForTitle(clip, srcStream)) return;

    const ownerId = srcStream.user_id;
    const creator = clip.user_id ? await db.getUserById(clip.user_id) : null;
    const creatorName = (creator && (creator.display_name || creator.username)) || 'Someone';
    const title = clip.title || 'Untitled Clip';
    const meta = {
        clip_id: clip.id, title,
        thumbnail_url: media.publicUrl(clip.thumbnail_url) || null,
        duration: clip.duration_seconds || clip.duration || null,
        creator: creatorName,
        creator_avatar: (creator && creator.avatar_url) || null,
        creator_color: (creator && creator.profile_color) || null,
        auto: !!clip.auto_generated,
    };
    const line = {
        stream_id: streamId,
        channel_user_id: ownerId,
        user_id: null,
        username: creatorName,
        message: `clipped: ${title}`,
        message_type: 'clip',
        metadata: meta,
    };
    try {
        const delivery = require('../chat/chat-delivery');
        // Chat persists and shows the line (one key per clip, so a re-announce cannot post twice).
        await delivery.message({ ...line, key: `clip:${clipId}` });
    } catch (e) {
        console.warn('[ClipNotify] send failed:', e.message);
    }
    await db.markClipNotifiedState(clipId);
}

async function _waitForTitle(clip, srcStream, now = Date.now()) {
    const titles = require('../ai/clip-title');
    if (!titles.isPlaceholder(clip.title, [srcStream && srcStream.title])) return false;
    const made = Date.parse(String(clip.created_at || '').replace(' ', 'T').replace(/(T\d\d:\d\d:\d\d(\.\d+)?)$/, '$1Z'));
    if (!Number.isFinite(made) || now - made > TITLE_WAIT_SECONDS * 1000) return false;
    const state = await db.getClipAiState(clip.id).catch(() => null);
    if (state && state.title_status) return false;   // decided: titled (Media's title is fresh above), kept or failed
    try { return await require('../ai/ai-analysis').isEnabled(); } catch { return false; }
}

let _sweepTimer = null;
// Clips whose announce is currently being sent. A slow Media getClip() once let
// six 15s sweep ticks stack up on the same clip and announce it six times when
// Media finally answered — a clip stays claimed here until its send resolves.
const _inFlight = new Set();
function startClipNotifySweeper() {
    if (_sweepTimer) return;
    _sweepTimer = setInterval(async () => {
        try {
            const due = await db.getDueClipNotifies(20) || [];
            for (const row of due) {
                if (_inFlight.has(row.clip_id)) continue;
                _inFlight.add(row.clip_id);
                _sendOne(row.clip_id).catch(() => {}).finally(() => _inFlight.delete(row.clip_id));
            }
        } catch (e) { console.warn('[ClipNotify] sweep error:', e.message); }
    }, SWEEP_INTERVAL_MS);
    if (_sweepTimer.unref) _sweepTimer.unref();
    console.log('[ClipNotify] sweeper started (Media-backed clips)');
}

module.exports = { scheduleClipNotify, bumpClipNotifyNow, startClipNotifySweeper, _sendOne, _waitForTitle, TITLE_WAIT_SECONDS };
