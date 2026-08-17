/**
 * OpenVibe.Live — Emote API Routes
 *
 * GET    /api/emotes/global          - Global custom emotes
 * GET    /api/emotes/channel/:userId - Channel emotes for a streamer
 * GET    /api/emotes/mine            - My emotes (auth required)
 * POST   /api/emotes                 - Upload a custom emote (auth required)
 * DELETE /api/emotes/:id             - Delete an emote (auth required)
 * GET    /api/emotes/file/:filename  - Serve emote image file
 * GET    /api/emotes/ffz             - Proxy + cache FrankerFaceZ global emotes
 * GET    /api/emotes/bttv            - Proxy + cache BetterTTV global emotes
 * GET    /api/emotes/search          - Search FFZ emotes by term
 * GET    /api/emotes/all/:streamId   - All emotes available in a stream context
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db/database');
const { requireAuth, optionalAuth } = require('../auth/auth');
const permissions = require('../auth/permissions');
const config = require('../config');

const router = express.Router();

// ── Emote file upload via multer ─────────────────────────────
const MIME_TO_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif' };
const emoteStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const emoteDir = path.resolve(config.emotes.path);
        if (!fs.existsSync(emoteDir)) fs.mkdirSync(emoteDir, { recursive: true });
        cb(null, emoteDir);
    },
    filename: (req, file, cb) => {
        const ext = MIME_TO_EXT[file.mimetype] || '.png';
        cb(null, `emote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
});
const emoteUpload = multer({
    storage: emoteStorage,
    limits: { fileSize: config.emotes.maxSizeKb * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/png', 'image/gif', 'image/webp', 'image/jpeg', 'image/avif'];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only PNG, GIF, WebP, AVIF, and JPEG images are allowed'));
        }
    },
});

// Per-user emote-upload rate limit (sliding window) so a single account can't mass-spam uploads
// across many channels. Keyed by user id, so it holds even across IPs. Filling one channel (30)
// in a session is fine; hundreds of rapid uploads are not.
const EMOTE_UPLOAD_WINDOW_MS = 15 * 60 * 1000;
const EMOTE_UPLOAD_MAX = 40;
const _emoteUploadTimes = new Map(); // userId → recent upload timestamps
function emoteUploadRateLimited(userId) {
    const now = Date.now();
    const arr = (_emoteUploadTimes.get(userId) || []).filter((t) => now - t < EMOTE_UPLOAD_WINDOW_MS);
    if (arr.length >= EMOTE_UPLOAD_MAX) { _emoteUploadTimes.set(userId, arr); return true; }
    arr.push(now);
    _emoteUploadTimes.set(userId, arr);
    return false;
}

// ══════════════════════════════════════════════════════════════
//  FFZ / BTTV CACHE
// ══════════════════════════════════════════════════════════════

let ffzCache = { data: null, ts: 0 };
let bttvCache = { data: null, ts: 0 };
let sevenTvCache = { data: null, ts: 0 };
let ffzSearchCache = new Map(); // query → { data, ts }

async function fetchJSON(url) {
    // Use native fetch (Node 18+)
    const res = await fetch(url, {
        headers: { 'User-Agent': 'OpenVibe.Live/1.0 (emote-proxy)' },
        signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

/**
 * Parse FFZ API response into a flat emote array
 */
function parseFfzSets(data) {
    const emotes = [];
    const sets = data.sets || {};
    for (const setId of Object.keys(sets)) {
        const set = sets[setId];
        for (const e of (set.emoticons || [])) {
            if (e.hidden) continue;
            if (e.modifier) continue;       // skip modifier effects
            emotes.push({
                id: `ffz-${e.id}`,
                code: e.name,
                url: e.urls['2'] || e.urls['1'] || `https://cdn.frankerfacez.com/emote/${e.id}/1`,
                url_1x: e.urls['1'] || `https://cdn.frankerfacez.com/emote/${e.id}/1`,
                url_2x: e.urls['2'] || e.urls['1'],
                url_4x: e.urls['4'] || e.urls['2'] || e.urls['1'],
                width: e.width || 28,
                height: e.height || 28,
                animated: false,
                source: 'ffz',
            });
        }
    }
    return emotes;
}

/**
 * Parse BTTV API response into a flat emote array
 */
