/**
 * Server-rendered channel, VOD and clip pages (server/seo/seo.js, roadmap 32.1/32.2): each has its
 * own title, description, canonical, Open Graph and JSON-LD, and a real HTML body that crawlers and
 * readers without JavaScript can use, whatever Accept header the client sends.
 *
 * It used to render only when Accept named text/html, so a crawler or tool sending *\/* got the home
 * page's title and canonical for /@finditfixit. Checked here, with the SEO middleware and the real
 * SPA fallback mounted as server/index.js mounts them (Media stubbed in-process, temp database):
 *   - /@user (a channel row or just an account), /vod/:id and /clip/:id answer the same page for
 *     every Accept header and user agent, with their own head and body;
 *   - a channel's videos page with ?page=N links (rel prev/next), each page self-canonical, and a
 *     page past the end noindex with the canonical on page 1;
 *   - a VOD lists its clips, people's then the AI's, and carries them as schema.org Clip parts;
 *   - a 404 is noindex with no canonical and no home metadata; no other shell page claims the home
 *     page as its canonical;
 *   - without JavaScript the body is shown (and the empty app shell hidden); with it, the route
 *     still boots its feature scripts and the client hydrates as before.
 *
 *   node test/seo-ssr.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = path.join(os.tmpdir(), `ov-seo-ssr-${process.pid}.db`);
process.env.DB_PATH = tmp;
process.env.NODE_ENV = 'test';
delete process.env.PASTES_ON_COMMUNITY;
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};
console.error = () => {};

const db = require('../server/db/database');
db.initDb();
const raw = db.getDb();
const auth = require('../server/auth/auth');
auth.optionalAuth = (req, res, next) => next();

const addUser = (id, username, display, extra = '') => raw.prepare(
    `INSERT INTO users (id, username, display_name, email, password_hash, role, bio, created_at)
     VALUES (?, ?, ?, ?, 'x', 'streamer', ?, '2025-01-01 00:00:00')`).run(id, username, display, `${username}@x`, extra);
addUser(3, 'alice', 'Alice', 'I stream woodworking.');
addUser(4, 'bob', 'Bob');
addUser(5, 'finditfixit', 'finditfixit', 'likes vintage video games');   // an account with no channel row
db.ensureChannel(3);

// ── OpenVibe.Media stand-in ──
const media = require('../server/media-client');
const missing = () => new media.MediaApiError('not found', 404, { error: 'not found' });
let slow = 0;
const day = (n) => new Date(Date.UTC(2026, 8, 1 + n)).toISOString().replace('T', ' ').slice(0, 19);
// Alice has 30 public VODs (100–129, newest first) and one private one.
const VODS = [];
for (let i = 0; i < 30; i++) VODS.push({ id: 100 + i, user_id: 3, title: `Build night ${100 + i}`, visibility: 'public', is_public: true, status: 'ready', duration_seconds: 3600 + i, created_at: day(30 - i) });
VODS.push({ id: 199, user_id: 3, title: 'SECRET VOD', visibility: 'private', is_public: false, status: 'ready', duration_seconds: 60, created_at: day(40) });
const CLIPS = [
    { id: 200, user_id: 4, channel_user_id: 3, vod_id: 100, title: 'Bob clipped the saw', visibility: 'public', is_public: true, status: 'ready', auto_generated: false, start_time: 61.2, end_time: 81.2, duration_seconds: 20 },
    { id: 201, user_id: 3, channel_user_id: 3, vod_id: 100, title: 'Chat lost it', visibility: 'public', is_public: true, status: 'ready', auto_generated: true, start_time: 125, end_time: 150, duration_seconds: 25 },
];
const listed = (rows, q) => {
    const off = Number(q.offset) || 0, lim = Number(q.limit) || 50;
    return rows.slice(off, off + lim);
};
media.listVods = async (q = {}) => {
    if (slow) await new Promise((r) => setTimeout(r, slow));
    const rows = VODS.filter((v) => v.is_public && (q.user_id == null || String(v.user_id) === String(q.user_id)));
    return { vods: listed(rows, q).map((v) => ({ ...v })), total: rows.length };
};
media.listClips = async (q = {}) => {
    if (slow) await new Promise((r) => setTimeout(r, slow));
    const rows = CLIPS.filter((c) => c.is_public
        && (q.channel_user_id == null || String(c.channel_user_id) === String(q.channel_user_id))
        && (q.vod_id == null || String(c.vod_id) === String(q.vod_id))
        && (q.auto_generated == null || Number(c.auto_generated) === Number(q.auto_generated)));
    return { clips: listed(rows, q).map((c) => ({ ...c })), total: rows.length };
};
media.getVod = async (id) => { const v = VODS.find((x) => x.id === Number(id)); if (!v) throw missing(); return { ...v }; };
media.getClip = async (id) => { const c = CLIPS.find((x) => x.id === Number(id)); if (!c) throw missing(); return { ...c }; };
media.request = async () => { throw new media.MediaApiError('stubbed', 0, null); };
const pastesClient = require('../server/pastes-client');
pastesClient.listPastes = async () => ({ pastes: [] });
pastesClient.getPaste = async () => { throw missing(); };

// ── The app, mounted as server/index.js mounts it ──
const express = require('express');
const seo = require('../server/seo/seo');
const pageStatus = require('../server/web/page-status');
const app = express();
seo.register(app);
app.get('*', pageStatus.spaFallback((res, urlPath) => {
    const html = seo.shellHtml(urlPath, res.statusCode);
    if (!html) return false;
    res.type('html').send(html);
    return true;
}));

let base;
function get(p, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(base + p, { method: 'GET', headers }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body, cache: res.headers['cache-control'] || '' }));
        });
        req.on('error', reject);
        req.end();
    });
}
const head = (html) => html.slice(0, html.search(/<\/head>/i));
const titleOf = (html) => ((head(html).match(/<title>([^<]*)<\/title>/) || [])[1] || '').replace(/&#39;/g, "'");
const canonicalsOf = (html) => [...head(html).matchAll(/<link rel="canonical" href="([^"]+)">/g)].map((m) => m[1]);
const robotsOf = (html) => [...head(html).matchAll(/<meta name="robots" content="([^"]+)">/g)].map((m) => m[1]);
const ldOf = (html) => [...head(html).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => { try { return JSON.parse(m[1]); } catch { return null; } }).filter(Boolean);
const bodyOf = (html) => ((html.match(/<div id="seo-prerender"[^>]*>([\s\S]*?)<\/div>\n/) || [])[1] || '');
const CLIENTS = [
    { name: 'no Accept (curl, monitors)', headers: {} },
    { name: 'Accept */*', headers: { accept: '*/*' } },
    { name: 'Googlebot', headers: { accept: 'text/html,application/xhtml+xml,application/signed-exchange;v=b3,*/*;q=0.8', 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' } },
    { name: 'a browser', headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } },
];

