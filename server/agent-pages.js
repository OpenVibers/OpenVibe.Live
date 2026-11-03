'use strict';
// The public pages the agent layer serves as Markdown twins (openvibe-shared/agent-layer), rendered by the
// same SEO middleware builder the HTML routes use, so a twin cannot drift from its page. A twin is English
// because the page itself is (the SPA translates in place in the browser); Japanese titles, bios and stream
// facts stay in Japanese in the Markdown, exactly as they are in the HTML.
//
// Every page the SEO renderer serves has a twin, since its Link header names one (11-03: /content, /moments, /rundown,
// /chat, /documentation and /updates named a twin that answered 404). Recordings, clips and pastes are not twinned
// here: /vod/:id, /clip/:id and /p/:slug 301 to OpenVibe.Video and OpenVibe.Community (mounted before this).
// The docs (/docs/<name>.md) are their own Markdown files, served by server/docs/routes.js sendTwin.
const pages = require('./seo/pages');

const HANDED_OVER_RE = /^\/(?:vod|clip|p)\//;

function createAgentPages() {
    async function renderPublicPage(path, { query } = {}) {
        const p = String(path || '/').replace(/\/+$/, '') || '/';
        if (!pages.SEO_ROUTE_RE.test(p) || HANDED_OVER_RE.test(p)) return null;
        const page = pages._pageParam(p, { page: (query && query.get('page')) || '' });
        const meta = await pages._pageMeta(p, { page });
        if (!meta) return null;
        const html = pages.render(meta, p);
        return html ? { html, title: meta.title, updated: null } : null;
    }

    return { renderPublicPage };
}

module.exports = { createAgentPages };
