/**
 * powerchat-oauth.js — PowerChat OAuth 2.0 (authorization-code + PKCE) + token management
 * + a thin authenticated REST client.
 *
 * PowerChat is a streamer donations/alerts service. OpenVibe.Live registers ONE confidential
 * OAuth app (client_id/secret configured by the owner in admin); each streamer then grants it
 * access to their own PowerChat account. We use the INTEGRATION direction (receive donations
 * via webhooks + attribute tip checkouts), so the requested scopes are read-focused.
 *
 * Security invariants (per the PowerChat docs):
 *  - Access tokens are ~10-min JWTs; refresh tokens ROTATE on every use. Reusing an old
 *    refresh token revokes the entire token family — so we persist the newest pair
 *    atomically and never replay an old one.
 *  - PKCE (S256) is used in addition to the client secret.
 *  - OAuth `state` is a signed, short-lived cookie (double-submit CSRF), same as the
 *    restream platform-OAuth flow.
 */
'use strict';

const crypto = require('crypto');
const db = require('../db/database');
const config = require('../config');

const JWT_SECRET = process.env.JWT_SECRET || 'openvibelive-dev-secret';
const STATE_TTL_MS = 10 * 60 * 1000;

function s(k) { return String(db.getSetting(k) || '').trim(); }
function b(k) { const v = db.getSetting(k); return v === true || v === 'true' || v === 1 || v === '1'; }

// ── App-level config (from admin site_settings) ──────────────────────────────
function getConfig() {
    const baseUrl = (s('powerchat_base_url') || 'https://powerchatlive.dev').replace(/\/+$/, '');
    return {
        enabled: b('powerchat_enabled'),
        baseUrl,
        clientId: s('powerchat_client_id'),
        clientSecret: s('powerchat_client_secret'),
        webhookSecret: s('powerchat_webhook_secret'),
        // Request the integration scopes AND the platform scopes we actually use
        // (chat:write / viewcount:write / subscriptions:write / follows:write /
        // currency:write / tips:write), so the grant carries them — otherwise every
        // platform intake call 403s. NOTE: the DB seeds this setting, so the seeded
        // value in database.js is what actually applies — keep the two lists in sync.
        // Widening the list requires the streamer to reconnect (re-consent) to re-mint
        // tokens with the wider set.
        scopes: s('powerchat_scopes') || 'profile:read webhooks:events checkout:attribute paid_messages:read alerts:trigger chat:write viewcount:write subscriptions:write follows:write currency:write tips:write',
        sandboxUsername: s('powerchat_sandbox_username') || 'alex',
        authorizeUrl: `${baseUrl}/oauth/authorize`,
        tokenUrl: `${baseUrl}/oauth/token`,
        revokeUrl: `${baseUrl}/oauth/revoke`,
        apiBase: `${baseUrl}/api/dev/v1`,
    };
}
// True once the owner has entered the client id + secret (webhook secret optional but
// required for webhooks to be accepted).
function isConfigured() {
    const c = getConfig();
    return !!(c.clientId && c.clientSecret);
}
function redirectUri() {
    return `${String(config.baseUrl).replace(/\/+$/, '')}/api/powerchat/oauth/callback`;
}

// ── PKCE ─────────────────────────────────────────────────────────────────────
function generatePkce() {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    return { codeVerifier, codeChallenge };
}

