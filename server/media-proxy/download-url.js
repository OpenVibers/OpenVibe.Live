'use strict';
/**
 * The URL a person saves a recording or clip from (OpenVibe.Video's Download menu): Media's bytes route with ?download,
 * which Media answers as an attachment named `name` (Media's server/public/routes.js), so the browser saves the file
 * instead of playing it. A public or unlisted item is its plain URL; a private one (its owner, or staff) is a
 * short-lived signed URL, since the browser that follows it carries no key.
 */
const media = require('../media-client');
const access = require('./access');

const TTL_S = 900;

/** A file name as the caller asked for it, without its extension (Media adds the real one), at most 150 characters. */
function cleanName(name) {
    const s = String(name || '').replace(/[\u0000-\u001f\u007f/\\]+/g, ' ').replace(/\s+/g, ' ').trim();
    return s.slice(0, 150);
}

/** → { url, expires_at } for `kind` ('vod' | 'clip') item `row`, already checked visible to the reader. */
async function downloadUrl(kind, row, name) {
    let base;
    let expires = null;
    if (access.isPrivate(row)) {
        const signed = await media.signedMediaUrl(kind, row.id, TTL_S);
        if (!signed || !signed.url) throw new Error('Media signed no URL');
        base = new URL(media.publicUrl(signed.url));
        expires = signed.expires_at || null;
    } else {
        base = new URL(kind === 'clip' ? media.clipUrl(row.id) : media.vodPlaybackUrl(row.id));
    }
    base.searchParams.set('download', '1');
    const n = cleanName(name);
    if (n) base.searchParams.set('name', n);
    return { url: base.toString(), expires_at: expires };
}

module.exports = { downloadUrl, cleanName };
