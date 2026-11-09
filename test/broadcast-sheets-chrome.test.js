'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const h = require('openvibe-shared/browser-harness');
if (process.env.OV_SKIP_BROWSER === '1' || !h.findChrome()) {
    console.log('broadcast-sheets-chrome: skipped (no Chrome)');
    process.exit(0);
}
const source = fs.readFileSync(path.join(__dirname, '..', 'public/js/broadcast.js'), 'utf8');
function extract(name) {
    const m = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
    assert.ok(m, `${name} exists`);
    let i = source.indexOf('{', m.index + m[0].length), depth = 0;
    for (; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) return source.slice(m.index, i + 1);
    }
    throw new Error(`${name} is unbalanced`);
}
const script = `let _bcMobileChatOpen=false;const _bcSheets=new Set();const _bcSheetOpeners=new Map();let _bcPageBeforeSheet=null;let _bcSheetKeysBound=false;\n${[' _bcLockSheet', '_bcUnlockSheet', '_bcDragSheet', 'toggleBroadcastMobileChat', 'closeCameraSwitcher'].map((name) => extract(name.trim())).join('\n')}`;
const page = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{margin:0;background:#111827;color:white}main{height:1800px}#bc-chat-sidebar{position:fixed;bottom:0;left:0;right:0;height:400px;background:#202b42;transform:translateY(100%)}#bc-chat-sidebar.mobile-chat-open{transform:none}.chat-header{height:50px;touch-action:none}.chat-messages{height:280px;overflow:auto;overscroll-behavior:contain}#bc-camera-sheet{position:fixed;inset:0;background:#0008;align-items:end}.bc-camera-sheet-panel{height:350px;background:#27344a;width:100%}.bc-camera-sheet-header{height:55px;touch-action:none}
</style><button id="bc-mobile-chat-toggle"><i></i>Chat</button><button id="bc-btn-switch-cam">Camera</button><main>Broadcast</main><div id="bc-chat-sidebar"><div class="chat-header">Chat <button onclick="toggleBroadcastMobileChat()">Close</button></div><div class="chat-messages" id="bc-chat-messages"><div style="height:1000px">Messages</div></div></div><span id="bc-mobile-chat-badge">2</span><div id="bc-camera-sheet" style="display:none"><div class="bc-camera-sheet-panel"><div class="bc-camera-sheet-header">Cameras <button onclick="closeCameraSwitcher()">Close</button></div></div></div><script src="/snippet.js"></script>`;
const server = http.createServer((req, res) => {
    if (req.url === '/snippet.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(script); }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(page);
});
(async () => {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-broadcast-sheet-'));
    const browser = await h.launch({ tmpDir: tmp });
    try {
        const context = await browser.newContext(), p = await h.openPage(browser, context, { width: 390, height: 844 });
        await p.goto(`http://127.0.0.1:${server.address().port}/`, { maxMs: 5000 });
        await p.evaluate('scrollTo(0,400);window.__before=scrollY;toggleBroadcastMobileChat()');
        assert.strictEqual(await p.evaluate('document.body.style.position'), 'fixed', 'chat locks the page');
        assert.strictEqual(await p.evaluate('document.body.style.top'), await p.evaluate('`${-__before}px`'), 'chat retains page position');
        await p.evaluate('document.querySelector("#bc-chat-messages").scrollTop=100');
        assert.strictEqual(await p.evaluate('document.querySelector("#bc-chat-messages").scrollTop'), 100, 'chat scrolls');
        await p.evaluate(`(() => {const head=document.querySelector('.chat-header');const fire=(type,y)=>head.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerType:'touch',pointerId:5,clientY:y}));fire('pointerdown',200);fire('pointermove',320);fire('pointerup',320)})()`);
        assert.strictEqual(await p.evaluate('document.body.style.position'), '', 'header swipe closes chat and unlocks');
        assert.strictEqual(await p.evaluate('Math.round(scrollY)'), await p.evaluate('Math.round(__before)'), 'chat restores scroll');
        await p.evaluate('document.querySelector("#bc-camera-sheet").style.display="flex";_bcLockSheet("camera",document.querySelector("#bc-btn-switch-cam"))');
        await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        assert.strictEqual(await p.evaluate('document.querySelector("#bc-camera-sheet").style.display'), 'none', 'Escape closes camera sheet');
        assert.strictEqual(await p.evaluate('document.body.style.position'), '', 'camera close unlocks');
        await p.close();
        console.log('broadcast-sheets-chrome: chat scroll and swipe, camera Escape and page lock ok');
    } finally { await browser.close(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exit(1); });
