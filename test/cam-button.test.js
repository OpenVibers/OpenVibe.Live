'use strict';
// The cam button (CAM-1): a signed-in viewer takes a still of a live stream. Live's server sends the
// viewer's own Network token to OpenVibe.Cam, returns the still (link + picture), and — when the viewer
// chooses — posts Cam's returned share.text into the stream's chat with Live's chat authority.
//   node test/cam-button.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-live-cam-'));
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
fs.writeFileSync(path.join(tmp, 'network.pem'), keys.publicKey);
process.env.OV_NETWORK_PUBLIC_KEY = path.join(tmp, 'network.pem');
process.env.OV_NETWORK_URL = 'https://openvibe.network';
process.env.NODE_ENV = 'test';
console.warn = () => {};

const ISS = 'https://openvibe.network';
const SUBJECT = 'usr_01J0000000000000000000000C1';
const viewerToken = () => jwt.sign({ sub: '77', username: 'alice', subject_id: SUBJECT, role: 'user' }, keys.privateKey, { algorithm: 'RS256', issuer: ISS, expiresIn: 600 });

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    const d = db.getDb();
    await d.prepare("INSERT INTO users (id, username, display_name, password_hash) OVERRIDING SYSTEM VALUE VALUES (501, 'alice', 'Alice', 'x')").run();
    await d.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (501, 'network', '77', ?)").run(SUBJECT);

    const slotId = Number((await db.run("INSERT INTO managed_streams (user_id, slug, title, protocol, stream_key) VALUES (501, 'whip', 'Whip', 'webrtc', 'whip-key') RETURNING id")).lastInsertRowid);
    const streamId = Number((await db.run("INSERT INTO streams (user_id, managed_stream_id, title, protocol, is_live) VALUES (501, ?, 'Alice live', 'webrtc', 1) RETURNING id", [slotId])).lastInsertRowid);

    const delivery = require('../server/chat/chat-delivery');
    const sent = [];
    let nextChatId = 900;
    delivery.message = async (body) => { sent.push(body); return nextChatId++; };

    const cam = require('../server/cam/cam-client');
    const camCalls = [];
    const shareText = 'A still from whip: https://openvibe.cam/s/cms_test';
    cam.createStill = async ({ token, slot, streamId: sid, caption }) => {
        camCalls.push({ token, slot, sid, caption });
        return {
            still: { id: 'cms_test', stream_id: sid, slot, caption, visibility: 'unlisted', pics_slug: 'slug', pics_url: 'https://pics.test/page', pics_direct: 'https://pics.test/direct' },
            frame_url: 'https://openvibe.media/live/whip/frame.jpg?w=640',
            share: { url: 'https://openvibe.cam/s/cms_test', caption, text: shareText },
        };
    };

    const app = express();
    app.use(express.json());
    app.use('/api/cam', require('../server/cam/routes'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const post = (p, body, token = viewerToken()) => fetch(`${base}/api/cam${p}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

    try {
        // Signed-out viewers cannot take a still.
        assert.strictEqual((await post('/stills', { slot: 'whip', stream_id: streamId }, null)).status, 401);

        // A signed-in viewer takes a still: Cam is called with the viewer's own Network token.
        const taken = await post('/stills', { slot: 'whip', stream_id: streamId, caption: 'the moment' });
        assert.strictEqual(taken.status, 200, JSON.stringify(taken.json));
        assert.strictEqual(taken.json.still.id, 'cms_test');
        assert.strictEqual(taken.json.share.text, shareText);
        assert.strictEqual(camCalls.length, 1);
        assert.strictEqual(camCalls[0].slot, 'whip');
        assert.strictEqual(camCalls[0].sid, streamId);
        assert.strictEqual(camCalls[0].token, viewerToken());

        // A viewer chooses to post the returned share.text into the stream chat.
        const posted = await post('/post-share', { stream_id: streamId, text: shareText });
        assert.deepStrictEqual(posted.json, { posted: true });
        assert.strictEqual(sent.length, 1);
        assert.deepStrictEqual([sent[0].stream_id, sent[0].channel_user_id, sent[0].username, sent[0].message, sent[0].message_type, sent[0].source_platform],
            [streamId, 501, 'alice', shareText, 'chat', 'cam']);

        // The button refuses a still while the stream is offline.
        await d.prepare('UPDATE streams SET is_live = 0 WHERE id = ?').run(streamId);
        const offline = await post('/stills', { slot: 'whip', stream_id: streamId });
        assert.strictEqual(offline.status, 409);
        assert.strictEqual(offline.json.error, 'That stream is offline');

        // Bad slot/stream inputs are refused before Cam is asked.
        assert.strictEqual((await post('/stills', { slot: '', stream_id: streamId })).status, 400);
        assert.strictEqual((await post('/stills', { slot: 'whip', stream_id: 'nope' })).status, 400);
    } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    process.stdout.write('cam-button: all passed\n');
    process.exit(0);
})().catch((e) => { process.stderr.write(`${e.stack}\n`); process.exit(1); });
