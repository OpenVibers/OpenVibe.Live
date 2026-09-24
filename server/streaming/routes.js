/**
 * OpenVibe.Live — Streaming & Channel API Routes
 * 
 * Channels (permanent, static URL per user):
 * GET    /api/streams/channel/:username  - Get channel + live stream
 * PUT    /api/streams/channel            - Update own channel
 * 
 * Managed Streams (persistent per-account stream definitions):
 * GET    /api/streams/managed            - List own managed streams
 * POST   /api/streams/managed            - Create a managed stream
 * PUT    /api/streams/managed/:id        - Update a managed stream
 * DELETE /api/streams/managed/:id        - Delete a managed stream
 * 
 * Streams (sessions on a managed stream):
 * GET    /api/streams                    - List live streams
 * GET    /api/streams/recent             - List recently ended streams
 * GET    /api/streams/:id                - Get stream details
 * POST   /api/streams                    - Go live (creates session on managed stream)
 * PUT    /api/streams/:id                - Update stream info
 * DELETE /api/streams/:id                - End a stream
 * GET    /api/streams/:id/endpoint       - Get streaming endpoint info
 * POST   /api/streams/:id/follow         - Follow/unfollow streamer
 */
const express = require('express');
const db = require('../db/database');
const { can } = require('../auth/permissions');
const config = require('../config');
const { requireAuth, requireStreamer, optionalAuth } = require('../auth/auth');
const jsmpegRelay = require('./jsmpeg-relay');
const webrtcSFU = require('./webrtc-sfu');
const recorder = require('./recorder');
const openreAuthority = require('../openre/authority');
const openreMirror = require('../openre/mirror');
const i18n = require('../i18n/translate');
const robotStreamerService = require('../integrations/robotstreamer-service');
const chatRelayService = require('../integrations/chat-relay-service');
const chatServer = require('../chat/chat-server');
const { sanitizeOfflineHtml, sanitizeOfflineCss } = require('./offline-html-sanitize');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
let sharp; try { sharp = require('sharp'); } catch { /* optional */ }

// Offline-screen asset storage + upload/transcode
const OFFLINE_DIR = require('../paths').dir('OFFLINE_SCREEN_PATH', 'offline');
try { fs.mkdirSync(OFFLINE_DIR, { recursive: true }); } catch { /* exists */ }
const offlineUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, OFFLINE_DIR),
        filename: (req, file, cb) => cb(null, `tmp-${req.user?.id || 0}-${Math.random().toString(16).slice(2)}`),
    }),
    limits: { fileSize: 80 * 1024 * 1024 }, // 80MB
});
// Transcode any uploaded video/gif to an optimized, muted, looping WebM.
// One encode at a time site-wide, at low CPU priority: any signed-in user can upload, and a VP8 encode
// of up to three minutes per upload competed with live ingest and chat for the same four cores.
const _offlineEncodes = require('../utils/limit')('offline-encode', 1);
function transcodeOfflineWebm(input, output) {
    return _offlineEncodes.run(() => _transcodeOfflineWebm(input, output), { maxQueue: 6 });
}
function _transcodeOfflineWebm(input, output) {
    return new Promise((resolve, reject) => {
        const args = ['-n', '15', 'ffmpeg', '-y', '-i', input,
            '-c:v', 'libvpx', '-b:v', '1200k', '-crf', '24', '-deadline', 'good', '-cpu-used', '2',
            '-vf', "scale='min(1280,iw)':-2", '-an', '-f', 'webm', output];
        const p = spawn('nice', args);
        let err = '';
        p.stderr.on('data', d => { err += d; if (err.length > 4000) err = err.slice(-4000); });
        const to = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} reject(new Error('transcode timeout')); }, 180000);
        p.on('error', e => { clearTimeout(to); reject(e); });
        p.on('close', code => { clearTimeout(to); code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.slice(-200)}`)); });
    });
}
const { pushNotification, actorInfo } = require('../utils/notify');

const router = express.Router();
const ALLOWED_PROTOCOLS = new Set(['jsmpeg', 'webrtc', 'rtmp']);
const ALLOWED_VISIBILITY = new Set(['public', 'unlisted', 'private']);
const ALLOWED_CALL_MODES = new Set(['mic', 'mic+cam', 'cam+mic']);
const MAX_TITLE_LENGTH = 140;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_CATEGORY_LENGTH = 60;
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 32;
const MAX_PANELS_LENGTH = 20000;

// ── Go-Live Notification Push ────────────────────────────────
const { pushBulkNotification } = require('../utils/notify');
const { publicManagedStream, publicChannel, publicStream } = require('../web/serializers');

/**
 * Staff may moderate someone else's stream or slot (edit, end, delete, read status) but never the site
 * owner's, and never act AS its streamer: reading or regenerating a stream key, the ingest endpoint,
 * going live on a slot, heartbeats, call settings and WHIP publishing stay with the streamer alone.
 */
function staffMayModerate(actor, ownerUserId) {
    if (!can(actor, 'staff.streams.manage')) return false;
    const target = db.getUserById(ownerUserId);
    return !(target && target.is_owner);
}

/** A control profile id a slot may point at: one of the caller's own (admins may use anyone's). */
function ownControlConfigId(req, raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    const id = parseInt(raw);
    const cfg = Number.isFinite(id) ? db.getControlConfig(id) : null;
    if (!cfg || (cfg.user_id !== req.user.id && !can(req.user, 'staff.streams.manage'))) return undefined;
    return id;
}

const { notifyDiscordGoLive } = require('../integrations/discord-webhook');

const INTERNAL_API_KEY = config.internalApiKey || process.env.INTERNAL_API_KEY || process.env.OV_INTERNAL_KEY || '';

/**
 * Push "X went live" notification via openvibe.network unified event endpoint.
 * This lets openvibe.network handle Discord bot alerts + push notifications centrally.
 * Falls back to direct webhook + bulk push if openvibe.network is unreachable.
 */
// Go-live fan-out lives in ./golive-notify (shared with the RTMP and WHIP ingest paths,
// which never notified anyone before), with follower-id translation + 60-min dedupe.
const { notifyFollowersGoLive } = require('./golive-notify');

function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function cleanText(value, { maxLength, allowEmpty = false } = {}) {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') return null;
    const cleaned = value.replace(/\s+/g, ' ').trim();
    if (!cleaned) return allowEmpty ? '' : null;
    return cleaned.slice(0, maxLength);
}

function cleanProtocol(value) {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') return null;
    const cleaned = value.trim().toLowerCase();
    return ALLOWED_PROTOCOLS.has(cleaned) ? cleaned : null;
}

function cleanVisibility(value) {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') return null;
    const cleaned = value.trim().toLowerCase();
    return ALLOWED_VISIBILITY.has(cleaned) ? cleaned : null;
}

function cleanCallMode(value) {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    if (typeof value !== 'string') return null;
    const cleaned = value.trim().toLowerCase();
    return ALLOWED_CALL_MODES.has(cleaned) ? cleaned : null;
}

function cleanTags(tags) {
    if (tags === undefined) return undefined;
    if (!Array.isArray(tags)) return null;
    const cleaned = [];
    const seen = new Set();
    for (const tag of tags) {
        if (typeof tag !== 'string') continue;
        const normalized = tag.replace(/\s+/g, ' ').trim().toLowerCase();
        if (!normalized || normalized.length > MAX_TAG_LENGTH || seen.has(normalized)) continue;
        seen.add(normalized);
        cleaned.push(normalized);
        if (cleaned.length >= MAX_TAGS) break;
    }
    return cleaned;
}

function cleanPanels(panels) {
    if (panels === undefined) return undefined;
    if (typeof panels === 'string') {
        return panels.length <= MAX_PANELS_LENGTH ? panels : null;
    }
    try {
        const serialized = JSON.stringify(panels ?? []);
        return serialized.length <= MAX_PANELS_LENGTH ? serialized : null;
    } catch {
        return null;
    }
}

function cleanBooleanFlag(value) {
    return value === true || value === 1 || value === '1' || value === 'true';
}

function resolveWhipUrlBase(config, req) {
    const requestHostOrigin = `${req.protocol}://${req.get('host')}`;
    const fallbackUrl = config.webrtc?.publicUrl || requestHostOrigin;
    let whipUrlBase = fallbackUrl;
    let whipUrlSource = config.webrtc?.publicUrl ? 'webrtc_public_url' : 'request_host';
    let whipUrlWarning;

    if (config.whip?.publicUrl && config.whip?.enabled) {
        whipUrlBase = config.whip.publicUrl;
        whipUrlSource = 'whip_public_url';
        try {
            const baseHost = new URL(config.baseUrl).hostname;
            const whipHost = new URL(whipUrlBase).hostname;
            if (whipHost !== baseHost && config.nodeEnv !== 'development') {
                whipUrlWarning = 'Dedicated WHIP hostname differs from BASE_URL host. Ensure DNS/vhost/TLS are configured for this host before using it.';
            }
        } catch {
            // invalid URL parsing should not block endpoint generation
        }
    } else if (config.whip?.publicUrl && !config.whip?.enabled) {
        whipUrlWarning = 'Dedicated WHIP hostname is configured but not enabled. Falling back to the safe public WebRTC origin.';
    }

    return { whipUrlBase, whipUrlSource, whipUrlWarning };
}

