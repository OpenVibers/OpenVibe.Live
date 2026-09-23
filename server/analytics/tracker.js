'use strict';
/**
 * Request analytics within the ADR-021 privacy bounds. Drop-in replacement for the openvibe-shared
 * AnalyticsTracker (same tables, same getStats/getOverview/getBotAnalysis shapes), minus the personal
 * data:
 *
 *   raw row      service, event_type, route template, method, status, response time, rotating session
 *                id, country (CDN header), user-agent class + browser/os/device, referer ORIGIN,
 *                bot flags, signed-in flag, timestamp. ip / user_id / city are always NULL.
 *   session id   random 16 hex chars, held in memory against the day's visitor hash; a new one after
 *                30 minutes idle and at every UTC midnight. Never derived from, or equal to, a user id.
 *   rate check   per-IP hit counters for the current and previous minute, IN MEMORY only (dropped
 *                after 2 minutes idle; analytics_rate_tracking is emptied on boot and no longer written).
 *   uniques      visitor hash = HMAC-SHA256(day salt, ip + "\n" + user agent), first 16 hex chars.
 *                The salt is random per UTC day and service (analytics_day_salts, deleted as soon as
 *                the day is over); hashes go to analytics_visitor_days only, never to raw events,
 *                and are deleted by the first aggregation after their day ends, right after that day's
 *                final hourly/daily rollup — so no hash or salt outlives its day by more than about
 *                one aggregation interval (1 h). Rollups keep only the counts.
 *
 * Retention of raw events (30 days) is ./retention.js; this tracker only writes and rolls up.
 *
 * Same file in OpenVibe.Live (server/analytics/) and OpenVibe.Tools (apps/_shared/analytics/).
 */

const crypto = require('crypto');
const { ensureSchema } = require('./schema');
const privacy = require('./privacy');
const retention = require('./retention');

const SESSION_IDLE_MS = 30 * 60 * 1000;
const MAX_TRACKED_CLIENTS = 200000;
const MAX_BUFFER = 5000;
const SESSION_ID_RE = /^[0-9a-f]{16}$/;

const pad = (n) => String(n).padStart(2, '0');
/** 'YYYY-MM-DD HH:MM:SS' in UTC, the format of CURRENT_TIMESTAMP. */
function sqlTime(ms) {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
const dayOf = (ms) => sqlTime(ms).slice(0, 10);
const hourOf = (ms) => sqlTime(ms).slice(0, 13) + ':00:00';
const parseSqlTime = (s) => Date.parse(s.replace(' ', 'T') + 'Z');

function isStaticOrHealth(path) {
    return path === '/api/health' || path === '/health' ||
        /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map)$/i.test(path);
}

