'use strict';
/**
 * Pastes live on openvibe.community: the old Live paste URLs keep working as a permanent redirect,
 * so links in chat, search results and clipboards survive. Every paste link Live renders already
 * points at Community, so this only answers old links.
 *
 * Mounted BEFORE the SEO middleware (server/seo/seo.js). It used to be mounted after it, so every
 * HTML navigation, crawlers included, got Live's own server-rendered copy of the paste, with a
 * canonical on openvibe.live, while only non-HTML clients got the redirect: two indexable pages,
 * each naming itself canonical, and a different answer for people and machines. Now every client
 * gets the same 301 and openvibe.community is the one canonical home (roadmap 32.2).
 *
 * /pastes itself stays on Live: it is the Content feed with the Pastes filter (public/js/content-feed.js).
 */

const communityUrl = () => (process.env.OV_COMMUNITY_URL || 'https://openvibe.community').replace(/\/$/, '');

/** Mount the /p/:slug redirect to Community. */
function register(app) {
    app.get('/p/:slug', (req, res) => res.redirect(301, `${communityUrl()}/p/${encodeURIComponent(req.params.slug)}`));
}

module.exports = { register, communityUrl };
