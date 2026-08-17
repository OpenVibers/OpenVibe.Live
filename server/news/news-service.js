/**
 * Breaking News Service
 * 
 * Manages modular news sources, deduplication, throttling, and injection
 * into stream/global chat. Streamers can enable/disable per-stream.
 * 
 * Architecture:
 *   news-service (this) ←→ sources (reddit, newsapi, rss, ...)
 *                       → chatServer.broadcastToStream() / broadcastGlobal()
 * 
 * Settings stored in SQLite: news_settings table (per-user/global).
 * Headline dedup via in-memory Set (cleared on restart, bounded to 500).
 */
'use strict';

const db = require('../db/database');
const NewsApiSource = require('./sources/newsapi-source');
const RedditSource = require('./sources/reddit-source');
const RssSource = require('./sources/rss-source');

const MAX_DEDUP_SIZE = 500;
const MIN_INJECT_INTERVAL_MS = 3 * 60 * 1000;  // min 3 min between injections per stream
const GLOBAL_COOLDOWN_MS = 60 * 1000;           // min 1 min between ANY injection globally

class NewsService {
    constructor() {
        this._sources = new Map();
        this._seenHeadlines = new Set();
        this._chatServer = null;
        this._lastInjectPerStream = new Map(); // streamId → timestamp
        this._lastGlobalInject = 0;
        this._pendingQueue = [];               // { headline, url, source } items waiting to be injected
        this._injectTimer = null;
        this._running = false;

        // Register built-in sources
        this.registerSource(new NewsApiSource());
        this.registerSource(new RedditSource());
        this.registerSource(new RssSource());

        // Ensure DB table exists
        this._ensureSchema();
    }

    _ensureSchema() {
        try {
            db.run(`CREATE TABLE IF NOT EXISTS news_settings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                scope TEXT NOT NULL DEFAULT 'global',
                scope_id INTEGER,
                source_id TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 0,
                config TEXT DEFAULT '{}',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(scope, scope_id, source_id)
            )`);
        } catch (err) {
            console.error('[News] Schema error:', err.message);
        }
    }

    registerSource(source) {
        this._sources.set(source.id, source);
    }

    /** Attach the chat server for message injection */
    setChatServer(chatServer) {
        this._chatServer = chatServer;
    }

    /** Start all enabled sources */
    start() {
        if (this._running) return;
        this._running = true;

        // Load settings from DB
        this._loadSettings();

        // Start enabled sources
        for (const [id, source] of this._sources) {
            if (source.enabled) {
                const { valid, error } = source.validate();
                if (!valid) {
                    console.warn(`[News:${id}] Skipping — ${error}`);
                    continue;
                }
                source.start((items) => this._onItems(id, items));
                console.log(`[News] Started source: ${source.label}`);
            }
        }

        // Process queue every 30s — drip-feed headlines into chat
        this._injectTimer = setInterval(() => this._processQueue(), 30_000);
    }

    stop() {
        this._running = false;
        for (const source of this._sources.values()) source.stop();
        if (this._injectTimer) { clearInterval(this._injectTimer); this._injectTimer = null; }
    }

    /** Get all sources with their current config/status */
    getSources() {
        return Array.from(this._sources.values()).map(s => ({
            id: s.id,
            label: s.label,
            enabled: s.enabled,
            config: s.config,
            validation: s.validate(),
        }));
    }

    /** Update a source's configuration */
    updateSource(sourceId, { enabled, config } = {}) {
        const source = this._sources.get(sourceId);
        if (!source) throw new Error(`Unknown source: ${sourceId}`);

        if (config !== undefined) Object.assign(source.config, config);
        if (enabled !== undefined) source.enabled = !!enabled;

        // Persist to DB
        const configJson = JSON.stringify(source.config);
        try {
            db.run(
                `INSERT INTO news_settings (scope, scope_id, source_id, enabled, config)
                 VALUES ('global', NULL, ?, ?, ?)
                 ON CONFLICT(scope, scope_id, source_id)
                 DO UPDATE SET enabled = excluded.enabled, config = excluded.config, updated_at = CURRENT_TIMESTAMP`,
                [sourceId, source.enabled ? 1 : 0, configJson]
            );
        } catch (err) {
            console.error(`[News] Save settings error:`, err.message);
        }

        // Restart or stop the source
        source.stop();
        if (source.enabled) {
            const { valid, error } = source.validate();
            if (!valid) throw new Error(error);
            source.start((items) => this._onItems(sourceId, items));
        }
    }

