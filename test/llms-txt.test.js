/**
 * /llms.txt (server/seo/discovery.js, roadmap 32.4/33.8): plain text that tells language models and other
 * automated readers what OpenVibe.Live is, where its public pages and their JSON are, where the API
 * docs are, and how people's work is kept apart from what the AI derived. Every docs page it links
 * must exist, and it must answer before the SPA fallback (never the HTML shell).
 *
 *   node test/llms-txt.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};
console.error = () => {};

const db = require('../server/db/database');
const express = require('express');
const seo = require('../server/seo');

let failures = 0;
async function check(name, fn) {
    try { await fn(); quiet('  ✓', name); }
    catch (e) { failures++; quiet('  ✗', name, '\n     ', e.message); }
}

async function main() {
    await db.initDb();
    const app = express();
    seo.register(app);
    app.get('*', (req, res) => res.status(404).type('html').send('<html>shell</html>'));

    const server = http.createServer(app);
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/llms.txt`);
    const text = await res.text();
    quiet('llms.txt');

    await check('answers 200 text/plain, before the SPA fallback', () => {
        assert.strictEqual(res.status, 200);
        assert.ok(/^text\/plain/.test(res.headers.get('content-type')), res.headers.get('content-type'));
        assert.ok(text.startsWith('# OpenVibe.Live\n\n> '), 'an llmstxt.org title and summary');
        assert.ok(!/<html/i.test(text));
    });

    await check('names the public pages and the JSON behind them', () => {
        for (const u of ['https://openvibe.live/content', 'https://openvibe.live/moments', 'https://openvibe.live/@<username>',
            'https://openvibe.video/watch?v=<watch_id>&t=<seconds>', 'https://openvibe.video/watch?v=<watch_id>', 'https://openvibe.live/api/content/feed',
            'https://openvibe.live/api/content/moments', 'https://openvibe.community/p/<slug>', 'https://openvibe.live/sitemap.xml']) {
            assert.ok(text.includes(u), `missing ${u}`);
        }
    });

    await check('leads with going live from a browser: no OBS, no follower minimum', () => {
        const summary = text.split('\n').find((l) => l.startsWith('> '));
        assert.match(summary, /straight from a web browser, with no OBS, no downloads and no follower/);
        assert.ok(text.includes('## Going live from a browser (no OBS)'));
        assert.ok(text.includes('https://openvibe.live/docs/go-live-in-your-browser.md)'));
    });

    await check('links the API docs, and every docs page it links exists', () => {
        assert.ok(text.includes('[API docs](https://openvibe.live/documentation.md)'));
        const linked = [...text.matchAll(/https:\/\/openvibe\.live\/docs\/([a-z-]+)\.md\)/g)].map((m) => m[1]);
        assert.ok(linked.includes('whip') && linked.includes('api-tokens'), linked.join(','));
        for (const name of linked) assert.ok(fs.existsSync(path.join(__dirname, '../docs', `${name}.md`)), `docs/${name}.md`);
    });

    await check("explains the separation of people's work and AI Moments", () => {
        assert.ok(/People's work and AI-made material are kept apart/.test(text));
        assert.ok(text.includes('noindex,follow') && text.includes('credited to no person') && text.includes('"ai": true'));
        assert.ok(/## What people made[\s\S]*## What the AI made/.test(text), 'made, then derived');
    });

    await check('links each of its own pages at the Markdown twin, and ends with an Optional section (AGT-5)', () => {
        const own = [...text.matchAll(/\]\((https:\/\/openvibe\.live[^)\s]*)\)( \(HTML\))?/g)];
        assert.ok(own.length > 10, String(own.length));
        for (const [, url, html] of own) {
            const p = new URL(url).pathname;
            assert.ok(p.endsWith('.md') || /\.[a-z]+$/.test(p) || p.startsWith('/api/') || html, `${url} is a twin, a file or marked (HTML)`);
        }
        assert.ok(text.includes('[Home](https://openvibe.live/index.md)'));
        assert.ok(text.includes('[The broadcaster](https://openvibe.live/broadcast) (HTML)'), 'the broadcaster has no twin');
        assert.ok(text.includes('(https://openvibe.live/@goosely.md)') && text.includes('(https://openvibe.video/watch?v=<watch_id>)'), 'a channel twin; another site keeps its link');
        assert.ok(/\n## Optional\n\n[\s\S]*\[Sitemap\]\(https:\/\/openvibe\.live\/sitemap\.xml\)/.test(text) && text.lastIndexOf('\n## ') === text.indexOf('\n## Optional'), 'Optional is the last section');
    });

    server.close();
    quiet(failures ? `\n${failures} check(s) failed` : '\nllms.txt: all checks passed');
    process.exit(failures ? 1 : 0);
}

main().catch((e) => { quiet(e.stack || e); process.exit(1); });
