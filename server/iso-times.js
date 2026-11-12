'use strict';
/**
 * Times leave with their zone (openvibe.design rule 148).
 *
 * The tables created from SQLite (migrations/0001_initial.sql) keep timestamps as text in the
 * SQLite shape `YYYY-MM-DD HH:MM:SS`, which ov_now() writes in UTC. A browser reads that string as
 * local time, so west of UTC every event looked hours in the future. This is the edge: JSON fields
 * whose name says they are a time are rendered as ISO 8601 with Z, and nothing else changes — the
 * stored text, cursors built from it and every query that compares it stay exactly as they are.
 *
 * Already-ISO values (with Z or an offset), dates (`YYYY-MM-DD`) and non-strings pass through.
 * `POST /api/v1/...` cursors echo their own stored text, not one of these fields, so pagination is
 * unaffected.
 */
const SQL_TEXT_TIME = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/;
// created_at, updated_at, started_at, ended_at, expires_at, last_message_at, timestamp, …
// and the bare `created` / `updated` / `started` / `ended` / `expires` some responses use.
const TIME_KEY = /(^|_)(at|created|updated|started|ended|expires|timestamp)$|^last_|^(since|until)$/;

/** One stored time as ISO 8601 with Z; anything not in the SQLite shape is returned untouched. */
function isoTime(value) {
    return typeof value === 'string' && SQL_TEXT_TIME.test(value) ? `${value.replace(' ', 'T')}Z` : value;
}

/** Copy `value`, rendering time-named fields; arrays and plain objects are walked, a Date is not. */
function normalizeTimes(value, depth = 0) {
    if (depth > 8 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => normalizeTimes(item, depth + 1));
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        out[key] = TIME_KEY.test(key) ? isoTime(item) : normalizeTimes(item, depth + 1);
    }
    return out;
}

/** Express middleware: JSON answers carry ISO times. Internal service routes keep their SQL shape. */
function isoJsonTimes(req, res, next) {
    if (req.path.startsWith('/internal/')) return next();
    const json = res.json.bind(res);
    res.json = (body) => json(normalizeTimes(body));
    next();
}

module.exports = { TIME_KEY, SQL_TEXT_TIME, isoTime, normalizeTimes, isoJsonTimes };
