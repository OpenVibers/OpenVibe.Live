'use strict';
/**
 * Agent streams S6, Live's part (design 2026-11-06): the chat plays mode.
 *
 *   - the mode chatplays is refused unless a sandbox worker is registered and healthy: a request runs in a
 *     network-isolated worker, not in the owner's own Codes worker, Node or desk (409, and the owner page
 *     says the worker is still coming);
 *   - Go (the arm) is refused the same way;
 *   - the time box, the cap and the queue's top three are the owner's own (the controls on the owner page);
 *   - a play request is never dispatched from here: Live stores what the desk reports and nothing more.
 */
const assert = require('assert');
const http = require('http');
const express = require('express');

process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};
console.error = (...a) => process.stderr.write(a.join(' ') + '\n');

const SID = { ann: 'usr_01JAB2C3D4E5F6G7H8J9K0MNA1' };
let failures = 0;
async function check(name, fn) {
    try { await fn(); quiet('  ✓', name); }
    catch (e) { failures++; quiet('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')); }
}

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    const raw = db.getDb();
    await raw.prepare(
        `INSERT INTO users (id, username, display_name, email, password_hash, role, is_owner) OVERRIDING SYSTEM VALUE
         VALUES (1, 'ann', 'ann', 'ann@x', 'x', 'streamer', 0) ON CONFLICT (id) DO NOTHING`).run();
    await raw.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (1, 'network', '101', ?) ON CONFLICT DO NOTHING").run(SID.ann);

    const config = require('../server/config');
    config.baseUrl = 'https://openvibe.live';
    const service = require('../server/agent-streams/service');
    const sandbox = require('../server/agent-streams/sandbox');
    const chat = require('../server/chat/chat-client');
    chat.available = () => true;
    const chatCalls = [];
    chat.agentRoom = async (body) => { chatCalls.push(body); return { room: 'agent:' + body.agent_stream_id }; };
    const moderation = require('../server/chat/moderation-client');
    moderation.getChannelModeration = async () => ({ settings: {}, moderator_ids: [] });

    const ann = await db.getUserById(1);
    const stream = await service.create({
        user: ann,
        title: 'Chat plays',
        task: { source: 'codes', ref: 'tsk_1', title: 'Work the queue', url: 'https://openvibe.codes/tasks/1' },
        visibility: 'public', copilotReady: true,
    });

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = { 1: ann }[req.get('x-test-user')] || null; next(); });
    app.use('/api/streams/agent', require('../server/agent-streams/routes'));
    const server = await new Promise((ok) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => ok(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, { as = 1, body } = {}) => {
        const res = await fetch(`${base}${url}`, {
            method, headers: { 'Content-Type': 'application/json', 'x-test-user': String(as) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        let data = {}; try { data = text ? JSON.parse(text) : {}; } catch { data = { text }; }
        return { status: res.status, data };
    };
    const voice = (body) => call('PUT', `/api/streams/agent/${stream.public_id}/voice`, { body });

    quiet('agent streams S6: the chat plays mode');

    await check('the mode is refused without a sandbox worker', async () => {
        const r = await voice({ mode: 'chatplays' });
        assert.strictEqual(r.status, 409, JSON.stringify(r.data));
        assert.strictEqual(r.data.code, 'chatplays_needs_sandbox_worker');
        assert.match(String(r.data.error || ''), /sandbox worker/i, 'the reason says what is missing');
    });

    await check('Go is refused without a sandbox worker too', async () => {
        const r = await call('PUT', `/api/streams/agent/${stream.public_id}/plays`, { body: { time_box_minutes: 10, cap_cents: 500, go: true } });
        assert.strictEqual(r.status, 409, JSON.stringify(r.data));
        assert.strictEqual(r.data.code, 'chatplays_needs_sandbox_worker');
    });

    await check('the owner page is told the worker is still coming', async () => {
        const r = await call('GET', `/api/streams/agent/${stream.public_id}/plays/worker`);
        assert.strictEqual(r.status, 200, JSON.stringify(r.data));
        assert.strictEqual(r.data.worker.ready, false);
        assert.match(String(r.data.worker.reason || ''), /coming soon/i);
    });

    await check('a worker that checks in makes the mode possible', async () => {
        const in1 = await call('POST', `/api/streams/agent/${stream.public_id}/plays/worker`, { body: { service: 'codes' } });
        assert.strictEqual(in1.status, 200, JSON.stringify(in1.data));
        assert.strictEqual(in1.data.worker.ready, true);
        // The budget first, then the mode.
        const cap = await call('PUT', `/api/streams/agent/${stream.public_id}/plays`, { body: { time_box_minutes: 10, cap_cents: 500 } });
        assert.strictEqual(cap.status, 200, JSON.stringify(cap.data));
        const mode = await voice({ mode: 'chatplays' });
        assert.strictEqual(mode.status, 200, JSON.stringify(mode.data));
        assert.strictEqual(mode.data.voice.mode, 'chatplays');
    });

    await check('a worker that stopped checking in is not there', async () => {
        await raw.prepare('UPDATE agent_sandbox_workers SET last_seen_at = ? WHERE subject = ?').run(Date.now() - 10 * 60 * 1000, SID.ann);
        const r = await voice({ mode: 'chatplays' });
        assert.strictEqual(r.status, 409, JSON.stringify(r.data));
        assert.strictEqual(r.data.code, 'chatplays_needs_sandbox_worker');
    });

    await check('the controls are the owner\'s own: the time box, the cap and Go', async () => {
        const r = await call('GET', `/api/streams/agent/${stream.public_id}/plays/worker`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.data.worker.ready, false, 'the stale worker is not healthy');
        const plays = require('../server/agent-streams/plays');
        assert.strictEqual(plays.cleanTimeBox(1), 5);
        assert.strictEqual(plays.cleanTimeBox(90), 30);
        assert.strictEqual(plays.cleanCap(500), 500);
        assert.strictEqual(plays.cleanCap(-5), null);
    });

    await check('the overlay gets the queue\'s top three and the current request', async () => {
        const plays = require('../server/agent-streams/plays');
        const row = { plays_queue: { requests: [
            { request_id: 'req_1', text: 'build a snake game', votes: 12, author: { handle: 'mira' } },
            { request_id: 'req_2', text: 'draw a house', votes: 7, author: { handle: 'bob' } },
            { request_id: 'req_3', text: 'make a quiz', votes: 3, author: { handle: 'ann' } },
            { request_id: 'req_4', text: 'make a meme', votes: 1, author: { handle: 'jo' } },
        ], current: { request_id: 'req_1', text: 'build a snake game', author: { handle: 'mira' } } } };
        const top = plays.queueTop(row, 3);
        assert.strictEqual(top.top.length, 3);
        assert.strictEqual(top.top[0].request_id, 'req_1');
        assert.strictEqual(top.top[0].votes, 12);
        assert.strictEqual(top.current.author, 'mira', 'the current request says who asked for it');
    });

    await check('the overlay reads the queue: the current request and the next three', async () => {
        await raw.prepare(
            `INSERT INTO agent_sandbox_workers (id, subject, service, status, last_seen_at, created_at)
             VALUES ('sbw_test', ?, 'codes', 'ready', ?, ?)
             ON CONFLICT (subject) DO UPDATE SET last_seen_at = excluded.last_seen_at`).run(SID.ann, Date.now(), Date.now());
        await raw.prepare('UPDATE agent_streams SET plays_queue = ? WHERE managed_stream_id = ?').run(
            JSON.stringify({
                requests: [
                    { request_id: 'req_1', text: 'build a snake game', votes: 12, author: { handle: 'mira' } },
                    { request_id: 'req_2', text: 'draw a house', votes: 7, author: { handle: 'bob' } },
                    { request_id: 'req_3', text: 'make a quiz', votes: 3, author: { handle: 'ann' } },
                    { request_id: 'req_4', text: 'make a meme', votes: 1, author: { handle: 'jo' } },
                ],
                current: { request_id: 'req_1', text: 'build a snake game', author: { handle: 'mira' } },
            }), stream.managed_stream_id);
        const r = await call('GET', `/api/streams/agent/${stream.public_id}/plays/queue`);
        assert.strictEqual(r.status, 200, JSON.stringify(r.data));
        assert.strictEqual(r.data.queue.top.length, 3, 'the overlay shows the queue\'s top three');
        assert.strictEqual(r.data.queue.top[0].request_id, 'req_1');
        assert.strictEqual(r.data.queue.top[0].votes, 12);
        assert.strictEqual(r.data.queue.current.author, 'mira', 'the current request says who asked for it');
    });

    await check('a play request is never dispatched from here', async () => {
        const before = chatCalls.length;
        const r = await call('POST', `/api/streams/agent/${stream.public_id}/plays/queue`, { body: { requests: [], current: null } });
        assert.ok(r.status === 200 || r.status === 401 || r.status === 403, 'the desk may report the queue: ' + r.status);
        assert.strictEqual(chatCalls.length, before, 'Live asks nobody to run anything');
    });

    server.close();
    quiet(failures ? `agent streams S6: ${failures} failed` : 'agent streams S6: the chat plays mode waits for the sandbox worker');
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
