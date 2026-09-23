'use strict';
/**
 * Analytics database schema (ADR-021). Same tables as the openvibe-shared tracker it replaces, so the
 * existing analytics.db files and the admin dashboards keep working; the columns that used to hold
 * personal data (ip, user_id, city) stay in the table for compatibility but are always NULL now, and
 * user_agent / referer / path hold the reduced forms (class, origin, route template).
 *
 * Added:
 *   analytics_events.authenticated   0/1 — whether the request was signed in (a flag, never who)
 *   analytics_visitor_days           the day's salted visitor hashes, for the unique-visitor rollups;
 *                                    rows are deleted once the day's rollup is final (≤ ~25 h)
 *   analytics_day_salts              the random salt of the current UTC day (so a restart does not
 *                                    double-count); deleted together with that day's hashes
 * Emptied: analytics_rate_tracking   (the rate check keeps per-IP counters in memory only now)
 */

const ANALYTICS_SCHEMA = `
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

    CREATE TABLE IF NOT EXISTS analytics_rate_tracking (
        ip TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        hit_count INTEGER DEFAULT 1,
        PRIMARY KEY (ip, window_start)
    );

    CREATE TABLE IF NOT EXISTS analytics_visitor_days (
        service TEXT NOT NULL,
        day TEXT NOT NULL,
        hour TEXT NOT NULL,
        vhash TEXT NOT NULL,
        authenticated INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (service, hour, vhash)
    );

    CREATE TABLE IF NOT EXISTS analytics_day_salts (
        service TEXT NOT NULL,
        day TEXT NOT NULL,
        salt TEXT NOT NULL,
        PRIMARY KEY (service, day)
    );

    CREATE INDEX IF NOT EXISTS idx_analytics_events_created ON analytics_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_analytics_events_service ON analytics_events(service, created_at);
    CREATE INDEX IF NOT EXISTS idx_analytics_events_path ON analytics_events(service, path, created_at);
    CREATE INDEX IF NOT EXISTS idx_analytics_events_bot ON analytics_events(is_bot, created_at);
    CREATE INDEX IF NOT EXISTS idx_analytics_hourly_lookup ON analytics_hourly(service, hour);
    CREATE INDEX IF NOT EXISTS idx_analytics_daily_lookup ON analytics_daily(service, date);
    CREATE INDEX IF NOT EXISTS idx_analytics_visitor_days_day ON analytics_visitor_days(service, day);

    -- Indexes over the retired personal columns.
    DROP INDEX IF EXISTS idx_analytics_events_ip;
    DROP INDEX IF EXISTS idx_analytics_events_user;
`;

/** Create or upgrade the analytics tables in place. Idempotent; never touches rows. */
function ensureSchema(db) {
    db.exec(ANALYTICS_SCHEMA);
    const cols = db.prepare('PRAGMA table_info(analytics_events)').all().map((c) => c.name);
    if (!cols.includes('authenticated')) {
        db.exec('ALTER TABLE analytics_events ADD COLUMN authenticated INTEGER NOT NULL DEFAULT 0');
    }
}

module.exports = { ANALYTICS_SCHEMA, ensureSchema };
