'use strict';
// network.subject.merged → Live (roadmap WS-B task 5, ADR-029): through POST /internal/network-events (signed), the
// folded-in Live user's follows (both ways), channel points (both ways, a shared pair summed, every move logged once)
// and streams move to the survivor's user; a follow it already has and following oneself are dropped; the folded-in
// user is marked merged_into. With only the folded-in account on Live, that user is relinked to the survivor. A
// redelivery changes nothing; a merge nobody on Live had is acknowledged. The subscription asks for the topic.
//   node test/subject-merge.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-live-merge-'));
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
const subjectMerge = require('../server/auth/subject-merge');
const { NETWORK_TOPICS } = require('../scripts/subscribe-media-events');

const KEEP = ids.newId('user'), FOLD = ids.newId('user'), X = ids.newId('user'), LONE = ids.newId('user'), LONE_INTO = ids.newId('user');
const d = db.getDb();
d.prepare(`INSERT INTO users (id, username, password_hash) VALUES (10, 'keep', '$sso$'), (11, 'fold', '$sso$'), (12, 'xena', '$sso$'), (13, 'yuri', '$sso$'), (14, 'lone', '$sso$')`).run();
d.prepare(`INSERT INTO linked_accounts (user_id, service, service_user_id, service_username, subject_id) VALUES
    (10, 'network', '100', 'keep', ?), (11, 'network', '101', 'fold', ?), (12, 'network', '102', 'xena', ?), (14, 'network', '104', 'lone', ?)`).run(KEEP, FOLD, X, LONE);
// Follows: fold follows xena (keep does too: a clash), fold follows yuri, yuri follows fold's channel, fold follows keep (self after merge).
d.prepare('INSERT INTO follows (follower_id, streamer_id) VALUES (11, 12), (10, 12), (11, 13), (13, 11), (11, 10)').run();
// Channel points: fold in xena's channel (keep has some there: summed), yuri in fold's channel, fold in keep's channel.
d.prepare('INSERT INTO channel_points (user_id, streamer_id, balance) VALUES (11, 12, 30), (10, 12, 5), (13, 11, 7), (11, 10, 9)').run();
d.prepare("INSERT INTO streams (user_id, title) VALUES (11, 'old stream'), (11, 'another'), (10, 'mine')").run();

const envelope = (from, into, mergeId = `mrg_${ids.ulid()}`) => {
    const payload = { merge_id: mergeId, from, into, merged_at: new Date().toISOString(), initiated_by: 'person', split_until: new Date(Date.now() + 30 * 86400000).toISOString() };
    assert.ok(validate('network.subject.merged@1', payload).valid);
    return { event_id: ids.newId('event'), event_type: 'network.subject.merged', version: 1, source: 'network', actor: { type: 'user', id: into },
        timestamp: payload.merged_at, visibility: 'internal', subject: { type: 'user', id: into }, payload };
};

(async () => {
    const app = express();
    app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
    app.post('/internal/network-events', networkEvents.handler);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/internal/network-events`;
    const send = async (ev) => { const raw = JSON.stringify({ event: ev, seq: 1 }); return (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...signDeliveryHeaders(raw, process.env.LIVE_EVENTS_SECRET) }, body: raw })).status; };
    try {
        assert.ok(NETWORK_TOPICS.includes('network.subject.merged'), 'the subscription asks for merges');

        const ev = envelope(FOLD, KEEP);
        assert.strictEqual(await send(ev), 204);
        const follows = d.prepare('SELECT follower_id AS a, streamer_id AS b FROM follows ORDER BY a, b').all().map((f) => `${f.a}>${f.b}`);
        assert.deepStrictEqual(follows, ['10>12', '10>13', '13>10'], 'moved; the clash with keep>xena and fold>keep (now self) dropped');
        const points = d.prepare('SELECT user_id AS u, streamer_id AS s, balance FROM channel_points ORDER BY u, s').all().map((p) => `${p.u}@${p.s}=${p.balance}`);
        assert.deepStrictEqual(points, ['10@10=9', '10@12=35', '13@10=7'], 'summed where both had points; the channel side moved too');
        const log = d.prepare("SELECT delta FROM channel_points_log WHERE reason = 'account_merge'").all().map((l) => l.delta);
        assert.strictEqual(log.reduce((n, x) => n + x, 0), 0, 'every move logged out and in');
        assert.strictEqual(log.length, 6);
        assert.deepStrictEqual(d.prepare('SELECT user_id FROM streams ORDER BY id').all().map((s) => s.user_id), [10, 10, 10]);
        assert.strictEqual(d.prepare('SELECT merged_into FROM users WHERE id = 11').get().merged_into, 10);
        const rec = d.prepare('SELECT * FROM subject_merges WHERE merge_id = ?').get(ev.payload.merge_id);
        assert.deepStrictEqual([rec.from_user_id, rec.into_user_id, JSON.parse(rec.outcome).result], [11, 10, 'merged']);

        // A redelivery changes nothing.
        assert.strictEqual(await send(ev), 204);
        assert.strictEqual(await subjectMerge.apply(ev), 'unchanged');
        assert.strictEqual(d.prepare("SELECT COUNT(*) AS n FROM channel_points_log WHERE reason = 'account_merge'").get().n, 6);

        // Only the folded-in account had a Live user: it becomes the survivor's.
        const r = await subjectMerge.apply(envelope(LONE, LONE_INTO), { resolveNetworkId: async (s) => (s === LONE_INTO ? 205 : null) });
        assert.strictEqual(r, 'relinked');
        assert.deepStrictEqual(d.prepare("SELECT subject_id, service_user_id FROM linked_accounts WHERE user_id = 14 AND service = 'network'").get(), { subject_id: LONE_INTO, service_user_id: '205' });

        // Nobody on Live: acknowledged, recorded.
        assert.strictEqual(await subjectMerge.apply(envelope(ids.newId('user'), ids.newId('user'))), 'nothing');
        // Not Network's, or a malformed payload: ignored.
        assert.strictEqual(await networkEvents.apply({ ...envelope(FOLD, KEEP), source: 'media' }), 'ignored:source');
        assert.strictEqual(await subjectMerge.apply({ payload: { merge_id: 'x', from: FOLD, into: KEEP } }), 'ignored:payload');
    } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log('subject merge: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