// ── Signed state cookie (CSRF) ───────────────────────────────────────────────
function signState(payload) {
    const body = Buffer.from(JSON.stringify({ ...payload, ts: Date.now() })).toString('base64url');
    const sig = crypto.createHmac('sha256', JWT_SECRET).update(body).digest('base64url');
    return `${body}.${sig}`;
}
function verifyState(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const [body, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(body).digest('base64url');
    try {
        if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    } catch { return null; }
    let data;
    try { data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
    if (!data || !data.ts || (Date.now() - data.ts) > STATE_TTL_MS) return null;
    return data;
}

// ── Authorize URL ────────────────────────────────────────────────────────────
// Returns { url, stateToken } — stateToken goes in the httpOnly cookie; the URL `state`
// param is just the nonce (double-submit check on callback).
function buildAuthorize({ userId, username }) {
    const c = getConfig();
    const nonce = crypto.randomBytes(16).toString('base64url');
    const { codeVerifier, codeChallenge } = generatePkce();
    const params = new URLSearchParams({
        client_id: c.clientId,
        redirect_uri: redirectUri(),
        response_type: 'code',
        scope: c.scopes,
        state: nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
    });
    const stateToken = signState({ userId, username: username || '', nonce, codeVerifier });
    return { url: `${c.authorizeUrl}?${params.toString()}`, stateToken };
}

// ── Token endpoint helpers ───────────────────────────────────────────────────
function normalizeToken(json) {
    const expiresIn = Number(json.expires_in) || 600;
    return {
        access_token: json.access_token,
        refresh_token: json.refresh_token || null,
        token_expires_at: Date.now() + expiresIn * 1000,
        scope: json.scope || null,
        // The token response carries the authorizing streamer — the documented, stable
        // identity source (the access token is opaque and must NOT be parsed).
        streamer: json.streamer || null,
    };
}

// Access tokens are JWTs — decode the (unverified) payload to read the streamer identity
// the grant is for, so we never have to ask the streamer for their own username.
function decodeJwtPayload(token) {
    try {
        const part = String(token || '').split('.')[1];
        if (!part) return null;
        return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    } catch { return null; }
}
// Pull a username + id out of whatever claim shape PowerChat uses. We check the common
// OAuth/OIDC identity claims rather than assuming one exact name.
function identityFromToken(accessToken) {
    const c = decodeJwtPayload(accessToken) || {};
    const username = c.username || c.preferred_username || c.streamer_username
        || c.streamer || c.slug || c.name || (typeof c.sub === 'string' && /[a-z]/i.test(c.sub) ? c.sub : null) || null;
    const id = (c.streamer_id != null ? c.streamer_id : (c.user_id != null ? c.user_id : c.sub)) ?? null;
    return { username: username ? String(username) : null, id: id != null ? String(id) : null };
}

async function _postToken(form) {
    const c = getConfig();
    let res;
    try {
        res = await fetch(c.tokenUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
                // A browser-like UA so PowerChat's bot protection is less likely to 404 us.
                'User-Agent': 'OpenVibe.Live/1.0 (+https://openvibe.live)',
            },
            body: new URLSearchParams(form).toString(),
        });
    } catch (e) {
        const err = new Error(`Could not reach PowerChat's token endpoint (${c.tokenUrl}): ${e.message}`);
        err.oauthError = 'network'; throw err;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
        // 404 here is not a normal OAuth error — the endpoint IS correct (per PowerChat's
        // own metadata) and works from a browser. Getting 404 from our server almost always
        // means PowerChat's edge (Cloudflare) is blocking server-to-server / datacenter
        // requests to its OAuth+API paths. Surface that clearly so it isn't mistaken for a
        // OpenVibe.Live bug.
        if (res.status === 404) {
            const ray = res.headers.get('cf-ray') || '';
            const err = new Error(`PowerChat returned 404 for its token endpoint when called from our server (the same endpoint works from a browser). This is a PowerChat-side block on server-to-server requests — ask PowerChat support to allow the Developer API from OpenVibe.Live's server${ray ? ` (cf-ray ${ray})` : ''}.`);
            err.oauthError = 'blocked_404'; err.status = 404; throw err;
        }
        const err = new Error((json.error_description || json.error || `token endpoint ${res.status}`));
        err.oauthError = json.error || `http_${res.status}`;
        err.status = res.status;
        throw err;
    }
    return json;
}

async function exchangeCode(code, codeVerifier) {
    const c = getConfig();
    return normalizeToken(await _postToken({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(),
        client_id: c.clientId,
        client_secret: c.clientSecret,
        code_verifier: codeVerifier,
    }));
}

async function refreshToken(refresh_token) {
    const c = getConfig();
    return normalizeToken(await _postToken({
        grant_type: 'refresh_token',
        refresh_token,
        client_id: c.clientId,
        client_secret: c.clientSecret,
    }));
}

