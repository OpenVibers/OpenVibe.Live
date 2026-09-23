#!/usr/bin/env node
/**
 * Browser smoke suite: real Chrome against a running server.
 *
 *   BASE=http://127.0.0.1:4188 npm run test:browser
 *   BASE=https://openvibe.live node test/browser/smoke.js --routes-only
 *
 * Needs a running site and Chrome (CHROME_BIN or /usr/bin/google-chrome); it is not part of
 * `npm test`. No camera or microphone is used.
 *
 * Checks, and fails on:
 *   1. every route renders its page with no uncaught exception, at 320/412/768/1440px wide, with no
 *      horizontal overflow and no skeleton still showing after the settle time;
 *   2. SPA navigation and back/forward land on the right page;
 *   3. a script is never loaded twice;
 *   4. navigating a loop of routes three times does not keep adding timers, sockets, document or
 *      window listeners, or DOM nodes (leaks are measured between the 2nd and 3rd lap, after warm-up).
 */
'use strict';
const { launch, sleep } = require('../../scripts/perf/cdp');

const BASE = (process.env.BASE || 'http://127.0.0.1:4188').replace(/\/$/, '');
const ROUTES_ONLY = process.argv.includes('--routes-only');
const SETTLE = Number(process.env.SETTLE || 3500);

const ROUTES = [
    ['/', 'page-home'], ['/vods', 'page-vods'], ['/clips', 'page-clips'], ['/pastes', 'page-pastes'],
    ['/chat', 'page-chat'], ['/arena', 'page-arena'], ['/broadcast', 'page-broadcast'], ['/documentation', 'page-documentation'],
    ['/updates', 'page-updates'], ['/dashboard', null], [process.env.CHANNEL || '/@admin', 'page-channel'],
    // Answered 404 by the server (server/web/page-status.js) with the same shell.
    ['/no-such-page', 'page-not-found'],
];
const ONLY_SIGNED = process.argv.includes('--signed-in-only');
const WIDTHS = ONLY_SIGNED ? [] : ROUTES_ONLY ? [1366] : [320, 412, 768, 1440];

// Counters installed before any page script runs.
const INSTRUMENT = `(() => {
  const w = window; const live = { intervals: new Set(), sockets: new Set() };
  const si = w.setInterval, ci = w.clearInterval;
  w.setInterval = function (...a) { const id = si.apply(this, a); live.intervals.add(id); return id; };
  w.clearInterval = function (id) { live.intervals.delete(id); return ci.call(this, id); };
  const WS = w.WebSocket;
  if (WS) {
    w.WebSocket = function (...a) { const s = new WS(...a); live.sockets.add(s); s.addEventListener('close', () => live.sockets.delete(s)); return s; };
    w.WebSocket.prototype = WS.prototype; Object.assign(w.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  }
  // Count what the browser actually keeps: re-adding the same (type, listener, capture) is a no-op.
  const counts = {};
  for (const target of [w, document]) {
    const add = target.addEventListener, rem = target.removeEventListener; const key = target === w ? 'window' : 'document';
    const reg = new Map(); counts[key] = () => [...reg.values()].reduce((n, m) => n + [...m.values()].reduce((k, s) => k + s.size, 0), 0);
    const cap = (o) => !!(o === true || (o && o.capture));
    target.addEventListener = function (t, fn, o) {
      if (fn && !(o && o.once)) { if (!reg.has(t)) reg.set(t, new Map()); const m = reg.get(t); if (!m.has(fn)) m.set(fn, new Set()); m.get(fn).add(cap(o)); }
      return add.call(this, t, fn, o);
    };
    target.removeEventListener = function (t, fn, o) { const m = reg.get(t); if (m && m.has(fn)) { m.get(fn).delete(cap(o)); if (!m.get(fn).size) m.delete(fn); } return rem.call(this, t, fn, o); };
  }
  w.__ovProbe = () => ({ intervals: live.intervals.size, sockets: [...live.sockets].filter(s => s.readyState < 2).length,
    windowListeners: counts.window(), documentListeners: counts.document(), domNodes: document.getElementsByTagName('*').length });
})();`;

let failures = 0;
const fail = (msg) => { failures++; console.log('  ✗', msg); };
const pass = (msg) => console.log('  ✓', msg);

async function openPage(width) {
    const cdp = await launch({ width, height: 900 });
    const errors = [];
    const scripts = [];
    cdp.on('Runtime.exceptionThrown', (p) => errors.push(((p.exceptionDetails.exception || {}).description || p.exceptionDetails.text || '').split('\n')[0]));
    cdp.on('Network.requestWillBeSent', (p) => { if (p.type === 'Script') scripts.push(p.request.url); });
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 700 });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
    return { cdp, errors, scripts };
}

