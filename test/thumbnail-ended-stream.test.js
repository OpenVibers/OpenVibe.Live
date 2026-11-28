'use strict';
// An ended stream's old thumbnail name (11-28: the chat page's cards named stream-3061-….jpg long after the stream
// ended, four 404s on every visit and Run's page check failed /chat) answers with its public recording's picture;
// with no public recording, or Media not answering, it stays the 404 the page's own fallback needs.
const assert = require('assert');
const http = require('http');

process.env.NODE_ENV = 'test';
console.warn = () => {};

(async () => {
    const media = require('../server/media-client');
    media.publicUrl = (u) => (u ? `https://media.example/${String(u).replace(/^\//, '')}` : null);
    const liveThumbs = require('../server/media-proxy/live-thumbs');
    liveThumbs.getStreamThumbnailState = async () => ({ exists: false, thumbUrl: null, filePath: null });
    const lookups = require('../server/media-proxy/lookups');
    const asked = [];
    const vods = { 3061: { id: 9001, thumbnail_url: '/t/vod-9001.jpg' }, 3062: { id: 9002, thumbnail_url: null } };
    lookups.publicVodsForStreams = async (ids) => {
        asked.push(...ids);
        if (ids[0] === 3063) throw new Error('Media down');
        return new Map(ids.filter((id) => vods[id]).map((id) => [id, vods[id]]));
    };
    const db = require('../server/db/database');
    const streams = { 3064: { id: 3064, user_id: 7, is_live: 0 }, 3065: { id: 3065, user_id: 7, is_live: 1 }, 3066: { id: 3066, user_id: 8, is_live: 0 } };
    db.getStreamById = async (id) => streams[id] || null;
    db.getUserById = async (id) => (id === 7 ? { id: 7, avatar_url: 'https://openvibe.network/avatars/7.png' } : { id, avatar_url: null });
    const auth = require('../server/auth/auth');
    auth.optionalAuth = (req, res, next) => next();

    const express = require('express');
    const app = express();
    app.use('/api/thumbnails', require('../server/media-proxy/thumbnails'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const get = (p) => fetch(`http://127.0.0.1:${server.address().port}${p}`, { redirect: 'manual' });
    try {
        const ended = await get('/api/thumbnails/stream-3061-1795144853998.jpg');
        assert.strictEqual(ended.status, 302, 'an ended stream with a public recording redirects');
        assert.strictEqual(ended.headers.get('location'), 'https://media.example/t/vod-9001.jpg');
        assert.match(ended.headers.get('cache-control') || '', /max-age=300/);

        assert.strictEqual((await get('/api/thumbnails/stream-3062-1795193618087.jpg')).status, 404, 'a recording with no picture: 404');
        const noRec = await get('/api/thumbnails/stream-3064-1795193618087.jpg');
        assert.strictEqual(noRec.status, 302, 'an ended stream with no recording: the streamer\'s picture, not a 404 (stream 3083)');
        assert.strictEqual(noRec.headers.get('location'), 'https://openvibe.network/avatars/7.png');
        assert.strictEqual((await get('/api/thumbnails/stream-3065-1795193618087.jpg')).status, 404, 'a live stream with no frame yet: still 404');
        assert.strictEqual((await get('/api/thumbnails/stream-3066-1795193618087.jpg')).status, 404, 'no recording and no picture: 404');
        assert.strictEqual((await get('/api/thumbnails/stream-3063-1795193618087.jpg')).status, 404, 'Media down: 404, never a 500');
        assert.deepStrictEqual(asked, [3061, 3062, 3064, 3065, 3066, 3063], 'each stream id is asked about once per request');
    } finally {
        server.close();
    }
    console.log('thumbnail-ended-stream: an ended stream\'s old thumbnail name answers with its recording\'s picture, else 404');
})().catch((e) => { console.error(e); process.exit(1); });
