/**
 * OpenVibe.Live — /api/clips proxy (OpenVibe.Media backed)
 *
 * Preserves the SPA's /api/clips surface; clip storage/metadata now lives in
 * OpenVibe.Media. Channel-level clip *settings* and moderator logic stay local.
 */
'use strict';
const express = require('express');
const db = require('../db/database');
const media = require('../media-client');
const { requireAuth, optionalAuth } = require('../auth/auth');
const permissions = require('../auth/permissions');

const router = express.Router();

function mediaErr(res, err, fallback) {
    if (err && err.name === 'MediaApiError' && err.status) {
        return res.status(err.status).json(err.body || { error: err.message });
    }
    console.warn('[Clips proxy]', err && err.message);
    return res.status(502).json({ error: fallback || 'Media service unavailable' });
}

// Overlay Live-owned user fields onto Media clip rows: creator (username/…) and
// the clipped channel's streamer (source_streamer_* via channel_user_id).
function withUserFields(clip) {
    if (!clip) return clip;
    if (clip.user_id != null) {
        const u = db.getUserById(clip.user_id);
        if (u) {
            clip.username = clip.username || u.username;
            clip.display_name = clip.display_name || u.display_name;
            clip.avatar_url = clip.avatar_url || u.avatar_url;
            clip.profile_color = clip.profile_color || u.profile_color;
        }
    }
    if (clip.channel_user_id != null) {
        const s = db.getUserById(clip.channel_user_id);
        if (s) {
            clip.source_streamer_id = clip.channel_user_id;
            clip.source_streamer_username = s.username;
            clip.source_streamer_display_name = s.display_name;
            clip.streamer_username = clip.streamer_username || s.username;
            clip.streamer_display_name = clip.streamer_display_name || s.display_name;
            clip.streamer_avatar_url = clip.streamer_avatar_url || s.avatar_url;
        }
    }
    // Absolutize Media-relative URLs so the SPA doesn't resolve them against Live.
    clip.playback_url = media.publicUrl(clip.playback_url) || media.clipUrl(clip.id);
    if (clip.thumbnail_url) clip.thumbnail_url = media.publicUrl(clip.thumbnail_url);
    // Short AI overview is Live-owned (clip_ai_state) — overlay for the cards.
    if (clip.id != null && !clip.ai_overview_short) {
        try {
            const s = db.get('SELECT ai_overview_short FROM clip_ai_state WHERE clip_id = ?', [clip.id]);
            if (s && s.ai_overview_short) clip.ai_overview_short = s.ai_overview_short;
        } catch { /* best-effort */ }
    }
    return clip;
}

async function clipChannelOwnerId(clip) {
    if (!clip) return null;
    if (clip.stream_id) { const s = db.getStreamById(clip.stream_id); if (s) return s.user_id; }
    if (clip.vod_id) {
        try { const v = await media.getVod(clip.vod_id); if (v) return v.user_id; } catch { /* */ }
    }
    return null;
}

async function canActorModerateClip(actor, clip) {
    if (!actor || !clip) return false;
    if (actor.id === clip.user_id) return true;
    const ownerId = await clipChannelOwnerId(clip);
    if (ownerId && actor.id === ownerId) return true;
    if (ownerId) { const ch = db.getChannelByUserId(ownerId); if (ch && db.isChannelModerator(actor.id, ch.id)) return true; }
    const clipOwner = clip.user_id ? db.getUserById(clip.user_id) : null;
    const streamOwner = ownerId ? db.getUserById(ownerId) : null;
    return permissions.canModerateContentOwner(actor, clipOwner) &&
           permissions.canModerateContentOwner(actor, streamOwner);
}

async function canActorDeleteClip(actor, clip) {
    if (!actor || !clip) return false;
    const ownerId = await clipChannelOwnerId(clip);
    if (ownerId && actor.id === ownerId) return true;
    if (!ownerId && actor.id === clip.user_id) return true;
    if (ownerId) {
        const ch = db.getChannelByUserId(ownerId);
        if (ch && db.isChannelModerator(actor.id, ch.id)) return true;
        if (actor.id === clip.user_id && ch && ch.clips_allow_creator_delete) return true;
    }
    const clipOwner = clip.user_id ? db.getUserById(clip.user_id) : null;
    const streamOwner = ownerId ? db.getUserById(ownerId) : null;
    return permissions.canModerateContentOwner(actor, clipOwner) &&
           permissions.canModerateContentOwner(actor, streamOwner);
}

// ── My clips / my streams' clips ─────────────────────────────
router.get('/mine', requireAuth, async (req, res) => {
    try {
        // App-key call: Live already authenticated the owner, and Media only
        // honors include_private for the owning app.
        const out = await media.listClips({ ...req.query, user_id: req.user.id, include_private: 1 });
        const raw = (out?.clips || (Array.isArray(out) ? out : [])).map(withUserFields);
        const clips = [];
        for (const c of raw) clips.push({ ...c, can_delete: await canActorDeleteClip(req.user, c) });
        res.json({ clips, total: out?.total ?? clips.length, limit: out?.limit ?? clips.length, offset: out?.offset ?? 0 });
    } catch (err) {
        mediaErr(res, err, 'Failed to list your clips');
    }
});

