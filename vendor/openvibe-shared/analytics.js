'use strict';

// ═══════════════════════════════════════════════════════════════
// OpenVibe — Unified Analytics Module
// Shared analytics tracking for all OpenVibe services.
// Each service stores events in its own SQLite DB using the
// same schema. The admin panel aggregates via internal API.
// ═══════════════════════════════════════════════════════════════

// ── Bot Detection ────────────────────────────────────────────

const BOT_USER_AGENTS = [
    /googlebot/i, /bingbot/i, /slurp/i, /duckduckbot/i, /baiduspider/i,
    /yandexbot/i, /facebot/i, /ia_archiver/i, /semrushbot/i, /ahrefsbot/i,
    /mj12bot/i, /dotbot/i, /petalbot/i, /rogerbot/i, /screaming frog/i,
    /seznambot/i, /sogou/i, /exabot/i, /archive\.org_bot/i, /crawler/i,
    /spider/i, /python-requests/i, /python-urllib/i, /httpx/i,
    /go-http-client/i, /java\//i, /libwww-perl/i, /wget/i, /curl/i,
    /headlesschrome/i, /phantomjs/i, /scrapy/i, /node-fetch/i,
    /axios/i, /postman/i, /insomnia/i, /lighthouse/i, /pagespeed/i,
    /gptbot/i, /chatgpt-user/i, /claudebot/i, /anthropic/i,
    /bytespider/i, /amazonbot/i, /applebot/i, /twitterbot/i,
    /facebookexternalhit/i, /linkedinbot/i, /whatsapp/i, /telegrambot/i,
    /discordbot/i, /slackbot/i, /uptimerobot/i, /pingdom/i,
    /statuscake/i, /monitoring/i, /health.?check/i,
];

const SUSPICIOUS_PATTERNS = {
    // Hits per minute thresholds
    highRequestRate: 60,
    // Pages per session in under a minute
    rapidPageViews: 20,
    // No JS execution (missing beacon)
    noJsExecution: true,
    // Accessing well-known bot traps
    honeypotPaths: ['/wp-login.php', '/xmlrpc.php', '/wp-admin', '/.env', '/admin.php', '/phpmyadmin'],
};

/**
 * Classify whether a request is from a bot.
 * Returns: { isBot: boolean, botType: string|null, confidence: number }
 */
function classifyRequest(req) {
    const ua = req.headers['user-agent'] || '';
    const ip = req.ip || req.connection?.remoteAddress || '';

    // 1. Known bot user agents
    for (const pattern of BOT_USER_AGENTS) {
        if (pattern.test(ua)) {
            return { isBot: true, botType: 'known_crawler', confidence: 0.95 };
        }
    }

    // 2. Missing or empty user agent
    if (!ua || ua.length < 10) {
        return { isBot: true, botType: 'no_useragent', confidence: 0.85 };
    }

    // 3. Honeypot paths
    const path = req.path || req.url || '';
    if (SUSPICIOUS_PATTERNS.honeypotPaths.some(p => path.toLowerCase().startsWith(p))) {
        return { isBot: true, botType: 'honeypot_hit', confidence: 0.90 };
    }

    // 4. Looks human (default)
    return { isBot: false, botType: null, confidence: 0.1 };
}


// ── Schema ───────────────────────────────────────────────────

const ANALYTICS_SCHEMA = `
    -- Page views / API hits
    CREATE TABLE IF NOT EXISTS analytics_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service TEXT NOT NULL,
        event_type TEXT NOT NULL DEFAULT 'pageview',
        path TEXT,
        method TEXT DEFAULT 'GET',
        status_code INTEGER,
        response_time_ms INTEGER,
        user_id INTEGER,
        session_id TEXT,
        ip TEXT,
        country TEXT,
        city TEXT,
        user_agent TEXT,
        referer TEXT,
        is_bot INTEGER DEFAULT 0,
        bot_type TEXT,
        device_type TEXT,
        browser TEXT,
        os TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Aggregated hourly stats (materialized by cron/timer)
    CREATE TABLE IF NOT EXISTS analytics_hourly (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service TEXT NOT NULL,
        hour TEXT NOT NULL,
        pageviews INTEGER DEFAULT 0,
        api_calls INTEGER DEFAULT 0,
        unique_visitors INTEGER DEFAULT 0,
        unique_users INTEGER DEFAULT 0,
        bot_hits INTEGER DEFAULT 0,
        avg_response_ms INTEGER DEFAULT 0,
        error_count INTEGER DEFAULT 0,
        bandwidth_bytes INTEGER DEFAULT 0,
        top_paths TEXT,
        top_referers TEXT,
        UNIQUE(service, hour)
    );

    -- Daily aggregates
    CREATE TABLE IF NOT EXISTS analytics_daily (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service TEXT NOT NULL,
        date TEXT NOT NULL,
        pageviews INTEGER DEFAULT 0,
        api_calls INTEGER DEFAULT 0,
        unique_visitors INTEGER DEFAULT 0,
        unique_users INTEGER DEFAULT 0,
        new_users INTEGER DEFAULT 0,
        bot_hits INTEGER DEFAULT 0,
        avg_response_ms INTEGER DEFAULT 0,
        error_count INTEGER DEFAULT 0,
        top_paths TEXT,
        top_referers TEXT,
        top_countries TEXT,
        device_breakdown TEXT,
        browser_breakdown TEXT,
        UNIQUE(service, date)
    );

    -- Rate tracking for bot detection
    CREATE TABLE IF NOT EXISTS analytics_rate_tracking (
        ip TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        hit_count INTEGER DEFAULT 1,
        PRIMARY KEY (ip, window_start)
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_analytics_events_created ON analytics_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_analytics_events_service ON analytics_events(service, created_at);
    CREATE INDEX IF NOT EXISTS idx_analytics_events_path ON analytics_events(service, path, created_at);
    CREATE INDEX IF NOT EXISTS idx_analytics_events_ip ON analytics_events(ip, created_at);
    CREATE INDEX IF NOT EXISTS idx_analytics_events_bot ON analytics_events(is_bot, created_at);
    CREATE INDEX IF NOT EXISTS idx_analytics_events_user ON analytics_events(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_analytics_hourly_lookup ON analytics_hourly(service, hour);
    CREATE INDEX IF NOT EXISTS idx_analytics_daily_lookup ON analytics_daily(service, date);
`;


