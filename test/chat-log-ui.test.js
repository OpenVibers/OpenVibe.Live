/**
 * Legacy parity (roadmap D20): the chat-log views.
 *
 *   streamer  Dashboard → Chat Logs (public/js/dashboard.js loadDashChatLogs / dashPurgeChatRange):
 *             search, user and time filters, pages of 50, purge a time range after a preview count.
 *             Scoped server-side to the streamer's own (most recent) stream.
 *   mod       the chat user card's "View Chat Logs" (public/js/chat.js openChatLogsModal): a user's,
 *             an anonymous chatter's or a relay chatter's history, and search. Staff (admin, global
 *             mod: staff.moderation.logs) see anyone's; everyone else only their own.
 *
 * The page's own functions run against a fake DOM and the real routes (server/chat/routes.js, the
 * CHAT_AUTHORITY=live path; OpenVibe.Chat serves the same API otherwise) on a temp database.
 *
 *   node test/chat-log-ui.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-chat-logs-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
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
require.cache[require.resolve('../server/chat/chat-server')] = {
    id: 'chat-server-stub', filename: 'chat-server-stub', loaded: true,
    exports: { broadcastToStream() {}, broadcastGlobal() {}, getStreamViewerCount: () => 0 },
};

const addUser = (id, username, role) => raw.prepare(
    `INSERT INTO users (id, username, display_name, email, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, 'x', ?, '2025-01-01 00:00:00')`).run(id, username, username, `${username}@x`, role);
addUser(1, 'admin', 'admin');
addUser(3, 'alice', 'streamer');
addUser(4, 'bob', 'streamer');
addUser(6, 'mod', 'global_mod');
addUser(7, 'viewer', 'user');
for (const id of [3, 4]) db.ensureChannel(id);
const stream = (userId, created) => {
    const id = Number(db.createStream({ user_id: userId, channel_id: db.getChannelByUserId(userId).id, title: 's', protocol: 'webrtc' }).lastInsertRowid);
    raw.prepare('UPDATE streams SET created_at = ? WHERE id = ?').run(created, id);
    return id;
};
const aliceOld = stream(3, '2026-09-19 10:00:00');
const aliceNow = stream(3, '2026-09-20 10:00:00');
const bobs = stream(4, '2026-09-20 11:00:00');
const say = (sid, userId, username, message, ts, extra = {}) => raw.prepare(
    `INSERT INTO chat_messages (stream_id, user_id, anon_id, username, message, message_type, timestamp) VALUES (?, ?, ?, ?, ?, 'chat', ?)`)
    .run(sid, userId, extra.anon || null, username, message, ts);
say(aliceOld, 7, 'viewer', 'yesterday hello', '2026-09-19 10:05:00');
say(aliceNow, 7, 'viewer', 'hi alice', '2026-09-20 10:01:00');
say(aliceNow, 7, 'viewer', '<img src=x onerror=alert(1)>', '2026-09-20 10:02:00');
say(aliceNow, null, 'anon42', 'anon says hi', '2026-09-20 10:03:00', { anon: 'anon42' });
say(bobs, 7, 'viewer', 'hi bob', '2026-09-20 11:01:00');
say(bobs, 4, 'bob', 'bob replies', '2026-09-20 11:02:00');

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/chat', require('../server/chat/routes'));
const server = http.createServer(app).listen(0);
function call(method, p, user, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const headers = { 'content-type': 'application/json' };
        if (data) headers['content-length'] = Buffer.byteLength(data);
        if (user) headers['x-test-user'] = String(user);
        const req = http.request({ port: server.address().port, path: p, method, headers }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode, json, text, headers: res.headers }); });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

/** The source of a top-level function declaration, braces matched. */
function extract(src, name) {
    const m = new RegExp(`(?:async )?function ${name}\\(`).exec(src);
    assert.ok(m, `${name}() must exist`);
    let i = src.indexOf('{', m.index);
    let depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(m.index, i + 1);
    }
    throw new Error(`unbalanced ${name}`);
}

