'use strict';
/**
 * The home's money counts from OpenVibe.Billing (GET /api/v1/stats, billing.stats.read, openvibe-contracts 0.203.0):
 * Vibes bought with money and channel subscriptions, network-wide and naming nobody. Live's own payment_orders and
 * subscriptions stopped at the cutover of 2026-10-17, so they are not counted.
 *
 *   counts()           { vibesBought, activeSubs, recent: { vibesBought, subs } } (windows d/w/m/pw) or null
 *   series(metric, n)  the home's series shape for 'vibesBought' or 'subs' over up to 90 days, or null
 *
 * One Billing read serves both, cached five minutes (a failure is cached for a minute and answers null: the board
 * shows the tiles empty rather than a guess).
 */
const api = require('./billing-client');

const TTL_MS = 5 * 60_000;
const MISS_MS = 60_000;
const SERIES_DAYS = 90;
let cache = { at: 0, ttl: 0, value: null };

async function read() {
    const now = Date.now();
    if (now - cache.at < cache.ttl) return cache.value;
    let value = null;
    try { value = await api.stats(SERIES_DAYS); } catch (e) { console.warn('[Home] Billing stats unavailable:', e.detail || e.message); }
    cache = { at: now, ttl: value ? TTL_MS : MISS_MS, value };
    return value;
}

async function counts() {
    const s = await read();
    if (!s) return null;
    return {
        vibesBought: s.purchases.bits_total, activeSubs: s.subscriptions.active,
        recent: { vibesBought: s.purchases.windows, subs: s.subscriptions.windows },
    };
}

const METRICS = { vibesBought: 'purchases', subs: 'subscriptions' };

async function series(metric, days) {
    const key = METRICS[metric];
    if (!key) return null;
    const s = await read();
    if (!s) return null;
    const n = Math.max(1, Math.min(SERIES_DAYS, days));
    const points = s[key].series.slice(-n).map((p) => ({ day: p.day, value: p.value }));
    const total = points.reduce((a, p) => a + p.value, 0);
    return {
        metric, kind: 'count', days: n, points, total, peak: Math.max(0, ...points.map((p) => p.value)),
        // A running total of Vibes bought starts at the all-time figure; subscriptions have no such base.
        before: key === 'purchases' ? Math.max(0, s.purchases.bits_total - total) : null, prev_total: null, source: 'billing',
    };
}

function _reset() { cache = { at: 0, ttl: 0, value: null }; }

module.exports = { counts, series, METRICS, _reset };
