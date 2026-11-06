'use strict';
/**
 * Agent streams: WHEP (the design's "Added 2026-11-06").
 *
 *   POST /whep/agent/<ags> takes a viewer's offer and answers an SDP answer the way /whip takes an ingest offer.
 *   A private or unlisted stream needs a view ticket; a public one needs none. A stream that is not publishing has
 *   nothing to send (409 not_live). The viewer's consumers are ordinary room consumers, so the curtain pauses them.
 *   DELETE ends the session, never the stream.
 *
 * The media path itself needs a running mediasoup, so a request that gets past authentication and finds a live session
 * stops at `503 sfu_unavailable` here; the SDP answer and the capability mapping are tested directly.
 */
const assert = require('assert');
const sdpTransform = require('sdp-transform');

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

const OFFER = sdpTransform.write({
    version: 0,
    origin: { username: '-', sessionId: '1', sessionVersion: 1, netType: 'IN', ipVer: 4, address: '127.0.0.1' },
    name: '-',
    timing: { start: 0, stop: 0 },
    media: [{
        type: 'video', port: 9, protocol: 'UDP/TLS/RTP/SAVPF', payloads: '96 97', mid: '0',
        direction: 'recvonly', setup: 'actpass', rtcpMux: 'rtcp-mux',
        fingerprint: { type: 'sha-256', hash: 'AA:BB:CC' },
        rtp: [{ payload: 96, codec: 'H264', rate: 90000 }, { payload: 97, codec: 'rtx', rate: 90000 }],
        fmtp: [{ payload: 96, config: 'profile-level-id=42e01f;packetization-mode=1' }, { payload: 97, config: 'apt=96' }],
        rtcpFb: [{ payload: 96, type: 'nack' }, { payload: 96, type: 'nack', subtype: 'pli' }],
        ext: [{ value: 1, uri: 'urn:ietf:params:rtp-hdrext:sdes:mid' }],
    }, {
        type: 'audio', port: 9, protocol: 'UDP/TLS/RTP/SAVPF', payloads: '111', mid: '1',
        direction: 'recvonly', setup: 'actpass', rtcpMux: 'rtcp-mux',
        fingerprint: { type: 'sha-256', hash: 'AA:BB:CC' },
        rtp: [{ payload: 111, codec: 'opus', rate: 48000, encoding: 2 }],
        fmtp: [{ payload: 111, config: 'minptime=10;useinbandfec=1' }],
        ext: [{ value: 1, uri: 'urn:ietf:params:rtp-hdrext:sdes:mid' }],
    }],
});

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    const raw = db.getDb();
    const addUser = async (id, username, role) => await raw.prepare(
        `INSERT INTO users (id, username, display_name, email, password_hash, role, is_owner) OVERRIDING SYSTEM VALUE
         VALUES (?, ?, ?, ?, 'x', ?, 0)`).run(id, username, username, `${username}@x`, role);
    await addUser(1, 'ann', 'streamer');
    await raw.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (1, 'network', '101', ?)").run(SID.ann);

    const service = require('../server/agent-streams/service');
    const tickets = require('../server/agent-streams/tickets');
    const curtains = require('../server/streaming/curtains');
    const whep = require('../server/streaming/whep-handler');
    const webrtcSFU = require('../server/streaming/webrtc-sfu');
    const ann = await db.getUserById(1);

    const make = async (visibility, title) => await service.create({
        user: ann, title, task: { source: 'node', ref: `d-${title}`, title: 'Work' }, visibility,
    });

    // A public stream, and a private one that is publishing.
    const pub = await make('public', 'Public');
    const priv = await make('private', 'Private');
    const liveStream = await db.createStream({ user_id: 1, managed_stream_id: priv.managed_stream_id, title: 'Private', protocol: 'webrtc' });
    await service.markPublishing(await service.getByManagedStreamId(priv.managed_stream_id));

    const post = async (agent, { ticket, body = OFFER } = {}) => {
        const res = fakeRes();
        await whep.handleWhepPost({
            params: { id: agent.public_id },
            headers: ticket ? { authorization: `Bearer ${ticket}` } : {},
            body,
            protocol: 'https',
            query: {},
            get: (n) => (n === 'host' ? 'live.test' : undefined),
        }, res);
        return res;
    };

    quiet('agent streams: WHEP authorisation');
    await check('a private stream refuses WHEP without a view ticket', async () => {
        const res = await post(priv);
        assert.strictEqual(res.statusCode, 401);
        assert.strictEqual(res.headers['X-WHEP-ERROR'], 'invalid_ticket');
    });
    await check('an expired, another stream\'s or a made-up ticket is refused', async () => {
        const expired = 'wvt_' + require('crypto').randomBytes(32).toString('base64url');
        await db.run("INSERT INTO agent_view_tickets (managed_stream_id, token_hash, subject, via, expires_at, renews_until) VALUES (?, ?, NULL, 'owner', now() - interval '1 minute', now())",
            [priv.managed_stream_id, service.sha256(expired)]);
        assert.strictEqual((await post(priv, { ticket: expired })).statusCode, 401);
        const otherStreams = await tickets.issueView(pub.managed_stream_id, { via: 'owner' });
        assert.strictEqual((await post(priv, { ticket: otherStreams.ticket })).statusCode, 401);
        assert.strictEqual((await post(priv, { ticket: 'wvt_' + 'x'.repeat(43) })).statusCode, 401);
    });
    await check('a valid view ticket passes authorisation and reaches the media path (503 without an SFU here)', async () => {
        const view = await tickets.issueView(priv.managed_stream_id, { via: 'owner' });
        const res = await post(priv, { ticket: view.ticket });
        assert.strictEqual(res.statusCode, 503);
        assert.strictEqual(res.headers['X-WHEP-ERROR'], 'sfu_unavailable');
    });
    await check('a public stream needs no ticket', async () => {
        const res = await post(pub);
        // Not publishing: nothing to send. The point is that it was not refused for a missing ticket.
        assert.strictEqual(res.statusCode, 409);
        assert.strictEqual(res.headers['X-WHEP-ERROR'], 'not_live');
    });
    await check('a public stream that is publishing reaches the media path', async () => {
        const liveRow = await db.createStream({ user_id: 1, managed_stream_id: pub.managed_stream_id, title: 'Public', protocol: 'webrtc' });
        await service.markPublishing(await service.getByManagedStreamId(pub.managed_stream_id));
        try {
            const res = await post(pub);
            assert.strictEqual(res.statusCode, 503);
            assert.strictEqual(res.headers['X-WHEP-ERROR'], 'sfu_unavailable');
        } finally { void liveRow; }
    });
    await check('an unknown stream is 404, and DELETE of a session nobody opened is 404', async () => {
        const missing = fakeRes();
        await whep.handleWhepPost({ params: { id: 'ags_00000000000000000000000000' }, headers: {}, body: OFFER, protocol: 'https', get: () => 'live.test' }, missing);
        assert.strictEqual(missing.statusCode, 404);
        const gone = fakeRes();
        await whep.handleWhepDelete({ params: { id: priv.public_id, resourceId: 'nope' } }, gone);
        assert.strictEqual(gone.statusCode, 404);
    });

    quiet('agent streams: WHEP and the curtain');
    await check('a WHEP consumer is paused by the curtain like any other viewer', async () => {
        const roomId = `stream-${liveStream.lastInsertRowid}`;
        const made = [];
        const room = { producers: new Map(), consumers: new Map(), transports: new Map(), router: null };
        for (const [id, peerId] of [['w1', 'whep-abc'], ['w2', 'peer-1']]) {
            const consumer = { paused: false, pause() { this.paused = true; }, resume() { this.paused = false; } };
            room.consumers.set(id, { consumer, peerId });
            made.push(consumer);
        }
        webrtcSFU.rooms.set(roomId, room);
        try {
            assert.strictEqual(curtains.raise(liveStream.lastInsertRowid), 2);
            assert.deepStrictEqual(made.map((c) => c.paused), [true, true]);
            assert.strictEqual(curtains.lower(liveStream.lastInsertRowid), 2);
            assert.deepStrictEqual(made.map((c) => c.paused), [false, false]);
        } finally {
            webrtcSFU.rooms.delete(roomId);
            curtains._reset();
        }
    });

    quiet('agent streams: the WHEP answer');
    await check('the offer\'s codecs become the receive capabilities, with their parameters', async () => {
        const caps = whep._capabilitiesFromOffer(sdpTransform.parse(OFFER));
        const h264 = caps.codecs.find((c) => c.mimeType === 'video/H264');
        assert.ok(h264, 'H264 offered');
        assert.strictEqual(h264.clockRate, 90000);
        assert.strictEqual(h264.parameters['profile-level-id'], '42e01f');
        assert.ok(h264.rtcpFeedback.some((f) => f.type === 'nack' && f.parameter === 'pli'));
        assert.ok(!caps.codecs.some((c) => c.mimeType.toLowerCase().endsWith('/rtx')), 'rtx is not a receive codec');
        assert.ok(caps.codecs.some((c) => c.mimeType === 'audio/opus' && c.channels === 2));
        assert.ok(caps.headerExtensions.some((e) => e.kind === 'video' && e.uri.endsWith('sdes:mid')));
    });
    await check('the answer is sendonly, with the consumer\'s payload types, SSRC and BUNDLE', async () => {
        const transport = {
            iceParameters: { usernameFragment: 'ufrag', password: 'pwd' },
            iceCandidates: [{ foundation: '1', protocol: 'udp', priority: 100, ip: '127.0.0.1', port: 40000, type: 'host' }],
            dtlsParameters: { fingerprints: [{ algorithm: 'sha-256', value: 'AA:BB:CC' }] },
        };
        const consumer = {
            rtpParameters: {
                mid: '0',
                codecs: [{
                    mimeType: 'video/H264', payloadType: 102, clockRate: 90000,
                    parameters: { 'profile-level-id': '42e01f', 'packetization-mode': 1 },
                    rtcpFeedback: [{ type: 'nack', parameter: '' }, { type: 'nack', parameter: 'pli' }],
                }],
                headerExtensions: [{ id: 1, uri: 'urn:ietf:params:rtp-hdrext:sdes:mid' }],
                encodings: [{ ssrc: 123456 }],
            },
        };
        const answer = whep._buildWhepAnswer(transport, sdpTransform.parse(OFFER), [consumer], { resourceId: 'abc' });
        assert.match(answer, /^m=video 9 /m);
        assert.match(answer, /a=sendonly/);
        assert.match(answer, /a=rtpmap:102 H264\/90000/);
        assert.match(answer, /a=fmtp:102 profile-level-id=42e01f;packetization-mode=1/);
        assert.match(answer, /a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid/);
        assert.match(answer, /a=ssrc:123456 cname:whep-abc/);
        assert.match(answer, /a=group:BUNDLE 0/);
        assert.match(answer, /a=setup:passive/);
        assert.match(answer, /a=mid:0/);
        // The audio section had no consumer: it is rejected, not silently sent.
        assert.match(answer, /m=audio 0 /);
        assert.doesNotMatch(answer, /a=sendonly[\s\S]*m=audio 0 [\s\S]*a=sendonly/);
    });
    await check('WHEP sessions count as viewers and can be listed per stream', async () => {
        whep.sessions.set('r1', { streamId: 4242, agentId: priv.public_id, consumerIds: [] });
        whep.sessions.set('r2', { streamId: 4242, agentId: priv.public_id, consumerIds: [] });
        try {
            assert.strictEqual(whep.countForStream(4242), 2);
            assert.ok(service.viewersNow(4242) >= 2, 'they keep the desk encoding');
        } finally {
            whep.sessions.delete('r1');
            whep.sessions.delete('r2');
        }
    });
    await check('CORS is the WHIP endpoint\'s: every origin, POST/PATCH/DELETE/OPTIONS', async () => {
        const res = fakeRes();
        whep.handleWhepOptions({}, res);
        assert.strictEqual(res.statusCode, 204);
        assert.strictEqual(res.headers['Access-Control-Allow-Origin'], '*');
        assert.match(res.headers['Access-Control-Allow-Methods'], /POST/);
        assert.match(res.headers['Access-Control-Allow-Methods'], /DELETE/);
        assert.strictEqual(res.headers['Access-Control-Expose-Headers'], 'Location, X-WHEP-ERROR');
    });

    if (failures) { quiet(`${failures} agent stream WHEP check(s) failed`); process.exit(1); }
    quiet('agent streams (whep): ok');
})().catch((e) => { quiet(e && e.stack || String(e)); process.exit(1); });
