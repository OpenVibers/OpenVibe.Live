/**
 * ADR-021 analytics bounds (server/analytics/, scripts/analytics-prune.js):
 *   - a tracked request stores no IP, user id, city, raw user agent, raw referer or query string,
 *     anywhere in analytics.db; the session id is a rotating id, never the user id;
 *   - paths become route templates (Express route when matched, normaliser otherwise);
 *   - unique visitors come from the day's salted hashes, which are deleted once the day is rolled up;
 *   - prune deletes strictly-older raw rows in bounded batches and never touches rollups;
 *   - scrub rewrites legacy rows and rollup top lists without changing any rollup counter;
 *   - the CLI's dry run changes nothing, and --apply needs --backup <new file> or --no-backup.
 *
 *   node test/analytics-privacy.test.js
 */
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const { AnalyticsTracker, privacy, retention } = require('../server/analytics');
const { sqlTime } = require('../server/analytics/tracker');
const cli = require('../scripts/analytics-prune');

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); }
    catch (e) { failures++; console.log('  ✗', name, '\n     ', e.stack); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-analytics-'));
const newDb = (name) => { const db = new Database(path.join(tmp, name)); db.pragma('journal_mode = WAL'); return db; };
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
const SUBJECT = 'usr_01J8ZQ4K7M2N3P4Q5R6S7T8V9W';

/** Every text/number value in every table, for "is this anywhere in the file" checks. */
function dumpAll(db) {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").pluck().all();
    return tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all())).join('\n');
}

