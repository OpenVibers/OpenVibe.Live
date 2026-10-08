/**
 * ADR-021 analytics bounds, on Live's own PostgreSQL database (plan T4; server/analytics/store.js runs openvibe-shared's
 * AnalyticsTrackerPg, whose privacy, rollups and retention openvibe-shared's own tests cover in depth):
 *   - paths become route templates; referers origins; user agents classes; countries ISO codes;
 *   - a request through Live's analytics store stores no IP, user id, city, raw user agent, raw referer, query string
 *     or token anywhere in the analytics tables; the session id is a rotating hash, never the user id;
 *   - the store's prune deletes raw rows strictly older than the 30-day window and leaves rollups alone.
 * The SQLite-era scrub CLI is gone: production's analytics rows held no IP, city or user id when they moved.
 *
 *   node test/analytics-privacy.test.js   (with the test preload; `ov test` loads it)
 */
'use strict';
const assert = require('assert');
const express = require('express');
const { privacy } = require('openvibe-shared/analytics');

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); }
    catch (e) { failures++; console.log('  ✗', name, '\n     ', e.stack); }
}

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
const SUBJECT = 'usr_01J8ZQ4K7M2N3P4Q5R6S7T8V9W';
const ANALYTICS_TABLES = ['analytics_events', 'analytics_hourly', 'analytics_daily', 'analytics_visitor_days', 'analytics_day_salts'];

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

    // ── A request through Live's analytics store ─────────────
    const live = require('../server/db/database');
    await live.initDb();
    const db = live.getDb();
    /** Every value in every analytics table, for "is this anywhere" checks. */
    const dumpAll = async () => (await Promise.all(ANALYTICS_TABLES.map(async (t) => JSON.stringify(await db.many(`SELECT * FROM ${t}`))))).join('\n');
    const { createAnalyticsStore } = require('../server/analytics/store');
    const store = createAnalyticsStore({ timers: false });

    await check('a tracked request stores no IP, user id, city, raw UA, raw referer, query or token', async () => {
        await store.ready();
        const app = express();
        app.set('trust proxy', true);
        app.use(store.tracker.middleware());
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
        await store.tracker.flush();

        const rows = await db.many("SELECT * FROM analytics_events WHERE service = 'live' ORDER BY id");
        assert.strictEqual(rows.length, 3);
        for (const r of rows) {
            assert.strictEqual(r.ip, null);
            assert.strictEqual(r.user_id, null);
            assert.strictEqual(r.city, null);
            assert.ok(!/[?#]/.test(r.path), r.path);
            assert.strictEqual(r.referer, 'https://www.google.com');
            assert.ok(/^[0-9a-f]{16}$/.test(r.session_id), r.session_id);
            assert.strictEqual(r.country, 'NL');
        }
        assert.deepStrictEqual(rows.map((r) => r.path), ['/api/things/:thingId', '/@:user/:param', '/vod/:param']);
        assert.deepStrictEqual(rows.map((r) => r.user_agent), ['chrome/windows/desktop', 'chrome/windows/desktop', 'firefox/linux/desktop']);
        assert.deepStrictEqual(rows.map((r) => r.event_type), ['api_call', 'pageview', 'pageview']);
        assert.strictEqual(rows[0].session_id, rows[1].session_id, 'same visitor, same session');
        assert.notStrictEqual(rows[0].session_id, rows[2].session_id);
        await store.tracker.aggregate();
        const everything = await dumpAll();
        for (const needle of ['203.0.113.77', '198.51.100.9', '127.0.0.1', SUBJECT, 'Amsterdam', 'supersecret', 'secret-query', '98765', '424242', 'Mozilla/5.0', '"alex"']) {
            assert.ok(!everything.includes(needle), `found ${needle} in the analytics tables`);
        }
    });

    await check('the store prunes raw rows strictly older than the window and leaves rollups alone', async () => {
        const ins = (path, at) => db.query("INSERT INTO analytics_events (service, event_type, path, method, status_code, created_at) VALUES ('live', 'pageview', $1, 'GET', 200, $2)", [path, at]);
        const sql = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
        const now = Date.now();
        await ins('/old', sql(now - 45 * 86400000));
        await ins('/edge-older', sql(now - 30 * 86400000 - 60000));
        await ins('/fresh', sql(now - 2 * 86400000));
        const rollups = await db.value("SELECT count(*) FROM analytics_hourly WHERE service = 'live'");
        const out = await store.prune();
        assert.strictEqual(out.removed, 2, JSON.stringify(out));
        const left = (await db.many("SELECT path FROM analytics_events WHERE service = 'live' AND path IN ('/old', '/edge-older', '/fresh')")).map((r) => r.path);
        assert.deepStrictEqual(left, ['/fresh']);
        assert.strictEqual(await db.value("SELECT count(*) FROM analytics_hourly WHERE service = 'live'"), rollups, 'rollups untouched');
    });

    await store.close();
    if (failures) { console.log(`\nanalytics privacy: ${failures} check(s) failed`); process.exit(1); }
    console.log('\nanalytics privacy: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
