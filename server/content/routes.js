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

// The same answer for everyone, so it is kept here for as long as its Cache-Control lets a browser keep it (15 s, a
// minute for "top"), and one build is shared while it runs (2026-11-19: ~530 an hour, each asking Media, Community and
// the database again; a CDN does not keep JSON). A partial page is never kept.
const QUERY_KEYS = ['type', 'sort', 'window', 'limit', 'cursor'];
const kept = new Map();   // name + query → { until, promise }
function keptPage(name, query) {
    const key = `${name}?${QUERY_KEYS.map((k) => `${k}=${String(query[k] == null ? '' : query[k]).slice(0, 200)}`).join('&')}`;
    const hit = kept.get(key);
    if (hit && (hit.until === 0 || Date.now() < hit.until)) return hit.promise;
    const entry = { until: 0, promise: null };
    entry.promise = feed.page(name, query).then((out) => {
        if (out && !out.partial) entry.until = Date.now() + (out.sort === 'top' ? 60_000 : 15_000);
        else kept.delete(key);
        return out;
    }, (err) => { kept.delete(key); throw err; });
    kept.set(key, entry);
    if (kept.size > 300) kept.delete(kept.keys().next().value);
    return entry.promise;
}

function handler(name) {
    return async (req, res) => {
        try {
            const out = await keptPage(name, req.query || {});
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
module.exports._kept = kept;
