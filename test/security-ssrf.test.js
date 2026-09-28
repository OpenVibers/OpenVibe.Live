'use strict';
/**
 * URLs that users choose never reach Live's own or internal services (roadmap WS-R task 5, the
 * SSRF class). test/egress.test.js pins the guard's pieces; this suite attacks it the ways SSRF
 * bugs actually happen, and checks the features that fetch user URLs really go through it.
 *
 *   - Every way of spelling an internal address: decimal (2130706433), octal (0177.0.0.1), hex
 *     (0x7f000001, 0x7f.1), short (127.1), 0 / 0.0.0.0, IPv6 (::1, ::, ::ffff:127.0.0.1 in both
 *     notations, fc00::/7, fe80::), cloud metadata (169.254.169.254), private ranges, "localhost."
 *     and names that resolve to any of those, plus non-http schemes and credentials in the URL.
 *   - DNS rebinding: a name that answers "public" to the first lookup and 127.0.0.1 to the next;
 *     a name with one public and one internal answer.
 *   - Redirects: a public page (a stubbed first hop, since a sandbox has no public server) that
 *     302s to each internal spelling, and to file:/gopher: URLs.
 *   - The loopback proxy yt-dlp and ffmpeg use: CONNECT and absolute-URI requests to the same.
 *   - The features: the image proxy, the kiosk link preview, song requests (media queue), the chat
 *     relay's page reads, and a streamer's own AI endpoint (AI viewers, "bring your own" base URL:
 *     its "test connection" button POSTed to any address and returned the answer; found by this
 *     suite, now through egress.postJson).
 *   - And a ratchet: the files that make outbound requests themselves are a reviewed list; a new
 *     one must go through server/net/egress.js or be added here with the reason its URLs are not
 *     a user's choice.
 *
 * A local HTTP server stands in for an internal service and counts every request it gets: it must
 * end at zero.
 *
 *   node test/security-ssrf.test.js
 */
const assert = require('assert');
const dns = require('dns');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const tmp = path.join(os.tmpdir(), `ov-ssrf-${process.pid}.db`);
process.env.DB_PATH = tmp;
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-sec-data-'));   // nothing lands in the checkout's data/
process.env.NODE_ENV = 'test';
process.env.OV_TOOLS_INTERNAL_URL = 'http://127.0.0.1:9';   // the kiosk asks Tools first; nobody is there
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

// ── DNS: test names, installed before the guard captures dns.lookup ──
const PUBLIC_IP = '93.184.216.34';
const FAKE = {
    'public.example.test': [PUBLIC_IP],
    'metadata.example.test': ['169.254.169.254'],
    'private.example.test': ['10.0.0.5'],
    'loop6.example.test': ['::1'],
    'mapped.example.test': ['::ffff:127.0.0.1'],
    'mixed.example.test': [PUBLIC_IP, '127.0.0.1'],
    'mapped.101soundboards.com': ['::ffff:127.0.0.1'],
    'cgnat.101soundboards.com': ['100.64.0.1'],
    'mixed.101soundboards.com': [PUBLIC_IP, '10.0.0.1'],
};
let rebindLookups = 0;
function answersFor(hostname) {
    const h = String(hostname).toLowerCase().replace(/\.$/, '');
    if (h === 'rebind.example.test' || h === 'rebind.101soundboards.com') { rebindLookups++; return rebindLookups === 1 ? [PUBLIC_IP] : ['127.0.0.1']; }
    return FAKE[h] || null;
}
const realLookup = dns.lookup;
dns.lookup = function (hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const list = answersFor(hostname);
    if (!list) return realLookup.call(this, hostname, options, callback);
    const opts = typeof options === 'number' ? { family: options } : (options || {});
    const addrs = list.map((a) => ({ address: a, family: a.includes(':') ? 6 : 4 }));
    process.nextTick(() => (opts.all ? callback(null, addrs) : callback(null, addrs[0].address, addrs[0].family)));
};
const realPromiseLookup = dns.promises.lookup;
dns.promises.lookup = async function (hostname, options) {
    const list = answersFor(hostname);
    if (!list) return realPromiseLookup.call(this, hostname, options);
    const addrs = list.map((a) => ({ address: a, family: a.includes(':') ? 6 : 4 }));
    return options && options.all ? addrs : addrs[0];
};

