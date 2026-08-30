/**
 * OpenVibe.Live — /api/vods proxy (OpenVibe.Media backed)
 *
 * Thin proxy that preserves the public API paths the SPA already calls and
 * forwards to OpenVibe.Media (Media API v1). Metadata is proxied as JSON; big
 * media file payloads 302-redirect to MEDIA_PUBLIC_URL. Auth/ownership checks
 * stay here (Live is the authority for its own users); Media additionally
 * applies user ACLs when the caller's Network JWT is forwarded.
 */
'use strict';
const express = require('express');
const multer = require('multer');
const db = require('../db/database');
const media = require('../media-client');
const recorder = require('../streaming/recorder');
const { requireAuth, optionalAuth } = require('../auth/auth');
const permissions = require('../auth/permissions');

const router = express.Router();

const MAX_UPLOAD_MB = parseInt(process.env.MAX_VOD_SIZE_MB || '2048', 10);
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 } });

// ── In-memory anti-abuse state for clip creation (was DB-backed pre-split) ──
const CLIP_USER_COOLDOWN_MS = 10000;
const CLIP_IP_COOLDOWN_MS = 5000;
const CLIP_LIVE_USER_COOLDOWN_MS = 2500;
const CLIP_LIVE_IP_COOLDOWN_MS = 1200;
const CLIP_MAX_PER_USER_PER_HOUR = 20;
const CLIP_MIN_ACCOUNT_AGE_MS = 60000;
const recentClipAttempts = new Map();   // key → last-ms
const hourlyClipLog = new Map();        // userId → [ms, ...]

function requesterIp(req) {
    return req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
}
function throttled(req, isLive) {
    const now = Date.now();
    const userCd = isLive ? CLIP_LIVE_USER_COOLDOWN_MS : CLIP_USER_COOLDOWN_MS;
    const ipCd = isLive ? CLIP_LIVE_IP_COOLDOWN_MS : CLIP_IP_COOLDOWN_MS;
    const uKey = req.user?.id ? `u:${req.user.id}` : null;
    const iKey = `i:${requesterIp(req)}`;
    if ((uKey && now - (recentClipAttempts.get(uKey) || 0) < userCd) || now - (recentClipAttempts.get(iKey) || 0) < ipCd) return true;
    if (uKey) recentClipAttempts.set(uKey, now);
    recentClipAttempts.set(iKey, now);
    if (recentClipAttempts.size > 5000) recentClipAttempts.clear();
    return false;
}
function overHourlyLimit(userId) {
    const now = Date.now();
    const log = (hourlyClipLog.get(userId) || []).filter(t => now - t < 3600_000);
    hourlyClipLog.set(userId, log);
    return log.length >= CLIP_MAX_PER_USER_PER_HOUR;
}
function noteClip(userId) {
    const log = hourlyClipLog.get(userId) || [];
    log.push(Date.now());
    hourlyClipLog.set(userId, log);
}
function accountTooNew(user) {
    if (!user?.created_at) return true;
    const created = new Date(user.created_at + (String(user.created_at).includes('Z') ? '' : 'Z'));
    return (Date.now() - created.getTime()) < CLIP_MIN_ACCOUNT_AGE_MS;
}
function sanitizeClipTitle(title) {
    if (!title || typeof title !== 'string') return '';
    return title.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, '').trim().slice(0, 200);
}
function defaultClipTitle(sanitized, sourceTitle) {
    if (sanitized) return sanitized;
    const src = (sourceTitle || '').toString().replace(/<[^>]*>/g, '').trim();
    return (src ? `Clip: ${src}` : 'Untitled Clip').slice(0, 200);
}

function mediaErr(res, err, fallback) {
    if (err && err.name === 'MediaApiError' && err.status) {
        return res.status(err.status).json(err.body || { error: err.message });
    }
    console.warn('[VODs proxy]', err && err.message);
    return res.status(502).json({ error: fallback || 'Media service unavailable' });
}

