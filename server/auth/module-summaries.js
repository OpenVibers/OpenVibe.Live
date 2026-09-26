'use strict';
/**
 * Live's user modules on OpenVibe.Network (openvibe-contracts 0.41.0, roadmap WS-B task 9):
 *
 *   live.profile  channel_url, followers, is_streamer, last_live_at (public), stream_minutes_30d
 *   live.stats    streams_30d, stream_minutes_30d, peak_viewers_30d (public), avg_viewers_30d,
 *                 new_followers_30d, computed_at
 *   live.loyalty  channel_points_total, channels (top ten by points), arena_level, arena_xp,
 *                 computed_at; private (contracts 0.56.0, WS-K task 9). Loyalty, never money.
 *
 * Summaries only: streams and follows stay Live's truth. Written with Live's service token (grants
 * network.modules.read/write on live.profile and live.stats), unconditionally, as the owner.
 *
 *   scan()     every 5 minutes: people whose stream ended or who gained a follower since the last scan
 *   refresh()  daily: everyone who streamed in the last 30 days (the window moves) or has followers
 *
 * A record is written only when it changed since Live last wrote it (module_summary_pushes keeps a hash),
 * so an idle day writes nothing. Only accounts with a Network subject (usr_). Off without
 * OV_OAUTH_CLIENT_SECRET, and never started under LIVE_DRILL (server/index.js).
 */
const crypto = require('crypto');
const db = require('../db/database');
const identity = require('./identity-sync');

