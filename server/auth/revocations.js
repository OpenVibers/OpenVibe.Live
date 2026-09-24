'use strict';
/**
 * Per-person token cutoffs from OpenVibe.Network (roadmap WS-B task 4; Contracts 0.39.0
 * network.user.token_valid_after).
 *
 * When someone signs out everywhere, changes or resets their password, is banned or has their
 * sessions ended by staff, Network moves their cutoff and publishes it; Live receives it at
 * POST /internal/network-events (./network-events.js). auth.js refuses a Network session token issued
 * before its subject's cutoff (Network's rule: iat * 1000 < valid_after), so a signed-out phone stops
 * working on Live at once instead of when its 7-day token expires.
 */
const db = require('../db/database');

let ready = false;
const cache = new Map(); // subject → valid_after ms (0 = none known)

function ensureSchema() {
    if (ready) return;
    db.run(`CREATE TABLE IF NOT EXISTS token_revocations (
        subject_id     TEXT PRIMARY KEY,
        valid_after_ms INTEGER NOT NULL,
        reason         TEXT,
        updated_at     INTEGER NOT NULL
    )`);
    ready = true;
}

/** The cutoff for a subject in ms, 0 when none. */
function cutoffFor(subject) {
    if (!subject) return 0;
    if (cache.has(subject)) return cache.get(subject);
    ensureSchema();
    const row = db.get('SELECT valid_after_ms FROM token_revocations WHERE subject_id = ?', [subject]);
    const ms = row ? Number(row.valid_after_ms) || 0 : 0;
    if (cache.size > 50000) cache.clear();
    cache.set(subject, ms);
    return ms;
}

/** Keep the later cutoff (events can arrive out of order). Returns true when it moved forward. */
function record(subject, validAfterMs, reason = null, now = Date.now()) {
    ensureSchema();
    if (!(validAfterMs > cutoffFor(subject))) return false;
    db.run(`INSERT INTO token_revocations (subject_id, valid_after_ms, reason, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(subject_id) DO UPDATE SET valid_after_ms = excluded.valid_after_ms, reason = excluded.reason, updated_at = excluded.updated_at
        WHERE excluded.valid_after_ms > token_revocations.valid_after_ms`, [subject, validAfterMs, reason, now]);
    cache.set(subject, validAfterMs);
    return true;
}

/** Was a session token with these (verified) claims issued before its subject's cutoff? */
function isRevoked(claims) {
    if (!claims || typeof claims.iat !== 'number' || typeof claims.subject_id !== 'string') return false;
    return claims.iat * 1000 < cutoffFor(claims.subject_id);
}

function _reset() { cache.clear(); ready = false; }

module.exports = { ensureSchema, cutoffFor, record, isRevoked, _reset };