// ── Get Channel by Username ──────────────────────────────────
router.get('/channel/:username', optionalAuth, async (req, res) => {
    try {
        let channel = db.getChannelByUsername(req.params.username);
        if (!channel) {
            const user = db.getUserByUsername(req.params.username);
            if (!user) return res.status(404).json({ error: 'Channel not found' });
            db.ensureChannel(user.id);
            channel = db.getChannelByUsername(req.params.username);
            if (!channel) return res.status(404).json({ error: 'Channel not found' });
        }

        // Get live streams (may be multiple with different protocols)
        const liveStreams = db.getLiveStreamsByUserId(channel.user_id) || [];
        for (const liveStream of liveStreams) {
            // Use managed stream key from the JOIN, else fall back to user key
            const lsKey = liveStream.managed_stream_key
                || db.getUserById(liveStream.user_id)?.stream_key;
            if (liveStream.protocol === 'jsmpeg') {
                liveStream.endpoint = jsmpegRelay.getChannelInfo(lsKey);
            } else if (liveStream.protocol === 'webrtc') {
                liveStream.endpoint = { roomId: `stream-${liveStream.id}` };
            } else if (liveStream.protocol === 'rtmp') {
                liveStream.endpoint = {
                    flvUrl: `/api/streams/rtmp-proxy/${liveStream.id}.flv`,
                };
            }
            // Whether this live slot is being recorded server-side — if so, the client can
            // cut clips on the SERVER (no CPU-heavy client-side MediaRecorder buffer).
            try { liveStream.server_clip = !!recorder.getActiveRecording(liveStream.id); } catch { liveStream.server_clip = false; }
            delete liveStream.stream_key;
            delete liveStream.managed_stream_key;
        }

        // Show hidden (private + unlisted) VODs/clips to the channel owner AND admins;
        // everyone else sees public only.
        const isOwner = req.user && req.user.id === channel.user_id;
        const canSeeHidden = !!(isOwner || can(req.user, 'staff.content.view_private'));
        const vodLimit = Math.min(Math.max(parseInt(req.query.vodLimit || '12', 10), 1), 48);
        const vodOffset = Math.max(parseInt(req.query.vodOffset || '0', 10), 0);
        const ALLOWED_VOD_ORDERS = new Set(['newest', 'oldest', 'views', 'peak_viewers']);
        const vodOrderBy = ALLOWED_VOD_ORDERS.has(req.query.vodOrderBy) ? req.query.vodOrderBy : 'newest';
        // Accept managed stream by numeric ID or slug
        let vodManagedStreamId = null;
        if (req.query.vodManagedStreamId) {
            const rawMsId = req.query.vodManagedStreamId;
            const numId = parseInt(rawMsId, 10);
            if (!isNaN(numId) && String(numId) === String(rawMsId)) {
                vodManagedStreamId = numId;
            } else {
                // Try slug resolution
                const msRow = db.getManagedStreamBySlug(channel.user_id, rawMsId);
                if (msRow) vodManagedStreamId = msRow.id;
            }
        } else if (req.query.vodManagedStreamSlug) {
            const msRow = db.getManagedStreamBySlug(channel.user_id, req.query.vodManagedStreamSlug);
            if (msRow) vodManagedStreamId = msRow.id;
        }
        const clipLimit = Math.min(Math.max(parseInt(req.query.clipLimit || '12', 10), 1), 48);
        const clipOffset = Math.max(parseInt(req.query.clipOffset || '0', 10), 0);
        const clipsOfLimit = Math.min(Math.max(parseInt(req.query.clipsOfLimit || '12', 10), 1), 48);
        const clipsOfOffset = Math.max(parseInt(req.query.clipsOfOffset || '0', 10), 0);
        const aiClipsLimit = Math.min(Math.max(parseInt(req.query.aiClipsLimit || '12', 10), 1), 48);
        const aiClipsOffset = Math.max(parseInt(req.query.aiClipsOffset || '0', 10), 0);
        // The 15s live/offline status poll passes ?pollOnly=1 — it only reads live streams
        // + viewer counts, so skip the 6 heavy VOD/clip listing+count queries entirely.
        const pollOnly = req.query.pollOnly === '1' || req.query.pollOnly === 'true';
        // VOD/clip rows live in OpenVibe.Media now — list through the media client.
        // TODO(contract): list filters (user_id/include_private/managed_stream_id/
        // channel_user_id/order) follow the inherited query shapes.
        const media = require('../media-client');
        const _rows = (r, k) => (r && r[k]) || (Array.isArray(r) ? r : []);
        let vods = [], vodTotal = 0, clips = [], clipTotal = 0, clipsOfStreams = [], clipsOfTotal = 0, aiClips = [], aiClipsTotal = 0;
        if (!pollOnly) {
            // People's clips and the AI's are separate lists (roadmap 33.6: made, then derived). The
            // auto-clip job cuts in the streamer's name, so without auto_generated=0 its clips would
            // be listed as clips the streamer made. Rows are checked again in case Media ignores it.
            const isAi = (c) => !!(c && (c.auto_generated === true || Number(c.auto_generated) === 1));
            const [vr, cr, cor, air] = await Promise.all([
                media.listVods({ user_id: channel.user_id, include_private: canSeeHidden ? 1 : 0, managed_stream_id: vodManagedStreamId || undefined, order: vodOrderBy, limit: vodLimit, offset: vodOffset }).catch(() => null),
                media.listClips({ user_id: channel.user_id, include_private: canSeeHidden ? 1 : 0, auto_generated: 0, limit: clipLimit, offset: clipOffset }).catch(() => null),
                media.listClips({ channel_user_id: channel.user_id, auto_generated: 0, limit: clipsOfLimit, offset: clipsOfOffset }).catch(() => null),
                media.listClips({ channel_user_id: channel.user_id, auto_generated: 1, limit: aiClipsLimit, offset: aiClipsOffset }).catch(() => null),
            ]);
            vods = _rows(vr, 'vods'); vodTotal = vr?.total ?? vods.length;
            clips = _rows(cr, 'clips').filter((c) => !isAi(c)); clipTotal = cr?.total ?? clips.length;
            clipsOfStreams = _rows(cor, 'clips').filter((c) => !isAi(c)); clipsOfTotal = cor?.total ?? clipsOfStreams.length;
            aiClips = _rows(air, 'clips').filter(isAi); aiClipsTotal = air?.total ?? aiClips.length;
            // Media only stores our numeric user ids — resolve clip creator names
            // locally so cards don't render "by Unknown".
            const nameClip = (c) => {
                if (c && c.user_id != null) {
                    const u = db.getUserById(c.user_id);
                    if (u) { c.clip_creator_username = u.username; c.clip_creator_display_name = u.display_name; }
                }
                return c;
            };
            clips.forEach(nameClip);
            clipsOfStreams.forEach(nameClip);
            // An AI clip has no clipper: it is "from <streamer>'s stream".
            for (const c of aiClips) { c.ai_label = 'AI clip'; c.source_streamer_username = channel.username; c.source_streamer_display_name = channel.display_name || channel.username; }
            // AI overviews are Live-owned (vod_ai_state / clip_ai_state). Attach the
            // full text too — the card expander swaps the short teaser for it.
            const aiShort = (rows, table, col) => {
                for (const r of rows) {
                    if (!r || r.id == null || (r.ai_overview_short && r.ai_overview)) continue;
                    try {
                        const s = db.get(`SELECT ai_overview_short, ai_overview FROM ${table} WHERE ${col} = ?`, [r.id]);
                        if (s && s.ai_overview_short && !r.ai_overview_short) r.ai_overview_short = s.ai_overview_short;
                        if (s && s.ai_overview && !r.ai_overview) r.ai_overview = s.ai_overview;
                    } catch { /* best-effort */ }
                }
            };
            aiShort(vods, 'vod_ai_state', 'vod_id');
            aiShort(clips, 'clip_ai_state', 'clip_id');
            aiShort(clipsOfStreams, 'clip_ai_state', 'clip_id');
            aiShort(aiClips, 'clip_ai_state', 'clip_id');
        }
        const followerCount = db.getFollowerCount(channel.user_id);
        const isFollowing = req.user ? db.isFollowing(req.user.id, channel.user_id) : false;
        // Managed streams for this channel
        const managedStreams = db.getManagedStreamsByUserId(channel.user_id) || [];

        // Include RS restream status + per-slot external viewer counts for each live stream.
        // Everything is keyed by the stream's own managed_stream_id (slot) so a channel
        // running two slots doesn't mix one slot's robot/platform counts onto the other.
        const restreamManager = require('./restream-manager');
        const rsInfo = {};
        for (const ls of liveStreams) {
            const slotId = ls.managed_stream_id || null;
            const rsVc = robotStreamerService.getRsViewerCount(ls.user_id, slotId);
            const hasBridge = robotStreamerService.chatBridges.has(ls.id);
            let hasPublish = robotStreamerService._activePublish?.has(ls.id);
            try { hasPublish = hasPublish || require('../integrations/rs-passthrough-relay').status(ls.id)?.state === 'live'; } catch { /* ignore */ }
            const rsActive = hasBridge || hasPublish;
            if (rsActive) {
                const integration = db.getRobotStreamerIntegrationForStream(ls.user_id, slotId);
                rsInfo[ls.id] = {
                    active: true,
                    robot_id: integration?.robot_id || null,
                    robot_name: integration?.stream_name || integration?.robot_id || 'RS Robot',
                    chat_mirrored: hasBridge,
                    video_restreamed: !!hasPublish,
                    viewer_count: rsVc,
                    managed_stream_id: slotId,
                };
            }
            // Per-slot external (Twitch/Kick/YouTube) + RS totals attached to this stream.
            const ext = restreamManager.getExternalViewerCountsForUser(ls.user_id, slotId);
            ls.rs_viewers = rsActive ? rsVc : 0;
            ls.platform_viewers = ext.breakdown;
            ls.external_viewer_count = ext.total + ls.rs_viewers;
            ls.total_viewer_count = (ls.viewer_count || 0) + ls.external_viewer_count;
        }

        // Include restream destination links (Twitch/Kick/YouTube) for live streams.
        // SLOT-ONLY: only show destinations bound to the managed_stream_id of the active live
        // stream(s). Never silently fall back to all account-level destinations — that caused
        // stale old-slot badges to appear on new streams.
        // Migration aid: if a live stream has NO managed_stream_id (legacy session), include
        // destinations that are also unbound (null managed_stream_id) as a temporary fallback
        // while the DB backfill migration has not yet run.
        let restreamLinks = null;
        let externalViewers = null;
        if (liveStreams.length > 0) {
            const allDests = db.getRestreamDestinationsByUserId(channel.user_id) || [];

            // Collect managed_stream_ids for all current live sessions
            const activeManagedIds = new Set(
                liveStreams.map(s => s.managed_stream_id).filter(Boolean)
            );

            let dests;
            if (activeManagedIds.size > 0) {
                // Slot-bound: only show destinations that belong to one of the live slots
                dests = allDests.filter(d => d.managed_stream_id && activeManagedIds.has(d.managed_stream_id));
            } else {
                // Legacy live session with no managed_stream_id — show unbound destinations only
                dests = allDests.filter(d => !d.managed_stream_id);
                if (dests.length > 0) {
                    console.warn(`[Restream] Channel ${channel.user_id} has a live stream with no managed_stream_id — showing unbound destinations. Run DB backfill migration.`);
                }
            }

            const enabledWithUrl = dests.filter(d => d.enabled && d.channel_url);
            if (enabledWithUrl.length > 0) {
                restreamLinks = enabledWithUrl.map(d => {
                    // Check if this destination is actively streaming
                    const streamStatuses = liveStreams.flatMap(ls => restreamManager.getStreamStatus(ls.id));
                    const activeSession = streamStatuses.find(s => s.destId === d.id && (s.status === 'live' || s.status === 'starting'));
                    const relayInfo = chatRelayService.getRelayInfo(liveStreams[0].id);
                    const hasRelay = relayInfo?.some(r => r.destId === d.id);

                    // Determine if actually live on the platform:
                    // - If we have a platform-level signal (Twitch Helix, Kick Pusher), use it
                    // - Otherwise fall back to session status with a 60s grace period for new sessions
                    let isLive = false;
                    if (activeSession) {
                        const platformLive = restreamManager.isPlatformLive(d.id);
                        if (platformLive != null) {
                            isLive = platformLive;
                        } else {
                            const sessionAge = Date.now() - (activeSession.startedAt || Date.now());
                            isLive = sessionAge < 60000;
                        }
                    }

                    return {
                        platform: d.platform,
                        name: d.name,
                        channel_url: d.channel_url,
                        is_live: isLive,
                        chat_relayed: !!hasRelay,
                        viewer_count: restreamManager.getCachedViewerCount(d.id),
                        managed_stream_id: d.managed_stream_id || null,
                    };
                });
            }

            // Channel-wide external summary = sum of each live slot's per-slot totals
            // (used only for the cumulative "across N streams" line; per-slot values live
            // on each stream object for the watched-slot badge).
            let channelExternalTotal = 0, channelRsTotal = 0;
            const channelBreakdown = [];
            for (const ls of liveStreams) {
                channelExternalTotal += ls.external_viewer_count || 0;
                channelRsTotal += ls.rs_viewers || 0;
                if (Array.isArray(ls.platform_viewers)) channelBreakdown.push(...ls.platform_viewers);
            }
            if (channelExternalTotal > 0 || channelBreakdown.length > 0 || Object.keys(rsInfo).length > 0) {
                externalViewers = {
                    total: channelExternalTotal,
                    platform_viewers: channelBreakdown,
                    rs_viewers: channelRsTotal,
                };
            }
        }

        // Strip private fields from public channel response
        const publicChannel = { ...channel, follower_count: followerCount, is_following: isFollowing };
        // Re-sanitize on every read: covers rows saved before offline-html-sanitize.js existed,
        // with no backfill migration needed, at the cost of re-running a cheap parse per request.
        if (publicChannel.offline_html) publicChannel.offline_html = sanitizeOfflineHtml(publicChannel.offline_html);
        if (publicChannel.offline_css) publicChannel.offline_css = sanitizeOfflineCss(publicChannel.offline_css);
        // Whether the weather widget is on (without leaking the zip) — used by the
        // client to decide if the About tab should show.
        publicChannel.weather_enabled = !!(channel.weather_zip && channel.weather_detail && channel.weather_detail !== 'off');
        // About-tab edit permission: the owner always can; channel mods can only when
        // the streamer has opted in (mods_can_edit_about). Surfaced so the client can
        // show the pencil edit button to the right people.
        let modsCanEditAbout = false;
        let _modSettings = {};
        try { _modSettings = db.getChannelModerationSettings(channel.id) || {}; modsCanEditAbout = !!_modSettings.mods_can_edit_about; } catch { /* default off */ }
        // Public chat limits so the client can cap the input + truncate TTS to the streamer's max.
        publicChannel.chat_limits = {
            max_message_length: Math.max(1, Number(_modSettings.max_message_length) || 500),
            tts_max_length: Math.max(10, Number(_modSettings.tts_max_length) || 200),
        };
        const viewerIsChannelMod = !!(req.user && db.isChannelModerator(req.user.id, channel.id));
        publicChannel.mods_can_edit_about = modsCanEditAbout;
        publicChannel.viewer_can_edit_about = !!(isOwner || (modsCanEditAbout && viewerIsChannelMod));
        // Streamer AI overview for the top of the About tab (unless the streamer hid it).
        // `hide_ai_overview` rides along on the channel row spread above.
        try {
            const _ov = pollOnly ? null : db.getStreamerOverview(channel.user_id);
            publicChannel.ai_overview = (_ov && (_ov.overview || _ov.overview_short)) || null;
        } catch { publicChannel.ai_overview = null; }
        delete publicChannel.weather_zip;
        delete publicChannel.stream_key;
        delete publicChannel.vod_recording_enabled;
        delete publicChannel.force_vod_recording_disabled;

        // Counts for tab badges. Owner/mods see hidden ones too. Pastes are counted by
        // OpenVibe.Community and taken clips by OpenVibe.Media (media-proxy/lookups.js).
        let pasteTotal = 0, clipsTakenTotal = 0, aiEventTotal = 0;
        if (!pollOnly) {
            const lookups = require('../media-proxy/lookups');
            const owner = db.getUserById(channel.user_id);
            [pasteTotal, clipsTakenTotal] = await Promise.all([
                lookups.countUserPastes(owner, { hidden: canSeeHidden ? (isOwner ? 'owner' : 'staff') : false }),
                lookups.countClipsTaken(channel.user_id, { includePrivate: canSeeHidden }),
            ]);
        }
        try { aiEventTotal = pollOnly ? 0 : db.countStreamMemoriesByUser(channel.user_id); } catch { /* */ }

        // Tab-hide flags: when a streamer defaults ALL their slots' VODs (or clips) to private,
        // and there's no public content to show, hide that tab on the public channel page.
        // (Gating on an empty count means we never hide a tab that still has public content.)
        const _slotVis = managedStreams.map(ms => ms.default_vod_visibility || 'public');
        const _slotClipVis = managedStreams.map(ms => ms.default_clip_visibility || 'public');
        const allVodPrivate = _slotVis.length
            ? _slotVis.every(v => v === 'private')
            : ((channel.default_vod_visibility || 'public') === 'private');
        const allClipPrivate = _slotClipVis.length
            ? _slotClipVis.every(v => v === 'private')
            : ((channel.default_clip_visibility || 'public') === 'private');
        const videos_tab_hidden = !pollOnly && allVodPrivate && vodTotal === 0;
        const clips_tab_hidden = !pollOnly && allClipPrivate && clipTotal === 0 && clipsOfTotal === 0 && aiClipsTotal === 0;

        res.json({
            videos_tab_hidden,
            clips_tab_hidden,
            pasteTotal,
            clipsTakenTotal,
            aiEventTotal,
            channel: publicChannel,
            // The language this channel lives in (explicit setting or detected from the bio) —
            // drives the chat auto-translation notice, the live-captions panel and bio translation.
            language: i18n.channelMeta(channel.user_id),
            stream: liveStreams[0] || null,
            streams: liveStreams,
            // Slots are rows from `SELECT ms.*` — the owner's ingest key and home ZIP are on them.
            // This endpoint is public, so everyone gets the public projection; the owner reads keys
            // from /api/streams/managed/:id/profile.
            managed_streams: managedStreams.map(publicManagedStream),
            rs_restream: Object.keys(rsInfo).length ? rsInfo : null,
            restream_links: restreamLinks,
            external_viewers: externalViewers,
            vods,
            vodTotal,
            vodLimit,
            vodOffset,
            vodOrderBy,
            vodManagedStreamId: vodManagedStreamId || null,
            vodHasMore: vodOffset + vods.length < vodTotal,
            clips,
            clipTotal,
            clipLimit,
            clipOffset,
            clipHasMore: clipOffset + clips.length < clipTotal,
            clipsOfStreams,
            clipsOfTotal,
            clipsOfLimit,
            clipsOfOffset,
            clipsOfHasMore: clipsOfOffset + clipsOfStreams.length < clipsOfTotal,
            // AI Moments of this channel: auto-clips, listed after people's clips and labelled.
            aiClips,
            aiClipsTotal,
            aiClipsLimit,
            aiClipsOffset,
            aiClipsHasMore: aiClipsOffset + aiClips.length < aiClipsTotal,
        });
    } catch (err) {
        console.error('[Channels] Get error:', err.message);
        res.status(500).json({ error: 'Failed to get channel' });
    }
});

