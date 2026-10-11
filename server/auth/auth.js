/**
 * OpenVibe.Live — JWT Auth Middleware
 * All authentication is handled via OpenVibe.Network RS256 tokens, checked by openvibe-sdk/auth.
 * Users sign in on openvibe.network and are redirected back via OAuth2.
 * Local user records are resolved via linked_accounts.
 */
const { createNetworkKeys, verifyUserToken } = require('openvibe-sdk/auth');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');

// ── OpenVibe.Network signing keys (RS256 verification) ──────────
// openvibe-sdk/auth createNetworkKeys: the key file when there is one (as before), else Network's JWKS, with a
// rotation honoured on an unknown kid and the last good keys kept through an outage. Nothing is fetched at module
// load: the JWKS (when used) loads on the first verification, or at boot through startNetworkKeys().
let networkKeys = null;
let keySource = null;

// The issuer is the public-facing URL of openvibe.network (the SSO provider).
// It's initialized from env or registry after config loads; we read it lazily
// at verify-time so config.refreshRegistry() updates are picked up automatically.
const config = require('../config');
function getNetworkIssuer() {
    return config.openvibeToolsUrl || process.env.OV_NETWORK_URL || 'https://openvibe.network';
}

function loadNetworkPublicKey() {
    const keyPaths = [
        process.env.OV_NETWORK_PUBLIC_KEY,
        require('../paths').data('keys', 'openvibe-tools-public.pem'),
        '/opt/openvibe/openvibe-tools/data/keys/public.pem',
    ].filter(Boolean);

    let pem = null;
    keySource = null;
    for (const p of keyPaths) {
        try {
            if (fs.existsSync(p)) {
                pem = fs.readFileSync(p, 'utf8');
                keySource = p;
                break;
            }
        } catch { /* try next */ }
    }
    if (networkKeys) networkKeys.stop();
    networkKeys = createNetworkKeys({ network: config.openvibeToolsInternalUrl || process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000', publicKey: pem, log: console });
    if (pem) console.log(`[Auth] Loaded openvibe.network public key from ${keySource}`);
    else console.log(`[Auth] No openvibe.network key file: verifying against Network's JWKS (${networkKeys.url})`);
}
loadNetworkPublicKey();

/** Boot (never a drill): load Network's JWKS now and keep it fresh, when there is no key file. */
function startNetworkKeys() { networkKeys.start().catch(() => { /* logged by the JWKS client */ }); }


/**
 * Verify a openvibe.network RS256 JWT token.
 * Returns decoded payload or null.
 */
// verifyUserToken refuses what is not a person's session though Network signs it with the same key: a typed token
// (`typ`/`purpose`: a FedCM assertion, a realtime ticket, an export token) and a service/app principal token.
async function verifyToken(token) {
    const r = await verifyTokenWithReason(token);
    return r.ok ? r.decoded : null;
}

/**
 * Like verifyToken but returns the error name for diagnostics.
 * For WS auth logging only.
 */
async function verifyTokenWithReason(token) {
    let decoded;
    try {
        decoded = await verifyUserToken(String(token || ''), { ...networkKeys.verifyOptions, issuer: getNetworkIssuer() });
    } catch (err) {
        // openvibe-sdk/auth codes: token.malformed, token.bad_signature, token.expired, token.not_user, token.no_key, …
        return { ok: false, reason: (err && err.code) || 'token.invalid', message: err && err.message };
    }
    // Signed out everywhere / password changed / banned since this token was issued (WS-B task 4).
    if (await require('./revocations').isRevoked(decoded)) return { ok: false, reason: 'revoked' };
    return { ok: true, decoded };
}

/**
 * Resolve a openvibe.network user to a local OpenVibe.Live user.
 * Checks linked_accounts first, falls back to username match,
 * auto-creates a local account if none found.
 */
// Keep the local user's role + profile fields in sync with the openvibe.network SSO token
// on EVERY auth — not just at account creation — so role changes (e.g. an admin grant
// in openvibe.network/admin) propagate. Only writes when a value actually changed. The local
// `is_owner` flag is NOT in the token and is never touched here.
const _ROLE_RANK = { user: 0, streamer: 1, global_mod: 2, admin: 3 };

async function _syncSsoUserFields(user, decoded) {
    if (!user || !decoded) return user;
    // Renamed on the Network (staff only; the old name stays theirs there): follow it here, and
    // /@old keeps working as a 301 (server/auth/usernames.js, WS-B task 6).
    if (typeof decoded.username === 'string' && user.username && decoded.username.toLowerCase() !== String(user.username).toLowerCase()) {
        try { if (await require('./usernames').syncUsername(user.id, decoded.username)) user = await db.getUserById(user.id) || user; } catch { /* keep the old name */ }
    }
    const updates = [];
    const params = [];
    if (decoded.avatar_url && decoded.avatar_url !== user.avatar_url) { updates.push('avatar_url = ?'); params.push(decoded.avatar_url); }
    if (decoded.profile_color && decoded.profile_color !== user.profile_color) { updates.push('profile_color = ?'); params.push(decoded.profile_color); }
    // Sync role from the SSO token, but NEVER downgrade based on it. Access tokens
    // live 24h, so a just-promoted admin's older token still carries role:'user'
    // and would otherwise strip their role (and Staff badge) on every connect.
    // Upgrades apply immediately; downgrades arrive from openvibe.network as
    // network.user.updated (server/auth/subject-projection.js) instead of trusting a stale token.
    if (decoded.role && _ROLE_RANK[decoded.role] !== undefined && decoded.role !== user.role
        && _ROLE_RANK[decoded.role] > (_ROLE_RANK[user.role] ?? 0)) {
        updates.push('role = ?'); params.push(decoded.role);
    }
    if (!updates.length) return user;
    try {
        params.push(user.id);
        await db.getDb().prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
        return await db.getUserById(user.id);
    } catch { return user; }
}

async function resolveNetworkUser(decoded) {
    const openvibeToolsId = String(decoded.sub || decoded.id);

    // Check linked_accounts for existing link
    const linked = await db.getDb().prepare(
        "SELECT * FROM linked_accounts WHERE service = 'network' AND service_user_id = ?"
    ).get(openvibeToolsId);

    if (linked) {
        const user = await _syncSsoUserFields(await db.getUserById(linked.user_id), decoded);
        if (user && decoded.subject_id) {
            user.subject_id = decoded.subject_id;
            await require('./identity-sync').noteSubject(user.id, openvibeToolsId, decoded.subject_id);
        }
        return user;
    }

    // Try matching by username (case-insensitive)
    let user = await db.getUserByUsername(decoded.username);
    if (user) {
        // Auto-link this user to the openvibe.network account
        try {
            await db.getDb().prepare(
                "INSERT INTO linked_accounts (service, service_user_id, service_username, user_id) VALUES ('network', ?, ?, ?) ON CONFLICT DO NOTHING"
            ).run(openvibeToolsId, decoded.username, user.id);
            console.log(`[Auth] Auto-linked ${decoded.username} to openvibe.network id ${openvibeToolsId}`);
        } catch { /* already linked */ }
        return await _syncSsoUserFields(user, decoded);
    }

    // Auto-create a local user for this openvibe.network account
    try {
        const stream_key = uuidv4().replace(/-/g, '');
        const result = await db.createUser({
            username: decoded.username,
            display_name: decoded.display_name || decoded.username,
            stream_key,
        });
        user = await db.getUserById(result.lastInsertRowid);

        // Sync profile fields from token claims
        const updates = [];
        const params = [];
        if (decoded.avatar_url) { updates.push('avatar_url = ?'); params.push(decoded.avatar_url); }
        if (decoded.profile_color) { updates.push('profile_color = ?'); params.push(decoded.profile_color); }
        if (decoded.role && ['user', 'streamer', 'global_mod', 'admin'].includes(decoded.role)) {
            updates.push('role = ?'); params.push(decoded.role);
        }
        if (updates.length > 0) {
            params.push(user.id);
            await db.getDb().prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
            user = await db.getUserById(user.id);
        }

        // Create linked_accounts entry
        await db.getDb().prepare(
            "INSERT INTO linked_accounts (user_id, service, service_user_id, service_username) VALUES (?, 'network', ?, ?) ON CONFLICT DO NOTHING"
        ).run(user.id, openvibeToolsId, decoded.username);

        console.log(`[Auth] Auto-created local account for openvibe.network user ${decoded.username} (local id: ${user.id})`);
        return user;
    } catch (err) {
        console.error(`[Auth] Failed to auto-create user for ${decoded.username}:`, err.message);
        return null;
    }
}

/**
 * Try to authenticate via API token (hbt_xxx format)
 * Returns { user, scopes } or null
 */
async function authenticateApiToken(rawToken) {
    if (!rawToken || !rawToken.startsWith('hbt_')) return null;
    const user = await db.validateApiToken(rawToken);
    if (!user) return null;
    return user;
}

/**
 * What an hbt_ API token may do over REST, by scope.
 *
 * Scopes were stored and shown in the token UI but never checked, so a "read" chat-bot token could
 * cash out, delete VODs, or — held by an admin — call every /api/admin route. The rule now:
 *   - money, staff and credential routes refuse API tokens outright;
 *   - reads (GET/HEAD) need any scope;
 *   - writes need the scope that covers the area, and areas with no scope refuse tokens.
 * Session (JWT) auth is unaffected.
 */
const TOKEN_DENIED_PREFIXES = ['/api/admin', '/api/mod', '/api/funds', '/api/payments', '/api/auth/stream-key', '/api/auth/tokens', '/api/cosmetics', '/api/analytics'];
const TOKEN_WRITE_SCOPES = [
    ['/api/chat', ['chat']], ['/api/dm', ['chat']], ['/api/emotes', ['chat']], ['/api/sounds', ['chat']], ['/api/tts', ['chat']],
    ['/api/streams', ['stream']], ['/api/restream', ['stream']], ['/api/robotstreamer', ['stream']], ['/api/thumbnails', ['stream']],
    ['/api/vods', ['stream']], ['/api/clips', ['stream']], ['/api/media', ['stream', 'chat']],
    ['/api/controls', ['control']], ['/api/onvif', ['control']],
    ['/api/vibe-coding', ['vibe_coding_publish']],   // not the broad `stream` scope
];
function apiTokenAllows(req, scopes) {
    const path = String(req.originalUrl || req.url || '').split('?')[0];
    const under = (prefix) => path === prefix || path.startsWith(prefix + '/');
    if (TOKEN_DENIED_PREFIXES.some(under)) return false;
    const list = Array.isArray(scopes) ? scopes : [];
    if (req.method === 'GET' || req.method === 'HEAD') return list.length > 0;
    const rule = TOKEN_WRITE_SCOPES.find(([prefix]) => under(prefix));
    return !!rule && rule[1].some((sc) => list.includes(sc));
}

/**
 * Express middleware — requires valid openvibe.network JWT or API token
 * Resolves to local user via linked_accounts (auto-creates if needed).
 */
async function requireAuth(req, res, next) {
    const token = extractToken(req);
    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    // Try API token first (hbt_ prefix)
    const apiUser = await authenticateApiToken(token);
    if (apiUser) {
        if (apiUser.is_banned) {
            return res.status(403).json({ error: 'Account is banned' });
        }
        if (!apiTokenAllows(req, apiUser.scopes)) {
            return res.status(403).json({ error: 'This API token\'s scopes do not allow this request' });
        }
        req.user = apiUser;
        req.authSource = 'api_token';
        req.tokenScopes = apiUser.scopes || [];
        return next();
    }

    // Fall back to openvibe.network JWT
    const decoded = await verifyToken(token);
    if (!decoded) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const user = await resolveNetworkUser(decoded);
    if (!user) {
        return res.status(401).json({ error: 'Unable to resolve account' });
    }
    if (user.is_banned) {
        return res.status(403).json({ error: 'Account is banned', reason: user.ban_reason });
    }

    req.user = user;
    req.authSource = 'network';
    next();
}

/**
 * Express middleware — optional auth (attaches user if token present)
 */
async function optionalAuth(req, res, next) {
    const token = extractToken(req);
    if (token) {
        // Try API token first
        const apiUser = await authenticateApiToken(token);
        if (apiUser && !apiUser.is_banned && apiTokenAllows(req, apiUser.scopes)) {
            req.user = apiUser;
            req.authSource = 'api_token';
            req.tokenScopes = apiUser.scopes || [];
        } else {
            const decoded = await verifyToken(token);
            if (decoded) {
                const user = await resolveNetworkUser(decoded);
                if (user && !user.is_banned) {
                    req.user = user;
                    req.authSource = 'network';
                }
            }
        }
    }
    next();
}

/**
 * Express middleware — requires admin role
 */
async function requireAdmin(req, res, next) {
    await requireAuth(req, res, () => {
        if (!require('./permissions').isAdmin(req.user)) {
            return res.status(403).json({ error: 'Admin access required' });
        }
        next();
    });
}

/**
 * Express middleware — requires staff (global_mod or admin)
 */
async function requireStaff(req, res, next) {
    await requireAuth(req, res, () => {
        if (!['global_mod', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ error: 'Staff access required' });
        }
        next();
    });
}

/**
 * Express middleware — requires streamer or above role
 */
async function requireStreamer(req, res, next) {
    await requireAuth(req, res, () => {
        if (!['streamer', 'global_mod', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ error: 'Streamer access required' });
        }
        next();
    });
}