    /** Check if news is enabled for a specific stream's owner */
    isEnabledForStream(streamId) {
        try {
            const row = db.get(
                `SELECT ns.enabled FROM news_settings ns WHERE ns.scope = 'user'
                 AND ns.scope_id = (SELECT user_id FROM streams WHERE id = ?) AND ns.source_id = '_master'`,
                [streamId]
            );
            // If no user-level setting, check global
            if (!row) {
                const global = db.get(`SELECT enabled FROM news_settings WHERE scope = 'global' AND source_id = '_master'`);
                return global ? !!global.enabled : false;
            }
            return !!row.enabled;
        } catch {
            return false;
        }
    }

    /** Set per-user master enable/disable */
    setUserEnabled(userId, enabled) {
        try {
            db.run(
                `INSERT INTO news_settings (scope, scope_id, source_id, enabled, config)
                 VALUES ('user', ?, '_master', ?, '{}')
                 ON CONFLICT(scope, scope_id, source_id)
                 DO UPDATE SET enabled = excluded.enabled, updated_at = CURRENT_TIMESTAMP`,
                [userId, enabled ? 1 : 0]
            );
        } catch (err) {
            console.error('[News] Set user enabled error:', err.message);
        }
    }

    /** Get per-user enabled state (null = inherit from global) */
    getUserEnabled(userId) {
        try {
            const row = db.get(
                `SELECT enabled FROM news_settings WHERE scope = 'user' AND scope_id = ? AND source_id = '_master'`,
                [userId]
            );
            return row ? !!row.enabled : null;
        } catch {
            return null;
        }
    }

    // ── Internal ──────────────────────────────────────────────

    _loadSettings() {
        try {
            const rows = db.all(`SELECT * FROM news_settings WHERE scope = 'global' AND source_id != '_master'`) || [];
            for (const row of rows) {
                const source = this._sources.get(row.source_id);
                if (!source) continue;
                source.enabled = !!row.enabled;
                try { source.config = JSON.parse(row.config || '{}'); } catch { source.config = {}; }
            }
            // Load global master switch
            const master = db.get(`SELECT enabled FROM news_settings WHERE scope = 'global' AND source_id = '_master'`);
            if (master && !master.enabled) {
                // Global kill switch — disable everything
                for (const source of this._sources.values()) source.enabled = false;
            }
        } catch (err) {
            console.error('[News] Load settings error:', err.message);
        }
    }

    _onItems(sourceId, items) {
        for (const item of items) {
            // Dedup by headline (normalized)
            const key = item.headline.toLowerCase().trim().slice(0, 100);
            if (this._seenHeadlines.has(key)) continue;
            this._seenHeadlines.add(key);

            // Bound dedup set
            if (this._seenHeadlines.size > MAX_DEDUP_SIZE) {
                const first = this._seenHeadlines.values().next().value;
                this._seenHeadlines.delete(first);
            }

            this._pendingQueue.push({ ...item, sourceId });
        }
    }

    _processQueue() {
        if (!this._chatServer || !this._pendingQueue.length) return;

        const now = Date.now();
        if (now - this._lastGlobalInject < GLOBAL_COOLDOWN_MS) return;

        const item = this._pendingQueue.shift();
        if (!item) return;

        // Inject into all active stream chats that have news enabled
        const activeStreams = this._getActiveStreamIds();
        for (const streamId of activeStreams) {
            const lastInject = this._lastInjectPerStream.get(streamId) || 0;
            if (now - lastInject < MIN_INJECT_INTERVAL_MS) continue;
            if (!this.isEnabledForStream(streamId)) continue;

            this._chatServer.broadcastToStream(streamId, {
                type: 'chat',
                message_type: 'news',
                username: '📰 Breaking News',
                message: `${item.headline}`,
                url: item.url || null,
                news_source: item.source || item.sourceId,
                timestamp: new Date().toISOString(),
                source_platform: 'news',
                system: true,
            });

            this._lastInjectPerStream.set(streamId, now);
        }

        this._lastGlobalInject = now;
    }

    _getActiveStreamIds() {
        try {
            const rows = db.all(`SELECT id FROM streams WHERE status = 'live'`) || [];
            return rows.map(r => r.id);
        } catch {
            return [];
        }
    }
}

// Singleton
module.exports = new NewsService();
