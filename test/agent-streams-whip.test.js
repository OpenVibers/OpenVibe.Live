'use strict';
/**
 * Agent streams: the WHIP ticket (Agent Streams S1).
 *
 * A desk publishes at POST /whip/agent/<ags> with `Authorization: Bearer wpt_…`. A ticket that does not verify, has
 * expired, was revoked, or names another stream is 401 invalid_ticket; a second session while one is up is 409
 * already_publishing; a person with a live agent stream already (one, or five for the owner) is 409
 * live.agent_stream_limit. A valid ticket reaches the media path, which this test stops at the SFU (503 in a test
 * process), proving the ticket itself was accepted.
 */
const assert = require('assert');

process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};
console.error = () => {};

const SID = { ann: 'usr_01JAB2C3D4E5F6G7H8J9K0MNA1', bob: 'usr_01JAB2C3D4E5F6G7H8J9K0MNB2' };
let failures = 0;
async function check(name, fn) {
    try { await fn(); quiet('  ✓', name); }
    catch (e) { failures++; quiet('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')); }
}

function fakeRes() {
    return {
        statusCode: 200,
        headers: {},
        body: null,
        status(code) { this.statusCode = code; return this; },
        set(key, value) { this.headers[key] = value; return this; },
        json(body) { this.body = body; return this; },
        send(body) { this.body = body; return this; },
        end() { return this; },
    };
}

function fakeReq({ id, ticket, body = 'v=0\r\n' }) {
    return {
        params: { id },
        headers: ticket ? { authorization: `Bearer ${ticket}` } : {},
        body,
        protocol: 'https',
        query: {},
        get(name) { return name === 'host' ? 'live.test' : undefined; },
    };
}