/**
 * Extract JWT from Authorization header or cookie
 */
function extractToken(req) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.slice(7);
    }

    // The Network session cookie. (Live's legacy 'token' cookie is no longer read: compatibility register C-05.)
    if (req.cookies) {
        if (req.cookies.ov_token) return req.cookies.ov_token;
    }

    // Raw Node/WebSocket upgrade requests do not go through cookie-parser,
    // so parse the Cookie header directly as a fallback.
    const cookieHeader = req.headers?.cookie;
    if (cookieHeader && typeof cookieHeader === 'string') {
        const parsed = {};
        for (const part of cookieHeader.split(';')) {
            const idx = part.indexOf('=');
            if (idx === -1) continue;
            const key = part.slice(0, idx).trim();
            const value = part.slice(idx + 1).trim();
            if (!key) continue;
            parsed[key] = decodeURIComponent(value);
        }
        if (parsed.ov_token) return parsed.ov_token;
    }

    return null;
}

/**
 * Extract JWT from query parameter (WebSocket upgrade requests)
 */
function extractWsToken(req) {
    // Prefer explicit ?token= query param — clients (e.g. broadcast signaling)
    // put the freshest localStorage token in the URL, which may be newer than
    // a stale httpOnly cookie from an earlier session.
    try {
        const url = new URL(req.url || '/', 'http://localhost');
        const queryToken = url.searchParams.get('token');
        if (queryToken && queryToken !== 'null' && queryToken !== 'undefined') return queryToken;
    } catch { /* fall through */ }

    // Fall back to cookie / Authorization header
    const direct = extractToken(req);
    if (direct) return direct;

    // Legacy: req.query fallback for non-URL parse environments
    return (req.query && req.query.token) || null;
}