(async () => {
    // ── Path templating ──────────────────────────────────────
    await check('normalisePath strips queries and replaces ids, slugs and usernames', () => {
        const n = privacy.normalisePath;
        const cases = {
            '/': '/',
            '': '/',
            '/vods': '/vods',
            '/vod/8a7c2f10-1b2c-4d5e-8f90-123456789abc?t=30': '/vod/:param',
            '/api/vods/123/comments?page=2&token=abc': '/api/vods/:id/comments',
            '/@JapaneseOldGuy': '/@:user',
            '/@alex/main-stage?stream=77': '/@:user/:param',
            '/p/k3yF00bar': '/p/:param',
            '/recap/some-words': '/recap/:param',
            '/u/alex/settings': '/u/:param/settings',
            '/api/users/alex': '/api/users/:param',
            '/watch/dQw4w9WgXcQ': '/watch/:param',
            '/files/3f786850e387550fdab836ed7e6dc881de23001b': '/files/:param',
            '/api/things/usr_01J8ZQ4K7M2N3P4Q5R6S7T8V9W': '/api/things/:id',
            '/x/01J8ZQ4K7M2N3P4Q5R6S7T8V9W': '/x/:id',
            '/verify/alex%40example.com': '/verify/:param',
            '/share/alex@example.com/x': '/share/:param/x',
            '/maps/@40.7128,-74.0060,12z': '/maps/@:user',
            '/dashboard/settings': '/dashboard/settings',
            '/wp-login.php': '/wp-login.php',
            '/stream-2024-09-23-highlights': '/:id',
            '/hello world': '/:id',
            'https://openvibe.live/@alex?x=1#y': '/@:user',
            '/one/two/three/four/five/six/seven/eight/nine': '/one/two/three/four/five/six/seven/eight/*',
        };
        for (const [raw, want] of Object.entries(cases)) assert.strictEqual(n(raw), want, `${raw}`);
        // Idempotent over templates, including Express route paths.
        for (const t of ['/api/vods/:id/comments', '/@:user/:param', '/api/analytics/channel/:username', '/p/:id']) {
            assert.strictEqual(n(t), t);
            assert.strictEqual(n(n(t)), n(t));
        }
        // Extra per-service prefixes.
        assert.strictEqual(n('/dishes/tacos', { paramPrefixes: ['dishes'] }), '/dishes/:param');
    });

    await check('referer → origin, user agent → class, country → ISO code', () => {
        assert.strictEqual(privacy.refererOrigin('https://www.google.com/search?q=who+is+alex'), 'https://www.google.com');
        assert.strictEqual(privacy.refererOrigin('http://localhost:3000/@alex'), 'http://localhost:3000');
        assert.strictEqual(privacy.refererOrigin('android-app://com.foo/'), null);
        assert.strictEqual(privacy.refererOrigin('not a url'), null);
        assert.strictEqual(privacy.uaClass(CHROME), 'chrome/windows/desktop');
        assert.strictEqual(privacy.uaClass(FIREFOX), 'firefox/linux/desktop');
        assert.strictEqual(privacy.uaClass('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), 'bot:googlebot');
        assert.strictEqual(privacy.uaClass(''), 'none');
        assert.strictEqual(privacy.uaClass('chrome/windows/desktop'), 'chrome/windows/desktop');
        assert.strictEqual(privacy.uaClass('bot:googlebot'), 'bot:googlebot');
        assert.strictEqual(privacy.countryCode('de'), 'DE');
        assert.strictEqual(privacy.countryCode('Berlin'), null);
    });

    // ── A tracked request ────────────────────────────────────
    await check('a tracked request stores no IP, user id, city, raw UA, raw referer or query', async () => {
        const db = newDb('track.db');
        let clock = Date.parse('2026-09-23T10:15:00Z');
        const tracker = new AnalyticsTracker(db, 'live', { timers: false, now: () => clock });
        const app = express();
        app.set('trust proxy', true);
        app.use(tracker.middleware());
        app.use((req, res, next) => { if (req.headers.authorization) req.user = { id: 42, sub: SUBJECT, username: 'alex' }; next(); });
        const router = express.Router();
        router.get('/things/:thingId', (req, res) => res.json({ ok: true }));
        app.use('/api', router);
        app.get('*', (req, res) => res.send('<html></html>'));
        const server = app.listen(0, '127.0.0.1');
        await new Promise((r) => server.once('listening', r));
        const base = `http://127.0.0.1:${server.address().port}`;
        const hdr = (extra) => ({ 'user-agent': CHROME, 'x-forwarded-for': '203.0.113.77', referer: 'https://www.google.com/search?q=secret-query', 'cf-ipcountry': 'NL', 'cf-ipcity': 'Amsterdam', ...extra });
        try {
            await (await fetch(`${base}/api/things/98765?token=supersecret`, { headers: hdr({ authorization: 'Bearer x' }) })).text();
            await (await fetch(`${base}/@alex/main?stream=12`, { headers: hdr() })).text();
            await (await fetch(`${base}/vod/424242`, { headers: hdr({ 'user-agent': FIREFOX, 'x-forwarded-for': '198.51.100.9' }) })).text();
            await new Promise((r) => setTimeout(r, 50));
        } finally { server.close(); }
        tracker.flush();

        const rows = db.prepare('SELECT * FROM analytics_events ORDER BY id').all();
        assert.strictEqual(rows.length, 3);
        for (const r of rows) {
            assert.strictEqual(r.ip, null);
            assert.strictEqual(r.user_id, null);
            assert.strictEqual(r.city, null);
            assert.ok(!/[?#]/.test(r.path), r.path);
            assert.ok(r.referer === 'https://www.google.com', r.referer);
            assert.ok(/^[0-9a-f]{16}$/.test(r.session_id), r.session_id);
            assert.notStrictEqual(r.session_id, '42');
            assert.strictEqual(r.country, 'NL');
        }
        assert.deepStrictEqual(rows.map((r) => r.path), ['/api/things/:thingId', '/@:user/:param', '/vod/:param']);
        assert.deepStrictEqual(rows.map((r) => r.user_agent), ['chrome/windows/desktop', 'chrome/windows/desktop', 'firefox/linux/desktop']);
        assert.deepStrictEqual(rows.map((r) => r.authenticated), [1, 0, 0]);
        assert.deepStrictEqual(rows.map((r) => r.event_type), ['api_call', 'pageview', 'pageview']);
        assert.strictEqual(rows[0].session_id, rows[1].session_id, 'same visitor, same session');
        assert.notStrictEqual(rows[0].session_id, rows[2].session_id);

        const everything = dumpAll(db);
        for (const needle of ['203.0.113.77', '198.51.100.9', '127.0.0.1', SUBJECT, 'Amsterdam', 'supersecret', 'secret-query', '98765', '424242', 'Mozilla/5.0', '"alex"']) {
            assert.ok(!everything.includes(needle), `found ${needle} in analytics.db`);
        }
        assert.strictEqual(db.prepare('SELECT COUNT(*) FROM analytics_rate_tracking').pluck().get(), 0);
        assert.ok(!db.prepare("SELECT name FROM sqlite_master WHERE name IN ('idx_analytics_events_ip', 'idx_analytics_events_user')").get());

        // Rollups: two distinct (ip, ua) visitors, one of them signed in.
        tracker.aggregate();
        const hourly = db.prepare("SELECT * FROM analytics_hourly WHERE hour = '2026-09-23 10:00:00'").get();
        assert.strictEqual(hourly.pageviews, 2);
        assert.strictEqual(hourly.api_calls, 1);
        assert.strictEqual(hourly.unique_visitors, 2);
        assert.strictEqual(hourly.unique_users, 1);
        const daily = db.prepare("SELECT * FROM analytics_daily WHERE date = '2026-09-23'").get();
        assert.strictEqual(daily.unique_visitors, 2);
        assert.strictEqual(daily.unique_users, 1);
        assert.strictEqual(daily.new_users, null);
        assert.ok(JSON.parse(daily.top_paths).every((p) => !/\d{3,}/.test(p.path)));
        assert.strictEqual(db.prepare('SELECT COUNT(*) FROM analytics_visitor_days').pluck().get(), 2);
        assert.strictEqual(db.prepare('SELECT COUNT(*) FROM analytics_day_salts').pluck().get(), 1);

        // Next day: the finished day is rolled up for the last time, then its hashes and salt go.
        clock = Date.parse('2026-09-24T00:20:00Z');
        tracker.aggregate();
        assert.strictEqual(db.prepare('SELECT COUNT(*) FROM analytics_visitor_days').pluck().get(), 0);
        assert.strictEqual(db.prepare('SELECT COUNT(*) FROM analytics_day_salts').pluck().get(), 0);
        const dailyAfter = db.prepare("SELECT * FROM analytics_daily WHERE date = '2026-09-23'").get();
        assert.strictEqual(dailyAfter.unique_visitors, 2, 'uniques survive the hashes');
        // A recompute of that day (e.g. the next hourly run) never lowers the stored uniques.
        clock = Date.parse('2026-09-24T01:20:00Z');
        tracker.aggregate();
        assert.strictEqual(db.prepare("SELECT unique_visitors FROM analytics_daily WHERE date = '2026-09-23'").pluck().get(), 2);

        // The same visitor gets a new session id (and hash) on a new day.
        tracker.record({ headers: { 'user-agent': CHROME }, ip: '203.0.113.77', method: 'GET' }, { statusCode: 200 }, '/', 3);
        tracker.flush();
        const last = db.prepare('SELECT session_id FROM analytics_events ORDER BY id DESC LIMIT 1').pluck().get();
        assert.notStrictEqual(last, rows[0].session_id);

        // Dashboards still answer, with the same shapes.
        const st = tracker.getStats({ days: 30 });
        for (const k of ['summary', 'realtime', 'daily', 'hourly', 'topPages', 'authBreakdown', 'visitorTypes', 'authTrend']) assert.ok(k in st, k);
        assert.ok(tracker.getStats({ hours: 6 }).timeBuckets);
        const bots = tracker.getBotAnalysis(30);
        for (const k of ['topBotIPs', 'botTrend', 'botTypes', 'suspiciousIPs']) assert.ok(Array.isArray(bots[k]), k);
        assert.ok(tracker.getOverview(30).services.length >= 1);
        tracker.destroy();
        db.close();
    });

    await check('rate check keeps IPs in memory only and still flags floods', () => {
        const db = newDb('rate.db');
        const clock = Date.parse('2026-09-23T12:00:30Z');
        const tracker = new AnalyticsTracker(db, 'live', { timers: false, now: () => clock });
        for (let i = 0; i < 70; i++) tracker.record({ headers: { 'user-agent': CHROME }, ip: '192.0.2.1', method: 'GET' }, { statusCode: 200 }, '/api/x', 1);
        tracker.flush();
        assert.ok(db.prepare("SELECT COUNT(*) FROM analytics_events WHERE bot_type = 'rate_limit'").pluck().get() >= 10);
        assert.strictEqual(db.prepare('SELECT COUNT(*) FROM analytics_rate_tracking').pluck().get(), 0);
        assert.ok(!dumpAll(db).includes('192.0.2.1'));
        tracker.trackEvent('custom', { ip: '192.0.2.2', user_id: 7, city: 'Paris', path: '/@bob?x=1', referer: 'https://a.example/x?y=1', user_agent: CHROME, session_id: 'user-7' });
        tracker.flush();
        const e = db.prepare("SELECT * FROM analytics_events WHERE event_type = 'custom'").get();
        assert.strictEqual(e.path, '/@:user');
        assert.strictEqual(e.referer, 'https://a.example');
        assert.strictEqual(e.session_id, null);
        assert.strictEqual(e.user_agent, 'chrome/windows/desktop');
        assert.ok(!dumpAll(db).includes('Paris') && !dumpAll(db).includes('192.0.2.2'));
        tracker.destroy();
        db.close();
    });

    // ── Retention ────────────────────────────────────────────
    function seedLegacy(db, nowMs) {
        new AnalyticsTracker(db, 'live', { timers: false }).destroy(); // schema
        const ins = db.prepare(`INSERT INTO analytics_events (service, event_type, path, method, status_code, response_time_ms, user_id, session_id, ip, city, user_agent, referer, is_bot, created_at)
            VALUES ('live', 'pageview', ?, 'GET', 200, 5, ?, ?, ?, ?, ?, ?, 0, ?)`);
        const at = (days, s = 0) => sqlTime(nowMs - days * 86400000 + s * 1000);
        const cutoffMs = nowMs - 30 * 86400000;
        const rows = [];
        for (let i = 0; i < 10; i++) rows.push(['/@old' + i, 5, 'eyJhbGciOi.tokentail' + i, '198.51.100.' + i, 'Lyon', CHROME, 'https://t.co/abc?x=1', at(45 + i)]);
        rows.push(['/@edge-older', 5, null, '198.51.100.50', null, CHROME, '', sqlTime(cutoffMs - 1000)]);
        rows.push(['/@edge-exact', 5, null, '198.51.100.51', null, CHROME, '', sqlTime(cutoffMs)]);
        rows.push(['/@edge-newer', null, null, '198.51.100.52', null, FIREFOX, '', sqlTime(cutoffMs + 1000)]);
        rows.push(['/vod/12345?t=9', 9, 'abcdef0123456789', '198.51.100.53', 'Oslo', FIREFOX, 'https://www.reddit.com/r/x/comments/1', at(2)]);
        for (const r of rows) ins.run(...r);
        const hr = db.prepare('INSERT INTO analytics_hourly (service, hour, pageviews, api_calls, unique_visitors, unique_users, top_paths, top_referers) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        const dy = db.prepare('INSERT INTO analytics_daily (service, date, pageviews, api_calls, unique_visitors, unique_users, new_users, top_paths, top_referers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
        const tops = JSON.stringify([{ path: '/@alex', cnt: 3 }, { path: '/@bob', cnt: 2 }, { path: '/vods', cnt: 1 }]);
        const refs = JSON.stringify([{ referer: 'https://www.google.com/search?q=alex', cnt: 4 }, { referer: 'https://www.google.com/', cnt: 1 }]);
        hr.run('live', at(60).slice(0, 13) + ':00:00', 10, 4, 3, 1, tops, refs);
        dy.run('live', at(60).slice(0, 10), 100, 40, 30, 10, 2, tops, refs);
        dy.run('live', at(2).slice(0, 10), 50, 20, 15, 5, 1, tops, refs);
        db.prepare("INSERT INTO analytics_rate_tracking (ip, window_start, hit_count) VALUES ('198.51.100.99', 1, 1)").run();
    }

    await check('prune: strictly older than the cutoff, bounded batches, rollups untouched', async () => {
        const db = newDb('prune.db');
        const nowMs = Date.parse('2026-09-23T12:00:00Z');
        seedLegacy(db, nowMs);
        const totals = retention.rollupTotals(db);
        const bounded = await retention.pruneRawEvents(db, { days: 30, batchSize: 3, maxBatches: 2, now: () => nowMs });
        assert.strictEqual(bounded.deleted, 6);
        assert.strictEqual(bounded.complete, false);
        const out = await retention.pruneRawEvents(db, { days: 30, batchSize: 3, now: () => nowMs });
        assert.strictEqual(out.deleted, 5);
        assert.strictEqual(out.cutoff, '2026-08-24 12:00:00');
        const left = db.prepare('SELECT path FROM analytics_events ORDER BY created_at').pluck().all();
        assert.deepStrictEqual(left, ['/@edge-exact', '/@edge-newer', '/vod/12345?t=9']);
        assert.deepStrictEqual(retention.rollupTotals(db), totals);
        assert.strictEqual(db.prepare('SELECT COUNT(*) FROM analytics_daily').pluck().get(), 2, 'old rollups stay');
        assert.strictEqual(db.prepare('SELECT COUNT(*) FROM analytics_rate_tracking').pluck().get(), 0);
        assert.strictEqual((await retention.pruneRawEvents(db, { days: 30, now: () => nowMs })).deleted, 0);
        assert.throws(() => retention.cutoffFor(31), /1 to 30/);
        assert.throws(() => retention.cutoffFor(0), /1 to 30/);
        db.close();
    });

    await check('scrub: legacy rows and rollup top lists reduced, counters unchanged', async () => {
        const db = newDb('scrub.db');
        const nowMs = Date.parse('2026-09-23T12:00:00Z');
        seedLegacy(db, nowMs);
        await retention.pruneRawEvents(db, { days: 30, now: () => nowMs });
        const totals = retention.rollupTotals(db);
        const s = await retention.scrubEvents(db, { batchSize: 2 });
        assert.strictEqual(s.rows, 3);
        const r = retention.scrubRollups(db);
        assert.deepStrictEqual(r, { hourly: 1, daily: 2 });
        assert.deepStrictEqual(retention.rollupTotals(db), totals);
        const rows = db.prepare('SELECT * FROM analytics_events ORDER BY created_at').all();
        assert.deepStrictEqual(rows.map((x) => x.path), ['/@:user', '/@:user', '/vod/:param']);
        assert.deepStrictEqual(rows.map((x) => x.authenticated), [1, 0, 1]);
        assert.deepStrictEqual(rows.map((x) => x.session_id), [null, null, 'abcdef0123456789']);
        assert.deepStrictEqual(rows.map((x) => x.referer), ['', '', 'https://www.reddit.com']);
        assert.deepStrictEqual(rows.map((x) => x.user_agent), ['chrome/windows/desktop', 'firefox/linux/desktop', 'firefox/linux/desktop']);
        for (const x of rows) assert.ok(x.ip === null && x.user_id === null && x.city === null);
        const daily = db.prepare('SELECT top_paths, top_referers FROM analytics_daily ORDER BY date LIMIT 1').get();
        assert.deepStrictEqual(JSON.parse(daily.top_paths), [{ path: '/@:user', cnt: 5 }, { path: '/vods', cnt: 1 }]);
        assert.deepStrictEqual(JSON.parse(daily.top_referers), [{ referer: 'https://www.google.com', cnt: 5 }]);
        const all = dumpAll(db);
        for (const needle of ['198.51.100.', 'Lyon', 'Oslo', 'eyJhbGciOi', 'q=alex', '@alex', '/vod/12345', 'Mozilla/5.0']) assert.ok(!all.includes(needle), needle);
        // Idempotent.
        await retention.scrubEvents(db);
        assert.deepStrictEqual(retention.scrubRollups(db), { hourly: 0, daily: 0 });
        assert.deepStrictEqual(retention.rollupTotals(db), totals);
        db.close();
    });

    // ── CLI ──────────────────────────────────────────────────
    const quiet = [];
    const log = (l) => quiet.push(l);
    const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

    function cliDb(name) {
        const file = path.join(tmp, name);
        const db = new Database(file);
        db.pragma('journal_mode = WAL');
        seedLegacy(db, Date.now() + 120000); // edge rows 2 min clear of the CLI's own cutoff: 10 older rows
        db.pragma('wal_checkpoint(TRUNCATE)');
        db.close();
        return file;
    }
    function snapshot(file) {
        const db = new Database(file, { readonly: true });
        try { return dumpAll(db); } finally { db.close(); }
    }

    await check('CLI dry run (with and without --scrub) changes nothing', async () => {
        const file = cliDb('cli-dry.db');
        const before = { hash: sha(file), dump: snapshot(file) };
        assert.strictEqual(await cli.main(['--db', file], log), 0);
        assert.strictEqual(await cli.main(['--db', file, '--scrub', '--days', '7'], log), 0);
        assert.strictEqual(sha(file), before.hash);
        assert.strictEqual(snapshot(file), before.dump);
        assert.ok(quiet.some((l) => /dry run: nothing changed/.test(l)));
        assert.ok(quiet.some((l) => /prune\s+10 rows/.test(l)), quiet.join('\n'));
    });

    await check('CLI --apply refuses without a backup choice, an existing target, or days > 30', async () => {
        const file = cliDb('cli-refuse.db');
        const before = snapshot(file);
        assert.strictEqual(await cli.main(['--db', file, '--apply'], log), 2);
        const existing = path.join(tmp, 'exists.bak');
        fs.writeFileSync(existing, 'x');
        assert.strictEqual(await cli.main(['--db', file, '--apply', '--backup', existing], log), 2);
        assert.strictEqual(await cli.main(['--db', file, '--apply', '--no-backup', '--days', '31'], log), 2);
        assert.strictEqual(await cli.main(['--db', file, '--apply', '--no-backup', '--backup', existing], log), 2);
        assert.strictEqual(snapshot(file), before);
        assert.strictEqual(fs.readFileSync(existing, 'utf8'), 'x');
    });

    await check('CLI --apply --scrub --backup: verified backup first, then prune + scrub, rollups equal', async () => {
        const file = cliDb('cli-apply.db');
        const src = new Database(file, { readonly: true });
        const totals = retention.rollupTotals(src);
        const rowsBefore = src.prepare('SELECT COUNT(*) FROM analytics_events').pluck().get();
        src.close();
        const bak = path.join(tmp, 'cli-apply.backup.db');
        assert.strictEqual(await cli.main(['--db', file, '--apply', '--scrub', '--backup', bak, '--batch', '4'], log), 0);
        const b = new Database(bak, { readonly: true });
        assert.strictEqual(b.prepare('SELECT COUNT(*) FROM analytics_events').pluck().get(), rowsBefore, 'backup has every row');
        b.close();
        const db = new Database(file, { readonly: true });
        assert.strictEqual(db.prepare('SELECT COUNT(*) FROM analytics_events').pluck().get(), 4);
        assert.strictEqual(db.prepare('SELECT COUNT(*) FROM analytics_events WHERE ip IS NOT NULL OR user_id IS NOT NULL OR city IS NOT NULL').pluck().get(), 0);
        assert.strictEqual(db.prepare("SELECT COUNT(*) FROM analytics_events WHERE path LIKE '%?%'").pluck().get(), 0);
        assert.deepStrictEqual(retention.rollupTotals(db), totals);
        db.close();
        // Prune-only with an explicit --no-backup works too (nothing left to prune).
        assert.strictEqual(await cli.main(['--db', file, '--apply', '--no-backup', '--no-vacuum'], log), 0);
    });

    fs.rmSync(tmp, { recursive: true, force: true });
    if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
    console.log('\nanalytics privacy: all passed');
})();