// ── Most-popular recent VOD + clip (offline-screen "explore" cards) ──
router.get('/channel/:username/popular', async (req, res) => {
    try {
        const user = db.getUserByUsername(req.params.username);
        if (!user) return res.status(404).json({ error: 'Not found' });
        let vods = [], clips = [];
        const media = require('../media-client');
        try { const r = await media.listVods({ user_id: user.id, order: 'views', limit: 12 }); vods = r?.vods || (Array.isArray(r) ? r : []); } catch { /* */ }
        try { const r = await media.listClips({ channel_user_id: user.id, order: 'views', limit: 12 }); clips = r?.clips || (Array.isArray(r) ? r : []); } catch { /* */ }
        let ranges = null;
        try { ranges = await require('../media-proxy/lookups').topContentRanges(user); } catch { /* */ }
        res.json({
            // Singular kept for back-compat; arrays let the offline screen fill the space.
            vod: vods[0] || null,
            clip: clips[0] || null,
            vods,
            clips,
            // Top VOD + clip per time window (week/month/all) for the compact offline cycler.
            ranges,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get popular content' });
    }
});

// ── "Clips Taken" tab: clips this streamer created, filterable by source streamer,
// sortable, self-clips hidden by default. optionalAuth so owners can see their private.
router.get('/channel/:username/clips-taken', optionalAuth, async (req, res) => {
    try {
        const user = db.getUserByUsername(req.params.username);
        if (!user) return res.status(404).json({ error: 'Not found' });
        const isOwner = req.user && req.user.id === user.id;
        const canSeeHidden = !!(isOwner || can(req.user, 'staff.content.view_private'));
        const ALLOWED_SORT = new Set(['newest', 'oldest', 'views']);
        const orderBy = ALLOWED_SORT.has(req.query.sort) ? req.query.sort : 'newest';
        const sourceStreamerId = parseInt(req.query.of, 10) || null;
        // Default hides self-clips unless a specific streamer is chosen or includeSelf=1.
        const includeSelf = req.query.includeSelf === '1' || req.query.includeSelf === 'true';
        const hideSelf = !sourceStreamerId && !includeSelf;
        const limit = Math.min(Math.max(parseInt(req.query.limit || '12', 10), 1), 48);
        const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
        // Clip rows come from OpenVibe.Media now (creator-scoped listing).
        // TODO(contract): source-streamer/self filters follow the inherited query shapes.
        const media = require('../media-client');
        const r = await media.listClips({
            user_id: user.id, include_private: canSeeHidden ? 1 : 0, order: orderBy,
            source_streamer_id: sourceStreamerId || undefined, hide_self: hideSelf ? 1 : 0,
            auto_generated: 0,   // the auto-clip job cuts in the streamer's name; those clips are not ones they took
            limit, offset,
        }).catch(() => null);
        const clips = (r?.clips || (Array.isArray(r) ? r : [])).map(c => {
            // Overlay Live-owned source-streamer fields (Media only stores our id).
            const streamer = c.channel_user_id != null ? db.getUserById(c.channel_user_id) : null;
            if (streamer) {
                c.source_streamer_id = c.channel_user_id;
                c.source_streamer_username = streamer.username;
                c.source_streamer_display_name = streamer.display_name;
            }
            return c;
        });
        const total = r?.total ?? clips.length;
        const facets = (r?.facets || []).map(f => ({ ...f, is_self: f.streamer_id === user.id }));
        res.json({ clips, total, facets, limit, offset, hasMore: offset + clips.length < total, sort: orderBy, of: sourceStreamerId, includeSelf });
    } catch (err) {
        console.error('[Channels] clips-taken error:', err.message);
        res.status(500).json({ error: 'Failed to get clips' });
    }
});

// ── Lightweight live-only channel endpoint (fast player init) ──
// Returns ONLY the data needed to start the player — no VODs, clips, or heavy queries
router.get('/channel/:username/live', (req, res) => {
    try {
        res.set('Cache-Control', 'public, max-age=3');
        const channel = db.getChannelByUsername(req.params.username);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        const liveStreams = db.getLiveStreamsByUserId(channel.user_id) || [];
        for (const liveStream of liveStreams) {
            // Use managed stream key from the JOIN, else fall back to user key
            const lsKey = liveStream.managed_stream_key
                || db.getUserById(liveStream.user_id)?.stream_key;
            if (liveStream.protocol === 'jsmpeg') {
                liveStream.endpoint = jsmpegRelay.getChannelInfo(lsKey);
            } else if (liveStream.protocol === 'webrtc') {
                liveStream.endpoint = { roomId: `stream-${liveStream.id}` };
            } else if (liveStream.protocol === 'rtmp') {
                liveStream.endpoint = {
                    flvUrl: `/api/streams/rtmp-proxy/${liveStream.id}.flv`,
                };
            }
            // Whether this live slot is being recorded server-side — if so, the client can
            // cut clips on the SERVER (no CPU-heavy client-side MediaRecorder buffer).
            try { liveStream.server_clip = !!recorder.getActiveRecording(liveStream.id); } catch { liveStream.server_clip = false; }
            delete liveStream.stream_key;
            delete liveStream.managed_stream_key;
        }

        res.json({
            channel: { username: channel.username, display_name: channel.display_name, user_id: channel.user_id },
            streams: liveStreams,
        });
    } catch (err) {
        console.error('[Channels] Live-only error:', err.message);
        res.status(500).json({ error: 'Failed to get live stream data' });
    }
});

// ── Get Own Channel ──────────────────────────────────────────
router.get('/channel', requireAuth, (req, res) => {
    try {
        db.ensureChannel(req.user.id);
        const channel = db.getChannelByUserId(req.user.id);
        res.json(channel || {});
    } catch (err) {
        console.error('[Channels] Get own error:', err.message);
        res.status(500).json({ error: 'Failed to get channel' });
    }
});

// ── Update Own Channel ───────────────────────────────────────
router.put('/channel', requireAuth, (req, res) => {
    try {
        db.ensureChannel(req.user.id);
        const { is_nsfw, auto_record, vod_recording_enabled } = req.body;
        const title = cleanText(req.body.title, { maxLength: MAX_TITLE_LENGTH });
        const description = cleanText(req.body.description, { maxLength: MAX_DESCRIPTION_LENGTH, allowEmpty: true });
        const category = cleanText(req.body.category, { maxLength: MAX_CATEGORY_LENGTH });
        const protocol = cleanProtocol(req.body.protocol);
        const panels = cleanPanels(req.body.panels);
        const defaultVodVisibility = cleanVisibility(req.body.default_vod_visibility);
        const defaultClipVisibility = cleanVisibility(req.body.default_clip_visibility);

        // Weather settings
        let weatherZip;
        if (hasOwn(req.body, 'weather_zip')) {
            const raw = (req.body.weather_zip || '').toString().trim();
            weatherZip = raw === '' ? null : raw.replace(/[^0-9a-zA-Z\s-]/g, '').slice(0, 10);
        }
        const ALLOWED_WEATHER_DETAIL = new Set(['off', 'basic', 'hourly', 'detailed']);
        let weatherDetail;
        if (hasOwn(req.body, 'weather_detail')) {
            const wd = (req.body.weather_detail || '').toString().trim();
            weatherDetail = ALLOWED_WEATHER_DETAIL.has(wd) ? wd : undefined;
        }

        if ((hasOwn(req.body, 'title') && title === null)
            || (hasOwn(req.body, 'description') && description === null)
            || (hasOwn(req.body, 'category') && category === null)
            || (hasOwn(req.body, 'protocol') && protocol === null)
            || (hasOwn(req.body, 'panels') && panels === null)
            || (hasOwn(req.body, 'default_vod_visibility') && defaultVodVisibility === null)
            || (hasOwn(req.body, 'default_clip_visibility') && defaultClipVisibility === null)) {
            return res.status(400).json({ error: 'Invalid channel settings' });
        }

        const fields = {};
        if (title !== undefined) fields.title = title;
        if (description !== undefined) fields.description = description;
        if (category !== undefined) fields.category = category;
        if (protocol !== undefined) fields.protocol = protocol;
        if (is_nsfw !== undefined) fields.is_nsfw = cleanBooleanFlag(is_nsfw) ? 1 : 0;
        if (auto_record !== undefined) fields.auto_record = cleanBooleanFlag(auto_record) ? 1 : 0;
        if (vod_recording_enabled !== undefined) {
            fields.vod_recording_enabled = cleanBooleanFlag(vod_recording_enabled) ? 1 : 0;
        }
        if (panels !== undefined) fields.panels = panels;
        if (defaultVodVisibility !== undefined) {
            fields.default_vod_visibility = defaultVodVisibility;
        }
        if (defaultClipVisibility !== undefined) {
            fields.default_clip_visibility = defaultClipVisibility;
        }
        if (weatherZip !== undefined) fields.weather_zip = weatherZip;
        if (weatherDetail !== undefined) fields.weather_detail = weatherDetail;
        if (hasOwn(req.body, 'weather_show_location')) {
            fields.weather_show_location = cleanBooleanFlag(req.body.weather_show_location) ? 1 : 0;
        }
        if (hasOwn(req.body, 'hide_ai_overview')) {
            fields.hide_ai_overview = cleanBooleanFlag(req.body.hide_ai_overview) ? 1 : 0;
        }
        if (hasOwn(req.body, 'ai_overview_pref')) {
            const p = String(req.body.ai_overview_pref || 'auto').trim();
            if (['auto', 'show', 'hide'].includes(p)) fields.ai_overview_pref = p;
        }
        // Whether OpenVibe's AI may make Moments from this channel's streams (roadmap 33.7).
        if (hasOwn(req.body, 'ai_derivation_enabled')) {
            fields.ai_derivation_enabled = cleanBooleanFlag(req.body.ai_derivation_enabled) ? 1 : 0;
        }
        // Chat/stream language: 'auto' (detect from bio) or an ISO code from i18n.LANG_NAMES.
        if (hasOwn(req.body, 'chat_language')) {
            const l = String(req.body.chat_language || 'auto').trim().toLowerCase();
            if (i18n.isAllowedLang(l)) { fields.chat_language = l; i18n.invalidateChannel(req.user.id); }
        }

        // Offline screen config (asset is uploaded separately at /channel/offline-screen)
        if (hasOwn(req.body, 'offline_screen_type')) {
            const t = String(req.body.offline_screen_type || 'none').trim();
            if (['none', 'image', 'video', 'html'].includes(t)) fields.offline_screen_type = t;
        }
        // Sanitized on write (basic markup, no script/frames/forms — see offline-html-sanitize.js)
        // and again on every read below, so rows saved before this sanitizer existed are covered too.
        if (hasOwn(req.body, 'offline_html')) fields.offline_html = sanitizeOfflineHtml(String(req.body.offline_html || '').slice(0, 20000));
        if (hasOwn(req.body, 'offline_css')) fields.offline_css = sanitizeOfflineCss(String(req.body.offline_css || '').slice(0, 20000));

        if (Object.keys(fields).length > 0) {
            db.updateChannel(req.user.id, fields);
        }

        const channel = db.getChannelByUserId(req.user.id);
        res.json({ channel });
    } catch (err) {
        // (falls through to the shared handler below)
        console.error('[Channel] update error:', err.message);
        return res.status(500).json({ error: 'Failed to update channel' });
    }
});

// ── Bio in English (for non-English streamers) ────────────────
// Cached by content hash in the translations table; null when the bio is already English
// or AI translation is unavailable.
router.get('/channel/:username/bio-en', async (req, res) => {
    try {
        const user = db.getUserByUsername(req.params.username);
        if (!user) return res.status(404).json({ error: 'Channel not found' });
        const bio = String(user.bio || '').trim();
        const from = i18n.detectForeignInText(bio);   // any non-English line makes the bio worth translating
        res.set('Cache-Control', 'public, max-age=300');
        if (!bio || !from) return res.json({ from: null, to: 'en', text: null });
        const text = await i18n.translate(bio, { from, to: 'en', context: 'bio' });
        res.json({ from, to: 'en', text: text || null, from_name: i18n.langName(from), flag: i18n.langFlag(from) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to translate bio' });
    }
});

// ── Save a channel's About section (bio + panels) ────────────
// Editable by the channel owner, and by channel moderators when the streamer has
// enabled `mods_can_edit_about`. Targets the channel by username so a mod writes
// to the STREAMER's channel, not their own.
router.put('/channel/:username/about', requireAuth, (req, res) => {
    try {
        const channel = db.getChannelByUsername(req.params.username);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        const isOwner = req.user.id === channel.user_id;
        let modsCanEditAbout = false;
        try { modsCanEditAbout = !!(db.getChannelModerationSettings(channel.id) || {}).mods_can_edit_about; } catch { /* off */ }
        const isChannelMod = db.isChannelModerator(req.user.id, channel.id);
        if (!isOwner && !(modsCanEditAbout && isChannelMod)) {
            return res.status(403).json({ error: 'You do not have permission to edit this About section' });
        }

        // Bio (stored on the streamer's user profile)
        if (hasOwn(req.body, 'bio')) {
            const bio = String(req.body.bio == null ? '' : req.body.bio).replace(/<[^>]*>/g, '').slice(0, 500);
            db.setUserBio(channel.user_id, bio);
        }
        // Panels (stored on the channel)
        if (hasOwn(req.body, 'panels')) {
            const panels = cleanPanels(req.body.panels);
            if (panels === null) return res.status(400).json({ error: 'Invalid panels' });
            if (panels !== undefined) db.updateChannel(channel.user_id, { panels });
        }
        // Show/hide the AI overview at the top of the About tab.
        if (hasOwn(req.body, 'hide_ai_overview')) {
            db.updateChannel(channel.user_id, { hide_ai_overview: req.body.hide_ai_overview ? 1 : 0 });
        }
        // Tri-state AI-overview preference (auto/show/hide).
        if (hasOwn(req.body, 'ai_overview_pref')) {
            const p = String(req.body.ai_overview_pref || 'auto').trim();
            if (['auto', 'show', 'hide'].includes(p)) db.updateChannel(channel.user_id, { ai_overview_pref: p });
        }

        const updated = db.getChannelByUsername(req.params.username);
        // getChannelByUsername joins users and selects u.stream_key. This endpoint is reachable by
        // a channel's moderators (that is what edited_by_mod reports), so returning the row as-is
        // handed every mod the streamer's broadcast key — enough to publish to their channel. The
        // rest of this file already redacts it the same way before sending a channel or stream.
        if (updated) { delete updated.stream_key; delete updated.managed_stream_key; }
        res.json({ channel: updated, edited_by_mod: !isOwner });
    } catch (err) {
        console.error('[Channel] about update error:', err.message);
        res.status(500).json({ error: 'Failed to save About section' });
    }
});

// Upload an About-panel image → optimized WebP served from /data/offline.
// Lightweight (no paste feed / cooldowns) — just returns a URL.
router.post('/panel-image', requireAuth, offlineUpload.single('file'), async (req, res) => {
    const tmp = req.file?.path;
    try {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        const mime = (req.file.mimetype || '').toLowerCase();
        if (!/^image\//.test(mime)) { fs.unlink(tmp, () => {}); return res.status(400).json({ error: 'Image required' }); }
        const outName = `panel-${req.user.id}-${Date.now().toString(36)}.webp`;
        if (sharp) {
            await sharp(tmp).rotate().resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toFile(path.join(OFFLINE_DIR, outName));
        } else {
            fs.copyFileSync(tmp, path.join(OFFLINE_DIR, outName));
        }
        fs.unlink(tmp, () => {});
        res.json({ url: `/data/offline/${outName}` });
    } catch (err) {
        if (tmp) fs.unlink(tmp, () => {});
        res.status(500).json({ error: 'Image upload failed: ' + err.message });
    }
});

// Upload a donation-goal image OR video/gif. Videos/gifs → optimized muted looping
// WebM; images → WebP. Returns { url, type } for the dashboard to attach to a goal.
router.post('/goal-media', requireAuth, offlineUpload.single('file'), async (req, res) => {
    const tmp = req.file?.path;
    try {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        const mime = (req.file.mimetype || '').toLowerCase();
        const isPlainImage = /^image\/(png|jpe?g|webp|avif)$/.test(mime);
        const isVideoish = /^video\//.test(mime) || mime === 'image/gif';
        if (!isPlainImage && !isVideoish) { fs.unlink(tmp, () => {}); return res.status(400).json({ error: 'Unsupported file type' }); }
        const stamp = Date.now().toString(36);
        let outName, type;
        if (isVideoish) {
            outName = `goal-${req.user.id}-${stamp}.webm`;
            await transcodeOfflineWebm(tmp, path.join(OFFLINE_DIR, outName));
            type = 'video';
        } else {
            outName = `goal-${req.user.id}-${stamp}.webp`;
            if (sharp) {
                await sharp(tmp).rotate().resize({ width: 960, height: 960, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toFile(path.join(OFFLINE_DIR, outName));
            } else {
                fs.copyFileSync(tmp, path.join(OFFLINE_DIR, outName));
            }
            type = 'image';
        }
        fs.unlink(tmp, () => {});
        res.json({ url: `/data/offline/${outName}`, type });
    } catch (err) {
        if (tmp) fs.unlink(tmp, () => {});
        console.error('[GoalMedia] upload error:', err.message);
        res.status(500).json({ error: 'Failed to process goal media: ' + err.message });
    }
});

// Upload an offline-screen asset (image OR video/gif). Videos/gifs are transcoded
// to an optimized muted looping WebM served just for this channel. Images are
// re-encoded to WebP. Sets channels.offline_screen_url + type.
router.post('/channel/offline-screen', requireAuth, offlineUpload.single('file'), async (req, res) => {
    const tmp = req.file?.path;
    try {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        db.ensureChannel(req.user.id);
        const mime = (req.file.mimetype || '').toLowerCase();
        const isPlainImage = /^image\/(png|jpe?g|webp|avif)$/.test(mime);
        const isVideoish = /^video\//.test(mime) || mime === 'image/gif';
        if (!isPlainImage && !isVideoish) { fs.unlink(tmp, () => {}); return res.status(400).json({ error: 'Unsupported file type' }); }

        const stamp = Date.now().toString(36);
        let outName, type;
        if (isVideoish) {
            outName = `off-${req.user.id}-${stamp}.webm`;
            await transcodeOfflineWebm(tmp, path.join(OFFLINE_DIR, outName));
            type = 'video';
        } else {
            outName = `off-${req.user.id}-${stamp}.webp`;
            if (sharp) {
                await sharp(tmp).rotate().resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toFile(path.join(OFFLINE_DIR, outName));
            } else {
                fs.copyFileSync(tmp, path.join(OFFLINE_DIR, outName));
            }
            type = 'image';
        }
        fs.unlink(tmp, () => {});

        // Remove the previous asset (best-effort) to avoid orphans.
        try {
            const prev = db.getChannelByUserId(req.user.id)?.offline_screen_url;
            if (prev && prev.startsWith('/data/offline/')) fs.unlink(path.join(OFFLINE_DIR, path.basename(prev)), () => {});
        } catch { /* ignore */ }

        const url = `/data/offline/${outName}`;
        db.updateChannel(req.user.id, { offline_screen_url: url, offline_screen_type: type });
        res.json({ url, type });
    } catch (err) {
        if (tmp) fs.unlink(tmp, () => {});
        console.error('[OfflineScreen] upload error:', err.message);
        res.status(500).json({ error: 'Failed to process offline screen: ' + err.message });
    }
});

// ── Weather for Channel (privacy-preserving) ─────────────────
const weatherCache = new Map(); // key: zip, value: { data, ts }
const WEATHER_CACHE_TTL = 15 * 60 * 1000; // 15 min
const GEOCODE_CACHE = new Map();

async function geocodeZip(zip) {
    if (GEOCODE_CACHE.has(zip)) return GEOCODE_CACHE.get(zip);
    try {
        const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(zip)}&count=1&language=en&format=json`;
        const resp = await fetch(url);
        const json = await resp.json();
        if (json.results && json.results.length > 0) {
            const r = json.results[0];
            const result = { lat: r.latitude, lon: r.longitude, name: r.name, region: r.admin1 || '', country: r.country_code || '' };
            GEOCODE_CACHE.set(zip, result);
            return result;
        }
    } catch (e) { console.warn('[Weather] Geocode error:', e.message); }
    // Fallback: try US zip via zip-coordinates API
    try {
        const url = `https://api.zippopotam.us/us/${encodeURIComponent(zip)}`;
        const resp = await fetch(url);
        if (resp.ok) {
            const json = await resp.json();
            const place = json.places?.[0];
            if (place) {
                const result = { lat: parseFloat(place.latitude), lon: parseFloat(place.longitude), name: place['place name'], region: place['state abbreviation'] || '', country: 'US' };
                GEOCODE_CACHE.set(zip, result);
                return result;
            }
        }
    } catch (e) { /* silent fallback */ }
    return null;
}

async function fetchWeather(zip) {
    const now = Date.now();
    const cached = weatherCache.get(zip);
    if (cached && (now - cached.ts) < WEATHER_CACHE_TTL) return cached.data;

    const geo = await geocodeZip(zip);
    if (!geo) return null;

    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}`
            + `&hourly=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,cloud_cover,visibility,uv_index`
            + `&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset`
            + `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,is_day`
            + `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch`
            + `&timezone=auto&forecast_days=7`;
        const resp = await fetch(url);
        const data = await resp.json();
        const result = { ...data, location: { name: geo.name, region: geo.region, country: geo.country } };
        weatherCache.set(zip, { data: result, ts: now });
        return result;
    } catch (e) {
        console.warn('[Weather] Fetch error:', e.message);
        return null;
    }
}

router.get('/channel/:username/weather', async (req, res) => {
    try {
        const channel = db.getChannelByUsername(req.params.username);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        // Per-slot override: weather is configurable per managed stream slot, so a
        // viewer watching a specific slot gets that slot's weather. Falls back to
        // the channel default. `?managed=<id>` or `?stream=<liveSessionId>`.
        let wZip = channel.weather_zip, wDetail = channel.weather_detail, wShowLoc = channel.weather_show_location;
        try {
            let slot = null;
            const managedId = parseInt(req.query.managed, 10) || null;
            const streamId = parseInt(req.query.stream, 10) || null;
            if (managedId) slot = db.getManagedStreamById(managedId);
            else if (streamId) { const s = db.getStreamById(streamId); if (s && s.managed_stream_id) slot = db.getManagedStreamById(s.managed_stream_id); }
            if (slot && slot.user_id === channel.user_id && slot.weather_zip) {
                wZip = slot.weather_zip;
                wDetail = slot.weather_detail || wDetail;
                wShowLoc = slot.weather_show_location;
            }
        } catch { /* fall back to channel */ }

        if (!wZip || wDetail === 'off') {
            return res.json({ enabled: false });
        }

        const weather = await fetchWeather(wZip);
        if (!weather) return res.json({ enabled: false, error: 'Weather data unavailable' });

        const detail = wDetail || 'basic';

        // Shape response based on detail level — never expose zip code
        const response = { enabled: true, detail };
        // Include UTC offset so frontend can convert streamer-local times to viewer-local
        if (weather.utc_offset_seconds != null) response.utc_offset_seconds = weather.utc_offset_seconds;
        if (wShowLoc) {
            response.location = weather.location;
        }

        // Current conditions (always included if not 'off')
        if (weather.current) {
            response.current = {
                temperature: weather.current.temperature_2m,
                feels_like: weather.current.apparent_temperature,
                humidity: weather.current.relative_humidity_2m,
                weather_code: weather.current.weather_code,
                wind_speed: weather.current.wind_speed_10m,
                wind_direction: weather.current.wind_direction_10m,
                is_day: weather.current.is_day,
            };
        }

        // Hourly forecast — amount depends on detail level
        if (weather.hourly && detail !== 'basic') {
            // Open-Meteo times are naive in the location's timezone.
            // Convert server "now" to the location's local time for comparison.
            const utcOff = weather.utc_offset_seconds || 0;
            const nowUtcMs = Date.now();
            const locationNowMs = nowUtcMs + utcOff * 1000;
            const locationNow = new Date(locationNowMs);
            // Compare as naive strings (YYYY-MM-DDTHH:MM) since hourly times have no TZ
            const locationNowIso = locationNow.toISOString().slice(0, 16);

            const times = weather.hourly.time;
            const startIdx = times.findIndex(t => t >= locationNowIso);
            const hours = detail === 'hourly' ? 8 : 24; // hourly=8h, detailed=24h
            const end = Math.min(startIdx + hours, times.length);

            response.hourly = [];
            for (let i = Math.max(0, startIdx); i < end; i++) {
                const entry = { time: weather.hourly.time[i], temperature: weather.hourly.temperature_2m[i], feels_like: weather.hourly.apparent_temperature[i], weather_code: weather.hourly.weather_code[i], precipitation_probability: weather.hourly.precipitation_probability[i], wind_speed: weather.hourly.wind_speed_10m[i] };
                if (detail === 'detailed') {
                    entry.humidity = weather.hourly.relative_humidity_2m[i];
                    entry.precipitation = weather.hourly.precipitation[i];
                    entry.wind_gusts = weather.hourly.wind_gusts_10m[i];
                    entry.wind_direction = weather.hourly.wind_direction_10m[i];
                    entry.cloud_cover = weather.hourly.cloud_cover[i];
                    entry.visibility = weather.hourly.visibility[i];
                    entry.uv_index = weather.hourly.uv_index[i];
                }
                response.hourly.push(entry);
            }
        }

        // 7-day daily forecast — included for hourly and detailed levels
        if (weather.daily && detail !== 'basic') {
            const d = weather.daily;
            response.daily = [];
            for (let i = 0; i < (d.time || []).length; i++) {
                response.daily.push({
                    date: d.time[i],
                    temp_max: d.temperature_2m_max[i],
                    temp_min: d.temperature_2m_min[i],
                    weather_code: d.weather_code[i],
                    precipitation_sum: d.precipitation_sum[i],
                    precipitation_probability: d.precipitation_probability_max[i],
                    wind_speed_max: d.wind_speed_10m_max[i],
                    sunrise: d.sunrise[i],
                    sunset: d.sunset[i],
                });
            }
        }

        res.json(response);
    } catch (err) {
        console.error('[Weather] Route error:', err.message);
        res.status(500).json({ error: 'Failed to fetch weather' });
    }
});

// ── List Live Streams ────────────────────────────────────────
router.get('/', optionalAuth, (req, res) => {
    try {
        // Every open home tab polls this every 12 seconds and the response is the same for
        // everyone, so let the browser and the edge answer most of those hits. Kept well under
        // the poll period so a card can never look stale for a whole cycle.
        res.set('Cache-Control', 'public, max-age=5');
        const restreamManager = require('./restream-manager');
        const streams = db.getLiveStreams();
        const channelMap = db.getChannelsByUserIds(streams.map(s => s.user_id)); // one query, not N
        const enriched = streams.map(s => {
            const channel = channelMap[s.user_id] || null;
            // Per-slot external viewer counts (Kick/Twitch/YouTube + RS) for THIS stream slot
            const slotId = s.managed_stream_id || null;
            const ext = restreamManager.getExternalViewerCountsForUser(s.user_id, slotId);
            const rsVc = robotStreamerService.getRsViewerCount(s.user_id, slotId);
            const externalTotal = ext.total + rsVc;
            // getLiveStreams() selects s.* plus ms.stream_key, and this endpoint is public
            // (optionalAuth, no user required). Every sibling handler redacts the ingest keys
            // before responding; this one did not, so an anonymous GET returned the live ingest
            // key of every broadcasting channel — enough to take over their stream.
            // publicStream drops both ingest keys and the channel's home ZIP.
            return publicStream({
                ...s,
                channel: channel || null,
                external_viewer_count: externalTotal,
                total_viewer_count: (s.viewer_count || 0) + externalTotal,
            });
        });
        res.json({ streams: enriched });
    } catch (err) {
        console.error('[Streams] List error:', err.message);
        res.status(500).json({ error: 'Failed to list streams' });
    }
});

// ── List My Streams (all streams for current user) ───────────
router.get('/mine', requireAuth, (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '50'), 200);
        const streams = db.getStreamsByUserId(req.user.id, limit);
        res.json({ streams });
    } catch (err) {
        console.error('[Streams] My streams error:', err.message);
        res.status(500).json({ error: 'Failed to list streams' });
    }
});

// ── List Recently Ended Streams ──────────────────────────────
router.get('/recent', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '20'), 100);
        // Each stream's public VOD (id, thumbnail, duration) comes from OpenVibe.Media.
        const streams = await require('../media-proxy/lookups').attachPublicVods(db.getRecentStreams(limit));
        const enriched = streams.map(s => {
            const channel = db.getChannelByUserId(s.user_id);
            return publicStream({ ...s, channel: channel || null });
        });
        res.json({ streams: enriched });
    } catch (err) {
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Failed to list recent streams' });
    }
});

// ── Recently Online (grouped by user) ────────────────────────
router.get('/recently-online', async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
        const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
        const streamers = db.getRecentlyOnlineStreamers(limit, offset);
        const total = db.countRecentlyOnlineStreamers();
        // Parse the JSON aggregate column; sort managed streams by last_live_at desc
        for (const s of streamers) {
            try {
                const parsed = JSON.parse(s.managed_streams_json || '[]');
                // Sort by most recently live first; put null last
                s.managed_streams = parsed.sort((a, b) => {
                    if (!a.last_live_at && !b.last_live_at) return 0;
                    if (!a.last_live_at) return 1;
                    if (!b.last_live_at) return -1;
                    return a.last_live_at < b.last_live_at ? 1 : -1;
                });
            } catch { s.managed_streams = []; }
            delete s.managed_streams_json;
        }
        // VOD rows (and their thumbnails) live in OpenVibe.Media — the local SQL
        // can't join them, so batch-resolve the latest thumb per managed stream.
        try {
            const media = require('../media-client');
            const msIds = streamers.flatMap(s => (s.managed_streams || []).map(ms => ms.managed_stream_id)).filter(Boolean);
            if (msIds.length) {
                const out = await media.request('GET', '/vods/latest-thumbs', { query: { managed_stream_ids: msIds.join(',') }, timeoutMs: 5000 });
                const thumbs = out?.thumbs || {};
                for (const s of streamers) {
                    for (const ms of (s.managed_streams || [])) {
                        const t = thumbs[ms.managed_stream_id];
                        if (t && !ms.vod_thumbnail) ms.vod_thumbnail = media.publicUrl(t.thumbnail_url);
                    }
                }
            }
        } catch (err) {
            console.warn('[Streaming] recently-online thumb enrichment failed:', err.message);
        }
        // Each streamer's nearest active donation goal → progress bar on the card.
        try {
            const goals = db.getActiveGoalsForUsers(streamers.map(s => s.user_id).filter(Boolean));
            for (const s of streamers) {
                const g = goals[s.user_id];
                if (g) s.top_goal = { title: g.title, current: g.current_amount, target: g.target_amount };
            }
        } catch { /* best-effort */ }
        res.json({ streamers, total, limit, offset, hasMore: offset + streamers.length < total });
    } catch (err) {
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Failed to list recently online' });
    }
});

// ── Recent VODs ──────────────────────────────────────────────
router.get('/recent-vods', async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit || '12', 10), 1), 48);
        const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
        const media = require('../media-client');
        const r = await media.listVods({ limit, offset }).catch(() => null);
        const vods = r?.vods || (Array.isArray(r) ? r : []);
        for (const v of vods) {
            if (v && v.user_id != null && !v.username) {
                const u = db.getUserById(v.user_id);
                if (u) { v.username = u.username; v.display_name = u.display_name; v.avatar_url = u.avatar_url; }
            }
            if (v && v.id != null && (!v.ai_overview_short || !v.ai_overview)) {
                try {
                    const s = db.get('SELECT ai_overview_short, ai_overview FROM vod_ai_state WHERE vod_id = ?', [v.id]);
                    if (s && s.ai_overview_short && !v.ai_overview_short) v.ai_overview_short = s.ai_overview_short;
                    if (s && s.ai_overview && !v.ai_overview) v.ai_overview = s.ai_overview;
                } catch { /* */ }
            }
        }
        const total = r?.total ?? vods.length;
        res.json({ vods, total, limit, offset, hasMore: offset + vods.length < total });
    } catch (err) {
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Failed to list recent VODs' });
    }
});

/* ── Voice Channels (global, non-stream) ───────────────────── */

router.get('/voice-channels', optionalAuth, (req, res) => {
    try {
        res.set('Cache-Control', 'no-store'); // private calls differ per viewer; the list is pushed anyway
        res.json({ channels: callServer.listChannels(req.user || null) });
    } catch (err) {
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Failed to list voice channels' });
    }
});

router.get('/voice-channels/:channelId', optionalAuth, (req, res) => {
    try {
        const ch = callServer.getChannel(req.params.channelId, req.user || null);
        if (!ch) return res.status(404).json({ error: 'Channel not found' });
        res.json({ channel: ch });
    } catch (err) {
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Failed to get voice channel' });
    }
});

router.post('/voice-channels', requireAuth, (req, res) => {
    try {
        const { name, mode, maxParticipants } = req.body;
        const ch = callServer.createChannel({ name, mode, createdBy: req.user.id, maxParticipants });
        res.status(201).json({ channel: ch });
    } catch (err) {
        if (err.code === 'CHANNEL_LIMIT') return res.status(400).json({ error: err.message });
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Failed to create voice channel' });
    }
});

router.delete('/voice-channels/:channelId', requireAuth, (req, res) => {
    try {
        const ok = callServer.deleteChannel(req.params.channelId, req.user.id);
        if (!ok) return res.status(403).json({ error: 'Cannot delete this channel' });
        res.json({ deleted: true });
    } catch (err) {
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Failed to delete voice channel' });
    }
});

const _callUserRate = new Map(); // userId → [timestamps]
router.post('/voice-channels/call-user', requireAuth, (req, res) => {
    try {
        // Six calls a minute per account: a ring is a notification on someone else's screen.
        const now = Date.now();
        const recent = (_callUserRate.get(req.user.id) || []).filter((t) => now - t < 60000);
        if (recent.length >= 6) return res.status(429).json({ error: 'Slow down — try again in a minute' });
        recent.push(now); _callUserRate.set(req.user.id, recent);
        const targetUserId = Number(req.body?.user_id || 0);
        const targetUsername = String(req.body?.username || '').trim();

        let targetUser = null;
        if (targetUserId > 0) targetUser = db.getUserById(targetUserId);
        if (!targetUser && targetUsername) targetUser = db.getUserByUsername(targetUsername);
        if (!targetUser) return res.status(404).json({ error: 'User not found' });
        if (targetUser.id === req.user.id) return res.status(400).json({ error: 'You cannot call yourself' });
        try { const dm = require('../chat/dm'); if (dm.isBlockedEither && dm.isBlockedEither(req.user.id, targetUser.id)) return res.status(403).json({ error: 'You cannot call this user' }); } catch { /* */ }

        // Reuse caller's existing temp channel if present; otherwise create a private one — a
        // 1:1 call is not something the whole site should see listed and be able to walk into.
        const existing = (callServer.listChannels(req.user) || []).find(ch => !ch.permanent && !ch.streamId && ch.createdBy === req.user.id) || null;
        const channel = existing || callServer.createChannel({
            name: `${req.user.display_name || req.user.username}'s call`,
            mode: 'mic+cam',
            createdBy: req.user.id,
            maxParticipants: 8,
            isPrivate: true,
        });
        callServer.invite(channel.id, targetUser.id);

        const callerName = req.user.display_name || req.user.username || 'Someone';
        const payload = {
            type: 'vc-call-invite',
            channelId: channel.id,
            channelName: channel.name,
            fromUserId: req.user.id,
            fromUsername: req.user.username,
            fromDisplayName: callerName,
            fromAvatarUrl: req.user.avatar_url || null,
            createdAt: Date.now(),
        };

        // Real-time invite for online users via existing chat WS connections.
        chatServer.sendDm(targetUser.id, payload);

        // Persistent cross-site notification for offline users / later join.
        pushNotification({
            user_id: targetUser.id,
            type: 'VC_CALL_INVITE',
            title: `${callerName} is calling you`,
            message: `Join voice channel: ${channel.name}`,
            url: `${config.baseUrl}/?vcInvite=${encodeURIComponent(channel.id)}`,
            rich_content: {
                context: {
                    channel_id: channel.id,
                    channel_name: channel.name,
                    caller_username: req.user.username,
                },
            },
            ...actorInfo(req.user, callerName),
        });

        return res.json({ invited: true, reusedChannel: !!existing, channel });
    } catch (err) {
        if (err.code === 'CHANNEL_LIMIT') return res.status(400).json({ error: err.message });
        console.error('[Streaming]', err.message);
        return res.status(500).json({ error: 'Failed to call user' });
    }
});

router.post('/voice-channels/call-user/respond', requireAuth, (req, res) => {
    try {
        const callerUserId = Number(req.body?.caller_user_id || 0);
        const channelId = String(req.body?.channel_id || '').trim();
        const channelName = String(req.body?.channel_name || 'Voice Channel').trim() || 'Voice Channel';
        const status = String(req.body?.status || '').trim().toLowerCase();

        const allowed = new Set(['accepted', 'declined', 'busy', 'no-answer', 'canceled']);
        if (!callerUserId) return res.status(400).json({ error: 'caller_user_id is required' });
        if (!channelId) return res.status(400).json({ error: 'channel_id is required' });
        if (!allowed.has(status)) return res.status(400).json({ error: 'Invalid response status' });
        if (callerUserId === req.user.id) return res.status(400).json({ error: 'Invalid caller target' });
        // Only an invited user can answer, and only to the caller who owns that channel.
        const ch = callServer.getChannel(channelId, req.user);
        if (!ch || ch.createdBy !== callerUserId || !callServer.hasInvite(channelId, req.user.id)) return res.status(403).json({ error: 'No such invite' });

        const fromDisplayName = req.user.display_name || req.user.username || 'Someone';
        chatServer.sendDm(callerUserId, {
            type: 'vc-call-response',
            status,
            channelId,
            channelName,
            fromUserId: req.user.id,
            fromUsername: req.user.username,
            fromDisplayName,
            fromAvatarUrl: req.user.avatar_url || null,
            createdAt: Date.now(),
        });

        return res.json({ ok: true });
    } catch (err) {
        console.error('[Streaming]', err.message);
        return res.status(500).json({ error: 'Failed to send call response' });
    }
});

// ── Broadcast Settings ──────────────────────────────────────
router.get('/broadcast-settings', requireAuth, (req, res) => {
    try {
        const managedStreamId = req.query.managed_stream_id ? parseInt(req.query.managed_stream_id) : null;
        if (managedStreamId) {
            const settings = db.getManagedStreamBroadcastSettings(managedStreamId, req.user.id);
            return res.json({ settings, managed_stream_id: managedStreamId });
        }
        // Fallback: return defaults when no managed stream specified
        res.json({
            settings: {},
        });
    } catch (err) {
        console.error('[Streaming] broadcast-settings error:', err.message);
        res.status(500).json({ error: 'Failed to get broadcast settings' });
    }
});

router.put('/broadcast-settings', requireAuth, (req, res) => {
    try {
        const managedStreamId = req.body.managed_stream_id ? parseInt(req.body.managed_stream_id) : null;
        if (!managedStreamId) {
            return res.status(400).json({ error: 'managed_stream_id is required' });
        }
        const managed = db.getManagedStreamById(managedStreamId);
        if (!managed || managed.user_id !== req.user.id) {
            return res.status(403).json({ error: 'Not your managed stream' });
        }
        const settings = req.body.settings || {};
        db.updateManagedStreamBroadcastSettings(managedStreamId, req.user.id, settings);
        res.json({ settings, managed_stream_id: managedStreamId });
    } catch (err) {
        console.error('[Streaming] broadcast-settings save error:', err.message);
        res.status(500).json({ error: 'Failed to save broadcast settings' });
    }
});

// ── Channel Stream Resolution ────────────────────────────────
// Resolve a managed stream ref (slug or ID) to the currently live session for a channel.
// Used by the SPA to deep-link /@username/:managedStreamRef to the correct live stream.
router.get('/channel/:username/resolve/:ref', optionalAuth, (req, res) => {
    try {
        const username = req.params.username.replace(/^@/, '');
        const ref = req.params.ref;
        const channel = db.getChannelByUsername(username);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        // Resolve the ref to a managed stream
        const managed = db.getManagedStreamByIdOrSlug(channel.user_id, ref);
        if (!managed) return res.status(404).json({ error: 'Managed stream not found' });

        // Find a live session linked to this managed stream
        const liveStreams = db.getLiveStreamsByUserId(channel.user_id);
        const liveSession = liveStreams.find(s => s.managed_stream_id === managed.id);

        res.json({
            managed_stream: {
                id: managed.id,
                slug: managed.slug,
                title: managed.title,
                protocol: managed.protocol,
            },
            live_stream_id: liveSession?.id || null,
            is_live: !!liveSession,
        });
    } catch (err) {
        console.error('[Streaming] resolve error:', err.message);
        res.status(500).json({ error: 'Failed to resolve stream' });
    }
});

// ── Managed Stream CRUD ──────────────────────────────────────

// Get past stream sessions for a managed stream (workspace history panel)
router.get('/managed/:managedStreamId/history', requireAuth, async (req, res) => {
    const managedStreamId = parseInt(req.params.managedStreamId);
    if (!Number.isFinite(managedStreamId)) return res.status(400).json({ error: 'Invalid ID' });
    try {
        const sessions = db.getStreamHistoryByManagedStream(managedStreamId, req.user.id);
        // Each session's VOD comes from OpenVibe.Media; only asked when the slot has sessions of this user.
        const vods = sessions.length ? await require('../media-proxy/lookups').vodsForManagedStream(managedStreamId) : new Map();
        for (const s of sessions) {
            const v = vods.get(Number(s.id));
            s.vod_id = v ? v.id : null;
            s.vod_file_path = v ? (v.file_path || null) : null;
        }
        res.json({ sessions });
    } catch (err) {
        console.error('[ManagedStreams] History error:', err.message);
        res.status(500).json({ error: 'Could not load history' });
    }
});

// ── Get full managed stream profile (structured fields + broadcast settings blob) ──
// Returned to the workspace panel for a single round-trip load.
router.get('/managed/:managedStreamId/profile', requireAuth, async (req, res) => {
    const managedStreamId = parseInt(req.params.managedStreamId);
    if (!Number.isFinite(managedStreamId)) return res.status(400).json({ error: 'Invalid ID' });
    try {
        const ms = db.getManagedStreamById(managedStreamId);
        if (!ms) return res.status(404).json({ error: 'Managed stream not found' });
        if (ms.user_id !== req.user.id) return res.status(403).json({ error: 'Not your managed stream' });

        const broadcastSettings = db.getManagedStreamBroadcastSettings(managedStreamId, req.user.id);
        const { whipUrlBase, whipUrlSource, whipUrlWarning } = resolveWhipUrlBase(config, req);

        // Do NOT expose stream_key to the broader response — return it in a dedicated key
        // so the caller can display/copy it in the authenticated UI.
        const { stream_key: streamKey, ...msPublic } = ms;

        // Slot-level restream destinations
        const restreamDestinations = db.getRestreamDestinationsByManagedStream(managedStreamId);

        const rtmpHost = config.rtmp.host || (() => {
            try { return new URL(config.baseUrl).hostname; } catch { return req.hostname; }
        })();
        const rtmpUrl = `rtmp://${rtmpHost}:${config.rtmp.port}/live`;

        const body = {
            managed_stream: msPublic,
            stream_key: streamKey,
            broadcast_settings: broadcastSettings,
            whip_url_base: whipUrlBase,
            whip_url_source: whipUrlSource,
            whip_url_warning: whipUrlWarning,
            rtmp_url: rtmpUrl,
            restream_destinations: restreamDestinations,
        };
        // OpenRe ingests this slot: its RTMP server and key come from OpenRe (the key is only
        // ever shown by Regenerate). Slots on Live's own ingest get exactly the response above.
        if (openreAuthority.authorityOf(ms) === 'openre') {
            const subject = require('../auth/identity-sync').subjectOf(ms.user_id);
            Object.assign(body, { stream_key: null }, await openreAuthority.ingestFor(ms, subject).catch((err) => ({
                ingest_authority: 'openre', stream_key_managed_by: 'openre', rtmp_url: null, stream_key_hint: `OpenRe is unreachable (${err.message})`,
            })));
        }
        res.json(body);
    } catch (err) {
        console.error('[ManagedStreams] Profile error:', err.message);
        res.status(500).json({ error: 'Could not load profile' });
    }
});

// List own managed streams
// ── Setup progress: everything a streamer can set up, and what they have done ─────────────
// Drives the Go Live setup hub and the home page's "next up" button. Every check is wrapped so
// a missing table or column just reads as "not done" instead of breaking the hub.
router.get('/setup-progress', requireAuth, async (req, res) => {
    const uid = req.user.id;
    const safe = (fn, d) => { try { const v = fn(); return v == null ? d : v; } catch { return d; } };
    const slots = safe(() => db.getManagedStreamsByUserId(uid), []);
    const sessions = safe(() => db.get('SELECT COUNT(*) AS n FROM streams WHERE user_id = ?', [uid]).n, 0);
    const restreams = safe(() => db.getRestreamDestinationsByUserId(uid).length, 0);
    const rs = slots.some(sl => safe(() => { const r = db.getRobotStreamerIntegrationBySlot(uid, sl.id); return !!(r && (r.robot_id || r.stream_name)); }, false));
    const user = safe(() => db.getUserById(uid), {}) || {};
    const channel = safe(() => db.getChannelByUserId(uid), {}) || {};
    const emotes = safe(() => db.get('SELECT COUNT(*) AS n FROM emotes WHERE user_id = ?', [uid]).n, 0);
    const sounds = safe(() => db.get('SELECT COUNT(*) AS n FROM channel_sounds WHERE channel_owner_id = ?', [uid]).n, 0);
    const goals = safe(() => db.get('SELECT COUNT(*) AS n FROM donation_goals WHERE user_id = ? AND is_active = 1', [uid]).n, 0);
    const powerchat = safe(() => !!db.get('SELECT 1 FROM powerchat_connections WHERE user_id = ? LIMIT 1', [uid]), false);
    const followers = safe(() => db.getFollowerCount(uid), 0);
    let panels = 0; try { const p = channel.panels ? JSON.parse(channel.panels) : []; panels = Array.isArray(p) ? p.length : 0; } catch { panels = 0; }
    const offline = !!(channel.offline_screen_type && channel.offline_screen_type !== 'none');
    const methodSet = slots.some(sl => !!sl.streaming_method);
    // Second wave of tasks. Each one is a real feature with a real table behind it, so nothing on
    // the list can be permanently unreachable — a task that can never be ticked would park every
    // streamer below 100% forever.
    const mods = safe(() => channel.id ? db.get('SELECT COUNT(*) AS n FROM channel_moderators WHERE channel_id = ?', [channel.id]).n : 0, 0);
    const controls = safe(() => db.get('SELECT COUNT(*) AS n FROM control_configs WHERE user_id = ?', [uid]).n, 0);
    const aibot = safe(() => db.get('SELECT COUNT(*) AS n FROM channel_ai_bots WHERE channel_user_id = ?', [uid]).n, 0);
    // Pastes live in OpenVibe.Community: the person's own count, unlisted and private included.
    const pastes = await require('../media-proxy/lookups').countUserPastes(user && user.id ? user : null, { hidden: 'owner' });
    const requests = safe(() => !!db.get('SELECT 1 FROM media_request_settings WHERE user_id = ? LIMIT 1', [uid]), false);
    const modRules = safe(() => channel.id ? !!db.get('SELECT 1 FROM channel_moderation_settings WHERE channel_id = ? LIMIT 1', [channel.id]) : false, false);
    const tasks = [
        { id: 'slot', group: 'Stream', title: 'Create your stream slot', why: 'Your show gets its own key, settings, VODs and restreams.', done: slots.length > 0, count: slots.length },
        { id: 'method', group: 'Stream', title: 'Choose how you stream', why: 'Browser, OBS over RTMP, or OBS over WHIP.', done: methodSet },
        { id: 'restream', group: 'Stream', title: 'Mirror to another platform', why: 'Twitch, YouTube, Kick, RobotStreamer or any RTMP — all at once.', done: restreams > 0 || rs, count: restreams + (rs ? 1 : 0) },
        { id: 'golive', group: 'Stream', title: 'Go live for the first time', why: 'Nothing teaches like the first ten minutes.', done: sessions > 0, count: sessions },
        { id: 'profile', group: 'Look & feel', title: 'Avatar and bio', why: 'First thing people see on your channel and in chat.', done: !!(user.avatar_url && String(user.bio || '').trim()) },
        { id: 'offline', group: 'Look & feel', title: 'Offline screen', why: 'What visitors see when you are not live — image, video or your own HTML.', done: offline },
        { id: 'emote', group: 'Look & feel', title: 'Upload a custom emote', why: 'Your chat, your inside jokes. Animated works too.', done: emotes > 0, count: emotes },
        { id: 'sound', group: 'Look & feel', title: 'Add a sound command', why: 'Viewers type !boom and your stream plays it.', done: sounds > 0, count: sounds },
        { id: 'goal', group: 'Community & money', title: 'Set a donation goal', why: 'A visible target turns tips into a team effort.', done: goals > 0, count: goals },
        { id: 'powerchat', group: 'Community & money', title: 'Connect PowerChat for real tips', why: 'Card and crypto tips with on-stream alerts.', done: powerchat },
        { id: 'panels', group: 'Community & money', title: 'Fill in your About panels', why: 'Links, schedule, rules — the stuff under the player.', done: panels > 0, count: panels },
        { id: 'share', group: 'Grow', title: 'Get your first follower', why: 'Share your channel link; followers get pinged when you go live.', done: followers > 0, count: followers },
        // `go` is where the task lives when it has no guided journey of its own — the hub and the
        // home quest fall back to navigating there rather than silently doing nothing on click.
        { id: 'mods', group: 'Community & money', title: 'Add a moderator', why: 'Someone you trust watching chat while you stream.', done: mods > 0, count: mods, go: '/dashboard' },
        { id: 'requests', group: 'Community & money', title: 'Open media requests', why: 'Viewers spend OpenCoins to queue clips and tracks on your stream.', done: requests, go: '/dashboard' },
        { id: 'moderation', group: 'Community & money', title: 'Set your chat rules', why: 'Slow mode, followers-only and emote-only, tuned how you want them.', done: modRules, go: '/dashboard' },
        { id: 'controls', group: 'Build & mod', title: 'Build viewer controls', why: 'Let chat drive a robot, trigger hardware or press your buttons.', done: controls > 0, count: controls, go: '/dashboard' },
        { id: 'aibot', group: 'Build & mod', title: 'Add an AI chat regular', why: 'Keeps an empty chat warm and answers the usual questions.', done: aibot > 0, count: aibot, go: '/dashboard' },
        { id: 'paste', group: 'Build & mod', title: 'Publish a paste', why: 'Share code, configs or notes from your stream — they get their own page.', done: pastes > 0, count: pastes, go: '/pastes' },
    ];
    const done = tasks.filter(t => t.done).length;
    const next = tasks.find(t => !t.done) || null;
    res.set('Cache-Control', 'private, no-store');
    res.json({ tasks, done, total: tasks.length, next, username: user.username });
});

router.get('/managed', requireAuth, (req, res) => {
    try {
        const managed = db.getManagedStreamsByUserId(req.user.id);
        const limit = db.getManagedStreamLimit(req.user);
        res.json({ managed_streams: managed.map(openreAuthority.serializeSlot), limit });
    } catch (err) {
        console.error('[ManagedStreams] List error:', err.message);
        res.status(500).json({ error: 'Failed to list managed streams' });
    }
});

// Create a managed stream
router.post('/managed', requireAuth, (req, res) => {
    try {
        const limit = db.getManagedStreamLimit(req.user);
        const count = db.countManagedStreamsByUser(req.user.id);
        if (count >= limit) {
            return res.status(403).json({ error: `Managed stream limit reached (${limit})` });
        }

        const title = cleanText(req.body.title, { maxLength: MAX_TITLE_LENGTH }) || 'Untitled Stream';
        const description = cleanText(req.body.description, { maxLength: MAX_DESCRIPTION_LENGTH, allowEmpty: true }) || '';
        const category = cleanText(req.body.category, { maxLength: MAX_CATEGORY_LENGTH }) || null;   // empty = let the AI infer it from the stream
        const protocol = cleanProtocol(req.body.protocol) || 'webrtc';
        const is_nsfw = cleanBooleanFlag(req.body.is_nsfw);
        let slug = req.body.slug ? req.body.slug.trim().toLowerCase() : null;

        if (slug) {
            if (!db.isValidManagedStreamSlug(slug)) {
                return res.status(400).json({ error: 'Invalid slug. Must be 2-32 chars, start with a letter, alphanumeric/hyphens/underscores only, not purely numeric.' });
            }
            if (db.isManagedStreamSlugTaken(req.user.id, slug)) {
                return res.status(409).json({ error: 'Slug already in use for your account' });
            }
        }

        const channel = db.ensureChannel(req.user.id);

        // Generate unique stream key for this managed stream
        const crypto = require('crypto');
        const stream_key = crypto.randomBytes(20).toString('hex');

        const result = db.createManagedStream({
            user_id: req.user.id,
            channel_id: channel.id,
            slug,
            title,
            description,
            category,
            protocol,
            streaming_method: cleanText(req.body.streaming_method, { maxLength: 20 }) || null,
            stream_key,
            is_nsfw,
            // Someone else's profile would copy their buttons onto this slot and keep it in sync.
            control_config_id: ownControlConfigId(req, req.body.control_config_id) || null,
        });

        const managedStream = db.getManagedStreamById(result.lastInsertRowid);
        res.status(201).json({ managed_stream: managedStream });
    } catch (err) {
        console.error('[ManagedStreams] Create error:', err.message);
        res.status(500).json({ error: 'Failed to create managed stream' });
    }
});

// Update a managed stream
router.put('/managed/:id', requireAuth, (req, res) => {
    try {
        const msId = parseInt(req.params.id);
        const ms = db.getManagedStreamById(msId);
        if (!ms) return res.status(404).json({ error: 'Managed stream not found' });
        if (ms.user_id !== req.user.id && !staffMayModerate(req.user, ms.user_id)) {
            return res.status(403).json({ error: 'Not your managed stream' });
        }

        const fields = {};
        if (hasOwn(req.body, 'title')) {
            fields.title = cleanText(req.body.title, { maxLength: MAX_TITLE_LENGTH });
            if (fields.title === null) return res.status(400).json({ error: 'Invalid title' });
        }
        if (hasOwn(req.body, 'description')) {
            fields.description = cleanText(req.body.description, { maxLength: MAX_DESCRIPTION_LENGTH, allowEmpty: true });
            if (fields.description === null) return res.status(400).json({ error: 'Invalid description' });
        }
        if (hasOwn(req.body, 'category')) {
            fields.category = cleanText(req.body.category, { maxLength: MAX_CATEGORY_LENGTH });
            if (fields.category === null) return res.status(400).json({ error: 'Invalid category' });
        }
        if (hasOwn(req.body, 'protocol')) {
            fields.protocol = cleanProtocol(req.body.protocol);
            if (fields.protocol === null) return res.status(400).json({ error: 'Invalid protocol' });
        }
        if (hasOwn(req.body, 'is_nsfw')) {
            fields.is_nsfw = cleanBooleanFlag(req.body.is_nsfw) ? 1 : 0;
        }
        if (hasOwn(req.body, 'tags')) {
            fields.tags = cleanTags(req.body.tags);
            if (fields.tags === null) return res.status(400).json({ error: 'Invalid tags' });
        }
        if (hasOwn(req.body, 'control_config_id')) {
            const cfgId = ownControlConfigId(req, req.body.control_config_id);
            if (cfgId === undefined) return res.status(403).json({ error: 'Not your control profile' });
            fields.control_config_id = cfgId;
        }
        if (hasOwn(req.body, 'pip_source_msid')) {
            // null / '' clears the overlay. Anything else must be one of this user's own
            // slots and must not be this slot, which would ask the player to render a
            // stream inside itself.
            const raw = req.body.pip_source_msid;
            if (raw === null || raw === '' || raw === undefined) {
                fields.pip_source_msid = null;
            } else {
                const srcId = parseInt(raw, 10);
                if (!Number.isFinite(srcId)) return res.status(400).json({ error: 'Invalid pip_source_msid' });
                if (srcId === msId) return res.status(400).json({ error: 'A slot cannot be its own picture-in-picture camera' });
                const src = db.getManagedStreamById(srcId);
                if (!src) return res.status(404).json({ error: 'Picture-in-picture slot not found' });
                if (src.user_id !== ms.user_id) return res.status(403).json({ error: 'That slot belongs to someone else' });
                fields.pip_source_msid = srcId;
            }
        }
        if (hasOwn(req.body, 'pip_defaults')) {
            const d = req.body.pip_defaults || {};
            const num = (v, lo, hi, dflt) => {
                const n = Number(v);
                return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
            };
            // Fractions of the player box, so the overlay lands in the same relative
            // place regardless of the viewer's window size.
            fields.pip_defaults = JSON.stringify({
                x: num(d.x, 0, 1, 0.72), y: num(d.y, 0, 1, 0.70), w: num(d.w, 0.08, 0.6, 0.25),
            });
        }
        if (hasOwn(req.body, 'sort_order')) {
            fields.sort_order = parseInt(req.body.sort_order) || 0;
        }
        if (hasOwn(req.body, 'slug')) {
            const slug = req.body.slug ? req.body.slug.trim().toLowerCase() : null;
            if (slug) {
                if (!db.isValidManagedStreamSlug(slug)) {
                    return res.status(400).json({ error: 'Invalid slug format' });
                }
                if (db.isManagedStreamSlugTaken(req.user.id, slug, msId)) {
                    return res.status(409).json({ error: 'Slug already in use' });
                }
            }
            fields.slug = slug;
        }

        // Slot-level settings
        if (hasOwn(req.body, 'streaming_method')) {
            const validMethods = new Set(['browser', 'whip', 'cli', 'rtmp']);
            const method = String(req.body.streaming_method || '').trim().toLowerCase();
            if (!validMethods.has(method)) return res.status(400).json({ error: 'Invalid streaming_method' });
            fields.streaming_method = method;
            // Auto-derive protocol from method
            if (method === 'browser' || method === 'whip') fields.protocol = 'webrtc';
            else if (method === 'cli') fields.protocol = 'jsmpeg';
            else if (method === 'rtmp') fields.protocol = 'rtmp';
        }
        if (hasOwn(req.body, 'browser_mode')) {
            const validModes = new Set(['camera', 'camera_only', 'mic_only', 'screen']);
            const mode = String(req.body.browser_mode || '').trim().toLowerCase();
            if (!validModes.has(mode)) return res.status(400).json({ error: 'Invalid browser_mode' });
            fields.browser_mode = mode;
        }
        if (hasOwn(req.body, 'default_vod_visibility')) {
            const vis = String(req.body.default_vod_visibility || 'public').trim().toLowerCase();
            fields.default_vod_visibility = ['unlisted', 'private'].includes(vis) ? vis : 'public';
        }
        if (hasOwn(req.body, 'default_clip_visibility')) {
            const vis = String(req.body.default_clip_visibility || 'public').trim().toLowerCase();
            fields.default_clip_visibility = ['unlisted', 'private'].includes(vis) ? vis : 'public';
        }
        if (hasOwn(req.body, 'slot_vod_recording_enabled')) {
            fields.slot_vod_recording_enabled = cleanBooleanFlag(req.body.slot_vod_recording_enabled) ? 1 : 0;
        }
        if (hasOwn(req.body, 'slot_clip_recording_enabled')) {
            fields.slot_clip_recording_enabled = cleanBooleanFlag(req.body.slot_clip_recording_enabled) ? 1 : 0;
        }
        if (hasOwn(req.body, 'slot_clip_notify_enabled')) {
            fields.slot_clip_notify_enabled = cleanBooleanFlag(req.body.slot_clip_notify_enabled) ? 1 : 0;
        }
        if (hasOwn(req.body, 'slot_powerchat_relay')) {
            fields.slot_powerchat_relay = cleanBooleanFlag(req.body.slot_powerchat_relay) ? 1 : 0;
        }
        if (hasOwn(req.body, 'slot_powerchat_count_rs_views')) {
            fields.slot_powerchat_count_rs_views = cleanBooleanFlag(req.body.slot_powerchat_count_rs_views) ? 1 : 0;
        }
        if (hasOwn(req.body, 'weather_zip')) {
            fields.weather_zip = req.body.weather_zip ? String(req.body.weather_zip).trim().slice(0, 20) : null;
        }
        if (hasOwn(req.body, 'weather_detail')) {
            const detail = String(req.body.weather_detail || 'basic').trim().toLowerCase();
            fields.weather_detail = ['basic', 'detailed', 'off'].includes(detail) ? detail : 'basic';
        }
        if (hasOwn(req.body, 'weather_show_location')) {
            fields.weather_show_location = cleanBooleanFlag(req.body.weather_show_location) ? 1 : 0;
        }
        if (hasOwn(req.body, 'mic_only_image')) {
            fields.mic_only_image = req.body.mic_only_image ? String(req.body.mic_only_image).trim().slice(0, 500) : null;
        }

        db.updateManagedStream(msId, ms.user_id, fields);
        const updated = db.getManagedStreamById(msId);

        // If the title changed and this slot has a RobotStreamer integration, mirror the
        // new title to the RS robot name (best-effort, non-blocking).
        if (hasOwn(req.body, 'title') && fields.title) {
            try {
                const rsIntegration = db.getRobotStreamerIntegrationForStream(ms.user_id, msId);
                if (rsIntegration?.token && rsIntegration?.robot_id) {
                    require('../integrations/robotstreamer-service').syncRobotName(rsIntegration, fields.title)
                        .catch(() => {});
                }
            } catch { /* non-critical */ }
        }

        res.json({ managed_stream: updated });
    } catch (err) {
        console.error('[ManagedStreams] Update error:', err.message);
        res.status(500).json({ error: 'Failed to update managed stream' });
    }
});

// Delete a managed stream
router.delete('/managed/:id', requireAuth, (req, res) => {
    try {
        const msId = parseInt(req.params.id);
        const ms = db.getManagedStreamById(msId);
        if (!ms) return res.status(404).json({ error: 'Managed stream not found' });
        if (ms.user_id !== req.user.id && !staffMayModerate(req.user, ms.user_id)) {
            return res.status(403).json({ error: 'Not your managed stream' });
        }

        // Prevent deleting a managed stream that has an active live session
        const liveSessions = db.getLiveStreamsByUserId(ms.user_id) || [];
        const isLive = liveSessions.some(s => s.managed_stream_id === msId);
        if (isLive) {
            return res.status(409).json({ error: 'Cannot delete a managed stream that is currently live. End the stream first.' });
        }

        db.deleteManagedStream(msId, ms.user_id);
        res.json({ message: 'Managed stream deleted' });
    } catch (err) {
        console.error('[ManagedStreams] Delete error:', err.message);
        res.status(500).json({ error: 'Failed to delete managed stream' });
    }
});

// Regenerate stream key for a managed stream
router.post('/managed/:id/regenerate-key', requireAuth, async (req, res) => {
    try {
        const msId = parseInt(req.params.id);
        const ms = db.getManagedStreamById(msId);
        if (!ms) return res.status(404).json({ error: 'Managed stream not found' });
        if (ms.user_id !== req.user.id) {
            return res.status(403).json({ error: 'Not your managed stream' });
        }

        // OpenRe ingests this slot: OpenRe rotates its key (the old one stops working at once) and
        // the new one is shown here, once.
        if (openreAuthority.authorityOf(ms) === 'openre') {
            try {
                const subject = require('../auth/identity-sync').subjectOf(ms.user_id);
                return res.json(await openreAuthority.rotateFor(ms, subject));
            } catch (err) {
                return res.status(502).json({ error: `Could not rotate the key on OpenRe: ${err.message}` });
            }
        }

        const crypto = require('crypto');
        const newKey = crypto.randomBytes(20).toString('hex');
        db.run('UPDATE managed_streams SET stream_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [newKey, msId]);
        res.json({ stream_key: newKey });
    } catch (err) {
        console.error('[ManagedStreams] Regenerate key error:', err.message);
        res.status(500).json({ error: 'Failed to regenerate key' });
    }
});

// ── Get Stream Details ───────────────────────────────────────
router.get('/:id', optionalAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });

        // Read the key before redacting it: the JSMPEG relay channel is addressed by the slot key,
        // and deleting it first sent slot-keyed JSMPEG streams to the account-key channel.
        const jsmpegKey = stream.managed_stream_key || db.getUserById(stream.user_id)?.stream_key;
        delete stream.stream_key;
        delete stream.managed_stream_key;

        if (stream.is_live) {
            if (stream.protocol === 'jsmpeg') {
                stream.endpoint = jsmpegRelay.getChannelInfo(jsmpegKey);
            } else if (stream.protocol === 'webrtc') {
                stream.endpoint = { roomId: `stream-${stream.id}` };
            } else if (stream.protocol === 'rtmp') {
                stream.endpoint = {
                    flvUrl: `/api/streams/rtmp-proxy/${stream.id}.flv`,
                };
            }
        }

        stream.cameras = db.all('SELECT * FROM cameras WHERE stream_id = ?', [stream.id]);
        stream.controls = db.getStreamControls(stream.id);
        stream.channel = publicChannel(db.getChannelByUserId(stream.user_id)) || null;

        // Picture-in-picture camera overlay: another SLOT of this owner's whose live
        // stream should be drawn on top of this one. It is a normal stream in its own
        // right (own VOD, clips, transcript, restreams) — the player only needs to know
        // which live stream to put in the overlay and where to start it. Null whenever
        // nothing is configured or the camera slot is not currently live, so the player
        // simply renders no overlay.
        stream.pip_overlay = stream.managed_stream_id
            ? db.getPipOverlayForManagedStream(stream.managed_stream_id)
            : null;

        if (req.user) stream.isFollowing = db.isFollowing(req.user.id, stream.user_id);
        stream.follower_count = db.getFollowerCount(stream.user_id);

        res.json({ stream });
    } catch (err) {
        console.error('[Streams] Get error:', err.message);
        res.status(500).json({ error: 'Failed to get stream' });
    }
});

