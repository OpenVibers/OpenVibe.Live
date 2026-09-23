'use strict';
/**
 * The HTTP status of a page path, for the SPA fallback in server/index.js.
 *
 * Every page is the same shell (public/index.html) rendered by the client router, so a typo, a
 * deleted VOD and a channel that never existed all used to answer 200: soft 404s that search
 * engines index and uptime checks cannot see. The fallback now asks statusFor() and sends the same
 * shell with 404 when the path names nothing; the client router still boots and renders its
 * not-found view (showNotFound in public/js/app.js).
 *
 * The pages, mirroring routeFromURL() in public/js/app.js and the routes in public/features.json
 * (server/seo/seo.js renders the crawlable ones first and hands anything it cannot find to the
 * fallback):
 *
 *   /                                                   home
 *   /content /moments                                   the feeds (people's work, AI's)
 *   /vods /clips /pastes /updates /documentation        exact path (the first three are /content filtered)
 *   /settings /admin /themes                            exact path (the client redirects them)
 *   /dashboard/… /broadcast/… /chat/… /arena/…          any depth: these pages route sub-paths themselves
 *   /@user  /@user/<slot>                               a user that exists
 *   /vod/:id  /clip/:id                                 a Media item this visitor may see — a private
 *                                                       one is missing to everyone but its owners and
 *                                                       staff (server/media-proxy/access.js)
 *   /p/:slug                                            a paste that exists
 *   /recap/:streamId  /stream/:id                       a stream that exists
 *
 * Everything else is 404. Server routes (API, docs, overlays, popouts, legal pages, static files)
 * answer before the fallback and are not affected.
 *
 * Cost: the home page and the fixed routes are a table lookup. Users and streams are one SQLite
 * read. Media items and pastes are fetched once per id per minute (concurrent requests share the
 * fetch) and a visitor waits at most LOOKUP_DEADLINE_MS for one. When Media or Community cannot
 * answer in time, the page answers 200: an outage upstream must never turn real pages into 404s.
 */
const db = require('../db/database');
const media = require('../media-client');
const access = require('../media-proxy/access');

const OK = 200;
const NOT_FOUND = 404;

// Pages that exist only at their exact path.
const EXACT = new Set(['content', 'moments', 'vods', 'clips', 'pastes', 'updates', 'documentation', 'settings', 'admin', 'themes']);
// Pages that route their own sub-paths (dashboard tabs, broadcast slots, chat rooms, arena fighters).
const PREFIX = new Set(['dashboard', 'broadcast', 'chat', 'arena']);

// The client's channel-name rule (CHANNEL_USERNAME_RE in public/js/app.js); anything else it
// never treats as a channel.
const CHANNEL_RE = /^@+([A-Za-z0-9_]{3,24})$/;
const ID_RE = /^\d{1,15}$/;
const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;

const FOUND_TTL_MS = 60_000;        // an item's visibility may change; a minute of staleness is fine
const MISSING_TTL_MS = 30_000;      // short, so a brand-new item is not a 404 for long
const UNKNOWN_TTL_MS = 10_000;      // upstream failed: retry soon, and answer 200 meanwhile
const LOOKUP_DEADLINE_MS = 2500;
const CACHE_MAX = 2000;

const MISSING = Symbol('missing');
const UNKNOWN = Symbol('unknown');

const _cache = new Map();   // key -> { at, ttl, value, pending }

/** Only the fields the visibility rule reads — the cache never holds titles or descriptions. */
function slimMediaRow(row) {
    if (!row || typeof row !== 'object') return MISSING;
    return {
        user_id: row.user_id ?? null,
        channel_user_id: row.channel_user_id ?? null,
        stream_id: row.stream_id ?? null,
        visibility: row.visibility ?? null,
        is_public: row.is_public ?? null,
    };
}

const isMissingError = (err) => !!err && (err.status === 404 || err.status === 410);

/**
 * The cached answer for `key`, loading it at most once at a time. Resolves within
 * LOOKUP_DEADLINE_MS; a slower load keeps running and fills the cache for the next request.
 */
