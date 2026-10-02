'use strict';
/**
 * /api/social — channel social links (server/social/links.js) and their rich previews (server/social/preview.js).
 *
 *   GET /api/social/catalog                        the platforms a link can be (name, icon, color, handle input)
 *   GET /api/social/preview/:username/:index       the preview of one link a channel saved or is connected to
 *
 * Previews fetch only links a channel shows (addressed by channel and position), never a URL from the query, so
 * this cannot be used to make the server fetch arbitrary addresses. Answers are cached on the server and for
 * five minutes in browsers and at the edge.
 */
const express = require('express');
const db = require('../db/database');
const { channelSocialLinks, catalog } = require('./links');
const { preview } = require('./preview');
const cache = require('openvibe-shared/cache-policy');

const router = express.Router();

router.get('/catalog', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ platforms: catalog() });
});

router.get('/preview/:username/:index', async (req, res) => {
    try {
        const channel = db.getChannelByUsername(String(req.params.username || ''));
        if (!channel) return res.status(404).json({ error: 'Channel not found' });
        const i = Number.parseInt(req.params.index, 10);
        const { links } = channelSocialLinks(channel, db);
        const link = Number.isInteger(i) && i >= 0 ? links[i] : null;
        if (!link) return res.status(404).json({ error: 'No such link' });
        if (link.preview === false) return res.json({ kind: link.kind, url: link.url, items: [], disabled: true });
        const p = await preview(link);
        res.set('Cache-Control', 'public, max-age=300');
        res.json(p);
    } catch (err) {
        console.error('[Social] preview error:', err.message);
        res.status(500).json({ error: 'Preview failed' });
    }
});

/**
 * X's own timeline embed, alone in a page of ours so X's script never runs on the channel page: the channel page
 * frames this only after the viewer asks for it. Its CSP allows X's widget script and frames and nothing else.
 */
function xTimelinePage(req, res) {
    const h = String(req.query.h || '');
    if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) return res.status(400).type('text/plain').send('bad handle');
    res.set('Content-Security-Policy', "default-src 'none'; script-src https://platform.twitter.com; frame-src https://platform.twitter.com https://syndication.twitter.com; img-src https: data:; style-src 'unsafe-inline' https://platform.twitter.com; frame-ancestors 'self'");
    res.set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 }));
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;background:transparent;color:#e7e9ea;font:14px system-ui,sans-serif}a{color:#1d9bf0}</style></head>
<body><a class="twitter-timeline" data-theme="dark" data-chrome="noheader nofooter noborders transparent" data-height="520" href="https://twitter.com/${h}">Posts by @${h}</a>
<script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script></body></html>`);
}

module.exports = { router, xTimelinePage };