router.get('/my-stream', requireAuth, async (req, res) => {
    try {
        // Clips others took of my streams (channel_user_id filter); app-key call.
        const out = await media.listClips({ ...req.query, channel_user_id: req.user.id, include_private: 1 });
        const clips = (out?.clips || (Array.isArray(out) ? out : [])).map(withUserFields).map(c => ({ ...c, can_delete: true }));
        res.json({ clips, total: out?.total ?? clips.length, limit: out?.limit ?? clips.length, offset: out?.offset ?? 0 });
    } catch (err) {
        mediaErr(res, err, 'Failed to list stream clips');
    }
});

// ── Channel clip settings (Live-local) ───────────────────────
router.get('/settings/channel', requireAuth, (req, res) => {
    try {
        const ch = db.getChannelByUserId(req.user.id);
        res.json({ clips_allow_creator_delete: !!(ch && ch.clips_allow_creator_delete) });
    } catch {
        res.status(500).json({ error: 'Failed to load clip settings' });
    }
});

router.put('/settings/channel', requireAuth, (req, res) => {
    try {
        const ch = db.getChannelByUserId(req.user.id);
        if (!ch) return res.status(404).json({ error: 'Channel not found' });
        const val = req.body.clips_allow_creator_delete ? 1 : 0;
        db.run('UPDATE channels SET clips_allow_creator_delete = ? WHERE id = ?', [val, ch.id]);
        res.json({ clips_allow_creator_delete: !!val });
    } catch {
        res.status(500).json({ error: 'Failed to save clip settings' });
    }
});

// ── List public clips ────────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        // Media doesn't know usernames — translate ?username= to a user filter.
        const q = { ...req.query };
        const username = String(q.username || '').trim();
        delete q.username;
        if (username) {
            const u = db.getUserByUsername(username);
            q.channel_user_id = u ? u.id : -1;
        }
        const out = await media.listClips(q);
        const clips = (out?.clips || (Array.isArray(out) ? out : [])).map(withUserFields);
        res.json({
            clips,
            total: out?.total ?? clips.length,
            limit: out?.limit ?? parseInt(req.query.limit || '20', 10),
            offset: out?.offset ?? parseInt(req.query.offset || '0', 10),
            hasMore: out?.hasMore ?? false,
            streamers: out?.streamers || [],
            activeFilter: String(req.query.username || '').trim() || null,
        });
    } catch (err) {
        mediaErr(res, err, 'Failed to list clips');
    }
});

// ── Clip detail ──────────────────────────────────────────────
router.get('/:id', optionalAuth, async (req, res) => {
    try {
        if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'Clip not found' });
        let clip;
        try { clip = await media.getClip(req.params.id, { userToken: media.userTokenFrom(req) }); }
        catch (err) { return mediaErr(res, err, 'Failed to get clip'); }
        if (!clip) return res.status(404).json({ error: 'Clip not found' });
        withUserFields(clip);

        if (clip.visibility === 'private') {
            let allowed = req.user && (req.user.id === clip.user_id || req.user.role === 'admin');
            if (!allowed && req.user && clip.stream_id) { const s = db.getStreamById(clip.stream_id); if (s && s.user_id === req.user.id) allowed = true; }
            if (!allowed) return res.status(404).json({ error: 'Clip not found' });
        }

        // Unique-view tracking (content_views stays in live.db).
        try {
            const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
            const inserted = db.run('INSERT OR IGNORE INTO content_views (content_type, content_id, ip) VALUES (?, ?, ?)', ['clip', clip.id, ip]);
            if (inserted.changes > 0) {
                const count = db.get('SELECT COUNT(*) as c FROM content_views WHERE content_type = ? AND content_id = ?', ['clip', clip.id]);
                clip.view_count = Math.max(Number(clip.view_count) || 0, count.c);
            }
        } catch { /* */ }

        if (clip.stream_id) {
            const stream = db.getStreamById(clip.stream_id);
            if (stream) {
                clip.stream_started_at = stream.started_at;
                clip.stream_ended_at = stream.ended_at;
                clip.stream_title = stream.title;
                clip.stream_category = stream.category;
                clip.stream_peak_viewers = stream.peak_viewers;
                clip.stream_protocol = stream.protocol;
            }
        }

        if (!clip.playback_url) clip.playback_url = media.clipUrl(clip.id);
        if (clip.thumbnail_url) clip.thumbnail_url = media.publicUrl(clip.thumbnail_url);

        // Overlay Live-owned AI state (overview + transcript live in clip_ai_state).
        try {
            const st = db.getClipAiState(clip.id);
            if (st) {
                if (st.ai_overview_short) { clip.ai_overview_short = st.ai_overview_short; clip.ai_overview = clip.ai_overview || st.ai_overview_short; }
                if (st.ai_transcript_json) {
                    clip.ai_transcript_json = st.ai_transcript_json;
                    try { clip.ai_transcript = JSON.parse(st.ai_transcript_json).map(s => s.text).join(' ').trim() || clip.ai_transcript; } catch { /* */ }
                }
                clip.transcript_status = st.transcript_status || clip.transcript_status;
            }
        } catch { /* */ }

        clip.comment_count = db.getCommentCount('clip', clip.id);
        clip.can_delete = await canActorDeleteClip(req.user, clip);
        clip.can_edit = await canActorModerateClip(req.user, clip);

        clip.vod_available = false;
        if (clip.vod_id) {
            try {
                const v = await media.getVod(clip.vod_id);
                const recording = v && (v.status === 'recording' || v.is_recording);
                if (v && v.visibility !== 'private' && !recording) clip.vod_available = true;
            } catch { /* */ }
        }

        res.json({ clip });
    } catch {
        res.status(500).json({ error: 'Failed to get clip' });
    }
});

