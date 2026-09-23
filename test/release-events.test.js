'use strict';

// Deploys as events (roadmap Wave 3 exit): the deploy notice queues live.release.deployed in the
// same transaction that records the commits as announced (and stores the chat row), publishes it
// through Live's outbox, keeps the chat notice working (local row, or the Chat bridge), says
// nothing on a restart without new code, and rolls the notice back if the event cannot be queued.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-release-events-'));
process.env.DB_PATH = path.join(tmp, 'live.db');

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

    const contracts = require('openvibe-contracts');
    const db = require('../server/db/database');
    db.initDb();
    const raw = db.getDb();
    const dn = require('../server/chat/deploy-notice');
    const releaseEvents = require('../server/events/release-events');
    const streamEvents = require('../server/events/stream-events');
    const quiet = { log() {}, warn() {} };
    const outboxRows = () => raw.prepare('SELECT event_id, envelope FROM event_outbox ORDER BY id').all().map(r => JSON.parse(r.envelope)).filter(e => e.event_type === releaseEvents.EVENT_TYPE);
    const deployRows = () => raw.prepare("SELECT id, metadata FROM chat_messages WHERE message_type = 'system' AND metadata LIKE '%\"kind\":\"deploy\"%'").all();

    // The envelope is a valid event-envelope@1.
    const head = (await new Promise(r => require('child_process').execFile('git', ['rev-parse', 'HEAD'], { cwd: path.join(__dirname, '..') }, (e, o) => r(String(o).trim()))));
    assert.match(head, /^[0-9a-f]{40}$/);
    const sample = releaseEvents.envelopeFor({ head, previous: null, commits: [{ hash: head, short: head.slice(0, 7), subject: 'x', date: '2026-09-23T00:00:00Z' }] });
    const full = { ...sample, event_id: 'evt_01JAB2C3D4E5F6G7H8J9K0MNPQ', version: 1, source: 'live', timestamp: new Date().toISOString() };
    contracts.assertValid('events.event-envelope@1', full);
    contracts.assertValid('live.release.deployed@1', full.payload);
    assert.strictEqual(sample.payload.release, head.slice(0, 7));
    assert.throws(() => releaseEvents.envelopeFor({ head: 'nope' }), /full commit sha/);

    // Events off: the notice works exactly as before and nothing is queued.
    let r = await dn.announce({ db, chatServer: { remote: false, clients: new Map() }, log: quiet });
    assert.ok(r.announced >= 1);
    assert.strictEqual(r.event_id, null);
    assert.strictEqual(db.getSetting(dn.SETTING), head);
    assert.strictEqual(deployRows().length, 1);

    // Events on: a new deploy (the setting points elsewhere) queues and publishes the event.
    const outbox = streamEvents.init({ eventsUrl: base, clientSecret: 's3cret', intervalMs: 50 });
    assert.ok(outbox);
    db.setSetting(dn.SETTING, '');
    r = await dn.announce({ db, chatServer: { remote: false, clients: new Map() }, log: quiet });
    assert.ok(r.announced >= 1);
    assert.match(r.event_id, /^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
    let rows = outboxRows();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].event_id, r.event_id);
    assert.deepStrictEqual(rows[0].subject, { type: 'release', id: head });
    assert.strictEqual(rows[0].payload.commit, head);
    assert.strictEqual(rows[0].payload.service, 'live');
    assert.ok(rows[0].payload.commits.length >= 1 && rows[0].payload.commits[0].hash === head);
    contracts.assertValid('events.event-envelope@1', rows[0]);
    await outbox.flush();
    const sent = published.find(e => e.event_id === r.event_id);
    assert.ok(sent, 'published to Events');
    assert.strictEqual(sent.source, 'live');
    assert.strictEqual(sent.event_type, 'live.release.deployed');

    // A restart with no new code: no notice, no event.
    r = await dn.announce({ db, chatServer: { remote: false, clients: new Map() }, log: quiet });
    assert.strictEqual(r.announced, 0);
    assert.strictEqual(outboxRows().length, 1);

    // The event cannot be queued: nothing is recorded (no chat row, setting unchanged), so the next
    // boot announces again — never a notice without its event.
    db.setSetting(dn.SETTING, '');
    const chatBefore = deployRows().map(x => x.metadata).join('|');
    raw.exec("CREATE TEMP TRIGGER outbox_boom BEFORE INSERT ON event_outbox BEGIN SELECT RAISE(ABORT, 'outbox insert failed'); END");
    r = await dn.announce({ db, chatServer: { remote: false, clients: new Map() }, log: quiet });
    raw.exec('DROP TRIGGER temp.outbox_boom');
    assert.strictEqual(r.announced, 0);
    assert.strictEqual(db.getSetting(dn.SETTING), '');
    assert.strictEqual(deployRows().map(x => x.metadata).join('|'), chatBefore, 'the chat row rolled back too');
    assert.strictEqual(outboxRows().length, 1);

    // CHAT_AUTHORITY=chat: the chat notice still goes over the bridge, and the event is queued.
    const bridged = [];
    r = await dn.announce({ db, chatServer: { remote: true, deployNotice: (commits) => bridged.push(commits) }, log: quiet });
    assert.ok(r.announced >= 1);
    assert.strictEqual(bridged.length, 1);
    assert.strictEqual(bridged[0][0].hash, head);
    assert.strictEqual(db.getSetting(dn.SETTING), head);
    rows = outboxRows();
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[1].event_id, r.event_id);

    streamEvents._reset();
    stub.close();
    console.log('release events: live.release.deployed queued with the announcement, published, chat notice kept — all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