// ── Start a New Stream (Go Live) ─────────────────────────────
router.post('/', requireAuth, (req, res) => {
    try {
        const managedStreamId = req.body.managed_stream_id ? parseInt(req.body.managed_stream_id) : null;

        // Look up managed stream — no auto-creation
        let managedStream = null;
        if (managedStreamId) {
            managedStream = db.getManagedStreamById(managedStreamId);
            if (!managedStream) return res.status(404).json({ error: 'Managed stream not found' });
            if (managedStream.user_id !== req.user.id) {
                return res.status(403).json({ error: 'Not your managed stream' });
            }
        } else {
            // Auto-select first managed stream (but never auto-create)
            const existing = db.getManagedStreamsByUserId(req.user.id);
            if (existing.length > 0) {
                managedStream = existing[0];
            } else {
                return res.status(400).json({ error: 'Create a stream slot first' });
            }
        }

        const title = cleanText(req.body.title, { maxLength: MAX_TITLE_LENGTH });
        const description = cleanText(req.body.description, { maxLength: MAX_DESCRIPTION_LENGTH, allowEmpty: true });
        const category = cleanText(req.body.category, { maxLength: MAX_CATEGORY_LENGTH });
        const protocol = cleanProtocol(req.body.protocol);
        const tags = cleanTags(req.body.tags);
        const callMode = cleanCallMode(req.body.call_mode);

        if ((hasOwn(req.body, 'title') && title === null)
            || (hasOwn(req.body, 'description') && description === null)
            || (hasOwn(req.body, 'category') && category === null)
            || (hasOwn(req.body, 'protocol') && protocol === null)
            || (hasOwn(req.body, 'tags') && tags === null)
            || (hasOwn(req.body, 'call_mode') && callMode === null)) {
            return res.status(400).json({ error: 'Invalid stream settings' });
        }

        const channel = db.ensureChannel(req.user.id);

        // Streamer role promotion deferred — applied on first real feed ingest
        // (see whip-handler.js, webrtc-sfu producer, jsmpeg relay, rtmp handler)

        // Use managed stream's settings as defaults, allow per-session overrides
        const streamProtocol = protocol || cleanProtocol(managedStream.protocol) || cleanProtocol(channel.protocol) || 'webrtc';
        const streamCategory = category || cleanText(managedStream.category, { maxLength: MAX_CATEGORY_LENGTH }) || cleanText(channel.category, { maxLength: MAX_CATEGORY_LENGTH }) || null;   // null → the AI classifies the stream from what it shows
        const requestedControlConfigId = req.body.control_config_id !== undefined ? (req.body.control_config_id === null ? null : parseInt(req.body.control_config_id)) : undefined;

        if (requestedControlConfigId !== undefined && requestedControlConfigId !== null) {
            const config = db.getControlConfig(requestedControlConfigId);
            if (!config) {
                return res.status(404).json({ error: 'Control config not found' });
            }
            if (config.user_id !== req.user.id) {
                return res.status(403).json({ error: 'Not authorized for this control profile' });
            }
        }

        // Effective config: explicit non-null override > managed stream's saved default > null
        // Note: null sent by client means "no explicit choice" (async select not yet populated),
        // so fall back to the managed stream's configured profile rather than stripping controls.
        const effectiveConfigId = (requestedControlConfigId != null)
            ? requestedControlConfigId
            : (managedStream.control_config_id || null);

        const result = db.createStream({
            user_id: req.user.id,
            channel_id: channel.id,
            managed_stream_id: managedStream.id,
            control_config_id: effectiveConfigId,
            title: title || cleanText(managedStream.title, { maxLength: MAX_TITLE_LENGTH }) || `${req.user.display_name}'s Stream`,
            description: description ?? cleanText(managedStream.description, { maxLength: MAX_DESCRIPTION_LENGTH, allowEmpty: true }) ?? '',
            category: streamCategory,
            protocol: streamProtocol,
            is_nsfw: channel.force_nsfw ? 1 : (hasOwn(req.body, 'is_nsfw') ? cleanBooleanFlag(req.body.is_nsfw) : !!channel.is_nsfw),
        });

        const streamId = result.lastInsertRowid;

        // Initialize heartbeat
        db.run('UPDATE streams SET last_heartbeat = CURRENT_TIMESTAMP WHERE id = ?', [streamId]);

        if (tags && tags.length > 0) {
            db.run('UPDATE streams SET tags = ? WHERE id = ?', [JSON.stringify(tags), streamId]);
        }

        // Set call mode if provided — create a stream voice channel
        if (callMode) {
            db.run('UPDATE streams SET call_mode = ? WHERE id = ?', [callMode, streamId]);
            callServer.createStreamChannel(streamId, callMode, req.user.id);
        }

        let endpoint = {};
        if (streamProtocol === 'jsmpeg') {
            endpoint = jsmpegRelay.createChannel(managedStream.stream_key);
        } else if (streamProtocol === 'webrtc') {
            endpoint = { roomId: `stream-${streamId}` };
        }

        db.run(
            `INSERT INTO cameras (stream_id, camera_index, label, protocol) VALUES (?, 0, 'Main', ?)`,
            [streamId, streamProtocol]
        );

        // Apply the control config to populate stream_controls for viewers.
        if (effectiveConfigId !== null) {
            try {
                const applied = db.applyConfigToStream(effectiveConfigId, streamId);
                console.log(`[Streams] Applied control config ${effectiveConfigId} to stream ${streamId} (${applied} buttons)`);
            } catch (cfgErr) {
                console.warn(`[Streams] Failed to apply control config:`, cfgErr.message);
            }
        } else if (channel.active_control_config_id) {
            // No slot-level config at all: fall back to channel default
            try {
                const applied = db.applyConfigToStream(channel.active_control_config_id, streamId);
                console.log(`[Streams] Auto-applied channel default control config ${channel.active_control_config_id} to stream ${streamId} (${applied} buttons)`);
            } catch (cfgErr) {
                console.warn(`[Streams] Failed to auto-apply channel default control config:`, cfgErr.message);
            }
        }

        const stream = db.getStreamById(streamId);
        robotStreamerService.startForStream(stream).catch((rsErr) => {
            console.warn(`[RS] Failed to start integration for stream ${streamId}:`, rsErr.message);
        });
        chatRelayService.startForStream(stream).catch((relayErr) => {
            console.warn(`[ChatRelay] Failed to start relay for stream ${streamId}:`, relayErr.message);
        });
        try { require('../integrations/ai-chatbot-service').startForStream(stream); } catch (aiErr) { console.warn('[AI-Bots] start failed:', aiErr.message); }

        // Notify followers that this streamer went live (fire-and-forget)
        notifyFollowersGoLive(req.user, stream);
        // Cross-site on-screen "went live" notification (rate-limited per slot/hour).
        try { require('./live-events').announceGoLive(stream, req.user); } catch { /* */ }

        res.status(201).json({ stream, endpoint });
    } catch (err) {
        console.error('[Streams] Create error:', err.message);
        res.status(500).json({ error: 'Failed to create stream' });
    }
});

