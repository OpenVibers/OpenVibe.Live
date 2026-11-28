'use strict';
/**
 * The shape of a live stream's picture, read from its live thumbnail (2026-11-28).
 *
 * The channel page on a phone moved its chat 238 px a few seconds after loading whenever the stream was portrait
 * (RUM: channel|phone CLS p75 0.49, the moved element #chat-sidebar 188 times): the player box starts 16:9 and only
 * learns the stream's shape from the thumbnail or the first frame, and a portrait shape lays the whole page out again
 * (the picture fills the screen, the chat runs over its lower part). The thumbnail is a file this server wrote
 * (media-proxy/live-thumbs.js, data/live-thumbs/), so its width and height are known before the page is sent: the
 * page carries the ratio on the player box (data-shape-hint) and player-shape.js starts from it.
 *
 * Only the file's header is read (JPEG SOFn or PNG IHDR), once per file: a file name carries its time, so a new
 * picture is a new name.
 */
const fs = require('fs');
const path = require('path');

const MIN = 0.4, MAX = 3.2;         // the same bounds as public/js/player-shape.js
const HEAD_BYTES = 64 * 1024;       // a JPEG's frame header follows its tables; 64 KB covers any camera's
const cache = new Map();            // file name → ratio | null

/** Width and height from an image's first bytes, or null. */
function imageSize(buf) {
    if (!buf || buf.length < 24) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
        const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
        return w > 0 && h > 0 ? { w, h } : null;
    }
    if (buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
    let i = 2;
    while (i + 9 < buf.length) {
        if (buf[i] !== 0xFF) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xFF) { i++; continue; }
        if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
            const h = buf.readUInt16BE(i + 5), w = buf.readUInt16BE(i + 7);
            return w > 0 && h > 0 ? { w, h } : null;
        }
        if (marker === 0xDA || len < 2) return null;   // the image data starts: no frame header before it
        i += 2 + len;
    }
    return null;
}

/** The ratio (width / height) of a live thumbnail served at /api/thumbnails/<file>, or null when unknown. */
function liveShape(thumbUrl, dir = null) {
    const m = /^\/api\/thumbnails\/(stream-\d+-\d+\.(?:jpg|png))$/.exec(String(thumbUrl || ''));
    if (!m) return null;
    const file = m[1];
    if (cache.has(file)) return cache.get(file);
    let ratio = null;
    try {
        const base = dir || require('../media-proxy/live-thumbs').THUMB_DIR;
        const fd = fs.openSync(path.join(base, file), 'r');
        try {
            const buf = Buffer.alloc(HEAD_BYTES);
            const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
            const size = imageSize(buf.subarray(0, n));
            if (size) ratio = Math.min(MAX, Math.max(MIN, size.w / size.h));
        } finally { fs.closeSync(fd); }
    } catch { ratio = null; }
    if (cache.size >= 300) cache.delete(cache.keys().next().value);
    cache.set(file, ratio);
    return ratio;
}

module.exports = { liveShape, imageSize };
