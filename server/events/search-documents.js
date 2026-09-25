'use strict';
/**
 * Live's channels in OpenVibe.Search (roadmap WS-O task 10; Contracts 0.44.0 live.index_document.*):
 * one document per streamer (a user with at least one stream), published through Live's transactional
 * outbox (./stream-events.js) as live.index_document.upserted, and a tombstone (.deleted) once a channel
 * is banned or gone. Search takes them through its '*.index_document.*' subscription.
 *
 *   scan()     every 5 minutes: channels whose stream started or ended, who gained a follower or whose
 *              account changed since the previous scan
 *   refresh()  daily: every channel (follower counts and the last stream move)
 *
 * A document is sent only when what Search should hold changed (search_doc_pushes keeps a hash and the
 * revision, which grows by one with every document or tombstone). NSFW channels are indexed `noindex`
 * (Search can only make that stricter). Off while the outbox is off (EVENTS_URL unset).
 */
const crypto = require('crypto');
const db = require('../db/database');
const streamEvents = require('./stream-events');

const PUBLIC_BASE = (process.env.LIVE_PUBLIC_ORIGIN || 'https://openvibe.live').replace(/\/+$/, '');
const DAY_MS = 86400000;
const stats = { sent: 0, tombstones: 0, unchanged: 0, lastError: null };

