/**
 * OpenVibe.Live — OpenCoins wallet client (OpenVibe.Network-owned)
 *
 * The network-wide OpenCoins wallet lives in OpenVibe.Network (see CONTRACTS.md,
 * "OpenCoins wallet"). Live's legacy local balance column
 * (users.openvibe_coins_balance) is frozen for the migration script; every earn/
 * spend goes through this client now.
 *
 *   POST /internal/coins/credit|debit|transfer   (X-Internal-Key, server-to-server)
 *   GET  /api/coins/me, /api/coins/me/history    (Bearer user JWT, read-side)
 *
 * user ids: the wallet is keyed by the NETWORK (SSO) user id, never Live's local
 * row id — resolved via linked_accounts (service='network').
 */
'use strict';
const db = require('../db/database');

const NETWORK_INTERNAL_URL = (process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || process.env.OV_INTERNAL_KEY || '';

class WalletError extends Error {
    constructor(message, status, body) {
        super(message);
        this.name = 'WalletError';
        this.status = status || 0;
        this.body = body || null;
    }
}

/** Resolve a Live-local user id to their Network (SSO) user id, or null if unlinked. */
function networkUserId(localUserId) {
    if (!localUserId) return null;
    try {
        const row = db.getDb().prepare(
            "SELECT service_user_id FROM linked_accounts WHERE service = 'network' AND user_id = ?"
        ).get(localUserId);
        if (!row || row.service_user_id == null) return null;
        const n = Number(row.service_user_id);
        return Number.isFinite(n) ? n : row.service_user_id;
    } catch {
        return null;
    }
}

async function _post(apiPath, body) {
    let res;
    try {
        res = await fetch(`${NETWORK_INTERNAL_URL}${apiPath}`, {
            method: 'POST',
            headers: { 'X-Internal-Key': INTERNAL_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body),
        });
    } catch (err) {
        throw new WalletError(`Network wallet unreachable: ${err.message}`, 0);
    }
    const json = await res.json().catch(() => null);
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
    const user_id = networkUserId(localUserId);
    if (!user_id) return null;
    return _post('/internal/coins/credit', {
        user_id, app_id: 'live', amount: Math.max(1, Math.round(amount)),
        reason, ref: ref || undefined, idempotency_key: idempotencyKey,
    });
}

/**
 * Debit OpenCoins. Throws WalletError(status 409, body.error='insufficient_funds')
 * when the balance is too low. Returns { balance } or null when unlinked.
 */
async function debit(localUserId, amount, reason, idempotencyKey, ref = null) {
    const user_id = networkUserId(localUserId);
    if (!user_id) return null;
    return _post('/internal/coins/debit', {
        user_id, app_id: 'live', amount: Math.max(1, Math.round(amount)),
        reason, ref: ref || undefined, idempotency_key: idempotencyKey,
    });
}

/** Atomic transfer between two Live users. Returns { from_balance, to_balance } or null. */
async function transfer(fromLocalId, toLocalId, amount, reason, idempotencyKey, ref = null) {
    const from_user_id = networkUserId(fromLocalId);
    const to_user_id = networkUserId(toLocalId);
    if (!from_user_id || !to_user_id) return null;
    return _post('/internal/coins/transfer', {
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

module.exports = { WalletError, networkUserId, credit, debit, transfer, balanceForToken, historyForToken };
