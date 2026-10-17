/* Real-user measurements (server/web/rum.js): this page load's own timings, the time to a live channel's first
 * picture (stream-player.js sets window.__ovFirstFrameAt) and up to three script errors, sent once when the page is
 * hidden. Loaded by app.js on one page load in four, after the page is idle; nothing identifies the visitor (no
 * account, no id, no cookie). The observers read buffered entries, so the paints before this script loaded count.
 */
(function () {
    'use strict';
    if (!('PerformanceObserver' in window) || !navigator.sendBeacon) return;
    // Automated browsers are not visitors: crawlers that run scripts, headless test runs (ours included). Checked here
    // only; the user agent is never sent.
    if (navigator.webdriver || /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|phantom|puppeteer|playwright/i.test(navigator.userAgent || '')) return;
    const m = { fcp: 0, lcp: 0, cls: 0, inp: 0, tbt: 0, errs: [] };
    const watch = (type, fn, extra) => {
        try { new PerformanceObserver((list) => list.getEntries().forEach(fn)).observe(Object.assign({ type, buffered: true }, extra)); } catch (e) { /* not in this browser */ }
    };
    watch('paint', (e) => { if (e.name === 'first-contentful-paint') m.fcp = e.startTime; });
    watch('largest-contentful-paint', (e) => { m.lcp = e.startTime; });
    // CLS as web-vitals defines it: the worst window of shifts under 1 s apart, at most 5 s long.
    let win = 0, first = 0, last = 0;
    watch('layout-shift', (e) => {
        if (e.hadRecentInput) return;
        if (e.startTime - last > 1000 || e.startTime - first > 5000) { win = 0; first = e.startTime; }
        win += e.value; last = e.startTime;
        if (win > m.cls) m.cls = win;
    });
    watch('longtask', (e) => { if (m.fcp && e.startTime > m.fcp) m.tbt += Math.max(0, e.duration - 50); });
    watch('event', (e) => { if (e.interactionId && e.duration > m.inp) m.inp = e.duration; }, { durationThreshold: 40 });
    const err = (msg) => { if (m.errs.length < 3) m.errs.push(String(msg).slice(0, 140)); };
    addEventListener('error', (e) => err(e.message || 'error'));
    addEventListener('unhandledrejection', (e) => err('unhandled rejection: ' + ((e.reason && e.reason.message) || e.reason)));
    let sent = false;
    const send = () => {
        if (sent) return;
        sent = true;
        const nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
        const r = (v) => Math.round(v);
        let path = location.pathname;   // the page these timings are for: the one loaded, not where the SPA went since
        try { if (nav) path = new URL(nav.name).pathname; } catch (e) { /* keep */ }
        navigator.sendBeacon('/api/rum', JSON.stringify({
            path, w: innerWidth, ttfb: nav ? r(nav.responseStart) : 0, ttff: r(window.__ovFirstFrameAt || 0),
            fcp: r(m.fcp), lcp: r(m.lcp), cls: Math.round(m.cls * 1000) / 1000, inp: r(m.inp), tbt: r(m.tbt), errs: m.errs,
        }));
    };
    addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') send(); });
    addEventListener('pagehide', send);
})();
