/**
 * Kiosk omnibar helpers — resolve whether a typed string is a reachable website
 * (and grab its title/favicon) so the /kiosk#input address bar can decide between
 * navigating and searching, without the page making CSP-blocked cross-origin calls.
 *
 * SSRF-guarded: we only ever fetch PUBLIC http(s) hosts; private/loopback/link-local
 * targets are rejected before any outbound request.
 */
const express = require('express');
const dns = require('dns').promises;
const net = require('net');

const router = express.Router();

const FETCH_TIMEOUT_MS = 3500;
const MAX_HTML_BYTES = 200 * 1024;
const MAX_FAVICON_BYTES = 512 * 1024;

function ipv4IsPrivate(ip) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // malformed → treat as unsafe
    if (p[0] === 10) return true;                        // 10.0.0.0/8
    if (p[0] === 127) return true;                       // loopback
    if (p[0] === 0) return true;                         // 0.0.0.0/8
    if (p[0] === 169 && p[1] === 254) return true;       // link-local
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // 172.16/12
    if (p[0] === 192 && p[1] === 168) return true;       // 192.168/16
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT 100.64/10
    return false;
}

function ipIsPrivate(ip) {
    if (net.isIPv4(ip)) return ipv4IsPrivate(ip);
    if (net.isIPv6(ip)) {
        const low = ip.toLowerCase();
        if (low === '::1' || low === '::') return true;      // loopback / unspecified
        if (low.startsWith('fe80')) return true;             // link-local
        if (low.startsWith('fc') || low.startsWith('fd')) return true; // unique-local
        // IPv4-mapped ::ffff:a.b.c.d
        const m = low.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (m) return ipv4IsPrivate(m[1]);
        return false;
    }
    return true; // not an IP → unsafe
}

/** Resolve a hostname's IPs and confirm none are private/loopback (SSRF guard). */
async function hostIsPublic(host) {
    if (!host || typeof host !== 'string') return false;
    host = host.toLowerCase();
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
    // If the host is itself an IP literal, check it directly.
    if (net.isIP(host)) return !ipIsPrivate(host);
    if (!/^[a-z0-9.-]+$/.test(host) || host.length > 253) return false;
    try {
        const addrs = await dns.lookup(host, { all: true });
        if (!addrs.length) return false;
        return addrs.every((a) => !ipIsPrivate(a.address));
    } catch {
        return false;
    }
}

function normalizeUrl(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    try {
        const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        return u;
    } catch { return null; }
}

// ── GET /api/kiosk/site?url=<input> ──────────────────────────────
// { reachable, url, title, favicon, host } — reachable=false ⇒ the omnibar searches instead.
router.get('/site', async (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    const u = normalizeUrl(req.query.url);
    if (!u) return res.json({ reachable: false });

    // "Does this domain exist?" == does it resolve to a PUBLIC IP. This is the reliable signal:
    // plenty of real sites (chatgpt.com and other Cloudflare/bot-protected hosts) return 403 to a
    // server-side GET, so reachability must come from DNS, NOT from the HTTP response. A GET is
    // only used, best-effort, to enrich the suggestion with the page title.
    if (!(await hostIsPublic(u.hostname))) return res.json({ reachable: false });

    let title = '', finalUrl = u.href, finalHost = u.hostname;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
        const r = await fetch(u.href, {
            signal: ac.signal,
            redirect: 'follow',
            headers: {
                // A real browser UA gets past most simple bot walls so we can read the <title>.
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
                'accept': 'text/html,application/xhtml+xml',
            },
        });
        // Follow redirects but keep the favicon/host on a still-public final host.
        try { const fu = new URL(r.url || u.href); if (await hostIsPublic(fu.hostname)) { finalUrl = fu.href; finalHost = fu.hostname; } } catch { /* keep */ }
        const ct = r.headers.get('content-type') || '';
        if (ct.includes('text/html') && r.body?.getReader) {
            const reader = r.body.getReader();
            let received = 0; const chunks = [];
            while (received < MAX_HTML_BYTES) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value); received += value.length;
            }
            try { reader.cancel(); } catch { /* */ }
            const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
            const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
            if (m) title = m[1].replace(/\s+/g, ' ').trim().slice(0, 140);
        }
    } catch { /* blocked / slow / 403 — irrelevant; the domain resolves, so we still navigate */ }
    clearTimeout(timer);

    // Domain resolves → it's a real site → navigate there (title may be empty if the GET was blocked).
    return res.json({
        reachable: true,
        url: finalUrl,
        host: finalHost,
        title,
        favicon: `/api/kiosk/favicon?domain=${encodeURIComponent(finalHost)}`,
    });
});

// ── GET /api/kiosk/favicon?domain=<host> ─────────────────────────
// Proxies a favicon (via DuckDuckGo's icon service — fixed host, no SSRF) so the page
// can show it under a strict img-src 'self' CSP.
router.get('/favicon', async (req, res) => {
    const host = String(req.query.domain || '').trim().toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(host) || host.length > 253) return res.status(400).end();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3000);
    try {
        const r = await fetch(`https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`, { signal: ac.signal });
        clearTimeout(timer);
        if (!r.ok) return res.status(404).end();
        const buf = Buffer.from(await r.arrayBuffer());
        if (!buf.length || buf.length > MAX_FAVICON_BYTES) return res.status(404).end();
        res.setHeader('Content-Type', r.headers.get('content-type') || 'image/x-icon');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.end(buf);
    } catch {
        clearTimeout(timer);
        return res.status(404).end();
    }
});

module.exports = router;
