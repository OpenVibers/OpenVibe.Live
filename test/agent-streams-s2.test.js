'use strict';
/**
 * Agent streams S2, Live's part (design 2026-11-06).
 *
 *   - a publish ticket posts steps; the person's session does too, and a service needs live.agent_stream.publish;
 *   - one step a second, 2,000 per stream, a 120-character title, a 500-character detail, and the house text filters;
 *   - a public stream is in the agents list and the Agents live row; a private one is not; neither is in people's
 *     streams;
 *   - the Agents tab shows the owner their private and unlisted cards, and everyone else only public ones;
 *   - chapters are the steps that started, at their offset; a failed step (and the final passed one) can be clipped;
 *   - the overlay is drawn by the pages (never burned into video), and the phone layout is one line.
 *
 * Sign-in is stubbed with an x-test-user header (as agent-streams.test.js does); everything after that is production.
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
    const addUser = async (id, username, role, extra = {}) => await raw.prepare(
        `INSERT INTO users (id, username, display_name, email, password_hash, role, is_owner) OVERRIDING SYSTEM VALUE
         VALUES (?, ?, ?, ?, 'x', ?, ?)`).run(id, username, username, `${username}@x`, role, extra.is_owner ? 1 : 0);
    await addUser(1, 'ann', 'streamer');
    await addUser(2, 'bob', 'user');
    await raw.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (1, 'network', '101', ?)").run(SID.ann);
    await raw.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (2, 'network', '102', ?)").run(SID.bob);

    const config = require('../server/config');
    config.baseUrl = 'https://openvibe.live';
    const service = require('../server/agent-streams/service');
    // The sharing system asks Network who a subject is; a private stream's own guests are not part of this test.
    require('../server/agent-streams/sharing')._setNetwork({ json: async () => ({}) });
    const tickets = require('../server/agent-streams/tickets');
    const steps = require('../server/agent-streams/steps');
    const auth = require('../server/agent-streams/auth');
    const ann = await db.getUserById(1);
    const bob = await db.getUserById(2);

    const streamOf = (visibility, title) => service.create({
        user: ann,
        title,
        task: { source: 'codes', ref: 'tsk_1', title: 'Run the checkout tests', url: 'https://openvibe.codes/tasks/1' },
        visibility,
    });
    const publicStream = await streamOf('public', 'Fixing the checkout tests');
    const privateStream = await streamOf('private', 'A private job');

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
        return { status: res.status, data };
    };
    const slack = async () => await db.run("UPDATE agent_stream_steps SET created_at = now() - interval '2 seconds'");

    quiet('agent streams S2: the steps');
    const publish = await tickets.issuePublish(publicStream.managed_stream_id);
    await service.markPublishing(publicStream);
    await check('a publish ticket posts a step and the contract answers it', async () => {
        const r = await call('POST', `/api/streams/agent/${publicStream.public_id}/steps`, {
            as: 2, headers: { Authorization: `Bearer ${publish.ticket}` },
            body: { title: 'Run the checkout tests', status: 'started' },
        });
        assert.strictEqual(r.status, 201, JSON.stringify(r.data));
        assert.strictEqual(r.data.step.title, 'Run the checkout tests');
        assert.strictEqual(r.data.step.status, 'started');
        assert.ok(r.data.step.at, 'the step carries its time');
    });
    await check('the person posts their own step, with tests and cost', async () => {
        await slack();
        const r = await call('POST', `/api/streams/agent/${publicStream.public_id}/steps`, {
            body: { title: 'Checkout tests pass', status: 'passed', tests: { passed: 12, failed: 0 }, cost_usd: 0.42, detail: 'All 12 green' },
        });
        assert.strictEqual(r.status, 201, JSON.stringify(r.data));
        assert.deepStrictEqual(r.data.step.tests, { passed: 12, failed: 0 });
        assert.strictEqual(r.data.step.cost_usd, 0.42);
    });
    await check('a service needs live.agent_stream.publish; another stream is refused', async () => {
        const anonymous = await call('POST', `/api/streams/agent/${publicStream.public_id}/steps`, {
            as: 0, headers: { Authorization: 'Bearer not-a-service-token' }, body: { title: 'x', status: 'started' },
        });
        assert.ok(anonymous.status === 401 || anonymous.status === 403, JSON.stringify(anonymous.data));
        const other = await call('POST', `/api/streams/agent/${publicStream.public_id}/steps`, { as: 2, body: { title: 'x', status: 'started' } });
        assert.strictEqual(other.status, 403, JSON.stringify(other.data));
        assert.strictEqual(other.data.code, 'not_your_stream');
        assert.strictEqual(auth.CAPABILITY, 'live.agent_stream.publish');
        assert.strictEqual(auth.holdsCapability({ sub: 'svc:codes', cap: ['chat.message.write'] }), false);
    });
    await check('a second step in the same second is refused', async () => {
        const r = await call('POST', `/api/streams/agent/${publicStream.public_id}/steps`, { body: { title: 'Too fast', status: 'started' } });
        assert.strictEqual(r.status, 429, JSON.stringify(r.data));
        assert.strictEqual(r.data.code, 'steps_too_fast');
    });
    await check('the title and detail caps are enforced', async () => {
        await slack();
        const longTitle = await call('POST', `/api/streams/agent/${publicStream.public_id}/steps`, { body: { title: 't'.repeat(121), status: 'started' } });
        assert.strictEqual(longTitle.status, 400);
        assert.strictEqual(longTitle.data.code, 'invalid_title');
        await slack();
        const longDetail = await call('POST', `/api/streams/agent/${publicStream.public_id}/steps`, { body: { title: 'A step', status: 'started', detail: 'd'.repeat(501) } });
        assert.strictEqual(longDetail.status, 400);
        assert.strictEqual(longDetail.data.code, 'invalid_detail');
        assert.strictEqual(steps.plain('a'.repeat(120), 120).length, 120);
        assert.strictEqual(steps.plain('a'.repeat(121), 120), null);
    });
    await check('the house text filters refuse a step', async () => {
        await slack();
        const r = await call('POST', `/api/streams/agent/${publicStream.public_id}/steps`, { body: { title: 'my exact location', status: 'started' } });
        assert.strictEqual(r.status, 422, JSON.stringify(r.data));
        assert.strictEqual(r.data.code, 'text_rejected');
    });
    await check('2,000 steps is the cap', async () => {
        await db.run(`INSERT INTO agent_stream_steps (managed_stream_id, at, title, status)
                      SELECT ?, now(), 'step ' || n, 'passed' FROM generate_series(1, 2000) AS n`, [privateStream.managed_stream_id]);
        await service.markPublishing(privateStream);
        const r = await call('POST', `/api/streams/agent/${privateStream.public_id}/steps`, { body: { title: 'One too many', status: 'started' } });
        assert.strictEqual(r.status, 429, JSON.stringify(r.data));
        assert.strictEqual(r.data.code, 'too_many_steps');
    });
    await check('an ended stream takes no more steps', async () => {
        const ended = await streamOf('private', 'A finished job');
        await service.markPublishing(ended);
        await service.end(ended);
        const r = await call('POST', `/api/streams/agent/${ended.public_id}/steps`, { body: { title: 'After the end', status: 'passed' } });
        assert.strictEqual(r.status, 409, JSON.stringify(r.data));
    });

    quiet('agent streams S2: the overlay and the chapters');
    await check('the overlay is drawn by the page from the steps feed, never burned in', async () => {
        const overlay = fs.readFileSync(path.join(__dirname, '../public/js/agent-overlay.js'), 'utf8');
        assert.match(overlay, /agent-overlay-dot is-\$\{cur\.status\}/);
        assert.match(overlay, /textContent = cur\.title/);
        assert.match(overlay, /slice\(-12\)/, 'the timeline is the last twelve steps');
        assert.match(overlay, /FOLD_KEY/, 'the fold is remembered');
        const fragment = fs.readFileSync(path.join(__dirname, '../public/fragments/agent-stream.html'), 'utf8');
        assert.match(fragment, /id="agent-overlay"/);
        const embed = fs.readFileSync(path.join(__dirname, '../server/agent-streams/pages.js'), 'utf8');
        assert.match(embed, /agent-overlay\.js/);
        const css = fs.readFileSync(path.join(__dirname, '../public/css/features/agent-stream.css'), 'utf8');
        assert.match(css, /@media \(max-width: 640px\)/, 'the phone layout is one line');
    });
    await check('chapters are the steps that started, at their offset', async () => {
        const chapters = await service.create({
            user: ann,
            title: 'A chaptered run',
            task: { source: 'actor', ref: 'run_1', title: 'Chaptered' },
            visibility: 'public',
        });
        const startedAt = new Date(Date.now() - 10 * 60 * 1000);
        await db.run('UPDATE agent_streams SET started_at = ?, state = ? WHERE managed_stream_id = ?', [startedAt, 'ended', chapters.managed_stream_id]);
        await db.run('UPDATE agent_streams SET vod_id = ? WHERE managed_stream_id = ?', ['512', chapters.managed_stream_id]);
        await db.run(`INSERT INTO agent_stream_steps (managed_stream_id, at, title, status) VALUES
            (?, ?, 'Install dependencies', 'started'),
            (?, ?, 'Run the tests', 'started'),
            (?, ?, 'Run the tests', 'passed')`,
            [chapters.managed_stream_id, new Date(startedAt.getTime() + 60000), chapters.managed_stream_id,
                new Date(startedAt.getTime() + 180000), chapters.managed_stream_id, new Date(startedAt.getTime() + 240000)]);
        const r = await call('GET', `/api/streams/agent/${chapters.public_id}/chapters`);
        assert.strictEqual(r.status, 200, JSON.stringify(r.data));
        assert.deepStrictEqual(r.data.chapters.map((c) => c.at), [60, 180]);
        assert.deepStrictEqual(r.data.chapters.map((c) => c.title), ['Install dependencies', 'Run the tests']);
        assert.strictEqual(r.data.vod_id, '512');
    });
    await check('a failed step and the final passed step can be clipped, through Media', async () => {
        const media = require('../server/media-client');
        const original = media.createClip;
        const asked = [];
        media.createClip = async (args) => { asked.push(args); return { id: 77, status: 'queued' }; };
        try {
            const chapters = await db.get("SELECT ms.public_id, ms.id AS managed_stream_id FROM managed_streams ms JOIN agent_streams a ON a.managed_stream_id = ms.id WHERE a.vod_id = '512'");
            const rows = await db.all('SELECT id, status FROM agent_stream_steps WHERE managed_stream_id = ? ORDER BY id', [chapters.managed_stream_id]);
            const started = rows.find((r) => r.status === 'started');
            const passed = rows.find((r) => r.status === 'passed');
            const refused = await call('POST', `/api/streams/agent/${chapters.public_id}/clips`, { body: { step_id: started.id } });
            assert.strictEqual(refused.status, 409, JSON.stringify(refused.data));
            assert.strictEqual(refused.data.code, 'not_clippable');
            const made = await call('POST', `/api/streams/agent/${chapters.public_id}/clips`, { body: { step_id: passed.id } });
            assert.strictEqual(made.status, 201, JSON.stringify(made.data));
            assert.strictEqual(asked.length, 1);
            assert.strictEqual(asked[0].vod_id, '512');
            assert.ok(asked[0].end_s > asked[0].start_s);
        } finally { media.createClip = original; }
    });

    quiet('agent streams S2: public streams and the Agents tab');
    await check('a public stream is listed, a private one is not, and neither is in people\'s streams', async () => {
        const list = await call('GET', '/api/streams/agent?live=1', { as: 2 });
        assert.strictEqual(list.status, 200, JSON.stringify(list.data));
        const ids = list.data.agents.map((a) => a.id);
        assert.ok(ids.includes(publicStream.public_id), 'the public live stream is listed');
        assert.ok(!ids.includes(privateStream.public_id), 'the private one is not');
        const card = list.data.agents.find((a) => a.id === publicStream.public_id);
        assert.strictEqual(card.label, 'AI agent');
        assert.strictEqual(card.chat_room, `agent:${publicStream.public_id}`, 'a public stream names its chat room');
        const people = await db.getLiveStreams();
        assert.ok(!people.some((s) => s.managed_stream_id === publicStream.managed_stream_id), 'never mixed into people\'s streams');
    });
    await check('the channel Agents tab shows the owner everything, everyone else only public cards', async () => {
        const own = await call('GET', `/api/streams/agent?channel=ann`, { as: 1 });
        const ids = own.data.agents.map((a) => a.id);
        assert.ok(ids.includes(publicStream.public_id) && ids.includes(privateStream.public_id), 'the owner sees both');
        const other = await call('GET', `/api/streams/agent?channel=ann`, { as: 2 });
        const otherIds = other.data.agents.map((a) => a.id);
        assert.ok(otherIds.includes(publicStream.public_id));
        assert.ok(!otherIds.includes(privateStream.public_id), 'a private card is not shown to a stranger');
    });
    await check('a private stream\'s steps stay private', async () => {
        const r = await call('GET', `/api/streams/agent/${privateStream.public_id}/steps`, { as: 2 });
        assert.strictEqual(r.status, 404);
        const own = await call('GET', `/api/streams/agent/${privateStream.public_id}/steps`, { as: 1 });
        assert.strictEqual(own.status, 200);
        assert.ok(own.data.steps.length === 20, 'the newest 20');
    });
    await check('the home row and the channel tab exist in the markup and the scripts', async () => {
        const home = fs.readFileSync(path.join(__dirname, '../public/fragments/home.html'), 'utf8');
        assert.match(home, /id="home-agents"/);
        assert.match(home, /Agents live/);
        const channel = fs.readFileSync(path.join(__dirname, '../public/fragments/channel.html'), 'utf8');
        assert.match(channel, /data-tab="agents"/);
        assert.match(channel, /id="ch-panel-agents"/);
        const cards = fs.readFileSync(path.join(__dirname, '../public/js/agent-cards.js'), 'utf8');
        assert.match(cards, /chat_room|current_step/);
        const homeJs = fs.readFileSync(path.join(__dirname, '../public/js/app-home.js'), 'utf8');
        assert.match(homeJs, /function renderHomeAgents/);
        const features = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/features.json'), 'utf8'));
        assert.ok(features.features.channel.js.includes('/js/agent-cards.js'));
    });
    await check('the sitemap and llms.txt name a public agent stream while it is live', async () => {
        const discovery = require('../server/seo/discovery');
        const xml = await discovery.buildSitemap([]);
        assert.ok(String(xml).includes(`/@ann/agents/${publicStream.public_id}`), 'the live public agent page is in the sitemap');
        assert.ok(!String(xml).includes(`/@ann/agents/${privateStream.public_id}`), 'the private one is not');
        const llms = await discovery.llmsTxt();
        assert.ok(String(llms).includes(`/@ann/agents/${publicStream.public_id}`));
    });

    server.close();
    await db.closeDb?.();
    quiet(failures ? `\n${failures} check(s) failed` : '\nAll agent stream S2 checks passed');
    process.exit(failures ? 1 : 0);
})().catch((e) => { quiet(e.stack || String(e)); process.exit(1); });