const NETWORK_INTERNAL_URL = (process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
const CLIENT_ID = process.env.OV_OAUTH_CLIENT_ID || 'live';
const PUBLIC_BASE = (process.env.LIVE_PUBLIC_ORIGIN || 'https://openvibe.live').replace(/\/+$/, '');
const DAY_MS = 86400000;

let modulesClient = null;
const stats = { written: 0, unchanged: 0, failed: 0, lastError: null, lastScanAt: null };

function ensureSchema() {
    db.getDb().exec(`CREATE TABLE IF NOT EXISTS module_summary_pushes (
        user_id INTEGER NOT NULL,
        namespace TEXT NOT NULL,
        hash TEXT NOT NULL,
        pushed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, namespace)
    )`);
}

// SQLite CURRENT_TIMESTAMP is UTC without a zone ('2026-09-23 01:30:00').
function toIso(v) {
    if (!v) return null;
    const d = new Date(String(v).includes('T') ? v : `${String(v).replace(' ', 'T')}Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** { profile, stats } for one account, or null when it has neither streams nor followers. */
function summarize(userId, { now = Date.now() } = {}) {
    const d = db.getDb();
    const user = d.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
    if (!user) return null;
    const since = new Date(now - 30 * DAY_MS).toISOString().replace('T', ' ').slice(0, 19);
    const followers = d.prepare('SELECT COUNT(*) AS n FROM follows WHERE streamer_id = ?').get(userId).n;
    const ever = d.prepare('SELECT COUNT(*) AS n, MAX(started_at) AS last FROM streams WHERE user_id = ?').get(userId);
    if (!ever.n && !followers) return null;
    const recent = d.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(s.duration_seconds), 0) AS secs, COALESCE(MAX(s.peak_viewers), 0) AS peak,
            AVG(a.avg_viewers) AS avg
        FROM streams s LEFT JOIN stream_analytics a ON a.stream_id = s.id
        WHERE s.user_id = ? AND s.started_at >= ? AND s.is_live = 0`).get(userId, since);
    const newFollowers = d.prepare('SELECT COUNT(*) AS n FROM follows WHERE streamer_id = ? AND created_at >= ?').get(userId, since).n;
    const minutes = Math.round(Number(recent.secs) / 60);
    return {
        profile: {
            channel_url: `${PUBLIC_BASE}/@${encodeURIComponent(user.username)}`,
            followers,
            is_streamer: ever.n > 0,
            last_live_at: toIso(ever.last),
            stream_minutes_30d: minutes,
        },
        stats: {
            streams_30d: recent.n,
            stream_minutes_30d: minutes,
            peak_viewers_30d: Number(recent.peak) || 0,
            avg_viewers_30d: recent.avg == null ? 0 : Math.round(Number(recent.avg) * 10) / 10,
            new_followers_30d: newFollowers,
        },
    };
}

const LOYALTY_MIN_INTERVAL_MS = 30 * 60 * 1000; // points move while people watch: at most one write per half hour

/** live.loyalty for one account: channel points (top ten channels) and the Arena level, or null when
 *  there is nothing to say. Once a record was written, an account whose points are gone gets zeros. */
function loyaltyOf(userId) {
    const d = db.getDb();
    const channels = d.prepare(`SELECT u.username AS channel, cp.balance AS points FROM channel_points cp JOIN users u ON u.id = cp.streamer_id
        WHERE cp.user_id = ? AND cp.balance > 0 ORDER BY cp.balance DESC, u.username LIMIT 10`).all(userId)
        .map((r) => ({ channel: String(r.channel).slice(0, 64), points: r.points }));
    const total = d.prepare('SELECT COALESCE(SUM(balance), 0) AS n FROM channel_points WHERE user_id = ? AND balance > 0').get(userId).n;
    let arena = null;
    try { arena = d.prepare('SELECT xp, level FROM arena_trash_levels WHERE user_id = ?').get(userId) || null; } catch { /* the arena tables do not exist yet */ }
    if (!total && !arena) {
        const had = d.prepare("SELECT 1 FROM module_summary_pushes WHERE user_id = ? AND namespace = 'live.loyalty'").get(userId);
        return had ? { channel_points_total: 0, channels: [] } : null;
    }
    const out = { channel_points_total: total, channels };
    if (arena) { out.arena_level = Math.max(1, Number(arena.level) || 1); out.arena_xp = Math.max(0, Number(arena.xp) || 0); }
    return out;
}

function client() {
    if (modulesClient) return modulesClient;
    const clientSecret = process.env.OV_OAUTH_CLIENT_SECRET || '';
    if (!clientSecret) return null;
    const { createClient } = require('openvibe-sdk/core');
    const { createServiceTokenClient } = require('openvibe-sdk/auth');
    const { createModulesClient } = require('openvibe-sdk/modules');
    const tokens = createServiceTokenClient({ tokenUrl: `${NETWORK_INTERNAL_URL}/oauth/token`, clientId: CLIENT_ID, clientSecret });
    const core = createClient({ baseUrls: { network: NETWORK_INTERNAL_URL }, tokenProvider: tokens, retries: 1 });
    modulesClient = createModulesClient(core, { baseUrl: NETWORK_INTERNAL_URL }).forSubject;
    return modulesClient;
}

const hashOf = (data) => crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 32);

/** Write one person's records where they changed. Returns the namespaces written. */
async function push(userId, { modules = client(), now = Date.now(), force = false } = {}) {
    if (!modules) return [];
    const subject = identity.subjectOf(userId);
    if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(subject || '')) return [];
    const sum = summarize(userId, { now });
    const loyalty = loyaltyOf(userId);
    const pushes = [];
    if (sum) pushes.push(['live.profile', sum.profile], ['live.stats', sum.stats]);
    if (loyalty) pushes.push(['live.loyalty', loyalty]);
    const written = [];
    for (const [ns, data] of pushes) {
        const hash = hashOf(data);
        const last = db.getDb().prepare("SELECT hash, strftime('%s', pushed_at) * 1000 AS at FROM module_summary_pushes WHERE user_id = ? AND namespace = ?").get(userId, ns);
        if (last && last.hash === hash) { stats.unchanged++; continue; }
        if (ns === 'live.loyalty' && last && !force && now - Number(last.at) < LOYALTY_MIN_INTERVAL_MS) { stats.unchanged++; continue; }
        const body = ns === 'live.profile' ? data : { ...data, computed_at: new Date(now).toISOString() };
        try {
            await modules.put(ns, subject, body);
        } catch (err) {
            stats.failed++; stats.lastError = `${ns}: ${err.message}`;
            continue;
        }
        // pushed_at on the same clock the half-hour loyalty throttle reads (Date.now() in production).
        db.getDb().prepare(`INSERT INTO module_summary_pushes (user_id, namespace, hash, pushed_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, namespace) DO UPDATE SET hash = excluded.hash, pushed_at = excluded.pushed_at`).run(userId, ns, hash, new Date(now).toISOString().replace('T', ' ').slice(0, 19));
        stats.written++;
        written.push(ns);
    }
    return written;
}

