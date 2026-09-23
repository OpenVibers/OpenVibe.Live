'use strict';
/**
 * Live as a client of OpenVibe.Billing's /api/v1 (roadmap Wave 8, ADR-012).
 *
 * - Service token for audience `openvibe.billing` from OpenVibe.Network (network-principal.js,
 *   client `live`). Each route on Billing checks one capability; Live needs the grants
 *   billing.intent.create, billing.transfer.create, billing.balance.read, billing.cashout.request,
 *   billing.subscription.manage and billing.entitlement.check. A 401 fetches a fresh token once.
 * - Every POST carries an Idempotency-Key that the caller derives from the Live action
 *   (billing-actions.js keeps them in billing_actions and re-sends the same key on a retry).
 * - Timeouts on every call. Failures are thrown as BillingCallError with `kind`:
 *     refused      Billing answered 4xx (problem+json) — nothing moved
 *     unavailable  never reached Billing, or Billing answered 5xx before acting — nothing moved
 *     unknown      the request may have reached Billing but no answer came back (timeout, reset)
 *   There is deliberately NO fallback to Live's own columns: when Billing is the authority and it
 *   is down, money actions fail and balance reads say "unavailable".
 * - People are canonical subjects (usr_…). subjectFor() uses identity-sync's subjectOf() (the
 *   subject Network put in the person's token) and then Network's identity map; a Live user with
 *   neither cannot move money. The integer Live id is never sent to Billing.
 */
const { http } = require('openvibe-contracts');
const principal = require('../net/network-principal');

const AUDIENCE = 'openvibe.billing';
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const KEY_RE = /^[A-Za-z0-9._:-]{8,200}$/;

const baseUrl = () => (process.env.OV_BILLING_INTERNAL_URL || 'http://127.0.0.1:4600').replace(/\/+$/, '');
const publicUrl = () => (process.env.OV_BILLING_PUBLIC_URL || 'https://billing.openvibe.network').replace(/\/+$/, '');
const timeoutMs = (write) => {
    const n = parseInt(process.env.OV_BILLING_TIMEOUT_MS || '', 10);
    return Number.isFinite(n) && n > 0 ? n : (write ? 8000 : 4000);
};

class BillingCallError extends Error {
    constructor(kind, { status = null, code = null, detail = null, details = null, cause = null } = {}) {
        super(detail || code || kind);
        this.name = 'BillingCallError';
        this.kind = kind;          // refused | unavailable | unknown | no_subject | misconfigured
        this.status = status;      // Billing's HTTP status, when there was one
        this.code = code;          // Billing's problem code (billing.insufficient_funds, …)
        this.detail = detail;
        this.details = details;    // problem `details` (e.g. { available, required })
        if (cause) this.cause = cause;
    }
}

// ── Transport ────────────────────────────────────────────────
function connectionNeverMade(err) {
    const c = (err && (err.code || (err.cause && err.cause.code))) || '';
    return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_INVALID_URL'].includes(c);
}

/**
 * One call. opts: { body, idempotencyKey, trace (incoming request headers, for traceparent) }.
 * Resolves the parsed JSON body of a 2xx (plus `_replayed` when Billing replayed the key).
 */
async function request(method, path, { body, idempotencyKey, trace, retried = false } = {}) {
    const write = method !== 'GET';
    if (write && !KEY_RE.test(String(idempotencyKey || ''))) throw new Error(`billing-client: ${method} ${path} needs a valid Idempotency-Key`);
    let auth;
    try { auth = await principal.serviceHeaders(AUDIENCE); }
    catch (err) {
        console.warn(`[Billing] no service token for ${AUDIENCE}: ${err.message}`);
        throw new BillingCallError('unavailable', { code: 'token.unavailable', detail: `no service token: ${err.message}`, cause: err });
    }
    const headers = { Accept: 'application/json', ...auth, ...http.outboundHeaders(http.requestContext(trace || {})) };
    if (write) headers['Idempotency-Key'] = idempotencyKey;
    let payload;
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    let res;
    try {
        res = await fetch(`${baseUrl()}/api/v1${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs(write)) });
    } catch (err) {
        // Reads are always safe to call unanswered; a write that may have been sent is "unknown".
        const kind = !write || connectionNeverMade(err) ? 'unavailable' : 'unknown';
        throw new BillingCallError(kind, { detail: `${method} ${path}: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`, cause: err });
    }
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
    if (res.status === 401 && !retried) {           // token rotated/expired under us: once more with a fresh one
        principal.invalidate(AUDIENCE);
        return request(method, path, { body, idempotencyKey, trace, retried: true });
    }
    if (res.ok) {
        const out = json || {};
        if (res.headers.get('idempotent-replayed') === 'true') Object.defineProperty(out, '_replayed', { value: true });
        return out;
    }
    const code = (json && json.code) || null;
    const detail = (json && (json.detail || json.error)) || `${res.status} ${res.statusText}`;
    if (res.status === 401 || res.status === 403) {
        console.error(`[Billing] ${method} ${path} refused Live's service token (${res.status} ${code || ''}): ${detail} — check Live's grants on audience ${AUDIENCE}`);
        throw new BillingCallError('misconfigured', { status: res.status, code, detail });
    }
    if (res.status === 503 && code === 'billing.frozen') throw new BillingCallError('refused', { status: 503, code, detail });
    if (res.status >= 500) {
        // 502/503: Billing (or its readiness gate) refused before acting. A 500 or 504 on a write
        // may have come after the effect committed, so its outcome is unknown until re-sent.
        const kind = write && (res.status === 500 || res.status === 504) ? 'unknown' : 'unavailable';
        throw new BillingCallError(kind, { status: res.status, code, detail });
    }
    throw new BillingCallError('refused', { status: res.status, code, detail, details: json && json.details });
}

// ── Subjects ─────────────────────────────────────────────────
const _subjects = new Map();   // live user id -> usr_ id (only hits are cached)
const _owners = new Map();     // usr_ id -> live user id

async function resolveViaNetwork(liveUserId) {
    const net = (process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
    const res = await fetch(`${net}/internal/identity/resolve-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await principal.serviceHeaders('openvibe.network')) },
        body: JSON.stringify({ system: 'live', type: 'user', ids: [String(liveUserId)] }),
        signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`resolve-batch ${res.status}`);
    const out = await res.json();
    const hit = out && out.results && out.results[String(liveUserId)];
    return hit && hit.subject ? hit.subject.id : null;
}

