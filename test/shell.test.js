'use strict';
// The shell on the server's side (server/web/sw.js): the early hints (the page's Link header; never a 103 through nginx
// 1.28, which takes it as the final answer) and the manifest the
// shared worker reads to warm the shell by content hash.
const assert = require('assert');
const assets = require('../server/web/assets');
// The shared files are served from the pinned openvibe-shared package (the server sets this at startup).
try { assets.setSharedDir(require('openvibe-shared/files').dir); } catch { /* */ }
const shell = require('../server/web/sw');

function fakeRes() {
    const res = { headersSent: false, headers: {}, hints: null };
    res.writeEarlyHints = (h) => { res.hints = h; return true; };
    res.setHeader = (k, v) => { res.headers[k] = v; };
    return res;
}

{   // A page is hinted in its Link header; no 103 goes out (nginx 1.28 would send the page as the 103's body).
    const res = fakeRes();
    let nexted = false;
    shell.hints()({ method: 'GET', path: '/', headers: { accept: 'text/html' } }, res, () => { nexted = true; });
    assert.ok(nexted, 'the request goes on');
    assert.strictEqual(res.hints, null, 'no 103');
    const link = res.headers.Link || '';
    assert.ok(link.indexOf('rel=preload') >= 0, 'the links are preloads');
    assert.ok(/as=script/.test(link) && /as=style/.test(link), 'the scripts and the stylesheet are named');
    assert.ok(res.headers.Link && res.headers.Link.indexOf('rel=preload') >= 0, 'the page carries the hint too');
}

{   // The API and the files are none of the browser's business: they know their own URL.
    for (const p of ['/api/thing', '/shared/navbar.js', '/js/app.js', '/css/style.css']) {
        const res = fakeRes();
        shell.hints()({ method: 'GET', path: p, headers: { accept: '*/*' } }, res, () => { });
        assert.ok(!res.hints && !res.headers.Link, p + ' is not hinted');
    }
    // A write is never hinted.
    const res = fakeRes();
    shell.hints()({ method: 'POST', path: '/', headers: { accept: 'text/html' } }, res, () => { });
    assert.ok(!res.hints && !res.headers.Link, 'a write is not hinted');
}

{   // The manifest: the shell by content hash, so the worker warms the files the page already asks for.
    const man = shell.manifest();
    assert.ok(Array.isArray(man.shell) && man.shell.length >= 3, 'the shell is listed');
    for (const u of man.shell) {
        assert.ok(u.startsWith('/shared/'), u + ' is a shared file');
        assert.ok(/\?v=[0-9a-f]{8,}$/.test(u), u + ' carries its content hash');
    }
    assert.ok(man.shell.some((u) => u.indexOf('/shared/navbar.js') === 0), 'the navbar is in the shell');
}

console.log('shell: ok');
