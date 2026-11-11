'use strict';
/**
 * Agent streams S5, Live's part (design 2026-11-06): Co-pilot.
 *
 *   - the mode copilot needs a public or unlisted stream and a task's service that says it can read a digest;
 *   - the four controls (pause, curtain, mute, end) work for the owner and the channel's moderators;
 *   - a moderator cannot resume a pause the owner set, and every press is logged;
 *   - the state carries the pause the task's service reads (and the pause ends when the owner resumes);
 *   - a public or unlisted stream gets its Chat room, and the end closes the reading.
 */
const assert = require('assert');
const http = require('http');
const express = require('express');

process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};
console.error = (...a) => process.stderr.write(a.join(' ') + '\n');

const SID = { ann: 'usr_01JAB2C3D4E5F6G7H8J9K0MNA1', bob: 'usr_01JAB2C3D4E5F6G7H8J9K0MNB2' };
let failures = 0;
async function check(name, fn) {
    try { await fn(); quiet('  ✓', name); }
    catch (e) { failures++; quiet('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')); }
}

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    const raw = db.getDb();
    const addUser = async (id, username, role, extra = {}) => await raw.prepare(
        `INSERT INTO users (id, username, display_name, email, password_hash, role, is_owner) OVERRIDING SYSTEM VALUE
         VALUES (?, ?, ?, ?, 'x', ?, ?) ON CONFLICT (id) DO NOTHING`).run(id, username, username, `${username}@x`, role, extra.is_owner ? 1 : 0);
    await addUser(1, 'ann', 'streamer');
    await addUser(2, 'bob', 'user');
    await raw.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (1, 'network', '101', ?) ON CONFLICT DO NOTHING").run(SID.ann);
    await raw.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (2, 'network', '102', ?) ON CONFLICT DO NOTHING").run(SID.bob);

    const config = require('../server/config');
    config.baseUrl = 'https://openvibe.live';
    const service = require('../server/agent-streams/service');
    require('../server/agent-streams/sharing')._setNetwork({ json: async () => ({}) });
    const ann = await db.getUserById(1);
    const bob = await db.getUserById(2);

    // Chat is another service: record what Live asks it, and make bob a moderator of ann's channel.
    const roomCalls = [];
    const chat = require('../server/chat/chat-client');
    chat.available = () => true;
    chat.agentRoom = async (body) => { roomCalls.push(body); return { room: 'agent:' + body.agent_stream_id }; };
    const moderation = require('../server/chat/moderation-client');
    moderation.getChannelModeration = async () => ({ settings: {}, moderator_ids: [2] });

    const make = (visibility, { ready = true } = {}) => service.create({
        user: ann,
        title: 'Fixing the checkout tests ' + visibility,
        task: { source: 'codes', ref: 'tsk_1', title: 'Run the checkout tests', url: 'https://openvibe.codes/tasks/1' },
        visibility, copilotReady: ready,
    });
    const publicStream = await make('public');
    const privateStream = await make('private');
    const deskStream = await make('unlisted', { ready: false });

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = { 1: ann, 2: bob }[req.get('x-test-user')] || null; next(); });
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
    const control = (stream, body, as = 1) => call('POST', `/api/streams/agent/${stream.public_id}/control`, { as, body });

    quiet('agent streams S5: Co-pilot');

    await check('a public or unlisted stream with a ready service can be Co-pilot; a private one cannot', async () => {
        let r = await call('PUT', `/api/streams/agent/${publicStream.public_id}/voice`, { body: { mode: 'copilot' } });
        assert.strictEqual(r.status, 200, JSON.stringify(r.data));
        assert.strictEqual(r.data.voice.mode, 'copilot');
        r = await call('PUT', `/api/streams/agent/${privateStream.public_id}/voice`, { body: { mode: 'copilot' } });
        assert.strictEqual(r.status, 422, JSON.stringify(r.data));
        assert.strictEqual(r.data.code, 'copilot_needs_public');
        r = await call('PUT', `/api/streams/agent/${deskStream.public_id}/voice`, { body: { mode: 'copilot' } });
        assert.strictEqual(r.status, 422, JSON.stringify(r.data));
        assert.strictEqual(r.data.code, 'copilot_not_ready');
        r = await call('PUT', `/api/streams/agent/${deskStream.public_id}/voice`, { body: { mode: 'narrated' } });
        assert.strictEqual(r.status, 200, 'Narrated still works without a digest');
        r = await call('POST', `/api/streams/agent/${deskStream.public_id}/copilot`, { body: { ready: true } });
        assert.strictEqual(r.status, 200, JSON.stringify(r.data));
        r = await call('PUT', `/api/streams/agent/${deskStream.public_id}/voice`, { body: { mode: 'copilot' } });
        assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    });

    await check('Chat receives public and unlisted rooms plus a private visibility marker', async () => {
        assert.ok(roomCalls.some((c) => c.agent_stream_id === publicStream.public_id));
        assert.ok(roomCalls.some((c) => c.agent_stream_id === deskStream.public_id));
        assert.ok(roomCalls.some((c) => c.agent_stream_id === privateStream.public_id && c.visibility === 'private'), 'Chat hides an old room when its stream becomes private');
        assert.strictEqual(roomCalls.find((c) => c.agent_stream_id === publicStream.public_id).owner_subject, SID.ann);
    });

    await check('the owner pauses and resumes, and the state carries it', async () => {
        let r = await control(publicStream, { control: 'pause', paused: true });
        assert.strictEqual(r.status, 200, JSON.stringify(r.data));
        assert.strictEqual(r.data.paused, true);
        assert.strictEqual(r.data.paused_by, 'ann');
        r = await call('GET', `/api/streams/agent/${publicStream.public_id}/state`);
        assert.strictEqual(r.status, 200, JSON.stringify(r.data));
        assert.strictEqual(r.data.paused, true);
        assert.strictEqual(r.data.paused_by, 'ann');
        r = await control(publicStream, { control: 'pause', paused: false });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.data.paused, false);
    });

    await check("a moderator cannot resume the owner's pause, but can pause and resume their own", async () => {
        await control(publicStream, { control: 'pause', paused: true }, 1);
        let r = await control(publicStream, { control: 'pause', paused: false }, 2);
        assert.strictEqual(r.status, 403, JSON.stringify(r.data));
        assert.strictEqual(r.data.code, 'owner_pause');
        await control(publicStream, { control: 'pause', paused: false }, 1);
        r = await control(publicStream, { control: 'pause', paused: true }, 2);
        assert.strictEqual(r.status, 200, JSON.stringify(r.data));
        assert.strictEqual(r.data.paused_by, 'bob');
        r = await control(publicStream, { control: 'pause', paused: false }, 2);
        assert.strictEqual(r.status, 200, 'the moderator resumes their own pause');
    });

    await check('a stranger may not press a control', async () => {
        const r = await control(publicStream, { control: 'pause', paused: true }, 0);
        assert.strictEqual(r.status, 403, JSON.stringify(r.data));
    });

    await check('curtain and mute act, and every press is in the log', async () => {
        let r = await control(publicStream, { control: 'curtain', up: true }, 2);
        assert.strictEqual(r.status, 200, JSON.stringify(r.data));
        assert.strictEqual(r.data.curtain.up, true);
        r = await control(publicStream, { control: 'mute', muted: true }, 1);
        assert.strictEqual(r.status, 200, JSON.stringify(r.data));
        assert.strictEqual(r.data.muted, true);
        r = await call('GET', `/api/streams/agent/${publicStream.public_id}/controls`);
        assert.strictEqual(r.status, 200, JSON.stringify(r.data));
        const controls = r.data.controls.map((c) => c.control);
        for (const name of ['pause', 'curtain', 'mute']) assert.ok(controls.includes(name), `${name} is logged`);
        assert.ok(r.data.controls.some((c) => c.by.handle === 'bob' && c.by.role === 'moderator'));
    });

    await check('end ends the stream and closes the Co-pilot reading', async () => {
        const r = await control(publicStream, { control: 'end' }, 2);
        assert.strictEqual(r.status, 200, JSON.stringify(r.data));
        assert.strictEqual(r.data.state, 'ended');
        assert.ok(roomCalls.some((c) => c.agent_stream_id === publicStream.public_id && c.close === true), 'the room is closed');
        const after = await control(publicStream, { control: 'pause', paused: true }, 1);
        assert.strictEqual(after.status, 200, 'an ended stream still logs the press; pause has no effect on the desk');
    });

    const left = await db.get('SELECT COUNT(*) AS n FROM agent_stream_controls');
    assert.ok(Number(left.n) >= 8, 'every press is stored');
    server.close();
    quiet(failures ? `agent streams S5: ${failures} failed` : 'agent streams S5: Co-pilot mode, the four controls and the log');
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
