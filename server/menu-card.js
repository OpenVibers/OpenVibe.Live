'use strict';
// The menu's network card for OpenVibe.Live (frame.menu-card@1): GET /.well-known/openvibe-menu.json.
//
// Every open site publishes the cards the network's Frame menu shows for it. Live's is the "Live now" rail:
// the public channels that are live right now, the most watched first, each linking to its channel page. With
// nobody live the card is still published, with no items, and Network skips it. The file is public and CORS *,
// cached for 30 seconds (the card's ttl) so the home page's polling never hits the streams table.
//
// Only what GET /api/streams already shows anonymously is read: getLiveStreams() rows, with the 18+ channels
// the home page leaves out, capped at the schema's six items. No ingest key, channel ZIP or owner field is
// copied into the card — the items are built field by field.
const db = require('./db/database');
const contentLabels = require('./labels');

const SITE = 'live';
const BASE = 'https://openvibe.live';
const CARD_TTL_S = 30;
const CACHE_MS = CARD_TTL_S * 1000;

/** Plain words for a card: no markup, no control characters, one line, within the schema's limit. */
function plain(value, max) {
    return String(value == null ? '' : value)
        .replace(/<[^>]*>/g, ' ')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

/** The card itself. `rows` are Live's live rows in their own order (viewer_count DESC, started_at DESC). */
function cardFrom(rows, at = Date.now()) {
    const items = (Array.isArray(rows) ? rows : [])
        .filter((s) => s && s.username && !contentLabels.labelsOf(s).labels.includes('18+'))
        .slice(0, 6)
        .map((s) => {
            const viewers = Number(s.viewer_count);
            return {
                title: plain(s.display_name, 80) || plain(s.username, 80) || 'Live',
                meta: `${Number.isFinite(viewers) && viewers > 0 ? Math.round(viewers) : 0} watching`,
                url: `${BASE}/@${encodeURIComponent(String(s.username))}`,
            };
        });
    return {
        id: 'live-now',
        site: SITE,
        title: 'Live now',
        kind: 'rail',
        items,
        more: { label: 'See all', url: `${BASE}/` },
        updated_at: new Date(at).toISOString(),
        ttl_s: CARD_TTL_S,
    };
}

/**
 * A card cache with the 30 s ttl. `load` and `now` are injectable so the test can run the whole file without a
 * database; the running server uses the defaults.
 */
function createMenuCard({ load = () => db.getLiveStreams(), now = Date.now } = {}) {
    let cached = null;
    let cachedAt = 0;
    let pending = null;

    async function card() {
        const at = now();
        if (cached && at - cachedAt < CACHE_MS) return cached;
        if (pending) return pending;
        pending = (async () => {
            try {
                cached = cardFrom(await load(), at);
                cachedAt = at;
            } catch {
                // Keep the last good card rather than publish an empty rail on one database hiccup; the next
                // request retries after the cache window.
                if (!cached) {
                    cached = cardFrom([], at);
                    cachedAt = at;
                }
            }
            return cached;
        })().finally(() => { pending = null; });
        return pending;
    }

    async function handler(_req, res) {
        const body = await card();
        res.set('Cache-Control', `public, max-age=${CARD_TTL_S}`)
            .set('Access-Control-Allow-Origin', '*')
            .set('Cross-Origin-Resource-Policy', 'cross-origin')
            .json([body]);
    }

    return { card, handler, cardFrom, cacheMs: CACHE_MS };
}

module.exports = { ...createMenuCard(), createMenuCard, cardFrom, plain, SITE, CARD_TTL_S };
