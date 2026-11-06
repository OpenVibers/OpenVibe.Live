'use strict';
/**
 * The sharing system, for agent streams (openvibe-sdk/share, service `live`, kind `agent-stream`).
 *
 * The rules of who may open a private agent stream are not Live's own: they are the sharing system's, the same ones
 * the Share sheet offers everywhere on the network (Everyone / Anyone with the link / Specific people / Only me). A
 * stream registers itself when it is created, follows its visibility switch, and asks `canView` on every view.
 *
 * The SDK module is optional at runtime: Live must boot and serve its other pages on a release whose pinned
 * openvibe-sdk predates `share`. Without it, only the owner can open a private stream — fail closed — and the Share
 * sheet's access part is not offered. Nothing else changes.
 *
 * The tables (share_*) are created by Live's migration 0027 from the SDK's own expand-only schema; this module never
 * creates one at runtime. Network is asked only to turn user names into subjects (the sheet's lookup) and to resolve
 * people for display.
 */
const db = require('../db/database');

const SERVICE = 'live';
const KIND = 'agent-stream';
const AUDIENCE = { private: 'private', unlisted: 'link', public: 'public' };

let store;
let loaded = false;
let networkOverride = null;

/** Tests and a restore drill: answer Network's name lookups locally. */
function _setNetwork(client) {
    networkOverride = client || null;
    store = undefined;
    loaded = false;
}

/** Network's internal JSON client, with Live's service token for each call. */
function networkClient() {
    if (networkOverride) return networkOverride;
    const principal = require('../net/network-principal');
    const base = String(process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
    return {
        async json({ path, method = 'GET', query, json }) {
            const headers = await principal.headersFor(path);
            const q = query ? `?${new URLSearchParams(query)}` : '';
            const res = await fetch(`${base}${path}${q}`, {
                method,
                headers: { 'Content-Type': 'application/json', ...headers },
                ...(json === undefined ? {} : { body: JSON.stringify(json) }),
                signal: AbortSignal.timeout(15_000),
            });
            if (!res.ok) {
                const err = new Error(`Network ${path} answered ${res.status}`);
                err.status = res.status;
                throw err;
            }
            return await res.json();
        },
    };
}

/** Events go through Live's own outbox, inside the sharing transaction (the SDK outbox refuses otherwise). */
const events = {
    async publish(envelope) {
        const outbox = require('../events/stream-events');
        outbox.init();
        if (await outbox.enqueue(envelope)) outbox.kick();
    },
};

function sdk() {
    if (loaded) return store;
    loaded = true;
    let mod;
    try { mod = require('openvibe-sdk/share'); } catch { mod = null; }
    if (!mod || typeof mod.createShares !== 'function') return (store = null);
    try {
        store = mod.createShares({ db: db.getDb(), network: networkClient(), events, notify: async () => {} });
    } catch (err) {
        console.warn(`[AgentStream] sharing unavailable: ${err.message}`);
        store = null;
    }
    return store;
}

/** Whether the sharing system is installed in this release. */
function available() {
    try { return !!sdk(); } catch { return false; }
}

/** The store, or null when this release has no sharing. */
function store_() {
    try { return sdk(); } catch { return null; }
}

function audienceFor(visibility) { return AUDIENCE[visibility] || 'private'; }

/** Register a new stream. Its visibility is the initial audience; the owner is the row's subject. */
async function register(row) {
    const shares = store_();
    if (!shares || !row.owner_subject) return;
    try {
        await shares.register({ service: SERVICE, kind: KIND, id: row.public_id }, {
            owner_subject: { type: 'user', id: row.owner_subject },
            audience: audienceFor(row.visibility),
        });
    } catch (err) {
        // The visibility column is still the rule the routes read; a failed registration only means no guests yet.
        console.warn(`[AgentStream] share registration for ${row.public_id} failed: ${err.message}`);
    }
}

/** Follow the visibility switch, as the owner (the store's audience rule is its own). */
async function setAudience(row, visibility) {
    const shares = store_();
    if (!shares || !row.owner_subject) return;
    try {
        await shares.setAudience({ subject: { type: 'user', id: row.owner_subject }, staff: false },
            { service: SERVICE, kind: KIND, id: row.public_id }, audienceFor(visibility));
    } catch (err) {
        console.warn(`[AgentStream] share audience for ${row.public_id} not saved: ${err.message}`);
    }
}

/** Whether the sharing system lets this viewer open the stream. `viewer` is { subject, staff? }. */
async function canView(ref, viewer) {
    const shares = store_();
    if (!shares || !viewer || !viewer.subject) return false;
    try {
        return await shares.canView(viewer, ref);
    } catch {
        return false;
    }
}

/** The share router, mounted at /api/v1 (the Share sheet's access part). Null when the SDK has no sharing. */
function router(options) {
    const shares = store_();
    if (!shares) return null;
    return shares.router({ service: SERVICE, ...options });
}

/** Send the sharing system's queued deliveries (events and notices). Called by the housekeeping loop, never inline. */
async function flushDeliveries() {
    const shares = store_();
    if (!shares) return 0;
    return await shares.flush();
}

module.exports = { SERVICE, KIND, available, register, setAudience, canView, router, flushDeliveries, audienceFor, _setNetwork, _reset() { store = undefined; loaded = false; networkOverride = null; } };
