'use strict';
/**
 * Renamed channels (roadmap WS-B task 6). OpenVibe.Network owns usernames and keeps their history
 * (staff rename people there; the old name stays reserved). Live follows:
 *
 *   - a Network token whose username differs from the linked Live user's renames them here too
 *     (auth.js _syncSsoUserFields), recorded in username_history;
 *   - /@name that Live does not know asks Network (GET /api/v1/users/names/:name): an old name
 *     answers 301 → /@current (server/web/page-status.js), and a new name Live has not seen yet is
 *     picked up at once, before the person's next sign-in.
 *
 * Only /@name redirects. A bare /name is never a channel URL and stays a 404.
 */
const db = require('../db/database');
const config = require('../config');

const NAME_RE = /^[A-Za-z0-9_]{3,24}$/;
const LOOKUP_TTL_MS = 60_000;
let ready = false;
const _lookups = new Map(); // lowercased name → { at, value: record|null }

function ensureSchema() {
    if (ready) return;
    db.run(`CREATE TABLE IF NOT EXISTS username_history (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL,
        old_username TEXT NOT NULL,
        new_username TEXT NOT NULL,
        changed_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_username_history_old ON username_history(old_username COLLATE NOCASE)');
    ready = true;
}

/**
 * Rename a Live user to the Network's name for them, unless only the case differs or another Live
 * user already holds it. Returns true when it changed.
 */
function syncUsername(userId, newName) {
    if (!userId || !NAME_RE.test(String(newName || ''))) return false;
    const user = db.get('SELECT id, username FROM users WHERE id = ?', [userId]);
    if (!user || String(user.username || '').toLowerCase() === newName.toLowerCase()) return false;
    const clash = db.get('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id != ?', [newName, userId]);
    if (clash) { console.warn(`[Usernames] ${user.username} → ${newName}: another Live user holds that name; not renamed`); return false; }
    ensureSchema();
    db.getDb().transaction(() => {
        db.run('INSERT INTO username_history (user_id, old_username, new_username) VALUES (?, ?, ?)', [user.id, user.username, newName]);
        db.run('UPDATE users SET username = ? WHERE id = ?', [newName, user.id]);
    })();
    console.log(`[Usernames] renamed ${user.username} → ${newName} (Network)`);
    return true;
}

/** The current Live username for an old one, from Live's own history (null when unknown or reused). */
function localRenamedTo(name) {
    if (!NAME_RE.test(String(name || ''))) return null;
    ensureSchema();
    if (db.get('SELECT 1 AS x FROM users WHERE username = ? COLLATE NOCASE', [name])) return null;
    const row = db.get(`SELECT u.username FROM username_history h JOIN users u ON u.id = h.user_id
        WHERE h.old_username = ? COLLATE NOCASE ORDER BY h.id DESC LIMIT 1`, [name]);
    return row ? row.username : null;
}

async function networkRecord(name, { fetchImpl = globalThis.fetch, timeoutMs = 1500 } = {}) {
    const key = name.toLowerCase();
    const hit = _lookups.get(key);
    if (hit && Date.now() - hit.at < LOOKUP_TTL_MS) return hit.value;
    let value = null;
    try {
        const base = String(config.openvibeToolsInternalUrl || 'http://127.0.0.1:4000').replace(/\/+$/, '');
        const r = await fetchImpl(`${base}/api/v1/users/names/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(timeoutMs) });
        if (r.ok) {
            const b = await r.json();
            if (b && NAME_RE.test(String(b.current || '')) && Number.isInteger(b.network_id)) value = b;
        } else if (r.status !== 404) return null; // an outage is not a verdict: do not cache it
    } catch { return null; }
    if (_lookups.size > 5000) _lookups.clear();
    _lookups.set(key, { at: Date.now(), value });
    return value;
}

/**
 * For a /@name Live does not know: the username to send the visitor to (the current name of a
 * renamed channel, or `name` itself once a new name was picked up), or null for a real 404.
 */
async function resolveUnknownChannel(name, opts = {}) {
    if (!NAME_RE.test(String(name || ''))) return null;
    const local = localRenamedTo(name);
    if (local) return local;
    const rec = await networkRecord(name, opts);
    if (!rec) return null;
    const linked = db.get("SELECT user_id FROM linked_accounts WHERE service = 'network' AND service_user_id = ? ORDER BY id DESC LIMIT 1", [String(rec.network_id)]);
    if (!linked) return null;
    const user = db.get('SELECT id, username FROM users WHERE id = ?', [linked.user_id]);
    if (!user) return null;
    if (String(user.username).toLowerCase() !== rec.current.toLowerCase()) syncUsername(user.id, rec.current);
    const now = db.get('SELECT username FROM users WHERE id = ?', [user.id]);
    return now ? now.username : null;
}

function _reset() { _lookups.clear(); ready = false; }

module.exports = { syncUsername, localRenamedTo, resolveUnknownChannel, ensureSchema, _reset, NAME_RE };
