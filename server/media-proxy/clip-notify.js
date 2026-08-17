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

function scheduleClipNotify(clipId) {
    try { db.scheduleClipNotifyState(clipId, GRACE_SECONDS); }
    catch (e) { console.warn('[ClipNotify] schedule failed:', e.message); }
}

function bumpClipNotifyNow(clipId) {
    try { db.bumpClipNotifyNowState(clipId); } catch { /* best-effort */ }
}

async function _sendOne(clipId) {
    let clip = null;
    try { clip = await media.getClip(clipId); } catch { /* Media hiccup — retry next sweep */ }
    if (!clip) return; // keep pending; a deleted clip 404s forever → mark below
    if (clip.status && !['ready', 'done', 'ok'].includes(String(clip.status))) return; // still processing

    const streamId = clip.stream_id || null;
    const srcStream = streamId ? db.getStreamById(streamId) : null;
    // Only announce clips of a CURRENTLY-LIVE stream — that's when there's an audience.
    if (!srcStream || !srcStream.is_live) { db.markClipNotifiedState(clipId); return; }
    if (clip.visibility === 'private') { db.markClipNotifiedState(clipId); return; }
    if (srcStream.managed_stream_id) {
        try {
            const ms = db.get('SELECT slot_clip_notify_enabled FROM managed_streams WHERE id = ?', [srcStream.managed_stream_id]);
            if (ms && Number(ms.slot_clip_notify_enabled) === 0) { db.markClipNotifiedState(clipId); return; }
        } catch { /* fall through and notify */ }
    }

    const ownerId = srcStream.user_id;
    const creator = clip.user_id ? db.getUserById(clip.user_id) : null;
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
    const payload = {
        type: 'chat',
        message_type: 'clip',
        username: creatorName,
        user_id: null,
        message: `clipped: ${title}`,
        stream_id: streamId,
        channel_user_id: ownerId,
        is_global: false,
        clip: meta,
        timestamp: new Date().toISOString(),
    };
    try {
        const saved = db.saveChatMessage({
            stream_id: streamId,
            channel_user_id: ownerId,
            user_id: null,
            username: creatorName,
            message: `clipped: ${title}`,
            message_type: 'clip',
            metadata: meta,
        });
        payload.id = saved && saved.lastInsertRowid;
        require('../chat/chat-server').broadcastToChannelRoom(ownerId, streamId, payload);
    } catch (e) {
        console.warn('[ClipNotify] send failed:', e.message);
    }
    db.markClipNotifiedState(clipId);
}

let _sweepTimer = null;
// Clips whose announce is currently being sent. A slow Media getClip() once let
// six 15s sweep ticks stack up on the same clip and announce it six times when
// Media finally answered — a clip stays claimed here until its send resolves.
const _inFlight = new Set();
function startClipNotifySweeper() {
    if (_sweepTimer) return;
    _sweepTimer = setInterval(() => {
        try {
            const due = db.getDueClipNotifies(20) || [];
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

module.exports = { scheduleClipNotify, bumpClipNotifyNow, startClipNotifySweeper };
