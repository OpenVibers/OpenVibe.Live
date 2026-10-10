/**
 * OpenVibe.Live — OpenCoins wallet client (OpenVibe.Network-owned)
 *
 * The network-wide OpenCoins wallet lives in OpenVibe.Network (see CONTRACTS.md,
 * "OpenCoins wallet"). Live keeps no balance of its own: every read, earn and spend
 * goes through this client (the legacy users.openvibe_coins_balance column is read by
 * nothing; test/coins-column-unread.test.js keeps it that way until it is dropped).
 *
 *   POST /internal/coins/credit|debit|transfer   (Live's service token, server-to-server)
 *   GET  /api/coins/me, /api/coins/me/history    (Bearer user JWT, read-side)
 *
 * user ids: the wallet is keyed by the NETWORK (SSO) user id, never Live's local
 * row id — resolved via linked_accounts (service='network').
 */
'use strict';
const db = require('../db/database');
const principal = require('../net/network-principal');

const NETWORK_INTERNAL_URL = (process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');

class WalletError extends Error {
    constructor(message, status, body) {
        super(message);
        this.name = 'WalletError';
        this.status = status || 0;
        this.body = body || null;
    }
}

/** Resolve a Live-local user id to their Network (SSO) user id, or null if unlinked. */
async function networkUserId(localUserId) {
    if (!localUserId) return null;
    try {
        const row = await db.getDb().prepare(
            "SELECT service_user_id FROM linked_accounts WHERE service = 'network' AND user_id = ?"
        ).get(localUserId);
        if (!row || row.service_user_id == null) return null;
        const n = Number(row.service_user_id);
        return Number.isFinite(n) ? n : row.service_user_id;
    } catch {
        return null;
    }
}

async function _post(apiPath, body, retried = false) {
    let res;
    let auth;
    try { auth = await principal.headersFor(apiPath); } catch (err) {   // Live's scoped service token
        throw new WalletError(`Network wallet unavailable: no service token (${err.message})`, 0);
    }
    try {
        res = await fetch(`${NETWORK_INTERNAL_URL}${apiPath}`, {
            method: 'POST',
            headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body),
        });
    } catch (err) {
        throw new WalletError(`Network wallet unreachable: ${err.message}`, 0);
    }
    const json = await res.json().catch(() => null);
    // A rejected token (a key rotation, a revoked grant) is retried once with a freshly minted token.
    // Idempotency keys make the retry safe: a credit that did land is not applied twice.
    if (res.status === 401 && auth.Authorization && !retried) {
        principal.tokenRejected(json && json.code);
        return await _post(apiPath, body, true);
    }
    if (!res.ok) {
        throw new WalletError((json && json.error) || `wallet ${res.status}`, res.status, json);
    }
    return json;
}

/**
 * Credit OpenCoins. `localUserId` is Live's local id (resolved to the network id).
 * Idempotency keys follow `live:<event>:<uniqueid>` — a repeat key never double-credits.
 * Returns { balance } or null when the user has no linked network account.
 */
async function credit(localUserId, amount, reason, idempotencyKey, ref = null) {
    const user_id = await networkUserId(localUserId);
    if (!user_id) return null;
    return await _post('/internal/coins/credit', {
        user_id, app_id: 'live', amount: Math.max(1, Math.round(amount)),
        reason, ref: ref || undefined, idempotency_key: idempotencyKey,
    });
}

/**
 * Debit OpenCoins. Throws WalletError(status 409, body.error='insufficient_funds')
 * when the balance is too low. Returns { balance } or null when unlinked.
 */
async function debit(localUserId, amount, reason, idempotencyKey, ref = null) {
    const user_id = await networkUserId(localUserId);
    if (!user_id) return null;
    return await _post('/internal/coins/debit', {
        user_id, app_id: 'live', amount: Math.max(1, Math.round(amount)),
        reason, ref: ref || undefined, idempotency_key: idempotencyKey,
    });
}

/** Atomic transfer between two Live users. Returns { from_balance, to_balance } or null. */
async function transfer(fromLocalId, toLocalId, amount, reason, idempotencyKey, ref = null) {
    const from_user_id = await networkUserId(fromLocalId);
    const to_user_id = await networkUserId(toLocalId);
    if (!from_user_id || !to_user_id) return null;
    return await _post('/internal/coins/transfer', {
        from_user_id, to_user_id, app_id: 'live', amount: Math.max(1, Math.round(amount)),
        reason, ref: ref || undefined, idempotency_key: idempotencyKey,
    });
}

/** Balance read on behalf of a browser user — forwards their Network JWT. */
async function balanceForToken(userToken) {
    if (!userToken) return null;
    try {
        const res = await fetch(`${NETWORK_INTERNAL_URL}/api/coins/me`, {
            headers: { Authorization: `Bearer ${userToken}`, Accept: 'application/json' },
        });
        if (!res.ok) return null;
        const j = await res.json().catch(() => null);
        return j && typeof j.balance === 'number' ? j.balance : null;
    } catch {
        return null;
    }
}

/** Transaction history read on behalf of a browser user. */
async function historyForToken(userToken, limit = 50, offset = 0) {
    if (!userToken) return null;
    try {
        const res = await fetch(`${NETWORK_INTERNAL_URL}/api/coins/me/history?limit=${limit}&offset=${offset}`, {
            headers: { Authorization: `Bearer ${userToken}`, Accept: 'application/json' },
        });
        if (!res.ok) return null;
        const j = await res.json().catch(() => null);
        return j && Array.isArray(j.transactions) ? j.transactions : null;
    } catch {
        return null;
    }
}

/**
 * Site-wide OpenCoins totals for the home hero stat board.
 *
 * The coin ledger lives on OpenVibe.Network, so this is the only way Live can show what the
 * network economy looks like. Held for five minutes and never allowed to fail loudly: the hero
 * simply drops the coin chips if the network is unreachable, rather than losing the whole board.
 */
let _statsCache = { at: 0, data: null };
async function networkCoinStats() {
    if (_statsCache.data && Date.now() - _statsCache.at < 5 * 60 * 1000) return _statsCache.data;
    try {
        const ctl = AbortSignal.timeout ? AbortSignal.timeout(2500) : undefined;
        const res = await fetch(`${NETWORK_INTERNAL_URL}/internal/coins/stats`, {
            headers: { ...(await principal.headersFor('/internal/coins/stats')), Accept: 'application/json' },
            signal: ctl,
        });
        if (!res.ok) return _statsCache.data;
        const data = await res.json();
        _statsCache = { at: Date.now(), data };
        return data;
    } catch {
        return _statsCache.data;   // stale is fine; missing is fine
    }
}

module.exports = { WalletError, networkUserId, credit, debit, transfer, balanceForToken, historyForToken, networkCoinStats };