/** The dashboard card, with the page's own functions and api() going to the real routes as `user`. */
function dashboard(user, inputs = {}) {
    const els = {};
    for (const id of ['dash-chatlog-results', 'dash-chatlog-pagination', 'dash-chatlog-search', 'dash-chatlog-username', 'dash-chatlog-from', 'dash-chatlog-to']) {
        els[id] = { innerHTML: '', value: inputs[id] || '' };
    }
    const toasts = [];
    const requests = [];
    const fixtures = {
        document: { getElementById: (id) => els[id] || null },
        api: async (p, opts = {}) => {
            requests.push([opts.method || 'GET', p]);
            const r = await call(opts.method || 'GET', `/api${p}`, user, opts.body ? JSON.parse(opts.body) : undefined);
            if (r.status >= 400) throw new Error(r.json?.error || `HTTP ${r.status}`);
            return r.json;
        },
        toast: (msg, kind) => toasts.push([msg, kind]),
        confirm: () => true,
        _chatLogPage: 1,
    };
    const scope = new Proxy(fixtures, {
        has: (t, k) => typeof k === 'string',
        get: (t, k) => (k === Symbol.unscopables ? undefined : (k in t ? t[k] : globalThis[k])),
        set: (t, k, v) => { t[k] = v; return true; },
    });
    const src = [extract(read('public/js/app.js'), 'esc'), extract(read('public/js/dashboard.js'), 'loadDashChatLogs'), extract(read('public/js/dashboard.js'), 'dashPurgeChatRange')].join('\n');
    // eslint-disable-next-line no-new-func
    const fns = new Function('scope', `with (scope) { ${src}\n return { loadDashChatLogs, dashPurgeChatRange }; }`)(scope);
    return { fns, els, toasts, requests };
}

let failures = 0;
async function check(name, fn) {
    try { await fn(); quiet('  ✓', name); } catch (e) { failures++; quiet('  ✗', name, '\n     ', e.stack || e.message); }
}

