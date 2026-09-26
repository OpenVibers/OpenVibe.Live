'use strict';
/**
 * GET /api/search?q=&type=&category=&channel=&cursor=  (roadmap WS-O task 10: product search boxes use the query API)
 * GET /api/search/suggest?q=&type=                        title suggestions as someone types
 *
 * Live's /search page asks OpenVibe.Search for Live's own documents (channels, VODs, clips:
 * server/events/search-documents.js and search-media-documents.js), anonymously at Search's internal
 * origin, so only public, published, indexable documents come back. → { results, next_cursor, facets? }:
 * the first page also carries the category and channel facets with counts ({ category: [{ value, count }],
 * channel: [...] }), and category=/channel= narrow to one value. 400 for a malformed query; 503 { error }
 * when Search does not answer (the page says so). /suggest → { suggestions: [{ type, id, title,
 * canonical_url }] }, [] for fewer than 2 characters, and never an error the box would have to show.
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
        for (const k of ['category', 'channel']) {
            const v = String(req.query[k] || '').trim();
            if (v && v.length <= 64 && !/[\u0000-\u001f]/.test(v)) params.set(`facet.${k}`, v);
        }
        const cursor = String(req.query.cursor || '');
        if (/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) params.set('cursor', cursor);
        else params.set('facets', 'category,channel');
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
        const facetList = (rows) => (Array.isArray(rows) ? rows.filter((r) => r && typeof r.value === 'string' && Number.isFinite(r.count)).slice(0, 8).map((r) => ({ value: r.value, count: r.count })) : []);
        res.json({
            results: body.results.map((d) => Object.fromEntries(FIELDS.filter((k) => d[k] !== undefined).map((k) => [k, d[k]]))),
            next_cursor: body.next_cursor || null,
            ...(body.facets ? { facets: { category: facetList(body.facets.category), channel: facetList(body.facets.channel) } } : {}),
        });
    });

    router.get('/suggest', async (req, res) => {
        res.set('Cache-Control', 'private, max-age=30');
        const q = String(req.query.q || '').trim().slice(0, 100);
        if (q.length < 2) return res.json({ suggestions: [] });
        const params = new URLSearchParams({ q, owner: 'live', limit: '8' });
        if (TYPES.has(req.query.type)) params.set('type', req.query.type);
        try {
            const r = await fetchImpl(`${baseUrl}/api/v1/suggest?${params}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(2000) });
            const body = r.ok ? await r.json().catch(() => null) : null;
            const list = body && Array.isArray(body.suggestions) ? body.suggestions : [];
            // Many VODs share a title ("<name>'s Stream"): one suggestion per type and title, the best-ranked.
            const seen = new Set();
            const out = [];
            for (const s of list) {
                if (!s || !TYPES.has(s.type) || !s.title) continue;
                const key = `${s.type}\u0000${String(s.title).toLowerCase()}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({ type: s.type, id: s.id, title: s.title, canonical_url: s.canonical_url });
            }
            res.json({ suggestions: out });
        } catch {
            res.json({ suggestions: [] });   // typing never shows an error; submitting does
        }
    });
    return router;
}

module.exports = { createSearchRouter };
