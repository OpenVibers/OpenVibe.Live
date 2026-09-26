'use strict';
// GOLIVE_NOTIFY=events (compatibility register C-85): with Live's events outbox on, a go-live makes no call to
// Network (no POST /internal/events/stream-live, no fallback push) and leaves the followers to Network's
// live.stream.started consumer; the event itself is still queued with the streams row. Unset, or with the
// outbox off, the direct call stays.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-golive-mode-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.INTERNAL_API_KEY = 'test-internal-key';
process.env.OV_NETWORK_INTERNAL_URL = 'http://127.0.0.1:9';

const calls = [];
global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    return new Response(JSON.stringify({ ok: true, notifications: { sent: 0, total: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const logs = [];
const log = console.log;
console.log = (...a) => { logs.push(a.join(' ')); };

(async () => {
    try {
        const db = require('../server/db/database');
        db.initDb();
        db.getDb().prepare("INSERT INTO users (id, username, display_name, password_hash) VALUES (601, 'caster', 'Caster', 'x')").run();
        const streamEvents = require('../server/events/stream-events');
        const { notifyFollowersGoLive, leftToEvents } = require('../server/streaming/golive-notify');
        const settle = () => new Promise((r) => setTimeout(r, 50));
        const toNetwork = () => calls.filter((c) => c.url.startsWith('http://127.0.0.1:9/')).length;

        // Default: the direct call, as before.
        delete process.env.GOLIVE_NOTIFY;
        assert.strictEqual(leftToEvents(), false);
        notifyFollowersGoLive({ id: 601, username: 'caster' }, { id: 1, title: 'one' });
        await settle();
        assert.ok(toNetwork() >= 1, 'unset: Live calls Network directly');

        // GOLIVE_NOTIFY=events while the outbox is off: still the direct call (nothing else would tell anyone).
        process.env.GOLIVE_NOTIFY = 'events';
        assert.strictEqual(streamEvents.status().enabled, false);
        assert.strictEqual(leftToEvents(), false);

        // With the outbox on: no call at all, and the log says who announces.
        streamEvents.init({ eventsUrl: 'http://127.0.0.1:9', clientSecret: 's3cret', intervalMs: 60000 });
        assert.strictEqual(leftToEvents(), true);
        const before = calls.length;
        notifyFollowersGoLive({ id: 601, username: 'caster' }, { id: 2, title: 'two' }, { force: true });
        await settle();
        assert.deepStrictEqual(calls.slice(before).filter((c) => /\/internal\//.test(c.url)), [], 'no direct call, no fallback push');
        assert.ok(logs.some((l) => l.includes("caster: left to Network's live.stream.started consumer (GOLIVE_NOTIFY=events)")));
        // The event path is intact: a new stream row still queues live.stream.started.
        db.createStream({ user_id: 601, title: 'three', protocol: 'rtmp' });
        assert.strictEqual(db.getDb().prepare("SELECT COUNT(*) AS c FROM event_outbox WHERE envelope LIKE '%live.stream.started%'").get().c, 1);

        // Any other value keeps both paths.
        process.env.GOLIVE_NOTIFY = 'both';
        assert.strictEqual(leftToEvents(), false);
        streamEvents._reset();
    } finally {
        console.log = log;
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log('golive notify mode: all checks passed');
    process.exit(0);
})().catch((err) => { console.log = log; console.error(err); process.exit(1); });