function parseBttvEmotes(data) {
    return (Array.isArray(data) ? data : []).map(e => ({
        id: `bttv-${e.id}`,
        code: e.code,
        url: `https://cdn.betterttv.net/emote/${e.id}/2x`,
        url_1x: `https://cdn.betterttv.net/emote/${e.id}/1x`,
        url_2x: `https://cdn.betterttv.net/emote/${e.id}/2x`,
        url_4x: `https://cdn.betterttv.net/emote/${e.id}/3x`,
        width: 28,
        height: 28,
        animated: e.imageType === 'gif' || e.animated === true,
        source: 'bttv',
    }));
}

function parseBttvEmotes(data) {
    return (Array.isArray(data) ? data : []).map(e => ({
        id: `bttv-${e.id}`,
        code: e.code,
        url: `https://cdn.betterttv.net/emote/${e.id}/2x`,
        url_1x: `https://cdn.betterttv.net/emote/${e.id}/1x`,
        url_2x: `https://cdn.betterttv.net/emote/${e.id}/2x`,
        url_4x: `https://cdn.betterttv.net/emote/${e.id}/3x`,
        width: 28,
        height: 28,
        animated: e.imageType === 'gif' || e.animated === true,
        source: 'bttv',
    }));
}

/**
 * Parse 7TV global emote set into a flat emote array
 */
function parse7tvEmotes(data) {
    const emotes = data?.emotes || [];
    return emotes.map(e => {
        const host = e.data?.host;
        const baseUrl = host?.url || '';
        const files = host?.files || [];
        // Prefer 2x webp, fall back to 1x
        const f2x = files.find(f => f.name === '2x.webp') || files.find(f => f.name === '2x.avif') || files.find(f => f.name === '1x.webp') || files[0];
        const f1x = files.find(f => f.name === '1x.webp') || files.find(f => f.name === '1x.avif') || files[0];
        const f4x = files.find(f => f.name === '4x.webp') || files.find(f => f.name === '3x.webp') || f2x;
        const animated = !!(e.data?.animated);
        return {
            id: `7tv-${e.id}`,
            code: e.name,
            url: f2x ? `https:${baseUrl}/${f2x.name}` : '',
            url_1x: f1x ? `https:${baseUrl}/${f1x.name}` : '',
            url_2x: f2x ? `https:${baseUrl}/${f2x.name}` : '',
            url_4x: f4x ? `https:${baseUrl}/${f4x.name}` : '',
            width: f2x?.width || 28,
            height: f2x?.height || 28,
            animated,
            source: '7tv',
        };
    }).filter(e => e.url);
}

/**
 * Default emote collection — popular community emotes everyone recognizes.
 * These use FFZ / BTTV / 7TV CDN URLs for known emote IDs.
 */
