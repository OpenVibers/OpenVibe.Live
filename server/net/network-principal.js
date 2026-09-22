'use strict';
/**
 * Live as a service principal toward OpenVibe.Network (roadmap Wave 1, ADR-003).
 *
 * headersFor(path) returns the auth headers for one internal call: a short-lived, capability-scoped
 * token from Network's /oauth/token (client_credentials, using Live's existing OAuth client id and
 * secret) for the routes Network guards by capability, and the shared X-Internal-Key for every other
 * route. If a token can't be had (Network not upgraded yet, no grant, secret missing) the key is used
 * and token attempts pause for a few minutes, so a Network outage never breaks coins or notifications.
 * After a 401 on a token call, call tokenRejected() and retry once; the retry uses the key.
 */
const { serviceAuth } = require('openvibe-contracts');

const NETWORK_INTERNAL_URL = (process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || process.env.OV_INTERNAL_KEY || '';
const CLIENT_ID = process.env.OV_OAUTH_CLIENT_ID || 'live';
const CLIENT_SECRET = process.env.OV_OAUTH_CLIENT_SECRET || '';
const PAUSE_MS = 5 * 60 * 1000;

// Network routes that accept a service token (OpenVibe.Network server/internal/routes.js TOKEN_ROUTES).
const TOKEN_PATHS = new Set(['/internal/coins/credit', '/internal/coins/debit', '/internal/coins/transfer', '/internal/notifications/push', '/internal/notifications/push-bulk']);

const tokens = CLIENT_SECRET ? serviceAuth.createTokenClient({
    tokenUrl: `${NETWORK_INTERNAL_URL}/oauth/token`, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, audience: 'openvibe.network',
}) : null;
let pausedUntil = 0;
let lastFailure = null;
const stats = { token: 0, key: 0, tokenFailures: 0 };

const legacyHeaders = () => (INTERNAL_API_KEY ? { 'X-Internal-Key': INTERNAL_API_KEY } : {});

async function headersFor(path) {
    if (tokens && TOKEN_PATHS.has(path) && Date.now() >= pausedUntil) {
        try {
            const h = await tokens.authHeaders();
            stats.token++;
            return h;
        } catch (err) {
            stats.tokenFailures++;
            pausedUntil = Date.now() + PAUSE_MS;
            if (lastFailure !== err.message) console.warn(`[Principal] no service token (${err.message}); using the internal key for ${PAUSE_MS / 60000} min`);
            lastFailure = err.message;
        }
    }
    stats.key++;
    return legacyHeaders();
}

/** A token call came back 401: drop the cached token and use the key until the pause ends. */
function tokenRejected(problemCode) {
    if (tokens) tokens.invalidate();
    pausedUntil = Date.now() + PAUSE_MS;
    console.warn(`[Principal] Network refused the service token (${problemCode || '401'}); using the internal key for ${PAUSE_MS / 60000} min`);
}

module.exports = { headersFor, tokenRejected, TOKEN_PATHS, stats, _reset() { pausedUntil = 0; if (tokens) tokens.invalidate(); } };