// ── The public first hop: public.example.test answers from a table instead of the internet ──
const PUBLIC_PAGES = new Map();   // path → { status, headers, body }
const publicHops = [];
const realHttpRequest = http.request;
http.request = function (url, options, cb) {
    const target = url instanceof URL ? url : (typeof url === 'string' ? new URL(url) : null);
    if (target && target.hostname === 'public.example.test') {
        if (typeof options === 'function') { cb = options; options = {}; }
        publicHops.push(`${(options && options.method) || 'GET'} ${target.pathname}${target.search}`);
        const req = new EventEmitter();
        req.write = () => true;
        req.setTimeout = () => req;
        req.destroy = () => req;
        req.end = () => process.nextTick(() => {
            const page = PUBLIC_PAGES.get(target.pathname + target.search) || { status: 200, headers: { 'content-type': 'text/html' }, body: '<title>public page</title>' };
            const res = new PassThrough();
            res.statusCode = page.status;
            res.headers = page.headers;
            cb(res);
            res.end(page.body || '');
        });
        return req;
    }
    return realHttpRequest.apply(this, arguments);
};

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failures++; console.log(`  ✗ ${name}\n    ${String(err.stack || err.message).split('\n').slice(0, 8).join('\n    ')}`); }
}

(async () => {
    // The internal service: counts every request; its answers are what an attacker wants back.
    let hits = 0;
    const internal = http.createServer((req, res) => { hits++; res.writeHead(500); res.end('internal-admin-page'); });
    await new Promise((resolve) => internal.listen(0, '::', resolve).once('error', () => internal.listen(0, '127.0.0.1', resolve)));
    const p = internal.address().port;

    const egress = require('../server/net/egress');

    // Internal addresses, every spelling (with the internal server's port where one is listening).
    const INTERNAL = [
        `http://127.0.0.1:${p}/`, `http://2130706433:${p}/`, `http://0177.0.0.1:${p}/`, `http://0x7f000001:${p}/`, `http://0x7f.1:${p}/`,
        `http://127.1:${p}/`, `http://0:${p}/`, `http://0.0.0.0:${p}/`, `http://[::1]:${p}/`, `http://[::]:${p}/`,
        `http://[::ffff:127.0.0.1]:${p}/`, `http://[0:0:0:0:0:ffff:7f00:1]:${p}/`, `http://[::ffff:7f00:1]:${p}/`,
        `http://localhost:${p}/`, `http://LOCALHOST.:${p}/`, `http://mapped.example.test:${p}/`, `http://loop6.example.test:${p}/`,
        `http://mixed.example.test:${p}/`, 'http://169.254.169.254/latest/meta-data/', 'http://[::ffff:a9fe:a9fe]/latest/meta-data/',
        'http://metadata.example.test/computeMetadata/v1/', 'http://10.0.0.1/', 'http://172.16.0.1/', 'http://192.168.1.1/',
        'http://100.64.0.1/', 'http://private.example.test/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://[fc00::1]/',
    ];
    const NOT_HTTP = ['file:///etc/passwd', `gopher://127.0.0.1:${p}/_x`, `ftp://127.0.0.1:${p}/`, 'dict://127.0.0.1:11211/stat', 'data:text/plain,x', `http://user:pw@public.example.test/`];

    console.log('ssrf: the guard (server/net/egress.js)');
    await check('assertPublicUrl refuses every internal spelling, every non-http scheme and credentials', async () => {
        for (const u of [...INTERNAL, ...NOT_HTTP]) await assert.rejects(egress.assertPublicUrl(u), /./, u);
        await egress.assertPublicUrl('http://public.example.test/');   // and a public name passes
    });
    await check('fetchText, fetchBuffer and postJson never connect to any of them', async () => {
        for (const u of [...INTERNAL, ...NOT_HTTP]) {
            await assert.rejects(egress.fetchText(u, { timeoutMs: 2000 }), /./, `fetchText ${u}`);
            await assert.rejects(egress.fetchBuffer(u, { timeoutMs: 2000 }), /./, `fetchBuffer ${u}`);
            await assert.rejects(egress.postJson(u, { x: 1 }, { timeoutMs: 2000 }), /./, `postJson ${u}`);
        }
        assert.strictEqual(hits, 0);
    });
    await check('DNS rebinding: public at the check, loopback at connect time — refused where the connection is made', async () => {
        rebindLookups = 0;
        await assert.rejects(egress.fetchText(`http://rebind.example.test:${p}/`, { timeoutMs: 2000 }), /./);
        assert.ok(rebindLookups >= 2, `the connect-time lookup ran (${rebindLookups} lookups)`);
        rebindLookups = 0;
        await assert.rejects(egress.postJson(`http://rebind.example.test:${p}/v1/chat/completions`, {}, { timeoutMs: 2000 }), /./);
        assert.ok(rebindLookups >= 2);
        assert.strictEqual(hits, 0);
    });
    await check('redirects: a public page may redirect to another public page', async () => {
        PUBLIC_PAGES.set('/hop', { status: 302, headers: { location: 'http://public.example.test/final' } });
        const r = await egress.fetchText('http://public.example.test/hop');
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /public page/);
        assert.strictEqual(r.url, 'http://public.example.test/final');
    });
    await check('redirects: a public page that redirects to any internal spelling or scheme is refused at that hop', async () => {
        const targets = [...INTERNAL, 'file:///etc/passwd', `gopher://127.0.0.1:${p}/_x`, `//127.0.0.1:${p}/protocol-relative`, `http://rebind.example.test:${p}/`];
        for (const [i, to] of targets.entries()) {
            PUBLIC_PAGES.set(`/r${i}`, { status: 302, headers: { location: to } });
            rebindLookups = 1;   // the rebinding name now answers loopback
            await assert.rejects(egress.fetchText(`http://public.example.test/r${i}`, { timeoutMs: 2000 }), /./, to);
            await assert.rejects(egress.fetchBuffer(`http://public.example.test/r${i}`, { timeoutMs: 2000 }), /./, to);
        }
        assert.strictEqual(hits, 0);
    });
    await check('postJson does not follow a redirect at all (a 3xx comes back as it is)', async () => {
        PUBLIC_PAGES.set('/v1/chat/completions', { status: 307, headers: { location: `http://127.0.0.1:${p}/v1/chat/completions` } });
        const r = await egress.postJson('http://public.example.test/v1/chat/completions', { x: 1 });
        assert.strictEqual(r.status, 307);
        assert.strictEqual(hits, 0);
        PUBLIC_PAGES.delete('/v1/chat/completions');
    });

    console.log('ssrf: the proxy yt-dlp and ffmpeg go out through');
    const proxyPort = Number(new URL(await egress.proxy()).port);
    const raw = (text) => new Promise((resolve) => {
        const sock = net.connect(proxyPort, '127.0.0.1', () => sock.write(text));
        let data = '';
        sock.on('data', (c) => { data += c; if (/\r\n\r\n/.test(data)) sock.destroy(); });
        sock.on('close', () => resolve(data));
        sock.on('error', () => resolve(data));
        setTimeout(() => sock.destroy(), 3000);
    });
    await check('CONNECT to decimal, octal, hex, short, IPv6 and rebinding spellings is refused', async () => {
        for (const host of [`2130706433:${p}`, `0177.0.0.1:${p}`, `0x7f000001:${p}`, `127.1:${p}`, `0.0.0.0:${p}`, `[::1]:${p}`, `[::ffff:127.0.0.1]:${p}`,
            `mapped.example.test:${p}`, `loop6.example.test:${p}`, `mixed.example.test:${p}`, `metadata.example.test:80`, `169.254.169.254:80`]) {
            const res = await raw(`CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
            assert.doesNotMatch(res, /^HTTP\/1\.1 200/, `${host}: ${res}`);
            assert.match(res, /^HTTP\/1\.1 (403|502|400)/, `${host}: ${res}`);
        }
        assert.strictEqual(hits, 0);
    });
    await check('absolute-URI requests to the same are refused', async () => {
        for (const u of INTERNAL.filter((x) => x.startsWith('http://'))) {
            const host = new URL(u).host;
            const res = await raw(`GET ${u} HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
            assert.doesNotMatch(res, /^HTTP\/1\.1 200|internal-admin-page/, `${u}: ${res}`);
        }
        assert.strictEqual(hits, 0);
    });

    // ── The features, through their real routes ──
    const db = require('../server/db/database');
    db.initDb();
    const rawDb = db.getDb();
    rawDb.prepare("INSERT INTO users (id, username, display_name, email, password_hash, role) VALUES (7, 'ssrfer', 'ssrfer', 'ssrfer@example.test', 'x', 'streamer')").run();
    db.ensureChannel(7);
    const auth = require('../server/auth/auth');
    const signIn = (req) => { const u = req.headers['x-test-user'] ? db.getUserById(Number(req.headers['x-test-user'])) : null; if (u) { req.user = u; req.authSource = 'network'; } return u; };
    auth.requireAuth = (req, res, next) => (signIn(req) ? next() : res.status(401).json({ error: 'Authentication required' }));
    auth.optionalAuth = (req, res, next) => { signIn(req); next(); };
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/img-proxy', require('../server/media/external-image-proxy'));
    app.use('/api/kiosk', require('../server/kiosk/routes'));
    app.use('/api/ai-viewers', require('../server/ai/viewers/routes'));
    const server = http.createServer(app).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const call = (method, pth, body) => new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = realHttpRequest({ host: '127.0.0.1', port: server.address().port, path: pth, method, headers: { 'content-type': 'application/json', 'x-test-user': '7' } }, (res) => {
            let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, text }));
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });

    console.log('ssrf: the features that fetch user URLs');
    await check('image proxy (/api/img-proxy): internal spellings refused, the public host is fetched through the guard', async () => {
        for (const u of [...INTERNAL, ...NOT_HTTP]) {
            const r = await call('GET', `/api/img-proxy?url=${encodeURIComponent(u)}`);
            assert.ok([400, 403].includes(r.status), `${u}: ${r.status} ${r.text.slice(0, 120)}`);
            assert.ok(!r.text.includes('internal-admin-page'));
        }
        PUBLIC_PAGES.set('/img.png', { status: 302, headers: { location: `http://2130706433:${p}/img.png` } });
        const r = await call('GET', '/api/img-proxy?url=' + encodeURIComponent('http://public.example.test/img.png'));
        assert.ok(publicHops.includes('GET /img.png'), 'the first hop went out through the guard');
        assert.ok([403, 502].includes(r.status), `redirect into the network: ${r.status}`);
        assert.strictEqual(hits, 0);
    });
    await check('kiosk link preview (/api/kiosk/site): internal hosts are "not reachable", and a public page\'s redirect inward is not followed', async () => {
        for (const u of INTERNAL) {
            const r = await call('GET', `/api/kiosk/site?url=${encodeURIComponent(u)}`);
            assert.strictEqual(r.status, 200);
            assert.strictEqual(JSON.parse(r.text).reachable, false, `${u}: ${r.text}`);
        }
        PUBLIC_PAGES.set('/kiosk', { status: 301, headers: { location: `http://[::ffff:7f00:1]:${p}/` } });
        const r = await call('GET', '/api/kiosk/site?url=' + encodeURIComponent('http://public.example.test/kiosk'));
        assert.ok(publicHops.includes('GET /kiosk'), 'fetched through the guard');
        assert.ok(!r.text.includes('internal-admin-page'), r.text);
        assert.strictEqual(hits, 0);
    });
    await check('song requests (media queue): a link to an internal address is refused before yt-dlp is asked', async () => {
        const downloader = require('../server/media/media-downloader');
        const asked = [];
        downloader.isAvailable = () => true;
        downloader.ready = async () => null;
        downloader.getInfo = async (u) => { asked.push(u); return { url: u, title: 'x' }; };
        const queue = require('../server/media/media-queue');
        for (const u of INTERNAL.map((x) => `${x}watch?v=1`)) {
            await assert.rejects(queue.normalizeInput(u, { allow_direct_media: 1 }), /reachable|resolve|http|supported|link/i, u);
        }
        assert.deepStrictEqual(asked, []);
        // yt-dlp's canonical URL is held to the same rule: a public page claiming an internal canonical URL is refused.
        downloader.getInfo = async () => ({ url: `http://127.0.0.1:${p}/`, title: 'x' });
        await assert.rejects(queue.normalizeInput('http://public.example.test/track', { allow_direct_media: 1 }), /./);
        assert.strictEqual(hits, 0);
    });
    await check('chat relay page reads (_httpGet) refuse internal addresses', async () => {
        const relay = require('../server/integrations/chat-relay-service');
        for (const u of INTERNAL.slice(0, 12)) await assert.rejects(relay._httpGet(u), /./, u);
        assert.strictEqual(hits, 0);
    });
    await check('AI viewers "bring your own" base URL: test connection to an internal address never connects and returns nothing from it', async () => {
        for (const base of [...INTERNAL.map((u) => `${u}v1`), `http://rebind.example.test:${p}/v1`]) {
            rebindLookups = 0;
            const r = await call('POST', '/api/ai-viewers/byo/test', { byo_base_url: base, byo_key: 'byo-test-key', byo_model: 'm' });
            assert.ok(!r.text.includes('internal-admin-page'), `${base}: ${r.text.slice(0, 200)}`);
            const j = JSON.parse(r.text);
            assert.strictEqual(j.ok, false, `${base}: ${r.text.slice(0, 200)}`);
        }
        assert.strictEqual(hits, 0, 'the internal service was POSTed to');
        const before = publicHops.length;
        await call('POST', '/api/ai-viewers/byo/test', { byo_base_url: 'http://public.example.test/v1', byo_key: 'byo-test-key', byo_model: 'm' });
        assert.ok(publicHops.slice(before).includes('POST /v1/chat/completions'), 'a public BYO endpoint is still called, through the guard');
    });
    await check('AI viewers: a saved base URL is never called when the bots run (llm.complete refuses a raw key/base URL)', async () => {
        await call('PUT', '/api/ai-viewers/config', { byo_base_url: `http://127.0.0.1:${p}/v1`, byo_key: 'byo-test-key', use_shared_key: 0 });
        const llm = require('../server/ai/llm');
        const budget = require('../server/ai/viewers/budget');
        const override = budget.byoProvider(db.getChannelAiConfig(7));
        const r = await llm.complete({ role: 'chat', user: 'hi', maxTokens: 5, retries: 0, provider: override, skipGate: true }).catch((e) => ({ error: e.message }));
        assert.ok(!JSON.stringify(r || {}).includes('internal-admin-page'));
        assert.strictEqual(hits, 0);
    });

    await check('soundboard: a 101soundboards audio URL that resolves inward (any spelling, one internal answer, or rebinding at download) is refused', async () => {
        db.setSetting('soundboard_101_api_key', 'sentinel-not-a-secret-soundboard');
        const sb = require('../server/chat/soundboard-service');
        let audioUrl = null;
        const realFetch = globalThis.fetch;
        globalThis.fetch = async (url, opts) => (String(url).startsWith('https://www.101soundboards.com/')
            ? new Response(JSON.stringify({ data: { sound_name: 'Horn', sound_file_url: audioUrl } }), { status: 200, headers: { 'content-type': 'application/json' } })
            : realFetch(url, opts));
        const connects = [];
        const realConnect = net.Socket.prototype.connect;
        net.Socket.prototype.connect = function (...args) { const o = Array.isArray(args[0]) ? args[0][0] : args[0]; if (o && typeof o === 'object' && o.host) connects.push(String(o.host)); return realConnect.apply(this, args); };
        try {
            let id = 5000;
            for (const host of ['mapped', 'cgnat', 'mixed']) {
                audioUrl = `https://${host}.101soundboards.com/a.mp3`;
                await assert.rejects(sb.getSoundboardAudio(String(++id)), /restricted|resolved/, host);
            }
            rebindLookups = 0;
            audioUrl = 'https://rebind.101soundboards.com/a.mp3';
            await sb.getSoundboardAudio(String(++id)).catch(() => null);
            assert.ok(rebindLookups >= 2, `the download resolved again (${rebindLookups})`);
            assert.ok(!connects.some((c) => /^(127\.|::1|::ffff:127|10\.|100\.64\.)/.test(c)), `connected to ${connects.join(', ')}`);
        } finally { globalThis.fetch = realFetch; net.Socket.prototype.connect = realConnect; }
    });

    console.log('ssrf: who makes outbound requests');
    await check('every file that makes an outbound request itself is on the reviewed list (user-chosen URLs go through server/net/egress.js)', () => {
        // Why each may call fetch/http(s).request/WebSocket directly: its URLs are Live's configured
        // services, fixed third-party hosts, or settings only the site owner can change. User-chosen
        // URLs in these files go through egress (noted).
        const REVIEWED = {
            'server/net/egress.js': 'the guard itself',
            'server/drill.js': 'the restore-drill guard (refuses connections)',
            'server/config.js': 'Network registry (configured)',
            'server/media-client.js': 'OpenVibe.Media (configured)',
            'server/media-proxy/live-thumbs.js': 'OpenVibe.Media (configured)',
            'server/media-proxy/outcomes.js': 'ops alert webhook (env / owner-only setting)',
            'server/media-proxy/pastes.js': 'OpenVibe.Community / Media (configured)',
            'server/lineage/media-source.js': 'OpenVibe.Media (configured)',
            'server/pastes-client.js': 'OpenVibe.Community (configured)',
            'server/comments-client.js': 'OpenVibe.Community (configured)',
            'server/chat/chat-remote.js': 'OpenVibe.Chat (configured)',
            'server/chat/chat-tables.js': 'OpenVibe.Chat (configured)',
            'server/chat/chat-server.js': 'OpenVibe.Tools anon resolve (configured)',
            'server/streaming/calls-authority.js': 'OpenVibe.Chat (configured)',
            'server/streaming/golive-notify.js': 'OpenVibe.Network (configured)',
            'server/utils/notify.js': 'OpenVibe.Network (configured)',
            'server/auth/identity-sync.js': 'OpenVibe.Network (configured)',
            'server/auth/account-data.js': 'OpenVibe.Network (configured): export parts and deletion confirmations',
            'server/ai/viewer-quota.js': 'OpenVibe.AI (configured OV_AI_INTERNAL_URL): a streamer\'s daily AI-viewer cap',
            'server/ai/byo-credentials.js': 'OpenVibe.AI (configured OV_AI_INTERNAL_URL): a streamer\'s own key stored there',
            'server/monetization/billing-client.js': 'OpenVibe.Billing (configured)',
            'server/monetization/wallet-client.js': 'OpenVibe.Network wallet (configured)',
            'server/monetization/payments.js': 'PayPal (fixed host)',
            'server/monetization/cosmetics.js': 'legacy quest API (env)',
            'server/openre/openre-client.js': 'OpenRe.Stream (configured)',
            'server/ai/ai-service.js': 'OpenVibe.AI (configured)',
            'server/ai/llm.js': 'images are Live\'s own frames; a streamer\'s typed provider address (testProvider) goes through egress.postJson',
            'server/chat/routes.js': 'GIF providers (fixed hosts)',
            'server/chat/soundboard-service.js': '101soundboards (host allowlist; the audio download through safeLookup)',
            'server/chat/tts-engine.js': 'Google / AWS TTS (fixed hosts)',
            'server/emotes/routes.js': 'FFZ / BTTV / 7TV (fixed hosts)',
            'server/meta/routes.js': 'GitHub API (fixed host)',
            'server/seo/seo.js': 'a local function named fetch (no request)',
            'server/news/sources/newsapi-source.js': 'NewsAPI (fixed host)',
            'server/news/sources/reddit-source.js': 'Reddit (fixed host)',
            'server/news/sources/rss-source.js': 'feeds the site owner configures',
            'server/integrations/platform-oauth.js': 'Twitch / YouTube / Kick OAuth (fixed hosts)',
            'server/integrations/powerchat-oauth.js': 'PowerChat (owner setting)',
            'server/integrations/discord-webhook.js': 'Discord webhook (owner-only setting)',
            'server/integrations/robotstreamer-service.js': 'RobotStreamer API and the endpoints it returns',
            'server/integrations/rs-passthrough-relay.js': 'RobotStreamer SFU (from its API)',
            'server/integrations/chat-relay-service.js': 'YouTube API (fixed host); user channel pages via egress.fetchText',
            'server/kiosk/routes.js': 'OpenVibe.Tools (configured) and DuckDuckGo favicons; the user URL via egress.fetchText',
            'server/media/media-queue.js': 'YouTube oEmbed (fixed host); user links checked by egress, yt-dlp through the egress proxy',
            'server/streaming/restream-manager.js': 'Twitch / Kick / YouTube APIs (fixed hosts)',
            'server/streaming/routes.js': 'weather APIs (fixed hosts) and the local RTMP server',
        };
        const root = path.join(__dirname, '..');
        const found = [];
        const walk = (dir) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const f = path.join(dir, e.name);
                if (e.isDirectory()) walk(f);
                else if (e.name.endsWith('.js')) {
                    const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
                    if (/(^|[^.\w])fetch\(|\bhttps?\.(get|request)\(|\bmod\.(get|request)\(|new WebSocket\(|require\(['"](axios|got|node-fetch|undici)['"]\)/m.test(src)) found.push(path.relative(root, f));
                }
            }
        };
        walk(path.join(root, 'server'));
        const unreviewed = found.filter((f) => !REVIEWED[f]).sort();
        assert.deepStrictEqual(unreviewed, [], 'new outbound request sites: fetch user-chosen URLs through server/net/egress.js, then add the file here with the reason');
    });

    await check('the internal service was never reached', () => assert.strictEqual(hits, 0));

    server.close();
    internal.close();
    for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch { /* */ } }
    try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
    if (failures) { quiet(`\n${failures} failure(s)`); process.exit(1); }
    quiet('\nsecurity-ssrf: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
