'use strict';
/**
 * channel_tips (migrations/0009_channel_tips.sql, server/monetization/channel-tips.js): every tip a channel received,
 * whatever carried it. The stream leaderboard, the home's pulse and stats read it instead of Live's `transactions`, which
 * stops at the Billing cutover and never held PowerChat or OpenVibe.Tips tips.
 *
 *   node --import ./test/helpers/pg-preload.mjs test/channel-tips.test.js
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
    const addUser = async (id, username) => await raw.prepare(
        `INSERT INTO users (id, username, display_name, email, password_hash, role) OVERRIDING SYSTEM VALUE
         VALUES (?, ?, ?, ?, 'x', 'user')`).run(id, username, username[0].toUpperCase() + username.slice(1), `${username}@x`);
    await addUser(2, 'ann');
    await addUser(3, 'bob');
    const streamId = Number((await db.run("INSERT INTO streams (user_id, title, protocol, is_live) VALUES (3, 'bob live', 'webrtc', 1) RETURNING id")).lastInsertRowid);

    // Chat shows the lines (Live keeps no chat table): record what is sent instead.
    const delivery = require('../server/chat/chat-delivery');
    delivery.message = async () => 1;
    delivery.event = async () => {};

    // OpenVibe.Billing moves the Vibes (a stand-in here): the route records the tip under Billing's transaction.
    require('../server/monetization/billing-actions').donate = async (req, { amount }) => ({ amount, transactionId: 'txn_01DONATION', balance: 1850, goal: null, goalReached: null });
    const auth = require('../server/auth/auth');
    const signIn = async (req) => { const id = Number(req.headers['x-test-user'] || 0); const u = id ? await db.getUserById(id) : null; if (u) req.user = u; return u; };
    auth.requireAuth = (req, res, next) => { signIn(req).then((u) => (u ? next() : res.status(401).json({ error: 'Authentication required' }))).catch(next); };
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/funds', require('../server/monetization/routes'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const donate = async (user, body) => {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/api/funds/donate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': String(user) }, body: JSON.stringify(body) });
        return { status: res.status, json: await res.json() };
    };
    const tip = (ref) => raw.prepare('SELECT to_user_id, from_user_id, username, stream_id, amount, source FROM channel_tips WHERE ref = ?').get(ref);
    const count = async () => Number((await raw.prepare('SELECT COUNT(*) AS n FROM channel_tips').get()).n);

    // An on-site Vibes donation (Billing moved it): one tip named after Billing's transaction.
    const d = await donate(2, { streamer_id: 3, stream_id: streamId, amount: 150, message: 'gg' });
    assert.strictEqual(d.status, 200, JSON.stringify(d.json));
    assert.strictEqual(d.json.balance, 1850, "the donor's balance is Billing's");
    assert.deepStrictEqual(await tip('billing-txn:txn_01DONATION'), { to_user_id: 3, from_user_id: 2, username: null, stream_id: streamId, amount: 150, source: 'vibes' });

    // A tip on bob's own PowerChat: no Live account, so the name is kept; the same event twice is one tip.
    const powerchat = require('../server/integrations/powerchat-webhook');
    await powerchat.creditDonationPipeline(3, { eventId: 'evt_9', amountUsdCents: 300, donorName: 'pcfan', message: '' });
    await powerchat.creditDonationPipeline(3, { eventId: 'evt_9', amountUsdCents: 300, donorName: 'pcfan', message: '' });
    assert.deepStrictEqual(await tip('powerchat:evt_9'), { to_user_id: 3, from_user_id: null, username: 'pcfan', stream_id: streamId, amount: 300, source: 'powerchat' });
    // A PowerChat tip routed through the site account names the donor's Live account.
    await powerchat.creditDonationPipeline(3, { eventId: 'evt_10', amountUsdCents: 400, donorName: 'Ann', message: '' }, { fromUserId: 2 });
    assert.deepStrictEqual(await tip('powerchat:evt_10'), { to_user_id: 3, from_user_id: 2, username: null, stream_id: streamId, amount: 400, source: 'powerchat' });
    // A supporter who hid the amount (OpenVibe.Tips privacy.hide_amount) tipped, but adds nothing to the sums.
    const channelTips = require('../server/monetization/channel-tips');
    assert.strictEqual(await channelTips.record({ toUserId: 3, username: 'shy', streamId, amount: null, source: 'tips', ref: 'tips:tint_s:chat_line' }), true);
    assert.strictEqual(await channelTips.record({ toUserId: 3, username: 'shy', streamId, amount: null, source: 'tips', ref: 'tips:tint_s:chat_line' }), false, 'a repeat keeps one row');
    assert.strictEqual(await channelTips.record({ toUserId: 3, amount: 5, source: 'nope', ref: 'x:1' }), false, 'an unknown source is refused');
    assert.strictEqual(await count(), 4);

    // The stream's leaderboard: Ann's on-site and PowerChat tips together, then the PowerChat supporter (no profile link).
    const board = await require('../server/monetization/vibes').getLeaderboard(streamId);
    assert.deepStrictEqual(board.map((r) => [r.username, r.display_name, Number(r.total_donated)]), [['ann', 'Ann', 550], [null, 'pcfan', 300]]);

    // The home pulse and stats count every rail.
    const pulse = await db.getHomePulse();
    assert.strictEqual(pulse.latestTip.from_username, 'ann', 'the newest tip with an amount');
    assert.strictEqual(Number(pulse.latestTip.amount), 400);
    assert.deepStrictEqual(pulse.topSupporters.map((r) => [r.username, r.display_name, Number(r.total)]), [['ann', 'Ann', 550], [null, 'pcfan', 300]]);
    const stats = await db.getHomeStats();
    assert.strictEqual(stats.vibesTipped, 850);
    assert.strictEqual(stats.supporters, 3, 'ann, pcfan and the supporter who hid the amount');
    assert.strictEqual((await db.getHomeStatSeries('supporters', 30)).total, 3);

    // 0009's backfill copied the ledger's completed donations on 2026-10-17; the ledger itself went in 0016.

    server.close();
    quiet('channel tips: all checks passed');
    process.exit(0);
})().catch((err) => { quiet(err); process.exit(1); });
