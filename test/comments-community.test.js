/**
 * VOD and clip comments are OpenVibe.Community threads (roadmap Wave 5). /api/comments keeps its
 * paths and response shapes but is an adapter (server/comments-client.js): the thread of
 * { service: 'live', type, id } is resolved once with Live's service token and remembered; people
 * read, comment and edit as their Network subject (X-OV-Subject); deletes go as the author, as
 * staff (X-OV-Staff) or, for the item's owners, as Live itself; deleting a VOD hides its thread; a
 * Community outage is a 503 "comments are unavailable", never an empty list; and Live's own
 * comments table is neither read nor written.
 *
 * The real routers run on a temp database with Media stubbed, Community replaced by
 * test/community-stub.js and sign-in stubbed by an `x-test-user` header.
 *
 *   node test/comments-community.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = path.join(os.tmpdir(), `ov-comments-community-${process.pid}.db`);
process.env.DB_PATH = tmp;
process.env.NODE_ENV = 'test';
process.env.OV_COMMUNITY_URL = 'https://openvibe.community';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

const db = require('../server/db/database');
db.initDb();
const raw = db.getDb();

const auth = require('../server/auth/auth');
const signIn = (req) => {
    const id = Number(req.headers['x-test-user'] || 0);
    const u = id ? db.getUserById(id) : null;
    if (u) { req.user = u; req.authSource = 'network'; }
    return u;
};
auth.requireAuth = (req, res, next) => (signIn(req) ? next() : res.status(401).json({ error: 'Authentication required' }));
auth.optionalAuth = (req, res, next) => { signIn(req); next(); };

const notify = require('../server/utils/notify');
const pushed = [];
notify.pushNotification = (p) => { pushed.push(p); };
const principal = require('../server/net/network-principal');
principal.serviceHeaders = async () => ({ Authorization: 'Bearer test-service-token' });

const SUB = (c) => `usr_01JAB2C3D4E5F6G7H8J9K0MNP${c}`;
const addUser = (id, username, role, subject) => {
    raw.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role, profile_color, created_at)
                 VALUES (?, ?, ?, ?, 'x', ?, '#123456', '2025-01-01 00:00:00')`).run(id, username, username.toUpperCase(), `${username}@x`, role);
    if (subject) raw.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (?, 'network', ?, ?)").run(id, String(100 + id), subject);
};
addUser(1, 'admin', 'admin', SUB('A'));
addUser(3, 'alice', 'streamer', SUB('B'));     // owns VOD 100 and the stream clip 200 came from
addUser(5, 'carol', 'user', SUB('C'));         // made clip 200
addUser(7, 'mallory', 'user', SUB('E'));       // nobody special
addUser(9, 'nolink', 'user', null);            // no Network subject on file
db.ensureChannel(3);
const streamA = Number(db.createStream({ user_id: 3, channel_id: db.getChannelByUserId(3).id, title: 'A', protocol: 'webrtc' }).lastInsertRowid);

// A legacy row in Live's frozen comments table: never shown, never touched.
raw.prepare("INSERT INTO comments (content_type, content_id, user_id, message) VALUES ('vod', 100, 5, 'legacy local row')").run();
const legacyBefore = raw.prepare('SELECT * FROM comments').all();

const media = require('../server/media-client');
const VODS = {
    100: { id: 100, user_id: 3, title: 'Public VOD', visibility: 'public', is_public: 1, status: 'ready' },
    101: { id: 101, user_id: 3, title: 'Private VOD', visibility: 'private', is_public: 0, status: 'ready' },
    102: { id: 102, user_id: 3, title: 'Unlisted VOD', visibility: 'unlisted', is_public: 0, status: 'ready' },
};
const CLIPS = { 200: { id: 200, user_id: 5, stream_id: streamA, title: 'Public clip', visibility: 'public', is_public: 1, status: 'ready' } };
const missing = (what) => new media.MediaApiError(`${what} not found`, 404, { error: `${what} not found` });
media.getVod = async (id) => { const v = VODS[Number(id)]; if (!v) throw missing('VOD'); return { ...v }; };
media.getClip = async (id) => { const c = CLIPS[Number(id)]; if (!c) throw missing('Clip'); return { ...c }; };
media.listClips = async () => ({ clips: [] });
media.deleteVod = async (id) => { delete VODS[Number(id)]; return {}; };

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/vods', require('../server/media-proxy/vods'));
app.use('/api/clips', require('../server/media-proxy/clips'));
app.use('/api/comments', require('../server/media-proxy/comments'));
const commentsClient = require('../server/comments-client');
const server = http.createServer(app).listen(0);

function call(method, p, user, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const headers = { 'content-type': 'application/json' };
        if (user) headers['x-test-user'] = String(user);
        const req = http.request({ port: server.address().port, path: p, method, headers }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode, json, text }); });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

let failures = 0;
async function check(name, fn) {
    try { await fn(); quiet('  ✓', name); }
    catch (e) { failures++; quiet('  ✗', name, '\n     ', e.stack.split('\n').slice(0, 3).join('\n      ')); }
}

(async () => {
    await new Promise((r) => server.once('listening', r));
    const stub = await (require('./community-stub').startCommunityStub({ people: { [SUB('Z')]: { username: 'zed', display_name: 'Zed from Community' } } }));
    process.env.OV_COMMUNITY_INTERNAL_URL = stub.url;
    const last = (method, re) => [...stub.calls].reverse().find((c) => c.method === method && re.test(c.path));
    let carolTop, aliceReply;

    await check('list: the thread of live/vod/<id> is resolved once (labelled, remembered), with a link to the same thread on Community', async () => {
        const r = await call('GET', '/api/comments/vod/100');
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(r.json.comments, []);
        assert.strictEqual(r.json.total, 0);
        const resolve = last('POST', /^\/threads\/resolve$/);
        assert.deepStrictEqual(resolve.body, { ref: { service: 'live', type: 'vod', id: '100', label: 'Public VOD' } });
        assert.ok(resolve.auth, 'with Live\'s service token');
        assert.match(r.json.thread.id, /^cth_/);
        assert.strictEqual(r.json.thread.url, `https://openvibe.community/c/${r.json.thread.id}`);
        const n = stub.calls.filter((c) => c.path === '/threads/resolve').length;
        await call('GET', '/api/comments/vod/100', 5);
        assert.strictEqual(stub.calls.filter((c) => c.path === '/threads/resolve').length, n, 'remembered in comment_thread_refs');
        assert.strictEqual(raw.prepare('SELECT COUNT(*) AS n FROM comment_thread_refs').get().n, 1);
        assert.ok((await call('GET', '/api/comments/vod/102')).json.thread, 'unlisted items are linked too');
        assert.strictEqual((await call('GET', '/api/comments/vod/101', 3)).json.thread, undefined, 'private items never are');
        assert.strictEqual((await call('GET', '/api/comments/vod/101')).status, 404);
    });

    await check('post: as the signed-in person\'s subject, the old response shape, notifications to the owner and the parent\'s author', async () => {
        const r = await call('POST', '/api/comments/vod/100', 5, { message: '  great stream  ' });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(last('POST', /\/comments$/).subject, SUB('C'));
        assert.ok(last('POST', /\/comments$/).xff, 'the visitor\'s address rides along (Community limits per address)');
        carolTop = r.json.comment;
        for (const [k, v] of Object.entries({ content_type: 'vod', content_id: 100, user_id: 5, username: 'carol', display_name: 'CAROL', profile_color: '#123456', role: 'user', message: 'great stream', parent_id: null, is_deleted: 0, can_edit: true, can_delete: true })) {
            assert.deepStrictEqual(carolTop[k], v, k);
        }
        assert.strictEqual(carolTop.updated_at, carolTop.created_at, 'not edited');
        assert.deepStrictEqual(pushed.map((p) => [p.user_id, p.type]), [[3, 'CONTENT_COMMENT']]);

        const reply = await call('POST', '/api/comments/vod/100', 3, { message: 'thanks!', parent_id: carolTop.id });
        assert.strictEqual(reply.status, 201, reply.text);
        aliceReply = reply.json.comment;
        assert.strictEqual(aliceReply.parent_id, carolTop.id);
        assert.deepStrictEqual(pushed.slice(1).map((p) => [p.user_id, p.type]), [[5, 'CONTENT_REPLY']], 'the parent\'s author, found by subject');

        assert.strictEqual((await call('POST', '/api/comments/vod/100', null, { message: 'anon' })).status, 401, 'signed in only, as before');
        assert.strictEqual((await call('POST', '/api/comments/vod/100', 9, { message: 'no subject' })).status, 409);
        assert.strictEqual((await call('POST', '/api/comments/vod/100', 5, { message: 'x'.repeat(2001) })).status, 400);
        assert.strictEqual((await call('POST', '/api/comments/vod/100', 5, { message: '   ' })).status, 400);
        const clipComment = (await call('POST', '/api/comments/clip/200', 5, { message: 'on the clip' })).json.comment;
        const cross = await call('POST', '/api/comments/vod/100', 5, { message: 'cross', parent_id: clipComment.id });
        assert.strictEqual(cross.status, 400, 'a parent from another thread');
        assert.strictEqual((await call('POST', '/api/comments/vod/101', 7, { message: 'hi' })).status, 404);
    });

    await check('list: newest first, replies nested, total, people who only use Community, edits marked, limit/offset', async () => {
        const vodThread = stub.threads.find((t) => t.ref.type === 'vod' && t.ref.id === '100');
        stub.comments.push({ id: stub.comments.length + 1, thread_id: vodThread.id, parent_id: null, author: SUB('Z'), message: 'said on Community', created_at: '2026-09-02T00:00:00.000Z', edited_at: null, deleted_at: null });
        const r = await call('GET', '/api/comments/vod/100', 5);
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.total, 3);
        assert.deepStrictEqual(r.json.comments.map((c) => c.message), ['said on Community', 'great stream']);
        const zed = r.json.comments[0];
        assert.deepStrictEqual([zed.user_id, zed.username, zed.display_name, zed.subject, zed.can_edit, zed.can_delete], [null, 'zed', 'Zed from Community', SUB('Z'), false, false]);
        assert.deepStrictEqual(r.json.comments[1].replies.map((c) => [c.message, c.username, c.can_delete]), [['thanks!', 'alice', false]]);
        const asOwner = (await call('GET', '/api/comments/vod/100', 3)).json;
        assert.ok(asOwner.comments.every((c) => c.can_delete), 'the VOD\'s owner may delete any comment on it');
        assert.ok(!asOwner.comments[0].can_edit, 'but edit only their own');
        assert.strictEqual(last('GET', /^\/threads\/\d+$/).subject, SUB('B'), 'read as the viewer');
        const page = (await call('GET', '/api/comments/vod/100?limit=1&offset=1')).json;
        assert.deepStrictEqual(page.comments.map((c) => c.message), ['great stream']);
        assert.ok(!r.text.includes('legacy local row'), 'Live\'s own table is not read');
    });

    await check('replies: /:commentId/replies answers for Live comments the caller may see', async () => {
        const r = await call('GET', `/api/comments/${carolTop.id}/replies`);
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(r.json.replies.map((c) => c.message), ['thanks!']);
        assert.deepStrictEqual((await call('GET', `/api/comments/${aliceReply.id}/replies`)).json.replies, []);
        assert.strictEqual((await call('GET', '/api/comments/424242/replies')).status, 404);
    });

    await check('edit: the author only (as their subject); edits show as edited', async () => {
        assert.strictEqual((await call('PUT', `/api/comments/${carolTop.id}`, 7, { message: 'hijack' })).status, 403);
        assert.strictEqual((await call('PUT', `/api/comments/${carolTop.id}`, 1, { message: 'staff rewrite' })).status, 403, 'staff delete, they do not rewrite');
        assert.strictEqual((await call('PUT', `/api/comments/${carolTop.id}`, 5, { message: '' })).status, 400);
        const ok = await call('PUT', `/api/comments/${carolTop.id}`, 5, { message: 'great stream!!' });
        assert.strictEqual(ok.status, 200, ok.text);
        assert.deepStrictEqual(ok.json, { message: 'Comment updated' });
        assert.strictEqual(last('PATCH', /^\/\d+$/).subject, SUB('C'));
        const c = (await call('GET', '/api/comments/vod/100')).json.comments.find((x) => x.id === carolTop.id);
        assert.strictEqual(c.message, 'great stream!!');
        assert.ok(c.edited_at && c.updated_at !== c.created_at, 'the SPA shows "(edited)"');
    });

    await check('delete: strangers 403; the author as themselves; staff vouched as staff; the item\'s owners through Live itself', async () => {
        assert.strictEqual((await call('DELETE', `/api/comments/${carolTop.id}`, 7)).status, 403);
        const extra = (await call('POST', '/api/comments/vod/100', 7, { message: 'mallory was here' })).json.comment;
        assert.strictEqual((await call('DELETE', `/api/comments/${extra.id}`, 7)).status, 200);
        let d = last('DELETE', /^\/\d+$/);
        assert.deepStrictEqual([d.subject, d.staff], [SUB('E'), false]);
        const byStaff = (await call('POST', '/api/comments/vod/100', 7, { message: 'staff will remove this' })).json.comment;
        assert.strictEqual((await call('DELETE', `/api/comments/${byStaff.id}`, 1)).status, 200);
        d = last('DELETE', /^\/\d+$/);
        assert.deepStrictEqual([d.subject, d.staff], [SUB('A'), true]);
        const onClip = (await call('POST', '/api/comments/clip/200', 7, { message: 'rude clip comment' })).json.comment;
        assert.strictEqual((await call('DELETE', `/api/comments/${onClip.id}`, 3)).status, 200, 'the streamer the clip was cut from');
        d = last('DELETE', /^\/\d+$/);
        assert.deepStrictEqual([d.subject, d.staff], [null, false], 'Live moderates as itself');
        // A top-level comment with replies stays as a tombstone.
        assert.strictEqual((await call('DELETE', `/api/comments/${carolTop.id}`, 3)).status, 200);
        const list = (await call('GET', '/api/comments/vod/100')).json;
        const tomb = list.comments.find((c) => c.id === carolTop.id);
        assert.deepStrictEqual([tomb.deleted, tomb.is_deleted, tomb.message, tomb.username, tomb.can_delete], [true, 1, '', null, false]);
        assert.deepStrictEqual(tomb.replies.map((c) => c.message), ['thanks!']);
        assert.strictEqual((await call('DELETE', `/api/comments/${carolTop.id}`, 3)).status, 404, 'gone');
    });

    await check('a thread Community\'s moderators hid is hidden on Live too, whoever asks', async () => {
        const t = stub.threads.find((x) => x.ref.type === 'clip' && x.ref.id === '200');
        t.visibility = 'hidden';
        for (const user of [null, 5]) {
            const r = await call('GET', '/api/comments/clip/200', user);
            assert.deepStrictEqual([r.status, r.json], [404, { error: 'Comments are hidden here', code: 'comments_hidden' }], `user ${user}`);
        }
        t.visibility = 'public';
        assert.strictEqual((await call('GET', '/api/comments/clip/200')).status, 200);
    });

    await check('Community down: every route says comments are unavailable (503), never an empty list; VOD pages still load, fast', async () => {
        stub.down = true;
        const unavailable = { error: 'Comments are unavailable right now', code: 'comments_unavailable' };
        for (const [method, p, user, body] of [
            ['GET', '/api/comments/vod/100', null], ['GET', '/api/comments/vod/100', 5], ['POST', '/api/comments/vod/100', 5, { message: 'hello?' }],
            ['PUT', `/api/comments/${aliceReply.id}`, 3, { message: 'x' }], ['DELETE', `/api/comments/${aliceReply.id}`, 3], ['GET', `/api/comments/${aliceReply.id}/replies`, null],
        ]) {
            const r = await call(method, p, user, body);
            assert.deepStrictEqual([r.status, r.json], [503, unavailable], `${method} ${p}`);
        }
        const t0 = Date.now();
        const vod = await call('GET', '/api/vods/100');
        assert.strictEqual(vod.status, 200);
        assert.strictEqual(vod.json.vod.comment_count, null, 'unknown, not 0');
        const again = Date.now();
        assert.strictEqual((await call('GET', '/api/vods/100')).json.vod.comment_count, null);
        assert.ok(Date.now() - again < 1000 && again - t0 < 5000, 'no waiting on a Community that is down');
        stub.down = false;
    });

    await check('deleting a VOD hides its Community thread', async () => {
        const r = await call('DELETE', '/api/vods/100', 3);
        assert.strictEqual(r.status, 200, r.text);
        await commentsClient.hideThreadOf('none', 0);   // the queue: wait for the background hide
        const t = stub.threads.find((x) => x.ref.type === 'vod' && x.ref.id === '100');
        assert.strictEqual(t.visibility, 'hidden');
        const put = last('PUT', /\/visibility$/);
        assert.deepStrictEqual([put.subject, put.body], [null, { visibility: 'hidden' }]);
    });

    await check('Live\'s own comments table was neither read nor written', async () => {
        assert.deepStrictEqual(raw.prepare('SELECT * FROM comments').all(), legacyBefore);
    });

    server.close();
    await stub.close();
    for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch { /* */ } }
    if (failures) { quiet(`\n${failures} check(s) failed`); process.exit(1); }
    quiet('comments on Community: all checks passed');
    process.exit(0);
})().catch((err) => { quiet(err); server.close(); process.exit(1); });
