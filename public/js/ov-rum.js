/* Real-user measurements (server/web/rum.js): this page load's own timings, the time to a live channel's first
 * picture (stream-player.js sets window.__ovFirstFrameAt) and up to three script errors, sent once when the page is
 * hidden. Loaded by app.js on every page load, after the page is idle; nothing identifies the visitor (no
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
    // A page opened in a background tab paints only when it is shown, so its FCP and LCP say when the visitor looked,
    // not how fast it loaded (channel and moments pages reported 28-29 s on 2026-10-20). As web-vitals does, paints
    // count only before the page was first hidden: the browser's visibility-state history (buffered, so it is there
    // though this script loads late), else the state now. A prerendered page is timed from its activation.
    let firstHidden = Infinity;
    try {
        const vis = performance.getEntriesByType('visibility-state');
        if (vis && vis.length) { const h = vis.find((e) => e.name === 'hidden'); if (h) firstHidden = h.startTime; }
        else if (document.visibilityState === 'hidden') firstHidden = 0;
    } catch (e) { if (document.visibilityState === 'hidden') firstHidden = 0; }
    addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && firstHidden === Infinity) firstHidden = performance.now(); }, true);
    const nav0 = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    const activation = (nav0 && nav0.activationStart) || 0;
    const shown = (t) => (t < firstHidden ? Math.max(0, t - activation) : 0);   // 0 = not measured (dropped server-side)
    watch('paint', (e) => { if (e.name === 'first-contentful-paint') m.fcp = shown(e.startTime); });
    watch('largest-contentful-paint', (e) => { const t = shown(e.startTime); if (t) m.lcp = t; });
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
    // "ResizeObserver loop completed with undelivered notifications" is the browser deferring a resize callback to the
    // next frame, not a failure (and the only "error" in the 10-20 snapshot): it is not counted.
    const err = (msg) => { if (m.errs.length < 3 && !/^ResizeObserver loop/.test(String(msg))) m.errs.push(String(msg).slice(0, 140)); };
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