(async () => {
    await new Promise((r) => server.once('listening', r));

    await check('the dashboard card is part of the dashboard page and wired to the page\'s functions', async () => {
        const reg = JSON.parse(read('public/features.json'));
        assert.strictEqual(reg.features.dashboard.fragment, 'dashboard');
        assert.ok(reg.features.dashboard.js.includes('/js/dashboard.js'));
        const html = read('public/fragments/dashboard.html');
        for (const id of ['dash-card-chatlogs', 'dash-chatlog-search', 'dash-chatlog-username', 'dash-chatlog-from', 'dash-chatlog-to', 'dash-chatlog-results', 'dash-chatlog-pagination']) {
            assert.ok(html.includes(`id="${id}"`), `#${id}`);
        }
        assert.match(html, /onclick="loadDashChatLogs\(\)"/);
        assert.match(html, /onclick="dashPurgeChatRange\(\)"/);
    });

    await check('a streamer sees their own stream\'s log, escaped, newest first', async () => {
        const d = dashboard(3);
        await d.fns.loadDashChatLogs();
        const out = d.els['dash-chatlog-results'].innerHTML;
        assert.ok(out.includes('<table'), out);
        assert.ok(out.includes('hi alice') && out.includes('anon says hi'));
        assert.ok(!out.includes('hi bob') && !out.includes('yesterday hello'), 'not another channel\'s, nor an older stream\'s');
        assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;') && !out.includes('<img src=x'), 'messages are escaped');
        assert.ok(out.indexOf('anon says hi') < out.indexOf('hi alice'), 'newest first');
    });

    await check('the search, user and time filters narrow it', async () => {
        let d = dashboard(3, { 'dash-chatlog-search': 'says' });
        await d.fns.loadDashChatLogs();
        assert.ok(d.els['dash-chatlog-results'].innerHTML.includes('anon says hi'));
        assert.ok(!d.els['dash-chatlog-results'].innerHTML.includes('hi alice'));
        d = dashboard(3, { 'dash-chatlog-username': 'nobody' });
        await d.fns.loadDashChatLogs();
        assert.match(d.els['dash-chatlog-results'].innerHTML, /No messages found/);
        // datetime-local inputs are local time; the page sends them as ISO instants.
        const local = (iso) => { const t = new Date(iso); return new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
        d = dashboard(3, { 'dash-chatlog-from': local('2026-09-20T10:02:00Z'), 'dash-chatlog-to': local('2026-09-20T10:02:59Z') });
        await d.fns.loadDashChatLogs();
        const out = d.els['dash-chatlog-results'].innerHTML;
        assert.ok(out.includes('onerror') && !out.includes('hi alice') && !out.includes('anon says hi'), 'exactly the minute asked for');
    });

    await check('pages of 50 with previous/next', async () => {
        for (let i = 0; i < 60; i++) say(aliceNow, 7, 'viewer', `line ${i}`, `2026-09-20 12:${String(i).padStart(2, '0')}:00`);
        const d = dashboard(3);
        await d.fns.loadDashChatLogs();
        assert.match(d.els['dash-chatlog-pagination'].innerHTML, /Page 1 of 2/);
        assert.match(d.els['dash-chatlog-pagination'].innerHTML, /loadDashChatLogs\(2\)/);
        await d.fns.loadDashChatLogs(2);
        assert.match(d.els['dash-chatlog-pagination'].innerHTML, /loadDashChatLogs\(1\)/);
        assert.ok(d.requests.every(([, p]) => /limit=50/.test(p)));
    });

    await check('purge a range from the card: preview count, confirm, purge, reload', async () => {
        const local = (iso) => { const t = new Date(iso); return new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
        const d = dashboard(3, { 'dash-chatlog-from': local('2026-09-20T12:00:00Z'), 'dash-chatlog-to': local('2026-09-20T12:09:00Z') });
        await d.fns.dashPurgeChatRange();
        assert.deepStrictEqual(d.toasts.pop(), ['Purged 10 messages', 'success']);
        assert.deepStrictEqual(d.requests.map(([m, p]) => `${m} ${p.split('?')[0]}`), ['POST /chat/admin/purge/preview', 'DELETE /chat/admin/purge', 'GET /chat/admin/logs']);
        const empty = dashboard(3);
        await empty.fns.dashPurgeChatRange();
        assert.strictEqual(empty.toasts[0][1], 'error', 'both ends of the range are required');
    });

    await check('the server keeps each streamer to their own logs; staff see any, and purged lines on request', async () => {
        assert.strictEqual((await call('GET', `/api/chat/admin/logs?streamId=${bobs}`, 3)).status, 403);
        assert.strictEqual((await call('GET', `/api/chat/admin/logs/export?streamId=${bobs}&format=json`, 3)).status, 403);
        assert.strictEqual((await call('GET', '/api/chat/admin/logs/export?format=json', 3)).status, 403, 'only staff export everything');
        const own = await call('GET', `/api/chat/admin/logs/export?streamId=${aliceOld}&format=csv`, 3);
        assert.strictEqual(own.status, 200);
        assert.match(own.headers['content-type'], /text\/csv/);
        assert.match(own.text, /yesterday hello/, 'an older stream of their own by id');
        const admin = await call('GET', `/api/chat/admin/logs?streamId=${aliceNow}&includeDeleted=true&limit=200`, 1);
        assert.strictEqual(admin.json.total, 63, 'purged lines stay auditable by staff');
        const owner = await call('GET', `/api/chat/admin/logs?streamId=${aliceNow}&includeDeleted=true&limit=200`, 3);
        assert.strictEqual(owner.json.total, 53, 'the streamer only sees what is left');
    });

    await check('the mod view: staff read anyone\'s history, anonymous and relay chatters included; others only their own', async () => {
        const chat = read('public/js/chat.js');
        const load = extract(chat, 'loadChatLogs');
        for (const route of ['/chat/anon/${encodeURIComponent(ctx.anon)}/logs', '/chat/relay-user/${encodeURIComponent(ctx.relay.platform)}/${encodeURIComponent(ctx.relay.username)}/logs', '/chat/user/${ctx.userId}/history', '/chat/search?${params}']) {
            assert.ok(load.includes(route), `the modal reads ${route}`);
        }
        assert.match(load, /esc\(m\.message\)/, 'and escapes what it shows');
        assert.match(chat, /onclick="ctxViewLogs\('\$\{esc\(username\)\}', '\$\{data\.user\.id\}'\);closeModal\(\)"/, 'from the user card');

        const mine = await call('GET', '/api/chat/user/7/history?limit=50', 7);
        assert.strictEqual(mine.status, 200, 'a user reads their own');
        assert.strictEqual((await call('GET', '/api/chat/user/4/history', 7)).status, 403, 'not someone else\'s');
        const modView = await call('GET', '/api/chat/user/7/history?limit=200', 6);
        assert.strictEqual(modView.status, 200);
        assert.strictEqual(modView.json.total, 54, 'the viewer\'s lines on every channel, less the 10 purged');
        assert.strictEqual((await call('GET', '/api/chat/anon/anon42/logs', 6)).json.messages[0].message, 'anon says hi');
        assert.strictEqual((await call('GET', '/api/chat/anon/anon42/logs', 3)).status, 403, 'a streamer is not staff');
        const search = await call('GET', '/api/chat/search?q=bob&user_id=4', 7);
        assert.ok(search.json.messages.every((m) => m.user_id === 7), 'a non-staff search is limited to their own lines');
        const staffSearch = await call('GET', '/api/chat/search?q=bob&user_id=4', 6);
        assert.deepStrictEqual(staffSearch.json.messages.map((m) => m.message), ['bob replies']);
    });

    server.close();
    if (failures) { quiet(`\n${failures} check(s) failed`); process.exit(1); }
    quiet('\nAll chat-log view checks passed');
    process.exit(0);
})().catch((e) => { quiet(e); process.exit(1); });