/**
 * Canonical subject of a Live user, or a BillingCallError('no_subject'). `role` only shapes the
 * message ('self' = the person acting, 'recipient' = the streamer on the other side).
 */
async function subjectFor(liveUserId, { role = 'self' } = {}) {
    const id = Number(liveUserId);
    if (!Number.isInteger(id) || id <= 0) throw new BillingCallError('no_subject', { detail: 'no account' });
    if (_subjects.has(id)) return _subjects.get(id);
    let sid = null;
    try { sid = require('../auth/identity-sync').subjectOf(id); } catch { /* */ }
    if (!sid) {
        try { sid = await resolveViaNetwork(id); }
        catch (err) { console.warn(`[Billing] subject lookup for live user ${id} failed: ${err.message}`); }
    }
    if (!SUBJECT_RE.test(String(sid || ''))) {
        throw new BillingCallError('no_subject', {
            detail: role === 'recipient'
                ? 'This streamer\'s account is not linked to an OpenVibe account yet, so it cannot receive Vibes right now.'
                : 'Your account is not linked to an OpenVibe account yet — sign out and back in, then try again.',
        });
    }
    _subjects.set(id, sid);
    _owners.set(sid, id);
    return sid;
}

/** Live users for a list of subjects (for history/subscription displays). Map usr_ -> user row. */
function liveUsersForSubjects(subjects) {
    const out = new Map();
    const want = [...new Set((subjects || []).filter((s) => SUBJECT_RE.test(String(s || ''))))];
    if (!want.length) return out;
    const db = require('../db/database');
    const rows = db.getDb().prepare(`SELECT l.subject_id, u.id, u.username, u.display_name, u.avatar_url FROM linked_accounts l JOIN users u ON u.id = l.user_id
        WHERE l.service = 'network' AND l.subject_id IN (${want.map(() => '?').join(',')})`).all(...want);
    for (const r of rows) out.set(r.subject_id, r);
    for (const s of want) {
        if (out.has(s) || !_owners.has(s)) continue;
        const u = db.getUserById(_owners.get(s));
        if (u) out.set(s, { subject_id: s, id: u.id, username: u.username, display_name: u.display_name, avatar_url: u.avatar_url });
    }
    return out;
}

const ref = (sid) => ({ type: 'user', id: sid });

// ── Typed calls (one per Billing operation Live uses) ───────
const enc = encodeURIComponent;
const api = {
    ready: async () => {
        const res = await fetch(`${baseUrl()}/api/ready`, { signal: AbortSignal.timeout(3000) });
        return { ok: res.ok, status: res.status };
    },
    rates: (o) => request('GET', '/rates', o),
    /** billing.intent.create */
    createIntent: (body, o) => request('POST', '/intents', { ...o, body }),
    getIntent: (id, o) => request('GET', `/intents/${enc(id)}`, o),
    captureIntent: (id, o) => request('POST', `/intents/${enc(id)}/capture`, { ...o, body: {} }),
    /** billing.transfer.create */
    transfer: (body, o) => request('POST', '/transfers', { ...o, body }),
    refundTransfer: (txnId, body, o) => request('POST', `/transfers/${enc(txnId)}/refund`, { ...o, body }),
    /** billing.cashout.request */
    recycle: (body, o) => request('POST', '/recycle', { ...o, body }),
    requestCashout: (body, o) => request('POST', '/cashouts', { ...o, body }),
    /** billing.subscription.manage */
    subscribe: (body, o) => request('POST', '/subscriptions', { ...o, body }),
    cancelSubscription: (id, body, o) => request('POST', `/subscriptions/${enc(id)}/cancel`, { ...o, body }),
    /** billing.entitlement.check */
    listSubscriptions: (q, o) => request('GET', `/subscriptions?${new URLSearchParams(Object.entries(q).filter(([, v]) => v != null))}`, o),
    entitlement: (subject, streamer, o) => request('GET', `/entitlements/${enc(subject)}?streamer=${enc(streamer)}`, o),
    /** billing.balance.read */
    balance: (subject, o) => request('GET', `/balances/${enc(subject)}`, o),
    transactions: (subject, { limit = 50, cursor } = {}, o) => request('GET', `/transactions?${new URLSearchParams({ subject, limit: String(limit), ...(cursor ? { cursor } : {}) })}`, o),
};

module.exports = {
    AUDIENCE, BillingCallError, request, subjectFor, liveUsersForSubjects, ref, api, baseUrl, publicUrl, SUBJECT_RE, KEY_RE,
    _reset() { _subjects.clear(); _owners.clear(); },
};
