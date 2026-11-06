'use strict';
/**
 * Live's category-3 operator report goes to OpenVibe.Vision with Live's service principal: one POST, the
 * clip's id, the AI text and the note that names the hard line. Nothing else leaves the process (the clip
 * is already hidden by explicit.js whether or not Vision answers).
 */
const assert = require('assert');
const http = require('http');

(async () => {
    const state = { token: 0, reviews: [] };
    const srv = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/oauth/token') { state.token++; return send(200, { access_token: 'svc-live-vision', token_type: 'Bearer', expires_in: 300 }); }
            if (req.url === '/api/v1/review') {
                state.reviews.push({ auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
                return send(201, { review: { id: 'vir_x', report: { id: 'vor_x', status: 'open' } } });
            }
            send(404, {});
        });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    process.env.VISION_URL = base;
    process.env.OV_NETWORK_INTERNAL_URL = base;
    process.env.OV_OAUTH_CLIENT_ID = 'live';
    process.env.OV_OAUTH_CLIENT_SECRET = 'live-secret';
    const client = require('../server/ai/review-client');

    assert.strictEqual(client.enabled(), true);
    const out = await client.reportMinorSexual({
        clip: { id: 9, thumbnail_url: 'https://openvibe.media/t/9.jpg' },
        text: 'a naked child runs across the frame',
        ownerSubject: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ',
    });
    assert.strictEqual(out.review.report.id, 'vor_x');
    assert.strictEqual(state.reviews.length, 1);
    const body = state.reviews[0].body;
    assert.deepStrictEqual([body.object_type, body.object_id, body.owner_subject], ['live.clip', '9', 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ']);
    assert.strictEqual(body.text, 'a naked child runs across the frame');
    assert.match(body.note, /minor/);
    assert.ok(state.reviews[0].auth.startsWith('Bearer '));
    assert.strictEqual(state.token, 1);

    console.log('ai review client: 1 report sent with Live\'s service token');
    client._reset();
    await new Promise((r) => srv.close(r));
})().catch((e) => { console.error(e); process.exit(1); });