const token = (prefix) => prefix + require('crypto').randomBytes(32).toString('base64url');

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    const raw = db.getDb();
    const addUser = async (id, username, role, extra = {}) => await raw.prepare(
        `INSERT INTO users (id, username, display_name, email, password_hash, role, is_owner) OVERRIDING SYSTEM VALUE
         VALUES (?, ?, ?, ?, 'x', ?, ?)`).run(id, username, username, `${username}@x`, role, extra.is_owner ? 1 : 0);
    await addUser(1, 'ann', 'streamer');
    await addUser(2, 'bob', 'streamer');
    await raw.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (1, 'network', '101', ?), (2, 'network', '102', ?)").run(SID.ann, SID.bob);

    const service = require('../server/agent-streams/service');
    const tickets = require('../server/agent-streams/tickets');
    const whip = require('../server/streaming/whip-handler');
    const ann = await db.getUserById(1);
    const bob = await db.getUserById(2);

    const make = async (user, title) => await service.create({ user, title, task: { source: 'node', ref: `d-${title}`, title: 'Work' }, visibility: 'public' });
    const a = await make(ann, 'A');
    const b = await make(ann, 'B');
    const bobStream = await make(bob, 'Bob');

    quiet('agent streams: the publish ticket');
    await check('a ticket that does not verify is 401 invalid_ticket', async () => {
        const res = fakeRes();
        await whip.handleAgentWhipPost(fakeReq({ id: a.public_id, ticket: token('wpt_') }), res);
        assert.strictEqual(res.statusCode, 401);
        assert.strictEqual(res.headers['X-WHIP-ERROR'], 'invalid_ticket');
    });
    await check('an expired ticket is 401 invalid_ticket', async () => {
        const rawToken = token('wpt_');
        await db.run("INSERT INTO agent_publish_tickets (managed_stream_id, token_hash, expires_at) VALUES (?, ?, now() - interval '1 minute')",
            [a.managed_stream_id, service.sha256(rawToken)]);
        const res = fakeRes();
        await whip.handleAgentWhipPost(fakeReq({ id: a.public_id, ticket: rawToken }), res);
        assert.strictEqual(res.statusCode, 401);
        assert.strictEqual(res.headers['X-WHIP-ERROR'], 'invalid_ticket');
    });
    await check('a revoked ticket is 401 invalid_ticket', async () => {
        const rawToken = token('wpt_');
        await db.run('INSERT INTO agent_publish_tickets (managed_stream_id, token_hash, expires_at) VALUES (?, ?, now() + interval \'1 hour\')',
            [a.managed_stream_id, service.sha256(rawToken)]);
        await db.run('UPDATE agent_publish_tickets SET revoked_at = now() WHERE token_hash = ?', [service.sha256(rawToken)]);
        const res = fakeRes();
        await whip.handleAgentWhipPost(fakeReq({ id: a.public_id, ticket: rawToken }), res);
        assert.strictEqual(res.statusCode, 401);
        assert.strictEqual(res.headers['X-WHIP-ERROR'], 'invalid_ticket');
    });
    await check('another stream\'s ticket is 401 invalid_ticket', async () => {
        const mine = await tickets.issuePublish(b.managed_stream_id);
        const res = fakeRes();
        await whip.handleAgentWhipPost(fakeReq({ id: a.public_id, ticket: mine.ticket }), res);
        assert.strictEqual(res.statusCode, 401);
        assert.strictEqual(res.headers['X-WHIP-ERROR'], 'invalid_ticket');
    });

    quiet('agent streams: one session, one live stream');
    await check('a second WHIP session while one is up is 409 already_publishing', async () => {
        const session = await db.createStream({ user_id: 1, managed_stream_id: a.managed_stream_id, title: 'A', protocol: 'webrtc' });
        await service.markPublishing(await service.getByManagedStreamId(a.managed_stream_id));
        const resourceId = 'res-a-1';
        whip.sessions.set(resourceId, { streamId: session.lastInsertRowid, agentStreamId: a.public_id, agentManagedStreamId: a.managed_stream_id, iceReady: false, producerIds: [] });
        try {
            const ticket = await tickets.issuePublish(a.managed_stream_id);
            const res = fakeRes();
            await whip.handleAgentWhipPost(fakeReq({ id: a.public_id, ticket: ticket.ticket }), res);
            assert.strictEqual(res.statusCode, 409);
            assert.strictEqual(res.headers['X-WHIP-ERROR'], 'already_publishing');
        } finally {
            whip.sessions.delete(resourceId);
        }
    });
    await check('a second live agent stream on the account is 409 live.agent_stream_limit', async () => {
        // a is live from the check above; b is idle and wants to publish.
        const ticket = await tickets.issuePublish(b.managed_stream_id);
        const res = fakeRes();
        await whip.handleAgentWhipPost(fakeReq({ id: b.public_id, ticket: ticket.ticket }), res);
        assert.strictEqual(res.statusCode, 409);
        assert.strictEqual(res.headers['X-WHIP-ERROR'], 'live.agent_stream_limit');
    });
    await check('a valid ticket reaches the media path (503 in a test process, not an auth error)', async () => {
        const ticket = await tickets.issuePublish(bobStream.managed_stream_id);
        const res = fakeRes();
        await whip.handleAgentWhipPost(fakeReq({ id: bobStream.public_id, ticket: ticket.ticket }), res);
        assert.strictEqual(res.statusCode, 503);
        assert.strictEqual(res.headers['X-WHIP-ERROR'], 'sfu_unavailable');
    });
    await check('the owner may have five live agent streams (the owner rank)', async () => {
        assert.strictEqual(service.liveLimit({ is_owner: 1 }), 5);
        assert.strictEqual(service.liveLimit({ is_owner: 0 }), 1);
    });
    await check('a resource address on the agent path is answered under /whip/agent', async () => {
        const headers = whip.buildWhipResponseHeaders(fakeReq({ id: a.public_id }), a.public_id, 'res-1', '/whip/agent');
        assert.strictEqual(headers.Location, 'https://live.test/whip/agent/' + a.public_id + '/res-1');
    });

    if (failures) { quiet(`${failures} agent stream WHIP check(s) failed`); process.exit(1); }
    quiet('agent streams (whip): ok');
})().catch((e) => { quiet(e && e.stack || String(e)); process.exit(1); });
