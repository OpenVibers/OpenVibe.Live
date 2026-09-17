#!/usr/bin/env node
'use strict';
// Where does main-thread time go during a page load? Records a Chrome trace and attributes style
// recalculation, layout and script time to the JavaScript function that triggered them.
//
//   node scripts/perf/trace-page.js <url> [--phone-cpu] [--settle 8000] [--top 25]
const { launch, emulatePhone, sleep } = require('./cdp');

const args = process.argv.slice(2);
const url = args.find((a) => /^https?:/.test(a));
const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : Number(args[i + 1]); };
const SETTLE = flag('--settle', 8000);
const TOP = flag('--top', 25);

(async () => {
    const cdp = await launch();
    const events = [];
    cdp.on('Tracing.dataCollected', (p) => { for (const e of p.value) events.push(e); });
    const done = new Promise((r) => cdp.on('Tracing.tracingComplete', r));
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    if (args.includes('--phone-cpu')) await emulatePhone(cdp, { network: false });
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack,v8.execute', transferMode: 'ReportEvents' });
    await cdp.send('Page.navigate', { url });
    await sleep(SETTLE);
    await cdp.send('Tracing.end');
    await done;
    cdp.close();

    const mainPid = (events.find((e) => e.name === 'TracingStartedInBrowser') || {}).pid;
    const byKind = {};
    const byCaller = new Map();
    const frameName = (f) => f ? `${f.functionName || '(anonymous)'} ${String(f.url || '').split('/').pop().split('?')[0]}:${f.lineNumber}` : '(no stack)';
    for (const e of events) {
        if (e.ph !== 'X' && e.ph !== 'B') continue;
        const kind = { UpdateLayoutTree: 'style', Layout: 'layout', FunctionCall: 'script', EvaluateScript: 'script', TimerFire: 'timer', FireAnimationFrame: 'raf', ParseHTML: 'parse', Paint: 'paint', ParseAuthorStyleSheet: 'css-parse' }[e.name];
        if (!kind || !e.dur) continue;
        const ms = e.dur / 1000;
        byKind[kind] = (byKind[kind] || 0) + ms;
        if (kind === 'style' || kind === 'layout') {
            const stack = (e.args && e.args.beginData && e.args.beginData.stackTrace) || (e.args && e.args.data && e.args.data.stackTrace);
            const key = `${kind.padEnd(6)} ${frameName(stack && stack[0])}`;
            byCaller.set(key, (byCaller.get(key) || 0) + ms);
        }
        if (kind === 'script' && e.args && e.args.data && e.args.data.url) {
            const key = `script ${String(e.args.data.url).split('/').pop().split('?')[0]} ${e.args.data.functionName || ''}:${e.args.data.lineNumber || ''}`;
            byCaller.set(key, (byCaller.get(key) || 0) + ms);
        }
    }
    void mainPid;
    console.log('totals (ms):', Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, Math.round(v)])));
    console.log(`top ${TOP} triggers:`);
    [...byCaller.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP).forEach(([k, v]) => console.log(`  ${String(Math.round(v)).padStart(6)}ms  ${k}`));
})().catch((e) => { console.error(e); process.exit(1); });
