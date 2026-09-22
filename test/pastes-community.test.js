'use strict';

// PASTES_AUTHORITY=community (roadmap Wave 5): Live writes and reads pastes through OpenVibe.Community with
// a service token. AI pastes are ownerless (origin ai + source stream), a person is named by subject, the
// SPA's /api/pastes forwards anonymously when nobody is signed in, and staff routes keep requireAdmin.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { serviceAuth } = require('openvibe-contracts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-pastes-community-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.INTERNAL_API_KEY = 'legacy-key';
process.env.OV_OAUTH_CLIENT_ID = 'live';
process.env.OV_OAUTH_CLIENT_SECRET = 'live-secret';
process.env.PASTES_AUTHORITY = 'community';

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SID = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPA';
const SID2 = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPB';
const seen = [];

const net = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/oauth/token') {
            const aud = new URLSearchParams(raw).get('audience');
            const now = Math.floor(Date.now() / 1000);
            const cap = aud === 'openvibe.community' ? ['community.paste.create', 'community.paste.write', 'community.paste.moderate'] : ['identity.subject.resolve'];
            return res.end(JSON.stringify({ access_token: serviceAuth.signServiceToken({ iss: 'https://openvibe.network', sub: 'svc:live', actor_type: 'service', aud: [aud], cap, iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(6).toString('hex')}` }, keys.privateKey), expires_in: 300 }));
        }
        if (req.url === '/internal/identity/resolve-batch') {
            const { ids } = JSON.parse(raw);
            return res.end(JSON.stringify({ results: Object.fromEntries(ids.map((id) => [id, id === '2' ? { subject: { type: 'user', id: SID2 } } : null])) }));
        }
        res.statusCode = 404; res.end('{}');
    });
});
const community = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        const auth = req.headers.authorization || '';
        const claims = serviceAuth.verifyServiceToken(auth.slice(7), { publicKey: keys.publicKey, audience: 'openvibe.community' });
        seen.push({ method: req.method, url: req.url, subject: req.headers['x-ov-subject'] || null, origin: req.headers['x-ov-origin'] || null, sourceRef: req.headers['x-ov-source-ref'] || null, xff: req.headers['x-forwarded-for'] || null, type: req.headers['content-type'] || '', body: Buffer.concat(chunks).toString('latin1'), tokenOk: claims.ok });
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'POST') { res.statusCode = 201; return res.end(JSON.stringify({ id: 9, slug: 'new-slug-1', url: '/p/new-slug-1', paste: { slug: 'new-slug-1', origin: req.headers['x-ov-origin'] || 'user' } })); }
        res.end(JSON.stringify({ pastes: [], total: 0 }));
    });
});

(async () => {
    await new Promise((r) => net.listen(0, '127.0.0.1', r));
    await new Promise((r) => community.listen(0, '127.0.0.1', r));
    process.env.OV_NETWORK_INTERNAL_URL = `http://127.0.0.1:${net.address().port}`;
    process.env.OV_COMMUNITY_INTERNAL_URL = `http://127.0.0.1:${community.address().port}`;

    const db = require('../server/db/database');
    db.initDb();
    const d = db.getDb();
    const u1 = d.prepare("INSERT INTO users (username, password_hash, stream_key) VALUES ('ann', 'x', 'k1')").run().lastInsertRowid;
    d.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (?, 'network', '11', ?)").run(u1, SID);
    const client = require('../server/pastes-client');

    // AI paste: no person, origin ai, stream as source.
    let out = await client.createPaste({ user_id: u1, title: 'moment', content: 'x', stream_id: 77, metadata: { ai_moment: true } }, { origin: 'ai' });
    assert.strictEqual(out.slug, 'new-slug-1');
    let s = seen.pop();
    assert.strictEqual(s.subject, null, 'AI pastes are never filed under a person');
    assert.strictEqual(s.origin, 'ai');
    assert.deepStrictEqual(JSON.parse(s.sourceRef), { service: 'live', type: 'stream', id: '77' });
    assert.ok(s.tokenOk, 'Live calls with a Community-audience service token');
    assert.ok(!('user_id' in JSON.parse(s.body)), 'no Live id reaches Community');

    // A person: subject from the link table.
    await client.createPaste({ user_id: u1, title: 't', content: 'hello' });
    s = seen.pop();
    assert.strictEqual(s.subject, SID);
    // Not in the link table: resolved through Network's identity map (live user 2 -> SID2).
    d.prepare("INSERT INTO users (id, username, password_hash, stream_key) VALUES (2, 'bob', 'x', 'k2')").run();
    await client.createPaste({ user_id: 2, content: 'hi' });
    assert.strictEqual(seen.pop().subject, SID2);
    // Nobody we can name: refused rather than filed under the wrong person or as anonymous.
    d.prepare("INSERT INTO users (id, username, password_hash, stream_key) VALUES (3, 'cat', 'x', 'k3')").run();
    await assert.rejects(client.createPaste({ user_id: 3, content: 'hi' }), (e) => e.status === 409);

    // Screenshot: multipart with the file.
    await client.createPaste({ user_id: u1, title: 'shot', screenshot: { buffer: Buffer.from('PNGDATA'), filename: 'a.png', contentType: 'image/png' } });
    s = seen.pop();
    assert.ok(s.type.startsWith('multipart/form-data') && s.body.includes('PNGDATA') && s.body.includes('name="screenshot"'));

    // The SPA router: anonymous list/create forward anonymously; staff routes need a Live admin.
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
    app.use('/api/pastes', require('../server/media-proxy/pastes'));
    const srv = http.createServer(app);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}/api/pastes`;
    let r = await fetch(`${base}?limit=5&username=ann`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    assert.strictEqual(r.status, 200);
    s = seen.pop();
    assert.strictEqual(s.url, '/api/pastes?limit=5&username=ann', 'query forwarded as-is');
    assert.strictEqual(s.subject, null, 'nobody signed in, nobody named');
    assert.strictEqual(s.xff, '203.0.113.9', 'Community sees the visitor address for its limits');
    r = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'anon paste', user_id: 1 }) });
    assert.strictEqual(r.status, 201);
    s = seen.pop();
    assert.strictEqual(s.body, JSON.stringify({ content: 'anon paste', user_id: 1 }), 'body bytes forwarded untouched (Community ignores identity fields)');
    r = await fetch(`${base}/bulk`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.strictEqual(r.status, 401, 'staff routes still need a signed-in Live admin');
    r = await fetch(`${base}/some-slug/raw`, { redirect: 'manual' });
    assert.strictEqual(r.status, 302);
    assert.ok(r.headers.get('location').endsWith('/p/some-slug/raw'));

    // Default mode goes to Media exactly as before.
    process.env.PASTES_AUTHORITY = '';
    assert.strictEqual(client.onCommunity(), false);

    srv.close(); net.close(); community.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('pastes on community: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
