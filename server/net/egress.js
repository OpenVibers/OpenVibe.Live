'use strict';
/**
 * Outbound requests to URLs that strangers choose.
 *
 * Song requests, the kiosk link preview and chat-relay lookups fetch URLs typed by users. The old
 * guard resolved the host, checked the answers, and let the real fetch resolve it again — so a DNS
 * record that answers "public" to the check and "127.0.0.1" to the fetch (rebinding) got through,
 * as did a redirect to an internal address and IPv6 spellings of internal IPv4 addresses such as
 * [::ffff:7f00:1] (loopback) and [::ffff:a9fe:a9fe] (cloud metadata).
 *
 * The rule is enforced where the connection is made, on the address actually connected to:
 *   - `safeLookup` is a dns.lookup replacement that fails when any answer is not a public unicast
 *     address. Node's http/https/net use it at connect time, so there is no second resolution.
 *   - `fetchText` follows redirects itself, applying the rule on every hop.
 *   - `proxy()` is a loopback HTTP proxy for child processes (yt-dlp, and the ffmpeg it drives) that
 *     connects only through `safeLookup`, so the same rule applies to programs we do not control.
 */
const net = require('net');
const http = require('http');
const https = require('https');
// The address policy and the connect-time lookup are openvibe-shared/egress (the one rule Events and
// Tools use too); this file adds Live's fetches and the child-process proxy on top.
const { isPublicAddress, embeddedV4, safeLookup, EgressDenied } = require('openvibe-shared/egress');

function lookupAsync(hostname) {
    return new Promise((resolve, reject) => safeLookup(hostname, { all: true }, (e, a) => (e ? reject(e) : resolve(a))));
}

/** Throws EgressDenied unless `url` is http(s) and its host passes the policy right now. */
async function assertPublicUrl(url) {
    const u = url instanceof URL ? url : new URL(String(url));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new EgressDenied('Only http and https links can be fetched');
    if (u.username || u.password) throw new EgressDenied('Links with credentials are not fetched');
    await lookupAsync(u.hostname);
    return u;
}

/**
 * GET a URL with the policy enforced at connect time on every redirect hop, collecting the body
 * as a Buffer capped at maxBytes. Shared core for fetchText (decodes utf8) and fetchBuffer (raw
 * bytes — images and other binary payloads must never go through a text decode/re-encode).
 * Resolves { status, url, headers, body }.
 */
async function fetchRaw(url, { timeoutMs = 8000, maxBytes = 512 * 1024, maxRedirects = 4, headers = {} } = {}) {
    let current = await assertPublicUrl(url);
    const deadline = Date.now() + timeoutMs;
    for (let hop = 0; hop <= maxRedirects; hop++) {
        const res = await new Promise((resolve, reject) => {
            if (!literalAllowed(current.hostname)) return reject(new EgressDenied('That address is not reachable from here'));
            const mod = current.protocol === 'https:' ? https : http;
            const req = mod.request(current, {
                method: 'GET', lookup: safeLookup, headers: { 'User-Agent': 'OpenVibe.Live link preview', Accept: 'text/html,*/*;q=0.5', ...headers },
                timeout: Math.max(1, deadline - Date.now()),
            }, (r) => {
                if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); return resolve({ redirect: r.headers.location, status: r.statusCode }); }
                const chunks = []; let size = 0;
                r.on('data', (c) => { size += c.length; if (size > maxBytes) { chunks.push(c.subarray(0, c.length - (size - maxBytes))); r.destroy(); } else chunks.push(c); });
                const done = () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks) });
                r.on('end', done); r.on('close', done); r.on('error', reject);
            });
            req.on('timeout', () => req.destroy(new Error('timeout')));
            req.on('error', reject);
            req.end();
        });
        if (!res.redirect) return { ...res, url: current.href };
        current = await assertPublicUrl(new URL(res.redirect, current));
    }
    throw new EgressDenied('Too many redirects');
}

/** GET a URL as decoded utf8 text. Resolves { status, url, headers, text } with text capped at maxBytes. */
async function fetchText(url, opts = {}) {
    const r = await fetchRaw(url, opts);
    return { status: r.status, url: r.url, headers: r.headers, text: r.body.toString('utf8') };
}

/** GET a URL as a raw Buffer (images, fonts, anything binary). Resolves { status, url, headers, body }. */
async function fetchBuffer(url, opts = {}) {
    return fetchRaw(url, opts);
}

/**
 * Node's http and net skip `lookup` entirely when the host is already an IP literal, so a literal
 * has to be checked by hand before connecting. (Found by test: ffmpeg fetched http://127.0.0.1/
 * straight through the proxy.)
 */
function literalAllowed(host) {
    const h = String(host || '').replace(/^\[|\]$/g, '');
    return !net.isIP(h) || isPublicAddress(h);
}

// ── Loopback proxy for child processes ───────────────────────────────────────────────────────
let _proxy = null;
/**
 * Start (once) an HTTP proxy on 127.0.0.1 that forwards CONNECT tunnels and absolute-URI requests
 * only to public addresses. Resolves the proxy URL, e.g. http://127.0.0.1:41234.
 */
function proxy() {
    if (_proxy) return _proxy;
    _proxy = new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            // Plain http:// through the proxy: absolute URI in the request line.
            let target;
            try { target = new URL(req.url); } catch { res.writeHead(400).end(); return; }
            if (target.protocol !== 'http:') { res.writeHead(400).end(); return; }
            if (!literalAllowed(target.hostname)) { res.writeHead(403).end(); return; }
            const headers = { ...req.headers };
            delete headers['proxy-connection']; delete headers['proxy-authorization'];
            const upstream = http.request(target, { method: req.method, headers, lookup: safeLookup }, (up) => {
                res.writeHead(up.statusCode, up.headers);
                up.pipe(res);
            });
            upstream.on('error', (e) => { if (!res.headersSent) res.writeHead(e.code === 'EGRESS_DENIED' ? 403 : 502); res.end(); });
            req.pipe(upstream);
        });
        server.on('connect', (req, clientSocket, head) => {
            const m = String(req.url || '').match(/^\[?([^\]]+?)\]?:(\d+)$/);
            if (!m) { clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
            const port = Number(m[2]);
            if (!literalAllowed(m[1])) { clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
            const upstream = net.connect({ host: m[1], port, lookup: safeLookup }, () => {
                clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head && head.length) upstream.write(head);
                upstream.pipe(clientSocket);
                clientSocket.pipe(upstream);
            });
            upstream.on('error', (e) => {
                if (clientSocket.writable) clientSocket.end(`HTTP/1.1 ${e.code === 'EGRESS_DENIED' ? '403 Forbidden' : '502 Bad Gateway'}\r\n\r\n`);
            });
            clientSocket.on('error', () => upstream.destroy());
        });
        server.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* */ } });
        server.listen(0, '127.0.0.1', () => {
            server.unref();
            resolve(`http://127.0.0.1:${server.address().port}`);
        });
        server.on('error', (e) => { _proxy = null; reject(e); });
    });
    return _proxy;
}

module.exports = { isPublicAddress, embeddedV4, safeLookup, assertPublicUrl, fetchText, fetchBuffer, proxy, EgressDenied };