const tableExists = (name) => Boolean(db.getDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
const arenaLog = () => tableExists('arena_xp_log');
const arenaLevels = () => tableExists('arena_trash_levels');

let lastScan = null;
/** People whose stream ended, or who gained a follower, since the previous scan. */
async function scan({ modules = client(), now = Date.now() } = {}) {
    if (!modules) return 0;
    const from = lastScan || new Date(now - 10 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const to = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
    const ids = db.getDb().prepare(`SELECT user_id AS id FROM streams WHERE ended_at >= ? AND ended_at < ?
        UNION SELECT streamer_id AS id FROM follows WHERE created_at >= ? AND created_at < ?
        UNION SELECT user_id AS id FROM streams WHERE started_at >= ? AND started_at < ?
        UNION SELECT user_id AS id FROM channel_points WHERE updated_at >= ? AND updated_at < ?${arenaLog() ? `
        UNION SELECT user_id AS id FROM arena_xp_log WHERE created_at >= ? AND created_at < ?` : ''}`).all(...Array(arenaLog() ? 5 : 4).fill([from, to]).flat()).map((r) => r.id);
    for (const id of ids) await push(id, { modules, now });
    lastScan = to;
    stats.lastScanAt = new Date(now).toISOString();
    return ids.length;
}

/** Everyone who streamed in the last 30 days (their window moves daily) or has followers. */
async function refresh({ modules = client(), now = Date.now() } = {}) {
    if (!modules) return 0;
    const since = new Date(now - 31 * DAY_MS).toISOString().replace('T', ' ').slice(0, 19);
    const ids = db.getDb().prepare(`SELECT DISTINCT user_id AS id FROM streams WHERE started_at >= ?
        UNION SELECT DISTINCT streamer_id AS id FROM follows
        UNION SELECT DISTINCT user_id AS id FROM channel_points WHERE balance > 0
        UNION SELECT user_id AS id FROM module_summary_pushes WHERE namespace = 'live.loyalty'${arenaLevels() ? `
        UNION SELECT user_id AS id FROM arena_trash_levels` : ''}`).all(since).map((r) => r.id);
    for (const id of ids) await push(id, { modules, now, force: true });
    return ids.length;
}

function init() {
    if (!process.env.OV_OAUTH_CLIENT_SECRET || process.env.LIVE_MODULE_SUMMARIES === 'off') return false;
    ensureSchema();
    const jobs = require('../utils/jobs');
    jobs.every('module-summaries-scan', 5 * 60 * 1000, () => scan(), { initialDelayMs: 90 * 1000, jitterMs: 15 * 1000 });
    jobs.every('module-summaries-refresh', DAY_MS, () => refresh(), { initialDelayMs: 10 * 60 * 1000, jitterMs: 5 * 60 * 1000 });
    return true;
}

function status() { return { ...stats }; }
function _reset() { modulesClient = null; lastScan = null; Object.assign(stats, { written: 0, unchanged: 0, failed: 0, lastError: null, lastScanAt: null }); }

module.exports = { init, ensureSchema, summarize, loyaltyOf, push, scan, refresh, status, _reset };
