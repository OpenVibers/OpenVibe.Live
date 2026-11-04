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

const NOT_CONFIG = /^(star_streamer$|deploy_last_announced$|relay_users_backfilled$|bucks_bits_migration_done$|stats_vibes_reset_at$|storage_tier\.|money_writes_frozen)/;
// A webhook URL is its own credential (anyone holding it can post), so it is secret-class too.
const SECRET = /(api[_-]?key|secret|token|password|client_secret|service_account|private[_-]?key|salt|access[_-]?key|webhook)/i;
const PUBLIC_KEYS = new Set(['site_name', 'site_description', 'motd', 'registration_open', 'require_email', 'nsfw_enabled']);
const SYSTEM = { type: 'service', id: 'live' };

const isConfigKey = (key) => typeof key === 'string' && key.length > 0 && key.length <= 100 && !NOT_CONFIG.test(key);
const classify = (key) => (SECRET.test(key) ? 'secret' : PUBLIC_KEYS.has(key) ? 'public' : 'internal');

const isSecret = (key) => classify(key) === 'secret';
const nonSecret = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !isSecret(k)));

/** The configuration rows as they are now: key → the stored string. Never the merged view readers see. */
async function rowsNow() {
    const out = {};
    for (const r of await db.all('SELECT key, value FROM site_settings ORDER BY key')) if (isConfigKey(r.key)) out[r.key] = r.value == null ? '' : String(r.value);
    return out;
}

/**
 * Write the revision's non-secret values to the rows: set what differs, delete what the revision no longer has.
 * A secret-class value never goes into site_settings (D11): the store keeps the only copy, sealed when it has a
 * KEK. Its row may stay as a blank, typed slot so the settings page still lists the key; a stored value is left
 * alone here (the boot migration blanks it once the store holds a sealed copy).
 */
async function writeRows(target) {
    const now = await rowsNow();
    await db.getDb().tx(async () => {
        for (const [k, v] of Object.entries(target)) {
            if (!isConfigKey(k)) continue;
            if (isSecret(k)) {
                if (!(k in now)) await db.setSetting(k, '');
                continue;
            }
            if (now[k] !== String(v)) await db.setSetting(k, String(v));
        }
        for (const k of Object.keys(now)) if (!(k in target) && !isSecret(k)) await db.deleteSetting(k);
    });
}

let store = null;
function getStore() {
    if (store) return store;
    // On PostgreSQL createConfigStore reads/seeds its active revision before it resolves, so it returns a
    // promise of the store: getStore() hands that promise back (every caller awaits it). config-pg reads
    // `legacy` synchronously (it does not await the callback), so gather the rows first.
    store = (async () => {
        const legacyRows = await rowsNow();
        return await config.createConfigStore({
            db: db.getDb(), service: 'live', namespace: 'live.site_settings',
            classify,
            legacy: () => legacyRows,
            onActivate: async (values) => await writeRows(values),
            log: { info: (m) => console.log(`[Config] ${m}`), warn: (m) => console.warn(`[Config] ${m}`), error: (m) => console.error(`[Config] ${m}`) },
        });
    })();
    return store;
}

/** The store once it exists, without creating it. Readers use it when the boot has loaded it. */
function hasStore() { return store !== null; }
async function secretValue(key) {
    if (!store) return undefined;
    return (await store).get(key);
}

const canonical = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));

/** Record non-secret rows written around the journal as a revision of their own. → the sync snapshot, or null */
async function sync() {
    const s = await getStore();
    const now = await rowsNow();
    const current = { ...s.get() };
    const next = {};
    for (const [k, v] of Object.entries(current)) if (isSecret(k)) next[k] = v;   // secrets stay in the store
    for (const [k, v] of Object.entries(now)) if (!isSecret(k)) next[k] = v;
    if (canonical(nonSecret(current)) === canonical(nonSecret(next))) return null;
    return s.apply(next, { actor: SYSTEM, reason: 'sync: site_settings changed outside the configuration journal' });
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
    const snap = await (await getStore()).apply(values, { merge: true, unset, actor, reason });
    // An explicit unset drops the store's secret; blank the legacy slot too so no plaintext copy survives.
    for (const k of unset) if (isSecret(k)) await db.setSetting(k, '');
    return snap;
}

/** Roll back to the previous good revision (or `to`) after recording any outside changes. */
async function rollback({ actor = SYSTEM, reason = null, to } = {}) {
    await sync();
    return (await getStore()).rollback({ actor, reason, to });
}

/**
 * D11: the legacy table keeps non-secret rows only. With a KEK, every secret-class row the store holds — and for
 * which the sealed store's read-back and marker agree — is blanked. Without a KEK nothing is blanked (the store is
 * not sealed); without a value in the store, or with a locked envelope, the row is left for a later run. Counts
 * only, never a key's value.
 */
async function migrateLegacySecrets(s) {
    const rows = await rowsNow();
    const candidates = Object.entries(rows).filter(([k, v]) => isSecret(k) && String(v) !== '');
    if (!candidates.length) return { checked: 0, blanked: 0, kept: 0, sealed: !!s.sealed };
    if (!s.sealed) {
        console.log(`[Config] legacy site_settings: ${candidates.length} secret value(s) left (no KEK; the store is not sealed)`);
        return { checked: candidates.length, blanked: 0, kept: candidates.length, sealed: false };
    }
    const summary = await s.summary();
    const snap = summary.active;
    let blanked = 0, kept = 0;
    for (const [k, v] of candidates) {
        const stored = s.get(k);
        const marker = summary.secrets[k] || (typeof s.secretMarker === 'function' ? await s.secretMarker(k) : null);
        const sealedRow = snap && snap.values ? snap.values[k] : null;
        const proven = stored !== undefined && stored !== null && String(stored) !== ''
            && marker && sealedRow && sealedRow.redacted === true
            && marker.fingerprint && marker.fingerprint === sealedRow.fingerprint;
        if (!proven) { kept++; continue; }
        await db.setSetting(k, '');
        blanked++;
    }
    console.log(`[Config] legacy site_settings: ${blanked} secret value(s) blanked after the sealed store held them; ${kept} left (no sealed copy)${s.kek ? `; KEK ${s.kek}` : ''}`);
    return { checked: candidates.length, blanked, kept, sealed: true };
}

let initPromise = null;
/** Boot: load the store, seal old plaintext rows, then blank the legacy copies the sealed store holds. */
function init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
        const s = await getStore();
        if (s.sealed) await s.reseal();
        return await migrateLegacySecrets(s);
    })().catch((err) => { initPromise = null; throw err; });
    return initPromise;
}

/** A person as the journal records them. */
function actorOf(user) {
    if (user && user.subject_id) return { type: 'user', id: String(user.subject_id) };
    return SYSTEM;
}

module.exports = { getStore, init, hasStore, secretValue, migrateLegacySecrets, change, rollback, sync, isConfigKey, classify, isSecret, actorOf, NOT_CONFIG, _reset: () => { store = null; initPromise = null; } };