// ── Update Stream Info ───────────────────────────────────────
router.put('/:id', requireAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id && !staffMayModerate(req.user, stream.user_id)) {
            return res.status(403).json({ error: 'Not your stream' });
        }

        const title = cleanText(req.body.title, { maxLength: MAX_TITLE_LENGTH });
        const description = cleanText(req.body.description, { maxLength: MAX_DESCRIPTION_LENGTH, allowEmpty: true });
        const category = cleanText(req.body.category, { maxLength: MAX_CATEGORY_LENGTH });
        const tags = cleanTags(req.body.tags);

        if ((hasOwn(req.body, 'title') && title === null)
            || (hasOwn(req.body, 'description') && description === null)
            || (hasOwn(req.body, 'category') && category === null)
            || (hasOwn(req.body, 'tags') && tags === null)) {
            return res.status(400).json({ error: 'Invalid stream update' });
        }

        const updates = [];
        const params = [];

        if (title !== undefined) { updates.push('title = ?'); params.push(title); }
        if (description !== undefined) { updates.push('description = ?'); params.push(description); }
        if (category !== undefined) { updates.push('category = ?'); params.push(category); }
        if (hasOwn(req.body, 'is_nsfw')) {
            // Admin force_nsfw cannot be overridden by streamer
            const channel = db.getChannelByUserId(req.user.id);
            if (channel && channel.force_nsfw) {
                updates.push('is_nsfw = 1');
            } else {
                updates.push('is_nsfw = ?'); params.push(cleanBooleanFlag(req.body.is_nsfw) ? 1 : 0);
            }
        }
        if (tags !== undefined) { updates.push('tags = ?'); params.push(JSON.stringify(tags)); }

        if (updates.length > 0) {
            params.push(req.params.id);
            db.run(`UPDATE streams SET ${updates.join(', ')} WHERE id = ?`, params);
        }

        const updated = db.getStreamById(req.params.id);
        res.json({ stream: updated });
    } catch (err) {
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Failed to update stream' });
    }
});

