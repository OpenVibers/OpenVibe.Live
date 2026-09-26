'use strict';
/**
 * Creator analytics read from OpenVibe.Network (roadmap WS-E task 6). Network builds them from Live's
 * live.stream.ended events (Contracts 0.68.0 `stats`: counts only) at GET /api/v1/creators/:subject/analytics;
 * Live reads them with its service token (network.analytics.creator.read, the full figures) when
 * ANALYTICS_SOURCE=network, and merges what only Live knows per stream (coins earned, new followers, clips).
 *
 *   summaryFor(userId, days) → the shape of db.getChannelAnalyticsSummary (plus source: 'network'), or null when
 *   Network is not the source, the channel has no Network subject, or Network did not answer (the caller then
 *   uses Live's own tables). all_time stays Live's (every stream it ever ran).
 */
const db = require('../db/database');

const NETWORK_INTERNAL_URL = (process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const stats = { network: 0, fallback: 0 };

const enabled = () => process.env.ANALYTICS_SOURCE === 'network';

async function summaryFor(userId, days, { fetchImpl = globalThis.fetch } = {}) {
    if (!enabled()) return null;
    const r0 = db.getDb().prepare("SELECT subject_id FROM linked_accounts WHERE service = 'network' AND user_id = ?").get(userId);
    const subject = r0 && SUBJECT_RE.test(String(r0.subject_id || '')) ? r0.subject_id : null;
    if (!subject) { stats.fallback++; return null; }
    let body;
    try {
        const principal = require('../net/network-principal');
        const res = await fetchImpl(`${NETWORK_INTERNAL_URL}/api/v1/creators/${subject}/analytics?days=${Math.min(Math.max(parseInt(days, 10) || 30, 1), 365)}`, {
            headers: { Accept: 'application/json', ...(await principal.serviceHeaders('openvibe.network')) }, signal: AbortSignal.timeout(4000),
        });
        if (res.status !== 200) { stats.fallback++; return null; }
        body = await res.json();
    } catch { stats.fallback++; return null; }
    if (!body || !body.full || !Array.isArray(body.streams)) { stats.fallback++; return null; }
    const local = new Map();
    const q = db.getDb().prepare('SELECT stream_id, new_followers, clips_created, coins_earned FROM stream_analytics WHERE stream_id = ?');
    for (const s of body.streams) { const row = q.get(s.stream_id); if (row) local.set(s.stream_id, row); }
    const streams = body.streams.map((s) => {
        const l = local.get(s.stream_id) || {};
        return {
            id: s.stream_id, title: s.title, category: s.category, started_at: s.started_at, ended_at: s.ended_at, duration_seconds: s.duration_seconds,
            peak_viewers: s.peak_viewers ?? null, viewer_count: null, avg_viewers: s.avg_viewers ?? null, unique_chatters: s.unique_chatters ?? null,
            total_messages: s.messages ?? null, total_watch_minutes: s.watch_minutes ?? null,
            new_followers: l.new_followers ?? null, clips_created: l.clips_created ?? null, coins_earned: l.coins_earned ?? null,
        };
    });
    const sum = (k) => streams.reduce((n, s) => n + (Number(s[k]) || 0), 0);
    const t = body.totals || {};
    const base = db.getChannelAnalyticsSummary(userId, days);   // all_time and follower count stay Live's
    stats.network++;
    return {
        ...base,
        source: 'network',
        streams,
        summary: {
            total_streams: t.streams || 0,
            total_duration_seconds: t.stream_seconds || 0,
            peak_viewers: t.peak_viewers || 0,
            avg_viewers_per_stream: t.avg_viewers || 0,
            total_messages: t.messages || 0,
            total_unique_chatters: t.unique_chatters || 0,
            total_watch_minutes: t.watch_minutes || 0,
            total_new_followers: sum('new_followers'),
            total_clips: sum('clips_created'),
        },
    };
}

module.exports = { summaryFor, enabled, stats };
