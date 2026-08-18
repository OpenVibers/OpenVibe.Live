/**
 * OpenVibe.Live — Channel Sound Commands API
 *
 * Per-channel, viewer-uploadable sound clips triggered by !command in chat.
 *
 * GET    /api/sounds/channel/:userId - Sounds for a streamer's channel
 * GET    /api/sounds/all/:streamId   - Sounds available in a stream context
 * POST   /api/sounds                 - Upload a channel sound (auth required)
 * DELETE /api/sounds/:id             - Delete a sound (uploader / mod / owner)
 * GET    /api/sounds/file/:filename  - Serve a sound file
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const multer = require('multer');
const db = require('../db/database');
const { requireAuth } = require('../auth/auth');
const permissions = require('../auth/permissions');
const config = require('../config');

const router = express.Router();

// Commands already handled elsewhere in chat — cannot be overridden by a sound.
const RESERVED_COMMANDS = new Set([
    'sb', 'gotti', 'sr', 'yt', 'youtube', 'req', 'request', 'queue', 'np',
    'nowplaying', 'watching', 'skip', 'mediahelp', 'say',
    'forward', 'backward', 'left', 'right', 'liftup', 'liftdown', 'headup', 'headdown',
]);

const MIME_TO_EXT = {
    'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav',
    'audio/wave': '.wav', 'audio/vnd.wave': '.wav', 'audio/x-pn-wav': '.wav',
    'audio/ogg': '.ogg', 'audio/webm': '.webm', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a',
    'audio/aac': '.aac', 'audio/flac': '.flac', 'audio/x-flac': '.flac', 'audio/opus': '.opus',
};
// Browsers/OSes report .wav (and others) under many mimetypes — or none at all
// (application/octet-stream). Fall back to the file extension so uploads don't wrongly fail.
const ALLOWED_EXT = new Set(['.mp3', '.wav', '.ogg', '.oga', '.opus', '.webm', '.m4a', '.mp4', '.aac', '.flac']);

function extFor(file) {
    if (MIME_TO_EXT[file.mimetype]) return MIME_TO_EXT[file.mimetype];
    const ext = path.extname(file.originalname || '').toLowerCase();
    return ALLOWED_EXT.has(ext) ? ext : '';
}

function soundsDir() {
    const dir = path.resolve(config.sounds.path);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

const soundStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, soundsDir()),
    filename: (req, file, cb) => {
        const ext = extFor(file) || '.bin';
        cb(null, `snd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
});
const soundUpload = multer({
    storage: soundStorage,
    limits: { fileSize: config.sounds.maxSizeKb * 1024 },
    fileFilter: (req, file, cb) => {
        // Accept by known audio mimetype OR by a recognized audio extension.
        if (MIME_TO_EXT[file.mimetype] || ALLOWED_EXT.has(path.extname(file.originalname || '').toLowerCase())) {
            cb(null, true);
        } else {
            cb(new Error('Only audio files are allowed (MP3, WAV, OGG, Opus, WebM, M4A, AAC, FLAC).'));
        }
    },
});

/** Transcode an audio file to a canonical MP3 (fast decode, small, universal). Returns the
 *  new path on success (original left for the caller to delete), or null on failure. */
function convertToMp3(srcPath) {
    return new Promise((resolve) => {
        const outPath = srcPath.replace(/\.[^.]+$/, '') + '.conv.mp3';
        let proc;
        try {
            proc = spawn('ffmpeg', ['-y', '-i', srcPath, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '128k', outPath]);
        } catch { return resolve(null); }
        proc.on('close', (code) => resolve(code === 0 && fs.existsSync(outPath) ? outPath : null));
        proc.on('error', () => resolve(null));
        setTimeout(() => { try { proc.kill(); } catch {} resolve(null); }, 20000);
    });
}

