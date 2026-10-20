'use strict';
/**
 * The share cards: the og:image of every page (server/seo/pages.js), openvibe-shared/social's 1200×630 JPEGs served from
 * the pinned copy at /shared/social/<id>.jpg. `live` is the site's card; `live-rundown`, `live-content`, `live-moments`
 * and `live-chat` are page cards. Only a ?v= that matches the card's own hash is immutable; anything else that is not a
 * card falls through (to /shared's own 404).
 */
const social = require('openvibe-shared/social');
const cache = require('openvibe-shared/cache-policy');

function register(app) {
    app.get('/shared/social/:file', (req, res, next) => {
        const name = `social/${req.params.file}`;
        if (!social.isCard(name)) return next();
        const hashed = Boolean(req.query.v) && social.url(req.params.file.replace(/\.jpg$/, '')) === `/shared/${name}?v=${req.query.v}`;
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Cache-Control', cache.assetHeaders(req.originalUrl, { hashed }));
        if (hashed) res.setHeader('CDN-Cache-Control', cache.IMMUTABLE);
        res.type('jpg').sendFile(social.path(name));
    });
}

module.exports = { register };