function lookup(key, load) {
    const now = Date.now();
    let entry = _cache.get(key);
    if (!entry || (!entry.pending && now - entry.at >= entry.ttl)) {
        entry = { at: now, ttl: UNKNOWN_TTL_MS, value: UNKNOWN, pending: null };
        entry.pending = Promise.resolve()
            .then(load)
            .then(
                (value) => { entry.value = value; entry.ttl = value === MISSING ? MISSING_TTL_MS : FOUND_TTL_MS; },
                (err) => {
                    entry.value = isMissingError(err) ? MISSING : UNKNOWN;
                    entry.ttl = entry.value === MISSING ? MISSING_TTL_MS : UNKNOWN_TTL_MS;
                },
            )
            .then(() => { entry.at = Date.now(); entry.pending = null; return entry.value; });
        _cache.delete(key);
        _cache.set(key, entry);
        if (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value);
    }
    if (!entry.pending) return Promise.resolve(entry.value);
    let timer;
    const deadline = new Promise((resolve) => { timer = setTimeout(resolve, LOOKUP_DEADLINE_MS, UNKNOWN); });
    return Promise.race([entry.pending, deadline]).finally(() => clearTimeout(timer));
}

/** The signed-in visitor, or null. Only asked when a private item is at stake. */
function visitor(req) {
    if (req.user !== undefined) return req.user || null;
    try { require('../auth/auth').optionalAuth(req, null, () => {}); } catch { /* treat as anonymous */ }
    return req.user || null;
}

async function mediaItemStatus(req, kind, id) {
    if (!ID_RE.test(id)) return NOT_FOUND;
    const row = await lookup(`${kind}:${id}`, async () => slimMediaRow(kind === 'vod'
        ? await media.getVod(id, { timeoutMs: 10_000 })
        : await media.getClip(id, { timeoutMs: 10_000 })));
    if (row === UNKNOWN) return OK;
    if (row === MISSING) return NOT_FOUND;
    return access.canView(visitor(req), row) ? OK : NOT_FOUND;
}

async function pasteStatus(slug) {
    if (!SLUG_RE.test(slug)) return NOT_FOUND;
    const found = await lookup(`paste:${slug}`, async () => {
        const p = await require('../pastes-client').getPaste(slug);
        return p && typeof p === 'object' ? true : MISSING;
    });
    return found === MISSING ? NOT_FOUND : OK;
}

function channelStatus(segment) {
    const m = CHANNEL_RE.exec(segment);
    if (!m) return NOT_FOUND;
    try {
        return (db.getChannelByUsername(m[1]) || db.getUserByUsername(m[1])) ? OK : NOT_FOUND;
    } catch { return OK; }
}

function streamStatus(id) {
    if (!ID_RE.test(id)) return NOT_FOUND;
    try { return db.getStreamById(Number(id)) ? OK : NOT_FOUND; } catch { return OK; }
}

/**
 * 200 or 404 for a GET of `req.path`, which the SPA fallback is about to answer with the shell.
 * Never rejects.
 */
async function statusFor(req) {
    try {
        const segs = String(req.path || '/').split('/').filter(Boolean);
        if (!segs.length) return OK;
        const [first, second] = segs;
        if (segs.length === 1 && EXACT.has(first)) return OK;
        if (PREFIX.has(first)) return OK;
        if (first.startsWith('@')) return segs.length <= 2 ? channelStatus(first) : NOT_FOUND;
        if (segs.length !== 2) return NOT_FOUND;
        switch (first) {
            case 'vod': return await mediaItemStatus(req, 'vod', second);
            case 'clip': return await mediaItemStatus(req, 'clip', second);
            case 'p': return await pasteStatus(second);
            case 'recap':
            case 'stream': return streamStatus(second);
            default: return NOT_FOUND;
        }
    } catch (err) {
        console.warn('[PageStatus]', req.path, '-', err && err.message);
        return OK;
    }
}

/**
 * The SPA fallback (server/index.js mounts it last, as `app.get('*')`): the shell for every page
 * path, with the status statusFor() decides. `sendShell(res, urlPath)` sends index.html rendered
 * for that path and returns false when the shell is unavailable.
 */
function spaFallback(sendShell) {
    return async (req, res, next) => {
        // Don't serve HTML for API routes
        if (req.url.startsWith('/api/') || req.url.startsWith('/ws/')) {
            return res.status(404).json({ error: 'Not found' });
        }
        const status = await statusFor(req);
        if (res.headersSent) return;
        try {
            res.status(status);
            if (!sendShell(res, req.path)) res.status(503).type('text/plain').send('Site shell unavailable');
        } catch (err) { next(err); }   // an async handler's throw would otherwise never reach Express
    };
}

/** Forget cached lookups (tests; or after a change that must show at once). */
function clearCache() { _cache.clear(); }

module.exports = { statusFor, spaFallback, clearCache, EXACT, PREFIX, LOOKUP_DEADLINE_MS };
