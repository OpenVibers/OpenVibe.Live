'use strict';
// Live's channels in OpenVibe.Search (WS-O task 10, Contracts 0.44.0): a streamer's channel document goes
// through the outbox as live.index_document.upserted (valid against the contract), again only when it
// changed with the revision up by one; an NSFW channel is noindex; a banned channel gets a tombstone once;
// someone who never streamed is not a channel; the scan finds a stream that just ended.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-live-searchdocs-'));
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
    d.prepare("INSERT INTO users (id, username, display_name, password_hash, bio) VALUES (1, 'alex', 'Alex', 'x', 'Builds things live.'), (2, 'viewer', 'Viewer', 'x', '')").run();
    const streamEvents = require('../server/events/stream-events');
    const outbox = streamEvents.init({ eventsUrl: base, clientSecret: 's3cret', intervalMs: 50 });
    const docs = require('../server/events/search-documents');
    const index = () => published.filter((e) => /^live\.index_document\./.test(e.event_type));

    const s = db.createStream({ user_id: 1, title: 'Building a forum', category: 'tech', protocol: 'webrtc', is_nsfw: 0 });
    db.endStream(s.lastInsertRowid);
    assert.strictEqual(docs.publish(2), 'skipped', 'someone who never streamed is not a channel');
    assert.strictEqual(docs.publish(1), 'sent');
    await outbox.flush();
    let ev = index()[0];
    assert.strictEqual(ev.event_type, 'live.index_document.upserted'); assert.strictEqual(ev.source, 'live');
    assert.deepStrictEqual(ev.subject, { type: 'channel', id: '1', revision: 1 });
    const v = validate('live.index_document.upserted@1', ev.payload);
    assert.ok(v.valid, JSON.stringify(v.errors));
    assert.strictEqual(ev.payload.canonical_url, 'https://openvibe.live/@alex');
    assert.strictEqual(ev.payload.summary, 'Builds things live.');
    assert.ok(ev.payload.body.includes('Building a forum'));
    assert.strictEqual(docs.publish(1), 'unchanged', 'nothing changed: nothing sent');

    d.prepare("INSERT INTO follows (follower_id, streamer_id) VALUES (2, 1)").run();
    assert.strictEqual(docs.publish(1), 'sent');
    await outbox.flush();
    assert.strictEqual(index()[1].payload.revision, 2); assert.strictEqual(index()[1].payload.facets.followers, 1);

    const nsfw = db.createStream({ user_id: 1, title: 'Late night', protocol: 'webrtc', is_nsfw: 1 });
    db.endStream(nsfw.lastInsertRowid);
    assert.ok(docs.scan({ now: Date.now() + 1000 }) >= 1, 'the scan finds the stream that ended');
    await outbox.flush();
    assert.strictEqual(index()[2].payload.indexability.decision, 'noindex');

    d.prepare('UPDATE users SET is_banned = 1 WHERE id = 1').run();
    assert.strictEqual(docs.publish(1), 'tombstone');
    await outbox.flush();
    ev = index()[3];
    assert.strictEqual(ev.event_type, 'live.index_document.deleted');
    assert.ok(validate('live.index_document.deleted@1', ev.payload).valid);
    assert.deepStrictEqual(ev.payload, { type: 'channel', id: '1', revision: 4 });
    assert.strictEqual(docs.publish(1), 'unchanged', 'a tombstone is sent once');

    outbox.stop && outbox.stop();
    stub.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    quiet('search documents: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
