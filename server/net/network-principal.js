'use strict';
/**
 * Live as a service principal toward OpenVibe.Network (ADR-003).
 *
 * headersFor(path) returns the auth headers for one internal call: a short-lived, capability-scoped token from
 * Network's /oauth/token (client_credentials with Live's OAuth client id and secret; the token carries every capability
 * Network grants Live for audience openvibe.network). Every /internal route Live calls takes a token; the shared
 * X-Internal-Key is no longer sent (plan T2). Without a token (no OV_OAUTH_CLIENT_SECRET, Network down) the call
 * throws, and callers treat it like Network being unreachable. After a 401, call tokenRejected() and retry once: the
 * retry mints a fresh token.
 */
const { serviceAuth } = require('openvibe-contracts');

const NETWORK_INTERNAL_URL = (process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
const CLIENT_ID = process.env.OV_OAUTH_CLIENT_ID || 'live';
const CLIENT_SECRET = process.env.OV_OAUTH_CLIENT_SECRET || '';

const _clients = new Map();
/** One cached client-credentials token client per audience (openvibe.network, openvibe.community, ...). */
function clientFor(audience) {
    if (!CLIENT_SECRET) return null;
    if (!_clients.has(audience)) {
        _clients.set(audience, serviceAuth.createTokenClient({ tokenUrl: `${NETWORK_INTERNAL_URL}/oauth/token`, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, audience }));
    }
    return _clients.get(audience);
}

/** True when Live can call Network's internal API at all (it has its OAuth client secret). */
function configured() { return Boolean(CLIENT_SECRET); }

/** Bearer headers for another service. Throws when no token can be had. */
async function serviceHeaders(audience) {
    const c = clientFor(audience);
    if (!c) throw new Error('OV_OAUTH_CLIENT_SECRET is not set');
    return c.authHeaders();
}
function invalidate(audience) { const c = _clients.get(audience); if (c) c.invalidate(); }

const stats = { token: 0, tokenFailures: 0 };
let lastFailure = null;

/** Bearer headers for one call to Network's internal API (`path` is kept for the callers' logs). */
async function headersFor(path) {
    try {
        const h = await serviceHeaders('openvibe.network');
        stats.token++;
        return h;
    } catch (err) {
        stats.tokenFailures++;
        if (lastFailure !== err.message) console.warn(`[Principal] no service token for ${path} (${err.message})`);
        lastFailure = err.message;
        throw err;
    }
}

/** A token call came back 401: drop the cached token so the retry mints a fresh one. */
function tokenRejected(problemCode) {
    invalidate('openvibe.network');
    console.warn(`[Principal] Network refused the service token (${problemCode || '401'}); minting a fresh one`);
}

module.exports = { headersFor, tokenRejected, serviceHeaders, invalidate, configured, stats, _reset() { for (const c of _clients.values()) c.invalidate(); } };
