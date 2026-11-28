'use strict';
/**
 * Real-user measurements: how fast pages are on visitors' own devices, and the script errors they hit. Synthetic
 * checks (scripts/perf, the browser smoke) run on one emulated phone; this is what people actually get.
 *
 * public/js/ov-rum.js runs on every page load (not in automated browsers), after the page is idle, and sends one beacon when the page is
 * hidden: the path, the viewport width, and its own timings (TTFB, FCP, LCP, CLS, INP, blocking time, and the time to a
 * live channel's first picture) plus at most
 * three error messages. Nothing about the visitor is kept: no IP, no account, no user agent. Each beacon becomes
 * numbers in a reservoir per page kind and device class, and errors are counted by message.
 *
 *   POST /api/rum             the beacon (text/plain JSON from navigator.sendBeacon); always 204
 *   rum.snapshot()            p50/p75/p95 per page kind × device, and the most frequent errors (GET /api/admin/rum)
 *   rum.p75Gauge()            the p75s for /metrics (live_rum_p75{metric,page,device})
 *   rum.errorsGauge()         the ten most frequent error messages for /metrics (live_rum_errors{message}), so they can
 *                             be read on the host without a staff session
 *   rum.state() / restore()   the reservoirs as numbers, kept across restarts (at this traffic a deploy otherwise reset
 *                             them before any page had five samples)
 */
const express = require('express');

// ttff: a live channel's first picture (stream-player.js), from navigation; 0 when no live picture showed.
// tplayer: when the player started (the page and the stream's data were in), from navigation; ttff_<path>: ttff again
// under the playback path that showed the picture (2026-11-19: ttff's p75 was 8-10 s and nothing said where it went).
const METRICS = {
    ttfb: 60000, fcp: 60000, lcp: 60000, inp: 60000, tbt: 120000, cls: 10, ttff: 120000,
    tplayer: 120000, ttff_webrtc: 120000, ttff_hls: 120000, ttff_flv: 120000, ttff_jsmpeg: 120000,
    // Before the first paint (2026-11-20): the HTML in (thtml), the last render-blocking stylesheet in (tcss), and the
    // browser's coarse round-trip estimate (rtt, Chrome's Network Information).
    thtml: 60000, tcss: 60000, rtt: 10000,
};
const KEEP = 400;            // samples per reservoir (the newest)
const MAX_ERRORS = 100;      // distinct error messages kept
const PER_MINUTE = 20;       // beacons per address per minute (held in memory for that minute only)

