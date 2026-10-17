'use strict';
/**
 * POST /api/thumbnails/generate/clip/:id when OpenVibe.Media answers with neither a picture nor a job, or its job fails
 * (5xx): no picture yet,
 * answered 200 with thumbnail_url null and remembered for a while (Media is not asked again at once), never a 500 in
 * every visitor's console (the browser check of release 35d02c6b found one on /@goosely, clip 455).
 *
 *   node --import ./test/helpers/pg-preload.mjs test/thumbnail-no-picture.test.js
 */
const assert = require('assert');
const http = require('http');

process.env.NODE_ENV = 'test';
console.warn = () => {};

(async () => {
    const media = require('../server/media-client');
    const access = require('../server/media-proxy/access');
    let asked = 0;
    media.getClip = async (id) => ({ id: Number(id), user_id: 1, visibility: 'public', thumbnail_url: null });
    media.generateThumbnail = async () => { asked++; return {}; };
    media.publicUrl = (u) => u || null;
    access.canView = async () => true;
    const auth = require('../server/auth/auth');
    auth.optionalAuth = (req, res, next) => next();

    const express = require('express');
    const app = express();
    app.use('/api/thumbnails', require('../server/media-proxy/thumbnails'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const post = async (p) => { const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method: 'POST' }); return { status: r.status, json: await r.json() }; };

    const first = await post('/api/thumbnails/generate/clip/455');
    assert.deepStrictEqual([first.status, first.json], [200, { thumbnail_url: null }]);
    const again = await post('/api/thumbnails/generate/clip/455');
    assert.strictEqual(again.status, 200);
    assert.strictEqual(asked, 1, 'remembered: Media is not asked again at once');

    // Media's thumbnail job failing (it answers 500 with its job id): no picture for now, remembered, never the 500.
    media.generateThumbnail = async () => {
        asked++;
        const err = new Error('Failed to generate thumbnail');
        Object.assign(err, { name: 'MediaApiError', status: 500, body: { error: 'Failed to generate thumbnail', job_id: 'mjob_x' } });
        throw err;
    };
    const failed = await post('/api/thumbnails/generate/clip/456');
    assert.deepStrictEqual([failed.status, failed.json], [200, { thumbnail_url: null }]);
    await post('/api/thumbnails/generate/clip/456');
    assert.strictEqual(asked, 2, 'a failed job is remembered too');

    server.close();
    console.log('thumbnail no-picture: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