let ready = false;
function ensureSchema() {
    if (ready) return;
    db.getDb().exec(`CREATE TABLE IF NOT EXISTS search_doc_pushes (
        user_id INTEGER PRIMARY KEY,
        hash TEXT NOT NULL,
        revision INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        pushed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    ready = true;
}

const iso = (v) => {
    if (!v) return null;
    const d = new Date(String(v).includes('T') ? v : `${String(v).replace(' ', 'T')}Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** The document for one account's channel, `{ deleted: true }` when it must leave Search, or null (never a channel). */
function documentFor(userId) {
    const d = db.getDb();
    const u = d.prepare('SELECT id, username, display_name, bio, is_banned FROM users WHERE id = ?').get(userId);
    if (!u) return { deleted: true };
    const streams = d.prepare('SELECT COUNT(*) AS n, MIN(started_at) AS first FROM streams WHERE user_id = ?').get(userId);
    if (!streams.n) return null;
    if (u.is_banned) return { deleted: true };
    const ch = d.prepare('SELECT description, category, chat_language FROM channels WHERE user_id = ?').get(userId) || {};
    const last = d.prepare('SELECT title, category, is_live, is_nsfw FROM streams WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId) || {};
    const titles = d.prepare("SELECT DISTINCT title FROM streams WHERE user_id = ? AND title IS NOT NULL AND title != '' ORDER BY id DESC LIMIT 10").all(userId).map((r) => r.title);
    const followers = d.prepare('SELECT COUNT(*) AS n FROM follows WHERE streamer_id = ?').get(userId).n;
    const name = u.display_name || u.username;
    const about = String(ch.description || u.bio || '').trim();
    const lang = /^[a-z]{2,3}$/.test(String(ch.chat_language || '')) ? ch.chat_language : null;
    const doc = {
        owner: 'live', type: 'channel', id: String(u.id), deleted: false, visibility: 'public',
        canonical_url: `${PUBLIC_BASE}/@${encodeURIComponent(u.username)}`,
        title: `${name} (@${u.username})`.slice(0, 500),
        summary: (about || `${name} streams on OpenVibe.Live.`).slice(0, 4000),
        body: [about, ...titles].filter(Boolean).join('\n').slice(0, 8000),
        facets: { category: String(last.category || ch.category || 'irl').slice(0, 200), live: !!last.is_live, followers },
        authorship: 'human', publication_state: 'published', published_at: iso(streams.first),
        indexability: last.is_nsfw ? { decision: 'noindex', reasons: ['sensitive'] } : { decision: 'index' },
    };
    if (lang) doc.language = lang;
    return doc;
}

const hashOf = (doc) => crypto.createHash('sha256').update(JSON.stringify(doc)).digest('hex').slice(0, 32);

/** Send one channel's document or tombstone when it changed. → 'sent' | 'tombstone' | 'unchanged' | 'skipped' */
function publish(userId, { now = Date.now() } = {}) {
    ensureSchema();
    if (!streamEvents.status().enabled) return 'skipped';
    const doc = documentFor(userId);
    const d = db.getDb();
    const prev = d.prepare('SELECT hash, revision, deleted FROM search_doc_pushes WHERE user_id = ?').get(userId);
    if (!doc) return 'skipped';
    if (doc.deleted && (!prev || prev.deleted)) { stats.unchanged++; return 'unchanged'; }   // never sent, or already gone
    const hash = doc.deleted ? 'deleted' : hashOf(doc);
    if (prev && prev.hash === hash) { stats.unchanged++; return 'unchanged'; }
    const revision = (prev ? prev.revision : 0) + 1;
    const id = String(userId);
    d.transaction(() => {
        streamEvents.enqueue(doc.deleted
            ? { event_type: 'live.index_document.deleted', actor: { type: 'service', id: 'live' }, subject: { type: 'channel', id, revision }, visibility: 'internal', priority: 'low', payload: { type: 'channel', id, revision } }
            : { event_type: 'live.index_document.upserted', actor: { type: 'service', id: 'live' }, subject: { type: 'channel', id, revision }, visibility: 'internal', priority: 'low',
                payload: { ...doc, revision, updated_at: new Date(now).toISOString() } });
        d.prepare(`INSERT INTO search_doc_pushes (user_id, hash, revision, deleted, pushed_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                   ON CONFLICT(user_id) DO UPDATE SET hash = excluded.hash, revision = excluded.revision, deleted = excluded.deleted, pushed_at = excluded.pushed_at`)
            .run(userId, hash, revision, doc.deleted ? 1 : 0);
    })();
    streamEvents.kick();
    if (doc.deleted) { stats.tombstones++; return 'tombstone'; }
    stats.sent++;
    return 'sent';
}

let lastScan = null;
const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
function scan({ now = Date.now() } = {}) {
    if (!streamEvents.status().enabled) return 0;
    const from = lastScan || sqlTime(now - 10 * 60 * 1000);
    const to = sqlTime(now);
    const ids = db.getDb().prepare(`SELECT user_id AS id FROM streams WHERE (started_at >= @from AND started_at < @to) OR (ended_at >= @from AND ended_at < @to)
        UNION SELECT streamer_id FROM follows WHERE created_at >= @from AND created_at < @to
        UNION SELECT id FROM users WHERE updated_at >= @from AND updated_at < @to
        UNION SELECT user_id FROM channels WHERE updated_at >= @from AND updated_at < @to`).all({ from, to }).map((r) => r.id);
    for (const id of ids) { try { publish(id, { now }); } catch (err) { stats.lastError = err.message; } }
    lastScan = to;
    return ids.length;
}

function refresh({ now = Date.now() } = {}) {
    if (!streamEvents.status().enabled) return 0;
    const ids = db.getDb().prepare('SELECT DISTINCT user_id AS id FROM streams UNION SELECT user_id FROM search_doc_pushes').all().map((r) => r.id);
    for (const id of ids) { try { publish(id, { now }); } catch (err) { stats.lastError = err.message; } }
    return ids.length;
}

function init() {
    if (!streamEvents.status().enabled || process.env.LIVE_SEARCH_DOCUMENTS === 'off') return false;
    ensureSchema();
    const jobs = require('../utils/jobs');
    jobs.every('search-documents-scan', 5 * 60 * 1000, () => scan(), { initialDelayMs: 2 * 60 * 1000, jitterMs: 15 * 1000 });
    jobs.every('search-documents-refresh', DAY_MS, () => refresh(), { initialDelayMs: 4 * 60 * 1000, jitterMs: 60 * 1000 });
    return true;
}

function status() { return { ...stats }; }

module.exports = { init, ensureSchema, documentFor, publish, scan, refresh, status };
