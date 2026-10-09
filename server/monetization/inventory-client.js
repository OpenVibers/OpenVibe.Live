/**
 * OpenVibe.Live → OpenVibe.Inventory (ADR-054 §8): Live's cosmetics are items issued by `service:live` in the
 * network-wide inventory; cosmetics.js reads and writes them only through this client.
 *
 *   catalog()                    Live's definitions (alias = Live's item id ↔ itd_ id), cached 10 minutes
 *   subjectOf(userId)            a Live user's Network subject (linked_accounts, server/auth/identity-sync.js), cached
 *   owned(subject)               { alias → instance_id } of the live.* items the person owns
 *   equipped(subject)            { slot → alias } of what they wear (and `_badge`: a worn community badge's media id),
 *                                cached 30 s (chat and calls read it per message)
 *   equippedMany(subjects)       Map(subject → { slot → alias }), 100 people per read (OpenVibe.Chat's decor lookups)
 *   grant / revoke / equip       the writes, acting for the person with Live's own token
 *
 * The token is Live's client-credentials token for audience openvibe.inventory (Network's grants to `live`:
 * inventory.item.read, .list, .grant, .consume, inventory.equip.manage). A service acting for a person sends
 * X-OV-Subject. In a restore drill (LIVE_DRILL) nothing is sent: reads answer empty and writes refuse.
 */
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const identity = require('../auth/identity-sync');

const AUDIENCE = 'openvibe.inventory';
const LIVE = 'service:live';
const TIMEOUT_MS = 5000;
const CATALOG_TTL_MS = 10 * 60 * 1000;
const EQUIPPED_TTL_MS = 30 * 1000;
const BATCH = 100;   // Inventory's GET /equipped?subjects= takes at most 100
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

let tokens = null;
let catalogHit = null;
const equippedCache = new Map();   // subject → { at, value }
const subjects = new Map();        // Live user id → subject
let lastLog = null;

function drill() { try { return require('../drill').enabled; } catch { return false; } }
const baseUrl = () => String(process.env.INVENTORY_URL || 'http://127.0.0.1:5030').replace(/\/+$/, '');

class InventoryUnavailable extends Error {}

function note(what, err) {
    const m = `OpenVibe.Inventory ${what}: ${(err && err.message) || err}`;
    if (m === lastLog) return;   // once, until it changes
    lastLog = m;
    console.warn(`[Inventory] ${m}`);
}

