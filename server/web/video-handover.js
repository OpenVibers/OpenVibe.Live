'use strict';
/**
 * Stream recordings (VODs) and clips are watched on openvibe.video: the old Live watch URLs keep working as a permanent
 * redirect, so links in chat, search results, embeds and bookmarks survive, and a `?t=` start time goes along. Every VOD
 * and clip link Live renders already points at OpenVibe.Video (server/web/video-url.js, public/js/app.js videoHref), so
 * this only answers old links.
 *
 * Mounted BEFORE the SEO middleware (server/seo/pages.js), like the paste handover, so people and crawlers get the same
 * 301 and openvibe.video is the one canonical home. OpenVibe.Video reads the items from Live's API and owns their pages:
 * the player, AI chapters and captions, the chat replay, comments, clipping, and the owner's visibility and delete.
 *
 * /vods and /clips stay on Live: they are the Content feed with a filter (public/js/content-feed.js), linking out.
 */
const { videoUrl, VIDEO_BASE } = require('./video-url');
const { communityUrl } = require('./paste-handover');

const ID_RE = /^\d{1,15}$/;
/** `?t=` as seconds: 95, or 1:35, or 1:01:35. */
function secondsOf(t) {
    if (typeof t !== 'string') return null;
    if (/^\d{1,6}$/.test(t)) return Number(t);
    const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(t);
    return m ? Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

// A whole OpenVibe.Video or OpenVibe.Community address glued onto Live's: /https://openvibe.video/v/12 (or
// /https:/openvibe.video/v/12, once a proxy merges the slashes). A tab opened before the handover kept its old router,
// which put any link it was handed under '/', and the API now hands it these absolute links.
const GLUED_RE = /^\/https?:\/\/?([^/?#]+)(\/[^?#]*)?$/i;

/** Where a glued path really points, on one of the two sites Live hands pages to; null for anything else. */
function unglue(pathname, search = '') {
    const m = GLUED_RE.exec(String(pathname || ''));
    if (!m) return null;
    const host = m[1].toLowerCase();
    const origin = [VIDEO_BASE, communityUrl()].find((o) => { try { return new URL(o).host === host; } catch { return false; } });
    return origin ? `${origin}${m[2] || '/'}${search}` : null;
}

/** Mount the /vod/:id and /clip/:id redirects to OpenVibe.Video (anything not an id falls through to Live's 404), and
 *  the glued addresses' redirects to the page they name. */
function register(app) {
    app.get(/^\/https?:\//i, (req, res, next) => {
        const q = req.originalUrl.indexOf('?');
        const to = unglue(req.path, q >= 0 ? req.originalUrl.slice(q) : '');
        return to ? res.redirect(301, to) : next();
    });
    for (const [prefix, kind] of [['vod', 'vod'], ['clip', 'clip']]) {
        app.get([`/${prefix}/:id`, `/${prefix}/:id/`], (req, res, next) => {
            const to = ID_RE.test(req.params.id) ? videoUrl(kind, req.params.id, secondsOf(req.query && req.query.t)) : null;
            return to ? res.redirect(301, to) : next();
        });
    }
}

module.exports = { register, secondsOf, unglue };
