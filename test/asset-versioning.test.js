/**
 * Content-hashed asset URLs (server/web/assets.js).
 *
 * Builds a throwaway release layout — base/releases/{old,new}/public — points the module at the new
 * release, and checks the three promises the module makes:
 *   1. documents name each asset by the hash of its current bytes, with no manual counters;
 *   2. only a matching hash is served immutable; a stale or legacy ?v= is no-cache;
 *   3. a hash from the previous release is served from that release, so HTML rendered before a
 *      deploy never runs JS from after it.
 *
 *   node test/asset-versioning.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-assets-'));
const rel = (name) => path.join(base, 'releases', name, 'public');
for (const name of ['old', 'new']) {
    fs.mkdirSync(path.join(rel(name), 'js'), { recursive: true });
    fs.mkdirSync(path.join(rel(name), 'css'), { recursive: true });
}
fs.writeFileSync(path.join(rel('old'), 'js', 'app.js'), 'console.log("old");');
fs.writeFileSync(path.join(rel('new'), 'js', 'app.js'), 'console.log("new");');
fs.writeFileSync(path.join(rel('new'), 'css', 'style.css'), 'body{color:red}');
fs.writeFileSync(path.join(rel('new'), 'index.html'),
    '<link rel="stylesheet" href="/css/style.css?v=216"><script src="/js/app.js" defer></script>' +
    '<script>load(\'/js/app.js?v=9\')</script><img src="/js/missing.js"><!--ov:asset-manifest-->');
// The old release is older on disk, as it would be after a deploy.
const past = new Date(Date.now() - 3600e3);
fs.utimesSync(path.join(base, 'releases', 'old'), past, past);

process.env.OV_PUBLIC_DIR = rel('new');
const assets = require('../server/web/assets');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
const OLD = sha('console.log("old");');
const NEW = sha('console.log("new");');
const CSS = sha('body{color:red}');

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); }
    catch (e) { failures++; console.log('  ✗', name, '\n     ', e.message); }
}

(async () => {
    await check('hashOf is the sha256 prefix of the current bytes', () => {
        assert.strictEqual(assets.hashOf('/js/app.js'), NEW);
        assert.strictEqual(assets.hashOf('/js/nope.js'), null);
    });

    await check('documents replace manual counters with content hashes, and leave unknown files alone', () => {
        const { html } = assets.document('index.html');
        assert.ok(html.includes(`/css/style.css?v=${CSS}"`), html);
        assert.ok(html.includes(`"/js/app.js?v=${NEW}"`), html);
        assert.ok(html.includes(`'/js/app.js?v=${NEW}'`), 'quoted paths inside inline scripts are versioned too');
        assert.ok(html.includes('"/js/missing.js"'));
        assert.ok(!html.includes('v=216') && !html.includes('v=9'));
    });

    await check('the manifest placeholder becomes a JSON block listing every asset', () => {
        const { html } = assets.document('index.html');
        const m = html.match(/<script type="application\/json" id="ov-assets">(.*?)<\/script>/);
        assert.ok(m, 'manifest block present');
        const json = JSON.parse(m[1]);
        assert.strictEqual(json.v['/js/app.js'], NEW);
        assert.strictEqual(json.v['/css/style.css'], CSS);
    });

    await check('a path cannot escape public/', () => {
        assert.throws(() => assets.document('../../etc/passwd'));
        assert.strictEqual(assets.hashOf('/js/../../../../etc/passwd'), null);
    });

    await check('document version changes when a referenced asset changes', async () => {
        const before = assets.document('index.html').version;
        fs.writeFileSync(path.join(rel('new'), 'css', 'style.css'), 'body{color:blue}');
        await new Promise((r) => setTimeout(r, 2100));
        const after = assets.document('index.html');
        assert.notStrictEqual(after.version, before);
        assert.ok(after.html.includes(`/css/style.css?v=${sha('body{color:blue}')}`));
    });

    // A real express app, because the cache policy lives in response headers.
    const express = require('express');
    const app = express();
    app.use('/js', assets.versionedStatic('/js'), express.static(path.join(rel('new'), 'js'), { setHeaders: assets.staticHeaders }));
    const server = http.createServer(app).listen(0);
    await new Promise((r) => server.once('listening', r));
    const get = (p) => new Promise((resolve, reject) => {
        http.get({ port: server.address().port, path: p }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        }).on('error', reject);
    });

    await check('current hash → immutable at the browser and the CDN', async () => {
        const r = await get(`/js/app.js?v=${NEW}`);
        assert.strictEqual(r.body, 'console.log("new");');
        assert.match(r.headers['cache-control'], /immutable/);
        assert.match(r.headers['cdn-cache-control'], /immutable/);
    });

    await check('previous release hash → the previous bytes, immutable', async () => {
        const r = await get(`/js/app.js?v=${OLD}`);
        assert.strictEqual(r.body, 'console.log("old");');
        assert.match(r.headers['cache-control'], /immutable/);
        assert.strictEqual(r.headers['x-ov-asset'], 'previous-release');
    });

    await check('legacy counter or unknown hash → current bytes, never cacheable at the edge', async () => {
        for (const v of ['184', 'deadbeef0000', '']) {
            const r = await get(`/js/app.js${v ? '?v=' + v : ''}`);
            assert.strictEqual(r.body, 'console.log("new");');
            assert.strictEqual(r.headers['cache-control'], 'no-cache');
            assert.strictEqual(r.headers['cdn-cache-control'], 'no-store');
        }
    });

    server.close();
    fs.rmSync(base, { recursive: true, force: true });
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
    console.log('\nasset versioning: all checks passed');
})();