// ── End a Stream ─────────────────────────────────────────────
router.delete('/:id', requireAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id && !staffMayModerate(req.user, stream.user_id)) {
            return res.status(403).json({ error: 'Not your stream' });
        }

        db.endStream(stream.id);

        // Stop server-side recording (RTMP is handled in rtmp-server.js, but JSMPEG needs it here)
        if (stream.protocol === 'jsmpeg') {
            recorder.stopRecording(stream.id);
        }

        // Auto-finalize VOD recording server-side (catches cases where client didn't finalize)
        recorder.finalizeStream(stream.id).catch(err => {
            console.warn(`[VOD] Auto-finalize on stream end failed for ${stream.id}:`, err.message);
        });

        const user = db.getUserById(stream.user_id);
        const endKey = stream.managed_stream_key || user.stream_key;
        if (stream.protocol === 'jsmpeg') {
            jsmpegRelay.destroyChannel(endKey);
        } else if (stream.protocol === 'webrtc') {
            webrtcSFU.closeRoom(`stream-${stream.id}`);
        }

        // End any active group call / remove stream voice channel
        callServer.removeStreamChannel(stream.id);

        robotStreamerService.stopForStream(stream.id);
        chatRelayService.stopForStream(stream.id);
        try { require('../integrations/ai-chatbot-service').stopForStream(stream.id); } catch { /* non-critical */ }

        // Close signaling room and notify viewers
        const broadcastServer = require('./broadcast-server');
        broadcastServer.endStream(stream.id);

        res.json({ message: 'Stream ended' });
    } catch (err) {
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Failed to end stream' });
    }
});

