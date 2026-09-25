'use strict';
// Live's staff actions reach OpenVibe.Network's moderation audit log (ADR-022, WS-D task 1, Contracts
// 0.46.0): logModerationAction writes live.moderation.action to the outbox in the same transaction as the
// row (valid against the contract, actor = the staff member's subject); tidying one's own messages,
// configuring one's own channel and acting on oneself stay local; with the outbox off the row is still
// written.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-live-modevents-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

const published = [];
const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 300 }));
        if (req.url === '/api/v1/events' && req.method === 'POST') {
            const parsed = JSON.parse(body);
            const list = parsed.events || [parsed];
            const { validate } = require('openvibe-contracts');
            const bad = list.find((e) => !validate('events.event-envelope@1', e).valid);
            if (bad) { res.statusCode = 422; return res.end(JSON.stringify({ code: 'events.invalid_envelope' })); }
            const results = list.map((e) => { published.push(e); return { event_id: e.event_id, seq: published.length, duplicate: false }; });
            return res.end(JSON.stringify(parsed.events ? { results } : results[0]));
        }
        res.statusCode = 404; res.end('{}');
    });
});

(async () => {
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${stub.address().port}`;
    process.env.OV_NETWORK_INTERNAL_URL = base;
    const { validate } = require('openvibe-contracts');
    const db = require('../server/db/database');
    db.initDb();
    const d = db.getDb();
    d.prepare("INSERT INTO users (id, username, display_name, password_hash, role) VALUES (1, 'boss', 'Boss', 'x', 'admin'), (2, 'spammer', 'Spammer', 'x', 'user')").run();
    d.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (1, 'network', '10', 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ'), (2, 'network', '20', 'usr_01JAB2C3D4E5F6G7H8J9K0MNPR')").run();
    const rows = () => d.prepare('SELECT COUNT(*) AS n FROM moderation_actions').get().n;

    // Outbox off: the row is written, nothing is queued.
    db.logModerationAction({ scope_type: 'site', actor_user_id: 1, target_user_id: 2, action_type: 'site_ban', details: { reason: 'spam' } });
    assert.strictEqual(rows(), 1);

    const streamEvents = require('../server/events/stream-events');
    const outbox = streamEvents.init({ eventsUrl: base, clientSecret: 's3cret', intervalMs: 50 });
    const r = db.logModerationAction({ scope_type: 'site', actor_user_id: 1, target_user_id: 2, action_type: 'global_ban', details: { reason: 'spam', ban_type: 'permanent' } });
    db.logModerationAction({ scope_type: 'stream', scope_id: '77', actor_user_id: 1, target_user_id: 2, action_type: 'stream_force_end', details: {} });
    db.logModerationAction({ scope_type: 'stream', scope_id: 5, actor_user_id: 2, target_user_id: 2, action_type: 'self_message_delete_all', details: {} });
    db.logModerationAction({ scope_type: 'channel', scope_id: 5, actor_user_id: 2, target_user_id: null, action_type: 'channel_settings_update', details: {} });
    db.logModerationAction({ scope_type: 'stream', scope_id: 5, actor_user_id: 2, target_user_id: 2, action_type: 'message_delete', details: {} });
    assert.strictEqual(rows(), 6, 'every action is still logged locally');
    await outbox.flush();
    const evs = published.filter((e) => e.event_type === 'live.moderation.action');
    assert.deepStrictEqual(evs.map((e) => e.payload.action_type), ['global_ban', 'stream_force_end'], 'only moderation of someone else');
    for (const e of evs) { const v = validate('live.moderation.action@1', e.payload); assert.ok(v.valid, JSON.stringify(v.errors)); }
    const [ban, end] = evs;
    assert.deepStrictEqual(ban.actor, { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' });
    assert.deepStrictEqual(ban.subject, { type: 'moderation_action', id: String(r.lastInsertRowid) });
    assert.strictEqual(ban.payload.target_subject, 'usr_01JAB2C3D4E5F6G7H8J9K0MNPR');
    assert.deepStrictEqual(ban.payload.details, { reason: 'spam', ban_type: 'permanent' });
    assert.strictEqual(ban.priority, 'important'); assert.strictEqual(ban.visibility, 'internal');
    assert.strictEqual(end.payload.scope_id, 77);

    // The backfill keeps each action's original time.
    d.transaction(() => db.announceModerationAction(1, { scope_type: 'site', actor_user_id: 1, target_user_id: 2, action_type: 'site_ban', details: {} }, { at: '2026-04-13T20:56:38.000Z' }))();
    await outbox.flush();
    assert.strictEqual(published.at(-1).timestamp, '2026-04-13T20:56:38.000Z');

    // A failed insert queues nothing (the event is in its transaction).
    const before = published.length;
    assert.throws(() => db.logModerationAction({ scope_type: 'site', actor_user_id: 1, target_user_id: 2, action_type: null }));
    await outbox.flush();
    assert.strictEqual(published.length, before);

    outbox.stop && outbox.stop();
    stub.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    quiet('moderation events: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
