'use strict';

// The go-live setup hub → OpenVibe.Quest (owner Q16): server/streaming/setup-progress.js records each task the first
// time it reads as done (live_setup_tasks) and queues live.setup.task_completed in the same transaction; a second
// look, or a task undone later, queues nothing; a person Live cannot name on the network gets nothing recorded yet.
// Stub Network (token) + stub Events (publish), as test/stream-events.test.js.

const assert = require('assert');
const http = require('http');

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

const SUBJECT = 'usr_01J8Z3V9Q6N1X2Y3Z4A5B6C7D8';
const task = (id, done) => ({ id, group: 'Look & feel', title: `Task ${id}`, done });

(async () => {
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${stub.address().port}`;
    process.env.OV_NETWORK_INTERNAL_URL = base;

    const db = require('../server/db/database');
    await db.initDb();
    const d = db.getDb();
    await d.prepare("INSERT INTO users (id, username, display_name) OVERRIDING SYSTEM VALUE VALUES (611, 'setupper', 'Setupper'), (612, 'unlinked', 'Unlinked')").run();
    await d.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (611, 'network', '611', ?)").run(SUBJECT);

    const outbox = require('../server/events/stream-events').init({ eventsUrl: base, clientSecret: 's3cret', intervalMs: 50 });
    assert.ok(outbox);
    const setup = require('../server/streaming/setup-progress');

    // Two of three done: both recorded, both queued with the person, the task and the progress.
    const first = [task('slot', true), task('emote', true), task('sound', false)];
    assert.deepStrictEqual(await setup.record(611, first), ['slot', 'emote']);
    await outbox.flush();
    assert.strictEqual(published.length, 2);
    const ev = published.find((e) => e.payload.task === 'emote');
    assert.strictEqual(ev.event_type, 'live.setup.task_completed');
    assert.strictEqual(ev.source, 'live');
    assert.strictEqual(ev.visibility, 'internal');
    assert.deepStrictEqual(ev.subject, { type: 'user', id: SUBJECT });
    assert.deepStrictEqual(ev.actor, { type: 'user', id: SUBJECT });
    assert.deepStrictEqual(ev.payload.user, { type: 'user', id: SUBJECT });
    assert.strictEqual(ev.payload.done, 2);
    assert.strictEqual(ev.payload.total, 3);
    assert.strictEqual(ev.payload.title, 'Task emote');
    assert.match(ev.payload.completed_at, /^\d{4}-\d\d-\d\dT/);
    require('openvibe-contracts').assertValid('live.setup.task_completed@1', ev.payload);

    // The same look again: nothing new. The third task done: only it. An emote deleted later stays recorded.
    assert.deepStrictEqual(await setup.record(611, first), []);
    assert.deepStrictEqual(await setup.record(611, [task('slot', true), task('emote', false), task('sound', true)]), ['sound']);
    await outbox.flush();
    assert.deepStrictEqual(published.map((e) => e.payload.task).sort(), ['emote', 'slot', 'sound']);
    assert.strictEqual((await d.prepare('SELECT COUNT(*) AS n FROM live_setup_tasks WHERE user_id = 611').get()).n, 3);

    // Two looks at once record and queue a task once.
    const both = await Promise.all([setup.record(611, [task('goal', true)]), setup.record(611, [task('goal', true)])]);
    assert.deepStrictEqual(both.flat(), ['goal']);
    await outbox.flush();
    assert.strictEqual(published.filter((e) => e.payload.task === 'goal').length, 1);

    // No network subject yet: nothing recorded, so the next visit after linking still earns the quest.
    assert.deepStrictEqual(await setup.record(612, [task('slot', true)]), []);
    assert.strictEqual((await d.prepare('SELECT COUNT(*) AS n FROM live_setup_tasks WHERE user_id = 612').get()).n, 0);

    // The route records through it.
    const src = require('fs').readFileSync(require('path').join(__dirname, '../server/streaming/routes.js'), 'utf8');
    assert.ok(/require\('\.\/setup-progress'\)\.record\(uid, tasks\)/.test(src), 'GET /setup-progress records the tasks');

    await outbox.stop();
    stub.close();
    console.log('setup-progress-events: ok');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