// Overlay Live-owned user fields (username/display_name/avatar) onto Media rows —
// the SPA's cards render them and Media only stores our opaque user_id.
function withUserFields(row) {
    if (!row) return row;
    if (row.user_id != null) {
        const u = db.getUserById(row.user_id);
        if (u) {
            row.username = row.username || u.username;
            row.display_name = row.display_name || u.display_name;
            row.avatar_url = row.avatar_url || u.avatar_url;
            row.profile_color = row.profile_color || u.profile_color;
        }
    }
    // Media returns its own paths relative — absolutize onto MEDIA_PUBLIC_URL
    // so the SPA doesn't resolve them against Live's origin.
    row.playback_url = media.publicUrl(row.playback_url) || media.vodPlaybackUrl(row.id);
    if (row.thumbnail_url) row.thumbnail_url = media.publicUrl(row.thumbnail_url);
    // AI overview is Live-owned (vod_ai_state) — overlay short + full for the cards
    // (the expander swaps the short teaser for the full text).
    if (row.id != null && (!row.ai_overview_short || !row.ai_overview)) {
        try {
            const s = db.get('SELECT ai_overview_short, ai_overview FROM vod_ai_state WHERE vod_id = ?', [row.id]);
            if (s && s.ai_overview_short && !row.ai_overview_short) row.ai_overview_short = s.ai_overview_short;
            if (s && s.ai_overview && !row.ai_overview) row.ai_overview = s.ai_overview;
        } catch { /* best-effort */ }
    }
    return row;
}

// Media doesn't know usernames — translate a ?username= filter to user_id here.
function usernameToUserId(query) {
    const q = { ...query };
    const username = String(q.username || '').trim();
    delete q.username;
    if (username) {
        const u = db.getUserByUsername(username);
        q.user_id = u ? u.id : -1;   // unknown username → empty list, like before
    }
    return q;
}

async function ownVodOrModerator(req, res) {
    let vod;
    try { vod = await media.getVod(req.params.id); } catch (err) { mediaErr(res, err, 'VOD not found'); return null; }
    if (!vod) { res.status(404).json({ error: 'VOD not found' }); return null; }
    let owns = vod.user_id === req.user.id;
    if (!owns && vod.stream_id) { const s = db.getStreamById(vod.stream_id); if (s && s.user_id === req.user.id) owns = true; }
    if (!owns) owns = permissions.canModerateContentOwner(req.user, vod.user_id ? db.getUserById(vod.user_id) : null);
    if (!owns) { res.status(403).json({ error: 'Not authorized' }); return null; }
    return vod;
}

// ══════════════════════════════════════════════════════════════
//  CHUNKED VOD RECORDING (browser MediaRecorder → Media chunks API)
// ══════════════════════════════════════════════════════════════

router.post('/stream/:streamId/chunk', requireAuth, memUpload.single('chunk'), async (req, res) => {
    try {
        const streamId = parseInt(req.params.streamId);
        if (!req.file) return res.status(400).json({ error: 'No chunk data' });
        const stream = db.getStreamById(streamId);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not your stream' });
        }
        const vodPolicy = db.getChannelVodRecordingPolicyByUserId(stream.user_id, stream.managed_stream_id);
        if (!vodPolicy.recordingEnabled) {
            if (recorder.getActiveRecording(streamId)) recorder.finalizeStream(streamId).catch(() => {});
            return res.status(403).json({
                error: vodPolicy.forcedDisabled
                    ? 'VOD recording is disabled by admin for this channel'
                    : 'VOD recording is disabled for this channel',
            });
        }

        let rec = recorder.getActiveRecording(streamId);
        let created = false;
        if (!rec || rec.type !== 'chunks') {
            const { id } = await media.createVod({
                title: stream.title || 'Stream Recording',
                stream_id: streamId,
                managed_stream_id: stream.managed_stream_id || undefined,
                user_id: stream.user_id,
                visibility: db.resolveStreamVodVisibility(stream),
                meta: { protocol: stream.protocol || 'browser', chunked: true },
            });
            rec = recorder.registerChunkSession(streamId, id);
            created = true;
        }
        rec.chunkCount = (rec.chunkCount || 0) + 1;

        await media.uploadVodChunk(rec.vodId, {
            buffer: req.file.buffer,
            filename: req.file.originalname || 'chunk.webm',
            contentType: req.file.mimetype || 'video/webm',
        }, { segmentId: req.body?.segmentId || req.query.segmentId || '1' });

        res.json({ vodId: rec.vodId, chunkIndex: created ? 0 : rec.chunkCount, status: created ? 'created' : 'appended' });
    } catch (err) {
        mediaErr(res, err, 'Failed to save chunk');
    }
});

