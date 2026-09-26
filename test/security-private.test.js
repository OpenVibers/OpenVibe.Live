'use strict';
/**
 * Direct messages stay between their participants on every HTTP path (roadmap WS-R task 5, the
 * private-room class). dm-delivery.test.js pins live delivery (dm.isParticipant before a socket
 * gets a message) and authorization.test.js that a 1:1 cannot grow a third person; this suite
 * walks every /api/dm route as someone outside the conversation, as a participant who was removed
 * from a group, and anonymously:
 *
 *   read the conversation, its messages (every cursor form), the conversation list and the unread
 *   count; post into it, mark it read, rename it, add themselves or someone else, remove a
 *   participant, delete a participant's message.
 *
 * Each refusal leaves the conversation as it was and returns none of its text. (Private VODs and
 * clips are media-privacy.test.js's; with Chat serving /api/dm, OpenVibe.Chat has the same suite.)
 *
 *   node test/security-private.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = path.join(os.tmpdir(), `ov-private-${process.pid}.db`);
process.env.DB_PATH = tmp;
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-sec-data-'));   // nothing lands in the checkout's data/
process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};
console.error = () => {};

const db = require('../server/db/database');
db.initDb();
const raw = db.getDb();
const dm = require('../server/chat/dm');
dm.ensureTables();

const auth = require('../server/auth/auth');
const signIn = (req) => {
    const id = Number(req.headers['x-test-user'] || 0);
    const u = id ? db.getUserById(id) : null;
    if (u) { req.user = u; req.authSource = 'network'; }
    return u;
};
auth.requireAuth = (req, res, next) => (signIn(req) ? next() : res.status(401).json({ error: 'Authentication required' }));
auth.optionalAuth = (req, res, next) => { signIn(req); next(); };

const addUser = (id, username, role = 'user') => raw.prepare(
    `INSERT INTO users (id, username, display_name, email, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, 'x', ?, '2025-01-01 00:00:00')`).run(id, username, username, `${username}@example.test`, role);
const ANN = 11, BEN = 12, CAT = 13, EVE = 14, MOD = 15;
addUser(ANN, 'ann'); addUser(BEN, 'ben'); addUser(CAT, 'cat'); addUser(EVE, 'eve'); addUser(MOD, 'moddy', 'global_mod');

// A 1:1 between Ann and Ben, and a group Ann made with Ben and Cat (Cat is removed later).
const directId = Number(dm.getOrCreateDirect(ANN, BEN));
const groupId = Number(dm.createConversation(ANN, [ANN, BEN, CAT], 'Plans'));
const say = (conv, who, text) => Number(dm.sendMessage(conv, who, text).id);
const msgDirect = say(directId, BEN, 'the secret direct message');
const msgGroupOld = say(groupId, BEN, 'the secret group message');

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/dm', require('../server/chat/dm-routes'));
const server = http.createServer(app).listen(0, '127.0.0.1');
function call(method, p, user, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const headers = { 'content-type': 'application/json' };
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
const SECRETS = ['secret direct', 'secret group', 'Plans'];
const snapshot = () => ({
    conversations: raw.prepare('SELECT * FROM dm_conversations ORDER BY id').all(),
    participants: raw.prepare('SELECT conversation_id, user_id FROM dm_participants ORDER BY conversation_id, user_id').all(),
    messages: raw.prepare('SELECT id, conversation_id, sender_id, message FROM dm_messages ORDER BY id').all().map((m) => ({ ...m })),
});

let failures = 0;
async function check(name, fn) {
    try { await fn(); quiet('  ✓', name); } catch (e) { failures++; quiet('  ✗', name, '\n     ', String(e.stack || e.message).split('\n').slice(0, 6).join('\n      ')); }
}

/** Every DM path against conversation `id`, as `user`: all must refuse and carry nothing. */
async function outsider(user, id, label) {
    const before = snapshot();
    const reads = [
        ['GET', `/api/dm/conversations/${id}`], ['GET', `/api/dm/conversations/${id}/messages`],
        ['GET', `/api/dm/conversations/${id}/messages?before=999999`], ['GET', `/api/dm/conversations/${id}/messages?after=0`],
        ['GET', `/api/dm/conversations/${id}/messages?limit=500`],
    ];
    const writes = [
        ['POST', `/api/dm/conversations/${id}/messages`, { message: 'hi', text: 'hi' }],
        ['POST', `/api/dm/conversations/${id}/read`, {}],
        ['PATCH', `/api/dm/conversations/${id}`, { name: 'pwned' }],
        ['POST', `/api/dm/conversations/${id}/participants`, { user_id: user || EVE }],
        ['POST', `/api/dm/conversations/${id}/participants`, { user_id: MOD }],
        ['DELETE', `/api/dm/conversations/${id}/participants/${BEN}`],
        ['DELETE', `/api/dm/conversations/${id}/messages/${msgDirect}`],
        ['DELETE', `/api/dm/conversations/${id}/messages/${msgGroupOld}`],
    ];
    for (const [m, p, body] of [...reads, ...writes]) {
        const r = await call(m, p, user, body);
        assert.ok([401, 403, 404].includes(r.status), `${label}: ${m} ${p} → ${r.status} ${r.text.slice(0, 160)}`);
        for (const s of SECRETS) assert.ok(!r.text.includes(s), `${label}: ${m} ${p} carries "${s}"`);
    }
    assert.deepStrictEqual(snapshot(), before, `${label}: nothing changed`);
}

