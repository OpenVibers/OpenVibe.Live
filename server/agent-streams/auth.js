'use strict';
/**
 * Who may publish an agent stream, and who is asking to watch one.
 *
 * Publishing (create, renew/revoke a ticket, state, frame, curtain, end) is the person's own call:
 *
 *   - their Live session (the cookie their browser already has); or
 *   - a first-party service token for audience openvibe.live that holds the capability
 *     `live.agent_stream.publish` and names the person — as the token's `sub` (`usr_…`, the design's form, when Network
 *     issues a person token to a Node principal or to Codes/Actor) or in `X-OV-Subject` (`usr_…`, the form Actor
 *     established for a first-party service acting for somebody). A developer-app token and another person's stream are
 *     always refused.
 *
 * Watching is the visitor's session when there is one; the view rule itself is service.mayView.
 */
const contracts = require('openvibe-contracts');
const { verifyServiceToken } = require('openvibe-sdk/auth');
const { optionalAuth, verifyToken, resolveNetworkUser, networkVerifyOptions, getNetworkIssuer } = require('../auth/auth');
const db = require('../db/database');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const AUDIENCE = 'openvibe.live';
// The registry's id (a capability id carries no hyphen); the design's spelling is accepted too, so a token minted
// before the registry entry is pinned still works.
const CAPABILITIES = ['live.agent_stream.publish', 'live.agent-stream.publish'];
const CAPABILITY = CAPABILITIES[0];
const FIRST_PARTY_SUB = /^(svc|node):/;

/** The local account linked to a Network subject, or null. */
async function userForSubject(subject) {
    if (!SUBJECT_RE.test(String(subject || ''))) return null;
    const row = await db.getDb().prepare("SELECT user_id FROM linked_accounts WHERE service = 'network' AND subject_id = ? LIMIT 1").get(subject);
    return row ? await db.getUserById(row.user_id) : null;
}

/** The capability on a service token, with the pinned registry's check when it knows the id. */
function holdsCapability(claims) {
    const c = claims || {};
    if (!Array.isArray(c.cap)) return false;
    return CAPABILITIES.some((capability) => {
        if (!c.cap.includes(capability)) return false;
        if (contracts.capabilities.get(capability)) return contracts.capabilities.check(c, capability).allowed;
        return contracts.capabilities.grants(c.cap, capability);
    });
}

/**
 * The person a first-party service token acts for, or an error code. Only a `svc:`/`node:` token may name somebody;
 * an app or an agent acts as itself, never for a person.
 */
async function personFromServiceToken(req) {
    const auth = String(req.headers.authorization || '');
    if (!auth.startsWith('Bearer ')) return { code: 'token.missing' };
    const token = auth.slice(7).trim();
    if (!token.includes('.')) return { code: 'token.invalid' };
    let payload;
    try { payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { return { code: 'token.invalid' }; }
    // A service token is the only thing with one of these subjects; a person's token is handled by optionalAuth.
    const looksService = payload && typeof payload.sub === 'string' && (FIRST_PARTY_SUB.test(payload.sub) || String(payload.sub).startsWith('app:') || String(payload.sub).startsWith('agent:'));
    if (!looksService) return { code: 'token.not_service' };

    const r = await verifyServiceToken(token, { ...networkVerifyOptions(), issuer: getNetworkIssuer(), audience: AUDIENCE, contracts });
    if (!r.ok) return { code: r.code === 'token.unavailable' ? 'identity.unavailable' : r.code || 'token.invalid' };
    if (!holdsCapability(r.claims)) return { code: 'capability.denied' };

    const sub = String(r.claims.sub);
    let subject = null;
    if (SUBJECT_RE.test(sub)) subject = sub;                       // the design's person token
    else if (FIRST_PARTY_SUB.test(sub)) {                          // a first-party service acting for a person
        const named = req.get ? req.get('x-ov-subject') : req.headers['x-ov-subject'];
        if (named === undefined || named === '') return { code: 'subject.missing' };
        if (!SUBJECT_RE.test(String(named))) return { code: 'subject.invalid' };
        subject = String(named);
    } else {
        return { code: 'subject.not_delegated' };
    }
    const user = await userForSubject(subject);
    if (!user) return { code: 'subject.unknown' };
    if (user.is_banned) return { code: 'user_banned' };
    return { user, subject, via: `service:${sub}` };
}

/** The person publishing: their session, or the first-party service acting for them. */
async function publisher(req, res, next) {
    try {
        await optionalAuth(req, res, () => {});
        if (req.user && !req.user.is_banned) {
            req.publisher = { user: req.user, via: req.authSource || 'session', subject: null };
            return next();
        }
        if (req.user && req.user.is_banned) return res.status(403).json({ error: 'Account is banned', code: 'user_banned' });
        const service = await personFromServiceToken(req);
        if (service.user) {
            req.publisher = { user: service.user, subject: service.subject, via: service.via };
            return next();
        }
        if (service.code === 'identity.unavailable') return res.status(503).json({ error: 'Identity is unavailable', code: service.code });
        if (service.code === 'token.not_service' || service.code === 'token.missing') {
            return res.status(401).json({ error: 'Sign in, or present a service token that holds ' + CAPABILITY, code: 'authentication_required' });
        }
        return res.status(403).json({ error: 'This token may not publish an agent stream', code: service.code });
    } catch (err) {
        next(err);
    }
}

/** The visitor, if any (never refuses). `req.viewer` is a Live user row or null. */
async function viewer(req, res, next) {
    try {
        await optionalAuth(req, res, () => {});
        req.viewer = req.user || null;
    } catch { req.viewer = null; }
    next();
}

/** The caller's Network subject when Live knows it (for the sharing system). */
async function viewerSubject(user) {
    if (!user) return null;
    const row = await db.getDb().prepare("SELECT subject_id FROM linked_accounts WHERE service = 'network' AND user_id = ? LIMIT 1").get(user.id);
    return (row && SUBJECT_RE.test(String(row.subject_id || ''))) ? row.subject_id : null;
}

/** A person's own Live identity from a raw person token (the embed's server-side minting uses it). */
async function userFromToken(token) {
    const decoded = await verifyToken(String(token || ''));
    return decoded ? await resolveNetworkUser(decoded) : null;
}

module.exports = { publisher, viewer, viewerSubject, userForSubject, userFromToken, holdsCapability, AUDIENCE, CAPABILITY, CAPABILITIES };
