'use strict';
/**
 * Agent streams S7, Live's part (design 2026-11-06): schedules, the desk heartbeat, the miss and the Go; the party
 * count on a stream; and the robot camera as a second scene.
 *
 *   - a schedule shows on the channel's Agents tab 24 hours before its time and nowhere earlier;
 *   - reminders are opt-in, and the answer is a count, never a name;
 *   - a due schedule nobody claimed says "didn't start: the desk was offline" and starts nothing;
 *   - an online desk claims it and gets the one publish ticket; a chatplays schedule waits for the owner's Go;
 *   - the stream page carries the party count (a number) and, on a channel bound to a robot, the robot scene.
 *
 * Sign-in is stubbed with an x-test-user header, as agent-streams-s2.test.js does; everything after that is production.
 */
const assert = require('assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('http');
const express = require('express');

process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};
console.error = () => {};

const SID = {
    ann: 'usr_01JAB2C3D4E5F6G7H8J9K0MNA1',
    bob: 'usr_01JAB2C3D4E5F6G7H8J9K0MNB2',
};

let failures = 0;
async function check(name, fn) {
    try { await fn(); quiet('  ✓', name); }
    catch (e) { failures++; quiet('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')); }
}

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    const raw = db.getDb();
    const addUser = async (id, username, role) => await raw.prepare(
        `INSERT INTO users (id, username, display_name, email, password_hash, role, is_owner) OVERRIDING SYSTEM VALUE
         VALUES (?, ?, ?, ?, 'x', ?, 0)`).run(id, username, username, `${username}@x`, role);
    await addUser(1, 'ann', 'streamer');
    await addUser(2, 'bob', 'user');
    await raw.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (1, 'network', '101', ?)").run(SID.ann);
    await raw.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (2, 'network', '102', ?)").run(SID.bob);

    const config = require('../server/config');
    config.baseUrl = 'https://openvibe.live';
    const service = require('../server/agent-streams/service');
    const schedules = require('../server/agent-streams/schedules');
    require('../server/agent-streams/sharing')._setNetwork({ json: async () => ({}) });
    const ann = await db.getUserById(1);
    const bob = await db.getUserById(2);
    const channel = await db.ensureChannel(1);

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = { 1: ann, 2: bob }[req.get('x-test-user')] || null; next(); });
    app.use('/api/streams/agent', require('../server/agent-streams/routes'));
    const server = await new Promise((ok) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => ok(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, { as = 1, body, headers = {} } = {}) => {
        const res = await fetch(`${base}${url}`, {
            method,
            headers: { 'Content-Type': 'application/json', 'x-test-user': String(as), ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch { data = { text }; }
        return { status: res.status, data, headers: res.headers };
    };
    const makeSchedule = async ({ title = 'Fix the login page', at = Date.now() + 2 * 60 * 60 * 1000, mode = 'watch' } = {}) => {
        const r = await call('POST', '/api/streams/agent/schedules', {
            body: {
                title,
                task: { source: 'codes', ref: 'tsk_1', title: 'Fix the login page', url: 'https://openvibe.codes/tasks/1' },
                mode,
                starts_at: new Date(at).toISOString(),
            },
        });
        assert.strictEqual(r.status, 201, JSON.stringify(r.data));
        return r.data.schedule;
    };
    const due = async (id) => await db.run("UPDATE agent_stream_schedules SET starts_at = now() - interval '2 minutes' WHERE id = ?", [id]);

    quiet('agent streams S7: schedules');
    const soon = await makeSchedule({ title: 'Soon', at: Date.now() + 23 * 60 * 60 * 1000 });
    const later = await makeSchedule({ title: 'Later', at: Date.now() + 25 * 60 * 60 * 1000 });
    await check('a schedule answers the contract shape', async () => {
        assert.match(soon.id, /^scd_[0-9A-HJKMNP-TV-Z]{26}$/);
        assert.strictEqual(soon.owner, SID.ann);
        assert.strictEqual(soon.channel, 'ann');
        assert.strictEqual(soon.visibility, 'public');
        assert.strictEqual(soon.state, 'scheduled');
        assert.strictEqual(soon.reminders, 0);
        assert.ok(soon.page_url.endsWith('/@ann/agents'));
    });
    await check('Today sees it 24 hours ahead, not a day early', async () => {
        const r = await call('GET', '/api/streams/agent/schedules?channel=ann', { as: 2 });
        assert.strictEqual(r.status, 200, JSON.stringify(r.data));
        const ids = r.data.schedules.map((s) => s.id);
        assert.ok(ids.includes(soon.id), '23 hours ahead is shown');
        assert.ok(!ids.includes(later.id), '25 hours ahead is not');
        const mine = await call('GET', '/api/streams/agent/schedules?mine=1', { as: 1 });
        assert.ok(mine.data.schedules.some((s) => s.id === later.id), 'the owner sees their whole list');
    });
    await check('reminders are opt-in only, and the answer is a count', async () => {
        const before = await call('GET', `/api/streams/agent/schedules/${soon.id}`, { as: 2 });
        assert.strictEqual(before.data.schedule.reminded, false);
        const r = await call('POST', `/api/streams/agent/schedules/${soon.id}/remind`, { as: 2 });
        assert.strictEqual(r.status, 200, JSON.stringify(r.data));
        assert.strictEqual(r.data.reminders, 1);
        assert.strictEqual(r.data.reminded, true);
        const asAnn = await call('GET', `/api/streams/agent/schedules/${soon.id}`, { as: 1 });
        assert.strictEqual(asAnn.data.schedule.reminded, false, 'ann did not opt in');
        assert.strictEqual(asAnn.data.schedule.reminders, 1, 'the count is there');
        const all = JSON.stringify(asAnn.data);
        assert.ok(!all.includes('bob'), 'no name in a schedule view');
        const signedOut = await call('POST', `/api/streams/agent/schedules/${soon.id}/remind`, { as: 0 });
        assert.strictEqual(signedOut.status, 401);
    });
    await check('a due schedule with the desk offline says so and starts nothing', async () => {
        const missed = await makeSchedule({ title: 'Offline desk' });
        await due(missed.id);
        const streamsBefore = (await service.listByUser(1)).length;
        const out = await schedules.startDue();
        assert.ok(out.missed >= 1, JSON.stringify(out));
        const after = await call('GET', `/api/streams/agent/schedules/${missed.id}`, { as: 1 });
        assert.strictEqual(after.data.schedule.state, 'missed');
        assert.strictEqual(after.data.schedule.missed_reason, 'desk_offline');
        assert.strictEqual(after.data.schedule.agent_stream_id, null);
        assert.strictEqual((await service.listByUser(1)).length, streamsBefore, 'nothing ran');
    });
    await check('an online desk claims it and gets one publish ticket; ending the stream ends the schedule', async () => {
        const ready = await makeSchedule({ title: 'Online desk' });
        await schedules.heartbeat(ann, 'node/0.41.0');
        await due(ready.id);
        const r = await call('POST', `/api/streams/agent/schedules/${ready.id}/claim`, { as: 1 });
        assert.strictEqual(r.status, 201, JSON.stringify(r.data));
        assert.match(r.data.publish.ticket, /^wpt_/);
        assert.match(r.data.publish.whip_url, /\/whip\/agent\/ags_/);
        assert.strictEqual(r.data.schedule.state, 'live');
        assert.strictEqual(r.data.stream.id, r.data.schedule.agent_stream_id);
        await service.markPublishing(await service.getByPublicId(r.data.stream.id));
        const ended = await call('POST', `/api/streams/agent/${r.data.stream.id}/end`, { as: 1 });
        assert.strictEqual(ended.status, 200, JSON.stringify(ended.data));
        const after = await call('GET', `/api/streams/agent/schedules/${ready.id}`, { as: 1 });
        assert.strictEqual(after.data.schedule.state, 'ended');
        assert.ok(after.data.schedule.ended_at);
    });
    await check('a chat plays schedule waits for the owner\'s Go and starts nothing before it', async () => {
        const plays = await makeSchedule({ title: 'Chat plays a tiny game', mode: 'chatplays' });
        await schedules.heartbeat(ann);
        await due(plays.id);
        const before = (await service.listByUser(1)).length;
        const refused = await call('POST', `/api/streams/agent/schedules/${plays.id}/claim`, { as: 1 });
        assert.strictEqual(refused.status, 409, JSON.stringify(refused.data));
        assert.strictEqual(refused.data.code, 'waits_for_go');
        const waiting = await call('GET', `/api/streams/agent/schedules/${plays.id}`, { as: 1 });
        assert.strictEqual(waiting.data.schedule.waits_for_go, true);
        assert.strictEqual(waiting.data.schedule.missed_reason, 'waits_for_go');
        assert.strictEqual(waiting.data.schedule.state, 'scheduled');
        assert.strictEqual((await service.listByUser(1)).length, before, 'nothing ran without Go');
        const go = await call('POST', `/api/streams/agent/schedules/${plays.id}/go`, { as: 1 });
        assert.strictEqual(go.status, 201, JSON.stringify(go.data));
        assert.strictEqual(go.data.schedule.state, 'live');
    });
    await check('only the owner may cancel; a cancelled schedule leaves the window', async () => {
        const own = await makeSchedule({ title: 'Cancel me' });
        const other = await call('DELETE', `/api/streams/agent/schedules/${own.id}`, { as: 2 });
        assert.strictEqual(other.status, 403);
        const ok = await call('DELETE', `/api/streams/agent/schedules/${own.id}`, { as: 1 });
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.data));
        assert.strictEqual(ok.data.schedule.state, 'cancelled');
    });

    quiet('agent streams S7: parties and the robot scene');
    const partyStream = await service.create({
        user: ann, title: 'A party stream', task: { source: 'codes', ref: 'tsk_party', title: 'A party' }, visibility: 'public',
    });
    await check('the stream carries the party count and never a name', async () => {
        const chat = require('../server/chat/chat-client');
        const original = chat.partyCount;
        chat.partyCount = async () => ({ ok: true, count: 3 });
        try {
            const r = await call('GET', `/api/streams/agent/${partyStream.public_id}`, { as: 2 });
            assert.strictEqual(r.status, 200, JSON.stringify(r.data));
            assert.deepStrictEqual(r.data.parties, { count: 3 });
            const text = JSON.stringify(r.data);
            assert.ok(!/host|people|names|members/i.test(text), 'no party member list');
        } finally { chat.partyCount = original; }
        process.env.OV_CHAT_INTERNAL_URL = '';
        const noChat = await call('GET', `/api/streams/agent/${partyStream.public_id}`, { as: 2 });
        assert.strictEqual(noChat.data.parties, null, 'Chat down: no count, the stream still answers');
        process.env.OV_CHAT_INTERNAL_URL = 'http://127.0.0.1:4400';
    });
    await check('a channel bound to a robot shows the robot camera as a second scene', async () => {
        process.env.LIVE_BOT_EMBED = '1';
        try {
            await raw.prepare('UPDATE channels SET bot_robot_id = ? WHERE id = ?').run('rob_sim123', channel.id);
            const r = await call('GET', `/api/streams/agent/${partyStream.public_id}`, { as: 2 });
            assert.strictEqual(r.status, 200, JSON.stringify(r.data));
            assert.ok(r.data.stream.robot_scene, 'the robot scene is offered');
            assert.strictEqual(r.data.stream.robot_scene.robot_id, 'rob_sim123');
            assert.match(r.data.stream.robot_scene.embed_url, /\/panel\/rob_sim123\/embed$/);
            const fragment = fs.readFileSync(path.join(__dirname, '../public/fragments/agent-stream.html'), 'utf8');
            assert.match(fragment, /id="agent-scenes"/);
            assert.match(fragment, /id="agent-robot"/);
            const js = fs.readFileSync(path.join(__dirname, '../public/js/agent-stream.js'), 'utf8');
            assert.match(js, /function renderScenes/);
            assert.match(js, /robot_scene/);
            const css = fs.readFileSync(path.join(__dirname, '../public/css/features/agent-stream.css'), 'utf8');
            assert.match(css, /\.agent-robot/);
        } finally {
            await raw.prepare('UPDATE channels SET bot_robot_id = NULL WHERE id = ?').run(channel.id);
            delete process.env.LIVE_BOT_EMBED;
        }
    });
    await check('the kill switch reaches the robot through Bot', async () => {
        process.env.BOT_KILL_URL = 'https://bot.test';
        process.env.BOT_KILL_SECRET = 'kill-secret';
        try {
            await raw.prepare('UPDATE channels SET bot_robot_id = ? WHERE id = ?').run('rob_sim123', channel.id);
            const calls = [];
            const out = await require('../server/bot/kill').stop(
                { channel_id: channel.id, public_id: partyStream.public_id },
                { fetchImpl: async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; } }
            );
            assert.deepStrictEqual(out, { stopped: true, robot_id: 'rob_sim123' });
            assert.strictEqual(calls.length, 1);
            assert.strictEqual(calls[0].url, 'https://bot.test/internal/robots/rob_sim123/estop');
            assert.strictEqual(calls[0].opts.headers['X-OV-Bot-Kill'], 'kill-secret');
            assert.strictEqual(JSON.parse(calls[0].opts.body).reason, 'agent_stream_ended');
        } finally {
            await raw.prepare('UPDATE channels SET bot_robot_id = NULL WHERE id = ?').run(channel.id);
            delete process.env.BOT_KILL_URL;
            delete process.env.BOT_KILL_SECRET;
        }
    });

    await check('the channel Agents tab draws the schedules above the cards', async () => {
        const fragment = fs.readFileSync(path.join(__dirname, '../public/fragments/channel.html'), 'utf8');
        assert.match(fragment, /id="ch-agents-schedules"/);
        const cards = fs.readFileSync(path.join(__dirname, '../public/js/agent-cards.js'), 'utf8');
        assert.match(cards, /scheduleCard/);
        assert.match(cards, /Didn't start: the desk was offline/);
        const channelJs = fs.readFileSync(path.join(__dirname, '../public/js/app-channel.js'), 'utf8');
        assert.match(channelJs, /fillSchedules/);
    });
    await check('a Rundown topic cites a public agent report by its whole name only', async () => {
        const { createCitations, speaksOf } = require('../server/rundown/citations');
        assert.ok(speaksOf({ task: { title: 'Fix the login page' }, summary: 'Done.' }, 'Login page'));
        assert.ok(!speaksOf({ task: { title: 'Fix the login page' } }, 'login pag'), 'a partial name is not the topic');
        assert.ok(!speaksOf({ task: { title: 'Fix the login page' } }, 'ogin'), 'a name inside a word is not the topic');
        const asked = [];
        const fetchImpl = async (url) => {
            asked.push(url);
            return { ok: true, json: async () => ({ reports: [
                { id: 'rps_01JAB2C3D4E5F6G7H8J9K0MNPS', task: { title: 'Fix the login page' }, summary: 'Done.', outcome: 'done' },
                { id: 'rps_01JAB2C3D4E5F6G7H8J9K0MNPT', task: { title: 'Fix the checkout page' }, summary: 'Done.', outcome: 'done' },
            ] }) };
        };
        const cites = createCitations({ fetchImpl, url: 'https://report.test', log: { warn() {} } });
        const first = await cites.forTopic('Login page');
        assert.deepStrictEqual(first.map((c) => c.id), ['rps_01JAB2C3D4E5F6G7H8J9K0MNPS']);
        assert.strictEqual(first[0].title, 'Fix the login page');
        await cites.forTopic('Login page');
        assert.strictEqual(asked.length, 1, 'the topic is cached');
        assert.deepStrictEqual(await cites.forTopic('Login page'), first);
        const down = createCitations({ fetchImpl: async () => { throw new Error('down'); }, url: 'https://report.test', log: { warn() {} } });
        down.clear();
        assert.deepStrictEqual(await down.forTopic('Login page'), [], 'Report down: no citations, no broken page');
        const javascript = fs.readFileSync(path.join(__dirname, '../public/js/rundown.js'), 'utf8');
        assert.match(javascript, /Agents that worked on this/);
        assert.match(javascript, /openvibe\.report\/s\//);
    });

    await check('the schedule card survives 390 px', async () => {
        const css = fs.readFileSync(path.join(__dirname, '../public/css/features/agent-stream.css'), 'utf8');
        assert.match(css, /@media \(max-width: 640px\)[\s\S]*agent-scene/);
        assert.match(css, /\.agent-schedules \{ display: grid/);
    });

    server.close();
    await db.closeDb?.();
    quiet(failures ? `\n${failures} check(s) failed` : '\nAll agent stream S7 checks passed');
    process.exit(failures ? 1 : 0);
})().catch((e) => { quiet(e.stack || String(e)); process.exit(1); });
