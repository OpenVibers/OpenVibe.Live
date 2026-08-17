/**
 * OpenVibe.Live — JWT Auth Middleware
 * All authentication is handled via OpenVibe.Tools RS256 tokens.
 * Users sign in on openvibe.network and are redirected back via OAuth2.
 * Local user records are resolved via linked_accounts.
 */
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');

// ── OpenVibe.Tools Public Key (RS256 verification) ──────────────
let openvibeToolsPublicKey = null;

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
        path.resolve('./data/keys/openvibe-tools-public.pem'),
        '/opt/openvibe/openvibe-tools/data/keys/public.pem',
    ].filter(Boolean);

    for (const p of keyPaths) {
        try {
            if (fs.existsSync(p)) {
                openvibeToolsPublicKey = fs.readFileSync(p, 'utf8');
                console.log(`[Auth] Loaded openvibe.network public key from ${p}`);
                return;
            }
        } catch { /* try next */ }
    }
    console.error('[Auth] ❌ openvibe.network public key not found — authentication will NOT work!');
}
loadNetworkPublicKey();

/**
 * Verify a openvibe.network RS256 JWT token.
 * Returns decoded payload or null.
 */
function verifyToken(token) {
    if (!openvibeToolsPublicKey) return null;
    try {
        return jwt.verify(token, openvibeToolsPublicKey, {
            algorithms: ['RS256'],
            issuer: getNetworkIssuer(),
        });
    } catch {
        return null;
    }
}

/**
 * Like verifyToken but returns the error name for diagnostics.
 * For WS auth logging only.
 */