/** Probe an audio file's duration in seconds (0 on failure). */
function probeDuration(filePath) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        let out = '';
        let probe;
        try {
            probe = spawn('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', filePath]);
        } catch { return finish(0); }
        probe.stdout.on('data', (d) => { out += d; });
        probe.on('close', () => {
            try {
                const info = JSON.parse(out);
                const dur = parseFloat(info.format?.duration || '0');
                finish(Number.isFinite(dur) && dur > 0 ? dur : 0);
            } catch { finish(0); }
        });
        probe.on('error', () => finish(0));
        setTimeout(() => { try { probe.kill(); } catch {} finish(0); }, 10000);
    });
}

function serializeSound(s) {
    return {
        id: s.id,
        command: s.command,
        url: `/api/sounds/file/${path.basename(s.url)}`,
        duration_seconds: Math.round((s.duration_seconds || 0) * 10) / 10,
        uploader: s.created_by_name || 'someone',
        uploader_id: s.created_by,
        emote_code: s.emote_code || '',
        created_at: s.created_at,
    };
}

// ── List a channel's sounds ──────────────────────────────────
router.get('/channel/:userId', (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        if (!userId) return res.json({ sounds: [] });
        res.json({ sounds: db.getChannelSounds(userId).map(serializeSound) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load channel sounds' });
    }
});

// ── List sounds available in a stream context ────────────────
router.get('/all/:streamId', (req, res) => {
    try {
        const stream = db.getStreamById(parseInt(req.params.streamId));
        if (!stream?.user_id) return res.json({ sounds: [] });
        res.json({ sounds: db.getChannelSounds(stream.user_id).map(serializeSound) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load sounds' });
    }
});

// ── Upload a channel sound ───────────────────────────────────
router.post('/', requireAuth, soundUpload.single('sound'), async (req, res) => {
    const cleanup = () => { if (req.file && fs.existsSync(req.file.path)) { try { fs.unlinkSync(req.file.path); } catch {} } };
    try {
        if (!req.file) return res.status(400).json({ error: 'No audio file uploaded' });

        const command = String(req.body.command || '').trim().toLowerCase().replace(/^!+/, '');
        if (!/^[a-z0-9_]{2,24}$/.test(command)) {
            cleanup();
            return res.status(400).json({ error: 'Command must be 2-24 letters, numbers, or underscores' });
        }
        if (RESERVED_COMMANDS.has(command)) {
            cleanup();
            return res.status(400).json({ error: `"!${command}" is a reserved command — pick another name` });
        }

        // Resolve target channel: channel_id = streamer's user id; stream_id resolves to its owner.
        let channelOwnerId = parseInt(req.body.channel_id) || null;
        if (!channelOwnerId && req.body.stream_id) {
            channelOwnerId = db.getStreamById(parseInt(req.body.stream_id))?.user_id || null;
        }
        if (!channelOwnerId) channelOwnerId = req.user.id;
        const channel = db.getChannelByUserId(channelOwnerId) || (channelOwnerId === req.user.id ? db.ensureChannel(req.user.id) : null);
        if (!channel) {
            cleanup();
            return res.status(404).json({ error: 'Channel not found' });
        }

        const settings = db.getChannelModerationSettings(channel.id);
        const isMod = permissions.canModerateChannel(req.user, channel.id);
        const isOwnChannel = channelOwnerId === req.user.id;

        if (!isMod && !settings.custom_sounds_enabled) {
            cleanup();
            return res.status(403).json({ error: 'This streamer has disabled viewer sound uploads.' });
        }
        if (!isMod && !isOwnChannel && (settings.uploads_mods_only || settings.sounds_mods_only)) {
            cleanup();
            return res.status(403).json({ error: 'Only channel mods can upload sounds here.' });
        }

        // Adding a NEW file to an EXISTING command is restricted to that command's
        // creator (or channel mods/owner), so viewers can't hijack someone's command.
        const existingForCmd = db.getChannelSoundByCommand(channelOwnerId, command);
        if (existingForCmd && !isMod && !isOwnChannel && existingForCmd.created_by !== req.user.id) {
            cleanup();
            return res.status(403).json({ error: `Only the creator of !${command} (or a mod) can add more sounds to it.` });
        }

        // Per-channel + per-uploader caps
        if (db.countChannelSounds(channelOwnerId) >= config.sounds.maxPerChannel) {
            cleanup();
            return res.status(400).json({ error: `This channel has reached its sound limit (${config.sounds.maxPerChannel}).` });
        }
        if (!isMod && db.countChannelSoundsByUploader(channelOwnerId, req.user.id) >= config.sounds.maxPerUploaderPerChannel) {
            cleanup();
            return res.status(400).json({ error: `You've reached your upload limit for this channel (${config.sounds.maxPerUploaderPerChannel}).` });
        }

        // A command may hold multiple sounds (one is chosen at random on playback),
        // so duplicates are allowed. Per-channel / per-uploader count caps below still apply.

        // Duration gate
        const maxSeconds = Math.min(30, Math.max(1, settings.max_sound_seconds || config.sounds.defaultMaxSeconds));
        const duration = await probeDuration(req.file.path);
        if (!duration) {
            cleanup();
            return res.status(400).json({ error: 'Could not read that audio file — try a standard MP3 or WAV.' });
        }
        if (duration > maxSeconds + 0.25) {
            cleanup();
            return res.status(400).json({ error: `Sound is too long (${duration.toFixed(1)}s). Max is ${maxSeconds}s for this channel.` });
        }

        // Normalize every upload to MP3 — universal, small, and the fastest to decode for
        // low-latency chat playback. (Skip if it's already an .mp3.)
        let finalPath = req.file.path;
        let finalMime = req.file.mimetype;
        if (path.extname(finalPath).toLowerCase() !== '.mp3') {
            const mp3 = await convertToMp3(req.file.path);
            if (mp3) {
                try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
                finalPath = mp3;
                finalMime = 'audio/mpeg';
            } else {
                cleanup();
                return res.status(400).json({ error: 'Could not process that audio file. Try a standard MP3 or WAV.' });
            }
        }

        // Emote attached to the command (per-command; new files inherit the existing one).
        const emoteCode = String(req.body.emote_code || (existingForCmd && existingForCmd.emote_code) || '').trim().slice(0, 32);
        const result = db.createChannelSound({
            channel_owner_id: channelOwnerId,
            command,
            url: finalPath,
            mime: finalMime,
            duration_seconds: duration,
            created_by: req.user.id,
            created_by_name: req.user.display_name || req.user.username,
            emote_code: emoteCode,
        });
        // If an emote was (re)specified, apply it to every sound under this command.
        if (req.body.emote_code !== undefined) { try { db.setChannelSoundEmote(channelOwnerId, command, emoteCode); } catch { /* */ } }
        try { require('../media-proxy/asset-sync').syncSoon(); } catch { /* mirror is best-effort */ }

        // Tell everyone watching this channel to refresh their sound list live.
        try { require('./chat-server').broadcastToOwnerStreams(channelOwnerId, { type: 'sounds-updated' }); } catch { /* */ }

        res.json({
            sound: {
                id: result.lastInsertRowid,
                command,
                url: `/api/sounds/file/${path.basename(finalPath)}`,
                duration_seconds: Math.round(duration * 10) / 10,
                channel_id: channelOwnerId,
            },
        });
    } catch (err) {
        console.error('[Sounds] Upload error:', err);
        cleanup();
        if (err && /UNIQUE constraint/i.test(err.message || '')) {
            return res.status(409).json({ error: 'That command already exists on this channel.' });
        }
        res.status(500).json({ error: 'Failed to upload sound' });
    }
});

// ── Multer error handler ─────────────────────────────────────
router.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: `File too large (max ${Math.round(config.sounds.maxSizeKb / 1024 * 10) / 10}MB)` });
    }
    if (err.message && err.message.includes('Only')) {
        return res.status(400).json({ error: err.message });
    }
    console.error('[Sounds] Middleware error:', err);
    res.status(500).json({ error: 'Sound upload failed' });
});