// ── Get Streaming Endpoint Info ──────────────────────────────
router.get('/:id/endpoint', requireAuth, async (req, res) => {
    try {
        const stream = db.getStreamById(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id) {
            return res.status(403).json({ error: 'Not your stream' });
        }

        const user = db.getUserById(stream.user_id);
        // Use managed stream key from the JOIN, else fallback to user key
        const msKey = stream.managed_stream_key || user.stream_key;
        let endpoint = {};

        const hostname = config.host === '0.0.0.0' ? req.hostname : config.host;

        if (stream.protocol === 'jsmpeg') {
            endpoint = jsmpegRelay.getChannelInfo(msKey) || jsmpegRelay.createChannel(msKey);

            // Start server-side VOD recording for JSMPEG (taps the relay WebSocket, zero delay to live)
            const recMode = db.resolveStreamRecordingMode(stream);
            if (stream.is_live && recMode !== 'none' && !recorder.isRecording(stream.id)) {
                recorder.startRecording(stream.id, 'jsmpeg', {
                    streamKey: msKey,
                    videoPort: endpoint.videoPort,
                }, { mode: recMode });
            }

            const jsmpegOrigin = new URL(config.jsmpeg.publicUrl || `http://${hostname}`);
            const videoUrl = new URL(`${msKey}/640/480/`, jsmpegOrigin);
            videoUrl.port = endpoint.videoPort;
            const urlHD = new URL(`${msKey}/1280/720/`, jsmpegOrigin);
            urlHD.port = endpoint.videoPort;
            const audioUrl = new URL(`${msKey}/`, jsmpegOrigin);
            audioUrl.port = endpoint.audioPort;
            const lowLatencyFlags = '-fflags nobuffer -flags low_delay -probesize 32 -analyzeduration 0 -muxdelay 0.001 -flush_packets 1';
            endpoint.ffmpegCommand = `ffmpeg ${lowLatencyFlags} -thread_queue_size 512 -f v4l2 -framerate 24 -i /dev/video0 -thread_queue_size 512 -f alsa -i default -f mpegts -codec:v mpeg1video -s 640x480 -b:v 350k -maxrate 350k -bufsize 700k -g 12 -bf 0 -codec:a mp2 -b:a 96k -ar 44100 -ac 1 ${videoUrl}`;
            endpoint.ffmpegVideoOnly = `ffmpeg ${lowLatencyFlags} -thread_queue_size 512 -f v4l2 -framerate 24 -i /dev/video0 -f mpegts -codec:v mpeg1video -s 640x480 -b:v 350k -maxrate 350k -bufsize 700k -g 12 -bf 0 ${videoUrl}`;
            endpoint.ffmpegScreen = `ffmpeg ${lowLatencyFlags} -thread_queue_size 512 -f x11grab -s 1920x1080 -r 20 -i :0.0 -thread_queue_size 512 -f pulse -i default -f mpegts -codec:v mpeg1video -s 640x480 -b:v 450k -maxrate 450k -bufsize 900k -g 10 -bf 0 -codec:a mp2 -b:a 96k -ar 44100 -ac 1 ${videoUrl}`;
            endpoint.ffmpegOBS = `ffmpeg ${lowLatencyFlags} -thread_queue_size 512 -f v4l2 -framerate 24 -i /dev/video2 -thread_queue_size 512 -f pulse -i default -f mpegts -codec:v mpeg1video -s 640x480 -b:v 450k -maxrate 450k -bufsize 900k -g 12 -bf 0 -codec:a mp2 -b:a 96k -ar 44100 -ac 1 ${videoUrl}`;
            endpoint.ffmpegAudioOnly = `ffmpeg ${lowLatencyFlags} -thread_queue_size 512 -f alsa -i default -f mpegts -codec:a mp2 -b:a 96k -ar 44100 -ac 1 ${audioUrl}`;
            endpoint.ffmpegHD = `ffmpeg ${lowLatencyFlags} -thread_queue_size 512 -f v4l2 -video_size 1280x720 -framerate 30 -i /dev/video0 -thread_queue_size 512 -f alsa -i default -f mpegts -codec:v mpeg1video -s 1280x720 -b:v 1200k -maxrate 1200k -bufsize 2400k -r 30 -g 15 -bf 0 -codec:a mp2 -b:a 128k -ar 44100 -ac 2 ${urlHD}`;
        } else if (stream.protocol === 'webrtc') {
            const { whipUrlBase, whipUrlSource, whipUrlWarning } = resolveWhipUrlBase(config, req);
            endpoint = {
                roomId: `stream-${stream.id}`,
                signalingUrl: `/ws/broadcast?streamId=${stream.id}`,
                whipUrlBase,
                whipUrlSource,
                ...(whipUrlWarning ? { whipUrlWarning } : {}),
            };
        } else if (stream.protocol === 'rtmp' && openreAuthority.slotIsOpenre(stream.managed_stream_id)) {
            // OpenRe ingests this slot: its server URL, the hint of its key (never the key).
            const slot = openreAuthority.slotById(stream.managed_stream_id);
            const ingest = await openreAuthority.ingestFor(slot, require('../auth/identity-sync').subjectOf(slot.user_id)).catch(() => ({}));
            endpoint = {
                rtmpUrl: ingest.rtmp_url || null,
                streamKey: null,
                streamKeyHint: ingest.stream_key_hint || 'Press Regenerate to get your OpenRe stream key',
                keyManagedBy: 'openre',
                flvUrl: `/api/streams/rtmp-proxy/${stream.id}.flv`,
            };
            return res.json({ endpoint, stream_key: null });
        } else if (stream.protocol === 'rtmp') {
            const rtmpHost = config.rtmp.host || (() => {
                try { return new URL(config.baseUrl).hostname; } catch { return hostname; }
            })();
            // Standard port stays implicit → rtmp://ingest.openvibe.live/live
            const rtmpPortSuffix = config.rtmp.port === 1935 ? '' : `:${config.rtmp.port}`;
            endpoint = {
                rtmpUrl: `rtmp://${rtmpHost}${rtmpPortSuffix}/live`,
                streamKey: msKey,
                flvUrl: `/api/streams/rtmp-proxy/${stream.id}.flv`,
            };
        }

        res.json({ endpoint, stream_key: msKey });
    } catch (err) {
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Failed to get endpoint' });
    }
});

