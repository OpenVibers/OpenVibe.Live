'use strict';
/**
 * A channel's schedule from OpenVibe.Today (plan 2026-10-28 §4.2: streamers schedule in Today; Live shows it on the
 * channel). Live keeps no copy: it reads Today's public API and keeps each answer a minute.
 *
 *   GET /api/today/channel/:username   → { events: [{ id, title, starts_at, ends_at, tz, status, kind, url }] }
 *                                        the next three public events, soonest first; [] when Today is unreachable
 *
 * OV_TODAY_INTERNAL_URL (default http://127.0.0.1:5100) is where Live asks; links point at the public
 * https://openvibe.today. Nothing runs at boot: every read happens on a request (drill-safe).
 */
const express = require('express');

const TODAY_PUBLIC = 'https://openvibe.today';
const CACHE_MS = 60_000;
const FAIL_CACHE_MS = 15_000;
const CACHE_MAX = 500;
const USERNAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const EVENT_ID = /^tev_[0-9A-Za-z]{10,40}$/;

/** Only what a channel page shows; never Today's owner or internal fields. */
function publicEvent(e) {
    if (!e || !EVENT_ID.test(String(e.id || ''))) return null;
    const starts = Date.parse(e.starts_at || '');
    if (!Number.isFinite(starts)) return null;
    return {
        id: e.id,
        title: String(e.title || '').slice(0, 120),
        starts_at: new Date(starts).toISOString(),
        ends_at: e.ends_at && Number.isFinite(Date.parse(e.ends_at)) ? new Date(e.ends_at).toISOString() : null,
        tz: String(e.tz || 'UTC').slice(0, 64),
        status: ['scheduled', 'live', 'done', 'cancelled'].includes(e.status) ? e.status : 'scheduled',
        kind: e.kind === 'event' ? 'event' : 'stream',
        url: `${TODAY_PUBLIC}/e/${encodeURIComponent(e.id)}`,
    };
}

function createTodaySchedule({ todayUrl = process.env.OV_TODAY_INTERNAL_URL || 'http://127.0.0.1:5100', fetchImpl = (...a) => fetch(...a), now = () => Date.now(), timeoutMs = 2000 } = {}) {
    const cache = new Map();
    async function forChannel(username) {
        const key = String(username).toLowerCase();
        const hit = cache.get(key);
        if (hit && now() < hit.until) return hit.events;
        let events = [];
        let ok = false;
        try {
            const from = new Date(now() - 2 * 3600e3).toISOString();
            const res = await fetchImpl(`${String(todayUrl).replace(/\/+$/, '')}/api/v1/events?channel=${encodeURIComponent(username)}&from=${encodeURIComponent(from)}&limit=6`, {
                headers: { accept: 'application/json', 'user-agent': 'OpenVibe.Live (+https://openvibe.live)' }, signal: AbortSignal.timeout(timeoutMs),
            });
            if (res.ok) {
                const body = await res.json();
                events = (Array.isArray(body && body.events) ? body.events : []).map(publicEvent).filter((e) => e && e.status !== 'cancelled' && e.status !== 'done').slice(0, 3);
                ok = true;
            }
        } catch { /* Today unreachable: an empty schedule, asked again soon */ }
        cache.set(key, { events, until: now() + (ok ? CACHE_MS : FAIL_CACHE_MS) });
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
        return events;
    }
    return { forChannel, _cache: cache };
}

function createTodayRoutes(schedule = createTodaySchedule()) {
    const router = express.Router();
    router.get('/channel/:username', async (req, res) => {
        const username = String(req.params.username || '');
        if (!USERNAME.test(username)) return res.status(404).json({ error: 'Channel not found' });
        const events = await schedule.forChannel(username);
        res.set('Cache-Control', 'public, max-age=60');
        res.json({ events });
    });
    return router;
}

module.exports = { createTodayRoutes, createTodaySchedule, publicEvent };
