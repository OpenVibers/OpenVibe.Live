'use strict';
/**
 * Agent streams S6, Live's part (design 2026-11-06): the chat plays mode.
 *
 *   - the mode chatplays is refused unless a sandbox worker is registered and healthy: a request runs in a
 *     network-isolated worker, not in the owner's own Codes worker, Node or desk (409, and the owner page
 *     says the worker is still coming);
 *   - only OpenVibe's sandbox worker may register one: a Network service token holding
 *     live.agent_sandbox.register, naming the person it works for. The owner's session, a desk ticket and a
 *     token without the capability are refused (403);
 *   - a worker that does not report the isolation Live requires (no host network, no credentials, no
 *     profile, egress through the proxy) is not registered at all;
 *   - health comes only from the worker's own check-ins: a check-in within the last minute. A worker that
 *     falls silent is not there, and the mode is refused again;
 *   - the time box, the cap and the queue's top three are the owner's own, and a play request is never
 *     dispatched from here.
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
const ISOLATION = { host_network: false, credentials: false, profile: false, egress_proxy: true, workspace: 'ephemeral' };
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

    // The Network is not here: a service token is verified by this stand-in. The worker's token holds the
    // sandbox capability; the other one does not.
    const sdkAuth = require('openvibe-sdk/auth');
    sdkAuth.verifyServiceToken = async (token) => {
        if (token === 'tok-worker') return { ok: true, claims: { sub: 'svc:sandbox', cap: ['live.agent_sandbox.register'] } };
        if (token === 'tok-other') return { ok: true, claims: { sub: 'svc:other', cap: ['live.agent_stream.publish'] } };
        if (token === 'tok-person') return { ok: true, claims: { sub: SID.ann, cap: ['live.agent_sandbox.register'] } };
        return { ok: false, code: 'token.invalid' };
    };

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
    const call = async (method, url, { as = 0, body, token, subject } = {}) => {
        const headers = { 'Content-Type': 'application/json', 'x-test-user': String(as) };
        if (token) headers.authorization = `Bearer ${token}`;
        if (subject) headers['x-ov-subject'] = subject;
        const res = await fetch(`${base}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        let data = {}; try { data = text ? JSON.parse(text) : {}; } catch { data = { text }; }
        return { status: res.status, data };
    };
    // The owner's own session asks: the mode is the owner's to choose.
    const voice = (body) => call('PUT', `/api/streams/agent/${stream.public_id}/voice`, { as: 1, body });
    const checkIn = (opts = {}) => call('POST', `/api/streams/agent/${stream.public_id}/plays/worker`, {
        token: 'tok-worker', subject: SID.ann, body: { isolation: ISOLATION }, ...opts,
    });

    quiet('agent streams S6: the chat plays mode');

    await check('the mode is refused without a sandbox worker', async () => {
        const r = await voice({ mode: 'chatplays' });
        assert.strictEqual(r.status, 409, JSON.stringify(r.data));
        assert.strictEqual(r.data.code, 'chatplays_needs_sandbox_worker');
        assert.match(String(r.data.error || ''), /sandbox worker/i, 'the reason says what is missing');
    });

    await check('Go is refused without a sandbox worker too', async () => {
        const r = await call('PUT', `/api/streams/agent/${stream.public_id}/plays`, { as: 1, body: { time_box_minutes: 10, cap_cents: 500, go: true } });
        assert.strictEqual(r.status, 409, JSON.stringify(r.data));
        assert.strictEqual(r.data.code, 'chatplays_needs_sandbox_worker');
    });

    await check('the owner page is told the worker is still coming', async () => {
        const r = await call('GET', `/api/streams/agent/${stream.public_id}/plays/worker`, { as: 1 });
        assert.strictEqual(r.status, 200, JSON.stringify(r.data));
        assert.strictEqual(r.data.worker.ready, false);
        assert.match(String(r.data.worker.reason || ''), /coming soon/i);
    });

    await check("the owner's own session may not register a worker", async () => {
        const r = await call('POST', `/api/streams/agent/${stream.public_id}/plays/worker`, { as: 1, body: { isolation: ISOLATION } });
        assert.strictEqual(r.status, 403, JSON.stringify(r.data));
        assert.strictEqual(r.data.code, 'sandbox_worker.not_the_worker');
    });

    await check('a desk ticket may not register a worker', async () => {
        const r = await call('POST', `/api/streams/agent/${stream.public_id}/plays/worker`, { token: 'wpt_a_desk_ticket', subject: SID.ann, body: { isolation: ISOLATION } });
        assert.strictEqual(r.status, 403, JSON.stringify(r.data));
        assert.strictEqual(r.data.code, 'sandbox_worker.not_the_worker');
    });

    await check('a token without the capability may not register a worker', async () => {
        const r = await call('POST', `/api/streams/agent/${stream.public_id}/plays/worker`, { token: 'tok-other', subject: SID.ann, body: { isolation: ISOLATION } });
        assert.strictEqual(r.status, 403, JSON.stringify(r.data));
        assert.strictEqual(r.data.code, 'capability.denied');
    });

    await check('a person token may not register a worker', async () => {
        const r = await call('POST', `/api/streams/agent/${stream.public_id}/plays/worker`, { token: 'tok-person', subject: SID.ann, body: { isolation: ISOLATION } });
        assert.strictEqual(r.status, 403, JSON.stringify(r.data));
        assert.strictEqual(r.data.code, 'sandbox_worker.not_the_worker');
    });

    await check('a worker that does not say it is isolated is not registered', async () => {
        const r = await checkIn({ body: { isolation: { host_network: true, credentials: false, profile: false, egress_proxy: false, workspace: 'shared' } } });
        assert.strictEqual(r.status, 422, JSON.stringify(r.data));
        assert.strictEqual(r.data.code, 'sandbox_worker_not_isolated');
        const state = await call('GET', `/api/streams/agent/${stream.public_id}/plays/worker`, { as: 1 });
        assert.strictEqual(state.data.worker.ready, false, 'it is not registered at all');
    });

    await check('the worker registers and the mode becomes available', async () => {
        const in1 = await checkIn();
        assert.strictEqual(in1.status, 200, JSON.stringify(in1.data));
        assert.strictEqual(in1.data.worker.ready, true);
        const cap = await call('PUT', `/api/streams/agent/${stream.public_id}/plays`, { as: 1, body: { time_box_minutes: 10, cap_cents: 500 } });
        assert.strictEqual(cap.status, 200, JSON.stringify(cap.data));
        const mode = await voice({ mode: 'chatplays' });
        assert.strictEqual(mode.status, 200, JSON.stringify(mode.data));
        assert.strictEqual(mode.data.voice.mode, 'chatplays');
    });

    await check('a worker that fell silent is not there', async () => {
        await raw.prepare('UPDATE agent_sandbox_workers SET last_seen_at = ? WHERE subject = ?').run(Date.now() - 61 * 1000, SID.ann);
        const r = await voice({ mode: 'chatplays' });
        assert.strictEqual(r.status, 409, JSON.stringify(r.data));
        assert.strictEqual(r.data.code, 'chatplays_needs_sandbox_worker');
        // And it comes back when the worker checks in again.
        const in1 = await checkIn();
        assert.strictEqual(in1.status, 200, JSON.stringify(in1.data));
        assert.strictEqual(in1.data.worker.ready, true);
    });

    await check('the controls are the owner\'s own: the time box, the cap and Go', async () => {
        const plays = require('../server/agent-streams/plays');
        assert.strictEqual(plays.cleanTimeBox(1), 5);
        assert.strictEqual(plays.cleanTimeBox(90), 30);
        assert.strictEqual(plays.cleanCap(500), 500);
        assert.strictEqual(plays.cleanCap(-5), null);
        // The owner's session still may not arm the desk by itself: Go waits for the worker like the mode does.
        const go = await call('PUT', `/api/streams/agent/${stream.public_id}/plays`, { as: 1, body: { go: true } });
        assert.strictEqual(go.status, 200, JSON.stringify(go.data));
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
