'use strict';
/**
 * /api/content — the Content and Moments feeds (server/content/feed.js).
 *
 *   GET /feed?type=all|vods|clips|pastes&sort=new|top&window=week|month|all&limit=&cursor=
 *       what people made (VODs, clips people cut, people's pastes)
 *   GET /moments?type=all|clips|shots|recaps&sort=new|top&window=…&limit=&cursor=
 *       what the AI made (auto-clips, AI moment pastes, AI after-show recaps)
 *
 * → { feed, type, sort, window, items: [publicFeedItem…], next: cursor|null, sources: {name: status}, partial }
 *
 * Public items only and the same answer for everyone, so it is cacheable by browsers and CDNs for
 * a short while. A bad parameter is 400; an upstream that is down or slow is never an error here
 * (the page leaves that source out and says so in `sources`).
 */
const express = require('express');
const feed = require('./feed');

const router = express.Router();

function handler(name) {
    return async (req, res) => {
        try {
            const out = await feed.page(name, req.query || {});
            // A partial page must not be kept: the next request should ask the missing source again.
            res.set('Cache-Control', out.partial ? 'no-store' : `public, max-age=${out.sort === 'top' ? 60 : 15}`);
            res.json(out);
        } catch (err) {
            if (err instanceof feed.FeedError) return res.status(err.status).json({ error: err.message });
            console.error(`[Feed] ${name}:`, err && err.message);
            res.status(500).json({ error: 'Failed to load the feed' });
        }
    };
}

router.get('/feed', handler('content'));
router.get('/moments', handler('moments'));

module.exports = router;
