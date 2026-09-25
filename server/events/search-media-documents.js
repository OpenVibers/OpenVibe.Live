'use strict';
/**
 * Live's VOD and clip pages in OpenVibe.Search (roadmap WS-O task 10; Contracts 0.45.0
 * live.index_document.* types vod and clip): Live owns the canonical /vod/<id> and /clip/<id> pages of
 * the Media items recorded from its streams (title, channel, AI overview, transcript), so Live sends
 * their Search documents through its transactional outbox (./stream-events.js), with a tombstone once
 * an item is deleted, made private or unlisted, or failed. Items come from Media (media-client), never
 * from the frozen local vods/clips tables; the AI overview and transcript are Live's vod_ai_state and
 * clip_ai_state.
 *
 *   touch(kind, id)  right after Live changes an item (the /api/vods and /api/clips routes) or Media
 *                    announces it ready or failed (server/media-proxy/outcomes.js)
 *   scan()           every 5 minutes: the newest public VODs and clips
 *   refresh()        daily: every public VOD and clip, and a tombstone for each item Search holds that
 *                    Media no longer lists as public (checked one by one before it is removed)
 *
 * A document is sent only when it changed (search_media_pushes keeps a hash and the revision, which
 * grows by one with every document or tombstone). AI clips and clips or VODs of NSFW streams are
 * indexed noindex, as the pages are. Off while the outbox is off (EVENTS_URL unset).
 */
const crypto = require('crypto');
const db = require('../db/database');
const streamEvents = require('./stream-events');

const PUBLIC_BASE = (process.env.LIVE_PUBLIC_ORIGIN || 'https://openvibe.live').replace(/\/+$/, '');
const DAY_MS = 86400000;
const PAGE = 200;
const TOUCH_DELAY_MS = Number(process.env.LIVE_SEARCH_TOUCH_DELAY_MS) || 1500;
const KINDS = ['vod', 'clip'];
const stats = { sent: 0, tombstones: 0, unchanged: 0, lastError: null };

let ready = false;
function ensureSchema() {
    if (ready) return;
    db.getDb().exec(`CREATE TABLE IF NOT EXISTS search_media_pushes (
        kind TEXT NOT NULL,
        media_id INTEGER NOT NULL,
        hash TEXT NOT NULL,
        revision INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        pushed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (kind, media_id)
    )`);
    ready = true;
}

