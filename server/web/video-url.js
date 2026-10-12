'use strict';
/**
 * OpenVibe.Video (openvibe.video) is the canonical public home of a recording or clip: its watch page has the player
 * (HLS), chapters, captions, chat replay, comments, playlists and the owner's tools, and its sitemap lists them.
 * Live's own /vod/<id> and /clip/<id> pages keep working, but name the Video page as canonical, Live's sitemap leaves
 * them out, and OpenVibe.Search documents link there.
 *
 *   videoUrl('vod', 12)        → 'https://openvibe.video/v/12'
 *   videoUrl('clip', 7)        → 'https://openvibe.video/c/7'
 *   videoUrl('vod', 12, 95)    → 'https://openvibe.video/v/12?t=95'   (a moment)
 *
 * VIDEO_PUBLIC_URL overrides the origin (development, a restore drill).
 */
const BASE = String(process.env.VIDEO_PUBLIC_URL || 'https://openvibe.video').replace(/\/+$/, '');

function videoUrl(kind, id, t = null) {
    const n = Number(id);
    if (!Number.isSafeInteger(n) || n <= 0) return null;
    const at = t != null && Number.isFinite(Number(t)) && Number(t) > 0 ? `?t=${Math.floor(Number(t))}` : '';
    return `${BASE}/${kind === 'clip' ? 'c' : 'v'}/${n}${at}`;
}

module.exports = { videoUrl, VIDEO_BASE: BASE };
