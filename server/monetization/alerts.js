/**
 * alerts.js — streamer alert sounds for donations / donation-goal-reached events.
 *
 * The streamer uploads a sound (via chat → Settings); we read it server-side and
 * broadcast it as base64 `soundboard-audio` so the existing client audio queue
 * (playTTSAudio) plays it for every viewer, gated on their Chat Sounds toggle.
 * A goal-reached event uses the goal-override sound if set, else the donation sound.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const db = require('../db/database');

const MAX_SOUND_BYTES = 3 * 1024 * 1024; // 3MB — alert clips are short

function _mimeForExt(ext) {
    switch ((ext || '').toLowerCase()) {
        case '.wav': return 'audio/wav';
        case '.ogg': case '.oga': return 'audio/ogg';
        case '.opus': return 'audio/opus';
        case '.webm': return 'audio/webm';
        case '.m4a': case '.mp4': return 'audio/mp4';
        case '.aac': return 'audio/aac';
        case '.flac': return 'audio/flac';
        default: return 'audio/mpeg';
    }
}

function _readSound(diskPath, mimeHint) {
    try {
        if (!diskPath || !fs.existsSync(diskPath)) return null;
        const buf = fs.readFileSync(diskPath);
        if (!buf || !buf.length || buf.length > MAX_SOUND_BYTES) return null;
        return { audio: buf.toString('base64'), mimeType: mimeHint || _mimeForExt(path.extname(diskPath)) };
    } catch { return null; }
}

/**
 * Broadcast a streamer's alert sound to their viewers (channel-wide, so it reaches
 * every slot + offline chat). kind: 'donation' | 'goal'. No-op if none configured.
 */
function playAlertSound(chatServer, streamerId, streamId, kind) {
    try {
        if (!chatServer || !chatServer.broadcastToChannelRoom) return;
        const s = db.getChannelAlertSoundsByUser(streamerId) || {};
        let disk = null, mime = null;
        if (kind === 'goal') {
            // Goal-reached uses the override sound if set, otherwise the donation sound.
            disk = s.goal_sound_url || s.donation_sound_url;
            mime = s.goal_sound_url ? s.goal_sound_mime : s.donation_sound_mime;
        } else {
            disk = s.donation_sound_url;
            mime = s.donation_sound_mime;
        }
        const snd = _readSound(disk, mime);
        if (!snd) return;
        chatServer.broadcastToChannelRoom(streamerId, streamId || null, {
            type: 'soundboard-audio',
            audio: snd.audio,
            mimeType: snd.mimeType,
            source: kind === 'goal' ? 'goal-alert' : 'donation-alert',
        });
    } catch { /* non-critical */ }
}

module.exports = { playAlertSound };
