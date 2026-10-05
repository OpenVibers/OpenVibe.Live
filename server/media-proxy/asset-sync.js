/**
 * asset-sync.js — mirror Live's channel sounds into OpenVibe.Media, their canonical public home
 * (served at /a/:id, browsable on the media index with uploader + channel attribution).
 *
 * Local files remain the low-latency working copy (chat playback reads disk); this job uploads
 * anything Media doesn't have yet and records media_url / media_asset_id on the local row, so
 * sound URLs come from Media's long-cached endpoint and deletes propagate. Idempotent: rows are
 * skipped once media_asset_id is set, and Media upserts on (kind, name, channel).
 *
 * The emote backfill went with roadmap T3: OpenVibe.Chat owns `emotes` and uploads emote bytes to
 * Media with its own token, so Live no longer has emote rows to sync.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const media = require('../media-client');
const chatReads = require('../chat/chat-reads');

const paths = require('../paths');
const SOUND_DIR = paths.dir('SOUNDS_PATH', 'sounds');
const MIME_BY_EXT = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.avif': 'image/avif',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.webm': 'audio/webm',
};

function _ensureColumns() {
    for (const [table, col, type] of [
        ['channel_sounds', 'media_url', 'TEXT'], ['channel_sounds', 'media_asset_id', 'INTEGER'],
    ]) {
        try { db.getDb().exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch { /* exists */ }
    }
}

function _localFile(dir, urlOrPath) {
    if (!urlOrPath) return null;
    if (path.isAbsolute(urlOrPath) && fs.existsSync(urlOrPath)) return urlOrPath;
    const p = path.join(dir, path.basename(urlOrPath));
    return fs.existsSync(p) ? p : null;
}

async function _upload({ kind, name, filePath, user_id, username, channel_username, duration_seconds, meta }) {
    const ext = path.extname(filePath).toLowerCase();
    const fd = media._formData(
        { kind, name, user_id, username, channel_username, duration_seconds, meta },
        { buffer: fs.readFileSync(filePath), filename: path.basename(filePath), contentType: MIME_BY_EXT[ext] || 'application/octet-stream' },
        'file'
    );
    const out = await media.request('POST', '/assets', { body: fd, timeoutMs: 60000 });
    return out && out.asset;
}

let _running = false;
async function syncAll() {
    if (_running) return;
    _running = true;
    try {
        _ensureColumns();
        const nameCache = {};
        const uname = (id) => {
            if (!id) return '';
            if (!(id in nameCache)) { const u = db.getUserById(id); nameCache[id] = (u && u.username) || ''; }
            return nameCache[id];
        };
        let synced = 0, failed = 0;

        // The work list is Chat's (channel_sounds is Chat's table); Live's own rows when Live runs
        // chat. Page by id until a short page: sounds with no local file stay pending and would
        // otherwise fill the first window forever, starving every later sound.
        const PAGE = 100;
        let afterId = 0;
        for (;;) {
            const batch = (await chatReads.pendingSounds({ afterId, limit: PAGE })) || [];
            for (const s of batch) {
                const f = _localFile(SOUND_DIR, s.url);
                if (!f) continue;
                try {
                    const asset = await _upload({
                        kind: 'sound', name: s.command, filePath: f,
                        user_id: s.created_by, username: s.created_by_name || uname(s.created_by),
                        channel_username: uname(s.channel_owner_id),
                        duration_seconds: s.duration_seconds || 0,
                    });
                    if (asset) {
                        // Chat owns the row: a null answer means the record did not land, so the
                        // sound stays pending and must be counted failed, not synced.
                        const recorded = await chatReads.recordSoundAsset(s.id, asset.url, asset.id);
                        if (recorded) synced++; else failed++;
                    }
                } catch (err) { failed++; if (failed <= 3) console.warn('[AssetSync] sound', s.command, err.message); }
            }
            if (batch.length < PAGE) break;
            afterId = Number(batch[batch.length - 1].id) || 0;
            if (!afterId) break;
        }

        if (synced || failed) console.log(`[AssetSync] Synced ${synced} chat assets to Media${failed ? ` (${failed} failed — will retry next pass)` : ''}`);
    } finally {
        _running = false;
    }
}

let _debounce = null;
/** Debounced sync — call after any emote/sound upload. */
function syncSoon() {
    clearTimeout(_debounce);
    _debounce = setTimeout(() => syncAll().catch((e) => console.warn('[AssetSync]', e.message)), 5000);
    if (_debounce.unref) _debounce.unref();
}

/** Best-effort removal of the Media copy when the local asset is deleted. */
function removeAsset(mediaAssetId) {
    if (!mediaAssetId) return;
    media.request('DELETE', `/assets/${mediaAssetId}`).catch(() => {});
}

function start() {
    const boot = setTimeout(() => syncAll().catch((e) => console.warn('[AssetSync]', e.message)), 20 * 1000);
    if (boot.unref) boot.unref();
    const timer = setInterval(() => syncAll().catch(() => {}), 6 * 60 * 60 * 1000);
    if (timer.unref) timer.unref();
}

module.exports = { start, syncAll, syncSoon, removeAsset };