class AnalyticsTracker {
    /**
     * @param {object} db       better-sqlite3 handle (its own analytics database)
     * @param {string} service  service name ('live', 'openvibe-yt', …)
     * @param {object} [opts]
     * @param {string[]} [opts.paramPrefixes]  extra words whose next path segment is a parameter
     * @param {false|object} [opts.retention]  { days = 30, intervalMs = 24 h, initialDelayMs = 5 min }:
     *        run the raw-event prune on a timer (Tools). Live passes false and schedules
     *        retention.pruneRawEvents through server/utils/jobs.js instead.
     * @param {boolean} [opts.timers=true]     false: no flush/aggregate timers (tests call flush/aggregate)
     * @param {function} [opts.now]            clock (tests)
     */
    constructor(db, service, opts = {}) {
        this.db = db;
        this.service = service;
        this._now = opts.now || Date.now;
        this._pathOpts = opts.paramPrefixes
            ? { paramPrefixes: new Set([...privacy.DEFAULT_PARAM_PREFIXES, ...opts.paramPrefixes]) }
            : undefined;
        this._buffer = [];
        this._visitors = new Map();  // `${hour}|${vhash}` -> { day, hour, vhash, authenticated }
        this._sessions = new Map();  // vhash -> { sid, last }
        this._rates = new Map();     // client ip -> { minute, count, prev }   (memory only)
        this._saltDay = null;
        this._salt = null;
        this._timers = [];

        ensureSchema(db);
        try { db.pragma('secure_delete = ON'); } catch { /* not fatal */ }
        try { db.pragma('busy_timeout = 250'); } catch { /* not fatal */ }
        db.exec('DELETE FROM analytics_rate_tracking');

        this._insertEvent = db.prepare(`
            INSERT INTO analytics_events
            (service, event_type, path, method, status_code, response_time_ms,
             user_id, session_id, ip, country, city, user_agent, referer,
             is_bot, bot_type, device_type, browser, os, authenticated, created_at)
            VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        this._upsertVisitor = db.prepare(`
            INSERT INTO analytics_visitor_days (service, day, hour, vhash, authenticated) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(service, hour, vhash) DO UPDATE SET authenticated = MAX(authenticated, excluded.authenticated)
        `);
        this._write = db.transaction((events, visitors) => {
            for (const e of events) {
                this._insertEvent.run(
                    e.service, e.event_type, e.path, e.method, e.status_code, e.response_time_ms,
                    e.session_id, e.country, e.user_agent, e.referer,
                    e.is_bot ? 1 : 0, e.bot_type, e.device_type, e.browser, e.os, e.authenticated ? 1 : 0, e.created_at,
                );
            }
            for (const v of visitors) this._upsertVisitor.run(this.service, v.day, v.hour, v.vhash, v.authenticated ? 1 : 0);
        });

        if (opts.timers !== false) {
            const every = (fn, ms) => { const t = setInterval(fn, ms); if (t.unref) t.unref(); this._timers.push(t); };
            const once = (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); this._timers.push(t); };
            every(() => { this.flush(); this._sweep(); }, 5000);
            every(() => this.aggregate(), 60 * 60 * 1000);
            once(() => this.aggregate(), 10_000);
            if (opts.retention) {
                const r = opts.retention;
                const run = () => retention.pruneRawEvents(db, { days: r.days || retention.MAX_DAYS })
                    .then((out) => { if (out.deleted) console.log(`[Analytics:${service}] pruned ${out.deleted} raw events older than ${out.cutoff}`); })
                    .catch((err) => console.error(`[Analytics:${service}] prune error:`, err.message));
                once(run, r.initialDelayMs != null ? r.initialDelayMs : 5 * 60 * 1000);
                every(run, r.intervalMs || 24 * 60 * 60 * 1000);
            }
        }
    }

    // ── Per-request reducers ──────────────────────────────────

    _daySalt(day) {
        if (this._saltDay === day) return this._salt;
        let row = this.db.prepare('SELECT salt FROM analytics_day_salts WHERE service = ? AND day = ?').get(this.service, day);
        if (!row) {
            this.db.prepare('INSERT OR IGNORE INTO analytics_day_salts (service, day, salt) VALUES (?, ?, ?)')
                .run(this.service, day, crypto.randomBytes(32).toString('hex'));
            row = this.db.prepare('SELECT salt FROM analytics_day_salts WHERE service = ? AND day = ?').get(this.service, day);
        }
        // Earlier days' salts are never needed again: their hashes are already written.
        this.db.prepare('DELETE FROM analytics_day_salts WHERE service = ? AND day < ?').run(this.service, day);
        this._saltDay = day;
        this._salt = row.salt;
        this._sessions.clear();
        return this._salt;
    }

    _visitorHash(ip, ua, day) {
        return crypto.createHmac('sha256', this._daySalt(day)).update(`${ip}\n${ua}`).digest('hex').slice(0, 16);
    }

    _sessionId(vhash, nowMs) {
        let s = this._sessions.get(vhash);
        if (!s || nowMs - s.last > SESSION_IDLE_MS) {
            s = { sid: crypto.randomBytes(8).toString('hex'), last: nowMs };
            this._sessions.set(vhash, s);
        }
        s.last = nowMs;
        return s.sid;
    }

    /** Hits from this client in the current and previous minute (memory only). */
    _rateHit(ip, nowMs) {
        const minute = Math.floor(nowMs / 60000);
        let r = this._rates.get(ip);
        if (!r) { r = { minute, count: 0, prev: 0 }; this._rates.set(ip, r); }
        if (r.minute !== minute) {
            r.prev = r.minute === minute - 1 ? r.count : 0;
            r.count = 0;
            r.minute = minute;
        }
        r.count++;
        return r.count + r.prev;
    }

    _sweep() {
        const nowMs = this._now();
        const minute = Math.floor(nowMs / 60000);
        for (const [ip, r] of this._rates) if (r.minute < minute - 1) this._rates.delete(ip);
        for (const [h, s] of this._sessions) if (nowMs - s.last > SESSION_IDLE_MS) this._sessions.delete(h);
        if (this._rates.size > MAX_TRACKED_CLIENTS) this._rates.clear();
        if (this._sessions.size > MAX_TRACKED_CLIENTS) this._sessions.clear();
    }

    _push(event, visitor) {
        if (this._buffer.length >= MAX_BUFFER) this._buffer.shift();
        this._buffer.push(event);
        if (visitor) {
            const key = `${visitor.hour}|${visitor.vhash}`;
            const prev = this._visitors.get(key);
            if (!prev) this._visitors.set(key, visitor);
            else if (visitor.authenticated) prev.authenticated = true;
        }
        if (this._buffer.length >= 100) this.flush();
    }

    /**
     * Record one finished request. `entryPath` is the path as it arrived (req.path inside a mounted
     * router is relative by the time the response finishes).
     */
    record(req, res, entryPath, responseTimeMs) {
        const nowMs = this._now();
        const headers = req.headers || {};
        const ua = String(headers['user-agent'] || '');
        const ip = String(req.ip || (req.socket && req.socket.remoteAddress) || '');
        const bot = privacy.classifyRequest({ headers, path: entryPath });
        if (this._rateHit(ip, nowMs) > privacy.HIGH_REQUEST_RATE && !bot.isBot) {
            bot.isBot = true;
            bot.botType = 'rate_limit';
            bot.confidence = 0.80;
        }
        const parsed = privacy.parseUserAgent(ua);
        const day = dayOf(nowMs);
        const vhash = this._visitorHash(ip, ua, day);
        const authenticated = !!(req.user && (req.user.id != null || req.user.sub != null));
        const isApi = entryPath.startsWith('/api/') || entryPath.startsWith('/internal/') || entryPath.startsWith('/oauth/');
        this._push({
            service: this.service,
            event_type: isApi ? 'api_call' : 'pageview',
            path: privacy.routeTemplate(req, entryPath, this._pathOpts),
            method: req.method,
            status_code: res.statusCode,
            response_time_ms: responseTimeMs,
            session_id: this._sessionId(vhash, nowMs),
            country: privacy.countryCode(headers['cf-ipcountry']),
            user_agent: privacy.uaClass(ua),
            referer: privacy.refererOrigin(headers.referer || headers.referrer),
            is_bot: bot.isBot,
            bot_type: bot.botType,
            device_type: parsed.device,
            browser: parsed.browser,
            os: parsed.os,
            authenticated,
            created_at: sqlTime(nowMs),
        }, { day, hour: hourOf(nowMs), vhash, authenticated });
    }

    /** Express middleware: one row per finished request (health checks and static assets skipped). */
    middleware() {
        return (req, res, next) => {
            const entryPath = req.path || '';
            if (isStaticOrHealth(entryPath)) return next();
            const started = Date.now();
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                try { this.record(req, res, entryPath, Date.now() - started); }
                catch (err) { console.error(`[Analytics:${this.service}] record error:`, err.message); }
            };
            res.once('finish', finish);
            res.once('close', finish);
            next();
        };
    }

    /**
     * A custom (non-HTTP) event. Personal fields in `data` (ip, user_id, city) are ignored; path,
     * referer and user_agent are reduced like a request's; session_id is kept only if it is one of
     * this tracker's rotating ids.
     */
    trackEvent(eventType, data = {}) {
        const nowMs = this._now();
        const ua = data.user_agent ? String(data.user_agent) : '';
        const parsed = ua ? privacy.parseUserAgent(ua) : {};
        this._push({
            service: this.service,
            event_type: String(eventType || 'event').slice(0, 64),
            path: data.path ? privacy.normalisePath(data.path, this._pathOpts) : null,
            method: data.method || null,
            status_code: data.status_code || null,
            response_time_ms: data.response_time_ms || null,
            session_id: SESSION_ID_RE.test(String(data.session_id || '')) ? data.session_id : null,
            country: privacy.countryCode(data.country),
            user_agent: ua ? privacy.uaClass(ua) : null,
            referer: privacy.refererOrigin(data.referer),
            is_bot: !!data.is_bot,
            bot_type: data.bot_type || null,
            device_type: data.device_type || parsed.device || null,
            browser: data.browser || parsed.browser || null,
            os: data.os || parsed.os || null,
            authenticated: !!data.authenticated,
            created_at: sqlTime(nowMs),
        }, null);
    }

    /** Write buffered events and visitor hashes. On a busy database they are kept for the next flush. */
    flush() {
        if (!this._buffer.length && !this._visitors.size) return;
        const events = this._buffer.splice(0);
        const visitors = [...this._visitors.values()];
        this._visitors.clear();
        try {
            this._write(events, visitors);
        } catch (err) {
            console.error(`[Analytics:${this.service}] Flush error:`, err.message);
            this._buffer = events.slice(-MAX_BUFFER);
            for (const v of visitors) this._visitors.set(`${v.hour}|${v.vhash}`, v);
        }
    }

    // ── Rollups ───────────────────────────────────────────────

    /**
     * Hourly + daily rollups for the last 2 hours / 2 days, plus every earlier day that still has
     * visitor hashes (finalised here), after which those hashes are deleted.
     */
    aggregate() {
        try {
            this.flush();
            const nowMs = this._now();
            const today = dayOf(nowMs);
            const hours = new Set([hourOf(nowMs), hourOf(nowMs - 3600000)]);
            const days = new Set([today, dayOf(nowMs - 86400000)]);
            const pending = this.db.prepare('SELECT DISTINCT day, hour FROM analytics_visitor_days WHERE service = ? AND day < ?').all(this.service, today);
            for (const p of pending) { hours.add(p.hour); days.add(p.day); }
            for (const h of hours) this._aggregateHour(h);
            for (const d of days) this._aggregateDay(d);
            this.db.prepare('DELETE FROM analytics_visitor_days WHERE service = ? AND day < ?').run(this.service, today);
            this.db.prepare('DELETE FROM analytics_day_salts WHERE service = ? AND day < ?').run(this.service, today);
        } catch (err) {
            console.error(`[Analytics:${this.service}] Aggregation error:`, err.message);
        }
    }

    _aggregateHour(hourStart) {
        const nextHour = sqlTime(parseSqlTime(hourStart) + 3600000);
        const svc = this.service;
        const stats = this.db.prepare(`
            SELECT
                COUNT(*) FILTER (WHERE event_type = 'pageview') AS pageviews,
                COUNT(*) FILTER (WHERE event_type = 'api_call') AS api_calls,
                COUNT(*) FILTER (WHERE is_bot = 1) AS bot_hits,
                CAST(AVG(response_time_ms) AS INTEGER) AS avg_response_ms,
                COUNT(*) FILTER (WHERE status_code >= 400) AS error_count
            FROM analytics_events
            WHERE service = ? AND created_at >= ? AND created_at < ?
        `).get(svc, hourStart, nextHour);
        if (!stats || (stats.pageviews === 0 && stats.api_calls === 0)) return;

        // Uniques only grow within a period, so never lower a stored count (restarts, or rows
        // counted before this tracker when the old one still stored IPs).
        const v = this.db.prepare('SELECT COUNT(*) AS visitors, COALESCE(SUM(authenticated), 0) AS users FROM analytics_visitor_days WHERE service = ? AND hour = ?').get(svc, hourStart);
        const prev = this.db.prepare('SELECT unique_visitors, unique_users FROM analytics_hourly WHERE service = ? AND hour = ?').get(svc, hourStart) || {};

        const topPaths = this.db.prepare(`
            SELECT path, COUNT(*) as cnt FROM analytics_events
            WHERE service = ? AND created_at >= ? AND created_at < ? AND is_bot = 0
            GROUP BY path ORDER BY cnt DESC LIMIT 10
        `).all(svc, hourStart, nextHour);
        const topReferers = this.db.prepare(`
            SELECT referer, COUNT(*) as cnt FROM analytics_events
            WHERE service = ? AND created_at >= ? AND created_at < ? AND referer != '' AND referer IS NOT NULL AND is_bot = 0
            GROUP BY referer ORDER BY cnt DESC LIMIT 10
        `).all(svc, hourStart, nextHour);

        this.db.prepare(`
            INSERT INTO analytics_hourly
            (service, hour, pageviews, api_calls, unique_visitors, unique_users, bot_hits, avg_response_ms, error_count, top_paths, top_referers)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(service, hour) DO UPDATE SET
                pageviews = excluded.pageviews, api_calls = excluded.api_calls,
                unique_visitors = excluded.unique_visitors, unique_users = excluded.unique_users,
                bot_hits = excluded.bot_hits, avg_response_ms = excluded.avg_response_ms,
                error_count = excluded.error_count, top_paths = excluded.top_paths, top_referers = excluded.top_referers
        `).run(
            svc, hourStart, stats.pageviews, stats.api_calls,
            Math.max(prev.unique_visitors || 0, v.visitors || 0), Math.max(prev.unique_users || 0, v.users || 0),
            stats.bot_hits, stats.avg_response_ms || 0, stats.error_count,
            JSON.stringify(topPaths), JSON.stringify(topReferers),
        );
    }

    _aggregateDay(date) {
        const dayStart = date + ' 00:00:00';
        const dayEnd = date + ' 23:59:59';
        const svc = this.service;
        const q = (sql) => this.db.prepare(sql);
        const stats = q(`
            SELECT
                COUNT(*) FILTER (WHERE event_type = 'pageview') AS pageviews,
                COUNT(*) FILTER (WHERE event_type = 'api_call') AS api_calls,
                COUNT(*) FILTER (WHERE is_bot = 1) AS bot_hits,
                CAST(AVG(response_time_ms) AS INTEGER) AS avg_response_ms,
                COUNT(*) FILTER (WHERE status_code >= 400) AS error_count
            FROM analytics_events
            WHERE service = ? AND created_at >= ? AND created_at <= ?
        `).get(svc, dayStart, dayEnd);
        if (!stats || (stats.pageviews === 0 && stats.api_calls === 0)) return;

        const v = q(`
            SELECT COUNT(DISTINCT vhash) AS visitors,
                   COUNT(DISTINCT CASE WHEN authenticated = 1 THEN vhash END) AS users
            FROM analytics_visitor_days WHERE service = ? AND day = ?
        `).get(svc, date);
        const prev = q('SELECT unique_visitors, unique_users, new_users FROM analytics_daily WHERE service = ? AND date = ?').get(svc, date) || {};

        const range = [svc, dayStart, dayEnd];
        const topPaths = q(`SELECT path, COUNT(*) as cnt FROM analytics_events WHERE service = ? AND created_at >= ? AND created_at <= ? AND is_bot = 0 GROUP BY path ORDER BY cnt DESC LIMIT 15`).all(...range);
        const topReferers = q(`SELECT referer, COUNT(*) as cnt FROM analytics_events WHERE service = ? AND created_at >= ? AND created_at <= ? AND referer != '' AND referer IS NOT NULL AND is_bot = 0 GROUP BY referer ORDER BY cnt DESC LIMIT 10`).all(...range);
        const topCountries = q(`SELECT country, COUNT(*) as cnt FROM analytics_events WHERE service = ? AND created_at >= ? AND created_at <= ? AND country IS NOT NULL AND is_bot = 0 GROUP BY country ORDER BY cnt DESC LIMIT 10`).all(...range);
        const devices = q(`SELECT device_type, COUNT(*) as cnt FROM analytics_events WHERE service = ? AND created_at >= ? AND created_at <= ? AND is_bot = 0 GROUP BY device_type ORDER BY cnt DESC`).all(...range);
        const browsers = q(`SELECT browser, COUNT(*) as cnt FROM analytics_events WHERE service = ? AND created_at >= ? AND created_at <= ? AND is_bot = 0 GROUP BY browser ORDER BY cnt DESC`).all(...range);

        q(`
            INSERT INTO analytics_daily
            (service, date, pageviews, api_calls, unique_visitors, unique_users, new_users, bot_hits,
             avg_response_ms, error_count, top_paths, top_referers, top_countries, device_breakdown, browser_breakdown)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(service, date) DO UPDATE SET
                pageviews = excluded.pageviews, api_calls = excluded.api_calls,
                unique_visitors = excluded.unique_visitors, unique_users = excluded.unique_users,
                new_users = excluded.new_users, bot_hits = excluded.bot_hits,
                avg_response_ms = excluded.avg_response_ms, error_count = excluded.error_count,
                top_paths = excluded.top_paths, top_referers = excluded.top_referers,
                top_countries = excluded.top_countries, device_breakdown = excluded.device_breakdown,
                browser_breakdown = excluded.browser_breakdown
        `).run(
            svc, date, stats.pageviews, stats.api_calls,
            Math.max(prev.unique_visitors || 0, v.visitors || 0), Math.max(prev.unique_users || 0, v.users || 0),
            // New users needs a user id history, which analytics no longer has: keep what was
            // recorded before, NULL (not measured) from now on.
            prev.new_users != null ? prev.new_users : null,
            stats.bot_hits, stats.avg_response_ms || 0, stats.error_count,
            JSON.stringify(topPaths), JSON.stringify(topReferers), JSON.stringify(topCountries),
            JSON.stringify(devices), JSON.stringify(browsers),
        );
    }

    // ── Reads (admin dashboards) ─────────────────────────────
    // Same shapes as before. Where the old queries counted distinct IPs or user ids over raw events,
    // these count distinct rotating session ids (all sessions / signed-in sessions); rollup-based
    // numbers (daily/hourly unique_visitors) are true unique visitors per period.

    getStats(options = {}) {
        const { days = 30, hours, service } = options;
        const svc = service || this.service;
        const nowMs = this._now();
        const rangeMs = hours ? hours * 3600000 : days * 86400000;
        const rangeCutoff = sqlTime(nowMs - rangeMs);
        const isSubDay = hours && hours < 24;
        const effectiveDays = hours ? hours / 24 : days;
        const bucketMin = hours <= 1 ? 5 : hours <= 12 ? 15 : 30;
        const bucketExpr = `strftime('%Y-%m-%d %H:', created_at) || CAST((CAST(strftime('%M', created_at) AS INTEGER) / ${bucketMin}) * ${bucketMin} AS TEXT)`;
        const q = (sql) => this.db.prepare(sql);
        const safe = (fn, fallback) => { try { return fn() || fallback; } catch { return fallback; } };

        let daily = [];
        if (!isSubDay) {
            daily = q('SELECT * FROM analytics_daily WHERE service = ? AND date >= ? ORDER BY date ASC').all(svc, dayOf(nowMs - rangeMs));
        }

        const hourlyLimit = hours ? Math.min(hours, 168) : 24;
        const hourlyCutoff = sqlTime(nowMs - hourlyLimit * 3600000);
        const hourly = q('SELECT * FROM analytics_hourly WHERE service = ? AND hour >= ? ORDER BY hour ASC').all(svc, hourlyCutoff);

        let timeBuckets = [];
        if (isSubDay) {
            timeBuckets = q(`
                SELECT ${bucketExpr} as bucket,
                    COUNT(*) FILTER (WHERE event_type = 'pageview' AND is_bot = 0) AS pageviews,
                    COUNT(*) FILTER (WHERE event_type = 'api_call' AND is_bot = 0) AS api_calls,
                    COUNT(DISTINCT session_id) FILTER (WHERE is_bot = 0) AS unique_visitors,
                    COUNT(*) FILTER (WHERE is_bot = 1) AS bot_hits,
                    COUNT(*) FILTER (WHERE status_code >= 400) AS errors,
                    CAST(AVG(response_time_ms) AS INTEGER) AS avg_response_ms
                FROM analytics_events
                WHERE service = ? AND created_at >= ?
                GROUP BY bucket ORDER BY bucket ASC
            `).all(svc, rangeCutoff);
        }

        let summary;
        if (hours && hours < 48) {
            summary = q(`
                SELECT
                    COUNT(*) FILTER (WHERE event_type = 'pageview' AND is_bot = 0) AS total_pageviews,
                    COUNT(*) FILTER (WHERE event_type = 'api_call' AND is_bot = 0) AS total_api_calls,
                    COUNT(DISTINCT session_id) FILTER (WHERE is_bot = 0) AS total_unique_visitors,
                    COUNT(DISTINCT session_id) FILTER (WHERE is_bot = 0 AND authenticated = 1) AS total_unique_users,
                    COUNT(*) FILTER (WHERE is_bot = 1) AS total_bot_hits,
                    COUNT(*) FILTER (WHERE status_code >= 400) AS total_errors,
                    CAST(AVG(response_time_ms) AS INTEGER) AS avg_response_ms
                FROM analytics_events
                WHERE service = ? AND created_at >= ?
            `).get(svc, rangeCutoff);
        } else {
            summary = q(`
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
            `).get(svc, dayOf(nowMs - rangeMs));
        }

        const realtime = q(`
            SELECT COUNT(*) as requests, COUNT(DISTINCT session_id) as visitors, COUNT(*) FILTER (WHERE is_bot = 1) as bots
            FROM analytics_events WHERE service = ? AND created_at >= ?
        `).get(svc, sqlTime(nowMs - 300000));

        const human = [svc, rangeCutoff];
        const topPages = q(`
            SELECT path, COUNT(*) as hits, COUNT(DISTINCT session_id) as visitors
            FROM analytics_events WHERE service = ? AND created_at >= ? AND is_bot = 0
            GROUP BY path ORDER BY hits DESC LIMIT 20
        `).all(...human);
        const topReferers = q(`
            SELECT referer, COUNT(*) as hits FROM analytics_events
            WHERE service = ? AND created_at >= ? AND referer IS NOT NULL AND referer != '' AND is_bot = 0
            GROUP BY referer ORDER BY hits DESC LIMIT 15
        `).all(...human);
        const botBreakdown = q(`
            SELECT bot_type, COUNT(*) as hits FROM analytics_events
            WHERE service = ? AND created_at >= ? AND is_bot = 1
            GROUP BY bot_type ORDER BY hits DESC LIMIT 15
        `).all(...human);
        const statusCodes = q(`
            SELECT CASE
                    WHEN status_code >= 200 AND status_code < 300 THEN '2xx'
                    WHEN status_code >= 300 AND status_code < 400 THEN '3xx'
                    WHEN status_code >= 400 AND status_code < 500 THEN '4xx'
                    WHEN status_code >= 500 THEN '5xx'
                    ELSE 'other' END as group_code,
                COUNT(*) as cnt
            FROM analytics_events WHERE service = ? AND created_at >= ?
            GROUP BY group_code ORDER BY cnt DESC
        `).all(...human);
        const breakdown = (col) => q(`
            SELECT ${col}, COUNT(*) as cnt FROM analytics_events
            WHERE service = ? AND created_at >= ? AND is_bot = 0
            GROUP BY ${col} ORDER BY cnt DESC
        `).all(...human);
        const deviceBreakdown = breakdown('device_type');
        const browserBreakdown = breakdown('browser');
        const osBreakdown = breakdown('os');
        const countryBreakdown = q(`
            SELECT country, COUNT(*) as cnt FROM analytics_events
            WHERE service = ? AND created_at >= ? AND country IS NOT NULL AND is_bot = 0
            GROUP BY country ORDER BY cnt DESC LIMIT 20
        `).all(...human);

        const responsePercentiles = safe(() => {
            const vals = q(`
                SELECT response_time_ms FROM analytics_events
                WHERE service = ? AND created_at >= ? AND response_time_ms IS NOT NULL AND is_bot = 0
                ORDER BY response_time_ms ASC
            `).pluck().all(...human);
            if (!vals.length) return {};
            const pct = (p) => vals[Math.min(Math.floor(vals.length * p), vals.length - 1)];
            return { p50: pct(0.5), p90: pct(0.9), p95: pct(0.95), p99: pct(0.99), max: vals[vals.length - 1] };
        }, {});

        const bandwidth = safe(() => {
            const bw = q(`
                SELECT COUNT(*) as total_requests,
                    COUNT(*) FILTER (WHERE event_type = 'pageview') AS page_requests,
                    COUNT(*) FILTER (WHERE event_type = 'api_call') AS api_requests,
                    SUM(CASE WHEN event_type = 'pageview' THEN 50000 ELSE 2000 END) AS estimated_bytes
                FROM analytics_events WHERE service = ? AND created_at >= ? AND is_bot = 0
            `).get(...human);
            return bw && {
                total_requests: bw.total_requests || 0,
                page_requests: bw.page_requests || 0,
                api_requests: bw.api_requests || 0,
                estimated_bytes: bw.estimated_bytes || 0,
            };
        }, {});

        const authBreakdown = safe(() => q(`
            SELECT
                COUNT(*) FILTER (WHERE authenticated = 1) AS authenticated,
                COUNT(*) FILTER (WHERE authenticated = 0) AS anonymous,
                COUNT(DISTINCT session_id) FILTER (WHERE authenticated = 1) AS unique_authenticated_users,
                COUNT(DISTINCT session_id) FILTER (WHERE session_id IS NOT NULL) AS total_sessions
            FROM analytics_events WHERE service = ? AND created_at >= ? AND is_bot = 0
        `).get(...human), {});

        const errorTrend = safe(() => (isSubDay
            ? q(`
                SELECT ${bucketExpr} as bucket, COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE status_code >= 400) AS errors,
                    COUNT(*) FILTER (WHERE status_code >= 500) AS server_errors
                FROM analytics_events WHERE service = ? AND created_at >= ? AND is_bot = 0
                GROUP BY bucket ORDER BY bucket ASC
            `).all(...human)
            : q(`
                SELECT hour as bucket, (pageviews + api_calls) as total, error_count as errors
                FROM analytics_hourly WHERE service = ? AND hour >= ? ORDER BY hour ASC
            `).all(svc, hourlyCutoff)), []);

        const peakHours = safe(() => q(`
            SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour_of_day, COUNT(*) AS hits,
                COUNT(DISTINCT session_id) AS visitors, CAST(AVG(response_time_ms) AS INTEGER) AS avg_ms
            FROM analytics_events WHERE service = ? AND created_at >= ? AND is_bot = 0
            GROUP BY hour_of_day ORDER BY hour_of_day ASC
        `).all(...human), []);

        const topApiEndpoints = safe(() => q(`
            SELECT path, method, COUNT(*) as hits, CAST(AVG(response_time_ms) AS INTEGER) AS avg_ms,
                COUNT(*) FILTER (WHERE status_code >= 400) AS errors
            FROM analytics_events WHERE service = ? AND created_at >= ? AND event_type = 'api_call' AND is_bot = 0
            GROUP BY path, method ORDER BY hits DESC LIMIT 20
        `).all(...human), []);

        const sessionCount = safe(() => q(`
            SELECT COUNT(DISTINCT session_id) FROM analytics_events
            WHERE service = ? AND created_at >= ? AND session_id IS NOT NULL AND is_bot = 0
        `).pluck().get(...human), 0);

        // New vs returning needs a visitor identity that outlives a day; analytics keeps none.
        const visitorTypes = { new_visitors: null, returning_visitors: null, not_collected: 'ADR-021' };

        const slowestEndpoints = safe(() => q(`
            SELECT path, method, COUNT(*) as hits, CAST(AVG(response_time_ms) AS INTEGER) AS avg_ms, MAX(response_time_ms) AS max_ms
            FROM analytics_events WHERE service = ? AND created_at >= ? AND response_time_ms IS NOT NULL AND is_bot = 0
            GROUP BY path, method HAVING hits >= 3 ORDER BY avg_ms DESC LIMIT 10
        `).all(...human), []);

        const authTrend = safe(() => q(`
            SELECT ${isSubDay ? bucketExpr : "strftime('%Y-%m-%d', created_at)"} AS bucket,
                COUNT(DISTINCT session_id) FILTER (WHERE authenticated = 1) AS auth_visitors,
                COUNT(DISTINCT session_id) FILTER (WHERE authenticated = 0) AS anon_visitors,
                COUNT(*) FILTER (WHERE authenticated = 1) AS auth_hits,
                COUNT(*) FILTER (WHERE authenticated = 0) AS anon_hits
            FROM analytics_events WHERE service = ? AND created_at >= ? AND is_bot = 0
            GROUP BY bucket ORDER BY bucket ASC
        `).all(...human), []);

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

    getOverview(days = 30) {
        const cutoff = dayOf(this._now() - days * 86400000);
        const services = this.db.prepare(`
            SELECT service, SUM(pageviews) as pageviews, SUM(api_calls) as api_calls,
                SUM(unique_visitors) as unique_visitors, SUM(unique_users) as unique_users,
                SUM(bot_hits) as bot_hits, SUM(error_count) as errors,
                CAST(AVG(avg_response_ms) AS INTEGER) as avg_response_ms
            FROM analytics_daily WHERE date >= ? GROUP BY service ORDER BY pageviews DESC
        `).all(cutoff);
        const totals = this.db.prepare(`
            SELECT SUM(pageviews) as pageviews, SUM(api_calls) as api_calls, SUM(unique_visitors) as unique_visitors,
                SUM(bot_hits) as bot_hits, SUM(error_count) as errors
            FROM analytics_daily WHERE date >= ?
        `).get(cutoff);
        const dailyTrend = this.db.prepare(`
            SELECT date, SUM(pageviews) as pageviews, SUM(api_calls) as api_calls,
                SUM(unique_visitors) as unique_visitors, SUM(bot_hits) as bot_hits
            FROM analytics_daily WHERE date >= ? GROUP BY date ORDER BY date ASC
        `).all(cutoff);
        const realtime = this.db.prepare(`
            SELECT service, COUNT(*) as requests, COUNT(DISTINCT session_id) as visitors, COUNT(*) FILTER (WHERE is_bot = 1) as bots
            FROM analytics_events WHERE created_at >= ? GROUP BY service
        `).all(sqlTime(this._now() - 300000));
        return { period_days: days, totals: totals || {}, services, dailyTrend, realtime };
    }

    /**
     * Bot analysis. There are no IPs any more: the "top bot" rows are user-agent classes
     * (`bot:<family>`), the "suspicious" rows are high-volume rotating sessions. The `ip` field is
     * kept (null) so existing dashboards render; `ua_class` / `session_id` say what the row is.
     */
    getBotAnalysis(days = 30) {
        const since = sqlTime(this._now() - Math.min(Math.max(1, days), 365) * 86400000);
        const topBotIPs = this.db.prepare(`
            SELECT NULL AS ip, user_agent AS ua_class, bot_type, COUNT(*) as hits,
                   COUNT(DISTINCT session_id) AS sessions,
                   MIN(created_at) as first_seen, MAX(created_at) as last_seen
            FROM analytics_events WHERE is_bot = 1 AND created_at >= ?
            GROUP BY user_agent, bot_type ORDER BY hits DESC LIMIT 25
        `).all(since);
        const botTrend = this.db.prepare(`
            SELECT date, SUM(pageviews) + SUM(api_calls) as human_hits, SUM(bot_hits) as bot_hits
            FROM analytics_daily WHERE date >= ? GROUP BY date ORDER BY date ASC
        `).all(since.slice(0, 10));
        const botTypes = this.db.prepare(`
            SELECT bot_type, COUNT(*) as hits, NULL AS unique_ips, COUNT(DISTINCT session_id) AS unique_sessions
            FROM analytics_events WHERE is_bot = 1 AND created_at >= ?
            GROUP BY bot_type ORDER BY hits DESC
        `).all(since);
        const suspiciousIPs = this.db.prepare(`
            SELECT NULL AS ip, session_id, COUNT(*) as total_hits,
                   COUNT(*) FILTER (WHERE status_code >= 400) as error_hits,
                   COUNT(DISTINCT path) as unique_paths,
                   MIN(created_at) as first_seen, MAX(created_at) as last_seen
            FROM analytics_events
            WHERE created_at >= ? AND is_bot = 0 AND session_id IS NOT NULL
            GROUP BY session_id HAVING total_hits > 500
            ORDER BY total_hits DESC LIMIT 20
        `).all(sqlTime(this._now() - 7 * 86400000));
        return { topBotIPs, botTrend, botTypes, suspiciousIPs };
    }

    destroy() {
        this.flush();
        for (const t of this._timers) { clearInterval(t); clearTimeout(t); }
        this._timers = [];
        this._rates.clear();
        this._sessions.clear();
    }
}

module.exports = { AnalyticsTracker, sqlTime, dayOf, hourOf, SESSION_IDLE_MS };
