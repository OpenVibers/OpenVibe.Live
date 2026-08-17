'use strict';

// ═══════════════════════════════════════════════════════════════
// OpenVibe — Express Middleware
// Auth middleware for services consuming OpenVibe.Network SSO tokens.
// ═══════════════════════════════════════════════════════════════

const { OpenVibeAuthClient } = require('./auth-client');

/**
 * Extract token from request.
 * Priority: Authorization header → cookie → query param (WebSocket)
 */
function extractToken(req) {
    // 1. Authorization: Bearer <token>
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.slice(7);
    }
    // 2. Cookie
    if (req.cookies?.ov_token) return req.cookies.ov_token;
    if (req.cookies?.token) return req.cookies.token;  // legacy compat
    // 3. Query param (WebSocket upgrade)
    if (req.query?.token) return req.query.token;
    return null;
}

/**
 * Create requireOpenVibeAuth middleware.
 * Verifies JWT signed by OpenVibe.Network and attaches req.user.
 *
 * @param {OpenVibeAuthClient} authClient
 * @returns {Function} Express middleware
 */
function requireOpenVibeAuth(authClient) {
    return (req, res, next) => {
        const token = extractToken(req);
        if (!token) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        const user = authClient.verifyToken(token);
        if (!user) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }
        req.user = user;
        req.token = token;
        next();
    };
}

/**
 * Create optionalOpenVibeAuth middleware.
 * Attaches req.user if a valid token is present, otherwise continues.
 *
 * @param {OpenVibeAuthClient} authClient
 * @returns {Function} Express middleware
 */
function optionalOpenVibeAuth(authClient) {
    return (req, _res, next) => {
        const token = extractToken(req);
        if (token) {
            const user = authClient.verifyToken(token);
            if (user) {
                req.user = user;
                req.token = token;
            }
        }
        next();
    };
}

/**
 * Internal API authentication middleware.
 * Verifies X-Internal-Key header for server-to-server calls.
 *
 * @param {string} internalKey - Expected key value
 * @returns {Function} Express middleware
 */
function internalApiAuth(internalKey) {
    return (req, res, next) => {
        const provided = req.headers['x-internal-key'];
        if (!provided || provided !== internalKey) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        next();
    };
}

module.exports = {
    extractToken,
    requireOpenVibeAuth,
    optionalOpenVibeAuth,
    internalApiAuth,
};
