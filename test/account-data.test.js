'use strict';
// Account export and deletion → Live (roadmap WS-B task 7, ADR-033): through POST /internal/network-events (signed),
// network.account.export_requested sends Live's part to Network (the profile and the person's rows per table, no
// stream keys or token hashes; an empty part for someone with no Live account), and network.account.deleted erases the
// person's rows (follows and channel points both ways, streams with what is inside them, their own chat lines,
// managed streams, tokens), keeps money and moderation rows pointing at a tombstone (the donation message cleared),
// keeps shared rows without them, releases the username, and confirms with counts. A redelivery sends nothing twice;
// a failed confirmation is retried without erasing again. The subscription asks for both topics.
//   node test/account-data.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-live-account-data-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.NODE_ENV = 'test';
process.env.LIVE_EVENTS_SECRET = 's'.repeat(40);
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

const express = require('express');
const { ids, validate } = require('openvibe-contracts');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const db = require('../server/db/database');
db.initDb();
const networkEvents = require('../server/auth/network-events');
const accountData = require('../server/auth/account-data');
const { NETWORK_TOPICS } = require('../scripts/subscribe-media-events');

const DANA = ids.newId('user'), XENA = ids.newId('user'), NOBODY = ids.newId('user');
const d = db.getDb();
d.prepare(`INSERT INTO users (id, username, email, password_hash, bio) VALUES (20, 'dana', 'dana@example.com', '$sso$', 'hi'), (21, 'xena', NULL, '$sso$', ''), (22, 'yuri', NULL, '$sso$', '')`).run();
d.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, service_username, subject_id) VALUES (20, 'network', '200', 'dana', ?), (21, 'network', '201', 'xena', ?)").run(DANA, XENA);
d.prepare('INSERT INTO follows (follower_id, streamer_id) VALUES (20, 21), (22, 20), (22, 21)').run();
d.prepare('INSERT INTO channel_points (user_id, streamer_id, balance) VALUES (20, 21, 30), (22, 20, 7), (22, 21, 5)').run();
d.prepare("INSERT INTO streams (id, user_id, title) VALUES (1, 20, 'dana live'), (2, 21, 'xena live')").run();
// yuri chats in dana's stream (goes with the stream); dana chats in xena's (her own line goes); yuri in xena's stays.
d.prepare("INSERT INTO chat_messages (stream_id, user_id, username, message) VALUES (1, 22, 'yuri', 'hey dana'), (2, 20, 'dana', 'hey xena'), (2, 22, 'yuri', 'yo')").run();
d.prepare("INSERT INTO managed_streams (user_id, stream_key) VALUES (20, 'sk_live_secret_dana')").run();
d.prepare("INSERT INTO api_tokens (user_id, token_hash) VALUES (20, 'hash-secret-dana')").run();
d.prepare("INSERT INTO transactions (from_user_id, to_user_id, amount, type, message) VALUES (20, 21, 5, 'donation', 'love you xena'), (22, 20, 3, 'donation', 'for dana')").run();
d.prepare("INSERT INTO payment_orders (user_id, provider, provider_ref, kind, amount_cents, currency, bucks, status) VALUES (20, 'paypal', 'PO-1', 'bucks', 500, 'USD', 5, 'completed')").run();
d.prepare("INSERT INTO moderation_actions (action_type, actor_user_id, target_user_id) VALUES ('timeout', 21, 20)").run();

const envelope = (type, payload) => {
    assert.ok(validate(`${type}@1`, payload).valid, JSON.stringify(validate(`${type}@1`, payload).errors));
    return { event_id: ids.newId('event'), event_type: type, version: 1, source: 'network', actor: { type: 'user', id: payload.subject },
        timestamp: new Date().toISOString(), visibility: 'internal', subject: { type: 'user', id: payload.subject }, payload };
};
const ulid = () => ids.ulid();

