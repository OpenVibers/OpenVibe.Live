'use strict';
/**
 * Agent streams S4, Live's part (design 2026-11-06): the agent's voice.
 *
 *   - the line writer: one or two sentences, at most 220 characters, in the stream's personality;
 *   - the house text filters have the last word: a line that trips them is not said;
 *   - the pacing: one line every 20 s at most, the newest line wins (a queue of two), a failure line interrupts
 *     the gap once;
 *   - the lines travel in the state the desk polls, and the page shows them as captions and the recording keeps
 *     them as WebVTT;
 *   - the owner picks the mode, the voice and the personality, and mutes the voice; a channel moderator may mute
 *     it too;
 *   - the allowance: when the person's ceiling is spent the voice pauses and says so.
 *
 * Sign-in is stubbed with an x-test-user header (as agent-streams-s2.test.js does); everything after that is
 * production. The writer's model call is replaced by a stub (the writer takes its generator), so the pacing and
 * the filters are tested without a provider and without a clock of their own.
 */
const assert = require('assert');
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
    require('../server/agent-streams/sharing')._setNetwork({ json: async () => ({}) });
    const tickets = require('../server/agent-streams/tickets');
    const voice = require('../server/agent-streams/voice');
    const ann = await db.getUserById(1);
    const bob = await db.getUserById(2);

    const streamOf = (visibility, title) => service.create({
        user: ann,
        title,
        task: { source: 'codes', ref: 'tsk_1', title: 'Run the checkout tests', url: 'https://openvibe.codes/tasks/1' },
        visibility,
    });
    const publicStream = await streamOf('public', 'Fixing the checkout tests');

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
        return { status: res.status, data, text };
    };

    quiet('agent streams S4: the voice');

    // ── the writer, on its own (no model, no clock of its own) ──
    const makeWriter = (lines) => {
        let clock = 1000;
        const w = new voice.Writer({
            now: () => clock,
            generate: async () => lines.shift() || null,
        });
        return { writer: w, tick: (ms) => { clock += ms; } };
    };
    const row = { managed_stream_id: 999, user_id: 1, mode: 'narrated', personality: 'calm', task: { title: 'Run the checkout tests' } };

    await check('a line is at most 220 characters and ends at a sentence', () => {
        const long = 'The checkout tests are green and the build is ready to ship. ' + 'x'.repeat(400);
        const out = voice.clamp(long);
        assert.ok(Array.from(out).length <= voice.MAX_CHARS, `length ${Array.from(out).length}`);
        assert.ok(out.endsWith('.'), out);
    });

    await check('the personalities are the four the design names', () => {
        assert.deepStrictEqual(voice.PERSONALITIES, ['calm', 'hype', 'dry', 'roast']);
    });

    await check('the house filters refuse a slur line', () => {
        // The word itself is not written here on purpose; the filter is checked with the same helper chat runs.
        const slur = ['n', 'i', 'g', 'g', 'a'].join('');
        assert.strictEqual(voice.allowed(`you are a ${slur}`), false);
        assert.strictEqual(voice.allowed('the checkout tests are green'), true);
    });

    await check('the filters also refuse hate and doxxing', () => {
        assert.strictEqual(voice.allowed('my email is ann@example.com'), false);
        assert.strictEqual(voice.allowed('call me on +1 555 123 4567'), false);
    });

    await check('a line is written in the stream\'s personality and kept', async () => {
        const { writer: w } = makeWriter(['The checkout tests are green.']);
        const line = await w.onStep({ ...row, personality: 'hype' }, { title: 'Checkout tests', status: 'passed' });
        assert.ok(line, 'a line was written');
        assert.strictEqual(line.text, 'The checkout tests are green.');
        assert.strictEqual(line.personality, 'hype');
        assert.strictEqual(line.kind, 'result');
    });

    await check('the writer stays quiet outside narrated mode, and when muted', async () => {
        const { writer: w } = makeWriter(['A line.']);
        assert.strictEqual(await w.onStep({ ...row, mode: 'watch' }, { title: 'x', status: 'started' }), null);
        assert.strictEqual(await w.onStep({ ...row, voice_muted: true }, { title: 'x', status: 'started' }), null);
    });

    await check('a refused line is never said, and the next step gets a new line', async () => {
        const { writer: w } = makeWriter(['you are a ' + ['n', 'i', 'g', 'g', 'a'].join(''), 'The tests are green.']);
        const first = await w.onStep({ ...row }, { title: 'x', status: 'started' });
        assert.strictEqual(first, null, 'the slur line was not said');
        const second = await w.onStep({ ...row }, { title: 'y', status: 'started' });
        assert.ok(second && second.text === 'The tests are green.', 'the next step got a fresh line');
    });

    await check('one line every 20 s: the second step waits for the gap', async () => {
        const { writer: w, tick } = makeWriter(['First line.', 'Second line.']);
        const first = await w.onStep({ ...row }, { title: 'a', status: 'started' });
        assert.ok(first, 'the first line is said at once');
        tick(5000);
        const second = await w.onStep({ ...row }, { title: 'b', status: 'started' });
        assert.strictEqual(second, null, 'the gap held the second line back');
        assert.strictEqual(w.pending(999).length, 1, 'the line waits in the queue');
    });

    await check('the newest line wins: a queue of two, the older one is dropped', async () => {
        const { writer: w } = makeWriter(['First.', 'Second.', 'Third.']);
        const first = await w.onStep({ ...row }, { title: 'a', status: 'started' });
        assert.ok(first);
        await w.onStep({ ...row }, { title: 'b', status: 'started' });
        await w.onStep({ ...row }, { title: 'c', status: 'started' });
        const pending = w.pending(999);
        assert.strictEqual(pending.length, voice.QUEUE_MAX, 'the queue holds two');
        assert.strictEqual(pending[pending.length - 1].text, 'Third.', 'the newest line is the one left');
    });

    await check('a failure line interrupts the gap once', async () => {
        const { writer: w, tick } = makeWriter(['First.', 'The build broke.']);
        await w.onStep({ ...row }, { title: 'a', status: 'started' });
        tick(3000);
        const said = await w.onStep({ ...row }, { title: 'b', status: 'failed' });
        assert.ok(said && said.kind === 'failure', 'the failure line interrupted');
        tick(3000);
        const again = await w.onStep({ ...row }, { title: 'c', status: 'failed' });
        assert.strictEqual(again, null, 'the interrupt is used once');
    });

    await check('the WebVTT carries the lines as captions', () => {
        const vtt = voice.webvtt([{ start: 0, text: 'The checkout tests are green.' }, { start: 2.5, text: 'Second line.' }]);
        assert.ok(vtt.startsWith('WEBVTT'), vtt.slice(0, 40));
        assert.ok(vtt.includes('00:00:00.000 --> 00:00:04.000'), vtt);
        assert.ok(vtt.includes('The checkout tests are green.'), vtt);
    });

    quiet('agent streams S4: the owner\'s controls');
    const publish = await tickets.issuePublish(publicStream.managed_stream_id);
    await service.markPublishing(publicStream);

    await check('the owner picks the mode, the personality and the voice', async () => {
        const r = await call('PUT', `/api/streams/agent/${publicStream.public_id}/voice`, {
            body: { mode: 'narrated', personality: 'dry', voice: 'gary' },
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.data));
        assert.strictEqual(r.data.voice.mode, 'narrated');
        assert.strictEqual(r.data.voice.personality, 'dry');
        assert.strictEqual(r.data.voice.voice, 'gary');
    });

    await check('another account cannot change the voice', async () => {
        const r = await call('PUT', `/api/streams/agent/${publicStream.public_id}/voice`, {
            as: 2, body: { personality: 'roast' },
        });
        assert.strictEqual(r.status, 403, JSON.stringify(r.data));
    });

    await check('a bad personality is refused', async () => {
        const r = await call('PUT', `/api/streams/agent/${publicStream.public_id}/voice`, {
            body: { personality: 'sarcastic' },
        });
        assert.strictEqual(r.status, 400, JSON.stringify(r.data));
    });

    await check('the owner\'s own cloned voice needs their consent', async () => {
        const refused = await call('PUT', `/api/streams/agent/${publicStream.public_id}/voice`, { body: { own: true } });
        assert.strictEqual(refused.status, 422, JSON.stringify(refused.data));
        const ok = await call('PUT', `/api/streams/agent/${publicStream.public_id}/voice`, {
            body: { own: true, own_consent: true },
        });
        assert.strictEqual(ok.status, 200, JSON.stringify(ok.data));
        assert.strictEqual(ok.data.voice.own, true);
        assert.ok(ok.data.voice.own_consent_at, 'the moment they said yes is kept');
    });

    await check('the owner mutes the voice', async () => {
        const r = await call('POST', `/api/streams/agent/${publicStream.public_id}/voice/mute`, { body: { muted: true } });
        assert.strictEqual(r.status, 200, JSON.stringify(r.data));
        assert.strictEqual(r.data.voice.muted, true);
    });

    await check('a stranger cannot mute the voice', async () => {
        const r = await call('POST', `/api/streams/agent/${publicStream.public_id}/voice/mute`, {
            as: 2, body: { muted: false },
        });
        assert.ok(r.status === 403 || r.status === 404, JSON.stringify(r.data));
    });

    await check('a channel moderator may mute the voice', async () => {
        const permissions = require('../server/auth/permissions');
        const original = permissions.canModerateChannel;
        permissions.canModerateChannel = async () => true;
        try {
            const r = await call('POST', `/api/streams/agent/${publicStream.public_id}/voice/mute`, {
                as: 2, body: { muted: false },
            });
            assert.strictEqual(r.status, 200, JSON.stringify(r.data));
            assert.strictEqual(r.data.voice.muted, false);
        } finally {
            permissions.canModerateChannel = original;
        }
    });

    await check('the allowance message is what the design says', async () => {
        const row2 = await service.getByManagedStreamId(publicStream.managed_stream_id);
        await db.run('UPDATE agent_streams SET voice_paused = ? WHERE managed_stream_id = ?', ['allowance_spent', row2.managed_stream_id]);
        const r = await call('GET', `/api/streams/agent/${publicStream.public_id}/voice`);
        assert.strictEqual(r.data.voice.paused, 'allowance_spent');
        assert.strictEqual(r.data.voice.message, 'voice paused: allowance spent');
        await db.run('UPDATE agent_streams SET voice_paused = NULL WHERE managed_stream_id = ?', [row2.managed_stream_id]);
    });

    quiet('agent streams S4: the lines the desk reads');
    await check('a spoken line travels in the state the desk polls', async () => {
        const row3 = await service.getByManagedStreamId(publicStream.managed_stream_id);
        await db.run('UPDATE agent_streams SET voice_muted = false, mode = ? WHERE managed_stream_id = ?', ['narrated', row3.managed_stream_id]);
        const now = new Date().toISOString();
        await db.run(
            `INSERT INTO agent_stream_lines (managed_stream_id, at, text, personality, voice, kind) VALUES (?, ?, ?, ?, ?, ?)`,
            [row3.managed_stream_id, now, 'The checkout tests are green.', 'calm', 'gary', 'result']);
        const r = await call('GET', `/api/streams/agent/${publicStream.public_id}/state`, {
            headers: { Authorization: `Bearer ${publish.ticket}` },
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.data));
        assert.ok(Array.isArray(r.data.lines) && r.data.lines.length, 'the state carries the lines');
        assert.strictEqual(r.data.lines[r.data.lines.length - 1].text, 'The checkout tests are green.');
        assert.ok(r.data.voice, 'the state carries the voice');
    });

    await check('the desk asks for the lines it has not read yet', async () => {
        const row4 = await service.getByManagedStreamId(publicStream.managed_stream_id);
        const first = await call('GET', `/api/streams/agent/${publicStream.public_id}/state`, {
            headers: { Authorization: `Bearer ${publish.ticket}` },
        });
        const lastId = first.data.lines[first.data.lines.length - 1].id;
        const second = await call('GET', `/api/streams/agent/${publicStream.public_id}/state?after=${lastId}`, {
            headers: { Authorization: `Bearer ${publish.ticket}` },
        });
        assert.deepStrictEqual(second.data.lines, [], 'nothing new after the last id');
        const row5 = await service.getByManagedStreamId(row4.managed_stream_id);
        await db.run(
            `INSERT INTO agent_stream_lines (managed_stream_id, at, text, personality, voice, kind) VALUES (?, ?, ?, ?, ?, ?)`,
            [row5.managed_stream_id, new Date().toISOString(), 'A newer line.', 'calm', 'gary', 'step']);
        const third = await call('GET', `/api/streams/agent/${publicStream.public_id}/state?after=${lastId}`, {
            headers: { Authorization: `Bearer ${publish.ticket}` },
        });
        assert.strictEqual(third.data.lines.length, 1);
        assert.strictEqual(third.data.lines[0].text, 'A newer line.');
    });

    await check('the page reads the lines as captions', async () => {
        const r = await call('GET', `/api/streams/agent/${publicStream.public_id}/lines`);
        assert.strictEqual(r.status, 200, JSON.stringify(r.data));
        assert.ok(Array.isArray(r.data.lines) && r.data.lines.length, 'the lines are there');
        assert.ok(r.data.voice, 'the voice is there');
    });

    await check('the recording keeps the captions as WebVTT', async () => {
        const res = await fetch(`${base}/api/streams/agent/${publicStream.public_id}/captions.vtt`, {
            headers: { 'x-test-user': '1' },
        });
        assert.strictEqual(res.status, 200);
        assert.ok(String(res.headers.get('content-type')).includes('text/vtt'), res.headers.get('content-type'));
        const text = await res.text();
        assert.ok(text.startsWith('WEBVTT'), text.slice(0, 40));
        assert.ok(text.includes('The checkout tests are green.'), text);
    });

    await check('the owner page carries the voice controls', () => {
        const fs = require('node:fs');
        const path = require('node:path');
        const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'fragments', 'agent-stream.html'), 'utf8');
        for (const id of ['agent-voice-mode', 'agent-voice-personality', 'agent-voice-pick', 'agent-voice-own', 'agent-voice-mute']) {
            assert.ok(html.includes(id), `the page has ${id}`);
        }
    });

    server.close();
    quiet(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
})();