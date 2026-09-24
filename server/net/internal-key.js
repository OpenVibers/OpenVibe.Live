'use strict';
/**
 * The trust rule for Live's internal (server-to-server) routes, in one place.
 *
 *   viaProxy(req)        the request came through nginx or Cloudflare: nginx adds X-Forwarded-For /
 *                        X-Real-IP to everything from outside (Cloudflare adds CF-Connecting-IP), and
 *                        loopback callers never send them. Internal routes refuse such a request.
 *   internalKeyMatches(k) timing-safe comparison with INTERNAL_API_KEY (both sides hashed first, so
 *                        neither the content nor the length leaks through timing).
 *   internalKeyOk(req)   both: loopback and the right X-Internal-Key. Every X-Internal-Key route uses
 *                        this (server/internal/routes.js, /internal/analytics-summary,
 *                        POST /api/cosmetics/internal-unlock); service-token routes use
 *                        server/net/service-guard.js, which applies the same viaProxy rule.
 */
const crypto = require('crypto');

function viaProxy(req) {
    const h = (req && req.headers) || {};
    return !!(h['x-forwarded-for'] || h['x-real-ip'] || h['cf-connecting-ip']);
}

const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();

function internalKeyMatches(given) {
    const key = String(require('../config').internalApiKey || '');
    const presented = String(given || '');
    if (!key || !presented) return false;
    return crypto.timingSafeEqual(digest(presented), digest(key));
}

function internalKeyOk(req) {
    return !viaProxy(req) && internalKeyMatches(req && req.headers && req.headers['x-internal-key']);
}

module.exports = { viaProxy, internalKeyMatches, internalKeyOk };