// ── Delete a sound ───────────────────────────────────────────
router.delete('/:id', requireAuth, (req, res) => {
    try {
        const sound = db.getChannelSoundById(parseInt(req.params.id));
        if (!sound) return res.status(404).json({ error: 'Sound not found' });
        let allowed = sound.created_by === req.user.id || req.user.role === 'admin';
        if (!allowed) {
            const channel = db.getChannelByUserId(sound.channel_owner_id);
            if (channel && permissions.canModerateChannel(req.user, channel.id)) allowed = true;
        }
        if (!allowed) return res.status(403).json({ error: 'Not your sound' });

        if (sound.url && fs.existsSync(sound.url)) { try { fs.unlinkSync(sound.url); } catch {} }
        db.deleteChannelSound(sound.id);
        try { require('../media-proxy/asset-sync').removeAsset(sound.media_asset_id); } catch { /* */ }
        try { require('./chat-server').broadcastToOwnerStreams(sound.channel_owner_id, { type: 'sounds-updated' }); } catch { /* */ }
        res.json({ message: 'Sound deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete sound' });
    }
});

// ── Edit a !command group in place (rename / set emote) ──────
// Body: { channel_id? , stream_id?, command, newCommand?, emoteCode? }.
// A command may hold several sounds, so edits apply to the whole group.
// Allowed: channel owner, channel mods, admins, or the creator of every
// sound in the group (mirrors the add-to-command rule).
router.patch('/command', requireAuth, (req, res) => {
    try {
        let channelOwnerId = parseInt(req.body.channel_id) || null;
        if (!channelOwnerId && req.body.stream_id) {
            channelOwnerId = db.getStreamById(parseInt(req.body.stream_id))?.user_id || null;
        }
        if (!channelOwnerId) channelOwnerId = req.user.id;
        const channel = db.getChannelByUserId(channelOwnerId);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });

        const command = String(req.body.command || '').trim().toLowerCase().replace(/^!+/, '');
        const group = (db.getChannelSounds(channelOwnerId) || []).filter((s) => s.command === command);
        if (!group.length) return res.status(404).json({ error: `No sound command !${command} in this channel.` });

        const isMod = permissions.canModerateChannel(req.user, channel.id);
        const isOwnChannel = channelOwnerId === req.user.id;
        const isCreator = group.every((s) => s.created_by === req.user.id);
        if (!isMod && !isOwnChannel && !isCreator && req.user.role !== 'admin') {
            return res.status(403).json({ error: `Only the creator of !${command} (or a mod) can edit it.` });
        }

        let finalCommand = command;
        if (req.body.newCommand !== undefined) {
            const next = String(req.body.newCommand || '').trim().toLowerCase().replace(/^!+/, '');
            if (!/^[a-z0-9_]{2,24}$/.test(next)) {
                return res.status(400).json({ error: 'Command must be 2-24 letters, numbers, or underscores' });
            }
            if (RESERVED_COMMANDS.has(next)) {
                return res.status(400).json({ error: `"!${next}" is a reserved command — pick another name` });
            }
            if (next !== command && db.getChannelSoundByCommand(channelOwnerId, next)) {
                return res.status(409).json({ error: `!${next} already exists in this channel.` });
            }
            if (next !== command) {
                db.renameChannelSoundCommand(channelOwnerId, command, next);
                finalCommand = next;
            }
        }
        if (req.body.emoteCode !== undefined) {
            const emoteCode = String(req.body.emoteCode || '').trim().replace(/^:|:$/g, '');
            if (emoteCode && !/^[a-zA-Z0-9_]{2,32}$/.test(emoteCode)) {
                return res.status(400).json({ error: 'Emote code can only contain letters, numbers, and underscores' });
            }
            db.setChannelSoundEmote(channelOwnerId, finalCommand, emoteCode);
        }

        try { require('./chat-server').broadcastToOwnerStreams(channelOwnerId, { type: 'sounds-updated' }); } catch { /* */ }
        res.json({ message: 'Sound command updated', command: finalCommand });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update sound command' });
    }
});