const DEFAULT_EMOTES = [
    // FFZ classics
    { id: 'def-lul',       code: 'LUL',       url: 'https://cdn.frankerfacez.com/emote/38010/2',   source: 'defaults', animated: false },
    { id: 'def-lulw',      code: 'LULW',      url: 'https://cdn.frankerfacez.com/emote/139407/2',  source: 'defaults', animated: false },
    { id: 'def-kekw',      code: 'KEKW',      url: 'https://cdn.frankerfacez.com/emote/381875/2',  source: 'defaults', animated: false },
    { id: 'def-omegalul',  code: 'OMEGALUL',  url: 'https://cdn.frankerfacez.com/emote/128054/2',  source: 'defaults', animated: false },
    { id: 'def-pepehands', code: 'PepeHands', url: 'https://cdn.frankerfacez.com/emote/231552/2',  source: 'defaults', animated: false },
    { id: 'def-copium',    code: 'Copium',    url: 'https://cdn.frankerfacez.com/emote/540942/2',  source: 'defaults', animated: false },
    { id: 'def-monkas',    code: 'monkaS',    url: 'https://cdn.frankerfacez.com/emote/130762/2',  source: 'defaults', animated: false },
    { id: 'def-ez',        code: 'EZ',        url: 'https://cdn.frankerfacez.com/emote/425688/2',  source: 'defaults', animated: false },
    { id: 'def-pog',       code: 'Pog',       url: 'https://cdn.frankerfacez.com/emote/210748/2',  source: 'defaults', animated: false },
    { id: 'def-poggers',   code: 'Poggers',   url: 'https://cdn.frankerfacez.com/emote/214681/2',  source: 'defaults', animated: false },
    // BTTV classics
    { id: 'def-pogu',      code: 'PogU',      url: 'https://cdn.betterttv.net/emote/5e4e7a1f08b4447d56a92967/2x', source: 'defaults', animated: false },
    { id: 'def-peped',     code: 'PepeD',     url: 'https://cdn.betterttv.net/emote/5b1740221c5a6065a7bad4b5/2x', source: 'defaults', animated: true },
    { id: 'def-catjam',    code: 'catJAM',    url: 'https://cdn.betterttv.net/emote/5f1b0186cf6d2144653d2970/2x', source: 'defaults', animated: true },
    { id: 'def-sadge',     code: 'Sadge',     url: 'https://cdn.betterttv.net/emote/5e0fa9d40550d42106b8a489/2x', source: 'defaults', animated: false },
    { id: 'def-pepega',    code: 'Pepega',    url: 'https://cdn.betterttv.net/emote/5aca62163e290877a25481ad/2x', source: 'defaults', animated: false },
    { id: 'def-5head',     code: '5Head',     url: 'https://cdn.betterttv.net/emote/5d6096974932b21d9c332904/2x', source: 'defaults', animated: false },
    { id: 'def-widehard',  code: 'widepeepohappy', url: 'https://cdn.betterttv.net/emote/5e1a76dd8af14b5f1b438c04/2x', source: 'defaults', animated: false },
    { id: 'def-monkaw',    code: 'monkaW',    url: 'https://cdn.betterttv.net/emote/59ca6551b27c823d5b1fd872/2x', source: 'defaults', animated: false },
    { id: 'def-pepelaugh', code: 'PepeLaugh', url: 'https://cdn.betterttv.net/emote/5c548025009a2e73916b3a37/2x', source: 'defaults', animated: false },
    { id: 'def-modtime',   code: 'modCheck',  url: 'https://cdn.betterttv.net/emote/5d7eefb7c0652668c9e4d394/2x', source: 'defaults', animated: true },
    { id: 'def-clap',      code: 'CLAP',      url: 'https://cdn.betterttv.net/emote/55b6f480e66682f576dd94f5/2x', source: 'defaults', animated: false },
    { id: 'def-gg',        code: 'GGEZ',      url: 'https://cdn.frankerfacez.com/emote/703645/2',  source: 'defaults', animated: false },
    { id: 'def-based',     code: 'BASED',     url: 'https://cdn.frankerfacez.com/emote/768564/2',  source: 'defaults', animated: false },
    { id: 'def-peepo',     code: 'peepoHappy', url: 'https://cdn.betterttv.net/emote/5a16ee718c22a247ead62d4a/2x', source: 'defaults', animated: false },
    { id: 'def-mods',      code: 'MODS',      url: 'https://cdn.betterttv.net/emote/603451b77c74605395f3295d/2x', source: 'defaults', animated: true },
].map(e => ({ ...e, width: 28, height: 28 }));

// ══════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════

// ── Global custom emotes ─────────────────────────────────────
router.get('/global', (req, res) => {
    try {
        const emotes = db.getGlobalEmotes().map(e => ({
            id: `custom-${e.id}`,
            code: e.code,
            url: `/api/emotes/file/${path.basename(e.url)}`,
            animated: !!e.animated,
            width: e.width,
            height: e.height,
            source: 'custom',
            owner: e.username,
        }));
        res.json({ emotes });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load global emotes' });
    }
});

// ── Channel emotes ───────────────────────────────────────────
router.get('/channel/:userId', (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const emotes = db.getChannelEmotes(userId).map(e => ({
            id: `custom-${e.id}`,
            emote_id: e.id,
            code: e.code,
            url: `/api/emotes/file/${path.basename(e.url)}`,
            animated: !!e.animated,
            width: e.width,
            height: e.height,
            source: 'channel',
            owner: e.username,
            uploader: e.uploader_display_name || e.uploader_username || e.username,
            uploader_id: e.user_id,
        }));
        res.json({ emotes });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load channel emotes' });
    }
});

