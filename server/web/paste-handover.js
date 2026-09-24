'use strict';
/**
 * Pastes live on openvibe.community (PASTES_ON_COMMUNITY=1): the old Live paste URLs keep working
 * as redirects, so links in chat, search results and clipboards survive.
 *
 * Mounted BEFORE the SEO middleware (server/seo/seo.js). It used to be mounted after it, so every
 * HTML navigation, crawlers included, got Live's own server-rendered copy of the paste, with a
 * canonical on openvibe.live, while only non-HTML clients got the redirect: two indexable pages,
 * each naming itself canonical, and a different answer for people and machines. Now every client
 * gets the same answer and openvibe.community is the one canonical home (roadmap 32.2).
 *
 * Someone signed in here should arrive signed in there: they go through Community's silent sign-in
 * (one quiet round trip; it skips itself when Community already has a valid session and falls back
 * to the plain page when the Network session is gone). Guests and crawlers get the permanent redirect.
 *
 * /pastes itself stays on Live: it is the Content feed with the Pastes filter (public/js/content-feed.js).
 */

const onCommunity = () => process.env.PASTES_ON_COMMUNITY === '1';
const communityUrl = () => (process.env.OV_COMMUNITY_URL || 'https://openvibe.community').replace(/\/$/, '');

function handOver(req, res, target) {
    const signedIn = /(?:^|;\s*)ov_sso_hint=account(?:;|$)/.test(String(req.headers.cookie || ''));
    if (!signedIn) return res.redirect(301, `${communityUrl()}${target}`);
    res.set({ 'Cache-Control': 'private, no-store', Vary: 'Cookie' });
    return res.redirect(302, `${communityUrl()}/auth/login?silent=1&next=${encodeURIComponent(target)}`);
}

/** Mount the /p/:slug handover when pastes are on Community. Returns whether it was mounted. */
function register(app) {
    if (!onCommunity()) return false;
    app.get('/p/:slug', (req, res) => handOver(req, res, `/p/${encodeURIComponent(req.params.slug)}`));
    return true;
}

module.exports = { register, onCommunity, communityUrl };
