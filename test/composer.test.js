'use strict';
// Live's stream chat on the shared composer (openvibe-shared 4.215.0, OpenVibeComposer.mount, preset chat): the
// chat input row becomes form.ovc-v2[data-preset=chat], keeps the textarea's id and .chat-textarea class so
// sendChat() still finds it, and Send sends. Real Chrome at 390 px; skipped without Chrome.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const h = require('openvibe-shared/browser-harness');
if (process.env.OV_SKIP_BROWSER === '1' || !h.findChrome()) { console.log('composer: skipped (no Chrome; set CHROME_BIN)'); process.exit(0); }
const SHARED = process.env.OV_SHARED_DIR || path.join(__dirname, '..', 'node_modules', 'openvibe-shared');
const SITE = path.join(__dirname, '..');
const row = `<div class="chat-input-area"><div class="chat-input-row"><textarea id="chat-input" class="chat-textarea" placeholder="Send a message..." maxlength="500" rows="1"></textarea><button class="chat-send-btn" aria-label="Send message">Send</button></div></div>`;
const server = http.createServer((req, res) => {
    if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Live chat</title><link rel="icon" href="data:,"></head><body style="margin:0;padding:12px;background:#0b1220;color:#e6edf7;font-family:sans-serif"><div id="chat-input-area">${row}</div><script>window.sent=[]; window.sendChat=function(t){ if(!t||!t.value.trim()) return; window.sent.push(t.value.trim()); t.value=''; t.dispatchEvent(new Event('input',{bubbles:true})); };</script><script src="/ov-composer.js"></script><script src="/composer.js"></script></body></html>`);
    }
    if (req.url === '/ov-composer.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(fs.readFileSync(path.join(SHARED, 'ov-composer.js'))); }
    if (req.url === '/composer.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(fs.readFileSync(path.join(SITE, 'public/js/composer.js'))); }
    res.writeHead(404); res.end();
});
(async () => {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${server.address().port}`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-composer-'));
    const browser = await h.launch({ tmpDir });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const page = await h.openPage(browser, await browser.newContext(), { width: 390, height: 900 });
    try {
        await page.goto(base + '/', { maxMs: 6000 });
        for (let i = 0; i < 100 && !(await page.evaluate(`!!document.querySelector('.chat-input-row form.ovc-v2')`)); i++) await wait(40);
        const shape = await page.evaluate(`(() => { const f = document.querySelector('.chat-input-row form'); const t = f.querySelector('textarea'); return { preset: f.dataset.preset, id: t.id, cls: t.className, placeholder: t.placeholder, max: t.maxLength, old: !!f.querySelector('.chat-send-btn') }; })()`);
        assert.deepEqual(shape, { preset: 'chat', id: 'chat-input', cls: 'chat-textarea', placeholder: 'Send a message...', max: 500, old: false });
        assert.equal(await page.evaluate(`document.documentElement.scrollWidth`), 390, 'nothing is wider than a phone');
        await page.evaluate(`(() => { const t = document.querySelector('#chat-input'); t.value = 'Hello stream'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.chat-input-row [data-ovt-send]').click(); })()`);
        for (let i = 0; i < 100 && !(await page.evaluate(`window.sent.length`)); i++) await wait(40);
        assert.deepEqual(await page.evaluate(`window.sent`), ['Hello stream']);
        console.log('composer: the stream chat is the shared chat composer, keeps its id, sends, 390 px');
    } finally {
        await page.close().catch(() => {});
        await browser.close();
        server.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
})().catch((e) => { console.error(e); process.exit(1); });
