'use strict';
// The public pages the agent layer serves as Markdown twins (openvibe-shared/agent-layer), rendered by the
// same SEO middleware builder the HTML routes use, so a twin cannot drift from its page. A twin is English
// because the page itself is (the SPA translates in place in the browser); Japanese titles, bios and stream
// facts stay in Japanese in the Markdown, exactly as they are in the HTML.
//
// Recordings and clips are watched on OpenVibe.Video now: /vod/:id and /clip/:id 301 there (web/video-handover.js,
// mounted before this), so Live twins the home, the channel pages and the VOD/clip list pages it still serves.
const pages = require('./seo/pages');

const CHANNEL_PATH_RE = /^\/@([A-Za-z0-9_]{3,24})$/;
const LIST_PATHS = new Set(['/vods', '/clips']);
const CHANNEL_MAX_PAGE = 500;

function pageOf(query) {
    const raw = query && query.get('page');
    return /^\d{1,4}$/.test(String(raw || '')) ? Math.min(CHANNEL_MAX_PAGE, Math.max(1, parseInt(raw, 10))) : 1;
}

function createAgentPages() {
    async function renderPublicPage(path, { query } = {}) {
        const p = String(path || '/').replace(/\/+$/, '') || '/';
        const page = CHANNEL_PATH_RE.test(p) ? pageOf(query) : 1;
        if (p !== '/' && !CHANNEL_PATH_RE.test(p) && !LIST_PATHS.has(p)) return null;
        const meta = await pages._pageMeta(p, { page });
        if (!meta) return null;
        const html = pages.render(meta, p);
        return html ? { html, title: meta.title, updated: null } : null;
    }

    return { renderPublicPage };
}

module.exports = { createAgentPages };