router.post('/stream/:streamId/finalize', requireAuth, async (req, res) => {
    try {
        const streamId = parseInt(req.params.streamId);
        const stream = db.getStreamById(streamId);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not your stream' });
        }
        const rec = recorder.getActiveRecording(streamId);
        if (!rec) return res.status(404).json({ error: 'No active recording for this stream' });
        const vodId = rec.vodId;
        await recorder.finalizeStream(streamId);
        let vod = null;
        if (vodId) { try { vod = await media.getVod(vodId); } catch { /* still finalizing */ } }
        res.json({ vod: vod || (vodId ? { id: vodId, status: 'processing' } : null) });
    } catch (err) {
        mediaErr(res, err, 'Failed to finalize VOD');
    }
});

router.get('/stream/:streamId/live', optionalAuth, async (req, res) => {
    try {
        const streamId = parseInt(req.params.streamId);
        const rec = recorder.getActiveRecording(streamId);
        if (!rec || !rec.vodId || rec.clipsOnly) return res.status(404).json({ error: 'No active VOD recording' });
        let vod = null;
        try { vod = await media.getVod(rec.vodId); } catch { /* Media hiccup — synthesize */ }
        res.json({
            vod: vod || {
                id: rec.vodId,
                stream_id: streamId,
                is_recording: 1,
                duration_seconds: Math.round((Date.now() - rec.startedAt) / 1000),
            },
        });
    } catch {
        res.status(500).json({ error: 'Failed to get live VOD' });
    }
});

router.get('/:id/live-info', optionalAuth, async (req, res) => {
    try {
        if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'VOD not found' });
        const vod = await media.getVod(req.params.id);
        if (!vod) return res.status(404).json({ error: 'VOD not found' });
        const recording = vod.status === 'recording' || !!vod.is_recording;
        res.json({
            id: vod.id,
            duration: vod.duration || vod.duration_seconds || 0,
            fileSize: vod.file_size || 0,
            isRecording: recording,
            seekable: !!vod.seekable || !recording,
        });
    } catch (err) {
        mediaErr(res, err, 'Failed to get live info');
    }
});

// ══════════════════════════════════════════════════════════════
//  VOD LIST / DETAIL / MANAGEMENT
// ══════════════════════════════════════════════════════════════

router.get('/', optionalAuth, async (req, res) => {
    try {
        const out = await media.listVods(usernameToUserId(req.query));
        const vods = (out?.vods || (Array.isArray(out) ? out : [])).map(withUserFields);
        res.json({
            vods,
            total: out?.total ?? vods.length,
            limit: out?.limit ?? parseInt(req.query.limit || '20', 10),
            offset: out?.offset ?? parseInt(req.query.offset || '0', 10),
            hasMore: out?.hasMore ?? false,
            streamers: out?.streamers || [],
            activeFilter: String(req.query.username || '').trim() || null,
        });
    } catch (err) {
        mediaErr(res, err, 'Failed to list VODs');
    }
});