// ── My emotes (for dashboard management) ─────────────────────
router.get('/mine', requireAuth, (req, res) => {
    try {
        const emotes = db.getEmotesByUser(req.user.id).map(e => ({
            id: e.id,
            code: e.code,
            url: `/api/emotes/file/${path.basename(e.url)}`,
            animated: !!e.animated,
            width: e.width,
            height: e.height,
            is_global: !!e.is_global,
            created_at: e.created_at,
        }));
        // Cap is per-channel now: your own emotes + any viewer uploads on your channel, up to max.
        const count = db.countChannelEmotes(req.user.id);
        const max = config.emotes.maxPerChannel;
        res.json({ emotes, count, max });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load emotes' });
    }
});

// ── Upload a custom emote ────────────────────────────────────
router.post('/', requireAuth, emoteUpload.single('image'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No image file uploaded' });

        // Anti-spam: cap how many emotes one account can upload per window (across all channels).
        if (emoteUploadRateLimited(req.user.id)) {
            fs.unlinkSync(req.file.path);
            return res.status(429).json({ error: `Too many emote uploads — please wait a bit before uploading more.` });
        }

        const code = (req.body.code || '').trim();
        if (!code || code.length < 2 || code.length > 32) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: 'Emote code must be 2-32 characters' });
        }
        if (!/^[a-zA-Z0-9_]+$/.test(code)) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({ error: 'Emote code can only contain letters, numbers, and underscores' });
        }

        // Optional target channel: a viewer uploading an emote FOR a streamer's channel.
        // channel_id is the streamer's user id; stream_id is resolved to its owner.
        let channelOwnerId = parseInt(req.body.channel_id) || null;
        if (!channelOwnerId && req.body.stream_id) {
            channelOwnerId = db.getStreamById(parseInt(req.body.stream_id))?.user_id || null;
        }
        const isChannelUpload = channelOwnerId && channelOwnerId !== req.user.id;

        if (isChannelUpload) {
            const channel = db.getChannelByUserId(channelOwnerId);
            if (!channel) {
                fs.unlinkSync(req.file.path);
                return res.status(404).json({ error: 'Channel not found' });
            }
            const settings = db.getChannelModerationSettings(channel.id);
            const isMod = permissions.canModerateChannel(req.user, channel.id);
            if (!settings.custom_emotes_enabled && !isMod) {
                fs.unlinkSync(req.file.path);
                return res.status(403).json({ error: 'This streamer has disabled viewer emote uploads.' });
            }
            if (settings.uploads_mods_only && !isMod) {
                fs.unlinkSync(req.file.path);
                return res.status(403).json({ error: 'Only channel mods can upload emotes here.' });
            }
            // Per-channel cap only — anyone can upload until the channel is full (then the
            // streamer removes some). No per-uploader sub-limit.
            if (db.countChannelEmotes(channelOwnerId) >= config.emotes.maxPerChannel) {
                fs.unlinkSync(req.file.path);
                return res.status(400).json({ error: `This channel is full (${config.emotes.maxPerChannel} emotes max) — the streamer needs to remove some first.` });
            }
            // Unique code within the channel (any uploader)
            if (db.getChannelEmoteByCode(channelOwnerId, code)) {
                fs.unlinkSync(req.file.path);
                return res.status(409).json({ error: `This channel already has an emote named "${code}".` });
            }
        } else {
            // Uploading to your OWN channel — counts toward the same per-channel budget (your own
            // emotes + any viewer uploads on your channel), capped at maxPerChannel.
            if (db.countChannelEmotes(req.user.id) >= config.emotes.maxPerChannel) {
                fs.unlinkSync(req.file.path);
                return res.status(400).json({ error: `Your channel is full (${config.emotes.maxPerChannel} emotes max) — remove some to add more.` });
            }
            // Uniqueness is per-channel: only clash with emotes on YOUR OWN channel
            // (channel_owner_id IS NULL), not ones you uploaded to other people's channels.
            const existing = db.get('SELECT id FROM emotes WHERE user_id = ? AND code = ? AND channel_owner_id IS NULL', [req.user.id, code]);
            if (existing) {
                fs.unlinkSync(req.file.path);
                return res.status(409).json({ error: `You already have an emote named "${code}"` });
            }
        }

        const animated = req.file.mimetype === 'image/gif' || req.file.mimetype === 'image/webp';
        const isGlobal = req.body.is_global === 'true' && req.user.role === 'admin';

        // Per-emote display size (percent), clamped to the channel's configured range.
        let sizeMin = 25, sizeMax = 400;
        if (channelOwnerId) {
            try {
                const ch = db.getChannelByUserId(channelOwnerId);
                const st = ch ? db.getChannelModerationSettings(ch.id) : null;
                if (st) { sizeMin = st.emote_size_min || 50; sizeMax = st.emote_size_max || 200; }
            } catch { /* defaults */ }
        }
        const size = Math.min(sizeMax, Math.max(sizeMin, parseInt(req.body.size) || 100));

        const result = db.createEmote({
            user_id: req.user.id,
            code,
            url: req.file.path,
            animated,
            width: parseInt(req.body.width) || 28,
            height: parseInt(req.body.height) || 28,
            is_global: isGlobal,
            channel_owner_id: isChannelUpload ? channelOwnerId : null,
            size,
        });

        // Refresh viewers' emote pickers live (no reload) for channel emotes.
        if (isChannelUpload) {
            try { require('../chat/chat-server').broadcastToOwnerStreams(channelOwnerId, { type: 'emotes-updated' }); } catch { /* */ }
        }

        res.json({
            emote: {
                id: result.lastInsertRowid,
                code,
                url: `/api/emotes/file/${path.basename(req.file.path)}`,
                animated,
                channel_id: isChannelUpload ? channelOwnerId : undefined,
            },
        });
    } catch (err) {
        console.error('[Emotes] Upload error:', err);
        if (req.file && fs.existsSync(req.file.path)) { try { fs.unlinkSync(req.file.path); } catch {} }
        if (err && /UNIQUE constraint/i.test(err.message || '')) {
            return res.status(409).json({ error: `This channel already has an emote named "${code}" — pick a different code for this channel.` });
        }
        res.status(500).json({ error: 'Failed to upload emote' });
    }
});

