'use strict';
/**
 * A tip OpenVibe.Tips settled reaches the channel's donation goal and tip history (server/tips/tips-events.js). Since
 * the Billing cutover Tips posts its chat lines to OpenVibe.Chat, so Live learns of a tip only from tips.interaction.ready.
 * Live reads Tips' own view of it (what may be shown) and: leaves Live's own donations alone (origin billing), records
 * the tip once (PowerChat for a tip on the creator's own PowerChat), advances the goal by a Vibes amount, keeps a hidden
 * amount hidden and an anonymous supporter anonymous, and does nothing twice for a redelivery.
 *
 *   node --import ./test/helpers/pg-preload.mjs test/tips-events.test.js
 */
const assert = require('assert');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = () => {};
console.warn = () => {};

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ulid = () => Array.from(crypto.randomBytes(26), (b) => CROCKFORD[b % 32]).join('');
const SID = { bob: 'usr_01JAB2C3D4E5F6G7H8J9K0MNB2', ann: 'usr_01JAB2C3D4E5F6G7H8J9K0MNA1' };

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    const raw = db.getDb();
    await raw.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role) OVERRIDING SYSTEM VALUE
        VALUES (2, 'ann', 'Ann', 'ann@x', 'x', 'user'), (3, 'bob', 'Bob', 'bob@x', 'x', 'streamer')`).run();
    await raw.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (2, 'network', '102', ?), (3, 'network', '103', ?)").run(SID.ann, SID.bob);
    await db.createDonationGoal(3, { title: 'New camera', target_amount: 1000 });
    const goalNow = async () => Number((await raw.prepare('SELECT current_amount FROM donation_goals WHERE user_id = 3').get()).current_amount);
    const events = [];
    const lines = [];
    const delivery = require('../server/chat/chat-delivery');
    delivery.event = async (target, ev) => { events.push(ev); };
    delivery.message = async (m) => { lines.push(m); return 1; };

    const { apply } = require('../server/tips/tips-events');
    const tips = new Map();
    const read = async (id) => tips.get(id) || null;
    const ready = (interaction_id, extra = {}) => ({
        event_id: `evt_${ulid()}`, event_type: 'tips.interaction.ready', source: 'tips', version: 1,
        payload: { interaction_id, creator: { type: 'user', id: SID.bob }, supporter: null, supporter_name: 'x', kind: 'tip', amount: 1, currency: 'vibes-bits', settlement: 'billing', payment_state: 'settled', delivery_state: 'queued', billing_txn_id: null, test: false, ...extra },
    });
    const view = (over = {}) => ({ origin: 'tips', settlement: 'billing', currency: 'vibes-bits', test: false, supporter: { type: 'user', id: SID.ann }, supporter_name: 'Ann', privacy: { anonymous: false }, public: { amount: 300, supporter_name: 'Ann', hidden: false }, ...over });
    const tip = (ref) => raw.prepare('SELECT to_user_id, from_user_id, username, amount, source FROM channel_tips WHERE ref = ?').get(ref);

    // A tip from openvibe.tips: into the tip history once, the goal moves, the widget hears it; no chat line from Live.
    const t1 = `tint_${ulid()}`;
    tips.set(t1, view());
    const e1 = ready(t1);
    assert.strictEqual(await apply(e1, { read }), 'applied');
    assert.deepStrictEqual(await tip(`tips:${t1}`), { to_user_id: 3, from_user_id: 2, username: null, amount: 300, source: 'tips' });
    assert.strictEqual(await goalNow(), 300);
    assert.ok(events.some((e) => e.type === 'goal-update' && e.goal.current_amount === 300));
    assert.strictEqual(lines.filter((l) => l.metadata && l.metadata.kind === 'donation').length, 0, 'the chat line is Tips\'');
    assert.strictEqual(await apply(e1, { read }), 'duplicate', 'a redelivery does nothing');
    assert.strictEqual(await goalNow(), 300);

    // A tip on Bob's own PowerChat (Billing → Tips): PowerChat in the history; it fills the goal.
    const t2 = `tint_${ulid()}`;
    tips.set(t2, view({ origin: 'billing-external', settlement: 'external', supporter: null, privacy: { anonymous: false }, public: { amount: 700, supporter_name: 'pcfan', hidden: false } }));
    assert.strictEqual(await apply(ready(t2), { read }), 'applied');
    assert.deepStrictEqual(await tip(`tips:${t2}`), { to_user_id: 3, from_user_id: null, username: 'pcfan', amount: 700, source: 'powerchat' });
    assert.strictEqual(await goalNow(), 1000);
    assert.ok(lines.some((l) => l.metadata && l.metadata.kind === 'goal-reached' && /Goal reached: New camera/.test(l.message)), 'the goal reached line');

    // Live's own on-site donation, as Tips records it (origin billing): Live counted it already.
    const t3 = `tint_${ulid()}`;
    tips.set(t3, view({ origin: 'billing' }));
    assert.strictEqual(await apply(ready(t3), { read }), 'ignored:not-ours');
    assert.strictEqual(await tip(`tips:${t3}`), undefined);

    // A hidden amount stays hidden (no amount, no goal move); an anonymous supporter has no account named.
    const t4 = `tint_${ulid()}`;
    tips.set(t4, view({ privacy: { anonymous: true }, supporter: null, public: { amount: null, supporter_name: 'Anonymous', hidden: false } }));
    assert.strictEqual(await apply(ready(t4), { read }), 'applied');
    assert.deepStrictEqual(await tip(`tips:${t4}`), { to_user_id: 3, from_user_id: null, username: 'Anonymous', amount: null, source: 'tips' });
    assert.strictEqual(await goalNow(), 1000);

    // Not Live's: a creator with no Live channel, another source, a test.
    assert.strictEqual(await apply(ready(`tint_${ulid()}`, { creator: { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNZZ' } }), { read }), 'ignored:no-channel');
    assert.strictEqual(await apply({ ...ready(t1), source: 'live' }, { read }), 'ignored:source');
    assert.strictEqual(await apply(ready(t1, { test: true }), { read }), 'ignored:test');
    quiet('tips events: all checks passed');
    process.exit(0);
})().catch((err) => { quiet(err); process.exit(1); });
