'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const h = require('openvibe-shared/browser-harness');

if (process.env.OV_SKIP_BROWSER === '1' || !h.findChrome()) {
    console.log('stats-nerds-sheet-chrome: skipped (no Chrome)');
    process.exit(0);
}
const root = path.join(__dirname, '..');
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{color-scheme:dark;--bg-card:#151923;--border:#343947;--text-primary:#f0f2f6;--text-secondary:#b5becd;--text-muted:#9aa5b8;--accent:#68a6ff;--bg-secondary:#222838}
body{margin:0;background:#10141d;color:var(--text-primary);font:15px system-ui}button{cursor:pointer}#page{height:1800px;padding:20px;box-sizing:border-box}
</style><link rel="stylesheet" href="/stats.css"><main id="page"><div id="hero-stats"><button class="hero-stat" data-metric="users" data-tip='{"label":"People","desc":"People on OpenVibe"}'><span class="hero-stat-num" data-n="1200">1,200</span></button></div></main>
<script>window.api=async()=>({kind:'count',before:100,total:735,prev_total:650,points:Array.from({length:30},(_,i)=>({day:'2026-10-'+String(i+1).padStart(2,'0'),value:i+10}))});</script>
<script src="/stats.js"></script><script>document.querySelector('.hero-stat').onclick=e=>openStatsNerds(e.currentTarget)</script>`;
const server = http.createServer((req, res) => {
    const f = req.url === '/stats.css' ? 'public/css/features/stats.css' : req.url === '/stats.js' ? 'public/js/stats-nerds.js' : null;
    if (f) { res.writeHead(200, { 'content-type': f.endsWith('.css') ? 'text/css' : 'application/javascript' }); return res.end(fs.readFileSync(path.join(root, f))); }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(html);
});
(async () => {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-stats-sheet-'));
    const browser = await h.launch({ tmpDir: tmp });
    try {
        const context = await browser.newContext();
        for (const width of [390, 1280]) {
            const p = await h.openPage(browser, context, { width, height: 900 });
            await p.goto(`http://127.0.0.1:${server.address().port}/`, { maxMs: 5000 });
            await p.evaluate('document.querySelector(".hero-stat").focus({preventScroll:true});scrollTo(0,400);window.__before=scrollY;document.querySelector(".hero-stat").click()');
            await new Promise((ok) => setTimeout(ok, 100));
            assert.strictEqual(await p.evaluate('document.body.style.position'), 'fixed', `${width}: page locked`);
            assert.strictEqual(await p.evaluate('document.body.style.top'), await p.evaluate('`${-__before}px`'), `${width}: position kept`);
            if (process.env.OV_SHEETS_SHOTS) {
                fs.mkdirSync(process.env.OV_SHEETS_SHOTS, { recursive: true });
                const shot = await p.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
                fs.writeFileSync(path.join(process.env.OV_SHEETS_SHOTS, `live-stats-${width}.png`), Buffer.from(shot.data, 'base64'));
            }
            await p.evaluate('document.querySelector(".sn-dialog").appendChild(Object.assign(document.createElement("div"),{style:"height:1000px"}))');
            await p.evaluate('document.querySelector(".sn-dialog").scrollTop=100');
            assert.ok(await p.evaluate('document.querySelector(".sn-dialog").scrollTop') > 0, `${width}: sheet scrolls`);
            await p.evaluate('document.querySelector(".sn-close").click()');
            assert.strictEqual(await p.evaluate('Math.round(scrollY)'), await p.evaluate('Math.round(__before)'), `${width}: position restored`);
            assert.strictEqual(await p.evaluate('document.activeElement.className'), 'hero-stat', `${width}: focus restored`);
            if (width === 390) {
                await p.evaluate('document.querySelector(".hero-stat").click()');
                await p.evaluate(`(() => { const head=document.querySelector('.sn-head');
                    const fire=(type,y)=>head.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:6,pointerType:'touch',clientY:y}));
                    fire('pointerdown',200);fire('pointermove',320);fire('pointerup',320); })()`);
                assert.strictEqual(await p.evaluate('document.body.style.position'), '', 'phone: header swipe closes and unlocks');
            }
            await p.close();
        }
        console.log('stats-nerds-sheet-chrome: phone and desktop lock, sheet scroll, position and focus ok');
    } finally { await browser.close(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exit(1); });
