'use strict';
// A PowerChat checkout reference (pcorder/pcsub/pcdon) rides in the tip link, so the buyer can edit it.
// It must only count when the money landed where that checkout sends it: the SITE tips account for
// purchases, site-routed donations and site-routed subscriptions; the subscribed streamer's own
// account for a direct subscription. A streamer tipping their own PowerChat with `pcdon:<self>`, or a
// viewer tipping their own account with `pcsub:<x>`, must fall through to ordinary tip handling.
const assert = require('assert');
const path = require('path');
function stub(modPath, exportsObj) { const full = require.resolve(modPath); require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj }; }

const orders = new Map();
const credited = { cashout: [], bucks: [], subs: [] };
const seed = () => {
    orders.clear();
    orders.set(41, { id: 41, kind: 'bucks', amount_cents: 500, bucks: 500, user_id: 7, status: 'pending' });
    orders.set(42, { id: 42, kind: 'subscription', amount_cents: 500, user_id: 8, streamer_id: 3, provider_ref: 'direct', status: 'pending' });
    orders.set(43, { id: 43, kind: 'subscription', amount_cents: 500, user_id: 9, streamer_id: 3, provider_ref: 'site', status: 'pending' });
    credited.cashout.length = 0; credited.bucks.length = 0; credited.subs.length = 0;
};
stub(path.join(__dirname, '../server/db/database'), {
    getSetting: (k) => (k === 'powerchat_site_tip_username' ? 'siteacct' : null),
    getPaymentOrderById: (id) => orders.get(id) || null,
    updatePaymentOrder: (id, f) => Object.assign(orders.get(id), f),
    getUserById: (id) => ({ id, username: 'u' + id }),
    addVibesCashout: (uid, cents) => credited.cashout.push([uid, cents]),
    createTransaction: () => {},
    getPowerchatConnectionByUsername: () => null,
    getPowerchatConnection: () => null,
});
stub(path.join(__dirname, '../server/monetization/payments'), {
    bucksForUsd: (usd) => Math.round(usd * 100),
    fulfillBucksOrder: (o) => { credited.bucks.push(o.id); orders.get(o.id).status = 'credited'; },
    fulfillSubscriptionOrder: (o) => { credited.subs.push(o.id); orders.get(o.id).status = 'credited'; },
});
stub(path.join(__dirname, '../server/integrations/powerchat-webhook'), { creditDonationPipeline: () => {} });
stub(path.join(__dirname, '../server/utils/notify'), { pushNotification: () => {} });
const checkout = require('../server/integrations/powerchat-checkout');
const log = console.warn; console.warn = () => {};
const tip = (ref, cents = 500) => ({ appExternalRef: ref, amountUsdCents: cents });

seed();
// Exploit: streamer 3 tips their OWN PowerChat with a site-routed donation ref naming themselves.
assert.strictEqual(checkout.handleAttributedDonation(3, tip('pcdon:3:0'), { viaSiteAccount: false }), false, 'pcdon on a streamer account is an ordinary tip');
assert.deepStrictEqual(credited.cashout, [], 'no cashout Vibes minted');
// Exploit: a purchase ref on a streamer account credits no Vibes.
assert.strictEqual(checkout.handleAttributedDonation(3, tip('pcorder:41'), { viaSiteAccount: false }), false);
assert.deepStrictEqual(credited.bucks, []); assert.strictEqual(orders.get(41).status, 'pending');
// Exploit: viewer 9 tips their own account (user 9) with a direct sub ref for streamer 3.
assert.strictEqual(checkout.handleAttributedDonation(9, tip('pcsub:42'), { viaSiteAccount: false }), false, 'direct sub must be paid to the subscribed streamer');
// A site-routed sub ref paid to a streamer account is not a subscription either.
assert.strictEqual(checkout.handleAttributedDonation(3, tip('pcsub:43'), { viaSiteAccount: false }), false);
assert.deepStrictEqual(credited.subs, []);

// Legitimate paths still work.
assert.strictEqual(checkout.handleAttributedDonation(null, tip('pcorder:41')), true, 'purchase on the site account');
assert.deepStrictEqual(credited.bucks, [41]);
assert.strictEqual(checkout.handleAttributedDonation(3, tip('pcsub:42'), { viaSiteAccount: false }), true, 'direct sub paid to streamer 3');
assert.strictEqual(checkout.handleAttributedDonation(1, tip('pcsub:43'), { viaSiteAccount: true }), true, 'site sub on the site account (even when the site account is a connected user)');
assert.deepStrictEqual(credited.subs, [42, 43]);
assert.strictEqual(checkout.handleAttributedDonation(null, tip('pcdon:3:7')), true, 'site-routed donation on the site account');
assert.deepStrictEqual(credited.cashout, [[3, 500]]);
console.warn = log;
console.log('✅ PowerChat checkout refs count only on the account the checkout routes to');