function verifyTokenWithReason(token) {
    if (!openvibeToolsPublicKey) return { ok: false, reason: 'no_public_key' };
    try {
        const decoded = jwt.verify(token, openvibeToolsPublicKey, {
            algorithms: ['RS256'],
            issuer: getNetworkIssuer(),
        });
        return { ok: true, decoded };
    } catch (err) {
        return { ok: false, reason: err.name, message: err.message };
    }
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

function _syncSsoUserFields(user, decoded) {
    if (!user || !decoded) return user;
    const updates = [];
    const params = [];
    if (decoded.avatar_url && decoded.avatar_url !== user.avatar_url) { updates.push('avatar_url = ?'); params.push(decoded.avatar_url); }
    if (decoded.profile_color && decoded.profile_color !== user.profile_color) { updates.push('profile_color = ?'); params.push(decoded.profile_color); }
    // Sync role from the SSO token, but NEVER downgrade based on it. Access tokens
    // live 24h, so a just-promoted admin's older token still carries role:'user'
    // and would otherwise strip their role (and Staff badge) on every connect.
    // Upgrades apply immediately; downgrades are pushed authoritatively from
    // openvibe.network via POST /internal/user-role instead of trusting a stale token.
    if (decoded.role && _ROLE_RANK[decoded.role] !== undefined && decoded.role !== user.role
        && _ROLE_RANK[decoded.role] > (_ROLE_RANK[user.role] ?? 0)) {
        updates.push('role = ?'); params.push(decoded.role);
    }
    if (!updates.length) return user;
    try {
        params.push(user.id);
        db.getDb().prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
        return db.getUserById(user.id);
    } catch { return user; }
}

function resolveNetworkUser(decoded) {
    const openvibeToolsId = String(decoded.sub || decoded.id);

    // Check linked_accounts for existing link
    const linked = db.getDb().prepare(
        "SELECT * FROM linked_accounts WHERE service = 'network' AND service_user_id = ?"
    ).get(openvibeToolsId);

    if (linked) {
        return _syncSsoUserFields(db.getUserById(linked.user_id), decoded);
    }

    // Try matching by username (case-insensitive)
    let user = db.getUserByUsername(decoded.username);
    if (user) {
        // Auto-link this user to the openvibe.network account
        try {
            db.getDb().prepare(
                "INSERT OR IGNORE INTO linked_accounts (service, service_user_id, service_username, user_id) VALUES ('network', ?, ?, ?)"
            ).run(openvibeToolsId, decoded.username, user.id);
            console.log(`[Auth] Auto-linked ${decoded.username} to openvibe.network id ${openvibeToolsId}`);
        } catch { /* already linked */ }
        return _syncSsoUserFields(user, decoded);
    }

    // Auto-create a local user for this openvibe.network account
    try {
        const stream_key = uuidv4().replace(/-/g, '');
        const result = db.createUser({
            username: decoded.username,
            email: null,
            password_hash: '$sso$' + require('crypto').randomBytes(32).toString('hex'),
            display_name: decoded.display_name || decoded.username,
            stream_key,
        });
        user = db.getUserById(result.lastInsertRowid);

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
            db.getDb().prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
            user = db.getUserById(user.id);
        }

        // Create linked_accounts entry
        db.getDb().prepare(
            "INSERT OR IGNORE INTO linked_accounts (user_id, service, service_user_id, service_username) VALUES (?, 'network', ?, ?)"
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
function authenticateApiToken(rawToken) {
    if (!rawToken || !rawToken.startsWith('hbt_')) return null;
    const user = db.validateApiToken(rawToken);
    if (!user) return null;
    return user;
}

/**
 * Express middleware — requires valid openvibe.network JWT or API token
 * Resolves to local user via linked_accounts (auto-creates if needed).
 */
function requireAuth(req, res, next) {
    const token = extractToken(req);
    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    // Try API token first (hbt_ prefix)
    const apiUser = authenticateApiToken(token);
    if (apiUser) {
        if (apiUser.is_banned) {
            return res.status(403).json({ error: 'Account is banned' });
        }
        req.user = apiUser;
        req.authSource = 'api_token';
        req.tokenScopes = apiUser.scopes || [];
        return next();
    }

    // Fall back to openvibe.network JWT
    const decoded = verifyToken(token);
    if (!decoded) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const user = resolveNetworkUser(decoded);
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
function optionalAuth(req, res, next) {
    const token = extractToken(req);
    if (token) {
        // Try API token first
        const apiUser = authenticateApiToken(token);
        if (apiUser && !apiUser.is_banned) {
            req.user = apiUser;
            req.authSource = 'api_token';
            req.tokenScopes = apiUser.scopes || [];
        } else {
            const decoded = verifyToken(token);
            if (decoded) {
                const user = resolveNetworkUser(decoded);
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
function requireAdmin(req, res, next) {
    requireAuth(req, res, () => {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        next();
    });
}

/**
 * Express middleware — requires staff (global_mod or admin)
 */
function requireStaff(req, res, next) {
    requireAuth(req, res, () => {
        if (!['global_mod', 'admin'].includes(req.user.role)) {
            return res.status(403).json({ error: 'Staff access required' });
        }
        next();
    });
}

/**
 * Express middleware — requires streamer or above role
 */
function requireStreamer(req, res, next) {
    requireAuth(req, res, () => {
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

    // Check both cookie names: 'token' (legacy openvibelive) and 'ov_token' (shared network)
    if (req.cookies) {
        if (req.cookies.ov_token) return req.cookies.ov_token;
        if (req.cookies.token) return req.cookies.token;
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
        if (parsed.token) return parsed.token;
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
function authenticateWs(token) {
    if (!token) return null;
    // Try API token first
    const apiUser = authenticateApiToken(token);
    if (apiUser) {
        // Attach scopes for chat server to check
        apiUser._authSource = 'api_token';
        return apiUser;
    }
    const result = verifyTokenWithReason(token);
    if (!result.ok) {
        console.warn(`[Auth] WS JWT verify failed: ${result.reason} \u2014 ${result.message || ''}`);
        return null;
    }
    const user = resolveNetworkUser(result.decoded);
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
    verifyToken,
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
