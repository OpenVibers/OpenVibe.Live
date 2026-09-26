'use strict';
/**
 * Live's site settings as revisioned configuration (roadmap WS-C task 7; openvibe-shared/config).
 *
 * `site_settings` stays what every reader reads: db.getSetting is unchanged for its callers. The
 * namespace `live.site_settings` is the journal of changes to those rows:
 *   - an admin change is one revision, recorded with who made it and why, and written to the rows from
 *     the revision (only the keys it changes);
 *   - history and rollback come with it (GET /api/admin/config…, POST …/rollback);
 *   - secret-class values (API keys, client secrets, webhook secrets, salts) are only ever shown as
 *     keyed fingerprints.
 * Rows written around the journal (a direct db.setSetting by a job or an older code path) are recorded
 * as a "sync" revision before the next change, so a change or a rollback never reverts them.
 *
 * Not configuration, and never in the namespace (NOT_CONFIG): machine state that jobs keep in
 * site_settings (cursors, the daily star, the last deploy notice, one-off migration flags, old
 * storage_tier.* rows), and the money freeze, which has its own owner-only, audited path
 * (server/monetization/money-authority.js) that no configuration rollback may undo.
 */
const config = require('openvibe-shared/config');
const db = require('../db/database');

const NOT_CONFIG = /^(arena_backfill_cursor_|star_streamer$|deploy_last_announced$|relay_users_backfilled$|bucks_bits_migration_done$|stats_vibes_reset_at$|storage_tier\.|money_writes_frozen)/;
const SECRET = /(api[_-]?key|secret|token|password|client_secret|service_account|private[_-]?key|salt|access_key)/i;
const PUBLIC_KEYS = new Set(['site_name', 'site_description', 'motd', 'registration_open', 'require_email', 'nsfw_enabled']);
const SYSTEM = { type: 'service', id: 'live' };

const isConfigKey = (key) => typeof key === 'string' && key.length > 0 && key.length <= 100 && !NOT_CONFIG.test(key);
const classify = (key) => (SECRET.test(key) ? 'secret' : PUBLIC_KEYS.has(key) ? 'public' : 'internal');

/** The configuration rows as they are now: key → the stored string. */
function rowsNow() {
    const out = {};
    for (const r of db.getAllSettings()) if (isConfigKey(r.key)) out[r.key] = r.value == null ? '' : String(r.value);
    return out;
}

/** Write the revision's values to the rows: set what differs, delete what the revision no longer has. */
function writeRows(target) {
    const now = rowsNow();
    db.getDb().transaction(() => {
        for (const [k, v] of Object.entries(target)) if (isConfigKey(k) && now[k] !== String(v)) db.setSetting(k, String(v));
        for (const k of Object.keys(now)) if (!(k in target)) db.deleteSetting(k);
    })();
}

let store = null;
function getStore() {
    if (store) return store;
    store = config.createConfigStore({
        db: db.getDb(), service: 'live', namespace: 'live.site_settings',
        classify,
        legacy: () => rowsNow(),
        onActivate: async (values) => writeRows(values),
        log: { info: (m) => console.log(`[Config] ${m}`), warn: (m) => console.warn(`[Config] ${m}`), error: (m) => console.error(`[Config] ${m}`) },
    });
    return store;
}

const canonical = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));

/** Record rows written around the journal as a revision of their own. → the sync snapshot, or null */
async function sync() {
    const s = getStore();
    const now = rowsNow();
    if (canonical({ ...s.get() }) === canonical(now)) return null;
    return s.apply(now, { actor: SYSTEM, reason: 'sync: site_settings changed outside the configuration journal' });
}

/**
 * Change settings: set (key → string) and unset (keys), as one revision by `actor` for `reason`.
 * Keys that are not configuration are refused (the caller writes those directly). → the new snapshot
 */
async function change({ set = {}, unset = [] } = {}, { actor = SYSTEM, reason = null } = {}) {
    const bad = [...Object.keys(set), ...unset].filter((k) => !isConfigKey(k));
    if (bad.length) throw Object.assign(new Error(`not configuration: ${bad.join(', ')}`), { status: 400, code: 'config.not_configuration' });
    await sync();
    const values = {};
    for (const [k, v] of Object.entries(set)) values[k] = v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '');
    return getStore().apply(values, { merge: true, unset, actor, reason });
}

/** Roll back to the previous good revision (or `to`) after recording any outside changes. */
async function rollback({ actor = SYSTEM, reason = null, to } = {}) {
    await sync();
    return getStore().rollback({ actor, reason, to });
}

/** A person as the journal records them. */
function actorOf(user) {
    if (user && user.subject_id) return { type: 'user', id: String(user.subject_id) };
    return SYSTEM;
}

module.exports = { getStore, change, rollback, sync, isConfigKey, classify, actorOf, NOT_CONFIG, _reset: () => { store = null; } };