// ── Multer error handler ─────────────────────────────────────
router.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: `File too large (max ${config.emotes.maxSizeKb}KB)` });
    }
    if (err.message && err.message.includes('Only')) {
        return res.status(400).json({ error: err.message });
    }
    console.error('[Emotes] Middleware error:', err);
    res.status(500).json({ error: 'Emote upload failed' });
});

// ── Delete an emote ──────────────────────────────────────────
// ── Edit an emote in place (rename code / change display size) ──
// Same permission model as delete: uploader, admin, or channel mod/owner.
router.patch('/:id', requireAuth, (req, res) => {
    try {
        const emote = db.getEmoteById(req.params.id);
        if (!emote) return res.status(404).json({ error: 'Emote not found' });
        let allowed = emote.user_id === req.user.id || req.user.role === 'admin';
        if (!allowed) {
            const ownerId = emote.channel_owner_id || emote.user_id;
            const channel = db.getChannelByUserId(ownerId);
            if (channel && permissions.canModerateChannel(req.user, channel.id)) allowed = true;
        }
        if (!allowed) return res.status(403).json({ error: 'Not your emote' });

        const patch = {};
        if (req.body.code !== undefined) {
            const code = String(req.body.code || '').trim();
            if (!code || code.length < 2 || code.length > 32) {
                return res.status(400).json({ error: 'Emote code must be 2-32 characters' });
            }
            if (!/^[a-zA-Z0-9_]+$/.test(code)) {
                return res.status(400).json({ error: 'Emote code can only contain letters, numbers, and underscores' });
            }
            // No duplicates within the same channel's emote set.
            const scopeOwner = emote.channel_owner_id || emote.user_id;
            const clash = (db.getChannelEmotes(scopeOwner) || [])
                .find((e) => e.id !== emote.id && String(e.code).toLowerCase() === code.toLowerCase());
            if (clash) return res.status(409).json({ error: `An emote named "${clash.code}" already exists in this channel.` });
            patch.code = code;
        }
        if (req.body.size !== undefined) {
            // Clamp to the channel's configured render range, like upload does.
            let sizeMin = 25, sizeMax = 400;
            try {
                const ownerId = emote.channel_owner_id || emote.user_id;
                const channel = db.getChannelByUserId(ownerId);
                const st = channel ? db.getChannelModerationSettings(channel.id) : null;
                if (st) { sizeMin = st.emote_size_min || 50; sizeMax = st.emote_size_max || 200; }
            } catch { /* defaults */ }
            patch.size = Math.min(sizeMax, Math.max(sizeMin, parseInt(req.body.size) || 100));
        }
        if (patch.code === undefined && patch.size === undefined) {
            return res.status(400).json({ error: 'Nothing to change' });
        }

        db.updateEmote(emote.id, patch);
        // Sound commands attach this emote by code — carry the rename over.
        if (patch.code && patch.code !== emote.code) {
            try { db.updateChannelSoundEmoteRefs(emote.channel_owner_id || emote.user_id, emote.code, patch.code); } catch { /* */ }
        }
        if (emote.channel_owner_id) {
            try { require('../chat/chat-server').broadcastToOwnerStreams(emote.channel_owner_id, { type: 'emotes-updated' }); } catch { /* */ }
        }
        res.json({ message: 'Emote updated', code: patch.code ?? emote.code, size: patch.size ?? emote.size });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update emote' });
    }
});