router.get('/mine', requireAuth, async (req, res) => {
    try {
        // App-key call (not the user's JWT): Live already authenticated the owner,
        // and Media only honors include_private for the owning app.
        const out = await media.listVods({ ...req.query, user_id: req.user.id, include_private: 1 });
        const vods = (out?.vods || (Array.isArray(out) ? out : [])).map(withUserFields);
        res.json({ vods, total: out?.total ?? vods.length, limit: out?.limit ?? vods.length, offset: out?.offset ?? 0 });
    } catch (err) {
        mediaErr(res, err, 'Failed to list VODs');
    }
});

router.post('/bulk-delete-old', requireAuth, async (req, res) => {
    try {
        const olderThanDays = parseInt(req.body?.olderThanDays, 10);
        const deleteVods = req.body?.deleteVods !== false;
        const deleteClips = req.body?.deleteClips !== false;
        const action = ['delete', 'public', 'unlisted', 'private'].includes(req.body?.action) ? req.body.action : 'delete';
        if (!Number.isFinite(olderThanDays) || olderThanDays < 1) {
            return res.status(400).json({ error: 'olderThanDays must be a positive integer' });
        }
        if (!deleteVods && !deleteClips) {
            return res.status(400).json({ error: 'Select at least one media type to delete' });
        }
        const cutoff = Date.now() - olderThanDays * 86400_000;
        const tooOld = (row) => {
            const t = Date.parse(String(row.created_at || '').replace(' ', 'T') + (String(row.created_at || '').includes('Z') ? '' : 'Z'));
            return Number.isFinite(t) && t <= cutoff;
        };
        let vodCount = 0, clipCount = 0;
        if (deleteVods) {
            const out = await media.listVods({ user_id: req.user.id, include_private: 1, limit: 1000 });
            for (const v of (out?.vods || [])) {
                if (!tooOld(v) || v.is_recording) continue;
                if (action === 'delete') await media.deleteVod(v.id).catch(() => {});
                else await media.updateVod(v.id, { visibility: action }).catch(() => {});
                vodCount++;
            }
        }
        if (deleteClips) {
            const out = await media.listClips({ user_id: req.user.id, include_private: 1, limit: 1000 });
            for (const c of (out?.clips || [])) {
                if (!tooOld(c)) continue;
                if (action === 'delete') await media.deleteClip(c.id).catch(() => {});
                else await media.updateClip(c.id, { visibility: action }).catch(() => {});
                clipCount++;
            }
        }
        if (action !== 'delete') return res.json({ olderThanDays, action, updated: { vods: vodCount, clips: clipCount } });
        res.json({ olderThanDays, deleted: { vods: vodCount, clips: clipCount }, filesDeleted: { vods: vodCount, clips: clipCount }, fileDeleteErrors: 0 });
    } catch (err) {
        mediaErr(res, err, 'Failed to bulk delete old media');
    }
});

// AI "memory" timeline for a VOD (stream_memories stays in live.db).
router.get('/:id/memories', optionalAuth, async (req, res) => {
    try {
        if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'VOD not found' });
        let streamId = null;
        try { const vod = await media.getVod(req.params.id); streamId = vod?.stream_id || null; } catch { /* */ }
        if (!streamId) return res.json({ memories: [] });
        const memories = (db.getStreamMemories(streamId) || []).map(m => ({
            offset_seconds: m.offset_seconds,
            description: m.description,
            tags: m.tags ? (() => { try { return JSON.parse(m.tags); } catch { return []; } })() : [],
        }));
        res.json({ memories });
    } catch {
        res.status(500).json({ error: 'Failed to load AI timeline' });
    }
});

