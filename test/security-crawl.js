'use strict';
/**
 * The crawler behind test/security-stream-keys.test.js and test/security-secrets.test.js (roadmap
 * WS-R task 5). Not a test itself (no .test.js): it boots the real server/index.js in the calling
 * process as a restore-drill instance (LIVE_DRILL, server/drill.js: HTTP on one loopback port, reads
 * only, no outbound connection, no job, no socket server) against a temp database the caller seeded,
 * lists every GET route Express knows after boot, and requests each one.
 *
 * Listing the routes from the booted app (not from a hand-kept list) is the point: a route added
 * next month is crawled without anyone remembering to add it here.
 *
 * Sign-in is real: the caller gets an RSA key pair whose public half is the "Network" key Live
 * verifies (OV_NETWORK_PUBLIC_KEY), and signs user session tokens with the private half.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const ISSUER = 'https://network.crawl.test';

/** A temp directory with the drill's DB_PATH and DATA_DIR (both must lie outside the checkout). */
function tempEnv(name) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `live-${name}-`));
    const DB_PATH = path.join(dir, 'db', 'live.db');
    const DATA_DIR = path.join(dir, 'data');
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    return { dir, DB_PATH, DATA_DIR, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } } };
}

/**
 * Run `script` in a child Node process in normal mode (not a drill) against the temp database, the
 * way production would have written the rows a drill later reads. Its stdout's last line, if JSON,
 * is returned parsed.
 */
function seed(tmp, script, env = {}) {
    const r = spawnSync(process.execPath, ['-e', script], {
        cwd: REPO, encoding: 'utf8',
        env: { ...process.env, DB_PATH: tmp.DB_PATH, DATA_DIR: tmp.DATA_DIR, NODE_ENV: 'test', ...env },
    });
    assert.strictEqual(r.status, 0, `seeding failed:\n${r.stdout}\n${r.stderr}`);
    const last = r.stdout.trim().split('\n').pop() || '';
    try { return JSON.parse(last); } catch { return null; }
}

/** The "Network" signing key: its public half is what Live verifies session tokens with. */
function networkKeys(tmp) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicKeyPath = path.join(tmp.dir, 'network-public.pem');
    fs.writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));
    const jwt = require('jsonwebtoken');
    const sign = (claims) => jwt.sign({ ...claims }, privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });
    return { publicKeyPath, sign, env: { OV_NETWORK_PUBLIC_KEY: publicKeyPath, OV_NETWORK_URL: ISSUER } };
}

function freePort() {
    return new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

/** The path an Express 4 layer is mounted at ('' for app-level middleware), or null if it is a pattern we cannot turn back into a path. */
function mountPath(layer) {
    if (!layer.regexp || layer.regexp.fast_slash) return '';
    let src = layer.regexp.source.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/i, '').replace(/\/\?\(\?=\/\|\$\)$/i, '');
    let i = 0;
    src = src.replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, () => `:${(layer.keys[i++] || {}).name || 'param'}`);
    src = src.replace(/\\\//g, '/').replace(/\\\./g, '.').replace(/\\-/g, '-');
    return /[\\^$()|[\]*+?]/.test(src) ? null : src;
}