router.delete('/:id', requireAuth, (req, res) => {
    try {
        const emote = db.getEmoteById(req.params.id);
        if (!emote) return res.status(404).json({ error: 'Emote not found' });
        // Allowed: the uploader, an admin, or a mod/owner of the channel the emote belongs to.
        let allowed = emote.user_id === req.user.id || req.user.role === 'admin';
        if (!allowed) {
            const ownerId = emote.channel_owner_id || emote.user_id;
            const channel = db.getChannelByUserId(ownerId);
            if (channel && permissions.canModerateChannel(req.user, channel.id)) allowed = true;
        }
        if (!allowed) {
            return res.status(403).json({ error: 'Not your emote' });
        }

        // Delete file
        if (emote.url && fs.existsSync(emote.url)) {
            fs.unlinkSync(emote.url);
        }

        db.deleteEmote(req.params.id);
        if (emote.channel_owner_id) {
            try { require('../chat/chat-server').broadcastToOwnerStreams(emote.channel_owner_id, { type: 'emotes-updated' }); } catch { /* */ }
        }
        res.json({ message: 'Emote deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete emote' });
    }
});

// ── Serve emote image files ──────────────────────────────────
router.get('/file/:filename', (req, res) => {
    try {
        const filename = path.basename(req.params.filename);
        const filePath = path.resolve(config.emotes.path, filename);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Emote file not found' });
        }

        const ext = path.extname(filename).toLowerCase();
        const mimeTypes = {
            '.png': 'image/png',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.avif': 'image/avif',
        };

        res.setHeader('Content-Type', mimeTypes[ext] || 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        fs.createReadStream(filePath).pipe(res);
    } catch (err) {
        res.status(500).json({ error: 'Failed to serve emote' });
    }
});

// ── FFZ global emotes (cached proxy) ─────────────────────────
router.get('/ffz', async (req, res) => {
    try {
        const now = Date.now();
        if (ffzCache.data && (now - ffzCache.ts) < config.emotes.ffzCacheTtl * 1000) {
            return res.json({ emotes: ffzCache.data, cached: true });
        }

        const data = await fetchJSON('https://api.frankerfacez.com/v1/set/global');
        const emotes = parseFfzSets(data);
        ffzCache = { data: emotes, ts: now };
        res.json({ emotes, cached: false });
    } catch (err) {
        // Return stale cache if available
        if (ffzCache.data) return res.json({ emotes: ffzCache.data, cached: true, stale: true });
        res.status(502).json({ error: 'Failed to fetch FFZ emotes', emotes: [] });
    }
});

// ── BTTV global emotes (cached proxy) ────────────────────────
router.get('/bttv', async (req, res) => {
    try {
        const now = Date.now();
        if (bttvCache.data && (now - bttvCache.ts) < config.emotes.bttvCacheTtl * 1000) {
            return res.json({ emotes: bttvCache.data, cached: true });
        }

        const data = await fetchJSON('https://api.betterttv.net/3/cached/emotes/global');
        const emotes = parseBttvEmotes(data);
        bttvCache = { data: emotes, ts: now };
        res.json({ emotes, cached: false });
    } catch (err) {
        if (bttvCache.data) return res.json({ emotes: bttvCache.data, cached: true, stale: true });
        res.status(502).json({ error: 'Failed to fetch BTTV emotes', emotes: [] });
    }
});

