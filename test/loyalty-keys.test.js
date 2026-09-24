/**
 * Loyalty ledgers use deterministic per-event idempotency keys (ADR-012 rule 5), so a retry never
 * spends or credits twice.
 *
 *  - Channel points: every debit and credit goes through db.applyChannelPoints with a key, logged
 *    in channel_points_log; a repeated key moves nothing, a reused key for another event is refused,
 *    a refused debit leaves no row. Earn keys: watch row + minute, chat minute, follow, bonus window;
 *    a redemption is taken under its redemption id (limits first, no take-then-refund), and a
 *    streamer rejecting it twice refunds once.
 *  - Media requests: the request row is written first and the charge is keyed by its id
 *    (live:media_req:<id> for OpenCoins and points; Billing's key is tested in billing-authority).
 *    A wallet that never answers leaves the request 'unknown'; reconcileCharges() re-charges with
 *    the same key (a replay) and refunds, so the viewer ends where they started.
 *  - Admin OpenCoins grants: keyed by a local grant record; an Idempotency-Key repeat is the same grant.
 *
 *   node test/loyalty-keys.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-loyalty-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = () => {};
console.warn = () => {};

const db = require('../server/db/database');
db.initDb();
const raw = db.getDb();
const auth = require('../server/auth/auth');
const signIn = (req) => {
    const id = Number(req.headers['x-test-user'] || 0);
    const u = id ? db.getUserById(id) : null;
    if (u) req.user = u;
    return u;
};
auth.requireAuth = (req, res, next) => (signIn(req) ? next() : res.status(401).json({ error: 'Authentication required' }));

const addUser = (id, name, role = 'streamer', owner = 0) => raw.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role, is_owner) VALUES (?, ?, ?, ?, 'x', ?, ?)`).run(id, name, name, `${name}@x`, role, owner);
addUser(1, 'owner', 'admin', 1);
addUser(2, 'viewer');
addUser(3, 'streamer');
db.ensureChannel(3);
const chan = db.getChannelByUserId(3);
const streamId = Number(db.createStream({ user_id: 3, channel_id: chan.id, title: 'live', protocol: 'webrtc' }).lastInsertRowid);
const cp = () => db.getChannelPoints(2, 3);
const logRows = (key) => raw.prepare('SELECT * FROM channel_points_log WHERE idempotency_key = ?').all(key);

// A Network wallet that behaves like the real one: one effect per idempotency key.
const wallet = require('../server/monetization/wallet-client');
const ledger = { balance: 1000, keys: new Map(), calls: [], failNext: 0, landBeforeFailing: false };
function walletOp(kind) {
    return async (userId, amount, reason, key) => {
        ledger.calls.push({ kind, key, amount });
        if (ledger.failNext > 0) {
            ledger.failNext--;
            if (ledger.landBeforeFailing && !ledger.keys.has(key)) { ledger.keys.set(key, { kind, amount }); ledger.balance += kind === 'debit' ? -amount : amount; }
            const e = new Error('Network wallet unreachable: timeout'); e.status = 0; throw e;
        }
        if (ledger.keys.has(key)) return { balance: ledger.balance, replayed: true };
        if (kind === 'debit' && ledger.balance < amount) { const e = new Error('insufficient_funds'); e.status = 409; throw e; }
        ledger.keys.set(key, { kind, amount });
        ledger.balance += kind === 'debit' ? -amount : amount;
        return { balance: ledger.balance };
    };
}
wallet.debit = walletOp('debit');
wallet.credit = walletOp('credit');

(async () => {
    // ── 1. The keyed channel-points log ──────────────────────────────────────────────
    assert.throws(() => db.addChannelPoints(2, 3, 10), /idempotency key is required/, 'no unkeyed credit');
    assert.throws(() => db.deductChannelPoints(2, 3, 10), /idempotency key is required/, 'no unkeyed debit');
    assert.strictEqual(db.addChannelPoints(2, 3, 100, 'live:cp:test:credit:1'), 100);
    assert.strictEqual(db.addChannelPoints(2, 3, 100, 'live:cp:test:credit:1'), 100, 'a retried credit is applied once');
    assert.strictEqual(db.deductChannelPoints(2, 3, 30, 'live:cp:test:debit:1'), true);
    assert.strictEqual(db.deductChannelPoints(2, 3, 30, 'live:cp:test:debit:1'), true, 'a retried debit answers as taken…');
    assert.strictEqual(cp(), 70, '…but takes once');
    assert.throws(() => db.addChannelPoints(2, 3, 5, 'live:cp:test:credit:1'), /already used for a different event/, 'a key reused for another amount is refused');
    assert.strictEqual(db.deductChannelPoints(2, 3, 500, 'live:cp:test:debit:big'), false, 'not enough: refused');
    assert.strictEqual(logRows('live:cp:test:debit:big').length, 0, 'a refused debit leaves no log row');
    db.addChannelPoints(2, 3, 500, 'live:cp:test:topup');
    assert.strictEqual(db.deductChannelPoints(2, 3, 500, 'live:cp:test:debit:big'), true, 'so the same key can be tried again once the balance covers it');
    assert.strictEqual(cp(), 70);

    // ── 2. Earning: follow, chat (across a "restart"), watch ───────────────────────
    let coins = require('../server/monetization/opencoins');
    assert.ok(coins.awardFollow(2, 3));
    raw.prepare("DELETE FROM coin_transactions WHERE type = 'follow_bonus'").run();   // even without the old LIKE check…
    assert.strictEqual(coins.awardFollow(2, 3), null, '…a second follow bonus is refused by its key');
    assert.strictEqual(logRows('live:cp:follow:2:3').length, 1);
    const afterFollow = cp();
    assert.ok(coins.awardChat(2, streamId));
    delete require.cache[require.resolve('../server/monetization/opencoins')];
    coins = require('../server/monetization/opencoins');   // a restart: the in-memory chat cooldown is gone
    const minute = Math.floor(Date.now() / 60_000);
    const secondChat = coins.awardChat(2, streamId);
    if (Math.floor(Date.now() / 60_000) === minute) assert.strictEqual(secondChat, null, 'the same chat minute earns once, even after a restart');
    assert.strictEqual(cp(), afterFollow + 5 + (secondChat ? 5 : 0));
    raw.prepare('INSERT INTO watch_time (user_id, stream_id, minutes_watched) VALUES (2, ?, 4)').run(streamId);
    const watched = coins.awardWatch(2, streamId);   // minute 5 of the default 5-minute interval
    assert.ok(watched && watched.coins === 10);
    const wt = db.getWatchTime(2, streamId);
    assert.strictEqual(logRows(`live:cp:watch:${wt.id}:5`).length, 1, 'the watch award is keyed by the watch row and minute');
    assert.strictEqual(db.applyChannelPoints({ userId: 2, streamerId: 3, delta: 10, key: `live:cp:watch:${wt.id}:5` }).replayed, true, 'replaying that minute moves nothing');

    // ── 3. Redemptions: limits before the spend, keyed by redemption, reject refunds once ──
    const rewardId = Number(db.createCoinReward({ streamer_id: 3, title: 'Hydrate', cost: 40, cooldown_seconds: 3600 }).lastInsertRowid);
    const beforeRedeem = cp();
    const red = coins.redeem(2, rewardId, streamId, 'drink');
    assert.strictEqual(cp(), beforeRedeem - 40);
    assert.strictEqual(logRows(`live:cp:redeem:${red.redemption.id}`).length, 1, 'the spend is keyed by the redemption id');
    const redemptions = raw.prepare('SELECT COUNT(*) AS n FROM coin_redemptions').get().n;
    assert.throws(() => coins.redeem(2, rewardId, streamId, 'again'), /Cooldown/);
    assert.strictEqual(cp(), beforeRedeem - 40, 'a refused redemption takes nothing (no take-then-refund)');
    assert.strictEqual(raw.prepare('SELECT COUNT(*) AS n FROM coin_redemptions').get().n, redemptions, 'and leaves no redemption row');
    const pricey = Number(db.createCoinReward({ streamer_id: 3, title: 'Big', cost: 1_000_000 }).lastInsertRowid);
    assert.throws(() => coins.redeem(2, pricey, streamId, ''), /Not enough/);
    assert.strictEqual(raw.prepare('SELECT COUNT(*) AS n FROM coin_redemptions').get().n, redemptions, 'not enough points: the redemption row is rolled back');

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { signIn(req); next(); });
    app.use('/api/coins', require('../server/monetization/coins-routes'));
    const server = http.createServer(app).listen(0);
    const call = (method, p, user, body, headers = {}) => new Promise((resolve, reject) => {
        const req = http.request({ port: server.address().port, path: p, method, headers: { 'content-type': 'application/json', 'x-test-user': String(user), ...headers } }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode, json }); });
        });
        req.on('error', reject);
        req.end(body ? JSON.stringify(body) : undefined);
    });
    const beforeReject = cp();
    assert.strictEqual((await call('POST', `/api/coins/redemptions/${red.redemption.id}`, 3, { status: 'rejected' })).status, 200);
    assert.strictEqual((await call('POST', `/api/coins/redemptions/${red.redemption.id}`, 3, { status: 'rejected' })).status, 200);
    assert.strictEqual(cp(), beforeReject + 40, 'rejecting the same redemption twice refunds once');
    assert.strictEqual(logRows(`live:cp:redeem_refund:${red.redemption.id}`).length, 1);

    // ── 4. Media requests ───────────────────────────────────────────────────────────
    const mq = require('../server/media/media-queue');
    let n = 0;
    mq.normalizeInput = async () => { n++; return { canonical_url: `https://media.example/${n}.mp4`, embed_url: null, provider: 'video', title: `clip ${n}`, thumbnail_url: null, duration_seconds: 30, isLive: false }; };
    mq.extractStreamUrlForRequest = async () => null;
    mq.broadcastQueueUpdate = () => {};
    db.upsertMediaRequestSettings(3, { enabled: 1, request_cost: 25, currency: 'opencoins', max_per_user: 10 });

    const start = ledger.balance;
    const req1 = await mq.addRequest({ streamerId: 3, streamId, userId: 2, username: 'viewer', input: 'https://media.example/a.mp4' });
    assert.strictEqual(req1.status, 'pending');
    assert.strictEqual(ledger.calls.at(-1).key, `live:media_req:${req1.id}`, 'the OpenCoins spend is keyed by the request id');
    assert.strictEqual(ledger.balance, start - 25);
    // A retry of that charge (same request) is a replay at the wallet: nothing more is taken.
    await mq.charge({ currency: 'opencoins', cost: 25, userId: 2, streamerId: 3, streamId, label: 'retry', requestId: req1.id });
    assert.strictEqual(ledger.balance, start - 25, 'retrying the charge does not spend twice');
    assert.ok(db.getMediaRequestById(req1.id).queue_position >= 1, 'a paid request joins the queue');

    // The wallet times out after the debit landed, twice: the viewer is told it failed and the
    // request waits, out of the queue, for the reconciler.
    ledger.failNext = 2; ledger.landBeforeFailing = true;
    const queueBefore = db.all("SELECT id FROM media_requests WHERE status = 'pending'").length;
    await assert.rejects(mq.addRequest({ streamerId: 3, streamId, userId: 2, username: 'viewer', input: 'https://media.example/b.mp4' }), /Could not reach the OpenCoins wallet/);
    ledger.landBeforeFailing = false;
    const unknown = raw.prepare("SELECT * FROM media_requests WHERE charge_state = 'unknown'").get();
    assert.ok(unknown, 'the request is kept with its charge unknown');
    assert.strictEqual(unknown.status, 'failed');
    assert.strictEqual(db.all("SELECT id FROM media_requests WHERE status = 'pending'").length, queueBefore, 'and is not in the queue');
    assert.strictEqual(ledger.balance, start - 50, 'the debit did land');
    assert.strictEqual(await mq.reconcileCharges({ olderThanMs: -60_000 }), 1);
    assert.strictEqual(ledger.balance, start - 25, 'the reconciler re-charged with the same key (a replay) and refunded');
    assert.deepStrictEqual(ledger.calls.filter((c) => c.key === `live:media_req:${unknown.id}`).map((c) => c.kind), ['debit', 'debit', 'debit'], 'every attempt used the one key');
    const settled = db.getMediaRequestById(unknown.id);
    assert.strictEqual(settled.charge_state, null);
    assert.strictEqual(settled.refunded, 1);
    assert.strictEqual(await mq.reconcileCharges({ olderThanMs: -60_000 }), 0, 'nothing left to settle');
    assert.strictEqual(mq.refund(unknown.id), 0, 'and it is not refunded a second time');

    // A wallet that never answered and never took anything: the re-charge takes it, the refund gives it back.
    ledger.failNext = 2;
    await assert.rejects(mq.addRequest({ streamerId: 3, streamId, userId: 2, username: 'viewer', input: 'https://media.example/c.mp4' }), /Could not reach/);
    await mq.reconcileCharges({ olderThanMs: -60_000 });
    assert.strictEqual(ledger.balance, start - 25, 'net zero either way');

    // Not enough OpenCoins: nothing taken, no row left behind.
    const rows = raw.prepare('SELECT COUNT(*) AS n FROM media_requests').get().n;
    ledger.balance = 10;
    await assert.rejects(mq.addRequest({ streamerId: 3, streamId, userId: 2, username: 'viewer', input: 'https://media.example/d.mp4' }), /Not enough OpenCoins/);
    assert.strictEqual(raw.prepare('SELECT COUNT(*) AS n FROM media_requests').get().n, rows, 'a refused charge leaves no request row');
    assert.strictEqual(ledger.balance, 10);

    // Channel points: spend keyed by the request, refund keyed by the request, once.
    db.upsertMediaRequestSettings(3, { currency: 'points' });
    const pts = cp();
    const req2 = await mq.addRequest({ streamerId: 3, streamId, userId: 2, username: 'viewer', input: 'https://media.example/e.mp4' });
    assert.strictEqual(cp(), pts - 25);
    assert.strictEqual(logRows(`live:media_req:${req2.id}`).length, 1);
    assert.strictEqual(db.deductChannelPoints(2, 3, 25, `live:media_req:${req2.id}`), true, 'a retried points charge is a replay');
    assert.strictEqual(cp(), pts - 25);
    assert.strictEqual(mq.refund(req2.id), 25);
    db.updateMediaRequest(req2.id, { refunded: 0 });   // even if the refunded flag were lost…
    mq.refund(req2.id);
    assert.strictEqual(cp(), pts, '…the refund key credits once');

    // ── 5. Admin OpenCoins grants ─────────────────────────────────────────────────
    const g0 = ledger.balance;
    let r = await call('POST', '/api/coins/admin/grant', 1, { userId: 2, amount: 50, reason: 'thanks' }, { 'Idempotency-Key': 'grant-abc-123' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    const grantKey = ledger.calls.at(-1).key;
    assert.match(grantKey, /^live:admin_grant:\d+$/, 'the grant is keyed by its local record');
    r = await call('POST', '/api/coins/admin/grant', 1, { userId: 2, amount: 50, reason: 'thanks' }, { 'Idempotency-Key': 'grant-abc-123' });
    assert.strictEqual(ledger.calls.at(-1).key, grantKey, 'a repeated submit reuses the grant and its key');
    assert.strictEqual(ledger.balance, g0 + 50, 'and credits once');
    r = await call('POST', '/api/coins/admin/grant', 1, { userId: 2, amount: 99 }, { 'Idempotency-Key': 'grant-abc-123' });
    assert.strictEqual(r.status, 400, 'the same Idempotency-Key for a different grant is refused');
    await call('POST', '/api/coins/admin/grant', 1, { userId: 2, amount: 50 });
    assert.notStrictEqual(ledger.calls.at(-1).key, grantKey, 'a new grant without a key is a new event');
    assert.strictEqual(ledger.balance, g0 + 100);

    // ── No random keys left in the loyalty paths ───────────────────────────────────
    for (const f of ['server/media/media-queue.js', 'server/monetization/opencoins.js', 'server/monetization/coins-routes.js']) {
        const keyLines = fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split('\n').filter((l) => /`live:(media_req|media_refund|admin_grant|cp:)/.test(l));
        assert.ok(keyLines.length, `${f} builds loyalty keys`);
        for (const l of keyLines) assert.ok(!/Date\.now\(\)|Math\.random\(\)|randomUUID/.test(l), `${f}: a loyalty key never uses the clock or randomness: ${l.trim()}`);
    }
    const ba = fs.readFileSync(path.join(__dirname, '..', 'server/monetization/billing-actions.js'), 'utf8');
    assert.ok(/key: `live:media_charge:\$\{requestId\}`/.test(ba), 'the Billing media charge is keyed by the request id');

    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    quiet('loyalty-keys: ok');
    process.exit(0);
})().catch((err) => {
    quiet(err);
    process.exit(1);
});