(async () => {
    const app = express();
    app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
    app.post('/internal/network-events', networkEvents.handler);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/internal/network-events`;
    const deliver = async (ev) => { const raw = JSON.stringify({ event: ev, seq: 1 }); return (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...signDeliveryHeaders(raw, process.env.LIVE_EVENTS_SECRET) }, body: raw })).status; };
    const sent = [];
    let failNext = false;
    const send = async (p, body) => { if (failNext) { failNext = false; return { ok: false, status: 503 }; } sent.push({ path: p, body }); return { ok: true, status: 200 }; };
    try {
        assert.ok(NETWORK_TOPICS.includes('network.account.export_requested') && NETWORK_TOPICS.includes('network.account.deleted'), 'the subscription asks for both');
        const cols = accountData.personColumns(d);
        for (const t of accountData.FROZEN) assert.ok(!cols.has(t), `${t} is never touched`);

        // ── Export ──
        const exp = envelope('network.account.export_requested', { export_id: `exp_${ulid()}`, subject: DANA, requested_at: new Date().toISOString(), deadline: new Date(Date.now() + 1800000).toISOString() });
        assert.strictEqual(await accountData.apply(exp, { send }), 'exported');
        assert.strictEqual(sent.length, 1);
        assert.strictEqual(sent[0].path, `/internal/account-exports/${exp.payload.export_id}/parts`);
        const part = sent[0].body;
        assert.ok(validate('network.account-export-part@1', part).valid, JSON.stringify(validate('network.account-export-part@1', part).errors));
        const byName = Object.fromEntries(part.files.map((f) => [f.name, f.content]));
        assert.strictEqual(byName['profile.json'].username, 'dana');
        assert.deepStrictEqual(byName['follows.json'].map((f) => [f.follower_id, f.streamer_id]).sort(), [[20, 21], [22, 20]]);
        assert.ok(byName['transactions.json'] && byName['payment_orders.json'], 'money history is theirs to see');
        const text = JSON.stringify(part);
        for (const secret of ['sk_live_secret_dana', 'hash-secret-dana', '$sso$']) assert.ok(!text.includes(secret), `no ${secret}`);
        assert.strictEqual(await accountData.apply(exp, { send }), 'unchanged', 'a redelivery sends nothing twice');
        assert.strictEqual(sent.length, 1);
        const lone = envelope('network.account.export_requested', { export_id: `exp_${ulid()}`, subject: NOBODY, requested_at: new Date().toISOString(), deadline: new Date(Date.now() + 1800000).toISOString() });
        assert.strictEqual(await accountData.apply(lone, { send }), 'exported');
        assert.deepStrictEqual(sent[1].body.files, [], 'no Live account: an empty part, so the export does not wait');

        // ── Deletion ──
        const del = envelope('network.account.deleted', { deletion_id: `del_${ulid()}`, subject: DANA, requested_at: new Date(Date.now() - 30 * 86400000).toISOString(), deleted_at: new Date().toISOString() });
        failNext = true;
        await assert.rejects(accountData.apply(del, { send }), /confirmation refused: 503/, 'a failed confirmation is redelivered');
        const n = (sql, ...a) => d.prepare(sql).get(...a).n;
        assert.strictEqual(n('SELECT COUNT(*) AS n FROM follows WHERE follower_id = 20 OR streamer_id = 20'), 0, 'follows both ways');
        assert.strictEqual(n('SELECT COUNT(*) AS n FROM channel_points WHERE user_id = 20 OR streamer_id = 20'), 0, 'channel points both ways');
        assert.strictEqual(n('SELECT COUNT(*) AS n FROM follows'), 1, "others' follows stay");
        assert.strictEqual(n('SELECT COUNT(*) AS n FROM streams WHERE user_id = 20'), 0);
        assert.deepStrictEqual(d.prepare('SELECT stream_id, user_id, message FROM chat_messages ORDER BY id').all(), [{ stream_id: 2, user_id: 22, message: 'yo' }],
            'the stream took its chat with it; her own line elsewhere went; others stay');
        assert.strictEqual(n('SELECT COUNT(*) AS n FROM managed_streams WHERE user_id = 20') + n('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = 20') + n("SELECT COUNT(*) AS n FROM linked_accounts WHERE user_id = 20"), 0);
        assert.deepStrictEqual(d.prepare('SELECT from_user_id AS f, message FROM transactions ORDER BY id').all(), [{ f: 20, message: null }, { f: 22, message: 'for dana' }], 'money kept; her own message cleared');
        assert.strictEqual(n("SELECT COUNT(*) AS n FROM payment_orders WHERE user_id = 20"), 1, 'payment orders kept');
        assert.strictEqual(n('SELECT COUNT(*) AS n FROM moderation_actions WHERE target_user_id = 20'), 1, 'moderation records kept');
        const tomb = d.prepare('SELECT username, email, bio, deleted_at FROM users WHERE id = 20').get();
        assert.deepStrictEqual([tomb.username, tomb.email, tomb.bio, !!tomb.deleted_at], ['deleted-20', null, null, true]);
        d.prepare("INSERT INTO users (username, password_hash) VALUES ('dana', '$sso$')").run();
        assert.strictEqual(await accountData.apply(del, { send }), 'confirmed', 'the retry confirms without erasing again');
        const conf = sent[2];
        assert.strictEqual(conf.path, `/internal/account-deletions/${del.payload.deletion_id}/confirmations`);
        assert.ok(validate('network.account-deletion-confirmation@1', conf.body).valid, JSON.stringify(validate('network.account-deletion-confirmation@1', conf.body).errors));
        assert.ok(conf.body.erased.follows >= 2 && conf.body.erased.streams === 1 && conf.body.erased.accounts === 1, JSON.stringify(conf.body.erased));
        assert.ok(conf.body.retained.transactions === 2 && conf.body.retained.payment_orders === 1 && conf.body.retained.moderation_actions === 1, JSON.stringify(conf.body.retained));
        assert.strictEqual(await accountData.apply(del, { send }), 'unchanged');
        assert.strictEqual(sent.length, 3);

        // Through the signed endpoint: another source is ignored (204, nothing sent), and a bad payload too.
        assert.strictEqual(await deliver({ ...envelope('network.account.deleted', { deletion_id: `del_${ulid()}`, subject: XENA, requested_at: new Date().toISOString(), deleted_at: new Date().toISOString() }), source: 'media' }), 204);
        assert.strictEqual(n('SELECT COUNT(*) AS n FROM users WHERE id = 21 AND deleted_at IS NULL'), 1, 'xena untouched');
        assert.strictEqual(await networkEvents.apply({ event_id: ids.newId('event'), event_type: 'network.account.deleted', source: 'network', payload: { deletion_id: 'x', subject: XENA } }), 'ignored:payload');
    } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log('account export and deletion: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
