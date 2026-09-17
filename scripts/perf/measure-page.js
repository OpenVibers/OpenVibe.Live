#!/usr/bin/env node
'use strict';
// Cold page-load measurement over the DevTools protocol.
//
//   node scripts/perf/measure-page.js <url> [--runs 3] [--phone] [--settle 6000] [--json]
//
// Reports the median of each metric across runs. Every run uses a fresh browser profile with the
// HTTP cache disabled, so numbers describe a first visit. Headless Chrome composites in software,
// so treat FPS-like numbers as relative, never absolute.

const { launch, emulatePhone, sleep } = require('./cdp');

const args = process.argv.slice(2);
const url = args.find((a) => /^https?:/.test(a));
const flag = (name, def) => { const i = args.indexOf(name); return i === -1 ? def : Number(args[i + 1]); };
const RUNS = flag('--runs', 3);
const SETTLE = flag('--settle', 6000);
const PHONE = args.includes('--phone') || args.includes('--phone-cpu');
const PHONE_NET = !args.includes('--phone-cpu');
const JSON_OUT = args.includes('--json');
if (!url) { console.error('usage: measure-page.js <url> [--runs N] [--phone] [--settle ms] [--json]'); process.exit(1); }

const OBSERVERS = `(() => {
  window.__ov = { fcp: 0, lcp: 0, cls: 0, longTasks: [], };
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') __ov.fcp = e.startTime; }).observe({ type: 'paint', buffered: true }); } catch (e) {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) __ov.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch (e) {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) __ov.cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch (e) {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) __ov.longTasks.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
})();`;

async function runOnce() {
    const cdp = await launch();
    const requests = new Map();
    const sockets = [];
    const errors = [];
    cdp.on('Network.requestWillBeSent', (p) => { requests.set(p.requestId, { url: p.request.url, type: p.type, bytes: 0, size: 0 }); });
    cdp.on('Network.responseReceived', (p) => { const r = requests.get(p.requestId); if (r) { r.type = p.type; r.status = p.response.status; } });
    cdp.on('Network.dataReceived', (p) => { const r = requests.get(p.requestId); if (r) r.size += p.dataLength; });
    cdp.on('Network.loadingFinished', (p) => { const r = requests.get(p.requestId); if (r) r.bytes = p.encodedDataLength; });
    cdp.on('Network.webSocketCreated', (p) => sockets.push(p.url));
    cdp.on('Runtime.exceptionThrown', (p) => errors.push(((p.exceptionDetails.exception || {}).description || p.exceptionDetails.text || '').split('\n')[0]));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Performance.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    if (PHONE) await emulatePhone(cdp, { network: PHONE_NET });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVERS });
    await cdp.send('Page.navigate', { url });
    await sleep(SETTLE);

    const page = await cdp.evaluate(`(() => ({
      fcp: Math.round(__ov.fcp), lcp: Math.round(__ov.lcp), cls: +__ov.cls.toFixed(3),
      longTaskMs: Math.round(__ov.longTasks.reduce((s, t) => s + t[1], 0)),
      tbt: Math.round(__ov.longTasks.filter(t => t[0] > __ov.fcp).reduce((s, t) => s + Math.max(0, t[1] - 50), 0)),
      domNodes: document.getElementsByTagName('*').length,
      runningAnimations: document.getAnimations().filter(a => a.playState === 'running').length,
      hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      scripts: [...document.scripts].filter(s => s.src).map(s => new URL(s.src).pathname),
    }))()`);
    const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).result.metrics.map((m) => [m.name, m.value]));
    cdp.close();

    const all = [...requests.values()].filter((r) => !r.url.startsWith('data:'));
    const html = all.find((r) => r.type === 'Document');
    const sum = (type) => all.filter((r) => r.type === type).reduce((s, r) => ({ n: s.n + 1, wire: s.wire + r.bytes, raw: s.raw + r.size }), { n: 0, wire: 0, raw: 0 });
    return {
        htmlWireKB: html ? +(html.bytes / 1024).toFixed(1) : 0,
        htmlRawKB: html ? +(html.size / 1024).toFixed(1) : 0,
        jsCount: sum('Script').n, jsWireKB: +(sum('Script').wire / 1024).toFixed(1), jsRawKB: +(sum('Script').raw / 1024).toFixed(1),
        cssCount: sum('Stylesheet').n, cssWireKB: +(sum('Stylesheet').wire / 1024).toFixed(1), cssRawKB: +(sum('Stylesheet').raw / 1024).toFixed(1),
        requests: all.length,
        totalWireKB: +(all.reduce((s, r) => s + r.bytes, 0) / 1024).toFixed(1),
        webSockets: sockets.length,
        ...page,
        scriptMs: Math.round(metrics.ScriptDuration * 1000),
        styleMs: Math.round(metrics.RecalcStyleDuration * 1000),
        layoutMs: Math.round(metrics.LayoutDuration * 1000),
        taskMs: Math.round(metrics.TaskDuration * 1000),
        heapMB: +(metrics.JSHeapUsedSize / 1048576).toFixed(1),
        errors,
        socketUrls: sockets.map((s) => s.replace(/token=[^&]+/, 'token=…')),
    };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

(async () => {
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(await runOnce());
    const out = {};
    for (const k of Object.keys(runs[0])) {
        out[k] = typeof runs[0][k] === 'number' ? median(runs.map((r) => r[k])) : runs[runs.length - 1][k];
    }
    out.runs = RUNS; out.profile = PHONE ? (PHONE_NET ? 'phone 412x900 4xCPU 1.6Mbps' : 'phone 412x900 4xCPU, network unthrottled') : 'desktop 1366x900 unthrottled'; out.url = url;
    if (JSON_OUT) { console.log(JSON.stringify(out, null, 2)); return; }
    for (const [k, v] of Object.entries(out)) {
        if (k === 'scripts' || k === 'socketUrls' || k === 'errors') console.log(k.padEnd(18), Array.isArray(v) ? `${v.length}: ${v.join(' ')}` : v);
        else console.log(k.padEnd(18), v);
    }
})().catch((e) => { console.error(e); process.exit(1); });
