'use strict';
/**
 * Live as a receiver of service tokens (roadmap Wave 6).
 *
 * guard(capability) checks a Network client-credentials token (RS256, contract
 * identity.service-token-claims@1) for audience openvibe.live on Live's own internal routes —
 * today the ones OpenVibe.Chat calls (/internal/chat-context/*, /internal/chat-effects/*). The
 * token is verified with the same Network key Live verifies user JWTs with.
 *
 * The capability ids are registered in openvibe-contracts (checked with capabilities.check()); an
 * id the pinned registry does not know yet is checked as a plain grant with capabilities.grants()
 * until the pin moves. Like X-Internal-Key routes, these are loopback-only: anything that came
 * through nginx is refused.
 */
const { serviceAuth, capabilities, http } = require('openvibe-contracts');
const { getNetworkPublicKey, getNetworkIssuer } = require('../auth/auth');

const AUDIENCE = 'openvibe.live';

function viaProxy(req) {
    return !!(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['cf-connecting-ip']);
}

function guard(capability) {
    const registered = !!capabilities.get(capability);
    return function liveServiceGuard(req, res, next) {
        const ctx = http.requestContext(req.headers);
        if (viaProxy(req)) return http.sendProblem(res, 403, 'capability.denied', { detail: 'internal routes are loopback-only', ctx });
        const auth = String(req.headers.authorization || '');
        if (!auth.startsWith('Bearer ')) return http.sendProblem(res, 401, 'token.missing', { detail: 'no service token', ctx });
        const publicKey = getNetworkPublicKey();
        if (!publicKey) return http.sendProblem(res, 503, 'identity.unavailable', { detail: 'the Network signing key is not loaded', ctx });
        const r = serviceAuth.verifyServiceToken(auth.slice(7).trim(), { publicKey, issuer: getNetworkIssuer(), audience: AUDIENCE });
        if (!r.ok) return http.sendProblem(res, 401, r.code, { detail: r.reason, ctx });
        const c = registered
            ? capabilities.check(r.claims, capability)
            : (capabilities.grants(r.claims.cap, capability) ? { allowed: true } : { allowed: false, code: 'capability.denied', reason: `${capability} not granted` });
        if (!c.allowed) return http.sendProblem(res, 403, c.code || 'capability.denied', { detail: c.reason, ctx });
        req.principal = { sub: r.claims.sub, cap: r.claims.cap, jti: r.claims.jti };
        next();
    };
}

module.exports = { guard, AUDIENCE };