function pageKind(path) {
    const p = String(path || '/');
    if (p === '/') return 'home';
    if (/^\/@[^/]+\/?$/.test(p)) return 'channel';
    if (/^\/vod\//.test(p)) return 'vod';
    if (/^\/clip\//.test(p)) return 'clip';
    if (/^\/(chat|broadcast|dashboard|moments|content|rundown|search)(\/|$)/.test(p)) return p.split('/')[1];
    return 'other';
}
const deviceClass = (w) => (w > 0 && w < 600 ? 'phone' : w > 0 && w < 1024 ? 'tablet' : 'desktop');
const pct = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
const round = (v, metric) => (metric === 'cls' ? Math.round(v * 1000) / 1000 : Math.round(v));

function createRum({ now = () => Date.now() } = {}) {
    const buckets = new Map();   // "page|device" -> { n, samples: { metric: [] } }
    const errors = new Map();    // message -> count
    // message -> when it was last seen (ms). 11-20: the counts are kept across restarts for 14 days and said nothing of
    // when, so errors fixed weeks ago (#328's null player, a removed showToast) read as current. One unseen for a week
    // is dropped when the state is put back.
    const errorLast = new Map();
    const ERROR_KEEP_MS = 7 * 86400000;
    const hits = new Map();      // address -> { minute, n }
    // Slow interactions (INP over 200 ms) by page and what they were on ("click button#bc-go-live", ov-rum.js), so the
    // slow tap is named (2026-11-20). Kept in memory: counts and the worst.
    const slow = new Map();      // "page|on" -> { n, worst }
    const MAX_SLOW = 200;
    // What moved most in a page's worst window of layout shifts (ov-rum.js cls_on: a tag with its id or first class), by
    // page and device class, for a CLS of 0.05 or more (11-28: the home's tablet p75 was 0.345 and nothing said what
    // moved). Kept in memory, like slow taps: counts and the worst.
    const shifts = new Map();    // "page|device|on" -> { n, worst }
    const MAX_SHIFTS = 200;
    const ON_RE = /^[a-z][a-z0-9]{0,15}([#.][A-Za-z][\w-]{0,40})?$/;

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
        const on = String(body.inp_on || '');
        const inp = Number(body.inp);
        if (inp > 200 && inp <= METRICS.inp && /^[a-z]{2,20}( [a-z][a-z0-9]{0,15}([#.][A-Za-z][\w-]{0,40})?)?$/.test(on)) {
            const k = `${pageKind(body.path)}|${on}`;
            const s = slow.get(k) || (slow.size < MAX_SLOW ? { n: 0, worst: 0 } : null);
            if (s) { s.n++; s.worst = Math.max(s.worst, Math.round(inp)); slow.set(k, s); }
        }
        const clsOn = String(body.cls_on || '');
        const cls = Number(body.cls);
        if (cls >= 0.05 && cls <= METRICS.cls && ON_RE.test(clsOn)) {
            const k = `${key}|${clsOn}`;
            const s = shifts.get(k) || (shifts.size < MAX_SHIFTS ? { n: 0, worst: 0 } : null);
            if (s) { s.n++; s.worst = Math.max(s.worst, Math.round(cls * 1000) / 1000); shifts.set(k, s); }
        }
        for (const raw of Array.isArray(body.errs) ? body.errs.slice(0, 3) : []) {
            const msg = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 140);
            if (!msg) continue;
            errors.set(msg, (errors.get(msg) || 0) + 1);
            errorLast.set(msg, now());
            if (errors.size > MAX_ERRORS) {
                let least = null;
                for (const [k, c] of errors) if (k !== msg && (!least || c < errors.get(least))) least = k;
                errors.delete(least);
                errorLast.delete(least);
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
        const errs = [...errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
            .map(([message, count]) => ({ message, count, last: errorLast.has(message) ? new Date(errorLast.get(message)).toISOString() : null }));
        const slowTaps = [...slow.entries()].sort((a, b) => b[1].n - a[1].n || b[1].worst - a[1].worst).slice(0, 25)
            .map(([k, s]) => { const i = k.indexOf('|'); return { page: k.slice(0, i), on: k.slice(i + 1), count: s.n, worst: s.worst }; });
        const moved = [...shifts.entries()].sort((a, b) => b[1].n - a[1].n || b[1].worst - a[1].worst).slice(0, 25)
            .map(([k, s]) => { const [page, device, ...on] = k.split('|'); return { page, device, on: on.join('|'), count: s.n, worst: s.worst }; });
        return { pages, errors: errs, slow: slowTaps, shifts: moved };
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

    /** The reservoirs and error counts as plain numbers, to survive a restart (server/index.js keeps them in app_state). */
    function state() {
        return { v: 1, at: now(), pages: Object.fromEntries(buckets), errors: [...errors].map(([m, c]) => [m, c, errorLast.get(m) || null]) };
    }
    /** Put a saved state back under what arrived since boot (a beacon can land before the read). Older than 14 days,
     *  malformed or out-of-range parts are left out. */
    function restore(s) {
        if (!s || s.v !== 1 || typeof s.pages !== 'object' || !(now() - Number(s.at) < 14 * 86400000)) return false;
        for (const [key, saved] of Object.entries(s.pages)) {
            if (!/^[a-z]+\|(phone|tablet|desktop)$/.test(key) || !saved || typeof saved.samples !== 'object') continue;
            const b = buckets.get(key) || { n: 0, samples: Object.fromEntries(Object.keys(METRICS).map((m) => [m, []])) };
            b.n += Math.max(0, Number(saved.n) || 0);
            for (const [m, max] of Object.entries(METRICS)) {
                const old = (Array.isArray(saved.samples[m]) ? saved.samples[m] : []).map(Number).filter((v) => Number.isFinite(v) && v >= 0 && v <= max);
                b.samples[m] = old.concat(b.samples[m]).slice(-KEEP);
            }
            buckets.set(key, b);
        }
        for (const [msg, c, last] of Array.isArray(s.errors) ? s.errors.slice(0, MAX_ERRORS) : []) {
            if (typeof msg !== 'string' || !msg || errors.size >= MAX_ERRORS) continue;
            // A save from before last-seen was kept counts from its own time, so it ages out a week from now.
            const seen = Number.isFinite(Number(last)) && Number(last) > 0 ? Number(last) : Number(s.at);
            if (now() - seen > ERROR_KEEP_MS) continue;
            const k = msg.slice(0, 140);
            errors.set(k, (errors.get(k) || 0) + (Number(c) || 0));
            errorLast.set(k, Math.max(errorLast.get(k) || 0, seen));
        }
        return true;
    }

    return { router, record, snapshot, p75Gauge, errorsGauge, state, restore };
}

module.exports = { createRum, pageKind, deviceClass };