const iso = (v) => {
    if (!v) return null;
    const d = new Date(String(v).includes('T') ? v : `${String(v).replace(' ', 'T')}Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const isAiClip = (c) => c.auto_generated === true || Number(c.auto_generated) === 1;

function aiState(kind, id) {
    const st = kind === 'clip' ? db.getClipAiState(id) : db.getVodAiState(id);
    if (!st) return {};
    let transcript = '';
    try { transcript = (JSON.parse(st.ai_transcript_json || '[]') || []).map((s) => s && s.text).filter(Boolean).join(' '); } catch { /* unreadable: none */ }
    return { overview: st.ai_overview || st.ai_overview_short || '', short: st.ai_overview_short || '', transcript };
}

/** Would Live's page for this item be public? (the same rule as its SSR meta and the Media sitemap) */
function isListable(kind, row) {
    if (!row || row.id == null) return false;
    const visibility = row.visibility || (row.is_public ? 'public' : 'private');
    if (visibility !== 'public' || row.is_public === false || Number(row.is_public) === 0) return false;
    if (kind === 'vod' && (row.is_recording || row.clips_only || row.status !== 'ready')) return false;
    if (kind === 'clip' && (row.status || 'ready') !== 'ready') return false;
    if (row.readiness && row.readiness.playable === false) return false;
    return true;
}

/** The document for one Media item, or `{ deleted: true }` when Search must not hold it. */
function documentFor(kind, row) {
    if (!isListable(kind, row)) return { deleted: true };
    const d = db.getDb();
    const ownerId = kind === 'clip' ? (row.channel_user_id || row.user_id) : row.user_id;
    const owner = ownerId != null ? d.prepare('SELECT id, username, display_name, is_banned FROM users WHERE id = ?').get(Number(ownerId)) : null;
    if (owner && owner.is_banned) return { deleted: true };
    const stream = row.stream_id != null ? d.prepare('SELECT category, is_nsfw FROM streams WHERE id = ?').get(Number(row.stream_id)) : null;
    const ch = owner ? d.prepare('SELECT chat_language FROM channels WHERE user_id = ?').get(owner.id) : null;
    const name = owner ? (owner.display_name || owner.username) : null;
    const ai = aiState(kind, row.id);
    const aiClip = kind === 'clip' && isAiClip(row);
    const fallbackTitle = kind === 'vod' ? `${name ? `${name}'s ` : ''}stream VOD` : (aiClip ? 'AI clip' : 'Clip');
    const summary = clean(ai.short || ai.overview || row.description, 4000)
        || `${kind === 'vod' ? 'Recorded live stream' : aiClip ? 'AI clip of a live stream' : 'Clip of a live stream'}${name ? ` by ${name}` : ''} on OpenVibe.Live.`;
    const facets = { duration_seconds: Math.round(Number(row.duration_seconds ?? row.duration) || 0) };
    if (owner) facets.channel = owner.username;
    if (stream && stream.category) facets.category = String(stream.category).slice(0, 200);
    if (kind === 'clip') { facets.ai_clip = aiClip; if (row.vod_id != null) facets.vod_id = String(row.vod_id); }
    const reasons = [...(aiClip ? ['ai_unreviewed'] : []), ...(stream && stream.is_nsfw ? ['sensitive'] : [])];
    const doc = {
        owner: 'live', type: kind, id: String(row.id), deleted: false, visibility: 'public',
        canonical_url: `${PUBLIC_BASE}/${kind}/${row.id}`,
        title: clean(row.title || fallbackTitle, 500),
        summary,
        body: [clean(row.description, 4000), clean(ai.overview, 8000), ai.transcript].filter(Boolean).join('\n').slice(0, 40000),
        facets, authorship: aiClip ? 'ai_generated' : 'human', publication_state: 'published', published_at: iso(row.created_at),
        indexability: reasons.length ? { decision: 'noindex', reasons } : { decision: 'index' },
    };
    if (!doc.body) delete doc.body;
    if (ch && /^[a-z]{2,3}$/.test(String(ch.chat_language || ''))) doc.language = ch.chat_language;
    return doc;
}

const hashOf = (doc) => crypto.createHash('sha256').update(JSON.stringify(doc)).digest('hex').slice(0, 32);

/** Send one item's document or tombstone when it changed. `row` null: gone. → 'sent' | 'tombstone' | 'unchanged' | 'skipped' */
function publish(kind, id, row, { now = Date.now() } = {}) {
    ensureSchema();
    if (!streamEvents.status().enabled || !KINDS.includes(kind)) return 'skipped';
    const mediaId = Number(id);
    if (!Number.isSafeInteger(mediaId) || mediaId < 1) return 'skipped';
    const doc = row ? documentFor(kind, row) : { deleted: true };
    const d = db.getDb();
    const prev = d.prepare('SELECT hash, revision, deleted FROM search_media_pushes WHERE kind = ? AND media_id = ?').get(kind, mediaId);
    if (doc.deleted && (!prev || prev.deleted)) { stats.unchanged++; return 'unchanged'; }   // never sent, or already gone
    const hash = doc.deleted ? 'deleted' : hashOf(doc);
    if (prev && prev.hash === hash) { stats.unchanged++; return 'unchanged'; }
    const revision = (prev ? prev.revision : 0) + 1;
    const sid = String(mediaId);
    d.transaction(() => {
        streamEvents.enqueue(doc.deleted
            ? { event_type: 'live.index_document.deleted', actor: { type: 'service', id: 'live' }, subject: { type: kind, id: sid, revision }, visibility: 'internal', priority: 'low', payload: { type: kind, id: sid, revision } }
            : { event_type: 'live.index_document.upserted', actor: { type: 'service', id: 'live' }, subject: { type: kind, id: sid, revision }, visibility: 'internal', priority: 'low',
                payload: { ...doc, revision, updated_at: new Date(now).toISOString() } });
        d.prepare(`INSERT INTO search_media_pushes (kind, media_id, hash, revision, deleted, pushed_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                   ON CONFLICT(kind, media_id) DO UPDATE SET hash = excluded.hash, revision = excluded.revision, deleted = excluded.deleted, pushed_at = excluded.pushed_at`)
            .run(kind, mediaId, hash, revision, doc.deleted ? 1 : 0);
    })();
    streamEvents.kick();
    if (doc.deleted) { stats.tombstones++; return 'tombstone'; }
    stats.sent++;
    return 'sent';
}

let mediaImpl = null;
const mediaClient = () => mediaImpl || require('../media-client');
const fetchOne = (kind, id, media) => (kind === 'vod' ? media.getVod(id, { timeoutMs: 10000 }) : media.getClip(id, { timeoutMs: 10000 }));

/** Re-read one item from Media and send what changed. A 404 is a deletion; any other failure changes nothing. */
async function touch(kind, id, { media = mediaClient(), now = Date.now() } = {}) {
    if (!streamEvents.status().enabled || !KINDS.includes(kind)) return 'skipped';
    let row;
    try {
        row = await fetchOne(kind, id, media);
    } catch (err) {
        if (err && err.status === 404) row = null;
        else { stats.lastError = `${kind} ${id}: ${err && err.message}`; return 'skipped'; }
    }
    return publish(kind, id, row && (row.vod || row.clip || row), { now });
}

/** Fire-and-forget touch for route and event hooks: never throws, never delays the caller. */
function touchLater(kind, ids) {
    if (!streamEvents.status().enabled || process.env.LIVE_SEARCH_DOCUMENTS === 'off') return;
    const list = [...new Set((Array.isArray(ids) ? ids : [ids]).map((v) => parseInt(v, 10)).filter((v) => v > 0))].slice(0, 500);
    if (!list.length) return;
    setTimeout(async () => {
        for (const id of list) { try { await touch(kind, id); } catch (err) { stats.lastError = err.message; } }
    }, TOUCH_DELAY_MS).unref();
}

async function listPage(kind, offset, media, limit = PAGE) {
    const r = kind === 'vod' ? await media.listVods({ limit, offset }, { timeoutMs: 20000 }) : await media.listClips({ limit, offset }, { timeoutMs: 20000 });
    return { rows: (r && (kind === 'vod' ? r.vods : r.clips)) || [], hasMore: !!(r && r.hasMore) };
}

/** The newest public items (Media lists newest first). */
async function scan({ media = mediaClient(), now = Date.now(), limit = 50 } = {}) {
    if (!streamEvents.status().enabled) return 0;
    let n = 0;
    for (const kind of KINDS) {
        try {
            const { rows } = await listPage(kind, 0, media, limit);
            for (const row of rows) { publish(kind, row.id, row, { now }); n++; }
        } catch (err) { stats.lastError = `${kind} scan: ${err.message}`; }
    }
    return n;
}

/** Every public item, then a check of each one Search holds that the listing no longer shows. */
async function refresh({ media = mediaClient(), now = Date.now(), maxPages = 100 } = {}) {
    if (!streamEvents.status().enabled) return 0;
    ensureSchema();
    let n = 0;
    for (const kind of KINDS) {
        const seen = new Set();
        let complete = false;
        try {
            for (let page = 0, offset = 0; page < maxPages; page++, offset += PAGE) {
                const { rows, hasMore } = await listPage(kind, offset, media);
                for (const row of rows) { seen.add(Number(row.id)); publish(kind, row.id, row, { now }); n++; }
                if (!hasMore || !rows.length) { complete = true; break; }
            }
        } catch (err) { stats.lastError = `${kind} refresh: ${err.message}`; }
        if (!complete) continue;   // a partial listing never removes anything
        const held = db.getDb().prepare('SELECT media_id FROM search_media_pushes WHERE kind = ? AND deleted = 0').all(kind).map((r) => r.media_id);
        for (const id of held) if (!seen.has(id)) await touch(kind, id, { media, now });
    }
    return n;
}

function init() {
    if (!streamEvents.status().enabled || process.env.LIVE_SEARCH_DOCUMENTS === 'off') return false;
    ensureSchema();
    const jobs = require('../utils/jobs');
    jobs.every('search-media-scan', 5 * 60 * 1000, () => scan(), { initialDelayMs: 3 * 60 * 1000, jitterMs: 15 * 1000 });
    jobs.every('search-media-refresh', DAY_MS, () => refresh(), { initialDelayMs: 6 * 60 * 1000, jitterMs: 60 * 1000 });
    return true;
}

/**
 * Express middleware for /api/vods and /api/clips: after a successful change (not a GET), re-check the
 * items it named (the numeric :id in the path, or `ids` in a bulk body).
 */
function afterChange(kind) {
    return (req, res, next) => {
        if (req.method === 'GET' || req.method === 'HEAD') return next();
        res.on('finish', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) return;
            const m = String(req.path || '').match(/^\/(?:clips\/)?(\d+)(?:\/|$)/);
            const ids = m ? [m[1]] : (req.body && Array.isArray(req.body.ids) ? req.body.ids : []);
            const k = kind === 'vod' && /^\/clips\//.test(String(req.path || '')) ? 'clip' : kind;
            touchLater(k, ids);
        });
        next();
    };
}

function status() { return { ...stats }; }

function _setMedia(m) { mediaImpl = m; }

module.exports = { init, ensureSchema, isListable, documentFor, publish, touch, touchLater, scan, refresh, afterChange, status, _setMedia };
