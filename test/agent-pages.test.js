'use strict';
// Every page the SEO renderer serves has a Markdown twin, since its Link header names one (11-03: /content, /moments,
// /rundown, /chat, /documentation and /updates named twins that answered 404). Recordings, clips and pastes are handed
// over to OpenVibe.Video and OpenVibe.Community and are not twinned here; a path the renderer does not serve is not.
const assert = require('assert');
const { createAgentPages } = require('../server/agent-pages');
const seoPages = require('../server/seo/pages');

(async () => {
    const { renderPublicPage } = createAgentPages();
    const q = (s = '') => new URLSearchParams(s);
    for (const p of ['/vod/12', '/clip/3', '/p/abc', '/settings', '/dashboard', '/nope', '/docs/whip']) {
        assert.strictEqual(await renderPublicPage(p, { query: q() }), null, `${p} has no twin here`);
    }
    for (const p of ['/chat', '/documentation', '/updates', '/chat/']) {
        const page = await renderPublicPage(p, { query: q() });
        assert.ok(page && /<\/html>/i.test(page.html) && page.title, `${p} is twinned`);
    }
    // Paging follows the renderer's own rule: a feed caps at its last page, other pages ignore ?page.
    assert.strictEqual(seoPages._pageParam('/content', { page: '999' }), 20);
    assert.strictEqual(seoPages._pageParam('/chat', { page: '3' }), 1);
    for (const p of ['/', '/content', '/moments', '/vods', '/clips', '/rundown', '/rundown/topics', '/@goosely', '/recap/12']) {
        assert.ok(seoPages.SEO_ROUTE_RE.test(p), `${p} is an SEO route, so it is twinned`);
    }

    // Mounted as server/index.js mounts them: a doc's twin is its own Markdown, before the agent layer.
    const express = require('express');
    const http = require('http');
    const docs = require('../server/docs/routes');
    const app = express();
    app.get(['/docs.md', '/docs/:name.md'], docs.sendTwin);
    require('openvibe-shared/agent-layer').mount(app, { descriptor: require('../server/agent-descriptor'), render: renderPublicPage });
    app.use('/docs', docs);
    const server = await new Promise((ok) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => ok(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const whip = await fetch(`${base}/docs/whip.md`);
        const text = await whip.text();
        assert.strictEqual(whip.status, 200);
        assert.match(whip.headers.get('content-type'), /^text\/markdown/);
        assert.ok(text.startsWith('# ') && !/<html/i.test(text), 'the doc as written');
        assert.match(whip.headers.get('link'), /\/docs\/whip>; rel="canonical"/);
        assert.ok(!/\]\((?!https?:|\/|#|mailto:)[^)]+\)/.test(text.replace(/^(```|~~~)[\s\S]*?^\1/gm, '')), 'no relative link is left outside code');
        assert.strictEqual((await fetch(`${base}/docs.md`)).status, 200, 'the index');
        const missing = await fetch(`${base}/docs/nope.md`);
        assert.deepStrictEqual([missing.status, /markdown/.test(missing.headers.get('content-type'))], [404, true]);
        assert.strictEqual((await fetch(`${base}/docs/..%2Fpackage.md`)).status, 404, 'only a doc');
        const page = await fetch(`${base}/docs/whip`);
        assert.match(page.headers.get('link'), /<\/docs\/whip\.md>; rel="alternate"; type="text\/markdown"/, 'the page names its twin');
        assert.match(await page.text(), /<link rel="alternate" type="text\/markdown" href="\/docs\/whip\.md">/);
        const chat = await fetch(`${base}/chat.md`);
        assert.deepStrictEqual([chat.status, /markdown/.test(chat.headers.get('content-type'))], [200, true], '/chat names a twin, so it has one');
        assert.strictEqual((await fetch(`${base}/vod/1.md`)).status, 404);
    } finally {
        server.close();
    }
    console.log('agent pages: ok');
})().catch((e) => { console.error(e); process.exit(1); });