let failures = 0;
async function check(name, fn) {
    try { await fn(); quiet('  ✓', name); }
    catch (e) { failures++; quiet('  ✗', name, '\n     ', e.message); }
}

const server = http.createServer(app).listen(0, '127.0.0.1', async () => {
    base = `http://127.0.0.1:${server.address().port}`;
    quiet('Server-rendered pages');

    await check('/@alice: its own title, canonical, OG and JSON-LD for every client', async () => {
        for (const c of CLIENTS) {
            const r = await get('/@alice', c.headers);
            assert.strictEqual(r.status, 200, c.name);
            assert.strictEqual(titleOf(r.body), 'Alice (@alice) — OpenVibe.Live', `${c.name}: ${titleOf(r.body)}`);
            assert.deepStrictEqual(canonicalsOf(r.body), ['https://openvibe.live/@alice'], c.name);
            assert.ok(r.body.includes('<meta property="og:url" content="https://openvibe.live/@alice">'), c.name);
            assert.ok(r.body.includes('<meta property="og:type" content="profile">'), c.name);
            assert.deepStrictEqual(robotsOf(r.body), ['index,follow'], c.name);
            assert.ok(ldOf(r.body).some((n) => n['@type'] === 'ProfilePage' && n.mainEntity.name === 'Alice'), c.name);
        }
    });

    await check('/@alice: a real body with its videos, ?page=N links, clips and AI Moments apart', async () => {
        const b = bodyOf((await get('/@alice')).body);
        assert.ok(b.includes('<h1>Alice (@alice)</h1>'), b.slice(0, 300));
        assert.ok(b.includes('I stream woodworking.'));
        for (let id = 100; id < 112; id++) assert.ok(b.includes(`https://openvibe.live/vod/${id}"`), `VOD ${id} listed`);
        assert.ok(!b.includes('/vod/112"'), 'page 1 holds 12 videos');
        assert.ok(!b.includes('SECRET VOD'), 'no private VOD');
        assert.ok(b.includes('<a rel="next" href="https://openvibe.live/@alice?page=2">Older videos</a>'), 'next page link');
        assert.ok(b.includes('Page 1 of 3'));
        const clipsAt = b.indexOf('<h2>Clips</h2>'), aiAt = b.indexOf('<h2>AI Moments</h2>');
        assert.ok(clipsAt > 0 && aiAt > clipsAt, 'people\'s clips, then the AI\'s');
        assert.ok(b.slice(clipsAt, aiAt).includes('clipped by Bob'));
        assert.ok(b.slice(aiAt).includes('Chat lost it') && b.slice(aiAt).includes('AI clip'));
        const list = ldOf((await get('/@alice')).body).find((n) => n['@type'] === 'ItemList');
        assert.strictEqual(list.itemListElement.length, 12);
    });

    await check('/@alice?page=2 and ?page=3: self-canonical pages with prev/next; past the end is noindex', async () => {
        const p2 = (await get('/@alice?page=2')).body;
        assert.deepStrictEqual(canonicalsOf(p2), ['https://openvibe.live/@alice?page=2']);
        assert.ok(/page 2/.test(titleOf(p2)), titleOf(p2));
        const b2 = bodyOf(p2);
        assert.ok(b2.includes('/vod/112"') && b2.includes('/vod/123"') && !b2.includes('/vod/111"'));
        assert.ok(b2.includes('<a rel="prev" href="https://openvibe.live/@alice">Newer videos</a>'));
        assert.ok(b2.includes('<a rel="next" href="https://openvibe.live/@alice?page=3">'));
        assert.ok(!b2.includes('<h2>AI Moments</h2>'), 'clips are on page 1 only');
        const b3 = bodyOf((await get('/@alice?page=3')).body);
        assert.ok(b3.includes('/vod/129"') && !b3.includes('rel="next"'), 'the last page has no next link');
        const past = (await get('/@alice?page=9')).body;
        assert.deepStrictEqual(robotsOf(past), ['noindex,follow']);
        assert.deepStrictEqual(canonicalsOf(past), ['https://openvibe.live/@alice']);
        const junk = (await get('/@alice?page=abc')).body;
        assert.deepStrictEqual(canonicalsOf(junk), ['https://openvibe.live/@alice'], 'a non-number is page 1');
    });

    await check('/@finditfixit (an account with no channel row) gets its own page, not the home page', async () => {
        const r = await get('/@finditfixit', { 'user-agent': 'Googlebot/2.1' });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(titleOf(r.body), 'finditfixit (@finditfixit) — OpenVibe.Live');
        assert.deepStrictEqual(canonicalsOf(r.body), ['https://openvibe.live/@finditfixit']);
        assert.ok(bodyOf(r.body).includes('likes vintage video games'));
    });

    await check('/@Alice names the channel\'s own spelling as canonical', async () => {
        assert.deepStrictEqual(canonicalsOf((await get('/@Alice')).body), ['https://openvibe.live/@alice']);
    });

    await check('a 404 is noindex, with no canonical and none of the home page\'s metadata', async () => {
        for (const p of ['/@nobody', '/vod/999', '/clip/999', '/no-such-page', `/vod/199`]) {
            for (const c of CLIENTS.slice(0, 3)) {
                const r = await get(p, c.headers);
                assert.strictEqual(r.status, 404, `${p} ${c.name}`);
                assert.deepStrictEqual(canonicalsOf(r.body), [], `${p}: no canonical`);
                assert.deepStrictEqual(robotsOf(r.body), ['noindex'], `${p}: noindex`);
                assert.strictEqual(titleOf(r.body), 'Page not found — OpenVibe.Live', p);
                assert.ok(!/og:url|og:title|application\/ld\+json/.test(head(r.body)), `${p}: home OG/JSON-LD left in`);
                assert.ok(bodyOf(r.body).includes('<h1>Page not found</h1>'), `${p}: a not-found body`);
                assert.ok(!r.body.includes('SECRET VOD'));
            }
        }
    });

    await check('no other shell page claims the home page as canonical; a slot names its channel', async () => {
        const dash = (await get('/dashboard')).body;
        assert.deepStrictEqual(canonicalsOf(dash), []);
        const slot = (await get('/@alice/main')).body;
        assert.deepStrictEqual(canonicalsOf(slot), ['https://openvibe.live/@alice']);
        const home = (await get('/')).body;
        assert.deepStrictEqual(canonicalsOf(home), ['https://openvibe.live/']);
    });

    await check('/vod/100: its own head and a body with people\'s clips, then the AI\'s, as Clip parts', async () => {
        for (const c of CLIENTS) {
            const r = await get('/vod/100', c.headers);
            assert.strictEqual(r.status, 200, c.name);
            assert.deepStrictEqual(canonicalsOf(r.body), ['https://openvibe.live/vod/100'], c.name);
            assert.ok(/^Build night 100 — Alice \| OpenVibe\.Live$/.test(titleOf(r.body)), titleOf(r.body));
        }
        const r = await get('/vod/100?t=125');
        assert.deepStrictEqual(canonicalsOf(r.body), ['https://openvibe.live/vod/100'], 'a timestamp link is the same page');
        const vo = ldOf(r.body).find((n) => n['@type'] === 'VideoObject');
        assert.deepStrictEqual(vo.author, { '@type': 'Person', name: 'Alice' });
        assert.deepStrictEqual(vo.hasPart.map((x) => [x['@type'], x.startOffset, x.url]), [
            ['Clip', 61, 'https://openvibe.live/vod/100?t=61'],
            ['Clip', 125, 'https://openvibe.live/vod/100?t=125'],
        ]);
        const crumbs = ldOf(r.body).find((n) => n['@type'] === 'BreadcrumbList').itemListElement.map((i) => i.name);
        assert.deepStrictEqual(crumbs, ['Home', 'Alice', 'Build night 100']);
        const b = bodyOf(r.body);
        assert.ok(b.includes('Streamed by Alice') && b.includes('https://openvibe.live/@alice'));
        const people = b.indexOf('<h2>Clips from this stream</h2>'), ai = b.indexOf('<h2>AI Moments from this stream</h2>');
        assert.ok(people > 0 && ai > people);
        assert.ok(b.slice(people, ai).includes('clipped by Bob'));
        assert.ok(b.slice(ai).includes('AI clip · at 2:05'));
    });

    await check('/clip/200: its own head and a body linking the moment in the full stream', async () => {
        for (const c of CLIENTS) {
            const r = await get('/clip/200', c.headers);
            assert.strictEqual(r.status, 200, c.name);
            assert.deepStrictEqual(canonicalsOf(r.body), ['https://openvibe.live/clip/200'], c.name);
            assert.deepStrictEqual(robotsOf(r.body), ['index,follow'], c.name);
        }
        const b = bodyOf((await get('/clip/200')).body);
        assert.ok(b.includes("Clipped by Bob from Alice&#39;s stream"), b.slice(0, 300));
        assert.ok(b.includes('https://openvibe.live/vod/100?t=61'));
    });

    await check('without JavaScript the body shows (with the site links) and the empty app shell is hidden', async () => {
        const html = (await get('/@alice')).body;
        assert.ok(head(html).includes('<noscript><style>#seo-prerender{position:static!important'), 'no-JS rule in the head');
        assert.ok(head(html).includes('#app{display:none!important}'));
        assert.ok(bodyOf(html).startsWith('<nav aria-label="OpenVibe.Live"><a href="/">OpenVibe.Live</a>'));
    });

    await check('the client still hydrates: the route boots its feature and the fragment is inlined', async () => {
        const html = (await get('/@alice')).body;
        const boot = html.match(/<script type="application\/json" id="ov-route-features">([^<]*)<\/script>/);
        assert.ok(boot && JSON.parse(boot[1]).includes('channel'), 'the channel feature boots');
        assert.ok(html.includes('/js/app.js'), 'the client router is loaded');
        assert.ok(html.includes('data-fragment="channel" data-fragment-loaded="1"'), 'the channel markup is inlined');
        const src = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
        assert.ok(/getElementById\('seo-prerender'\)\?\.remove\(\)/.test(src), 'the SPA removes the server body on boot');
    });

    await check('a slow Media never holds a channel page: rendered without its lists, cached briefly', async () => {
        slow = 4000;
        const t0 = Date.now();
        const r = await get('/@bob');
        const took = Date.now() - t0;
        slow = 0;
        assert.strictEqual(r.status, 200);
        assert.ok(took < 2500, `took ${took}ms`);
        assert.strictEqual(titleOf(r.body), 'Bob (@bob) — OpenVibe.Live');
        assert.ok(/max-age=30\b/.test(r.cache), r.cache);
    });

    await check('server/index.js sends the fallback shell through seo.shellHtml', () => {
        const src = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
        assert.ok(src.includes("require('./seo/seo').shellHtml"));
        assert.ok(src.includes("app.get('*', require('./web/page-status').spaFallback((res, urlPath) => sendShell(res, urlPath)));"));
    });

    server.close();
    try { fs.unlinkSync(tmp); } catch { /* */ }
    for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch { /* */ } }
    quiet(failures ? `\n${failures} check(s) failed` : '\nseo ssr: all checks passed');
    process.exit(failures ? 1 : 0);
});
