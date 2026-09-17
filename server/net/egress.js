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
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');

// ── Address policy ───────────────────────────────────────────────────────────────────────────
const blocked = new net.BlockList();
for (const [addr, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
    ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
    ['::', 128], ['::1', 128], ['fe80::', 10], ['fec0::', 10], ['fc00::', 7], ['ff00::', 8],
    ['100::', 64], ['2001:db8::', 32], ['2001::', 23],
]) blocked.addSubnet(addr, prefix, 'ipv6');

/** Expand an IPv6 address to 8 numeric groups. */
function v6Groups(ip) {
    let s = ip.toLowerCase().split('%')[0];
    // Trailing dotted IPv4 (::ffff:1.2.3.4) → two hex groups.
    const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) {
        const p = dotted[1].split('.').map(Number);
        s = s.slice(0, -dotted[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
    }
    const [head, tail] = s.split('::');
    const h = head ? head.split(':') : [];
    const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
    const fill = tail !== undefined ? new Array(8 - h.length - t.length).fill('0') : [];
    return [...h, ...fill, ...t].map((g) => parseInt(g || '0', 16));
}
const v4From = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * The IPv4 address an IPv6 address really reaches, for the forms that embed one: v4-mapped
 * (::ffff:a.b.c.d), v4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96) and 6to4 (2002:AABB:CCDD::).
 */
function embeddedV4(ip) {
    const g = v6Groups(ip);
    if (g.length !== 8) return null;
    const zeros = (a, b) => g.slice(a, b).every((x) => x === 0);
    if (zeros(0, 5) && (g[5] === 0xffff || g[5] === 0) && (g[6] || g[7])) return v4From(g[6], g[7]);
    if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return v4From(g[6], g[7]);
    if (g[0] === 0x2002) return v4From(g[1], g[2]);
    return null;
}

/** True only for a public unicast address the server may connect to on a user's behalf. */
function isPublicAddress(ip) {
    const family = net.isIP(String(ip || ''));
    if (family === 4) return !blocked.check(ip, 'ipv4');
    if (family === 6) {
        const v4 = embeddedV4(ip);
        if (v4) return isPublicAddress(v4);
        return !blocked.check(ip.split('%')[0], 'ipv6');
    }
    return false;
}

class EgressDenied extends Error {
    constructor(message) { super(message); this.name = 'EgressDenied'; this.code = 'EGRESS_DENIED'; }
}

/** dns.lookup with the address policy applied to every answer. Drop-in for http/net `lookup`. */
function safeLookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const opts = typeof options === 'number' ? { family: options } : { ...(options || {}) };
    const host = String(hostname || '').replace(/^\[|\]$/g, '');
    const finish = (addrs) => {
        if (!addrs.length) return callback(new EgressDenied(`no address for ${host}`));
        const bad = addrs.find((a) => !isPublicAddress(a.address));
        if (bad) return callback(new EgressDenied(`${host} resolves to a non-public address`));
        if (opts.all) return callback(null, addrs);
        return callback(null, addrs[0].address, addrs[0].family);
    };
    if (net.isIP(host)) return finish([{ address: host, family: net.isIP(host) }]);
    dns.lookup(host, { all: true, family: opts.family || 0 }, (err, addrs) => {
        if (err) return callback(err);
        finish(addrs || []);
    });
}

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
 * GET a URL with the policy enforced at connect time on every redirect hop.
 * Resolves { status, url, headers, text } with text capped at maxBytes.
 */
async function fetchText(url, { timeoutMs = 8000, maxBytes = 512 * 1024, maxRedirects = 4, headers = {} } = {}) {
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
                const done = () => resolve({ status: r.statusCode, headers: r.headers, text: Buffer.concat(chunks).toString('utf8') });
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

module.exports = { isPublicAddress, embeddedV4, safeLookup, assertPublicUrl, fetchText, proxy, EgressDenied };