(async () => {
    await new Promise((r) => server.once('listening', r));
    quiet('private: direct messages');

    await check('control: participants read their conversations (the routes work in this harness)', async () => {
        const r = await call('GET', `/api/dm/conversations/${directId}/messages`, ANN);
        assert.strictEqual(r.status, 200, r.text.slice(0, 200));
        assert.ok(r.text.includes('the secret direct message'));
        const g = await call('GET', `/api/dm/conversations/${groupId}/messages`, CAT);
        assert.strictEqual(g.status, 200);
        assert.ok(g.text.includes('the secret group message'));
    });
    await check('an outsider gets nothing from a 1:1 on any path, and changes nothing', () => outsider(EVE, directId, 'outsider/direct'));
    await check('an outsider gets nothing from a group on any path, and changes nothing', () => outsider(EVE, groupId, 'outsider/group'));
    await check('a global mod is an outsider to other people\'s DMs too', () => outsider(MOD, directId, 'mod/direct'));
    await check('anonymous gets 401 everywhere', () => outsider(null, directId, 'anonymous'));
    await check('the outsider\'s own lists hold none of it (conversations, unread, search)', async () => {
        const list = await call('GET', '/api/dm/conversations', EVE);
        assert.strictEqual(list.status, 200);
        for (const s of SECRETS) assert.ok(!list.text.includes(s), list.text.slice(0, 200));
        const unread = await call('GET', '/api/dm/unread', EVE);
        assert.strictEqual(unread.status, 200);
        assert.ok(!/[1-9]/.test(JSON.stringify(unread.json)), `unread: ${unread.text}`);
        const search = await call('GET', '/api/dm/users/search?q=ann', EVE);
        assert.ok(!search.text.includes('@example.test'), 'no email in user search');
    });
    await check('a participant removed from a group loses every path from then on', async () => {
        const r = await call('DELETE', `/api/dm/conversations/${groupId}/participants/${CAT}`, ANN);
        assert.strictEqual(r.status, 200, r.text.slice(0, 200));
        say(groupId, BEN, 'the secret group message after cat left');
        await outsider(CAT, groupId, 'removed/group');
        const list = await call('GET', '/api/dm/conversations', CAT);
        assert.ok(!list.text.includes('Plans'), 'the group left her list');
    });
    await check('a participant of one conversation cannot reach another through it (ids swapped)', async () => {
        // Ann is in both; Eve starts her own 1:1 with Ann and tries Ann's other conversations' message ids.
        const mineId = Number(dm.getOrCreateDirect(EVE, ANN));
        const before = snapshot();
        const del = await call('DELETE', `/api/dm/conversations/${mineId}/messages/${msgDirect}`, EVE);
        assert.ok([403, 404].includes(del.status), `delete through her own conversation: ${del.status}`);
        const page = await call('GET', `/api/dm/conversations/${mineId}/messages?before=${msgDirect + 1}`, EVE);
        assert.strictEqual(page.status, 200);
        for (const s of SECRETS) assert.ok(!page.text.includes(s), `her own conversation's page carries "${s}"`);
        assert.deepStrictEqual(snapshot(), before);
    });

    server.close();
    for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch { /* */ } }
    try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
    if (failures) { quiet(`\n${failures} failure(s)`); process.exit(1); }
    quiet('\nsecurity-private: all checks passed');
    process.exit(0);
})().catch((e) => { quiet(e); process.exit(1); });