// ── Serve a sound file ───────────────────────────────────────
const EXT_TO_MIME = {
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.webm': 'audio/webm', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac',
};
router.get('/file/:filename', (req, res) => {
    try {
        const filename = path.basename(req.params.filename);
        const filePath = path.resolve(soundsDir(), filename);
        if (!filePath.startsWith(soundsDir()) || !fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Sound not found' });
        }
        const ext = path.extname(filename).toLowerCase();
        res.setHeader('Content-Type', EXT_TO_MIME[ext] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        fs.createReadStream(filePath).pipe(res);
    } catch (err) {
        res.status(500).json({ error: 'Failed to serve sound' });
    }
});

// ── Streamer alert sounds (donation / goal-reached) ──────────────────────
// Streamer-only. Stored on the channel's moderation settings; the file lives in the
// sounds dir and is read server-side + broadcast as base64 on donation / goal events.
function _alertKind(raw) { return raw === 'goal' ? 'goal' : 'donation'; }

// GET which alert sounds are configured (+ a preview URL).
router.get('/alert/mine', requireAuth, (req, res) => {
    const s = db.getChannelAlertSoundsByUser(req.user.id) || {};
    const toUrl = (p) => (p ? `/api/sounds/file/${path.basename(p)}` : null);
    res.json({
        donation: { set: !!s.donation_sound_url, url: toUrl(s.donation_sound_url) },
        goal: { set: !!s.goal_sound_url, url: toUrl(s.goal_sound_url) },
    });
});

// Upload/replace an alert sound. kind = 'donation' | 'goal'.
router.post('/alert/:kind', requireAuth, soundUpload.single('sound'), async (req, res) => {
    const kind = _alertKind(req.params.kind);
    try {
        if (!req.file) return res.status(400).json({ error: 'No sound file' });
        const channel = db.getChannelByUserId(req.user.id) || db.ensureChannel(req.user.id);
        if (!channel) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'No channel' }); }

        // Guard duration (reuse the channel's max-sound limit, capped at 15s for alerts).
        let duration = 0;
        try { duration = await probeDuration(req.file.path); } catch { /* */ }
        if (duration > 15.5) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: `Alert sound too long (${duration.toFixed(1)}s). Max 15s.` }); }

        // Normalize to mp3 for universal playback; fall back to the original on failure.
        let finalPath = req.file.path;
        try {
            const mp3 = await convertToMp3(req.file.path);
            if (mp3) { fs.unlink(req.file.path, () => {}); finalPath = mp3; }
        } catch { /* keep original */ }

        // Remove the previous alert sound of this kind (best-effort).
        try {
            const prev = db.getChannelAlertSoundsByUser(req.user.id) || {};
            const prevPath = kind === 'goal' ? prev.goal_sound_url : prev.donation_sound_url;
            if (prevPath && fs.existsSync(prevPath) && path.resolve(prevPath) !== path.resolve(finalPath)) fs.unlink(prevPath, () => {});
        } catch { /* ignore */ }

        const ext = path.extname(finalPath).toLowerCase();
        const mime = EXT_TO_MIME[ext] || 'audio/mpeg';
        db.setChannelAlertSound(channel.id, kind, finalPath, mime);
        res.json({ set: true, kind, url: `/api/sounds/file/${path.basename(finalPath)}` });
    } catch (err) {
        if (req.file) fs.unlink(req.file.path, () => {});
        res.status(500).json({ error: 'Failed to save alert sound: ' + err.message });
    }
});

// Clear an alert sound.
router.delete('/alert/:kind', requireAuth, (req, res) => {
    const kind = _alertKind(req.params.kind);
    try {
        const channel = db.getChannelByUserId(req.user.id);
        if (channel) {
            const prev = db.getChannelAlertSoundsByUser(req.user.id) || {};
            const prevPath = kind === 'goal' ? prev.goal_sound_url : prev.donation_sound_url;
            if (prevPath && fs.existsSync(prevPath)) { try { fs.unlinkSync(prevPath); } catch { /* */ } }
            db.setChannelAlertSound(channel.id, kind, null, null);
        }
        res.json({ set: false, kind });
    } catch (err) {
        res.status(500).json({ error: 'Failed to clear alert sound' });
    }
});

module.exports = router;
