/**
 * One canonical page per paste (roadmap 32.2): with PASTES_ON_COMMUNITY=1, /p/<slug> on Live is a
 * redirect to openvibe.community for every client, crawlers and browsers alike.
 *
 * The handover used to be mounted after the SEO middleware, so an HTML navigation (every crawler)
 * got Live's own rendered copy with a canonical on openvibe.live, and only a non-HTML client got
 * the 301: two self-canonical pages and a different answer for people and machines. Checked here:
 *   - server/index.js mounts server/web/paste-handover.js before server/seo/seo.js;
 *   - /p/<slug> answers 301 to Community whatever the Accept header, and a signed-in visitor goes
 *     through Community's silent sign-in (302);
 *   - Live's sitemap lists no /p/ URL, and the paste links Live renders point at Community.
 *
 *   node test/paste-canonical.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = path.join(os.tmpdir(), `ov-paste-canonical-${process.pid}.db`);
process.env.DB_PATH = tmp;
process.env.NODE_ENV = 'test';
process.env.PASTES_ON_COMMUNITY = '1';
process.env.OV_COMMUNITY_URL = 'https://openvibe.community';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

const db = require('../server/db/database');
db.initDb();

const media = require('../server/media-client');
media.listVods = async () => ({ vods: [] });
media.listClips = async () => ({ clips: [] });
media.request = async () => { throw new media.MediaApiError('stubbed', 0, null); };
const pastesClient = require('../server/pastes-client');
const PASTES = [{ slug: 'abc123', origin: 'user', type: 'paste', title: 'Hello', content: 'hi', visibility: 'public', username: 'bob' }];
let pasteReads = 0;
pastesClient.getPaste = async () => { pasteReads++; return { ...PASTES[0] }; };
pastesClient.listPastes = async (q = {}) => ({ pastes: (Number(q.offset) || 0) ? [] : PASTES.map((p) => ({ ...p })) });

const express = require('express');
const app = express();
require('../server/web/paste-handover').register(app);
const seo = require('../server/seo/seo');
seo.register(app);
app.get('*', (req, res) => res.status(200).type('html').send('<html>shell</html>'));

function get(p, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(base + p, { method: 'GET', headers }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location || null, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

let base;
let failures = 0;
async function check(name, fn) {
    try { await fn(); quiet('  ✓', name); }
    catch (e) { failures++; quiet('  ✗', name, '\n     ', e.message); }
}

const server = http.createServer(app).listen(0, '127.0.0.1', async () => {
    base = `http://127.0.0.1:${server.address().port}`;
    quiet('Paste canonical split');

    await check('server/index.js mounts the paste handover before the SEO middleware', () => {
        const src = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
        const handover = src.indexOf("require('./web/paste-handover').register(app)");
        const seoAt = src.indexOf("require('./seo/seo').register(app)");
        assert.ok(handover > 0, 'the handover is mounted');
        assert.ok(seoAt > 0, 'SEO is mounted');
        assert.ok(handover < seoAt, 'handover first');
        assert.ok(!/app\.get\('\/p\/:slug',/.test(src), 'no second /p/:slug handler in index.js');
    });

    await check('/p/<slug> is a 301 to Community for crawlers, browsers and curl alike', async () => {
        for (const accept of ['text/html,application/xhtml+xml', '*/*', undefined]) {
            const r = await get('/p/abc123', accept ? { accept, 'user-agent': 'Googlebot/2.1' } : {});
            assert.strictEqual(r.status, 301, `Accept ${accept}: ${r.status}`);
            assert.strictEqual(r.location, 'https://openvibe.community/p/abc123');
        }
        assert.strictEqual(pasteReads, 0, 'Live never rendered its own copy');
    });

    await check('a signed-in visitor goes through Community\'s silent sign-in', async () => {
        const r = await get('/p/abc123', { accept: 'text/html', cookie: 'ov_sso_hint=account' });
        assert.strictEqual(r.status, 302);
        assert.strictEqual(r.location, 'https://openvibe.community/auth/login?silent=1&next=%2Fp%2Fabc123');
    });

    await check('Live\'s sitemap lists no paste', async () => {
        const xml = await seo.buildSitemap();
        assert.ok(!/<loc>[^<]*\/p\//.test(xml), 'a /p/ URL in the sitemap');
        assert.ok(xml.includes('/pastes<'), 'the Content feed\'s Pastes filter is still a Live page');
    });

    await check('paste links Live renders point at the canonical Community page', async () => {
        const m = await seo._pageMeta('/pastes');
        assert.ok(m.snapshot.includes('href="https://openvibe.community/p/abc123"'), m.snapshot.slice(0, 400));
        assert.ok(!m.snapshot.includes('https://openvibe.live/p/'), 'no Live paste link');
    });

    server.close();
    try { fs.unlinkSync(tmp); } catch { /* */ }
    for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch { /* */ } }
    quiet(failures ? `\n${failures} check(s) failed` : '\npaste canonical: all checks passed');
    process.exit(failures ? 1 : 0);
});
