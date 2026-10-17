'use strict';
/**
 * The home's money counts from OpenVibe.Billing (server/monetization/billing-stats.js): Vibes bought and channel
 * subscriptions with their windows, the two series in the home's series shape, one cached Billing read for both, and
 * nothing (not a guess) while Billing does not answer.
 *
 *   node test/billing-stats.test.js
 */
const assert = require('assert');

(async () => {
    const api = require('../server/monetization/billing-client');
    let calls = 0;
    let fail = false;
    const days = Array.from({ length: 90 }, (_, i) => ({ day: new Date(Date.now() - (89 - i) * 86400000).toISOString().slice(0, 10), value: i === 89 ? 500 : (i === 88 ? 250 : 0) }));
    api.stats = async () => {
        calls++;
        if (fail) throw new Error('Billing down');
        return {
            as_of: new Date().toISOString(),
            purchases: { bits_total: 25000, windows: { d: 500, w: 750, m: 750, pw: 0 }, series: days },
            subscriptions: { active: 3, windows: { d: 1, w: 2, m: 2, pw: 1 }, series: days.map((p) => ({ day: p.day, value: p.value ? 1 : 0 })) },
        };
    };
    const stats = require('../server/monetization/billing-stats');

    const c = await stats.counts();
    assert.deepStrictEqual(c, { vibesBought: 25000, activeSubs: 3, recent: { vibesBought: { d: 500, w: 750, m: 750, pw: 0 }, subs: { d: 1, w: 2, m: 2, pw: 1 } } });
    const s = await stats.series('vibesBought', 7);
    assert.strictEqual(s.points.length, 7);
    assert.deepStrictEqual([s.metric, s.kind, s.total, s.peak, s.before, s.source], ['vibesBought', 'count', 750, 500, 24250, 'billing']);
    const subs = await stats.series('subs', 365);
    assert.strictEqual(subs.days, 90, 'Billing keeps 90 days of series');
    assert.strictEqual(subs.before, null);
    assert.strictEqual(await stats.series('vibes', 7), null, 'not a Billing metric');
    assert.strictEqual(calls, 1, 'one cached Billing read serves the counts and both series');

    stats._reset();
    fail = true;
    assert.strictEqual(await stats.counts(), null, 'Billing down: nothing, not a guess');
    assert.strictEqual(await stats.series('subs', 30), null);
    console.log('billing stats: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
