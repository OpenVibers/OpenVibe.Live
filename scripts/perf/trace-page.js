#!/usr/bin/env node
'use strict';
// Where does main-thread time go during a page load? Records a Chrome trace and attributes style
// recalculation, layout and script time to the JavaScript function that triggered them.
//
//   node scripts/perf/trace-page.js <url> [--phone-cpu] [--settle 8000] [--top 25] [--tasks]
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

    // --tasks: each main-thread task over 100 ms, with what ran inside it (which task is the long one, not just totals).
    if (args.includes('--tasks')) {
        // The page's main thread: the one that ran the most layout and script (other renderers exist).
        const busy = new Map();
        for (const e of events) if (e.ph === 'X' && (e.name === 'Layout' || e.name === 'FunctionCall')) busy.set(`${e.pid}/${e.tid}`, (busy.get(`${e.pid}/${e.tid}`) || 0) + 1);
        const [mp, mt] = ([...busy.entries()].sort((x, y) => y[1] - x[1])[0] || ['0/0'])[0].split('/').map(Number);
        const main = { pid: mp, tid: mt };
        const nav = events.find((e) => e.name === 'navigationStart' || e.name === 'TracingStartedInBrowser') || events[0];
        const onMain = (e) => main && e.pid === main.pid && e.tid === main.tid;
        const tasks = events.filter((e) => e.ph === 'X' && e.name === 'RunTask' && onMain(e) && e.dur > 100000).sort((x, y) => x.ts - y.ts);
        console.log(`main-thread tasks over 100 ms: ${tasks.length}`);
        for (const t of tasks) {
            const inside = new Map();
            for (const e of events) {
                if (e.ph !== 'X' || !onMain(e) || e.ts < t.ts || e.ts >= t.ts + t.dur || !e.dur || e === t) continue;
                let key = null;
                if ((e.name === 'FunctionCall' || e.name === 'EvaluateScript') && e.args && e.args.data) key = `script ${String(e.args.data.url || '').split('/').pop().split('?')[0]} ${e.args.data.functionName || ''}:${e.args.data.lineNumber || ''}`;
                else if (e.name === 'UpdateLayoutTree' || e.name === 'Layout') { const st = (e.args && e.args.beginData && e.args.beginData.stackTrace) || []; key = `${e.name === 'Layout' ? 'layout' : 'style'} ${frameName(st[0])}`; }
                else if (e.name === 'ParseHTML' || e.name === 'Paint' || e.name === 'TimerFire' || e.name === 'FireAnimationFrame') key = e.name;
                if (key) inside.set(key, (inside.get(key) || 0) + e.dur / 1000);
            }
            const top = [...inside.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, v]) => `${Math.round(v)}ms ${k}`).join(' · ');
            console.log(`  @${Math.round((t.ts - nav.ts) / 1000)}ms ${Math.round(t.dur / 1000)}ms: ${top}`);
        }
    }
})().catch((e) => { console.error(e); process.exit(1); });
