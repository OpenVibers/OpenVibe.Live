/**
 * Live's SEO: per-route head tags and no-JS snapshots (./pages.js) and the discovery files
 * (./discovery.js), both built with openvibe-shared/seo.
 */
'use strict';
const pages = require('./pages');
const discovery = require('./discovery');

// Discovery files first, then the meta middleware. MUST be mounted BEFORE express.static (so it
// can intercept "/" and /robots.txt) and before the SPA catch-all.
function register(app) {
    discovery.register(app);
    app.use(pages.middleware);
    console.log('[SEO] per-route meta + sitemap.xml + robots.txt + llms.txt + llms-full.txt registered');
}

module.exports = {
    register,
    middleware: pages.middleware, shellHtml: pages.shellHtml, render: pages.render, _pageMeta: pages._pageMeta,
    sitemapHandler: discovery.sitemapHandler, buildSitemap: discovery.buildSitemap,
    robotsTxt: discovery.robotsTxt, llmsTxt: discovery.llmsTxt, llmsFullTxt: discovery.llmsFullTxt,
};
