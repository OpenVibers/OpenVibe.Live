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
 *   videoUrl('vod', 12, null, 'dQw4w9WgXcQ') → 'https://openvibe.video/watch?v=dQw4w9WgXcQ'
 *   videoUrl('vod', 12, 95, 'dQw4w9WgXcQ')   → 'https://openvibe.video/watch?v=dQw4w9WgXcQ&t=95'
 *
 * A row's watch id (Media mints one for every VOD and clip) names the page in YouTube's shape; a row without one
 * keeps the numbered address, which Video still answers and redirects to the watch page.
 *
 * VIDEO_PUBLIC_URL overrides the origin (development, a restore drill).
 */
const BASE = String(process.env.VIDEO_PUBLIC_URL || 'https://openvibe.video').replace(/\/+$/, '');
const WATCH_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function videoUrl(kind, id, t = null, watchId = null) {
    const n = Number(id);
    if (!Number.isSafeInteger(n) || n <= 0) return null;
    const watch = watchId && WATCH_ID_RE.test(String(watchId)) ? String(watchId) : null;
    const at = t != null && Number.isFinite(Number(t)) && Number(t) > 0 ? `${watch ? '&' : '?'}t=${Math.floor(Number(t))}` : '';
    if (watch) return `${BASE}/watch?v=${watch}${at}`;
    return `${BASE}/${kind === 'clip' ? 'c' : 'v'}/${n}${at}`;
}

module.exports = { videoUrl, VIDEO_BASE: BASE };