// ── Title / visibility / bulk / delete ───────────────────────
router.put('/:id/title', requireAuth, async (req, res) => {
    try {
        let clip;
        try { clip = await media.getClip(req.params.id); } catch (err) { return mediaErr(res, err, 'Clip not found'); }
        if (!clip) return res.status(404).json({ error: 'Clip not found' });
        if (!(await canActorModerateClip(req.user, clip))) return res.status(403).json({ error: 'Not authorized to edit this clip' });
        const title = (req.body.title || '').trim();
        if (!title || title.length > 200) return res.status(400).json({ error: 'Title must be 1-200 characters' });
        await media.updateClip(clip.id, { title });
        // If the clip's chat announcement is still pending, fire it now with this title.
        try { require('./clip-notify').bumpClipNotifyNow(clip.id); } catch { /* */ }
        res.json({ message: 'Clip title updated', title });
    } catch (err) {
        mediaErr(res, err, 'Failed to update clip title');
    }
});

router.put('/:id/visibility', requireAuth, async (req, res) => {
    try {
        let clip;
        try { clip = await media.getClip(req.params.id); } catch (err) { return mediaErr(res, err, 'Clip not found'); }
        if (!clip) return res.status(404).json({ error: 'Clip not found' });
        if (!(await canActorModerateClip(req.user, clip))) return res.status(403).json({ error: 'Only the streamer can change clip visibility' });
        if (req.body.visibility !== undefined) {
            await media.updateClip(clip.id, { visibility: req.body.visibility });
            return res.json({ message: `Clip is now ${req.body.visibility}`, visibility: req.body.visibility, is_public: req.body.visibility === 'public' ? 1 : 0 });
        }
        const isPublic = req.body.is_public ? 1 : 0;
        await media.updateClip(clip.id, { visibility: isPublic ? 'public' : 'unlisted', is_public: isPublic });
        res.json({ message: isPublic ? 'Clip is now public' : 'Clip is now unlisted', is_public: isPublic });
    } catch (err) {
        mediaErr(res, err, 'Failed to update clip visibility');
    }
});

router.post('/bulk', requireAuth, async (req, res) => {
    try {
        const { ids, action } = req.body || {};
        if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'No ids provided' });
        if (!['delete', 'public', 'unlisted', 'private'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
        let done = 0, skipped = 0;
        for (const rawId of ids.slice(0, 500)) {
            const id = parseInt(rawId, 10);
            if (!id) { skipped++; continue; }
            let clip = null;
            try { clip = await media.getClip(id); } catch { /* */ }
            const allowed = clip && (action === 'delete' ? await canActorDeleteClip(req.user, clip) : await canActorModerateClip(req.user, clip));
            if (!allowed) { skipped++; continue; }
            try {
                if (action === 'delete') await media.deleteClip(id);
                else await media.updateClip(id, { visibility: action });
                done++;
            } catch { skipped++; }
        }
        res.json({ done, skipped });
    } catch {
        res.status(500).json({ error: 'Bulk action failed' });
    }
});

router.delete('/:id', requireAuth, async (req, res) => {
    try {
        let clip;
        try { clip = await media.getClip(req.params.id); } catch (err) { return mediaErr(res, err, 'Clip not found'); }
        if (!clip) return res.status(404).json({ error: 'Clip not found' });
        if (!(await canActorDeleteClip(req.user, clip))) return res.status(403).json({ error: 'Not authorized to delete this clip' });
        await media.deleteClip(clip.id);
        res.json({ message: 'Clip deleted' });
    } catch (err) {
        mediaErr(res, err, 'Failed to delete clip');
    }
});

module.exports = router;