/**
 * Authenticate a WebSocket connection (returns user or null)
 * Supports both openvibe.network JWT and API tokens (hbt_xxx)
 */
async function authenticateWs(token) {
    if (!token) return null;
    // Try API token first
    const apiUser = await authenticateApiToken(token);
    if (apiUser) {
        // Attach scopes for chat server to check
        apiUser._authSource = 'api_token';
        return apiUser;
    }
    const result = await verifyTokenWithReason(token);
    if (!result.ok) {
        console.warn(`[Auth] WS JWT verify failed: ${result.reason} \u2014 ${result.message || ''}`);
        return null;
    }
    const user = await resolveNetworkUser(result.decoded);
    if (!user) {
        console.warn(`[Auth] WS resolveNetworkUser failed for sub=${result.decoded.sub} username=${result.decoded.username}`);
    }
    return user;
}

/**
 * Reload the openvibe.network public key (e.g., after key rotation)
 */
function reloadNetworkKey() {
    loadNetworkPublicKey();
}

module.exports = {
    apiTokenAllows,
    verifyToken,
    verifyTokenWithReason,
    getNetworkIssuer,
    // The Network's keys also verify service tokens (server/net/service-guard.js).
    networkVerifyOptions: () => networkKeys.verifyOptions,
    networkKeysLoaded: () => networkKeys.loaded(),
    startNetworkKeys,
    requireAuth,
    optionalAuth,
    requireAdmin,
    requireStaff,
    requireStreamer,
    extractToken,
    extractWsToken,
    authenticateWs,
    authenticateApiToken,
    reloadNetworkKey,
    resolveNetworkUser,
};
