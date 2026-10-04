/**
 * Per-actor limits on Live's API writes (roadmap WS-R task 4; openvibe-sdk/limits).
 *
 * The per-address limits in server/index.js (900 reads / 180 writes a minute on /api, the auth and upload
 * limiters) stay. This counts WRITES by who makes them: a signed-in person (user:<subject>, or user:<id> before
 * their Network subject is known), and an hbt_ API token as the person who made it. Reads are not counted per
 * actor (the SPA reads a lot, and viewers share carrier addresses), and neither are signed-out writes: those keep
 * the per-address limit.
 *
 * Every write takes LIVE_LIMITS_MINUTE / LIVE_LIMITS_HOUR (120 and 3000) under the name `live.api.write`; the
 * table below gives expensive or sensitive writes their own, tighter numbers. Past a limit the request answers
 * 429 problem+json `rate_limited` with Retry-After before any route runs; the refusal is logged (the actor is a
 * subject or a user id, never a token) and counted in live_rate_limited_total{limit,window}. Counters live in this
 * process: a restart forgets them.
 *
 * Never counted: device and broadcast traffic that must keep flowing — robot controls, ONVIF, kiosks,
 * RobotStreamer publishing, recording chunks and finalize, live thumbnails, broadcaster heartbeats and diag logs —
 * and /api/auth (its own limiter). Everything outside /api (/internal, /whip, /metrics, …) is never seen here.
 */
'use strict';

const { createActorLimiter } = require('openvibe-sdk/limits');

const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };

/** Writes never counted per actor (paths relative to /api). */
const EXEMPT = [
    /^\/auth\//, /^\/controls(\/|$)/, /^\/onvif(\/|$)/, /^\/kiosk(\/|$)/, /^\/robotstreamer(\/|$)/,
    /^\/vods\/stream\/[^/]+\/(chunk|finalize)$/, /^\/thumbnails\/live(\/|$)/,
    /^\/streams\/[^/]+\/heartbeat$/, /^\/streams\/diag-log$/,
];

/**
 * Writes with their own numbers: [name, method regex, path regex, { minute, hour }]. The first match wins.
 * Each number is well above what a person does by hand and stops a script.
 */
const ROUTES = [
    // Creating a clip cuts video on Media.
    ['live.clip.create', /^POST$/, /^\/(vods\/clips|clips)(\/[^/]+\/trim)?$/, { minute: 10, hour: 100 }],
    // A paste stores content on Community (anonymous pastes keep their own address limit in pastes.js).
    ['live.paste.create', /^POST$/, /^\/pastes\/?$/, { minute: 30, hour: 600 }],
    // Binding a channel to a Bot robot (server/bot/routes.js): set once, rarely changed.
    ['live.bot.bind', /^PUT$/, /^\/streams\/channel\/[^/]+\/bot$/, { minute: 10, hour: 60 }],
    ['live.follow', /^(POST|DELETE)$/, /^\/streams\/(channel\/[^/]+|[^/]+)\/follow$/, { minute: 60, hour: 600 }],
    // A new stream key invalidates the old one; nobody needs it more than a few times.
    ['live.stream.key', /^POST$/, /^\/streams\/managed\/[^/]+\/regenerate-key$/, { minute: 5, hour: 20 }],
    // Image uploads (panel, goal media, offline screen, avatar, emotes, themes) are stored and re-encoded.
    ['live.upload', /^(POST|PUT)$/, /^\/(streams\/(panel-image|goal-media|channel\/offline-screen)|emotes(\/.*)?|themes\/.*upload.*)$/, { minute: 10, hour: 100 }],
    ['live.comment', /^POST$/, /^\/comments(\/|$)/, { minute: 20, hour: 300 }],
    // Money: checkouts, subscriptions, donations, cash-outs. Channel-point heartbeats and redemptions keep the general
    // write budget (a heartbeat every half minute per tab); provider webhooks carry no person and are never counted.
    ['live.money', /^POST$/, /^\/(payments\/(bucks\/checkout|subscribe|subscriptions\/[^/]+\/cancel)|funds\/(purchase|donate|cashout|recycle))$/, { minute: 10, hour: 60 }],
    // Testing an AI provider key calls that provider.
    ['live.ai.test', /^POST$/, /^\/ai-viewers\/byo\/test$/, { minute: 5, hour: 30 }],
];

function createLiveActorLimits({ env = process.env, registry = null, now } = {}) {
    let refused = null;
    if (registry && typeof registry.counter === 'function') {
        refused = registry.counter({ name: 'live_rate_limited_total', help: 'API writes refused 429 by a per-actor limit, by limit name and window', labelNames: ['limit', 'window'] });
    }
    const auth = require('../auth/auth');
    /** The person behind the request's token, without failing it (requireAuth still decides later). */
    function actor(req) {
        const token = auth.extractToken(req);
        if (!token) return null;
        try {
            if (String(token).startsWith('hbt_')) {
                const u = auth.authenticateApiToken(token);
                return u ? `user:${u.subject_id || u.id}` : null;
            }
            const d = auth.verifyToken(token);
            if (!d) return null;
            const subject = d.subject_id || d.sub_subject || (typeof d.sub === 'string' && d.sub.startsWith('usr_') ? d.sub : null);
            return subject ? `user:${subject}` : (d.sub != null ? `user:${d.sub}` : null);
        } catch { return null; }
    }
    const limits = createActorLimiter({
        limits: { minute: num(env.LIVE_LIMITS_MINUTE, 120), hour: num(env.LIVE_LIMITS_HOUR, 3000) },
        actor,
        ...(now ? { now } : {}),
        onLimited(e) {
            console.warn(`[Limits] ${e.name}: ${e.actor} refused, over ${e.limit} per ${e.window}`);
            if (refused) refused.inc({ limit: e.name, window: e.window });
        },
    });
    const write = limits('live.api.write');
    const named = ROUTES.map(([name, method, pathRe, own]) => ({ name, method, pathRe, mw: limits(name, own) }));
    const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    function middleware(req, res, next) {
        if (!WRITE.has(req.method)) return next();
        const p = req.path;   // relative to the /api mount
        if (EXEMPT.some((re) => re.test(p))) return next();
        const own = named.find((r) => r.method.test(req.method) && r.pathRe.test(p));
        // A named route counts against its own numbers AND the general write budget.
        return write(req, res, (err) => (err ? next(err) : own ? own.mw(req, res, next) : next()));
    }
    middleware.limits = limits;
    return middleware;
}

module.exports = { createLiveActorLimits, EXEMPT, ROUTES };