// ── Stream Heartbeat (fallback keepalive) ───────────────────────
// Most live streams are kept alive by actual ingest activity (RTMP session,
// active WHIP session, or connected WebRTC producer). This route is a
// fallback for cases where the browser must keep the stream record fresh
// while the ingest path is still coming online.

// ── Client diagnostic log ────────────────────────────────────
// Records browser-side errors that occur during stream creation so we can
// see them in server logs without needing access to the user's console.
router.post('/diag-log', optionalAuth, (req, res) => {
    const { stream_id, error_name, error_message, method, sub, browser_source, ua } = req.body || {};
    const user = req.user ? `user=${req.user.id}` : 'anon';
    console.warn(`[BroadcastDiag] ${user} stream=${stream_id} err="${error_name}: ${error_message}" method=${method}/${sub}/${browser_source} ua=${String(ua).slice(0, 80)}`);
    res.json({ ok: true });
});

router.post('/:id/heartbeat', requireAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id) {
            return res.status(403).json({ error: 'Not your stream' });
        }
        if (!stream.is_live) return res.status(400).json({ error: 'Stream is not live' });

        db.run('UPDATE streams SET last_heartbeat = CURRENT_TIMESTAMP WHERE id = ?', [stream.id]);
        res.json({ ok: true });
    } catch (err) {
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Heartbeat failed' });
    }
});

// ── RTMP Feed Status ─────────────────────────────────────────
router.get('/:id/rtmp-status', requireAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id && !staffMayModerate(req.user, stream.user_id)) {
            return res.status(403).json({ error: 'Not your stream' });
        }
        if (stream.protocol !== 'rtmp') {
            return res.status(400).json({ error: 'Not an RTMP stream' });
        }
        const mirrored = openreMirror.sessionForStream(stream.id);
        if (mirrored) {
            return res.json({ receiving: mirrored.state === 'live', connected_at: mirrored.started_at, managed_by: 'openre' });
        }
        const rtmpKey = stream.managed_stream_key || db.getUserById(stream.user_id)?.stream_key;
        const rtmpServer = require('./rtmp-server');
        const status = rtmpServer.getStatus(rtmpKey);
        res.json(status);
    } catch (err) {
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Failed to check RTMP status' });
    }
});

// ── Follow/Unfollow Streamer ─────────────────────────────────
router.post('/:id/follow', requireAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });

        if (db.isFollowing(req.user.id, stream.user_id)) {
            db.unfollowUser(req.user.id, stream.user_id);
            res.json({ following: false, count: db.getFollowerCount(stream.user_id) });
        } else {
            db.followUser(req.user.id, stream.user_id);
            // Award OpenCoins for following
            try {
                const openvibeCoins = require('../monetization/opencoins');
                openvibeCoins.awardFollow(req.user.id, stream.user_id);
            } catch { /* non-critical */ }
            // Fire a PowerChat follow alert for the streamer (follows:write).
            try {
                const follower = db.getUserById(req.user.id);
                require('../integrations/powerchat-platform').forwardFollow(stream.user_id, {
                    followerName: follower?.display_name || follower?.username || 'Someone',
                    externalId: 'u' + req.user.id,
                });
            } catch { /* non-critical */ }
            // Notify the followed user
            try {
                const { pushNotification, actorInfo } = require('../utils/notify');
                const follower = db.getUserById(req.user.id);
                pushNotification({
                    user_id: stream.user_id,
                    type: 'FOLLOW',
                    title: 'New Follower',
                    message: `${follower?.display_name || follower?.username || 'Someone'} followed you`,
                    url: follower?.username ? `${config.baseUrl}/@${encodeURIComponent(follower.username)}` : config.baseUrl,
                    ...actorInfo(follower),
                });
            } catch { /* non-critical */ }
            res.json({ following: true, count: db.getFollowerCount(stream.user_id) });
        }
    } catch (err) {
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Failed to follow/unfollow' });
    }
});

// ── Follow/Unfollow by Username ──────────────────────────────
router.post('/channel/:username/follow', requireAuth, (req, res) => {
    try {
        const user = db.getUserByUsername(req.params.username);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (db.isFollowing(req.user.id, user.id)) {
            db.unfollowUser(req.user.id, user.id);
            res.json({ following: false, count: db.getFollowerCount(user.id) });
        } else {
            db.followUser(req.user.id, user.id);
            // Award OpenCoins for following
            try {
                const openvibeCoins = require('../monetization/opencoins');
                openvibeCoins.awardFollow(req.user.id, user.id);
            } catch { /* non-critical */ }
            // Fire a PowerChat follow alert for the streamer (follows:write).
            try {
                const f = db.getUserById(req.user.id);
                require('../integrations/powerchat-platform').forwardFollow(user.id, {
                    followerName: f?.display_name || f?.username || 'Someone',
                    externalId: 'u' + req.user.id,
                });
            } catch { /* non-critical */ }
            // Notify the followed user
            try {
                const { pushNotification, actorInfo } = require('../utils/notify');
                const follower = db.getUserById(req.user.id);
                pushNotification({
                    user_id: user.id,
                    type: 'FOLLOW',
                    title: 'New Follower',
                    message: `${follower?.display_name || follower?.username || 'Someone'} followed you`,
                    url: follower?.username ? `${config.baseUrl}/@${encodeURIComponent(follower.username)}` : config.baseUrl,
                    ...actorInfo(follower),
                });
            } catch { /* non-critical */ }
            res.json({ following: true, count: db.getFollowerCount(user.id) });
        }
    } catch (err) {
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Failed to follow/unfollow' });
    }
});

// ── Group Call: Enable / Disable / Get Status ────────────────
const callServer = require('./call-server');

router.put('/:id/call', requireAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        if (stream.user_id !== req.user.id) {
            return res.status(403).json({ error: 'Not your stream' });
        }
        if (!stream.is_live) {
            return res.status(400).json({ error: 'Stream is not live' });
        }

        const { call_mode } = req.body;
        const validModes = ['mic', 'mic+cam', 'cam+mic', null];
        if (!validModes.includes(call_mode)) {
            return res.status(400).json({ error: 'Invalid call mode. Use: mic, mic+cam, cam+mic, or null to disable' });
        }

        db.run('UPDATE streams SET call_mode = ? WHERE id = ?', [call_mode, stream.id]);

        // Create or remove stream voice channel
        const channelId = `stream-${stream.id}`;
        if (call_mode) {
            callServer.createStreamChannel(stream.id, call_mode, stream.user_id);
        } else {
            callServer.removeStreamChannel(stream.id);
        }

        res.json({
            call_mode,
            channelId: call_mode ? channelId : null,
            participants: callServer.getParticipants(channelId),
            participant_count: callServer.getParticipantCount(channelId),
        });
    } catch (err) {
        console.error('[Streams] Call mode error:', err.message);
        res.status(500).json({ error: 'Failed to update call mode' });
    }
});

router.get('/:id/call', optionalAuth, (req, res) => {
    try {
        const stream = db.getStreamById(req.params.id);
        if (!stream) return res.status(404).json({ error: 'Stream not found' });
        const channelId = `stream-${stream.id}`;

        res.json({
            call_mode: stream.call_mode || null,
            channelId: stream.call_mode ? channelId : null,
            participants: callServer.getParticipants(channelId),
            participant_count: callServer.getParticipantCount(channelId),
        });
    } catch (err) {
        console.error('[Streaming]', err.message);
        res.status(500).json({ error: 'Failed to get call status' });
    }
});

// ── RTMP FLV Proxy ───────────────────────────────────────────
// Proxies HTTP-FLV from the internal NMS server so the browser fetches
// from the same HTTPS origin, avoiding CSP / mixed-content issues.
router.get('/rtmp-proxy/:streamId.flv', async (req, res) => {
    try {
        const stream = db.getStreamById(req.params.streamId);
        if (!stream || !stream.is_live || stream.protocol !== 'rtmp') {
            return res.status(404).end();
        }
        let url;
        const mirrored = openreMirror.sessionForStream(stream.id);
        if (mirrored) {
            // An OpenRe session: pull HTTP-FLV from the OpenRe worker that holds it, as named by
            // OpenRe's playback descriptor (a loopback URL on this host; no key in it).
            if (mirrored.state !== 'live') return res.status(404).end();
            const pb = await require('../openre/openre-client').playback(mirrored.session_id).catch(() => null);
            if (!pb || !pb.flv || !/^http:\/\/127\.0\.0\.1:\d+\/live\/ses_[0-9A-Z]+\.flv$/.test(pb.flv.internal_url)) return res.status(502).end();
            url = pb.flv.internal_url;
        } else {
            const flvKey = stream.managed_stream_key || db.getUserById(stream.user_id)?.stream_key;
            if (!flvKey) return res.status(404).end();
            const nmsPort = config.rtmp.port + 8000;
            url = `http://127.0.0.1:${nmsPort}/live/${flvKey}.flv`;
        }

        if (req.destroyed) return undefined; // the viewer left while OpenRe was asked
        const http = require('http');
        const upstream = http.get(url, (nmsRes) => {
            if (nmsRes.statusCode !== 200) {
                res.status(502).end();
                nmsRes.resume();
                return;
            }
            res.writeHead(200, {
                'Content-Type': 'video/x-flv',
                'Cache-Control': 'no-cache, no-store',
                'Transfer-Encoding': 'chunked',
                'Access-Control-Allow-Origin': '*',
            });
            nmsRes.pipe(res);
        });
        upstream.on('error', () => res.status(502).end());
        req.on('close', () => upstream.destroy());
    } catch (err) {
        console.error('[FLV Proxy]', err.message);
        if (!res.headersSent) res.status(500).end();
    }
});

module.exports = router;
