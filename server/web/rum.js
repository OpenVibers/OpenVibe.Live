'use strict';
/**
 * Real-user measurements: how fast pages are on visitors' own devices, and the script errors they hit. Synthetic
 * checks (scripts/perf, the browser smoke) run on one emulated phone; this is what people actually get.
 *
 * public/js/ov-rum.js runs on one page load in four, after the page is idle, and sends one beacon when the page is
 * hidden: the path, the viewport width, and its own timings (TTFB, FCP, LCP, CLS, INP, blocking time) plus at most
 * three error messages. Nothing about the visitor is kept: no IP, no account, no user agent. Each beacon becomes
 * numbers in a reservoir per page kind and device class, and errors are counted by message.
 *
 *   POST /api/rum             the beacon (text/plain JSON from navigator.sendBeacon); always 204
 *   rum.snapshot()            p50/p75/p95 per page kind × device, and the most frequent errors (GET /api/admin/rum)
 *   rum.p75Gauge()            the p75s for /metrics (live_rum_p75{metric,page,device})
 *   rum.errorsGauge()         the ten most frequent error messages for /metrics (live_rum_errors{message}), so they can
 *                             be read on the host without a staff session
 */
const express = require('express');

const METRICS = { ttfb: 60000, fcp: 60000, lcp: 60000, inp: 60000, tbt: 120000, cls: 10 };
const KEEP = 400;            // samples per reservoir (the newest)
const MAX_ERRORS = 100;      // distinct error messages kept
const PER_MINUTE = 20;       // beacons per address per minute (held in memory for that minute only)

function pageKind(path) {
    const p = String(path || '/');
    if (p === '/') return 'home';
    if (/^\/@[^/]+\/?$/.test(p)) return 'channel';
    if (/^\/vod\//.test(p)) return 'vod';
    if (/^\/clip\//.test(p)) return 'clip';
    if (/^\/(chat|broadcast|dashboard|moments|content|arena|search)(\/|$)/.test(p)) return p.split('/')[1];
    return 'other';
}
const deviceClass = (w) => (w > 0 && w < 600 ? 'phone' : w > 0 && w < 1024 ? 'tablet' : 'desktop');
const pct = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
const round = (v, metric) => (metric === 'cls' ? Math.round(v * 1000) / 1000 : Math.round(v));

function createRum({ now = () => Date.now() } = {}) {
    const buckets = new Map();   // "page|device" -> { n, samples: { metric: [] } }
    const errors = new Map();    // message -> count
    const hits = new Map();      // address -> { minute, n }

    function record(body) {
        if (!body || typeof body !== 'object') return false;
        const key = `${pageKind(body.path)}|${deviceClass(Number(body.w))}`;
        let b = buckets.get(key);
        if (!b) { b = { n: 0, samples: Object.fromEntries(Object.keys(METRICS).map((m) => [m, []])) }; buckets.set(key, b); }
        b.n++;
        for (const [m, max] of Object.entries(METRICS)) {
            const v = Number(body[m]);
            if (!Number.isFinite(v) || v < 0 || v > max) continue;
            if (m !== 'cls' && m !== 'tbt' && m !== 'inp' && v === 0) continue;   // not measured (0 is real only for these)
            const arr = b.samples[m];
            arr.push(v);
            if (arr.length > KEEP) arr.shift();
        }
        for (const raw of Array.isArray(body.errs) ? body.errs.slice(0, 3) : []) {
            const msg = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 140);
            if (!msg) continue;
            errors.set(msg, (errors.get(msg) || 0) + 1);
            if (errors.size > MAX_ERRORS) {
                let least = null;
                for (const [k, c] of errors) if (k !== msg && (!least || c < errors.get(least))) least = k;
                errors.delete(least);
            }
        }
        return true;
    }

    function allowed(addr) {
        const minute = Math.floor(now() / 60000);
        const h = hits.get(addr);
        if (!h || h.minute !== minute) {
            if (hits.size > 5000) hits.clear();
            hits.set(addr, { minute, n: 1 });
            return true;
        }
        return ++h.n <= PER_MINUTE;
    }

    const router = express.Router();
    router.post('/', express.text({ type: () => true, limit: '4kb' }), (req, res) => {
        res.status(204).end();
        const addr = req.headers['cf-connecting-ip'] || req.ip || '';
        if (!allowed(addr)) return;
        let body = null;
        try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; } catch { body = null; }
        record(body);
    });

    function snapshot() {
        const pages = {};
        for (const [key, b] of buckets) {
            const out = { beacons: b.n };
            for (const [m, arr] of Object.entries(b.samples)) {
                if (!arr.length) continue;
                const s = [...arr].sort((x, y) => x - y);
                out[m] = { n: s.length, p50: round(pct(s, 0.5), m), p75: round(pct(s, 0.75), m), p95: round(pct(s, 0.95), m) };
            }
            pages[key] = out;
        }
        const errs = [...errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([message, count]) => ({ message, count }));
        return { pages, errors: errs };
    }

    function p75Gauge() {
        const out = [];
        for (const [key, b] of buckets) {
            const [page, device] = key.split('|');
            for (const [m, arr] of Object.entries(b.samples)) {
                if (arr.length < 5) continue;   // too few to mean anything
                const s = [...arr].sort((x, y) => x - y);
                out.push({ labels: { metric: m, page, device }, value: round(pct(s, 0.75), m) });
            }
        }
        return out;
    }

    function errorsGauge() {
        return [...errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([message, count]) => ({ labels: { message: message.slice(0, 100) }, value: count }));
    }

    return { router, record, snapshot, p75Gauge, errorsGauge };
}

module.exports = { createRum, pageKind, deviceClass };