async function revokeToken(token) {
    const c = getConfig();
    try {
        await fetch(c.revokeUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token, client_id: c.clientId, client_secret: c.clientSecret }).toString(),
        });
    } catch { /* best-effort */ }
}

// ── Valid access token (auto-refresh at use, atomic rotation) ────────────────
// Returns a usable access token for the streamer, refreshing + persisting the rotated
// pair when near expiry. On a reuse/invalid_grant failure the family is dead → we clear
// the tokens so the streamer is prompted to re-authorize. Throws on unrecoverable states.
async function getValidAccessToken(userId, { force = false } = {}) {
    const conn = db.getPowerchatConnection(userId);
    if (!conn || !conn.access_token) throw new Error('PowerChat not connected');
    // Normally reuse the stored token until it's near expiry. `force` (used after a 401)
    // refreshes regardless — the stored token may be valid by our clock yet rejected as
    // "an older credential generation" because PowerChat rotated the token family.
    if (!force && conn.token_expires_at && (conn.token_expires_at - Date.now()) > 60000) {
        return conn.access_token;
    }
    if (!conn.refresh_token) throw new Error('PowerChat token expired — reconnect required');
    let t;
    try {
        t = await refreshToken(conn.refresh_token);
    } catch (err) {
        // invalid_grant almost always means the refresh token was already rotated/revoked
        // (family killed) or the streamer revoked consent → force a reconnect.
        if (err.oauthError === 'invalid_grant' || err.status === 400 || err.status === 401) {
            db.setPowerchatConnectionError(userId, `Reconnect needed: ${err.oauthError || err.message}`);
            db.updatePowerchatTokens(userId, { access_token: null, refresh_token: null, token_expires_at: null, scope: conn.scope });
        }
        throw err;
    }
    // Persist the NEW pair atomically before using it. PowerChat rotates the refresh
    // token on every use, but defend against a response that omits it — writing null
    // would strand the connection with no way to refresh.
    if (!t.refresh_token) t.refresh_token = conn.refresh_token;
    db.updatePowerchatTokens(userId, t);
    return t.access_token;
}

// ── Authenticated REST client ────────────────────────────────────────────────
// path is relative to /streamers/:username, e.g. '/profile'. `username` defaults to the
// streamer's stored PowerChat username (sandbox: the app owner's).
async function apiRequest(userId, { method = 'GET', path, username, body, query } = {}) {
    const c = getConfig();
    const conn = db.getPowerchatConnection(userId);
    const uname = username || (conn && conn.powerchat_username) || c.sandboxUsername;
    let url = `${c.apiBase}/streamers/${encodeURIComponent(uname)}${path}`;
    if (query) { const qs = new URLSearchParams(query).toString(); if (qs) url += `?${qs}`; }

    // One authenticated attempt; on a 401 (expired / rotated / "older credential
    // generation") force a token refresh and retry exactly once.
    const attempt = async (force) => {
        const token = await getValidAccessToken(userId, { force });
        const res = await fetch(url, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                'Accept': 'application/json',
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        const json = await res.json().catch(() => ({}));
        return { res, json };
    };

    let { res, json } = await attempt(false);
    if (res.status === 401) {
        // Refresh-and-retry. If the refresh itself is rejected, getValidAccessToken
        // clears the tokens (reconnect needed) and throws.
        ({ res, json } = await attempt(true));
    }
    if (!res.ok) {
        const e = new Error((json.error && json.error.message) || `PowerChat API ${res.status}`);
        e.status = res.status;
        e.code = json.error && json.error.code;
        throw e;
    }
    return json;
}

// Public profile + live status + tipPageUrl (scope profile:read).
async function fetchProfile(userId, username) {
    return apiRequest(userId, { method: 'GET', path: '/profile', username });
}

module.exports = {
    getConfig, isConfigured, redirectUri,
    buildAuthorize, verifyState, exchangeCode, refreshToken, revokeToken,
    getValidAccessToken, apiRequest, fetchProfile, normalizeToken,
    decodeJwtPayload, identityFromToken,
};