router.get('/:id', optionalAuth, async (req, res) => {
    try {
        if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'VOD not found' });
        let vod;
        try { vod = await media.getVod(req.params.id, { actingUser: media.actingUserFrom(req) }); }
        catch (err) { return mediaErr(res, err, 'Failed to get VOD'); }
        if (!vod) return res.status(404).json({ error: 'VOD not found' });
        withUserFields(vod);

        // Enrich with local stream details for chat replay.
        if (vod.stream_id) {
            const stream = db.getStreamById(vod.stream_id);
            if (stream) {
                vod.stream_started_at = stream.started_at;
                vod.stream_ended_at = stream.ended_at;
                vod.stream_category = stream.ai_category || stream.category;
                vod.stream_peak_viewers = stream.peak_viewers;
            }
        }
        if (!vod.playback_url) vod.playback_url = media.vodPlaybackUrl(vod.id);
        if (vod.thumbnail_url) vod.thumbnail_url = media.publicUrl(vod.thumbnail_url);

        // Overlay Live-owned AI state (overview + transcript live in vod_ai_state).
        try {
            const st = db.getVodAiState(vod.id);
            if (st) {
                if (st.ai_overview_short) { vod.ai_overview_short = st.ai_overview_short; vod.ai_overview = st.ai_overview || vod.ai_overview || st.ai_overview_short; }
                if (st.ai_transcript_json) {
                    vod.ai_transcript_json = st.ai_transcript_json;
                    try { vod.ai_transcript = JSON.parse(st.ai_transcript_json).map(s => s.text).join(' ').trim() || vod.ai_transcript; } catch { /* */ }
                }
                vod.transcript_status = st.transcript_status || vod.transcript_status;
            }
        } catch { /* */ }

        const isOwnerOrAdmin = req.user && (req.user.id === vod.user_id || req.user.role === 'admin');
        const isPrivate = (vod.visibility ? vod.visibility === 'private' : !vod.is_public);
        let clips = [];
        try {
            const q = vod.stream_id ? { stream_id: vod.stream_id } : { vod_id: vod.id };
            const co = await media.listClips(q);
            clips = co?.clips || (Array.isArray(co) ? co : []);
        } catch { /* */ }
        if (isPrivate && !isOwnerOrAdmin) {
            return res.json({
                vod: {
                    id: vod.id, title: vod.title, username: vod.username, display_name: vod.display_name,
                    avatar_url: vod.avatar_url, is_public: 0, is_private: true, stream_id: vod.stream_id,
                    created_at: vod.created_at, user_id: vod.user_id,
                },
                clips,
            });
        }

        // Unique-view tracking stays local (content_views is a Live table).
        try {
            const ip = requesterIp(req);
            const inserted = db.run('INSERT OR IGNORE INTO content_views (content_type, content_id, ip) VALUES (?, ?, ?)', ['vod', vod.id, ip]);
            if (inserted.changes > 0) {
                const count = db.get('SELECT COUNT(*) as c FROM content_views WHERE content_type = ? AND content_id = ?', ['vod', vod.id]);
                vod.view_count = Math.max(Number(vod.view_count) || 0, count.c);
            }
        } catch { /* */ }

        vod.comment_count = db.getCommentCount('vod', vod.id);
        res.json({ vod, clips });
    } catch {
        res.status(500).json({ error: 'Failed to get VOD' });
    }
});

router.put('/:id', requireAuth, async (req, res) => {
    const vod = await ownVodOrModerator(req, res);
    if (!vod) return;
    try {
        const { title, description, is_public, visibility } = req.body || {};
        const fields = {};
        if (title !== undefined) fields.title = title;
        if (description !== undefined) fields.description = description;
        if (visibility !== undefined) fields.visibility = visibility;
        else if (is_public !== undefined) fields.visibility = is_public ? 'public' : 'private';
        await media.updateVod(req.params.id, fields);
        res.json({ vod: await media.getVod(req.params.id).catch(() => ({ ...vod, ...fields })) });
    } catch (err) {
        mediaErr(res, err, 'Failed to update VOD');
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
            let vod = null;
            try { vod = await media.getVod(id); } catch { /* */ }
            if (!vod) { skipped++; continue; }
            let owns = vod.user_id === req.user.id;
            if (!owns && vod.stream_id) { const s = db.getStreamById(vod.stream_id); if (s && s.user_id === req.user.id) owns = true; }
            if (!owns) owns = permissions.canModerateContentOwner(req.user, vod.user_id ? db.getUserById(vod.user_id) : null);
            if (!owns) { skipped++; continue; }
            try {
                if (action === 'delete') await media.deleteVod(id);
                else await media.updateVod(id, { visibility: action });
                done++;
            } catch { skipped++; }
        }
        res.json({ done, skipped });
    } catch {
        res.status(500).json({ error: 'Bulk action failed' });
    }
});