function serviceTokens() {
    if (tokens) return tokens;
    const clientSecret = process.env.OV_OAUTH_CLIENT_SECRET || '';
    if (!clientSecret) return null;
    const networkInternalUrl = String(process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
    tokens = createServiceTokenClient({ tokenUrl: `${networkInternalUrl}/oauth/token`, clientId: process.env.OV_OAUTH_CLIENT_ID || 'live', clientSecret, audience: AUDIENCE });
    return tokens;
}

/** One call. → parsed JSON; a problem answer throws with its code; an outage throws InventoryUnavailable. */
async function call(method, path, { body, subject } = {}) {
    if (drill()) throw new InventoryUnavailable('restore drill: nothing is sent');
    const client = serviceTokens();
    if (!client) throw new InventoryUnavailable('OV_OAUTH_CLIENT_SECRET is not set');
    let res;
    try {
        res = await fetch(`${baseUrl()}/api/v1${path}`, {
            method,
            headers: {
                Accept: 'application/json', Authorization: `Bearer ${await client.getToken()}`,
                ...(subject ? { 'X-OV-Subject': subject } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (err) { note(`${method} ${path.split('?')[0]}`, err); throw new InventoryUnavailable(err.message); }
    const out = await res.json().catch(() => ({}));
    if (res.status === 401) client.invalidate && client.invalidate();
    if (res.status >= 500) { note(`${method} ${path.split('?')[0]}`, `answered ${res.status}`); throw new InventoryUnavailable(`answered ${res.status}`); }
    if (!res.ok) throw Object.assign(new Error(out.detail || out.code || `answered ${res.status}`), { status: res.status, code: out.code });
    lastLog = null;
    return out;
}

/** Live's definitions: { byAlias: Map(alias → definition), byId: Map(itd_ → alias) }. */
async function catalog() {
    if (catalogHit && Date.now() - catalogHit.at < CATALOG_TTL_MS) return catalogHit.value;
    const out = await call('GET', `/definitions?issuer=${encodeURIComponent(LIVE)}&limit=500`);
    const byAlias = new Map();
    const byId = new Map();
    for (const d of out.definitions || []) for (const alias of d.aliases || []) { byAlias.set(alias, d); byId.set(d.id, alias); }
    catalogHit = { at: Date.now(), value: { byAlias, byId } };
    return catalogHit.value;
}

/** A Live user's Network subject, or null (an account without one holds no items). */
async function subjectOf(userId) {
    const id = Number(userId);
    if (subjects.has(id)) return subjects.get(id);
    const found = await identity.subjectOf(id);
    const s = SUBJECT_RE.test(String(found || '')) ? found : null;
    if (s) { subjects.set(id, s); if (subjects.size > 5000) subjects.delete(subjects.keys().next().value); }
    return s;
}

/** { alias → { instance_id, acquired_at } } of the live.* items the person owns. */
async function owned(subject) {
    const { byId } = await catalog();
    const out = new Map();
    let cursor = null;
    for (let page = 0; page < 10; page++) {
        const r = await call('GET', `/me/items?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { subject });
        for (const i of r.instances || []) {
            const alias = byId.get(i.definition_id);
            if (alias && i.state === 'owned' && !out.has(alias)) out.set(alias, { instance_id: i.id, acquired_at: i.acquired_at });
        }
        if (!r.next_cursor) break;
        cursor = r.next_cursor;
    }
    return out;
}

/** One equipped set as Inventory answers it → { slot → alias } of its live.* items, kept for 30 s. */
function remember(subject, slots, byId) {
    const value = {};
    for (const [key, v] of Object.entries(slots || {})) {
        const [kind, slot] = key.split(':');
        // A community badge (OpenVibe.Inventory's Workshop, network.badge): its image, for the chat line.
        if (kind === 'network.badge' && /^med_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(v.media_id || ''))) { value._badge = v.media_id; continue; }
        if (!kind.startsWith('live.')) continue;
        const alias = byId.get(v.definition_id);
        if (alias) value[slot] = alias;
    }
    equippedCache.set(subject, { at: Date.now(), value });
    if (equippedCache.size > 5000) equippedCache.delete(equippedCache.keys().next().value);
    return value;
}
const fresh = (subject) => { const hit = equippedCache.get(subject); return hit && Date.now() - hit.at < EQUIPPED_TTL_MS ? hit.value : null; };

/** { slot → alias } of the live.* items the person wears (cached 30 s). */
async function equipped(subject) {
    const hit = fresh(subject);
    if (hit) return hit;
    const { byId } = await catalog();
    const r = await call('GET', `/people/${encodeURIComponent(subject)}/equipped`);
    return remember(subject, r.slots, byId);
}

/** Map(subject → { slot → alias }) for many people: the cached ones as they are, the rest 100 per read. */
async function equippedMany(list) {
    const out = new Map();
    const missing = [];
    for (const s of new Set(list)) {
        if (!SUBJECT_RE.test(String(s))) continue;
        const hit = fresh(s);
        if (hit) out.set(s, hit); else missing.push(s);
    }
    if (!missing.length) return out;
    const { byId } = await catalog();
    for (let i = 0; i < missing.length; i += BATCH) {
        const chunk = missing.slice(i, i + BATCH);
        const r = await call('GET', `/equipped?subjects=${chunk.map(encodeURIComponent).join(',')}`);
        for (const set of r.equipped || []) if (chunk.includes(set.subject)) out.set(set.subject, remember(set.subject, set.slots, byId));
    }
    return out;
}

const forget = (subject) => equippedCache.delete(subject);

async function grant(subject, alias, key) {
    const { byAlias } = await catalog();
    const d = byAlias.get(alias);
    if (!d) throw Object.assign(new Error('Unknown cosmetic'), { status: 404 });
    return (await call('POST', '/grants', { body: { definition_id: d.id, subject, idempotency_key: key, origin: 'granted', reason: 'given on OpenVibe.Live' } })).instance;
}

async function revoke(instanceId, reason) {
    return (await call('POST', `/instances/${encodeURIComponent(instanceId)}/revoke`, { body: { reason: String(reason || 'revoked on OpenVibe.Live').slice(0, 200) } })).instance;
}

async function equip(subject, kind, slot, instanceId) {
    forget(subject);
    const r = await call('PUT', '/me/equipped', { subject, body: { kind, slot, instance_id: instanceId } });
    forget(subject);
    return r;
}

/** Tests only. */
function reset() { tokens = null; catalogHit = null; equippedCache.clear(); subjects.clear(); lastLog = null; }

module.exports = { catalog, subjectOf, owned, equipped, equippedMany, grant, revoke, equip, forget, reset, InventoryUnavailable, AUDIENCE };
