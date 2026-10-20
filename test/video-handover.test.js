/**
 * Recordings and clips are watched on openvibe.video (server/web/video-handover.js): /vod/<id> and /clip/<id> answer a
 * 301 to the OpenVibe.Video page, with a ?t= start time as seconds (95, 1:35 or 0:01:35); anything that is not an id
 * falls through to Live's own 404; an OpenVibe.Video or Community address glued onto Live's (/https://openvibe.video/v/12,
 * what a tab opened before the handover made of the new links) 301s to the page it names; the SPA shell names the origin in its ov-video-base meta (public/js/app.js videoHref),
 * and no client code links a /vod/ or /clip/ page any more.
 *
 *   node test/video-handover.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

process.env.NODE_ENV = 'test';

(async () => {
    let failures = 0;
    const check = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failures++; console.log(`  ✗ ${name}\n    ${err.stack}`); } };
    const app = express();
    require('../server/web/video-handover').register(app);
    app.use((req, res) => res.status(404).send('live 404'));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const get = (p) => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: server.address().port, path: p }, (res) => { res.resume(); resolve({ status: res.statusCode, location: res.headers.location || null }); }).on('error', reject);
    });

    await check('/vod/<id> and /clip/<id> 301 to OpenVibe.Video, the start time kept as seconds', async () => {
        assert.deepStrictEqual(await get('/vod/12'), { status: 301, location: 'https://openvibe.video/v/12' });
        assert.deepStrictEqual(await get('/vod/12/'), { status: 301, location: 'https://openvibe.video/v/12' });
        assert.deepStrictEqual(await get('/vod/12?t=95'), { status: 301, location: 'https://openvibe.video/v/12?t=95' });
        assert.deepStrictEqual(await get('/vod/12?t=1:35'), { status: 301, location: 'https://openvibe.video/v/12?t=95' });
        assert.deepStrictEqual(await get('/vod/12?t=1:01:35'), { status: 301, location: 'https://openvibe.video/v/12?t=3695' });
        assert.deepStrictEqual(await get('/clip/7'), { status: 301, location: 'https://openvibe.video/c/7' });
        assert.deepStrictEqual(await get('/vod/12?t=soon'), { status: 301, location: 'https://openvibe.video/v/12' }, 'a junk start time is dropped');
    });

    await check('a whole OpenVibe.Video or Community address glued onto Live\'s (an old tab\'s router did that) goes to the page it names', async () => {
        assert.deepStrictEqual(await get('/https://openvibe.video/v/5857'), { status: 301, location: 'https://openvibe.video/v/5857' });
        assert.deepStrictEqual(await get('/https:/openvibe.video/v/5857?t=95'), { status: 301, location: 'https://openvibe.video/v/5857?t=95' }, 'merged slashes, start time kept');
        assert.deepStrictEqual(await get('/https://openvibe.video/c/7'), { status: 301, location: 'https://openvibe.video/c/7' });
        assert.deepStrictEqual(await get('/https://openvibe.community/p/abc'), { status: 301, location: 'https://openvibe.community/p/abc' });
        assert.strictEqual((await get('/https://evil.example/v/1')).status, 404, 'any other host is no redirect');
        assert.strictEqual((await get('/https://openvibe.video.evil.example/v/1')).status, 404);
        assert.strictEqual((await get('/https:openvibe.video/v/1')).status, 404);
    });

    await check('what is not an id stays Live\'s 404', async () => {
        assert.strictEqual((await get('/vod/abc')).status, 404);
        assert.strictEqual((await get('/vod/0')).status, 404);
        assert.strictEqual((await get('/clip/1e3')).status, 404);
    });

    await check('the shell names OpenVibe.Video for the SPA, and no client code links a /vod/ or /clip/ page', async () => {
        const seo = require('../server/seo/pages');
        const html = await seo.shellHtml('/@someone', 200);
        if (html) assert.ok(html.includes('<meta name="ov-video-base" content="https://openvibe.video">'), 'the meta is on the shell');
        const dir = path.join(__dirname, '..', 'public', 'js');
        const offenders = [];
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
            const src = fs.readFileSync(path.join(dir, f), 'utf8');
            src.split('\n').forEach((line, i) => { if (/(?<![\w/])\/(vod|clip)\/\$\{|['"`]\/(vod|clip)\/['"`]? *\+/.test(line) && !/\/api\//.test(line)) offenders.push(`${f}:${i + 1}`); });
        }
        assert.deepStrictEqual(offenders, [], 'every watch link goes through videoHref');
        assert.ok(!fs.existsSync(path.join(dir, 'app-media.js')), 'the old player is gone');
    });

    server.close();
    console.log(failures ? `\n${failures} check(s) failed` : '\nvideo handover: all checks passed');
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
