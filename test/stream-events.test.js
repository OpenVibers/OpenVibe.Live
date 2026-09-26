'use strict';

// Stream lifecycle → OpenVibe.Events (roadmap Wave 3): createStream/endStream enqueue
// live.stream.started / live.stream.ended in the same transaction as the streams row, and the
// relay publishes them with a service token (stub Network + stub Events).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-stream-events-'));
process.env.DB_PATH = path.join(tmp, 'live.db');

const published = [];
const mode = { down: false };
const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/oauth/token') {
            const p = new URLSearchParams(body);
            assert.strictEqual(p.get('grant_type'), 'client_credentials');
            assert.strictEqual(p.get('audience'), 'openvibe.events');
            return res.end(JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 300 }));
        }
        if (req.url === '/api/v1/events' && req.method === 'POST') {
            if (mode.down) { res.statusCode = 503; return res.end('{"code":"events.unavailable"}'); }
            assert.strictEqual(req.headers.authorization, 'Bearer tok');
            const parsed = JSON.parse(body);
            const list = parsed.events || [parsed];
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

    const db = require('../server/db/database');
    db.initDb();
    const d = db.getDb();
    d.prepare("INSERT INTO users (id, username, display_name, password_hash) VALUES (501, 'streamer', 'Streamer', 'x')").run();
    d.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (501, 'network', '77', 'usr_01J0000000000000000000000Z')").run();

    const streamEvents = require('../server/events/stream-events');

    // Disabled without a secret or URL: going live works and nothing is queued.
    assert.strictEqual(streamEvents.init({ eventsUrl: '', clientSecret: '' }), null);
    const plain = db.createStream({ user_id: 501, title: 'no events', protocol: 'rtmp' });
    assert.ok(plain.lastInsertRowid);
    db.endStream(plain.lastInsertRowid);

    const outbox = streamEvents.init({ eventsUrl: base, clientSecret: 's3cret', intervalMs: 50 });
    assert.ok(outbox);

    // Started: queued in the same transaction and published.
    const started = db.createStream({ user_id: 501, title: 'Hello', category: 'irl', protocol: 'webrtc', is_nsfw: 0 });
    const id = Number(started.lastInsertRowid);
    await outbox.flush();
    assert.strictEqual(published.length, 1);
    const ev = published[0];
    assert.strictEqual(ev.event_type, 'live.stream.started');
    assert.strictEqual(ev.source, 'live');
    assert.deepStrictEqual(ev.subject, { type: 'stream', id: String(id), revision: 1 });
    assert.deepStrictEqual(ev.actor, { type: 'user', id: 'usr_01J0000000000000000000000Z' });
    assert.strictEqual(ev.visibility, 'public');
    assert.strictEqual(ev.payload.title, 'Hello');
    assert.strictEqual(ev.payload.channel.username, 'streamer');
    assert.match(ev.payload.started_at, /^\d{4}-\d\d-\d\dT/);
    assert.match(ev.event_id, /^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.strictEqual(ev.payload.channel.url, 'https://openvibe.live/@streamer', 'the channel link is the channel page');
    require('openvibe-contracts').assertValid('live.stream.started@1', ev.payload);

    // Ending a stream that is already ended emits nothing; ending a live one emits ended.
    db.endStream(id);
    db.endStream(id);
    await outbox.flush();
    assert.strictEqual(published.length, 2);
    assert.strictEqual(published[1].event_type, 'live.stream.ended');
    assert.strictEqual(published[1].subject.revision, 2);
    assert.ok('duration_seconds' in published[1].payload);
    require('openvibe-contracts').assertValid('live.stream.ended@1', published[1].payload);
    // Contracts 0.68.0: the stream's totals ride on the ended event (counts only) for creator analytics on Network.
    const st = published[1].payload.stats;
    assert.ok(st && ['peak_viewers', 'avg_viewers', 'unique_chatters', 'messages', 'watch_minutes'].every((k) => typeof st[k] === 'number' && st[k] >= 0), JSON.stringify(st));
    assert.deepStrictEqual(Object.keys(st).sort(), ['avg_viewers', 'messages', 'peak_viewers', 'unique_chatters', 'watch_minutes'], 'no people in it');

    // A rolled-back go-live leaves no event.
    assert.throws(() => d.transaction(() => { db.createStream({ user_id: 501, title: 'rolled back' }); throw new Error('abort'); })());
    assert.strictEqual(outbox.pending(), 0);

    // Events down: the stream still goes live; the event waits and is published once Events is back.
    mode.down = true;
    const later = db.createStream({ user_id: 501, title: 'while down' });
    assert.ok(later.lastInsertRowid);
    await outbox.flush();
    assert.strictEqual(outbox.pending(), 1);
    mode.down = false;
    d.prepare('UPDATE event_outbox SET next_attempt_at = 0').run();
    await outbox.flush();
    assert.strictEqual(outbox.pending(), 0);
    assert.strictEqual(published[2].payload.title, 'while down');

    // A hook failure never blocks going live.
    d.exec('ALTER TABLE event_outbox RENAME TO event_outbox_moved');
    const log = console.warn; console.warn = () => {};
    const safe = db.createStream({ user_id: 501, title: 'hook broken' });
    console.warn = log;
    assert.ok(safe.lastInsertRowid);
    d.exec('ALTER TABLE event_outbox_moved RENAME TO event_outbox');

    assert.strictEqual(streamEvents.status().enabled, true);
    streamEvents._reset();
    stub.close();
    console.log('✅ stream lifecycle events: outbox, relay, retry, rollback');
})().catch((err) => { console.error(err); process.exit(1); });
