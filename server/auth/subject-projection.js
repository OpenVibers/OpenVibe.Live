'use strict';
/**
 * What Live knows about a person, kept from OpenVibe.Network's network.user.updated (Contracts 0.43.0,
 * roadmap WS-B task 2) instead of Live's own copies.
 *
 *   subject_projection   one row per Network subject: the person's current username, display name, picture,
 *                        colour, role and ban, with Network's profile revision. An event whose revision is
 *                        not newer than the row is ignored (events can arrive out of order or twice).
 *
 * The linked Live account follows the projection in the same step: picture, colour, display name and
 * username (server/auth/usernames.js keeps /@old answering), and the role by these rules:
 *   - an event whose `changed` includes role is Network changing it: staff roles (global_mod, admin) follow it
 *     both ways (a downgrade too, which the token sync in auth.js never does; /internal/user-role pushed it
 *     before), but `streamer` is Live's own (someone with a channel, ensureStreamerRoleOnFeed), so a person
 *     who has streamed keeps it rather than dropping to user;
 *   - any other event only ever raises the role, like the token sync;
 *   - the local owner keeps admin (is_owner is Live's). A Network ban is recorded here and never touches Live's own users.is_banned: the
 * person cannot sign in anyway (Network refuses and revokes their tokens), and unbanning on Network must
 * not lift a ban Live's staff set. Chat drops what it cached about them.
 */
const db = require('../db/database');

const ROLES = ['user', 'streamer', 'global_mod', 'admin'];
const RANK = { user: 0, streamer: 1, global_mod: 2, admin: 3 };
const STAFF_ROLES = new Set(['global_mod', 'admin']);

/** The Live role after a Network event (see the rules above). */
function nextRole(user, p) {
    if (user.is_owner) return 'admin';
    const current = ROLES.includes(user.role) ? user.role : 'user';
    if (!(Array.isArray(p.changed) && p.changed.includes('role'))) return RANK[p.role] > RANK[current] ? p.role : current;
    if (STAFF_ROLES.has(p.role)) return p.role;
    const streamed = !!db.getDb().prepare('SELECT 1 FROM streams WHERE user_id = ? LIMIT 1').get(user.id);
    return streamed || RANK[p.role] >= RANK.streamer ? 'streamer' : 'user';
}
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

let ready = false;
function ensureSchema() {
    if (ready) return;
    db.getDb().exec(`CREATE TABLE IF NOT EXISTS subject_projection (
        subject_id TEXT PRIMARY KEY,
        network_user_id INTEGER,
        revision INTEGER NOT NULL,
        username TEXT NOT NULL,
        display_name TEXT,
        avatar_url TEXT,
        profile_color TEXT,
        role TEXT NOT NULL,
        banned INTEGER NOT NULL DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_subject_projection_network ON subject_projection(network_user_id);`);
    ready = true;
}

/** The local account linked to this Network person, or null. */
function localUser(subject, networkUserId) {
    const d = db.getDb();
    const row = d.prepare("SELECT user_id FROM linked_accounts WHERE service = 'network' AND (subject_id = ? OR service_user_id = ?) ORDER BY subject_id = ? DESC LIMIT 1")
        .get(subject, String(networkUserId), subject);
    return row ? db.getUserById(row.user_id) : null;
}

/**
 * Apply one network.user.updated payload. → 'updated' | 'stale' | 'ignored:payload'
 * `notify(userId)` is told when the linked account changed (Chat's cache).
 */
function apply(p, { notify = () => {} } = {}) {
    ensureSchema();
    const subject = p && p.subject && p.subject.id;
    if (!SUBJECT_RE.test(String(subject || '')) || !Number.isInteger(p.revision) || p.revision < 1 || typeof p.username !== 'string' || !p.username
        || !ROLES.includes(p.role) || typeof p.banned !== 'boolean') return 'ignored:payload';
    const d = db.getDb();
    return d.transaction(() => {
        const cur = d.prepare('SELECT revision FROM subject_projection WHERE subject_id = ?').get(subject);
        if (cur && cur.revision >= p.revision) return 'stale';
        const str = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);
        d.prepare(`INSERT INTO subject_projection (subject_id, network_user_id, revision, username, display_name, avatar_url, profile_color, role, banned, updated_at)
                   VALUES (@subject, @nid, @rev, @username, @display_name, @avatar_url, @profile_color, @role, @banned, CURRENT_TIMESTAMP)
                   ON CONFLICT(subject_id) DO UPDATE SET network_user_id = excluded.network_user_id, revision = excluded.revision, username = excluded.username,
                     display_name = excluded.display_name, avatar_url = excluded.avatar_url, profile_color = excluded.profile_color, role = excluded.role,
                     banned = excluded.banned, updated_at = excluded.updated_at`)
            .run({ subject, nid: Number.isInteger(p.network_user_id) ? p.network_user_id : null, rev: p.revision, username: p.username.slice(0, 64),
                display_name: str(p.display_name, 120), avatar_url: str(p.avatar_url, 500), profile_color: str(p.profile_color, 32), role: p.role, banned: p.banned ? 1 : 0 });
        const user = localUser(subject, p.network_user_id);
        if (!user) return 'updated';
        const role = nextRole(user, p);
        const next = { role, avatar_url: str(p.avatar_url, 500) || user.avatar_url, profile_color: str(p.profile_color, 32) || user.profile_color, display_name: str(p.display_name, 120) || user.display_name };
        const changed = Object.keys(next).filter((k) => next[k] !== user[k]);
        if (changed.length) d.prepare(`UPDATE users SET ${changed.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...Object.fromEntries(changed.map((k) => [k, next[k]])), id: user.id });
        let renamed = false;
        if (p.username.toLowerCase() !== String(user.username || '').toLowerCase()) {
            try { renamed = !!require('./usernames').syncUsername(user.id, p.username); } catch { /* the name is taken here: keep the old one */ }
        }
        if (changed.length || renamed) notify(user.id);
        return 'updated';
    })();
}

/** The projected person for a subject, or null. */
function get(subject) {
    ensureSchema();
    return db.getDb().prepare('SELECT * FROM subject_projection WHERE subject_id = ?').get(subject) || null;
}

module.exports = { apply, get, ensureSchema, _reset: () => { ready = false; } };
