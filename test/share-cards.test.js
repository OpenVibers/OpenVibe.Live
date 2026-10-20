/**
 * Share cards (server/web/share-cards.js, server/seo/pages.js): every page's og:image is an openvibe-shared/social card
 * served from Live's pinned copy, not the old /og-image.png. The site's card by default; The Rundown, the content lists,
 * AI Moments and Chat each have a page card. A hashed URL is immutable, an unknown card falls through.
 *
 *   node test/share-cards.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const social = require('openvibe-shared/social');

(async () => {
    let failures = 0;
    const check = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failures++; console.log(`  ✗ ${name}\n    ${err.stack}`); } };
    const app = express();
    require('../server/web/share-cards').register(app);
    app.use((req, res) => res.status(404).send('shared 404'));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const get = (p) => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: server.address().port, path: p }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        }).on('error', reject);
    });

    await check('the site card and the page cards are in the pinned openvibe-shared', () => {
        for (const id of ['live', 'live-rundown', 'live-content', 'live-moments', 'live-chat']) assert.ok(social.has(id), id);
    });

    await check('/shared/social/<id>.jpg answers the JPEG; its own hash is immutable, anything else is not', async () => {
        const url = social.url('live-rundown');
        const r = await get(url);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers['content-type'], 'image/jpeg');
        assert.strictEqual(r.body.readUInt16BE(0), 0xffd8, 'a JPEG');
        assert.match(r.headers['cache-control'], /immutable/);
        assert.ok(r.headers['cdn-cache-control'], 'the CDN keeps it too');
        const plain = await get('/shared/social/live.jpg');
        assert.strictEqual(plain.status, 200);
        assert.ok(!/immutable/.test(plain.headers['cache-control']), 'no hash: revalidated');
        assert.ok(!/immutable/.test((await get('/shared/social/live.jpg?v=000000000000')).headers['cache-control']), 'a wrong hash is not immutable');
    });

    await check('what is not a card falls through', async () => {
        assert.strictEqual((await get('/shared/social/nope.jpg')).status, 404);
        assert.strictEqual((await get('/shared/social/..%2Fpackage.json')).status, 404);
        assert.strictEqual((await get('/shared/social/live.png')).status, 404);
    });

    await check('pages name the cards: the site card by default, page cards on the big pages', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'seo', 'pages.js'), 'utf8');
        assert.match(src, /const DEFAULT_OG_IMAGE = shareCard\('live'\);/);
        assert.match(src, /const base = \{ image: shareCard\('live-rundown'\)/, 'The Rundown');
        assert.match(src, /canonicalPath: '\/chat', image: shareCard\('live-chat'\)/, 'Chat');
        assert.match(src, /LIST_CARDS = \{ content: 'live-content', vods: 'live-content', clips: 'live-content', pastes: 'live-content', moments: 'live-moments' \}/);
        for (const f of ['index.html', 'tos.html', 'privacy.html', 'dmca.html']) {
            const html = fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
            assert.ok(!html.includes('og-image.png'), `${f} still names /og-image.png`);
            assert.ok(html.includes('content="https://openvibe.live/shared/social/live.jpg"'), f);
        }
    });

    server.close();
    console.log(failures ? `\n${failures} check(s) failed` : '\nshare cards: all checks passed');
    if (failures) process.exitCode = 1;
})();
