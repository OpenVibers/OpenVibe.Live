'use strict';
/**
 * A channel's support on OpenVibe.VIP and OpenVibe.Tips for Live's donate and subscribe modals (server/monetization/
 * elsewhere.js): VIP's joinable plans with their tier and Billing's price, Tips' other ways to support (links Tips
 * built) and the tip page while it takes tips. Only https links pass; whatever does not answer is left out; a minute's
 * cache per channel; a name that is not a handle asks nobody.
 *
 *   node test/channel-elsewhere.test.js
 */
const assert = require('assert');
const elsewhere = require('../server/monetization/elsewhere');

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const card = {
    creator: { username: 'tierra', url: 'https://openvibe.vip/tierra' }, join_url: 'https://openvibe.vip/tierra',
    plans: [
        { name: 'Supporter', tier: 1, price_cents: 300, purchasable: true, join_url: 'https://openvibe.vip/tierra#plan-supporter' },
        { name: 'Superfan', tier: 2, price_cents: 1500, purchasable: true, join_url: 'https://openvibe.vip/tierra#plan-superfan' },
        { name: 'Patron', tier: 3, price_cents: null, purchasable: false, join_url: 'https://openvibe.vip/tierra#plan-patron' },
        { name: 'Sneaky', tier: 4, price_cents: 100, purchasable: true, join_url: 'javascript:alert(1)' },
    ],
};
const profile = {
    url: 'https://openvibe.tips/tierra', page_enabled: true, accepting: true,
    support_links: [
        { provider: 'kofi', label: 'Ko-fi', handle: 'tierra', url: 'https://ko-fi.com/tierra' },
        { provider: 'paypal', label: 'PayPal.me', handle: 'x', url: 'http://paypal.me/x' },
    ],
};

(async () => {
    const calls = [];
    const fetchImpl = async (url) => {
        calls.push(url);
        if (url.endsWith('/embed/tierra/card.json')) return json(200, card);
        if (url.endsWith('/api/v1/profiles/tierra')) return json(200, { profile });
        if (url.includes('/embed/quiet/')) throw new Error('timeout');
        return json(404, { code: 'not_found' });
    };

    const out = await elsewhere.forChannel('Tierra', { fetchImpl, now: 1000 });
    assert.deepStrictEqual(out.memberships, {
        url: 'https://openvibe.vip/tierra',
        plans: [
            { name: 'Supporter', tier: 1, price_cents: 300, join_url: 'https://openvibe.vip/tierra#plan-supporter' },
            { name: 'Superfan', tier: 2, price_cents: 1500, join_url: 'https://openvibe.vip/tierra#plan-superfan' },
        ],
    }, 'joinable plans only, and only https links');
    assert.deepStrictEqual(out.support_links, [{ provider: 'kofi', label: 'Ko-fi', url: 'https://ko-fi.com/tierra' }], 'an http link is dropped');
    assert.strictEqual(out.tips_url, 'https://openvibe.tips/tierra');
    assert.ok(calls.every((u) => u.startsWith('http://127.0.0.1:')), 'loopback reads');

    const n = calls.length;
    await elsewhere.forChannel('tierra', { fetchImpl, now: 30_000 });
    assert.strictEqual(calls.length, n, 'cached for a minute');
    await elsewhere.forChannel('tierra', { fetchImpl, now: 62_000 });
    assert.strictEqual(calls.length, n + 2, 'read again after the minute');

    const quiet = await elsewhere.forChannel('quiet', { fetchImpl, now: 1000 });
    assert.deepStrictEqual(quiet, { memberships: null, support_links: null, tips_url: null }, 'nothing answers: nothing shown');

    profile.accepting = false;
    elsewhere._reset();
    assert.strictEqual((await elsewhere.forChannel('tierra', { fetchImpl, now: 1000 })).tips_url, null, 'no tip page link while it takes no tips');

    const before = calls.length;
    assert.deepStrictEqual(await elsewhere.forChannel('../admin', { fetchImpl }), { memberships: null, support_links: null, tips_url: null });
    assert.strictEqual(calls.length, before, 'a name that is not a handle asks nobody');
    console.log('channel elsewhere: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