router.delete('/:id', requireAuth, async (req, res) => {
    const vod = await ownVodOrModerator(req, res);
    if (!vod) return;
    try {
        await media.deleteVod(req.params.id);
        res.json({ message: 'VOD deleted' });
    } catch (err) {
        mediaErr(res, err, 'Failed to delete VOD');
    }
});

router.post('/:id/publish', requireAuth, async (req, res) => {
    try {
        let vod;
        try { vod = await media.getVod(req.params.id); } catch (err) { return mediaErr(res, err, 'VOD not found'); }
        if (!vod) return res.status(404).json({ error: 'VOD not found' });
        if (vod.user_id !== req.user.id) return res.status(403).json({ error: 'Not your VOD' });
        await media.updateVod(req.params.id, { visibility: 'public', is_public: 1 });
        res.json({ message: 'VOD published', is_public: true });
    } catch (err) {
        mediaErr(res, err, 'Failed to publish VOD');
    }
});

// Big media payloads live on openvibe.media now — 302 out instead of streaming through.
// TODO(contract): legacy /api/vods/file/<basename> URLs are mapped onto Media's /v/ route
// by filename; Media's inherited serving resolves both ids and legacy basenames.
router.get('/file/:filename', optionalAuth, (req, res) => {
    const filename = require('path').basename(req.params.filename);
    res.set('Cache-Control', 'private, max-age=0');
    res.redirect(302, `${media.MEDIA_PUBLIC_URL}/v/${encodeURIComponent(filename)}`);
});

router.post('/upload', requireAuth, memUpload.single('video'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No video file uploaded' });
        const { stream_id, title } = req.body;
        if (stream_id) {
            const stream = db.getStreamById(stream_id);
            if (stream && stream.user_id !== req.user.id && req.user.role !== 'admin') {
                return res.status(403).json({ error: 'Not your stream' });
            }
        }
        const uStream = stream_id ? db.getStreamById(parseInt(stream_id)) : null;
        const visibility = uStream
            ? db.resolveStreamVodVisibility(uStream)
            : (db.getChannelByUserId(req.user.id)?.default_vod_visibility || 'public');
        const { id } = await media.createVod({
            title: title || 'Stream Recording',
            stream_id: stream_id ? parseInt(stream_id) : undefined,
            user_id: req.user.id,
            meta: { uploaded: true, visibility },
        });
        await media.uploadVodChunk(id, {
            buffer: req.file.buffer,
            filename: req.file.originalname || 'upload.webm',
            contentType: req.file.mimetype || 'video/webm',
        });
        await media.completeVodChunks(id).catch(() => {});
        await media.finalizeVod(id);
        const vod = await media.getVod(id).catch(() => ({ id, status: 'processing' }));
        res.status(201).json({ vod });
    } catch (err) {
        mediaErr(res, err, 'Failed to upload VOD');
    }
});

// ══════════════════════════════════════════════════════════════
//  CLIP CREATION (/api/vods/clips — also see media-proxy/clips.js)
// ══════════════════════════════════════════════════════════════