/** Every route of an Express app: [{ path, methods }] with `path` a string template (':param'). */
function listRoutes(app) {
    const out = [];
    const walk = (stack, prefix) => {
        for (const layer of stack) {
            if (layer.route) {
                const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]);
                for (const p of [].concat(layer.route.path)) {
                    if (typeof p === 'string') out.push({ path: prefix + p, methods });
                }
            } else if (layer.handle && Array.isArray(layer.handle.stack)) {
                const mp = mountPath(layer);
                if (mp !== null) walk(layer.handle.stack, prefix + mp);
            } else {
                // A plain middleware mounted on a path (e.g. the "moved" answers): it answers everything under it.
                const mp = mountPath(layer);
                if (mp) out.push({ path: prefix + mp, methods: ['_all'] });
            }
        }
    };
    walk(app._router.stack, '');
    const seen = new Set();
    return out.filter((r) => { const k = `${r.methods.join(',')} ${r.path}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * Concrete paths for a route template. `values(name)` gives the candidate values of a parameter;
 * a template yields one path per candidate position (candidate i for every parameter), so a route
 * with an unknown parameter is tried with each seeded id without multiplying out.
 */
function expand(template, values) {
    const names = [];
    const t = `/${template.replace(/^\/+/, '')}`.replace(/\*/g, 'x').replace(/:([A-Za-z0-9_]+)\??(\([^)]*\))?/g, (m, n) => { names.push(n); return `:${n}`; });
    if (!names.length) return [t];
    const lists = names.map((n) => values(n));
    const width = Math.max(...lists.map((l) => l.length));
    const paths = new Set();
    for (let i = 0; i < width; i++) {
        let j = 0;
        paths.add(t.replace(/:([A-Za-z0-9_]+)/g, () => { const l = lists[j++]; return encodeURIComponent(String(l[Math.min(i, l.length - 1)])); }));
    }
    return [...paths];
}

/**
 * Boot server/index.js in this process as a drill instance on a free loopback port. `env` is added
 * to process.env first (the tests put their sentinel secrets there). Resolves with the app, its
 * routes, and request(method, path, { headers, timeoutMs }).
 */
async function boot(tmp, env = {}) {
    const port = await freePort();
    Object.assign(process.env, env, { LIVE_DRILL: '1', DB_PATH: tmp.DB_PATH, DATA_DIR: tmp.DATA_DIR, HOST: '127.0.0.1', PORT: String(port) });
    delete process.env.LISTEN_FDS;
    let app = null;
    const realCreate = http.createServer;
    http.createServer = function (...a) { const h = a.find((x) => typeof x === 'function'); if (h && typeof h.handle === 'function' && typeof h.set === 'function') app = h; return realCreate.apply(this, a); };
    delete require.cache[require.resolve('../server/drill')];
    require('../server/index.js');
    http.createServer = realCreate;
    assert.ok(app, 'server/index.js created its HTTP server from the Express app');
    const base = `http://127.0.0.1:${port}`;
    const request = (method, p, { headers = {}, timeoutMs = 4000, body = null } = {}) => new Promise((resolve) => {
        let done = false;
        const finish = (r) => { if (!done) { done = true; resolve(r); } };
        let req;
        try { new URL(base + p); } catch (e) { finish({ status: 0, headers: {}, text: '', error: `bad path ${p}` }); return; }
        req = http.request(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
            let text = '';
            const timer = setTimeout(() => { res.destroy(); finish({ status: res.statusCode, headers: res.headers, text, timedOut: true }); }, timeoutMs);
            res.setEncoding('utf8');
            res.on('data', (c) => { if (text.length < 4 * 1024 * 1024) text += c; });
            res.on('end', () => { clearTimeout(timer); finish({ status: res.statusCode, headers: res.headers, text }); });
            res.on('error', () => { clearTimeout(timer); finish({ status: res.statusCode, headers: res.headers, text }); });
        });
        req.setTimeout(timeoutMs, () => { req.destroy(); finish({ status: 0, headers: {}, text: '', timedOut: true }); });
        req.on('error', (e) => finish({ status: 0, headers: {}, text: '', error: e.message }));
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
    let ready = null;
    for (let i = 0; i < 200 && !(ready && ready.status === 200); i++) {
        ready = await request('GET', '/api/ready', { timeoutMs: 1000 });
        if (ready.status !== 200) await new Promise((r) => setTimeout(r, 100));
    }
    assert.strictEqual(ready && ready.status, 200, `drill instance not ready: ${ready && ready.text}`);
    return { app, port, base, request, routes: listRoutes(app) };
}

/** Capture console output (the logs a public request writes) until stop() is called. */
function captureLogs() {
    const lines = [];
    const orig = {};
    for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
        orig[m] = console[m];
        console[m] = (...a) => { lines.push(a.map((x) => (typeof x === 'string' ? x : (() => { try { return x instanceof Error ? `${x.message}\n${x.stack}` : JSON.stringify(x); } catch { return String(x); } })())).join(' ')); };
    }
    const wOut = process.stdout.write.bind(process.stdout);
    const wErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (c, ...a) => { lines.push(String(c)); return true; };
    process.stderr.write = (c, ...a) => { lines.push(String(c)); return true; };
    return {
        lines,
        stop() { Object.assign(console, orig); process.stdout.write = wOut; process.stderr.write = wErr; return lines; },
    };
}

/** Which of `needles` ({ label: value }) occur in a response's body or headers: [{ label, where }]. */
function leaks(res, needles) {
    const found = [];
    const headerText = Object.entries(res.headers || {}).map(([k, v]) => `${k}: ${[].concat(v).join(', ')}`).join('\n');
    for (const [label, value] of Object.entries(needles)) {
        if (!value) continue;
        if (res.text && res.text.includes(value)) found.push({ label, where: 'body' });
        if (headerText.includes(value)) found.push({ label, where: 'headers' });
    }
    return found;
}

/**
 * Every GET path to crawl: each GET route (and path-mounted handler) expanded with `values(name)`,
 * each also with `query` appended when given, plus `extra` (pages the route list shows only as '*').
 */
function getPaths(srv, values, { query = '', extra = [] } = {}) {
    const paths = new Set();
    for (const r of srv.routes) {
        if (!r.methods.includes('get') && !r.methods.includes('_all')) continue;
        for (const p of expand(r.path, values)) {
            paths.add(p);
            if (query && !p.includes('?')) paths.add(`${p}?${query}`);
        }
    }
    for (const p of extra) paths.add(p);
    return [...paths];
}

/**
 * GET every path as every person, a few requests at a time. `needlesFor(who)` names the values that
 * person must never see. Resolves { found: ['who: GET path → status carries label in its where'],
 * answered, timedOut: [paths], statuses: { '2xx': n, ... } }.
 */
async function crawlAll(srv, paths, people, needlesFor, { concurrency = 6, timeoutMs = 3000 } = {}) {
    const found = [];
    const timedOut = new Set();
    const statuses = {};
    let answered = 0;
    for (const [who, headers] of Object.entries(people)) {
        const needles = needlesFor(who);
        const queue = [...paths];
        await Promise.all(Array.from({ length: concurrency }, async () => {
            while (queue.length) {
                const p = queue.shift();
                const r = await srv.request('GET', p, { headers, timeoutMs });
                if (r.status) answered++;
                if (r.timedOut) timedOut.add(p);
                const cls = r.status ? `${String(r.status)[0]}xx` : 'none';
                statuses[cls] = (statuses[cls] || 0) + 1;
                for (const l of leaks(r, needles)) found.push(`${who}: GET ${p} → ${r.status} carries ${l.label} in its ${l.where}`);
            }
        }));
    }
    return { found, answered, timedOut: [...timedOut], statuses };
}

module.exports = { REPO, ISSUER, tempEnv, seed, networkKeys, boot, listRoutes, expand, getPaths, crawlAll, captureLogs, leaks };
