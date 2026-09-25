'use strict';
/**
 * GET /api/search?q=&type=&cursor=  (roadmap WS-O task 10: product search boxes use the query API)
 *
 * Live's /search page asks OpenVibe.Search for Live's own documents (channels, VODs, clips:
 * server/events/search-documents.js and search-media-documents.js), anonymously at Search's internal
 * origin, so only public, published, indexable documents come back. → { results, next_cursor };
 * 400 for a malformed query; 503 { error } when Search does not answer (the page says so).
 */
const express = require('express');

const SEARCH_URL = (process.env.OV_SEARCH_INTERNAL_URL || 'http://127.0.0.1:4710').replace(/\/+$/, '');
const TYPES = new Set(['channel', 'vod', 'clip']);
const FIELDS = ['type', 'id', 'title', 'summary', 'canonical_url', 'facets', 'snippet_html', 'authorship', 'published_at', 'updated_at'];

function createSearchRouter({ fetchImpl = globalThis.fetch, baseUrl = SEARCH_URL, timeoutMs = 4000 } = {}) {
    const router = express.Router();
    router.get('/', async (req, res) => {
        const q = String(req.query.q || '').trim().slice(0, 200);
        if (!q) return res.json({ results: [], next_cursor: null });
        const params = new URLSearchParams({ q, owner: 'live', limit: '24' });
        if (TYPES.has(req.query.type)) params.set('type', req.query.type);
        const cursor = String(req.query.cursor || '');
        if (/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) params.set('cursor', cursor);
        let r;
        try {
            r = await fetchImpl(`${baseUrl}/api/v1/search?${params}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
        } catch (err) {
            console.warn('[Search] /api/search:', err.message);
            return res.status(503).json({ error: 'Search is not answering right now' });
        }
        const body = await r.json().catch(() => null);
        if (r.status === 400) return res.status(400).json({ error: 'That search could not be read' });
        if (!r.ok || !body || !Array.isArray(body.results)) return res.status(503).json({ error: 'Search is not answering right now' });
        res.set('Cache-Control', 'private, max-age=30');
        res.json({
            results: body.results.map((d) => Object.fromEntries(FIELDS.filter((k) => d[k] !== undefined).map((k) => [k, d[k]]))),
            next_cursor: body.next_cursor || null,
        });
    });
    return router;
}

module.exports = { createSearchRouter };
