'use strict';
// Live's user modules on Network (server/auth/module-summaries.js, Contracts 0.41.0, WS-B task 9):
// live.profile and live.stats computed from streams and follows, written as the owner with Live's
// service token through openvibe-sdk/modules, only when they changed; accounts without a Network
// subject and people with neither streams nor followers are skipped; the scan picks up ended streams
// and new followers; the job is never started under LIVE_DRILL.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-live-modsum-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

const db = require('../server/db/database');
db.initDb();
const sums = require('../server/auth/module-summaries');
sums.ensureSchema();

const ANN = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPA';
const d = db.getDb();
const now = Date.parse('2026-09-25T12:00:00Z');
const at = (msAgo) => new Date(now - msAgo).toISOString().replace('T', ' ').slice(0, 19);
const H = 3600000, DAY = 24 * H;
d.prepare("INSERT INTO users (id, username, email, password_hash) VALUES (1, 'ann', 'a@x', 'x'), (2, 'bob', 'b@x', 'x'), (3, 'cat', 'c@x', 'x')").run();
d.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (1, 'network', '11', ?), (3, 'network', '33', 'usr_01JAB2C3D4E5F6G7H8J9K0MNPC')").run(ANN);
const stream = (user, startedAgo, secs, peak, avg) => {
    const id = d.prepare('INSERT INTO streams (user_id, is_live, peak_viewers, started_at, ended_at, duration_seconds) VALUES (?, 0, ?, ?, ?, ?)')
        .run(user, peak, at(startedAgo), at(startedAgo - secs * 1000), secs).lastInsertRowid;
    if (avg != null) d.prepare('INSERT INTO stream_analytics (stream_id, avg_viewers) VALUES (?, ?)').run(id, avg);
};
stream(1, 2 * DAY, 3600, 12, 8);
stream(1, 5 * DAY, 1800, 30, 11);
stream(1, 45 * DAY, 7200, 99, 50);        // outside the 30-day window
d.prepare('INSERT INTO follows (follower_id, streamer_id, created_at) VALUES (2, 1, ?), (3, 1, ?)').run(at(3 * DAY), at(60 * DAY));

(async () => {
    // ── The summary ──
    const s = sums.summarize(1, { now });
    assert.deepStrictEqual(s.profile, { channel_url: 'https://openvibe.live/@ann', followers: 2, is_streamer: true, last_live_at: new Date(now - 2 * DAY).toISOString(), stream_minutes_30d: 90 });
    assert.deepStrictEqual(s.stats, { streams_30d: 2, stream_minutes_30d: 90, peak_viewers_30d: 30, avg_viewers_30d: 9.5, new_followers_30d: 1 });
    assert.strictEqual(sums.summarize(3, { now }), null, 'no streams and no followers: nothing to say');

    // ── Writes through a stub Network (the real SDK client, Live's service token) ──
    const puts = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            if (req.url === '/oauth/token') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ access_token: 'svc-token', token_type: 'Bearer', expires_in: 300 })); }
            const m = req.url.match(/^\/internal\/modules\/([^/]+)\/([^/]+)$/);
            if (req.method === 'PUT' && m) {
                puts.push({ ns: m[1], subject: m[2], auth: req.headers.authorization, data: JSON.parse(body).data });
                res.statusCode = 201; res.setHeader('content-type', 'application/json');
                return res.end(JSON.stringify({ namespace: m[1], revision: puts.length, data: JSON.parse(body).data }));
            }
            res.statusCode = 404; res.end('{}');
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    process.env.OV_NETWORK_INTERNAL_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.OV_OAUTH_CLIENT_SECRET = 'live-secret';
    delete require.cache[require.resolve('../server/auth/module-summaries')];
    const live = require('../server/auth/module-summaries');

    assert.deepStrictEqual(await live.push(1, { now }), ['live.profile', 'live.stats']);
    assert.deepStrictEqual(puts.map((p) => [p.ns, p.subject, p.auth]), [['live.profile', ANN, 'Bearer svc-token'], ['live.stats', ANN, 'Bearer svc-token']]);
    assert.strictEqual(puts[1].data.computed_at, new Date(now).toISOString());
    const { modules } = require('openvibe-contracts');
    for (const p of puts) assert.ok(modules.validateData(p.ns, p.data).valid, `${p.ns} matches its schema`);
    assert.deepStrictEqual(await live.push(1, { now: now + 60000 }), [], 'unchanged: nothing written');
    assert.deepStrictEqual(await live.push(2, { now }), [], 'no Network subject: skipped');

    // ── The scan: a stream that just ended ──
    d.prepare('INSERT INTO streams (user_id, is_live, peak_viewers, started_at, ended_at, duration_seconds) VALUES (1, 0, 40, ?, ?, 600)').run(at(20 * 60000), at(8 * 60000));
    assert.strictEqual(await live.scan({ now }), 1);
    assert.strictEqual(puts.length, 4, 'both records changed');
    assert.strictEqual(puts[3].data.peak_viewers_30d, 40);
    assert.strictEqual(await live.scan({ now: now + 5 * 60000 }), 0, 'the next scan starts where this one ended');
    assert.strictEqual(await live.refresh({ now: now + DAY }), 1, 'the daily refresh visits everyone with recent streams or followers');

    // ── Never under LIVE_DRILL: index.js starts it inside the non-drill boot, like the other jobs ──
    const idx = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
    assert.ok(/require\('\.\/auth\/module-summaries'\)\.init\(\)/.test(idx), 'index.js starts it');

    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    quiet('module summaries: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