// ── Device/Browser Parsing (lightweight) ─────────────────────

function parseUserAgent(ua) {
    if (!ua) return { device: 'unknown', browser: 'unknown', os: 'unknown' };

    // Device
    let device = 'desktop';
    if (/mobile|android|iphone|ipod/i.test(ua)) device = 'mobile';
    else if (/ipad|tablet/i.test(ua)) device = 'tablet';

    // Browser
    let browser = 'other';
    if (/edg\//i.test(ua)) browser = 'edge';
    else if (/opr\/|opera/i.test(ua)) browser = 'opera';
    else if (/firefox\//i.test(ua)) browser = 'firefox';
    else if (/chrome\//i.test(ua) && !/chromium/i.test(ua)) browser = 'chrome';
    else if (/safari\//i.test(ua) && !/chrome/i.test(ua)) browser = 'safari';
    else if (/trident|msie/i.test(ua)) browser = 'ie';

    // OS
    let os = 'other';
    if (/windows/i.test(ua)) os = 'windows';
    else if (/macintosh|mac os/i.test(ua)) os = 'macos';
    else if (/linux/i.test(ua) && !/android/i.test(ua)) os = 'linux';
    else if (/android/i.test(ua)) os = 'android';
    else if (/iphone|ipad|ipod/i.test(ua)) os = 'ios';

    return { device, browser, os };
}


// ── Analytics Tracker Class ──────────────────────────────────

class AnalyticsTracker {
    /**
     * @param {object} db - better-sqlite3 database instance
     * @param {string} service - service name (e.g., 'live', 'openvibe-network', 'tools')
     */
    constructor(db, service) {
        this.db = db;
        this.service = service;
        this._buffer = [];
        this._flushInterval = null;
        this._aggregateInterval = null;

        // Initialize schema
        this.db.exec(ANALYTICS_SCHEMA);

        // Prepared statements
        this._insertEvent = this.db.prepare(`
            INSERT INTO analytics_events
            (service, event_type, path, method, status_code, response_time_ms,
             user_id, session_id, ip, country, city, user_agent, referer,
             is_bot, bot_type, device_type, browser, os)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        this._insertMany = this.db.transaction((events) => {
            for (const e of events) {
                this._insertEvent.run(
                    e.service, e.event_type, e.path, e.method, e.status_code, e.response_time_ms,
                    e.user_id, e.session_id, e.ip, e.country, e.city, e.user_agent, e.referer,
                    e.is_bot ? 1 : 0, e.bot_type, e.device_type, e.browser, e.os
                );
            }
        });

        this._updateRate = this.db.prepare(`
            INSERT INTO analytics_rate_tracking (ip, window_start, hit_count)
            VALUES (?, ?, 1)
            ON CONFLICT(ip, window_start) DO UPDATE SET hit_count = hit_count + 1
        `);

        this._getRate = this.db.prepare(
            'SELECT SUM(hit_count) as total FROM analytics_rate_tracking WHERE ip = ? AND window_start >= ?'
        );

        this._cleanRates = this.db.prepare(
            'DELETE FROM analytics_rate_tracking WHERE window_start < ?'
        );

        // Start flush timer (write buffered events every 5s)
        this._flushInterval = setInterval(() => this.flush(), 5000);

        // Hourly aggregation timer
        this._aggregateInterval = setInterval(() => this.aggregate(), 60 * 60 * 1000);

        // Initial aggregation on startup (catch up)
        setTimeout(() => this.aggregate(), 10_000);

        // Clean old rate tracking every 10 min
        setInterval(() => {
            const cutoff = Math.floor(Date.now() / 1000) - 300;
            try { this._cleanRates.run(cutoff); } catch {}
        }, 10 * 60 * 1000);
    }

    /**
     * Express middleware for automatic request tracking.
     * Tracks page views and API calls with response times.
     */
    middleware() {
        return (req, res, next) => {
            // Skip health checks and static assets
            const path = req.path || '';
            if (path === '/api/health' || path === '/health' ||
                /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map)$/i.test(path)) {
                return next();
            }

            const startTime = Date.now();

            // Hook into response finish
            const originalEnd = res.end;
            res.end = (...args) => {
                res.end = originalEnd;
                res.end(...args);

                const responseTime = Date.now() - startTime;
                const botCheck = classifyRequest(req);
                const parsed = parseUserAgent(req.headers['user-agent'] || '');

                const isApi = path.startsWith('/api/') || path.startsWith('/internal/') || path.startsWith('/oauth/');
                const eventType = isApi ? 'api_call' : 'pageview';

                // Rate-based bot detection
                const ip = req.ip || '';
                const windowStart = Math.floor(Date.now() / 60000); // 1-minute windows
                try {
                    this._updateRate.run(ip, windowStart);
                    if (!botCheck.isBot) {
                        const rateData = this._getRate.get(ip, windowStart - 1);
                        if (rateData && rateData.total > SUSPICIOUS_PATTERNS.highRequestRate) {
                            botCheck.isBot = true;
                            botCheck.botType = 'rate_limit';
                            botCheck.confidence = 0.80;
                        }
                    }
                } catch {}

                // Get session ID from cookie or generate from IP+UA
                const sessionId = req.cookies?.openvibe_session ||
                    req.cookies?.ov_token?.slice(-16) ||
                    null;

                this._buffer.push({
                    service: this.service,
                    event_type: eventType,
                    path: path.substring(0, 500),
                    method: req.method,
                    status_code: res.statusCode,
                    response_time_ms: responseTime,
                    user_id: req.user?.id || req.user?.sub || null,
                    session_id: sessionId,
                    ip: ip,
                    country: req.headers['cf-ipcountry'] || null,
                    city: null,
                    user_agent: (req.headers['user-agent'] || '').substring(0, 500),
                    referer: (req.headers['referer'] || '').substring(0, 500),
                    is_bot: botCheck.isBot,
                    bot_type: botCheck.botType,
                    device_type: parsed.device,
                    browser: parsed.browser,
                    os: parsed.os,
                });

                // Auto-flush if buffer gets large
                if (this._buffer.length >= 100) {
                    this.flush();
                }
            };

            next();
        };
    }

    /**
     * Track a custom event (not from HTTP request).
     */
    trackEvent(eventType, data = {}) {
        this._buffer.push({
            service: this.service,
            event_type: eventType,
            path: data.path || null,
            method: data.method || null,
            status_code: data.status_code || null,
            response_time_ms: data.response_time_ms || null,
            user_id: data.user_id || null,
            session_id: data.session_id || null,
            ip: data.ip || null,
            country: data.country || null,
            city: data.city || null,
            user_agent: data.user_agent || null,
            referer: data.referer || null,
            is_bot: data.is_bot || false,
            bot_type: data.bot_type || null,
            device_type: data.device_type || null,
            browser: data.browser || null,
            os: data.os || null,
        });
    }

    /**
     * Flush buffered events to database.
     */
    flush() {
        if (this._buffer.length === 0) return;
        const events = this._buffer.splice(0);
        try {
            this._insertMany(events);
        } catch (err) {
            console.error(`[Analytics:${this.service}] Flush error:`, err.message);
        }
    }

    /**
     * Run hourly + daily aggregation.
     */
    aggregate() {
        try {
            this._aggregateHourly();
            this._aggregateDaily();
            // Prune raw events older than 90 days
            this.db.prepare("DELETE FROM analytics_events WHERE created_at < datetime('now', '-90 days')").run();
        } catch (err) {
            console.error(`[Analytics:${this.service}] Aggregation error:`, err.message);
        }
    }

    _aggregateHourly() {
        // Aggregate last 2 hours (to catch stragglers)
        const hours = [];
        const now = new Date();
        for (let i = 0; i < 2; i++) {
            const d = new Date(now.getTime() - i * 3600000);
            hours.push(d.toISOString().slice(0, 13) + ':00:00');
        }

        const upsert = this.db.prepare(`
            INSERT OR REPLACE INTO analytics_hourly
            (service, hour, pageviews, api_calls, unique_visitors, unique_users, bot_hits, avg_response_ms, error_count, top_paths, top_referers)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const hour of hours) {
            const nextHour = new Date(new Date(hour).getTime() + 3600000).toISOString().slice(0, 19).replace('T', ' ');
            const hourStart = hour.replace('T', ' ');

            const stats = this.db.prepare(`
                SELECT
                    COUNT(*) FILTER (WHERE event_type = 'pageview') AS pageviews,
                    COUNT(*) FILTER (WHERE event_type = 'api_call') AS api_calls,
                    COUNT(DISTINCT ip) AS unique_visitors,
                    COUNT(DISTINCT user_id) AS unique_users,
                    COUNT(*) FILTER (WHERE is_bot = 1) AS bot_hits,
                    CAST(AVG(response_time_ms) AS INTEGER) AS avg_response_ms,
                    COUNT(*) FILTER (WHERE status_code >= 400) AS error_count
                FROM analytics_events
                WHERE service = ? AND created_at >= ? AND created_at < ?
            `).get(this.service, hourStart, nextHour);

            if (!stats || (stats.pageviews === 0 && stats.api_calls === 0)) continue;

            const topPaths = this.db.prepare(`
                SELECT path, COUNT(*) as cnt FROM analytics_events
                WHERE service = ? AND created_at >= ? AND created_at < ? AND is_bot = 0
                GROUP BY path ORDER BY cnt DESC LIMIT 10
            `).all(this.service, hourStart, nextHour);

            const topReferers = this.db.prepare(`
                SELECT referer, COUNT(*) as cnt FROM analytics_events
                WHERE service = ? AND created_at >= ? AND created_at < ? AND referer != '' AND referer IS NOT NULL AND is_bot = 0
                GROUP BY referer ORDER BY cnt DESC LIMIT 10
            `).all(this.service, hourStart, nextHour);

            upsert.run(
                this.service, hourStart,
                stats.pageviews, stats.api_calls, stats.unique_visitors, stats.unique_users,
                stats.bot_hits, stats.avg_response_ms || 0, stats.error_count,
                JSON.stringify(topPaths), JSON.stringify(topReferers)
            );
        }
    }

    _aggregateDaily() {
        // Aggregate last 2 days
        const days = [];
        const now = new Date();
        for (let i = 0; i < 2; i++) {
            const d = new Date(now.getTime() - i * 86400000);
            days.push(d.toISOString().slice(0, 10));
        }

        const upsert = this.db.prepare(`
            INSERT OR REPLACE INTO analytics_daily
            (service, date, pageviews, api_calls, unique_visitors, unique_users, new_users, bot_hits,
             avg_response_ms, error_count, top_paths, top_referers, top_countries, device_breakdown, browser_breakdown)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const date of days) {
            const dayStart = date + ' 00:00:00';
            const dayEnd = date + ' 23:59:59';

            const stats = this.db.prepare(`
                SELECT
                    COUNT(*) FILTER (WHERE event_type = 'pageview') AS pageviews,
                    COUNT(*) FILTER (WHERE event_type = 'api_call') AS api_calls,
                    COUNT(DISTINCT ip) AS unique_visitors,
                    COUNT(DISTINCT user_id) AS unique_users,
                    COUNT(*) FILTER (WHERE is_bot = 1) AS bot_hits,
                    CAST(AVG(response_time_ms) AS INTEGER) AS avg_response_ms,
                    COUNT(*) FILTER (WHERE status_code >= 400) AS error_count
                FROM analytics_events
                WHERE service = ? AND created_at >= ? AND created_at <= ?
            `).get(this.service, dayStart, dayEnd);

            if (!stats || (stats.pageviews === 0 && stats.api_calls === 0)) continue;

            const topPaths = this.db.prepare(`
                SELECT path, COUNT(*) as cnt FROM analytics_events
                WHERE service = ? AND created_at >= ? AND created_at <= ? AND is_bot = 0
                GROUP BY path ORDER BY cnt DESC LIMIT 15
            `).all(this.service, dayStart, dayEnd);

            const topReferers = this.db.prepare(`
                SELECT referer, COUNT(*) as cnt FROM analytics_events
                WHERE service = ? AND created_at >= ? AND created_at <= ? AND referer != '' AND referer IS NOT NULL AND is_bot = 0
                GROUP BY referer ORDER BY cnt DESC LIMIT 10
            `).all(this.service, dayStart, dayEnd);

            const topCountries = this.db.prepare(`
                SELECT country, COUNT(*) as cnt FROM analytics_events
                WHERE service = ? AND created_at >= ? AND created_at <= ? AND country IS NOT NULL AND is_bot = 0
                GROUP BY country ORDER BY cnt DESC LIMIT 10
            `).all(this.service, dayStart, dayEnd);

            const devices = this.db.prepare(`
                SELECT device_type, COUNT(*) as cnt FROM analytics_events
                WHERE service = ? AND created_at >= ? AND created_at <= ? AND is_bot = 0
                GROUP BY device_type ORDER BY cnt DESC
            `).all(this.service, dayStart, dayEnd);

            const browsers = this.db.prepare(`
                SELECT browser, COUNT(*) as cnt FROM analytics_events
                WHERE service = ? AND created_at >= ? AND created_at <= ? AND is_bot = 0
                GROUP BY browser ORDER BY cnt DESC
            `).all(this.service, dayStart, dayEnd);

            // New users (first seen this day)
            const newUsers = this.db.prepare(`
                SELECT COUNT(DISTINCT user_id) as cnt FROM analytics_events
                WHERE service = ? AND created_at >= ? AND created_at <= ? AND user_id IS NOT NULL
                AND user_id NOT IN (
                    SELECT DISTINCT user_id FROM analytics_events
                    WHERE service = ? AND created_at < ? AND user_id IS NOT NULL
                )
            `).get(this.service, dayStart, dayEnd, this.service, dayStart);

            upsert.run(
                this.service, date, stats.pageviews, stats.api_calls,
                stats.unique_visitors, stats.unique_users,
                newUsers?.cnt || 0, stats.bot_hits,
                stats.avg_response_ms || 0, stats.error_count,
                JSON.stringify(topPaths), JSON.stringify(topReferers),
                JSON.stringify(topCountries), JSON.stringify(devices),
                JSON.stringify(browsers)
            );
        }
    }

    /**
     * Get analytics data for the admin dashboard.
     * @param {object} options
     * @param {number} options.days - Number of days to look back (default 30)
     * @param {number} options.hours - If set, overrides days with an hour-based range (e.g. 1, 12, 24, 72)
     * @param {string} options.service - Service name override
     */
    getStats(options = {}) {
        const { days = 30, hours, service } = options;
        const svc = service || this.service;

        // Compute cutoff timestamp for raw event queries
        const rangeMs = hours ? hours * 3600000 : days * 86400000;
        const rangeCutoff = new Date(Date.now() - rangeMs).toISOString().slice(0, 19).replace('T', ' ');
        const isSubDay = hours && hours < 24;
        const effectiveDays = hours ? hours / 24 : days;

        // Daily trend (use daily aggregates for multi-day, raw events for sub-day)
        let daily = [];
        if (!isSubDay) {
            const dateCutoff = new Date(Date.now() - rangeMs).toISOString().slice(0, 10);
            daily = this.db.prepare(`
                SELECT * FROM analytics_daily
                WHERE service = ? AND date >= ?
                ORDER BY date ASC
            `).all(svc, dateCutoff);
        }

        // Hourly trend (always useful — scope to the requested range)
        const hourlyLimit = hours ? Math.min(hours, 168) : 24;
        const hourlyCutoff = new Date(Date.now() - hourlyLimit * 3600000).toISOString().slice(0, 19).replace('T', ' ');
        const hourly = this.db.prepare(`
            SELECT * FROM analytics_hourly
            WHERE service = ? AND hour >= ?
            ORDER BY hour ASC
        `).all(svc, hourlyCutoff);

        // For sub-day ranges, generate fine-grained time buckets from raw events
        let timeBuckets = [];
        if (isSubDay) {
            // 5-minute buckets for ≤1h, 15-min for ≤12h, 30-min for ≤24h
            const bucketMin = hours <= 1 ? 5 : hours <= 12 ? 15 : 30;
            timeBuckets = this.db.prepare(`
                SELECT
                    strftime('%Y-%m-%d %H:', created_at) ||
                        CAST((CAST(strftime('%M', created_at) AS INTEGER) / ${bucketMin}) * ${bucketMin} AS TEXT) as bucket,
                    COUNT(*) FILTER (WHERE event_type = 'pageview' AND is_bot = 0) AS pageviews,
                    COUNT(*) FILTER (WHERE event_type = 'api_call' AND is_bot = 0) AS api_calls,
                    COUNT(DISTINCT ip) FILTER (WHERE is_bot = 0) AS unique_visitors,
                    COUNT(*) FILTER (WHERE is_bot = 1) AS bot_hits,
                    COUNT(*) FILTER (WHERE status_code >= 400) AS errors,
                    CAST(AVG(response_time_ms) AS INTEGER) AS avg_response_ms
                FROM analytics_events
                WHERE service = ? AND created_at >= ?
                GROUP BY bucket
                ORDER BY bucket ASC
            `).all(svc, rangeCutoff);
        }

        // Summary totals — for sub-day ranges, compute from raw events
        let summary;
        if (hours && hours < 48) {
            summary = this.db.prepare(`
                SELECT
                    COUNT(*) FILTER (WHERE event_type = 'pageview' AND is_bot = 0) AS total_pageviews,
                    COUNT(*) FILTER (WHERE event_type = 'api_call' AND is_bot = 0) AS total_api_calls,
                    COUNT(DISTINCT ip) FILTER (WHERE is_bot = 0) AS total_unique_visitors,
                    COUNT(DISTINCT user_id) FILTER (WHERE is_bot = 0 AND user_id IS NOT NULL) AS total_unique_users,
                    COUNT(*) FILTER (WHERE is_bot = 1) AS total_bot_hits,
                    COUNT(*) FILTER (WHERE status_code >= 400) AS total_errors,
                    CAST(AVG(response_time_ms) AS INTEGER) AS avg_response_ms
                FROM analytics_events
                WHERE service = ? AND created_at >= ?
            `).get(svc, rangeCutoff);
        } else {
            const dateCutoff = new Date(Date.now() - rangeMs).toISOString().slice(0, 10);
            summary = this.db.prepare(`
                SELECT
                    SUM(pageviews) as total_pageviews,
                    SUM(api_calls) as total_api_calls,
                    SUM(unique_visitors) as total_unique_visitors,
                    SUM(unique_users) as total_unique_users,
                    SUM(bot_hits) as total_bot_hits,
                    SUM(error_count) as total_errors,
                    CAST(AVG(avg_response_ms) AS INTEGER) as avg_response_ms
                FROM analytics_daily
                WHERE service = ? AND date >= ?
            `).get(svc, dateCutoff);
        }

        // Real-time (last 5 min)
        const fiveMinAgo = new Date(Date.now() - 300000).toISOString().slice(0, 19).replace('T', ' ');
        const realtime = this.db.prepare(`
            SELECT
                COUNT(*) as requests,
                COUNT(DISTINCT ip) as visitors,
                COUNT(*) FILTER (WHERE is_bot = 1) as bots
            FROM analytics_events
            WHERE service = ? AND created_at >= ?
        `).get(svc, fiveMinAgo);

        // Top pages (human only)
        const topPages = this.db.prepare(`
            SELECT path, COUNT(*) as hits, COUNT(DISTINCT ip) as visitors
            FROM analytics_events
            WHERE service = ? AND created_at >= ? AND is_bot = 0
            GROUP BY path ORDER BY hits DESC LIMIT 20
        `).all(svc, rangeCutoff);

        // Top referers
        const topReferers = this.db.prepare(`
            SELECT referer, COUNT(*) as hits
            FROM analytics_events
            WHERE service = ? AND created_at >= ?
              AND referer IS NOT NULL AND referer != '' AND is_bot = 0
            GROUP BY referer ORDER BY hits DESC LIMIT 15
        `).all(svc, rangeCutoff);

        // Bot breakdown
        const botBreakdown = this.db.prepare(`
            SELECT bot_type, COUNT(*) as hits
            FROM analytics_events
            WHERE service = ? AND created_at >= ? AND is_bot = 1
            GROUP BY bot_type ORDER BY hits DESC LIMIT 15
        `).all(svc, rangeCutoff);

        // Status code distribution
        const statusCodes = this.db.prepare(`
            SELECT
                CASE
                    WHEN status_code >= 200 AND status_code < 300 THEN '2xx'
                    WHEN status_code >= 300 AND status_code < 400 THEN '3xx'
                    WHEN status_code >= 400 AND status_code < 500 THEN '4xx'
                    WHEN status_code >= 500 THEN '5xx'
                    ELSE 'other'
                END as group_code,
                COUNT(*) as cnt
            FROM analytics_events
            WHERE service = ? AND created_at >= ?
            GROUP BY group_code ORDER BY cnt DESC
        `).all(svc, rangeCutoff);

        // Device/browser/OS breakdown
        const deviceBreakdown = this.db.prepare(`
            SELECT device_type, COUNT(*) as cnt
            FROM analytics_events
            WHERE service = ? AND created_at >= ? AND is_bot = 0
            GROUP BY device_type ORDER BY cnt DESC
        `).all(svc, rangeCutoff);

        const browserBreakdown = this.db.prepare(`
            SELECT browser, COUNT(*) as cnt
            FROM analytics_events
            WHERE service = ? AND created_at >= ? AND is_bot = 0
            GROUP BY browser ORDER BY cnt DESC
        `).all(svc, rangeCutoff);

        const osBreakdown = this.db.prepare(`
            SELECT os, COUNT(*) as cnt
            FROM analytics_events
            WHERE service = ? AND created_at >= ? AND is_bot = 0
            GROUP BY os ORDER BY cnt DESC
        `).all(svc, rangeCutoff);

        // Country breakdown
        const countryBreakdown = this.db.prepare(`
            SELECT country, COUNT(*) as cnt
            FROM analytics_events
            WHERE service = ? AND created_at >= ?
              AND country IS NOT NULL AND is_bot = 0
            GROUP BY country ORDER BY cnt DESC LIMIT 20
        `).all(svc, rangeCutoff);

        // ── Enhanced Metrics ─────────────────────────────────

        // Response time percentiles (p50, p90, p95, p99)
        let responsePercentiles = {};
        try {
            const rtRows = this.db.prepare(`
                SELECT response_time_ms FROM analytics_events
                WHERE service = ? AND created_at >= ? AND response_time_ms IS NOT NULL AND is_bot = 0
                ORDER BY response_time_ms ASC
            `).all(svc, rangeCutoff);
            if (rtRows.length > 0) {
                const vals = rtRows.map(r => r.response_time_ms);
                const pct = (p) => vals[Math.min(Math.floor(vals.length * p), vals.length - 1)];
                responsePercentiles = { p50: pct(0.5), p90: pct(0.9), p95: pct(0.95), p99: pct(0.99), max: vals[vals.length - 1] };
            }
        } catch {}

        // Bandwidth estimation (response_time_ms * rough factor isn't great,
        // but we can count requests and estimate from content-length if tracked;
        // for now, count total requests * avg page weight heuristic)
        let bandwidth = {};
        try {
            const bwData = this.db.prepare(`
                SELECT
                    COUNT(*) as total_requests,
                    COUNT(*) FILTER (WHERE event_type = 'pageview') AS page_requests,
                    COUNT(*) FILTER (WHERE event_type = 'api_call') AS api_requests,
                    SUM(CASE WHEN event_type = 'pageview' THEN 50000 ELSE 2000 END) AS estimated_bytes
                FROM analytics_events
                WHERE service = ? AND created_at >= ? AND is_bot = 0
            `).get(svc, rangeCutoff);
            if (bwData) {
                bandwidth = {
                    total_requests: bwData.total_requests || 0,
                    page_requests: bwData.page_requests || 0,
                    api_requests: bwData.api_requests || 0,
                    estimated_bytes: bwData.estimated_bytes || 0,
                };
            }
        } catch {}

        // Authenticated vs anonymous sessions
        let authBreakdown = {};
        try {
            authBreakdown = this.db.prepare(`
                SELECT
                    COUNT(*) FILTER (WHERE user_id IS NOT NULL) AS authenticated,
                    COUNT(*) FILTER (WHERE user_id IS NULL) AS anonymous,
                    COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL) AS unique_authenticated_users,
                    COUNT(DISTINCT session_id) FILTER (WHERE session_id IS NOT NULL) AS total_sessions
                FROM analytics_events
                WHERE service = ? AND created_at >= ? AND is_bot = 0
            `).get(svc, rangeCutoff) || {};
        } catch {}

        // Error rate over time (hourly for multi-day, bucketed for sub-day)
        let errorTrend = [];
        try {
            if (isSubDay) {
                const bucketMin = hours <= 1 ? 5 : hours <= 12 ? 15 : 30;
                errorTrend = this.db.prepare(`
                    SELECT
                        strftime('%Y-%m-%d %H:', created_at) ||
                            CAST((CAST(strftime('%M', created_at) AS INTEGER) / ${bucketMin}) * ${bucketMin} AS TEXT) as bucket,
                        COUNT(*) AS total,
                        COUNT(*) FILTER (WHERE status_code >= 400) AS errors,
                        COUNT(*) FILTER (WHERE status_code >= 500) AS server_errors
                    FROM analytics_events
                    WHERE service = ? AND created_at >= ? AND is_bot = 0
                    GROUP BY bucket ORDER BY bucket ASC
                `).all(svc, rangeCutoff);
            } else {
                errorTrend = this.db.prepare(`
                    SELECT hour as bucket,
                        (pageviews + api_calls) as total,
                        error_count as errors
                    FROM analytics_hourly
                    WHERE service = ? AND hour >= ?
                    ORDER BY hour ASC
                `).all(svc, hourlyCutoff);
            }
        } catch {}

        // Peak hours (which hours of day get most traffic)
        let peakHours = [];
        try {
            peakHours = this.db.prepare(`
                SELECT
                    CAST(strftime('%H', created_at) AS INTEGER) AS hour_of_day,
                    COUNT(*) AS hits,
                    COUNT(DISTINCT ip) AS visitors,
                    CAST(AVG(response_time_ms) AS INTEGER) AS avg_ms
                FROM analytics_events
                WHERE service = ? AND created_at >= ? AND is_bot = 0
                GROUP BY hour_of_day
                ORDER BY hour_of_day ASC
            `).all(svc, rangeCutoff);
        } catch {}

        // Top API endpoints (separate from top pages)
        let topApiEndpoints = [];
        try {
            topApiEndpoints = this.db.prepare(`
                SELECT path, method, COUNT(*) as hits,
                    CAST(AVG(response_time_ms) AS INTEGER) AS avg_ms,
                    COUNT(*) FILTER (WHERE status_code >= 400) AS errors
                FROM analytics_events
                WHERE service = ? AND created_at >= ? AND event_type = 'api_call' AND is_bot = 0
                GROUP BY path, method ORDER BY hits DESC LIMIT 20
            `).all(svc, rangeCutoff);
        } catch {}

        // Unique sessions count
        let sessionCount = 0;
        try {
            const sc = this.db.prepare(`
                SELECT COUNT(DISTINCT session_id) as cnt
                FROM analytics_events
                WHERE service = ? AND created_at >= ? AND session_id IS NOT NULL AND is_bot = 0
            `).get(svc, rangeCutoff);
            sessionCount = sc?.cnt || 0;
        } catch {}

        // New vs returning visitors (first-time IPs in this period vs seen before)
        let visitorTypes = {};
        try {
            visitorTypes = this.db.prepare(`
                SELECT
                    COUNT(DISTINCT ip) FILTER (
                        WHERE ip NOT IN (
                            SELECT DISTINCT ip FROM analytics_events
                            WHERE service = ? AND created_at < ? AND is_bot = 0
                        )
                    ) AS new_visitors,
                    COUNT(DISTINCT ip) FILTER (
                        WHERE ip IN (
                            SELECT DISTINCT ip FROM analytics_events
                            WHERE service = ? AND created_at < ? AND is_bot = 0
                        )
                    ) AS returning_visitors
                FROM analytics_events
                WHERE service = ? AND created_at >= ? AND is_bot = 0
            `).get(svc, rangeCutoff, svc, rangeCutoff, svc, rangeCutoff) || {};
        } catch {}

        // Slowest endpoints
        let slowestEndpoints = [];
        try {
            slowestEndpoints = this.db.prepare(`
                SELECT path, method,
                    COUNT(*) as hits,
                    CAST(AVG(response_time_ms) AS INTEGER) AS avg_ms,
                    MAX(response_time_ms) AS max_ms
                FROM analytics_events
                WHERE service = ? AND created_at >= ? AND response_time_ms IS NOT NULL AND is_bot = 0
                GROUP BY path, method
                HAVING hits >= 3
                ORDER BY avg_ms DESC LIMIT 10
            `).all(svc, rangeCutoff);
        } catch {}

        // Authenticated vs anonymous time trend
        let authTrend = [];
        try {
            if (isSubDay) {
                const bucketMin = hours <= 1 ? 5 : hours <= 12 ? 15 : 30;
                authTrend = this.db.prepare(`
                    SELECT
                        strftime('%Y-%m-%d %H:', created_at) ||
                            CAST((CAST(strftime('%M', created_at) AS INTEGER) / ${bucketMin}) * ${bucketMin} AS TEXT) as bucket,
                        COUNT(DISTINCT ip) FILTER (WHERE user_id IS NOT NULL) AS auth_visitors,
                        COUNT(DISTINCT ip) FILTER (WHERE user_id IS NULL) AS anon_visitors,
                        COUNT(*) FILTER (WHERE user_id IS NOT NULL) AS auth_hits,
                        COUNT(*) FILTER (WHERE user_id IS NULL) AS anon_hits
                    FROM analytics_events
                    WHERE service = ? AND created_at >= ? AND is_bot = 0
                    GROUP BY bucket ORDER BY bucket ASC
                `).all(svc, rangeCutoff);
            } else {
                authTrend = this.db.prepare(`
                    SELECT
                        strftime('%Y-%m-%d', created_at) AS bucket,
                        COUNT(DISTINCT ip) FILTER (WHERE user_id IS NOT NULL) AS auth_visitors,
                        COUNT(DISTINCT ip) FILTER (WHERE user_id IS NULL) AS anon_visitors,
                        COUNT(*) FILTER (WHERE user_id IS NOT NULL) AS auth_hits,
                        COUNT(*) FILTER (WHERE user_id IS NULL) AS anon_hits
                    FROM analytics_events
                    WHERE service = ? AND created_at >= ? AND is_bot = 0
                    GROUP BY bucket ORDER BY bucket ASC
                `).all(svc, rangeCutoff);
            }
        } catch {}

        return {
            service: svc,
            period_days: effectiveDays,
            period_hours: hours || null,
            summary: summary || {},
            realtime: realtime || {},
            daily,
            hourly,
            timeBuckets,
            topPages,
            topReferers,
            botBreakdown,
            statusCodes,
            deviceBreakdown,
            browserBreakdown,
            osBreakdown,
            countryBreakdown,
            // Enhanced metrics
            responsePercentiles,
            bandwidth,
            authBreakdown,
            errorTrend,
            peakHours,
            topApiEndpoints,
            sessionCount,
            visitorTypes,
            slowestEndpoints,
            authTrend,
        };
    }

    /**
     * Get a cross-service overview (for the admin panel).
     */
    getOverview(days = 30) {
        const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

        const services = this.db.prepare(`
            SELECT
                service,
                SUM(pageviews) as pageviews,
                SUM(api_calls) as api_calls,
                SUM(unique_visitors) as unique_visitors,
                SUM(unique_users) as unique_users,
                SUM(bot_hits) as bot_hits,
                SUM(error_count) as errors,
                CAST(AVG(avg_response_ms) AS INTEGER) as avg_response_ms
            FROM analytics_daily
            WHERE date >= ?
            GROUP BY service
            ORDER BY pageviews DESC
        `).all(cutoff);

        // Totals across all services
        const totals = this.db.prepare(`
            SELECT
                SUM(pageviews) as pageviews,
                SUM(api_calls) as api_calls,
                SUM(unique_visitors) as unique_visitors,
                SUM(bot_hits) as bot_hits,
                SUM(error_count) as errors
            FROM analytics_daily
            WHERE date >= ?
        `).get(cutoff);

        // Daily trend (all services combined)
        const dailyTrend = this.db.prepare(`
            SELECT date,
                SUM(pageviews) as pageviews,
                SUM(api_calls) as api_calls,
                SUM(unique_visitors) as unique_visitors,
                SUM(bot_hits) as bot_hits
            FROM analytics_daily
            WHERE date >= ?
            GROUP BY date
            ORDER BY date ASC
        `).all(cutoff);

        // Real-time all services
        const fiveMinAgo = new Date(Date.now() - 300000).toISOString().slice(0, 19).replace('T', ' ');
        const realtime = this.db.prepare(`
            SELECT
                service,
                COUNT(*) as requests,
                COUNT(DISTINCT ip) as visitors,
                COUNT(*) FILTER (WHERE is_bot = 1) as bots
            FROM analytics_events
            WHERE created_at >= ?
            GROUP BY service
        `).all(fiveMinAgo);

        return {
            period_days: days,
            totals: totals || {},
            services,
            dailyTrend,
            realtime,
        };
    }

    /**
     * Get bot analysis data.
     */
    getBotAnalysis(days = 30) {
        const daysCast = Math.min(Math.max(1, days), 365);

        // Top bot IPs
        const topBotIPs = this.db.prepare(`
            SELECT ip, COUNT(*) as hits, bot_type, user_agent,
                   MIN(created_at) as first_seen, MAX(created_at) as last_seen
            FROM analytics_events
            WHERE is_bot = 1 AND created_at >= datetime('now', '-' || ? || ' days')
            GROUP BY ip ORDER BY hits DESC LIMIT 25
        `).all(daysCast);

        // Bot vs human ratio over time
        const botTrend = this.db.prepare(`
            SELECT date,
                SUM(pageviews) + SUM(api_calls) as human_hits,
                SUM(bot_hits) as bot_hits
            FROM analytics_daily
            WHERE date >= date('now', '-' || ? || ' days')
            GROUP BY date ORDER BY date ASC
        `).all(daysCast);

        // Bot type breakdown
        const botTypes = this.db.prepare(`
            SELECT bot_type, COUNT(*) as hits, COUNT(DISTINCT ip) as unique_ips
            FROM analytics_events
            WHERE is_bot = 1 AND created_at >= datetime('now', '-' || ? || ' days')
            GROUP BY bot_type ORDER BY hits DESC
        `).all(daysCast);

        // Suspicious behavior patterns
        const suspiciousIPs = this.db.prepare(`
            SELECT ip, COUNT(*) as total_hits,
                   COUNT(*) FILTER (WHERE status_code >= 400) as error_hits,
                   COUNT(DISTINCT path) as unique_paths,
                   MIN(created_at) as first_seen,
                   MAX(created_at) as last_seen
            FROM analytics_events
            WHERE created_at >= datetime('now', '-7 days') AND is_bot = 0
            GROUP BY ip
            HAVING total_hits > 500
            ORDER BY total_hits DESC LIMIT 20
        `).all();

        return {
            topBotIPs,
            botTrend,
            botTypes,
            suspiciousIPs,
        };
    }

    /**
     * Destroy tracker (clean up timers).
     */
    destroy() {
        this.flush();
        if (this._flushInterval) clearInterval(this._flushInterval);
        if (this._aggregateInterval) clearInterval(this._aggregateInterval);
    }
}


module.exports = {
    AnalyticsTracker,
    classifyRequest,
    parseUserAgent,
    ANALYTICS_SCHEMA,
    BOT_USER_AGENTS,
    SUSPICIOUS_PATTERNS,
};
