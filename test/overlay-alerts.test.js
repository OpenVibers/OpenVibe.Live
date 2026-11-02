'use strict';
/**
 * The overlay alert feed (server/overlay/): the typed moments a streamer's OBS overlay shows —
 * "X followed", "X tipped 5 Vibes: message", "X subscribed", "X raided with 12 viewers",
 * "Goal reached" — and the streamer's own test alert (POST /api/overlay/test-alert).
 *
 * What this holds:
 *   - the shape of every kind, and that the shape is closed;
 *   - the tipper's words are plain text (a <script> arrives as text);
 *   - the test alert is the streamer's own and is rate-limited;
 *   - every moment Live already celebrates is announced: a follow, a tip, a goal reached, a sub;
 *   - nothing private rides along: no email, no account id, no Billing or Network internals.
 *
 *   node --import ./test/helpers/pg-preload.mjs test/overlay-alerts.test.js
 */
const assert = require('assert');
const http = require('http');

process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = () => {};
console.warn = () => {};

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    const raw = db.getDb();
    const addUser = async (id, username, display) => await raw.prepare(
        `INSERT INTO users (id, username, display_name, email, password_hash, role) OVERRIDING SYSTEM VALUE
         VALUES (?, ?, ?, ?, 'x', 'user')`).run(id, username, display, `${username}@example.test`);
    await addUser(2, 'ann', 'Ann');
    await addUser(3, 'bob', 'Bob');
    const SID = { ann: 'usr_01JAB2C3D4E5F6G7H8J9K0MNA1', bob: 'usr_01JAB2C3D4E5F6G7H8J9K0MNB2' };
    await raw.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (2, 'network', '102', ?), (3, 'network', '103', ?)")
        .run(SID.ann, SID.bob);
    const streamId = Number((await raw.prepare("INSERT INTO streams (user_id, title, protocol, is_live) VALUES (3, 'bob live', 'webrtc', 1) RETURNING id")).lastInsertRowid);

    // What Live sends to Chat is what the overlay reads: keep the frames.
    const delivery = require('../server/chat/chat-delivery');
    const sent = [];
    delivery.message = async () => 1;
    delivery.event = async (target, frame, opts) => { sent.push({ target, frame, key: opts && opts.key }); return { ok: true }; };
    const alerts = () => sent.filter((s) => s.frame && s.frame.type === 'overlay-alert');

    const overlay = require('../server/overlay/overlay-alerts');

    // ── The shape of every kind ────────────────────────────────────────────────
    const kinds = [
        { kind: 'follow', who: { name: 'Ann', avatar: 'https://example.test/ann.png' }, amount: null, text: null },
        { kind: 'tip', who: { name: 'Bob', avatar: null }, amount: { value: 5, unit: 'vibes' }, text: 'nice stream' },
        { kind: 'sub', who: { name: 'Cid', avatar: null }, amount: null, text: null },
        { kind: 'raid', who: { name: 'Dee', avatar: null }, amount: { value: 12, unit: 'viewers' }, text: null },
        { kind: 'goal', who: null, amount: { value: 1000, unit: 'vibes' }, text: null },
    ];
    for (const [i, k] of kinds.entries()) {
        sent.length = 0;
        const frame = await overlay.emit({ streamerId: 3, kind: k.kind, who: k.who, amount: k.amount, text: k.text, naturalKey: `test:${k.kind}:${i}` });
        assert.strictEqual(frame.type, 'overlay-alert');
        assert.strictEqual(frame.kind, k.kind);
        assert.deepStrictEqual(frame.who, k.who ? { name: k.who.name, avatar: k.who.avatar } : null);
        assert.deepStrictEqual(frame.amount, k.amount);
        assert.strictEqual(frame.text, k.text);
        assert.ok(Number.isFinite(Date.parse(frame.at)), 'the moment says when it happened');
        assert.match(frame.id, /^[a-z]+:[0-9a-f]{16}$/, 'the id is unique per moment and says nothing about it');
        assert.deepStrictEqual(Object.keys(frame).sort(), ['amount', 'at', 'id', 'kind', 'text', 'type', 'who'], 'the shape is closed');
        assert.strictEqual(sent.length, 1);
        assert.deepStrictEqual(sent[0].target, { kind: 'channel', id: 3 }, 'the moment goes to the channel owner\'s own room');
        assert.strictEqual(sent[0].key, `overlay:${frame.id}`, 'the moment is delivered once');
    }
    // The same moment twice is the same message (the ingress key is the moment's id).
    sent.length = 0;
    const first = await overlay.emit({ streamerId: 3, kind: 'tip', who: { name: 'Ann' }, amount: { value: 5, unit: 'vibes' }, text: 'again', naturalKey: 'same-moment' });
    const again = await overlay.emit({ streamerId: 3, kind: 'tip', who: { name: 'Ann' }, amount: { value: 5, unit: 'vibes' }, text: 'again', naturalKey: 'same-moment' });
    assert.strictEqual(first.id, again.id);
    assert.strictEqual(first.at, again.at);
    assert.strictEqual(sent[0].key, sent[1].key);

    // ── Plain text only ────────────────────────────────────────────────────────
    sent.length = 0;
    const script = '<script>alert(1)</script>';
    const tip = await overlay.emit({ streamerId: 3, kind: 'tip', who: { name: 'Ann' }, amount: { value: 5, unit: 'vibes' }, text: script, naturalKey: 'plain' });
    assert.strictEqual(tip.text, script, 'the words are the words: the overlay renders them as text');
    const long = await overlay.emit({ streamerId: 3, kind: 'tip', who: { name: 'Ann' }, amount: null, text: 'x'.repeat(300), naturalKey: 'long' });
    assert.strictEqual(long.text.length, 200, 'the words are trimmed to 200 characters');
    const padded = await overlay.emit({ streamerId: 3, kind: 'tip', who: { name: '  Ann  ' }, amount: null, text: '  hello  ', naturalKey: 'padded' });
    assert.strictEqual(padded.who.name, 'Ann');
    assert.strictEqual(padded.text, 'hello');
    const nameless = await overlay.emit({ streamerId: 3, kind: 'tip', who: null, amount: null, text: null, naturalKey: 'anonymous' });
    assert.strictEqual(nameless.who, null, 'an anonymous tip has no person');
    const scriptish = await overlay.emit({ streamerId: 3, kind: 'tip', who: { name: 'Ann', avatar: 'javascript:alert(1)' }, amount: null, text: null, naturalKey: 'avatar' });
    assert.strictEqual(scriptish.who.avatar, null, 'an avatar is a picture, not a script');

    // ── Nothing private rides along ────────────────────────────────────────────
    sent.length = 0;
    await overlay.emit({ streamerId: 3, kind: 'tip', who: { name: 'Ann', avatar: 'https://example.test/ann.png' }, amount: { value: 500, unit: 'vibes' }, text: 'gg', naturalKey: 'donation:txn_secret_42' });
    const payload = JSON.stringify(sent[0].frame);
    assert.ok(!payload.includes('txn_secret_42'), 'the moment\'s own key is never sent');
    assert.ok(!payload.includes('ann@example.test'), 'no email');
    assert.ok(!payload.includes(SID.bob) && !payload.includes(SID.ann), 'no Network subject');
    assert.ok(!payload.includes('"user_id"') && !payload.includes('"streamer_id"'), 'no account id');
    assert.deepStrictEqual(Object.keys(sent[0].frame).sort(), ['amount', 'at', 'id', 'kind', 'text', 'type', 'who']);

    // ── The moments Live already celebrates ────────────────────────────────────
    // A follow: Network's event reaches Live's projection, and the channel is told.
    const follows = require('../server/social/network-follows');
    sent.length = 0;
    const ev = { event_id: 'evt_01JAB2C3D4E5F6G7H8J9K0M0001', event_type: 'network.follow.created', source: 'network',
        payload: { follower: SID.ann, target_type: 'channel', target_id: SID.bob, revision: 7 } };
    assert.strictEqual(await follows.apply(ev), 'followed');
    assert.strictEqual(alerts().length, 1, 'a follow is announced');
    assert.strictEqual(alerts()[0].frame.kind, 'follow');
    assert.deepStrictEqual(alerts()[0].frame.who, { name: 'Ann', avatar: null });
    assert.deepStrictEqual(alerts()[0].target, { kind: 'channel', id: 3 });
    assert.strictEqual(await follows.apply(ev), 'stale', 'the same event again announces nothing');
    assert.strictEqual(alerts().length, 1);

    // A tip: the on-site donation route celebrates it.
    require('../server/monetization/billing-actions').donate = async (req, { amount }) => ({ amount, transactionId: 'txn_01TIP', balance: 100, goal: null, goalReached: null });
    const auth = require('../server/auth/auth');
    auth.requireAuth = (req, res, next) => {
        const id = Number(req.headers['x-test-user'] || 0);
        db.getUserById(id).then((u) => (u ? (req.user = u, next()) : res.status(401).json({ error: 'Authentication required' }))).catch(next);
    };
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/funds', require('../server/monetization/routes'));
    app.use('/api/overlay', require('../server/overlay/routes'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const call = async (path, body, user) => {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
            method: 'POST', headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': String(user) } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, json: await res.json().catch(() => null) };
    };
    sent.length = 0;
    const donated = await call('/api/funds/donate', { streamer_id: 3, stream_id: streamId, amount: 500, message: 'gg' }, 2);
    assert.strictEqual(donated.status, 200, JSON.stringify(donated.json));
    const tipAlert = alerts().find((a) => a.frame.kind === 'tip');
    assert.ok(tipAlert, 'a tip is announced');
    assert.deepStrictEqual(tipAlert.frame.who, { name: 'Ann', avatar: null });
    assert.deepStrictEqual(tipAlert.frame.amount, { value: 500, unit: 'vibes' });
    assert.strictEqual(tipAlert.frame.text, 'gg');
    assert.deepStrictEqual(tipAlert.target, { kind: 'channel', id: 3 });

    // A goal reached: the goal line, the goal sound, and the overlay's goal alert.
    sent.length = 0;
    await require('../server/monetization/goal-announce').announceGoal({
        userId: 3, streamId, by: 'Ann',
        goalResult: { goal: { id: 9, user_id: 3, title: 'New mic', target_amount: 1000, current_amount: 1000, is_active: 1, reached_at: '2026-10-31T20:00:00.000Z' }, reached: true },
        key: 'goal:txn_01TIP',
    });
    const goalAlert = alerts().find((a) => a.frame.kind === 'goal');
    assert.ok(goalAlert, 'a goal reached is announced');
    assert.deepStrictEqual(goalAlert.frame.amount, { value: 1000, unit: 'vibes' });
    assert.strictEqual(goalAlert.frame.who, null);

    // A subscription Billing settled: "X subscribed" on the channel's overlay.
    sent.length = 0;
    require('../server/integrations/powerchat-platform').forwardSubscription = async () => {};
    require('../server/utils/notify').pushNotification = () => {};
    const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const ulid = () => Array.from(require('crypto').randomBytes(26), (b) => CROCKFORD[b % 32]).join('');
    const envelope = {
        event_id: `evt_${ulid()}`, event_type: 'billing.transaction.settled', version: 1, source: 'billing',
        actor: { type: 'service', id: 'billing' }, timestamp: new Date().toISOString(), priority: 'important', visibility: 'internal',
        subject: { type: 'transaction', id: 'txn_x' },
        payload: { transaction_id: 'txn_01SUB', type: 'subscription', test: false, from_subject: SID.ann, to_subject: SID.bob, provider: 'powerchat', metadata: { renewal: false } },
    };
    assert.strictEqual(await require('../server/monetization/billing-events').apply(envelope), 'applied');
    const subAlert = alerts().find((a) => a.frame.kind === 'sub');
    assert.ok(subAlert, 'a subscription is announced');
    assert.deepStrictEqual(subAlert.frame.who, { name: 'Ann', avatar: null });
    assert.strictEqual(subAlert.frame.amount, null);
    assert.strictEqual(subAlert.frame.text, null);

    // A subscription (the Vibes route): "X subscribed".
    sent.length = 0;
    const billing = require('../server/monetization/billing-client');
    billing.subjectFor = async () => 'usr_01JAB2C3D4E5F6G7H8J9K0MNA1';
    billing.request = async () => ({ transaction: { id: 'txn_sub_1' }, subscription: { id: 'sub_1', current_period_end: null } });
    billing.api.entitlement = async () => null;
    const billingActions = require('../server/monetization/billing-actions');
    const subscription = await billingActions.subscribe({ user: await db.getUserById(2), headers: {} }, { streamer: await db.getUserById(3), provider: 'bucks' });
    assert.strictEqual(subscription.status, 200, JSON.stringify(subscription.body));
    const subFrame = sent.find((s) => s.frame.kind === 'sub');
    assert.ok(subFrame, 'a subscription is announced');
    assert.deepStrictEqual(subFrame.target, { kind: 'channel', id: 3 }, 'in the subscribed channel’s room');
    assert.strictEqual(subFrame.frame.who.name, 'Ann');
    assert.strictEqual(subFrame.frame.amount, null);

    // ── The streamer's own test alert ──────────────────────────────────────────
    const overlayRoutes = require('../server/overlay/routes');
    overlayRoutes._reset();
    sent.length = 0;
    const unauth = await call('/api/overlay/test-alert', { kind: 'tip' });
    assert.strictEqual(unauth.status, 401, 'signed in only');
    assert.strictEqual(alerts().length, 0, 'nobody is told');
    assert.strictEqual((await call('/api/overlay/test-alert', { kind: 'nope' }, 3)).status, 400, 'an unknown kind');
    assert.strictEqual((await call('/api/overlay/test-alert', { kind: 'tip', streamer_id: 2 }, 3)).status, 400, 'no other room to aim at');
    assert.strictEqual((await call('/api/overlay/test-alert', {}, 3)).status, 400, 'a kind is required');
    assert.strictEqual(alerts().length, 0);

    sent.length = 0;
    const mine = await call('/api/overlay/test-alert', { kind: 'tip' }, 3);
    assert.strictEqual(mine.status, 200, JSON.stringify(mine.json));
    assert.strictEqual(alerts().length, 1, 'the sample reaches the room');
    assert.deepStrictEqual(alerts()[0].target, { kind: 'channel', id: 3 }, 'and it is the streamer\'s own room');
    assert.strictEqual(alerts()[0].frame.kind, 'tip');
    assert.strictEqual(mine.json.id, alerts()[0].frame.id);

    // Every kind has a sample.
    for (const kind of ['follow', 'tip', 'sub', 'raid', 'goal']) {
        sent.length = 0;
        const r = await call('/api/overlay/test-alert', { kind }, 3);
        assert.strictEqual(r.status, 200, `${kind}: ${JSON.stringify(r.json)}`);
        assert.strictEqual(alerts().length, 1, `${kind} is announced`);
        assert.strictEqual(alerts()[0].frame.kind, kind);
    }

    // And it is rate-limited: a test button, not a firehose.
    overlayRoutes._reset();
    let refused = 0;
    for (let i = 0; i < 12; i++) {
        const r = await call('/api/overlay/test-alert', { kind: 'tip' }, 3);
        if (r.status === 429) refused++;
        else assert.strictEqual(r.status, 200, `call ${i + 1}: ${JSON.stringify(r.json)}`);
    }
    assert.strictEqual(refused, 2, 'ten a minute are allowed, the rest are refused');

    server.close();
    quiet('overlay alerts: all checks passed');
    process.exit(0);
})().catch((err) => { quiet(err); process.exit(1); });
