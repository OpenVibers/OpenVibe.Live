'use strict';

/**
 * The /api/ rate limit's options (server/index.js). The SPA makes a lot of legitimate read-only API requests (channel
 * data, media strip, weather, VOD pagination, polling), so GET/HEAD get a much higher ceiling than writes.
 *
 * Our own services on this host are not one visitor: openvibe.video's pages call Live at 127.0.0.1:3000 with no proxy
 * headers (nginx sets X-Forwarded-For on every public request), and they shared one 900-a-minute bucket keyed
 * 127.0.0.1, so Video's pages answered 502 whenever it ran out (11-28: 80 refusals in an hour while Meme re-checked
 * videos). A direct loopback request (openvibe-shared/metrics isLoopbackDirect, the same test /metrics uses) is skipped.
 */
const { isLoopbackDirect } = require('openvibe-shared/metrics');

function apiLimiterOptions() {
    return {
        windowMs: 60 * 1000,
        skip: (req) => isLoopbackDirect(req),
        max: (req) => (req.method === 'GET' || req.method === 'HEAD' ? 900 : 180),
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many requests, slow down partner' },
    };
}

module.exports = { apiLimiterOptions };