// ── 7TV global emotes (cached proxy) ─────────────────────────
router.get('/7tv', async (req, res) => {
    try {
        const now = Date.now();
        if (sevenTvCache.data && (now - sevenTvCache.ts) < config.emotes.sevenTvCacheTtl * 1000) {
            return res.json({ emotes: sevenTvCache.data, cached: true });
        }

        const data = await fetchJSON('https://7tv.io/v3/emote-sets/global');
        const emotes = parse7tvEmotes(data);
        sevenTvCache = { data: emotes, ts: now };
        res.json({ emotes, cached: false });
    } catch (err) {
        if (sevenTvCache.data) return res.json({ emotes: sevenTvCache.data, cached: true, stale: true });
        res.status(502).json({ error: 'Failed to fetch 7TV emotes', emotes: [] });
    }
});

// ── Default emotes ───────────────────────────────────────────
router.get('/defaults', (req, res) => {
    res.json({ emotes: DEFAULT_EMOTES });
});

// ── Emote source preferences ────────────────────────────────
router.get('/sources', requireAuth, (req, res) => {
    try {
        const channel = db.ensureChannel(req.user.id);
        let sources = { defaults: true, custom: true, ffz: true, bttv: true, '7tv': true };
        try { sources = JSON.parse(channel.emote_sources || '{}'); } catch (err) { console.warn('[Emotes] Source parse error:', err.message); /* use defaults */ }
        // Ensure all keys exist
        for (const key of ['defaults', 'custom', 'ffz', 'bttv', '7tv']) {
            if (sources[key] === undefined) sources[key] = true;
        }
        res.json({ sources });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load emote sources' });
    }
});

router.put('/sources', requireAuth, (req, res) => {
    try {
        const sources = {};
        for (const key of ['defaults', 'custom', 'ffz', 'bttv', '7tv']) {
            sources[key] = req.body[key] !== false && req.body[key] !== 'false';
        }
        db.updateChannel(req.user.id, { emote_sources: JSON.stringify(sources) });
        res.json({ sources, message: 'Emote sources updated' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update emote sources' });
    }
});

// ── Search FFZ emotes ────────────────────────────────────────
router.get('/search', async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        if (!q || q.length < 2) return res.json({ emotes: [] });

        const cacheKey = q.toLowerCase();
        const cached = ffzSearchCache.get(cacheKey);
        const now = Date.now();
        if (cached && (now - cached.ts) < config.emotes.ffzCacheTtl * 1000) {
            return res.json({ emotes: cached.data, cached: true });
        }

        const data = await fetchJSON(`https://api.frankerfacez.com/v1/emotes?q=${encodeURIComponent(q)}&per_page=50&sort=count-desc`);
        const emotes = (data.emoticons || []).filter(e => !e.hidden && !e.modifier).map(e => ({
            id: `ffz-${e.id}`,
            code: e.name,
            url: e.urls?.['2'] || e.urls?.['1'] || `https://cdn.frankerfacez.com/emote/${e.id}/1`,
            url_1x: e.urls?.['1'] || `https://cdn.frankerfacez.com/emote/${e.id}/1`,
            url_2x: e.urls?.['2'] || e.urls?.['1'],
            animated: false,
            source: 'ffz',
            usage_count: e.usage_count || 0,
        }));

        ffzSearchCache.set(cacheKey, { data: emotes, ts: now });
        // Prune old cache entries
        if (ffzSearchCache.size > 200) {
            const oldest = [...ffzSearchCache.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 100);
            for (const [key] of oldest) ffzSearchCache.delete(key);
        }

        res.json({ emotes, cached: false });
    } catch (err) {
        res.status(502).json({ error: 'Search failed', emotes: [] });
    }
});