router.post('/clips', requireAuth, memUpload.single('video'), async (req, res) => {
    try {
        const { vod_id, stream_id, title } = req.body;
        const parsedStreamId = stream_id ? parseInt(stream_id, 10) : null;
        const parsedVodId = vod_id ? parseInt(vod_id, 10) : null;
        const startTime = Number.parseFloat(req.body?.start_time);
        const endTime = Number.parseFloat(req.body?.end_time);
        const isLiveClip = !!req.file || ['true', '1', true].includes(req.body.live);
        const sanitizedTitle = sanitizeClipTitle(title);

        if (accountTooNew(req.user)) return res.status(403).json({ error: 'Your account is too new to create clips. Please wait a minute.' });
        if (overHourlyLimit(req.user.id)) return res.status(429).json({ error: `You've created too many clips this hour (max ${CLIP_MAX_PER_USER_PER_HOUR}). Please try again later.` });
        if (throttled(req, isLiveClip)) {
            return res.status(429).json({ error: `You are clipping too fast. Please wait ${isLiveClip ? 'a few seconds' : '10 seconds'} before making another clip.` });
        }

        // ── Direct clip upload (browser MediaRecorder blob) ──
        // TODO(contract): direct-upload clip blobs are forwarded as multipart `video` to
        // POST /clips — an inherited-behavior extension beyond the documented JSON body.
        if (req.file) {
            const liveStream = parsedStreamId ? db.getStreamById(parsedStreamId) : null;
            if (liveStream && !db.isStreamClipRecordingEnabled(liveStream)) {
                return res.status(403).json({ error: 'Clipping is disabled for this stream.' });
            }
            const fd = new FormData();
            fd.append('stream_id', String(parsedStreamId || ''));
            fd.append('user_id', String(req.user.id));
            if (liveStream) fd.append('channel_user_id', String(liveStream.user_id));
            fd.append('title', defaultClipTitle(sanitizedTitle, liveStream?.title));
            if (Number.isFinite(startTime)) fd.append('start_s', String(startTime));
            if (Number.isFinite(endTime)) fd.append('end_s', String(endTime));
            if (liveStream) fd.append('visibility', db.resolveStreamClipVisibility(liveStream));
            fd.append('video', new Blob([req.file.buffer], { type: req.file.mimetype || 'video/webm' }), req.file.originalname || 'clip.webm');
            const clip = await media.request('POST', '/clips', { body: fd, timeoutMs: 120000 });
            noteClip(req.user.id);
            _notifyStreamerOfClip(parsedStreamId, req.user, sanitizedTitle, clip?.id);
            return res.status(201).json({ clip });
        }

        // ── LIVE clip — cut server-side from the stream's active Media recording ──
        if (isLiveClip && parsedStreamId && !parsedVodId) {
            const stream = db.getStreamById(parsedStreamId);
            if (!stream) return res.status(404).json({ error: 'Stream not found' });
            if (!db.isStreamClipRecordingEnabled(stream)) return res.status(403).json({ error: 'Clipping is disabled for this stream.' });
            const rec = recorder.getActiveRecording(parsedStreamId);
            if (!rec || !rec.vodId) {
                let starting = false;
                try {
                    if (stream.is_live) { recorder.reconcileLiveRecordings(); starting = recorder.isActivelyRecording(parsedStreamId); }
                } catch { /* */ }
                return res.status(409).json({
                    error: starting
                        ? 'Recording is starting up — try clipping again in a few seconds.'
                        : 'This stream is not being recorded, so live clips are unavailable.',
                    no_recording: true,
                    recording_starting: starting,
                });
            }
            const maxDur = db.getSetting('max_clip_duration') || 60;
            let dur = parseFloat(req.body.duration);
            if (!Number.isFinite(dur) || dur < 1) dur = 30;
            dur = Math.min(dur, maxDur);
            const recElapsed = Math.max(0, (Date.now() - rec.startedAt) / 1000);
            const safeEdge = Math.max(0, recElapsed - 1.5); // stay inside flushed footage
            let clipEnd = parseFloat(req.body.at);
            if (!Number.isFinite(clipEnd) || clipEnd <= 0) clipEnd = safeEdge;
            clipEnd = Math.min(clipEnd, safeEdge);
            const liveStart = Math.max(0, clipEnd - dur);
            if (clipEnd - liveStart < 1) return res.status(400).json({ error: 'Not enough recorded footage yet — try again in a moment.', no_recording: true });

            const clip = await media.createClip({
                vod_id: rec.vodId,
                start_s: liveStart,
                end_s: clipEnd,
                title: defaultClipTitle(sanitizedTitle, stream.title),
                user_id: req.user.id,
                stream_id: parsedStreamId,
                visibility: db.resolveStreamClipVisibility(stream),
            });
            noteClip(req.user.id);
            _notifyStreamerOfClip(parsedStreamId, req.user, sanitizedTitle, clip?.id);
            return res.status(201).json({ clip });
        }

        // ── VOD clip (server-side cut in Media) ──
        if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return res.status(400).json({ error: 'start_time and end_time required' });
        if (startTime < 0 || endTime < 0) return res.status(400).json({ error: 'Time values cannot be negative' });
        const duration = endTime - startTime;
        const maxClipDuration = db.getSetting('max_clip_duration') || 60;
        if (duration < 1) return res.status(400).json({ error: 'Clip must be at least 1 second' });
        if (duration > maxClipDuration) return res.status(400).json({ error: `Clips are limited to ${maxClipDuration} seconds` });
        if (!parsedVodId || !Number.isFinite(parsedVodId)) return res.status(400).json({ error: 'Valid vod_id is required for VOD clips' });

        let vod;
        try { vod = await media.getVod(parsedVodId); } catch (err) { return mediaErr(res, err, 'VOD not found'); }
        if (!vod) return res.status(404).json({ error: 'VOD not found or file missing' });
        if ((vod.visibility === 'private' || (!vod.is_public && !vod.visibility)) && vod.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Cannot create clips from private videos' });
        }
        const effStreamId = parsedStreamId || vod.stream_id || null;
        const effStream = effStreamId ? db.getStreamById(effStreamId) : null;
        if (effStream && !db.isStreamClipRecordingEnabled(effStream)) {
            return res.status(403).json({ error: 'Clipping is disabled for this stream.' });
        }
        const clip = await media.createClip({
            vod_id: parsedVodId,
            start_s: startTime,
            end_s: endTime,
            title: defaultClipTitle(sanitizedTitle, effStream?.title || vod.title),
            user_id: req.user.id,
            stream_id: effStreamId || undefined,
            visibility: effStream ? db.resolveStreamClipVisibility(effStream) : 'public',
        });
        noteClip(req.user.id);
        _notifyStreamerOfClip(effStreamId, req.user, sanitizedTitle, clip?.id);
        res.status(201).json({ clip });
    } catch (err) {
        mediaErr(res, err, 'Failed to create clip');
    }
});

