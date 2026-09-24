/**
 * /llms.txt (server/seo/seo.js, roadmap 32.4/33.8): plain text that tells language models and other
 * automated readers what OpenVibe.Live is, where its public pages and their JSON are, where the API
 * docs are, and how people's work is kept apart from what the AI derived. Every docs page it links
 * must exist, and it must answer before the SPA fallback (never the HTML shell).
 *
 *   node test/llms-txt.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = path.join(os.tmpdir(), `ov-llms-${process.pid}.db`);
process.env.DB_PATH = tmp;
process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};
console.error = () => {};

require('../server/db/database').initDb();
const express = require('express');
const seo = require('../server/seo/seo');
const app = express();
seo.register(app);
app.get('*', (req, res) => res.status(404).type('html').send('<html>shell</html>'));

let failures = 0;
async function check(name, fn) {
    try { await fn(); quiet('  ✓', name); }
    catch (e) { failures++; quiet('  ✗', name, '\n     ', e.message); }
}

const server = http.createServer(app).listen(0, '127.0.0.1', async () => {
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
            'https://openvibe.live/vod/<id>?t=<seconds>', 'https://openvibe.live/clip/<id>', 'https://openvibe.live/api/content/feed',
            'https://openvibe.live/api/content/moments', 'https://openvibe.community/p/<slug>', 'https://openvibe.live/sitemap.xml']) {
            assert.ok(text.includes(u), `missing ${u}`);
        }
    });

    await check('links the API docs, and every docs page it links exists', () => {
        assert.ok(text.includes('[API docs](https://openvibe.live/documentation)'));
        const linked = [...text.matchAll(/https:\/\/openvibe\.live\/docs\/([a-z-]+)\)/g)].map((m) => m[1]);
        assert.ok(linked.includes('whip') && linked.includes('api-tokens'), linked.join(','));
        for (const name of linked) assert.ok(fs.existsSync(path.join(__dirname, '../docs', `${name}.md`)), `docs/${name}.md`);
    });

    await check("explains the separation of people's work and AI Moments", () => {
        assert.ok(/People's work and AI-made material are kept apart/.test(text));
        assert.ok(text.includes('noindex,follow') && text.includes('credited to no person') && text.includes('"ai": true'));
        assert.ok(/## What people made[\s\S]*## What the AI made/.test(text), 'made, then derived');
    });

    await check('no "free" or "$0" copy (owner rule)', () => {
        assert.ok(!/\bfree\b|\$0/i.test(text), 'found free/$0');
    });

    server.close();
    try { fs.unlinkSync(tmp); } catch { /* */ }
    for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch { /* */ } }
    quiet(failures ? `\n${failures} check(s) failed` : '\nllms.txt: all checks passed');
    process.exit(failures ? 1 : 0);
});
