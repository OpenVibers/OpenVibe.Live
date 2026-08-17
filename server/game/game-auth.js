/**
 * OpenVibeGame — auth helpers
 * Allows authenticated users and anonymous players with chat-style anon IDs.
 */
const db = require('../db/database');
const chatServer = require('../chat/chat-server');
const { extractWsToken, authenticateWs } = require('../auth/auth');

function getRequestIp(req) {
    const rawIp = req?.headers?.['cf-connecting-ip']
        || req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
        || req?.socket?.remoteAddress || req?.connection?.remoteAddress || 'unknown';
    return chatServer.normalizeIp(rawIp);
}

function getAnonGameIdentityFromIp(ip) {
    const normalizedIp = chatServer.normalizeIp(ip);
    const anonId = chatServer.getAnonIdForConnection(normalizedIp, null);
    const user = db.getOrCreateAnonGameUser(anonId);
    if (!user) {
        throw new Error('Unable to create anonymous OpenVibeGame profile');
    }
    return {
        user,
        anonId,
        isAnon: true,
    };
}

function resolveGameIdentity({ req, token, ip }) {
    const authToken = token ?? (req ? extractWsToken(req) : null);
    const user = authenticateWs(authToken);
    if (user) {
        return {
            user,
            anonId: null,
            isAnon: false,
        };
    }

    return getAnonGameIdentityFromIp(ip || getRequestIp(req));
}

function requireGameAuth(req, res, next) {
    try {
        const identity = resolveGameIdentity({ req });
        if (!identity?.user) {
            return res.status(401).json({ error: 'Unable to resolve game identity' });
        }
        if (identity.user.is_banned) {
            return res.status(403).json({ error: 'Account is banned', reason: identity.user.ban_reason });
        }

        req.user = identity.user;
        req.gameIdentity = identity;
        next();
    } catch (e) {
        res.status(500).json({ error: e.message || 'Failed to resolve game identity' });
    }
}

module.exports = {
    getRequestIp,
    getAnonGameIdentityFromIp,
    resolveGameIdentity,
    requireGameAuth,
};