const pageState = `(() => ({
  active: (document.querySelector('.page.active') || {}).id || null,
  path: location.pathname,
  hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  overflowers: [...document.querySelectorAll('.page.active *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > document.documentElement.clientWidth + 1 && getComputedStyle(e).position !== 'fixed'; }).slice(0, 3).map(e => (e.id ? '#' + e.id : e.className && String(e.className).split(' ')[0]) || e.tagName),
  skeletons: [...document.querySelectorAll('.page.active .ovsk, .page.active .skeleton, .page.active [data-skeleton]')].filter(e => e.offsetParent !== null).length,
}))()`;

(async () => {
    console.log(`Browser smoke against ${BASE}`);

    // 1. Direct loads at each width.
    for (const width of WIDTHS) {
        const { cdp, errors } = await openPage(width);
        for (const [route, expected] of ROUTES) {
            errors.length = 0;
            await cdp.send('Page.navigate', { url: BASE + route });
            await sleep(SETTLE);
            let st = await cdp.evaluate(pageState);
            // Skeletons must resolve; a route that redirects (signed-out /dashboard → home) loads the
            // next route's code first, so allow it a few more seconds before calling it stuck.
            for (let i = 0; i < 10 && st.skeletons; i++) { await sleep(500); st = await cdp.evaluate(pageState); }
            const label = `${String(width).padStart(4)}px ${route}`;
            const problems = [];
            if (expected && st.active !== expected) problems.push(`active=${st.active}, expected ${expected}`);
            if (errors.length) problems.push(`errors: ${errors.slice(0, 2).join(' | ')}`);
            if (st.hscroll) problems.push(`horizontal overflow (${st.overflowers.join(', ')})`);
            if (st.skeletons) problems.push(`${st.skeletons} skeleton(s) still showing`);
            if (problems.length) fail(`${label}: ${problems.join('; ')}`); else pass(label);
        }
        cdp.close();
    }
    if (ROUTES_ONLY) return finish();

    // Signed in (TOKEN=hbt_… API token for a local account): the pages that only render for a user,
    // reached both directly (markup inlined by the server) and by SPA navigation (fragment fetched).
    if (process.env.TOKEN) {
        const { cdp, errors } = await openPage(1366);
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('token', ${JSON.stringify(process.env.TOKEN)}); } catch (e) {}` });
        const checks = [
            ['/dashboard', 'page-dashboard', '#dash-tabs'],
            ['/broadcast', 'page-broadcast', '#bc-chat-input, #page-broadcast .bc-ws, #page-broadcast [id^="bc-"]'],
            ['/chat', 'page-chat', '#global-chat-messages'],
        ];
        for (const [route, page, marker] of checks) {
            for (const mode of ['direct', 'spa']) {
                errors.length = 0;
                if (mode === 'direct') { await cdp.send('Page.navigate', { url: BASE + route }); await sleep(SETTLE + 1500); }
                else { await cdp.send('Page.navigate', { url: BASE + '/' }); await sleep(SETTLE); await cdp.evaluate(`navigate(${JSON.stringify(route)})`); await sleep(SETTLE); }
                const st = await cdp.evaluate(`(() => ({ active: (document.querySelector('.page.active') || {}).id, marker: !!document.querySelector(${JSON.stringify(marker)}), user: (typeof currentUser !== 'undefined' && !!currentUser), loaded: (document.getElementById(${JSON.stringify(page)}) || {dataset:{}}).dataset.fragmentLoaded || null }))()`);
                const problems = [];
                if (!st.user) problems.push('not signed in');
                if (st.active !== page) problems.push(`active=${st.active}`);
                if (!st.marker) problems.push('page markup missing');
                if (errors.length) problems.push(`errors: ${errors.slice(0, 2).join(' | ')}`);
                const label = `signed in, ${mode} ${route}`;
                if (problems.length) fail(`${label}: ${problems.join('; ')}`); else pass(label);
            }
        }
        cdp.close();
    }
    if (ONLY_SIGNED) return finish();

    // 2 + 3. SPA navigation, back/forward, duplicate script loads.
    {
        const { cdp, errors, scripts } = await openPage(1366);
        await cdp.send('Page.navigate', { url: BASE + '/' });
        await sleep(SETTLE);
        const go = async (p) => { await cdp.evaluate(`navigate(${JSON.stringify(p)})`); await sleep(1500); return cdp.evaluate(pageState); };
        const a = await go('/vods');
        const b = await go('/chat');
        const c = await go('/broadcast');
        await cdp.evaluate('history.back()'); await sleep(1500);
        const back = await cdp.evaluate(pageState);
        await cdp.evaluate('history.forward()'); await sleep(1500);
        const fwd = await cdp.evaluate(pageState);
        const ok = a.active === 'page-vods' && b.active === 'page-chat' && c.active === 'page-broadcast' && back.active === 'page-chat' && fwd.active === 'page-broadcast';
        if (ok) pass('SPA navigate + back/forward land on the right page'); else fail(`navigation: ${[a, b, c, back, fwd].map(s => s.active).join(' → ')}`);
        const seen = new Map();
        for (const u of scripts) { const k = u.split('?')[0]; seen.set(k, (seen.get(k) || 0) + 1); }
        const dupes = [...seen].filter(([, n]) => n > 1);
        if (dupes.length) fail(`scripts requested more than once: ${dupes.map(([k, n]) => `${k.split('/').pop()}×${n}`).join(', ')}`); else pass(`no script requested twice (${seen.size} scripts)`);
        if (errors.length) fail(`errors during navigation: ${errors.slice(0, 3).join(' | ')}`); else pass('no errors during navigation');
        cdp.close();
    }

    // 3b. Chat: rows render, the view follows the conversation, and the popout is the same chat.
    if (!ONLY_SIGNED && !ROUTES_ONLY) {
        const { cdp, errors } = await openPage(1366);
        await cdp.send('Page.navigate', { url: BASE + '/chat' });
        await sleep(SETTLE + 2000);
        const st = await cdp.evaluate(`(() => {
            const box = document.getElementById('global-chat-messages');
            if (!box) return { err: 'no global chat container' };
            return { rows: box.querySelectorAll('.chat-msg').length, gap: Math.round(box.scrollHeight - box.scrollTop - box.clientHeight), pinned: window._chatPinned };
        })()`);
        if (st.err) fail(`chat: ${st.err}`);
        else if (st.gap > 120) fail(`chat: not following the conversation after load (${st.gap}px from the bottom)`);
        else pass(`chat renders and stays pinned to the bottom (${st.rows} rows)`);
        // Growth that isn't the reader (a late image, a translation line) must not unpin chat.
        const after = await cdp.evaluate(`(() => {
            const box = document.getElementById('global-chat-messages');
            const filler = document.createElement('div'); filler.style.height = '400px'; filler.className = 'chat-msg';
            box.appendChild(filler);
            return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r({ gap: Math.round(box.scrollHeight - box.scrollTop - box.clientHeight), pinned: window._chatPinned }))));
        })()`);
        if (after.gap > 120) fail(`chat: content growth unpinned the view (${after.gap}px from the bottom)`);
        else pass('chat keeps following when content grows under it');
        await cdp.send('Page.navigate', { url: BASE + '/popout/global' });
        await sleep(SETTLE);
        const pop = await cdp.evaluate(`({ rows: document.querySelectorAll('#pc-msgs .chat-msg').length, hasInput: !!document.getElementById('pc-input') })`);
        if (!pop.hasInput) fail('popout chat did not render');
        else pass(`popout chat renders (${pop.rows} rows)`);
        if (errors.length) fail(`errors on chat pages: ${errors.slice(0, 3).join(' | ')}`);
        cdp.close();
    }

    // 4. Leak check over repeated laps.
    {
        const { cdp, errors } = await openPage(1366);
        await cdp.send('Page.navigate', { url: BASE + '/' });
        await sleep(SETTLE);
        const ch = process.env.CHANNEL || '/@admin';
        const lap = [ch, '/chat', '/dashboard', '/', '/broadcast', ch, '/', '/vods', '/'];
        const probes = [];
        for (let i = 0; i < 3; i++) {
            for (const p of lap) { await cdp.evaluate(`navigate(${JSON.stringify(p)})`); await sleep(1200); }
            await sleep(2000);
            probes.push(await cdp.evaluate('__ovProbe()'));
        }
        const [, second, third] = probes;
        const grew = Object.keys(third).filter((k) => {
            const slack = k === 'domNodes' ? 150 : 2;
            return third[k] - second[k] > slack;
        });
        console.log('    lap probes:', probes.map((p) => JSON.stringify(p)).join('\n                '));
        if (grew.length) fail(`resources still growing on lap 3: ${grew.map((k) => `${k} ${second[k]}→${third[k]}`).join(', ')}`);
        else pass('repeated navigation does not keep adding timers, sockets, listeners or DOM');
        if (errors.length) fail(`errors during laps: ${errors.slice(0, 3).join(' | ')}`);
        cdp.close();
    }
    finish();
})().catch((e) => { console.error(e); process.exit(1); });

function finish() {
    console.log(failures ? `\n${failures} browser check(s) failed` : '\nbrowser smoke: all checks passed');
    process.exit(failures ? 1 : 0);
}
