'use strict';
/**
 * One streamer cannot act on another streamer's things by swapping ids (roadmap WS-R task 5, the
 * IDOR class). authorization.test.js pins the holes the 2026-09-16 audit found and
 * media-privacy.test.js the private-item ones; this suite walks every write route that takes an
 * object id in Live and tries it with the other streamer's id:
 *
 *   - VODs and clips (Media's, through Live's proxy): edit, delete, publish, visibility, title,
 *     recut, trim, bulk actions (which take a list of ids), thumbnail regeneration, and uploading
 *     recording chunks / a live thumbnail into someone else's stream;
 *   - streams and slots: edit, end, delete, the slot's settings, its stream key regeneration (the
 *     answer would be the new key), the slot's vibe-coding settings;
 *   - restream destinations (each holds a platform stream key): edit, delete, start, stop;
 *   - API tokens.
 *
 * Every refusal must leave the object exactly as it was (the row, or no call to Media at all) and
 * return nothing of it (no key); each area also has a positive control, so a route that simply
 * broke in this harness cannot pass for a refusal.
 *
 * The real routers run on the test database; sign-in is stubbed by an `x-test-user` header (as in
 * authorization.test.js) and Media by an in-process stub that records every call.
 *
 *   node test/security-idor.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-sec-data-'));   // nothing lands in the checkout's data/
process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};
console.error = () => {};

const db = require('../server/db/database');

const auth = require('../server/auth/auth');
const signIn = async (req) => {
    const id = Number(req.headers['x-test-user'] || 0);
    const u = id ? await db.getUserById(id) : null;
    if (u) { req.user = u; req.authSource = 'network'; }
    return u;
};
auth.requireAuth = async (req, res, next) => ((await signIn(req)) ? next() : res.status(401).json({ error: 'Authentication required' }));
auth.optionalAuth = async (req, res, next) => { await signIn(req); next(); };

const addUser = (id, username, role) => db.getDb().prepare(
    `INSERT INTO users (id, username, display_name, email, password_hash, role, stream_key, created_at) OVERRIDING SYSTEM VALUE
     VALUES (?, ?, ?, ?, 'x', ?, ?, '2025-01-01 00:00:00')`).run(id, username, username, `${username}@example.test`, role, `${String(id).repeat(32)}`);
const ALICE = 3, BOB = 4;
const SLOT_KEY = 'ab'.repeat(20);
const DEST_KEY = 'restream-idor-key-cdcd';

// ── Media stub: records every call; only reads answer from the table ──
const media = require('../server/media-client');
const VODS = { 100: { id: 100, user_id: ALICE, title: 'Alice VOD', visibility: 'public', is_public: 1, status: 'ready', duration_seconds: 60 } };
const CLIPS = { 200: { id: 200, user_id: ALICE, channel_user_id: ALICE, vod_id: 100, title: 'Alice clip', visibility: 'public', is_public: 1, status: 'ready', start_time: 0, end_time: 5 } };
const mediaCalls = [];
const missing = (what) => new media.MediaApiError(`${what} not found`, 404, { error: `${what} not found` });
const READS = {
    getVod: async (id) => { const v = VODS[Number(id)]; if (!v) throw missing('VOD'); return { ...v }; },
    getClip: async (id) => { const c = CLIPS[Number(id)]; if (!c) throw missing('Clip'); return { ...c }; },
    listVods: async (q = {}) => ({ vods: Object.values(VODS).filter((v) => q.user_id == null || v.user_id === Number(q.user_id)).map((v) => ({ ...v, created_at: '2020-01-01 00:00:00' })) }),
    listClips: async (q = {}) => ({ clips: Object.values(CLIPS).filter((c) => q.user_id == null || c.user_id === Number(q.user_id)).map((c) => ({ ...c, created_at: '2020-01-01 00:00:00' })) }),
    getJob: async () => ({ status: 'done' }),
};
for (const k of Object.keys(media)) {
    if (typeof media[k] !== 'function' || /^[A-Z]/.test(k) || /Url$/.test(k) || ['request', 'proxy', 'actingUserFrom', '_formData', 'publicUrl'].includes(k)) continue;
    media[k] = async (...args) => { if (!READS[k]) mediaCalls.push([k, ...args]); return READS[k] ? READS[k](...args) : { id: 999, url: '/t/x.jpg', status: 'processing' }; };
}
const writesTo = (kind, id) => mediaCalls.filter(([k, ...a]) => !READS[k] && (k.toLowerCase().includes(kind) || k === 'generateThumbnail') && JSON.stringify(a).includes(String(id)));

const principal = require('../server/net/network-principal');
principal.serviceHeaders = async () => ({ Authorization: 'Bearer test-service-token' });
const recorder = require('../server/streaming/recorder');
recorder.getActiveRecording = () => null;
recorder.finalizeStream = async () => null;

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/auth', require('../server/auth/routes'));
app.use('/api/streams', require('../server/streaming/routes'));
app.use('/api/restream', require('../server/streaming/restream-routes'));
app.use('/api/vods', require('../server/media-proxy/vods'));
app.use('/api/clips', require('../server/media-proxy/clips'));
app.use('/api/thumbnails', require('../server/media-proxy/thumbnails'));
app.use('/api/vibe-coding', require('../server/vibe-coding/routes'));
const server = http.createServer(app).listen(0, '127.0.0.1');

let ipSeq = 0;
function call(method, p, user, body, { contentType = 'application/json', rawBody = null } = {}) {
    return new Promise((resolve, reject) => {
        const data = rawBody != null ? rawBody : (body ? JSON.stringify(body) : null);
        const headers = { 'content-type': contentType, 'cf-connecting-ip': `10.9.0.${++ipSeq % 250}` };
        if (data) headers['content-length'] = Buffer.byteLength(data);
        if (user) headers['x-test-user'] = String(user);
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path: p, method, headers, agent: false }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode, json, text }); });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}
const refused = (r, what) => {
    assert.ok([401, 403, 404].includes(r.status), `${what}: expected a refusal, got ${r.status} ${r.text.slice(0, 200)}`);
    for (const k of [SLOT_KEY, DEST_KEY, 'Alice VOD', 'Alice clip']) assert.ok(!r.text.includes(k), `${what}: the answer carries "${k}"`);
};
const row = (table, id) => db.getDb().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);

let failures = 0;
async function check(name, fn) {
    try { await fn(); quiet('  ✓', name); } catch (e) { failures++; quiet('  ✗', name, '\n     ', String(e.stack || e.message).split('\n').slice(0, 6).join('\n      ')); }
}

(async () => {
    await db.initDb();
    const raw = db.getDb();

    await addUser(ALICE, 'alice', 'streamer');
    await addUser(BOB, 'bob', 'streamer');
    await db.ensureChannel(ALICE); await db.ensureChannel(BOB);
    const chanA = await db.getChannelByUserId(ALICE);
    const slotA = Number((await db.createManagedStream({ user_id: ALICE, channel_id: chanA.id, slug: 'main', title: 'Alice main', protocol: 'rtmp', stream_key: SLOT_KEY })).lastInsertRowid);
    const streamA = Number((await db.createStream({ user_id: ALICE, channel_id: chanA.id, managed_stream_id: slotA, title: 'Alice live', protocol: 'rtmp' })).lastInsertRowid);
    VODS[100].stream_id = streamA;
    const destA = Number((await db.createRestreamDestination(ALICE, { platform: 'custom', name: 'Alice mirror', server_url: 'rtmp://ingest.example.test/live', stream_key: DEST_KEY, managed_stream_id: slotA })).id);
    const tokenA = (await db.createApiToken(ALICE, 'Alice bot', ['chat', 'read'])).id;
    // Bob has his own slot and stream, so "my slot" routes have something of his to compare against.
    const chanB = await db.getChannelByUserId(BOB);
    const slotB = Number((await db.createManagedStream({ user_id: BOB, channel_id: chanB.id, slug: 'main', title: 'Bob main', protocol: 'rtmp', stream_key: 'ef'.repeat(20) })).lastInsertRowid);

    if (!server.listening) await new Promise((r) => server.once('listening', r));
    quiet('idor: Bob uses Alice\'s ids');

    await check('VODs: edit, delete, publish, bulk and old-VOD cleanup never reach Media for Alice\'s VOD', async () => {
        refused(await call('PUT', '/api/vods/100', BOB, { title: 'pwned', visibility: 'private' }), 'PUT vod');
        refused(await call('DELETE', '/api/vods/100', BOB), 'DELETE vod');
        refused(await call('POST', '/api/vods/100/publish', BOB), 'publish vod');
        const bulk = await call('POST', '/api/vods/bulk', BOB, { ids: [100], action: 'delete' });
        assert.deepStrictEqual([bulk.status, bulk.json && bulk.json.done], [200, 0], bulk.text);
        await call('POST', '/api/vods/bulk', BOB, { ids: [100], action: 'private' });
        await call('POST', '/api/vods/bulk-delete-old', BOB, { older_than_days: 1, vods: true, clips: true, action: 'delete' });
        assert.deepStrictEqual(writesTo('vod', 100), []);
    });
    await check('clips: title, visibility, delete, recut, trim and bulk never reach Media for Alice\'s clip', async () => {
        refused(await call('PUT', '/api/clips/200/title', BOB, { title: 'pwned' }), 'clip title');
        refused(await call('PUT', '/api/clips/200/visibility', BOB, { visibility: 'private' }), 'clip visibility');
        refused(await call('DELETE', '/api/clips/200', BOB), 'DELETE clip');
        refused(await call('POST', '/api/clips/200/recut', BOB), 'recut');
        refused(await call('POST', '/api/clips/200/trim', BOB, { start: 1, end: 2, title: 'pwned' }), 'trim');
        // The old path only sends tabs on to the route above.
        const old = await call('POST', '/api/vods/clips/200/trim', BOB, { start: 1, end: 2 });
        assert.deepStrictEqual([old.status, old.text.includes('Alice')], [307, false], 'the old trim path redirects');
        const bulk = await call('POST', '/api/clips/bulk', BOB, { ids: [200], action: 'delete' });
        assert.deepStrictEqual([bulk.status, bulk.json && bulk.json.done], [200, 0], bulk.text);
        assert.deepStrictEqual(writesTo('clip', 200), []);
    });
    // (Regenerating a PUBLIC item's thumbnail is open to anyone on purpose: pages repair a broken
    // thumbnail lazily, the frame is derived from the video, and there are no custom thumbnails to
    // overwrite. Private items are media-privacy.test.js's.)
    await check('thumbnails: Bob cannot post a live thumbnail into Alice\'s stream', async () => {
        const before = mediaCalls.length;
        const r = await call('POST', `/api/thumbnails/live/${streamA}`, BOB, null, { contentType: 'multipart/form-data; boundary=x', rawBody: '--x\r\nContent-Disposition: form-data; name="thumbnail"; filename="t.jpg"\r\nContent-Type: image/jpeg\r\n\r\nJPEG\r\n--x--\r\n' });
        refused(r, 'live thumbnail');
        assert.strictEqual(mediaCalls.length, before, JSON.stringify(mediaCalls.slice(before)));
    });
    await check('recording chunks: Bob cannot upload into or finalize Alice\'s stream\'s VOD', async () => {
        const before = mediaCalls.length;
        refused(await call('POST', `/api/vods/stream/${streamA}/chunk`, BOB, null, { contentType: 'multipart/form-data; boundary=x', rawBody: '--x\r\nContent-Disposition: form-data; name="chunk"; filename="c.webm"\r\nContent-Type: video/webm\r\n\r\nDATA\r\n--x--\r\n' }), 'chunk');
        refused(await call('POST', `/api/vods/stream/${streamA}/finalize`, BOB, {}), 'finalize');
        assert.strictEqual(mediaCalls.length, before, JSON.stringify(mediaCalls.slice(before)));
    });
    await check('control: Alice can edit her own VOD and clip (the routes work in this harness)', async () => {
        assert.strictEqual((await call('PUT', '/api/vods/100', ALICE, { title: 'Alice renamed' })).status, 200);
        assert.strictEqual((await call('PUT', '/api/clips/200/title', ALICE, { title: 'Alice renamed' })).status, 200);
        assert.ok(writesTo('vod', 100).length >= 1 && writesTo('clip', 200).length >= 1);
        mediaCalls.length = 0;
        const trim = await call('POST', '/api/clips/200/trim', ALICE, { start: 1, end: 4, title: 'Alice trimmed' });
        assert.strictEqual(trim.status, 200, trim.text);
        assert.deepStrictEqual(mediaCalls.map(([k, ...a]) => [k, ...a.slice(0, 2)]), [['updateClip', 200, { title: 'Alice trimmed' }], ['trimClip', 200, { start_s: 1, end_s: 4 }]]);
        mediaCalls.length = 0;
    });
    await check('clip trim: a maker who may not delete their clip on the channel saves its title but cannot cut it down', async () => {
        // Bob clipped Alice's stream; her channel does not let clip makers delete their clips (the default).
        CLIPS[201] = { id: 201, user_id: BOB, channel_user_id: ALICE, vod_id: 100, title: 'Bob clip', visibility: 'public', is_public: 1, status: 'ready', start_time: 10, end_time: 20, duration_seconds: 10 };
        mediaCalls.length = 0;
        const titled = await call('POST', '/api/clips/201/trim', BOB, { start: 0, end: 10, title: 'Bob titled' });
        assert.strictEqual(titled.status, 200, titled.text);
        assert.deepStrictEqual(mediaCalls.map(([k, ...a]) => [k, ...a.slice(0, 2)]), [['updateClip', 201, { title: 'Bob titled' }], ['trimClip', 201, { start_s: 0, end_s: 10 }]], 'the whole clip: the title rule');
        mediaCalls.length = 0;
        const cut = await call('POST', '/api/clips/201/trim', BOB, { start: 0, end: 1, title: 'Bob one second' });
        assert.strictEqual(cut.status, 403, cut.text);
        assert.deepStrictEqual(mediaCalls, [], 'refused before anything is written (not even the title)');
        assert.strictEqual(((await db.getClipAiState(201)) || {}).ai_window ?? null, null, 'no window recorded for a refused trim');
        // Where the channel lets makers delete their clips, they may trim them too; the clip's window is recorded first.
        await raw.prepare('UPDATE channels SET clips_allow_creator_delete = 1 WHERE id = ?').run(chanA.id);
        const allowed = await call('POST', '/api/clips/201/trim', BOB, { start: 0, end: 1 });
        assert.strictEqual(allowed.status, 200, allowed.text);
        assert.deepStrictEqual(mediaCalls.map(([k, ...a]) => [k, ...a.slice(0, 2)]), [['trimClip', 201, { start_s: 0, end_s: 1 }]]);
        assert.strictEqual((await db.getClipAiState(201)).ai_window, '10.0-20.0', 'the pre-trim window, for clip.ready to compare');
        await raw.prepare('UPDATE channels SET clips_allow_creator_delete = 0 WHERE id = ?').run(chanA.id);
        // Alice's channel mods and Alice herself are never held to the maker rule.
        mediaCalls.length = 0;
        assert.strictEqual((await call('POST', '/api/clips/201/trim', ALICE, { start: 2, end: 5 })).status, 200);
        assert.deepStrictEqual(mediaCalls.map(([k]) => k), ['trimClip']);
        mediaCalls.length = 0;
        delete CLIPS[201];
    });

    await check('streams: Bob cannot edit, end or delete Alice\'s stream', async () => {
        const before = await row('streams', streamA);
        refused(await call('PUT', `/api/streams/${streamA}`, BOB, { title: 'pwned', is_nsfw: 1 }), 'PUT stream');
        refused(await call('DELETE', `/api/streams/${streamA}`, BOB), 'DELETE stream');
        refused(await call('POST', `/api/streams/${streamA}/heartbeat`, BOB, {}), 'heartbeat');
        refused(await call('PUT', `/api/streams/${streamA}/call`, BOB, { mode: 'open' }), 'call settings');
        assert.deepStrictEqual(await row('streams', streamA), before);
    });
    await check('slots: Bob cannot edit, delete or regenerate the key of Alice\'s slot, and never sees a key', async () => {
        const before = await row('managed_streams', slotA);
        refused(await call('PUT', `/api/streams/managed/${slotA}`, BOB, { title: 'pwned', stream_key: 'x'.repeat(40), user_id: BOB }), 'PUT slot');
        refused(await call('POST', `/api/streams/managed/${slotA}/regenerate-key`, BOB), 'regenerate slot key');
        refused(await call('DELETE', `/api/streams/managed/${slotA}`, BOB), 'DELETE slot');
        refused(await call('GET', `/api/streams/managed/${slotA}/profile`, BOB), 'slot profile');
        assert.deepStrictEqual(await row('managed_streams', slotA), before);
        const mine = await call('GET', '/api/streams/managed', BOB);
        assert.strictEqual(mine.status, 200);
        assert.ok(!mine.text.includes(SLOT_KEY) && !mine.text.includes('Alice main'), 'Bob\'s slot list is his own');
    });
    await check('slots: Bob\'s account-key regeneration changes only his own key', async () => {
        const r = await call('POST', '/api/auth/stream-key/regenerate', BOB, { user_id: ALICE, managed_stream_id: slotA });
        assert.strictEqual(r.status, 200, r.text.slice(0, 200));
        assert.strictEqual((await db.getUserById(ALICE)).stream_key, '3'.repeat(32));
        assert.strictEqual((await row('managed_streams', slotA)).stream_key, SLOT_KEY);
    });
    await check('vibe-coding: Bob cannot change Alice\'s slot settings', async () => {
        refused(await call('PUT', `/api/vibe-coding/managed/${slotA}/settings`, BOB, { enabled: true, repo: 'bob/pwn' }), 'PUT settings');
        refused(await call('GET', `/api/vibe-coding/managed/${slotA}/settings`, BOB), 'GET settings');
        refused(await call('GET', `/api/vibe-coding/managed/${slotA}/events`, BOB), 'GET events');
        assert.strictEqual((await call('GET', `/api/vibe-coding/managed/${slotA}/settings`, ALICE)).status, 200, 'control: Alice reads hers');
    });
    await check('control: Alice can edit her own slot', async () => {
        const r = await call('PUT', `/api/streams/managed/${slotA}`, ALICE, { title: 'Alice main' });
        assert.strictEqual(r.status, 200, r.text.slice(0, 200));
    });

    await check('restream destinations: Bob cannot edit, delete, start or stop Alice\'s, and his list holds none of hers', async () => {
        const before = await row('restream_destinations', destA);
        refused(await call('PUT', `/api/restream/destinations/${destA}`, BOB, { server_url: 'rtmp://bob.example.test/live', stream_key: 'bob' }), 'PUT destination');
        refused(await call('POST', `/api/restream/destinations/${destA}/start`, BOB), 'start destination');
        refused(await call('POST', `/api/restream/destinations/${destA}/stop`, BOB), 'stop destination');
        refused(await call('DELETE', `/api/restream/destinations/${destA}`, BOB), 'DELETE destination');
        const after = await row('restream_destinations', destA);
        assert.deepStrictEqual({ ...after, updated_at: null }, { ...before, updated_at: null });
        const list = await call('GET', '/api/restream/destinations?all=1', BOB);
        assert.strictEqual(list.status, 200);
        assert.ok(!list.text.includes('Alice mirror') && !list.text.includes(DEST_KEY));
    });
    await check('control: Alice sees her destination, with the key masked', async () => {
        const list = await call('GET', '/api/restream/destinations?all=1', ALICE);
        assert.ok(list.text.includes('Alice mirror'));
        assert.ok(!list.text.includes(DEST_KEY), 'even the owner gets a masked key back');
    });

    await check('API tokens: Bob cannot revoke Alice\'s token', async () => {
        refused(await call('DELETE', `/api/auth/tokens/${tokenA}`, BOB), 'DELETE token');
        assert.strictEqual((await row('api_tokens', tokenA)).is_active, 1);
    });
    await check('Alice can revoke her own token', async () => {
        assert.strictEqual((await call('DELETE', `/api/auth/tokens/${tokenA}`, ALICE)).status, 200);
    });
    await check('anonymous callers get 401 on all of them', async () => {
        for (const [m, p] of [['PUT', '/api/vods/100'], ['DELETE', '/api/clips/200'], ['PUT', `/api/streams/managed/${slotA}`], ['POST', `/api/streams/managed/${slotA}/regenerate-key`],
            ['DELETE', `/api/restream/destinations/${destA}`], ['DELETE', `/api/auth/tokens/${tokenA}`]]) {
            const r = await call(m, p, null, {}).catch((e) => ({ status: 0, text: e.message }));
            assert.strictEqual(r.status, 401, `${m} ${p}: ${r.status} ${r.text}`);
        }
        assert.strictEqual((await row('managed_streams', slotA)).stream_key, SLOT_KEY);
        assert.ok(await row('managed_streams', slotB));
    });

    server.close();
    try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
    if (failures) { quiet(`\n${failures} failure(s)`); process.exit(1); }
    quiet('\nsecurity-idor: all checks passed');
    process.exit(0);
})().catch((e) => { quiet(e); process.exit(1); });