function _notifyStreamerOfClip(streamId, clipper, title, clipId) {
    try {
        if (!streamId) return;
        const stream = db.getStreamById(streamId);
        if (!stream || stream.user_id === clipper.id) return;
        const { pushNotification, actorInfo } = require('../utils/notify');
        pushNotification({
            user_id: stream.user_id,
            type: 'CLIP_CREATED',
            title: 'New Clip',
            message: `${clipper.display_name || clipper.username} clipped your stream${title ? `: ${title}` : ''}`,
            url: `https://openvibe.live/clip/${clipId || ''}`,
            ...actorInfo(clipper),
        });
    } catch { /* non-critical */ }
}

router.get('/clips/stream/:streamId', optionalAuth, async (req, res) => {
    try {
        const out = await media.listClips({ stream_id: req.params.streamId });
        res.json({ clips: out?.clips || (Array.isArray(out) ? out : []) });
    } catch (err) {
        mediaErr(res, err, 'Failed to get clips');
    }
});

// TODO(contract): clip trimming (re-cut an existing clip in place) has no Media API v1
// endpoint. Cut a fresh clip from the source VOD instead once Media exposes trim.
router.post('/clips/:id/trim', requireAuth, (req, res) => {
    res.status(501).json({ error: 'Clip trimming is temporarily unavailable while media moves to openvibe.media.' });
});

module.exports = router;
