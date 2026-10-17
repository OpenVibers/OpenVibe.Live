'use strict';
/**
 * Billing's settlements told to people once Billing is the ledger (server/monetization/billing-events.js, items 2 and
 * 5 of OpenVibe.Billing's cutover list): "Vibes credited", "Subscribed!" with the PowerChat sub alert, the channel's
 * celebration for a site-routed PowerChat tip, and the subscription notices Live's renewal sweeper used to send. In
 * `live` mode Live sends those itself, so the events are acknowledged and left alone; a redelivery sends nothing twice.
 *
 *   node --import ./test/helpers/pg-preload.mjs test/billing-events.test.js
 */
const assert = require('assert');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.LIVE_EVENTS_SECRET = crypto.randomBytes(32).toString('hex');
const quiet = console.log;
console.log = () => {};
console.warn = () => {};

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ulid = () => Array.from(crypto.randomBytes(26), (b) => CROCKFORD[b % 32]).join('');
const SID = { ann: 'usr_01JAB2C3D4E5F6G7H8J9K0MNA1', bob: 'usr_01JAB2C3D4E5F6G7H8J9K0MNB2' };

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    const raw = db.getDb();
    await raw.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role) OVERRIDING SYSTEM VALUE
        VALUES (2, 'ann', 'Ann', 'ann@x', 'x', 'user'), (3, 'bob', 'Bob', 'bob@x', 'x', 'streamer')`).run();
    await raw.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (2, 'network', '102', ?), (3, 'network', '103', ?)").run(SID.ann, SID.bob);

    const sent = [];
    require('../server/utils/notify').pushNotification = (n) => { sent.push(n); };
    const subAlerts = [];
    require('../server/integrations/powerchat-platform').forwardSubscription = async (streamerId, o) => { subAlerts.push([streamerId, o]); };
    const lines = [];
    const delivery = require('../server/chat/chat-delivery');
    delivery.message = async (m) => { lines.push(m); return 1; };
    delivery.event = async () => {};

    const express = require('express');
    const app = express();
    app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
    const events = require('../server/monetization/billing-events');
    app.post('/internal/billing-events', events.handler);
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const { signDeliveryHeaders } = require('openvibe-sdk/events');
    const post = async (envelope, secret = process.env.LIVE_EVENTS_SECRET) => {
        const body = JSON.stringify({ event: envelope });
        const res = await fetch(`http://127.0.0.1:${server.address().port}/internal/billing-events`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(body, secret) }, body });
        return res.status;
    };
    const envelope = (type, payload, extra = {}) => ({
        event_id: `evt_${ulid()}`, event_type: type, version: 1, source: 'billing', actor: { type: 'service', id: 'billing' },
        timestamp: new Date().toISOString(), priority: 'important', visibility: 'internal', subject: { type: 'transaction', id: 'txn_x' }, payload, ...extra,
    });
    const settled = (type, extra = {}) => envelope('billing.transaction.settled', {
        transaction_id: `txn_${ulid()}`, type, test: false, from_subject: null, to_subject: SID.ann, provider: 'powerchat', metadata: {}, ...extra,
    });
    const entitlement = (reason, extra = {}) => envelope('billing.entitlement.changed', {
        subject: { type: 'user', id: SID.ann }, streamer: { type: 'user', id: SID.bob }, kind: 'channel_subscription', active: false, expires_at: null,
        subscription: { id: `sub_${ulid()}`, status: 'expired', auto_renew: 1, cancel_at_period_end: 0, provider: null }, reason, ...extra,
    });

    const purchase = settled('purchase', { metadata: { bits: 500, paid_cents: 500 } });
    assert.strictEqual(await post(purchase, 'x'.repeat(64)), 401, 'a delivery signed with another secret is refused');
    assert.deepStrictEqual(sent, []);
    assert.strictEqual(await post(purchase), 204);
    assert.deepStrictEqual(sent.map((n) => [n.user_id, n.title, n.message]), [[2, 'Vibes credited 🎉', '500 Vibes were added to your balance ($5.00).']]);
    assert.strictEqual(await post(purchase), 204);
    assert.strictEqual(sent.length, 1, 'a redelivery sends nothing again');
    assert.strictEqual(await post(settled('purchase', { test: true, metadata: { bits: 100 } })), 204);
    assert.strictEqual(sent.length, 1, 'a test purchase notifies nobody');
    assert.strictEqual(await events.apply({ ...settled('purchase', { metadata: { bits: 100 } }), source: 'live' }), 'ignored:source');

    // A subscription PowerChat paid: "Subscribed!" and the sub alert on Bob's PowerChat overlay; a renewal only the alert.
    sent.length = 0;
    const sub = settled('subscription', { from_subject: SID.ann, to_subject: SID.bob, metadata: { renewal: false, period_end: '2026-11-16T12:00:00Z' } });
    await post(sub);
    assert.deepStrictEqual(sent.map((n) => [n.user_id, n.title, n.message, n.url]), [[2, 'Subscribed! ⭐', 'Your subscription to Bob is active until 2026-11-16.', '/@bob']]);
    assert.deepStrictEqual(subAlerts, [[3, { subscriberName: 'Ann', externalId: `billing:${sub.payload.transaction_id}`, isResub: false }]]);
    await post(settled('subscription', { from_subject: SID.ann, to_subject: SID.bob, metadata: { renewal: true } }));
    assert.strictEqual(sent.length, 1, 'a renewal is not announced to the subscriber');
    assert.strictEqual(subAlerts.length, 2);
    assert.strictEqual(subAlerts[1][1].isResub, true);
    await post(settled('subscription', { from_subject: SID.ann, to_subject: SID.bob, provider: null, metadata: { renewal: false } }));
    assert.strictEqual(sent.length, 1, 'a Vibes-paid subscription was bought on the page, which said so');
    assert.strictEqual(subAlerts.length, 2, 'and Live\'s subscribe route fired its alert');

    // A PowerChat tip paid to the site account for Bob: Bob's channel celebrates it and keeps it in its tip history.
    const tip = settled('donation', { from_subject: SID.ann, to_subject: SID.bob, metadata: { kind: 'tip', route: 'site', amount_bits: 300, donor_name: 'Ann' } });
    await post(tip);
    await post(tip);
    assert.strictEqual(lines.filter((l) => l.message_type === 'donation').length, 1, 'one chat line, however often it is delivered');
    assert.match(lines[0].message, /^Ann tipped 300 Vibes/);
    assert.deepStrictEqual(await raw.prepare('SELECT to_user_id, from_user_id, amount, source FROM channel_tips WHERE ref = ?').get(`powerchat:billing:${tip.payload.transaction_id}`),
        { to_user_id: 3, from_user_id: 2, amount: 300, source: 'powerchat' });
    await post(settled('donation', { from_subject: SID.ann, to_subject: SID.bob, provider: null, metadata: { amount_bits: 50 } }));
    assert.strictEqual(lines.length, 1, 'an on-site Vibes donation was celebrated by the donate route already');

    // Subscription notices, in the words Live's sweeper used.
    sent.length = 0;
    await post(entitlement('renewal_insufficient_credit'));
    await post(entitlement('expired', { subscription: { id: `sub_${ulid()}`, status: 'expired', auto_renew: 0, cancel_at_period_end: 1, provider: null } }));
    await post(entitlement('expired'));
    await post(entitlement('renewal_failed', { grace_until: '2026-10-20T00:00:00Z' }));
    await post(entitlement('granted', { active: true }));
    assert.deepStrictEqual(sent.map((n) => [n.user_id, n.title, n.message, n.url]), [
        [2, 'Subscription update', 'Bob: Your subscription could not auto-renew: not enough Vibes. Top up and resubscribe!', '/@bob'],
        [2, 'Subscription update', 'Bob: Your channel subscription has ended. Resubscribe any time!', '/@bob'],
        [2, 'Subscription update', 'Bob: A renewal payment failed; it is tried again until 2026-10-20. Your subscription is paused until it goes through.', '/@bob'],
    ], 'someone who cancelled is not told it ended, and a granted period needs no notice');

    server.close();
    quiet('billing events: all checks passed');
    process.exit(0);
})().catch((err) => { quiet(err); process.exit(1); });
