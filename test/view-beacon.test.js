'use strict';
// POST /api/views/:kind/:id (server/media-proxy/view-beacon.js): openvibe.video's watch page counts a view from the
// viewer's browser. Only openvibe.video's origin is answered; a public or unlisted finished item gets one
// content_views row per address; a private, missing or still-recording item, a bad id and Media being down count
// nothing; every counted or uncounted beacon answers 204 the same way.
const assert = require('assert');
const path = require('path');
const http = require('http');
const express = require('express');

const rows = [];
const items = {
    'vod:1': { id: 1, visibility: 'public' },
    'vod:2': { id: 2, visibility: 'private', user_id: 9 },
    'vod:3': { id: 3, visibility: 'unlisted' },
    'vod:4': { id: 4, visibility: 'public', is_recording: true },
    'clip:7': { id: 7, visibility: 'public' },
};
let mediaDown = false;
let mediaCalls = 0;
class MediaApiError extends Error { constructor(status) { super('media'); this.name = 'MediaApiError'; this.status = status; } }
const lookup = (kind) => async (id) => {
    mediaCalls++;
    if (mediaDown) throw new Error('ECONNREFUSED');
    const it = items[`${kind}:${id}`];
    if (!it) throw new MediaApiError(404);
    return it;
};
const stub = (rel, exports) => { const f = require.resolve(path.join(__dirname, '..', 'server', rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports }; };
stub('db/database', {
    run: async (sql, params) => {
        assert.match(sql, /INSERT INTO content_views .* ON CONFLICT DO NOTHING/);
        const key = params.join('|');
        if (rows.includes(key)) return { changes: 0 };
        rows.push(key);
        return { changes: 1 };
    },
    getStreamById: async () => null,
});
stub('media-client', { getVod: lookup('vod'), getClip: lookup('clip') });

const { createViewBeacon, _internals } = require('../server/media-proxy/view-beacon');
const rateLimit = require('express-rate-limit');

(async () => {
    const app = express();
    app.set('trust proxy', 'loopback');
    app.use('/api/views', createViewBeacon({ rateLimit }));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, { origin = 'https://openvibe.video', ip = '203.0.113.5', method = 'POST' } = {}) => fetch(base + p, {
        method, headers: { ...(origin ? { Origin: origin } : {}), 'X-Forwarded-For': ip },
    });

    try {
        let r = await post('/api/views/vod/1');
        assert.strictEqual(r.status, 204);
        assert.strictEqual(r.headers.get('access-control-allow-origin'), 'https://openvibe.video');
        assert.strictEqual(r.headers.get('cross-origin-resource-policy'), 'cross-origin', 'the watch page may read the answer');
        assert.deepStrictEqual(rows, ['vod|1|203.0.113.5'], 'a public VOD is counted for the viewer\'s address');

        r = await post('/api/views/vod/1');
        assert.strictEqual(r.status, 204);
        assert.strictEqual(rows.length, 1, 'the same address counts once');
        assert.strictEqual(mediaCalls, 1, 'visibility is remembered for a minute');

        await post('/api/views/vod/1', { ip: '198.51.100.7' });
        assert.strictEqual(rows.length, 2, 'another address counts');

        assert.strictEqual((await post('/api/views/vod/3')).status, 204);
        assert.ok(rows.includes('vod|3|203.0.113.5'), 'unlisted counts');
        assert.strictEqual((await post('/api/views/clip/7')).status, 204);
        assert.ok(rows.includes('clip|7|203.0.113.5'), 'a clip counts');

        const before = rows.length;
        for (const p of ['/api/views/vod/2', '/api/views/vod/4', '/api/views/vod/99', '/api/views/vod/0', '/api/views/vod/abc', '/api/views/live/1']) {
            r = await post(p);
            assert.strictEqual(r.status, 204, `${p} answers 204`);
        }
        assert.strictEqual(rows.length, before, 'private, recording, missing and malformed items are not counted');

        mediaDown = true;
        _internals.visible.clear();
        r = await post('/api/views/vod/1', { ip: '192.0.2.50' });
        assert.strictEqual(r.status, 204);
        assert.strictEqual(rows.length, before, 'Media down counts nothing');
        mediaDown = false;
        await post('/api/views/vod/1', { ip: '192.0.2.50' });
        assert.strictEqual(rows.length, before + 1, 'and nothing was remembered while it was down');

        r = await post('/api/views/vod/1', { origin: 'https://evil.example' });
        assert.strictEqual(r.status, 403, 'another origin is refused');
        r = await post('/api/views/vod/1', { origin: null });
        assert.strictEqual(r.status, 403, 'no origin is refused');
        r = await post('/api/views/vod/1', { origin: 'https://openvibe.live' });
        assert.strictEqual(r.status, 403, 'Live itself counts on its detail read, not here');

        r = await post('/api/views/vod/1', { method: 'OPTIONS' });
        assert.strictEqual(r.status, 204);
        assert.strictEqual(r.headers.get('access-control-allow-methods'), 'POST');
        assert.strictEqual(r.headers.get('access-control-allow-credentials'), null, 'never credentialed');

        console.log('view-beacon: ok');
    } finally {
        server.close();
    }
})().catch((e) => { console.error(e); process.exit(1); });