// ── All emotes for a stream context ──────────────────────────
router.get('/all/:streamId', optionalAuth, async (req, res) => {
    try {
        const streamId = parseInt(req.params.streamId);
        const stream = streamId ? db.getStreamById(streamId) : null;
        let streamUserId = stream ? stream.user_id : null;
        // Fallback: resolve the channel by ?channel=<username> when there's no live stream
        // context (e.g. the channel-wide chat overlay uses streamId 0) so a channel's custom
        // emotes still load and render instead of showing as plain text.
        if (!streamUserId && req.query.channel) {
            try { const u = db.getUserByUsername(String(req.query.channel)); if (u) streamUserId = u.id; } catch { /* */ }
        }

        // Load channel's emote source preferences
        let sources = { defaults: true, custom: true, ffz: true, bttv: true, '7tv': true };
        if (streamUserId) {
            const channel = db.getChannelByUserId(streamUserId);
            if (channel && channel.emote_sources) {
                try { sources = JSON.parse(channel.emote_sources); } catch { /* use defaults */ }
            }
        }

        // Defaults
        const defaults = sources.defaults !== false ? DEFAULT_EMOTES : [];

        // Custom global emotes
        let globalCustom = [];
        let channelEmotes = [];
        if (sources.custom !== false) {
            globalCustom = db.getGlobalEmotes().map(e => ({
                id: `custom-${e.id}`,
                code: e.code,
                url: `/api/emotes/file/${path.basename(e.url)}`,
                animated: !!e.animated,
                width: e.width,
                height: e.height,
                size: e.size || 100,
                source: 'custom',
                owner: e.username,
            }));

            if (streamUserId) {
                channelEmotes = db.getChannelEmotes(streamUserId).filter(e => !e.is_global).map(e => ({
                    id: `custom-${e.id}`,
                    emote_id: e.id,
                    code: e.code,
                    url: `/api/emotes/file/${path.basename(e.url)}`,
                    animated: !!e.animated,
                    width: e.width,
                    height: e.height,
                    size: e.size || 100,
                    source: 'channel',
                    owner: e.username,
                    uploader: e.uploader_display_name || e.uploader_username || e.username,
                    uploader_id: e.user_id,
                }));
            }
        }

        // FFZ (use cache or fetch)
        let ffzEmotes = [];
        if (sources.ffz !== false) {
            ffzEmotes = ffzCache.data || [];
            if (!ffzEmotes.length) {
                try {
                    const data = await fetchJSON('https://api.frankerfacez.com/v1/set/global');
                    ffzEmotes = parseFfzSets(data);
                    ffzCache = { data: ffzEmotes, ts: Date.now() };
                } catch { /* use empty */ }
            }
        }

        // BTTV (use cache or fetch)
        let bttvEmotes = [];
        if (sources.bttv !== false) {
            bttvEmotes = bttvCache.data || [];
            if (!bttvEmotes.length) {
                try {
                    const data = await fetchJSON('https://api.betterttv.net/3/cached/emotes/global');
                    bttvEmotes = parseBttvEmotes(data);
                    bttvCache = { data: bttvEmotes, ts: Date.now() };
                } catch { /* use empty */ }
            }
        }

        // 7TV (use cache or fetch)
        let sevenTvEmotes = [];
        if (sources['7tv'] !== false) {
            sevenTvEmotes = sevenTvCache.data || [];
            if (!sevenTvEmotes.length) {
                try {
                    const data = await fetchJSON('https://7tv.io/v3/emote-sets/global');
                    sevenTvEmotes = parse7tvEmotes(data);
                    sevenTvCache = { data: sevenTvEmotes, ts: Date.now() };
                } catch { /* use empty */ }
            }
        }

        // The streamer's overall emote scale (a multiplier on top of per-emote sizes) so
        // chat overlays can honour it — the main chat already applies this via chat settings.
        let emoteScale = 100;
        if (streamUserId) {
            try {
                const ch = db.getChannelByUserId(streamUserId);
                const st = ch ? db.getChannelModerationSettings(ch.id) : null;
                if (st && st.emote_scale) emoteScale = Number(st.emote_scale) || 100;
            } catch { /* default 100 */ }
        }

        res.json({
            defaults,
            channel: channelEmotes,
            global: globalCustom,
            ffz: ffzEmotes,
            bttv: bttvEmotes,
            '7tv': sevenTvEmotes,
            sources,
            emote_scale: emoteScale,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load emotes' });
    }
});

module.exports = router;
