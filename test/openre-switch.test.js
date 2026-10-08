'use strict';

// OpenRe ingest switch (roadmap Wave 7, ADR-009). With OPENRE_URL unset, or a slot on 'live' (the
// default), nothing changes. With a slot switched to 'openre': Live's RTMP, WHIP, browser
// broadcaster and JSMPEG ingest refuse its key, the Go Live helpers show OpenRe's URLs and rotate
// OpenRe's key, and OpenRe session events (signed Events deliveries, applied once, in revision
// order) become ordinary `streams` rows.

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');

delete process.env.OPENRE_URL;
delete process.env.OPENRE_EVENTS_SECRET;

const SUBJECT = 'usr_01J0000000000000000000000Q';
const SES = (n) => `ses_01J00000000000000000000${String(n).padStart(3, '0')}`.slice(0, 30);
const openreCalls = [];
let openreSessions = {};
/** OpenRe definitions by id: { id, ref, protocols }. */
const openreDefs = {};
const ingestOf = (protocols) => ({
    ...(protocols.includes('rtmp') ? { rtmp: { url: 'rtmp://ingest.openre.stream:1936/live', key_hint: 'WXYZ' } } : {}),
    ...(protocols.includes('webrtc') ? { webrtc: { whip_url: 'https://ingest.openre.stream/whip', signaling_url: 'wss://ingest.openre.stream/b', key_hint: 'WXYZ' } } : {}),
    ...(protocols.includes('jsmpeg') ? { jsmpeg: { url: 'http://ingest.openre.stream:8081', key_hint: 'WXYZ' } } : {}),
});
const view = (def) => ({ id: def.id, protocols: def.protocols, ingest: ingestOf(def.protocols) });

const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        const send = (status, obj) => { res.statusCode = status; res.end(JSON.stringify(obj)); };
        if (req.url === '/oauth/token') {
            const p = new URLSearchParams(body);
            // Live also asks for other audiences here (the go-live fan-out to Network).
            return send(200, { access_token: p.get('audience') === 'openvibe.openre' ? 'svc-live' : 'other', token_type: 'Bearer', expires_in: 300 });
        }
        if (!req.url.startsWith('/api/v1/')) return send(404, {});
        assert.strictEqual(req.headers.authorization, 'Bearer svc-live');
        openreCalls.push({ method: req.method, url: req.url, subject: req.headers['x-ov-subject'] || null, body: body ? JSON.parse(body) : null });
        const defOf = (u) => openreDefs[u.split('/')[4]] || { id: u.split('/')[4], protocols: ['rtmp'] };
        if (req.method === 'GET' && req.url.startsWith('/api/v1/streams?external_ref=')) {
            const ref = new URL(req.url, 'http://x').searchParams.get('external_ref');
            return send(200, { streams: Object.values(openreDefs).filter(x => x.ref === ref).map(view) });
        }
        if (req.method === 'POST' && req.url === '/api/v1/streams') {
            const b = JSON.parse(body);
            const slotId = b.external_refs[0].id;
            const def = { id: slotId === '701' ? 'std_01J0000000000000000000000S' : `std_slot${slotId}`, ref: `live:managed_stream:${slotId}`, protocols: b.protocols || ['rtmp'] };
            openreDefs[def.id] = def;
            return send(201, { stream: view(def), key: { key: 'ork_dropped' } });
        }
        if (req.method === 'PATCH' && req.url.startsWith('/api/v1/streams/std_')) {
            const def = defOf(req.url);
            def.protocols = JSON.parse(body).protocols;
            return send(200, { stream: view(def) });
        }
        if (req.method === 'GET' && req.url.startsWith('/api/v1/streams/std_')) return send(200, { stream: view(defOf(req.url)) });
        if (req.method === 'POST' && req.url.endsWith('/keys/rotate')) return send(200, { key: { key: 'ork_newkey_shown_once' }, ingest: ingestOf(defOf(req.url).protocols) });
        const m = /^\/api\/v1\/sessions\/(ses_[0-9A-Z]+)(\/playback)?$/.exec(req.url);
        if (m && openreSessions[m[1]]) {
            if (m[2]) return send(200, { playback: { flv: { internal_url: `http://127.0.0.1:19999/live/${m[1]}.flv` } } });
            return send(200, { session: openreSessions[m[1]] });
        }
        return send(404, { code: 'openre.not_found' });
    });
});

function signed(event, secret, { now } = {}) {
    const { signDelivery, signDeliveryHeaders } = require('openvibe-sdk/events');
    const raw = Buffer.from(JSON.stringify({ event, seq: 1 }));
    return { raw, headers: signDeliveryHeaders(raw, secret, { now }), v1: { 'X-OpenVibe-Signature': signDelivery(raw, secret) } };
}

/** POST a delivery (never on a kept-alive socket: the server may drop an idle one between slow steps, which surfaced as ECONNRESET under load): all three signature headers by default; `v1Only` sends only X-OpenVibe-Signature; `now` backdates the v2 timestamp. */
async function deliver(base, event, { secret = 'whsec_test', headers, v1Only = false, now } = {}) {
    const s = signed(event, secret, { now });
    const res = await fetch(`${base}/internal/openre-events`, { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close', ...(headers || (v1Only ? s.v1 : s.headers)) }, body: s.raw });
    return res.status;
}

let seq = 0;
function sessionEvent(type, sessionId, revision, payload = {}) {
    seq++;
    return {
        event_id: `evt_01J00000000000000000${String(seq).padStart(5, '0')}`,
        event_type: `openre.session.${type}`,
        version: 1,
        source: 'openre',
        actor: { type: 'user', id: SUBJECT },
        timestamp: new Date().toISOString(),
        subject: { type: 'ingest_session', id: sessionId, revision },
        payload: { session_id: sessionId, external_refs: [{ service: 'live', type: 'managed_stream', id: '701' }], mirror_to_live: true, started_at: new Date().toISOString(), ...payload },
    };
}

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    // broadcast-server takes authenticateWs at load (the mirror may load it first): 'tok-<user id>' signs in.
    require('../server/auth/auth').authenticateWs = async (token) => (/^tok-\d+$/.test(token || '') ? (await db.getUserById(Number(token.slice(4)))) || null : null);
    const d = db.getDb();
    await d.prepare("INSERT INTO users (id, username, display_name, password_hash, stream_key) OVERRIDING SYSTEM VALUE VALUES (601, 'caster', 'Caster', 'x', 'personalkey601')").run();
    await d.prepare("INSERT INTO users (id, username, display_name, password_hash) OVERRIDING SYSTEM VALUE VALUES (602, 'nosub', 'NoSub', 'x')").run();
    await d.prepare(`INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (601, 'network', '91', '${SUBJECT}')`).run();
    await d.prepare("INSERT INTO managed_streams (id, user_id, title, protocol, stream_key, streaming_method) OVERRIDING SYSTEM VALUE VALUES (701, 601, 'OBS slot', 'rtmp', 'livekey701aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'obs')").run();
    await d.prepare("INSERT INTO managed_streams (id, user_id, title, protocol, stream_key) OVERRIDING SYSTEM VALUE VALUES (702, 601, 'Browser slot', 'webrtc', 'livekey702aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')").run();
    await d.prepare("INSERT INTO managed_streams (id, user_id, title, protocol, stream_key) OVERRIDING SYSTEM VALUE VALUES (703, 602, 'No subject', 'rtmp', 'livekey703aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')").run();
    await d.prepare("INSERT INTO managed_streams (id, user_id, title, protocol, stream_key, streaming_method) OVERRIDING SYSTEM VALUE VALUES (708, 601, 'WHIP encoder slot', 'webrtc', 'livekey708aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'whip')").run();
    await d.prepare("INSERT INTO managed_streams (id, user_id, title, protocol, stream_key, streaming_method) OVERRIDING SYSTEM VALUE VALUES (709, 601, 'JSMPEG slot', 'jsmpeg', 'livekey709aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'cli')").run();

    const authority = require('../server/openre/authority');
    const mirror = require('../server/openre/mirror');

    // ── Switch off ────────────────────────────────────────────
    const cols = (await d.prepare("SELECT column_name FROM information_schema.columns WHERE table_name = 'managed_streams'").all()).map(c => c.column_name);
    assert.ok(cols.includes('ingest_authority') && cols.includes('openre_stream_id'));
    assert.strictEqual((await db.getManagedStreamById(701)).ingest_authority, 'live', "every slot starts on 'live'");
    const slot701 = await db.getManagedStreamById(701);
    assert.strictEqual(authority.serializeSlot(slot701), slot701, 'the same object: responses unchanged');
    assert.strictEqual(await authority.refusesLiveIngest({ managedStream: slot701 }), false);
    assert.strictEqual(await authority.refusesLiveIngest({ managedStream: null, user: { id: 601 } }), false);
    // Even a slot marked 'openre' behaves as before while OpenRe is not configured.
    await d.prepare("UPDATE managed_streams SET ingest_authority = 'openre' WHERE id = 701").run();
    const marked = await db.getManagedStreamById(701);
    assert.strictEqual(authority.authorityOf(marked), 'live');
    assert.strictEqual(await authority.refusesLiveIngest({ managedStream: marked }), false);
    assert.strictEqual(authority.serializeSlot(marked), marked);
    assert.strictEqual(await authority.slotIsOpenre(701), false);
    assert.strictEqual(await mirror.hasLiveSession(1), false);
    assert.strictEqual(await mirror.ownsStream(1), false);
    assert.strictEqual(await mirror.reconcileOnce(), 0);
    await d.prepare("UPDATE managed_streams SET ingest_authority = 'live' WHERE id = 701").run();

    const express = require('express');
    const app = express();
    app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
    app.post('/internal/openre-events', mirror.webhookHandler);
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.strictEqual(await deliver(base, sessionEvent('started', SES(1), 2)), 503, 'inert without OPENRE_EVENTS_SECRET');

    // ── Configured, slot still on 'live' ─────────────────────
    await new Promise(r => stub.listen(0, '127.0.0.1', r));
    const stubUrl = `http://127.0.0.1:${stub.address().port}`;
    process.env.OPENRE_URL = stubUrl;
    process.env.OV_NETWORK_INTERNAL_URL = stubUrl;
    process.env.OV_OAUTH_CLIENT_SECRET = 'live-secret';
    process.env.OPENRE_EVENTS_SECRET = 'whsec_test';
    require('../server/openre/openre-client')._reset();
    assert.strictEqual(await authority.refusesLiveIngest({ managedStream: await db.getManagedStreamById(701) }), false);
    assert.strictEqual(await deliver(base, sessionEvent('started', SES(2), 2)), 204);
    assert.strictEqual((await d.prepare('SELECT COUNT(*) AS n FROM streams').get()).n, 0, 'a slot on live is never mirrored');

    // ── The switch ───────────────────────────────────────────
    assert.match((await authority.setAuthority(702, 'openre')).error || '', /Go Live page cannot publish to OpenRe/, 'a browser slot needs force');
    assert.strictEqual((await authority.setAuthority(703, 'openre')).status, 409, 'no canonical subject');
    const liveRow = await db.createStream({ user_id: 601, managed_stream_id: 701, title: 'on Live', protocol: 'rtmp' });
    assert.strictEqual((await authority.setAuthority(701, 'openre')).status, 409, 'refused while live on Live');
    await db.endStream(liveRow.lastInsertRowid);
    const flip = await authority.setAuthority(701, 'openre');
    assert.strictEqual(flip.status, 200, JSON.stringify(flip));
    assert.strictEqual(flip.body.openre_stream_id, 'std_01J0000000000000000000000S');
    const created = openreCalls.find(c => c.method === 'POST' && c.url === '/api/v1/streams');
    assert.strictEqual(created.subject, SUBJECT, 'created for the owner subject');
    assert.deepStrictEqual(created.body.external_refs.map(r => `${r.service}:${r.type}:${r.id}`), ['live:managed_stream:701', 'live:user:601']);
    assert.strictEqual(created.body.mirror_to_live, true);
    assert.deepStrictEqual(created.body.protocols, ['rtmp'], "the definition allows the slot's protocol");
    assert.strictEqual(flip.body.rtmp_url, 'rtmp://ingest.openre.stream:1936/live');
    const switched = await db.getManagedStreamById(701);
    assert.strictEqual(switched.ingest_authority, 'openre');
    assert.strictEqual(await db.getManagedStreamByStreamKey('livekey701aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), undefined, "Live's old key is rotated away");
    assert.strictEqual(await authority.refusesLiveIngest({ managedStream: switched }), true, "Live's RTMP refuses the slot");
    assert.strictEqual(await authority.refusesLiveIngest({ managedStream: switched, protocol: 'srt' }), false, 'only the protocols OpenRe carries are refused');
    assert.deepStrictEqual([...authority.OPENRE_PROTOCOLS], ['rtmp', 'webrtc', 'jsmpeg']);
    for (const protocol of ['rtmp', 'webrtc', 'jsmpeg']) {
        assert.strictEqual(await authority.refusesLiveIngest({ managedStream: switched, protocol }), true, `${protocol}: the slot key is refused`);
        assert.strictEqual(await authority.refusesLiveIngest({ managedStream: null, user: { id: 601 }, protocol }), true, `${protocol}: the owner's personal key is refused`);
        assert.strictEqual(await authority.refusesLiveIngest({ managedStream: await db.getManagedStreamById(703), protocol }), false, `${protocol}: a live slot is admitted`);
        assert.strictEqual(await authority.refusesLiveIngest({ managedStream: null, user: { id: 602 }, protocol }), false, `${protocol}: a personal key without an OpenRe slot is admitted`);
    }
    assert.strictEqual(await authority.refusesLiveIngest({ managedStream: null, user: { id: 602 } }), false, 'personal keys of users without an OpenRe slot stay on Live');
    assert.strictEqual(await authority.refusesLiveIngest({ managedStream: null, user: { id: 601 } }), true, 'a personal key cannot double-ingest a switched channel');
    const shown = authority.serializeSlot(switched);
    assert.strictEqual(shown.stream_key, null);
    assert.strictEqual(shown.stream_key_managed_by, 'openre');
    const ingest = await authority.ingestFor(switched, SUBJECT);
    assert.strictEqual(ingest.rtmp_url, 'rtmp://ingest.openre.stream:1936/live');
    assert.strictEqual(ingest.whip_url, null);
    assert.strictEqual(ingest.jsmpeg_url, null);
    assert.match(ingest.stream_key_hint, /…WXYZ/);
    const rotated = await authority.rotateFor(switched, SUBJECT);
    assert.strictEqual(rotated.stream_key, 'ork_newkey_shown_once');
    assert.strictEqual(rotated.rtmp_url, 'rtmp://ingest.openre.stream:1936/live');
    assert.strictEqual(openreCalls.filter(c => c.url.endsWith('/keys/rotate')).pop().subject, SUBJECT);

    // A WHIP encoder slot: its definition is created for WebRTC, the Go Live helpers give OpenRe's WHIP URL.
    const whipFlip = await authority.setAuthority(708, 'openre');
    assert.strictEqual(whipFlip.status, 200, JSON.stringify(whipFlip));
    assert.deepStrictEqual(openreCalls.filter(c => c.method === 'POST' && c.url === '/api/v1/streams').pop().body.protocols, ['webrtc']);
    assert.strictEqual(whipFlip.body.whip_url, 'https://ingest.openre.stream/whip');
    const whipIngest = await authority.ingestFor(await db.getManagedStreamById(708), SUBJECT);
    assert.deepStrictEqual([whipIngest.rtmp_url, whipIngest.whip_url, whipIngest.jsmpeg_url], [null, 'https://ingest.openre.stream/whip', null]);
    assert.match(whipIngest.stream_key_hint, /…WXYZ/);
    assert.strictEqual((await authority.rotateFor(await db.getManagedStreamById(708), SUBJECT)).whip_url, 'https://ingest.openre.stream/whip');
    // A JSMPEG slot whose OpenRe definition already exists (RTMP only, OpenRe's default): JSMPEG is added to it.
    openreDefs.std_slot709 = { id: 'std_slot709', ref: 'live:managed_stream:709', protocols: ['rtmp'] };
    const jsmpegFlip = await authority.setAuthority(709, 'openre');
    assert.strictEqual(jsmpegFlip.status, 200, JSON.stringify(jsmpegFlip));
    const patched = openreCalls.filter(c => c.method === 'PATCH').pop();
    assert.strictEqual(patched.url, '/api/v1/streams/std_slot709');
    assert.strictEqual(patched.subject, SUBJECT);
    assert.deepStrictEqual(patched.body, { protocols: ['rtmp', 'jsmpeg'] });
    assert.strictEqual(jsmpegFlip.body.jsmpeg_url, 'http://ingest.openre.stream:8081');
    assert.strictEqual((await authority.ingestFor(await db.getManagedStreamById(709), SUBJECT)).jsmpeg_url, 'http://ingest.openre.stream:8081');

    // ── Mirror ────────────────────────────────────────────────
    assert.strictEqual(await deliver(base, sessionEvent('started', SES(3), 2), { headers: { 'X-OpenVibe-Signature': 'sha256=00', 'X-OpenVibe-Timestamp': '1', 'X-OpenVibe-Signature-V2': 't=1,v2=00' } }), 401, 'bad signature');
    assert.strictEqual(await deliver(base, sessionEvent('started', SES(3), 2), { v1Only: true }), 401, 'v1 only (no v2 header): refused');
    assert.strictEqual(await deliver(base, sessionEvent('started', SES(3), 2), { now: Date.now() - 301000 }), 401, 'stale v2 (outside the 300 s window): refused');
    assert.strictEqual(await deliver(base, sessionEvent('started', SES(3), 2, { mirror_to_live: false })), 204);
    assert.strictEqual((await d.prepare('SELECT COUNT(*) AS n FROM streams WHERE is_live = 1').get()).n, 0, 'no consent, no mirror');

    const started = sessionEvent('started', SES(4), 2);
    assert.strictEqual(await deliver(base, started), 204);
    assert.strictEqual(await deliver(base, started), 204, 'redelivery');
    const rows = await d.prepare('SELECT * FROM streams WHERE is_live = 1').all();
    assert.strictEqual(rows.length, 1, 'exactly one live row');
    assert.strictEqual(rows[0].protocol, 'rtmp');
    assert.strictEqual(rows[0].managed_stream_id, 701);
    assert.strictEqual(rows[0].user_id, 601);
    const streamId = rows[0].id;
    assert.strictEqual((await mirror.sessionForStream(streamId)).session_id, SES(4));
    assert.strictEqual(await mirror.hasLiveSession(streamId), true, 'stale cleanup leaves it alone');
    assert.strictEqual(await mirror.ownsStream(streamId), true, 'Live does not resume its own restreams for it');

    // Reconcile: OpenRe says live → heartbeat refreshed; says ended → row ended.
    openreSessions[SES(4)] = { id: SES(4), state: 'live', revision: 2 };
    await d.prepare("UPDATE streams SET last_heartbeat = datetime('now', '-10 minutes') WHERE id = ?").run(streamId);
    await mirror.reconcileOnce();
    assert.ok((await d.prepare("SELECT last_heartbeat > datetime('now', '-1 minute') AS fresh FROM streams WHERE id = ?").get(streamId)).fresh);
    openreSessions[SES(4)] = { id: SES(4), state: 'ended', revision: 4, ended_at: new Date().toISOString() };
    await mirror.reconcileOnce();
    assert.strictEqual((await db.getStreamById(streamId)).is_live, 0);
    // The ended event arriving afterwards changes nothing (revision guard).
    assert.strictEqual(await deliver(base, sessionEvent('ended', SES(4), 4)), 204);

    // Out of order: ended (rev 4) before started (rev 2) never creates a live row.
    assert.strictEqual(await deliver(base, sessionEvent('ended', SES(5), 4)), 204);
    assert.strictEqual(await deliver(base, sessionEvent('started', SES(5), 2)), 204);
    assert.strictEqual((await d.prepare('SELECT COUNT(*) AS n FROM streams WHERE is_live = 1').get()).n, 0);

    // A normal started → failed pair.
    assert.strictEqual(await deliver(base, sessionEvent('started', SES(6), 2)), 204);
    const s6 = (await d.prepare('SELECT id FROM streams WHERE is_live = 1').get()).id;
    assert.strictEqual(await deliver(base, sessionEvent('failed', SES(6), 3, { failure_reason: 'worker_lost' })), 204);
    assert.strictEqual((await db.getStreamById(s6)).is_live, 0);

    // Live ends a mirrored row itself (End Stream): reconcile stops tracking it.
    assert.strictEqual(await deliver(base, sessionEvent('started', SES(7), 2)), 204);
    const s7 = (await d.prepare('SELECT id FROM streams WHERE is_live = 1').get()).id;
    openreSessions[SES(7)] = { id: SES(7), state: 'live', revision: 2 };
    await db.endStream(s7);
    await mirror.reconcileOnce();
    assert.strictEqual((await d.prepare('SELECT state FROM openre_sessions WHERE session_id = ?').get(SES(7))).state, 'detached');
    assert.strictEqual(await mirror.hasLiveSession(s7), false);
    // A signed event without an id is acknowledged, not retried forever.
    const noId = sessionEvent('started', SES(8), 2);
    delete noId.event_id;
    assert.strictEqual(await deliver(base, noId), 204);

    // ── WHIP and JSMPEG publishers ───────────────────────────
    await d.prepare("INSERT INTO users (id, username, display_name, password_hash, stream_key) OVERRIDING SYSTEM VALUE VALUES (603, 'browsercaster', 'BrowserCaster', 'x', 'personalkey603')").run();
    const whipKey = () => {
        let key;
        do { key = crypto.randomBytes(16).toString('hex'); } while (!/[a-f]/.test(key));
        return key;
    };
    const openReWhipKey = whipKey();
    const liveWhipKey = whipKey();
    await d.prepare("INSERT INTO managed_streams (id, user_id, title, protocol, stream_key, ingest_authority) OVERRIDING SYSTEM VALUE VALUES (704, 603, 'WHIP on OpenRe', 'webrtc', ?, 'openre')").run(openReWhipKey);
    await d.prepare("INSERT INTO managed_streams (id, user_id, title, protocol, stream_key) OVERRIDING SYSTEM VALUE VALUES (705, 602, 'WHIP on Live', 'webrtc', ?)").run(liveWhipKey);
    await d.prepare("INSERT INTO managed_streams (id, user_id, title, protocol, stream_key, ingest_authority) OVERRIDING SYSTEM VALUE VALUES (706, 603, 'JSMPEG on OpenRe', 'jsmpeg', 'jsmpegopenre706', 'openre')").run();
    await d.prepare("INSERT INTO managed_streams (id, user_id, title, protocol, stream_key) OVERRIDING SYSTEM VALUE VALUES (707, 602, 'JSMPEG on Live', 'jsmpeg', 'jsmpeglive707')").run();
    process.env.OPENRE_URL = stubUrl;
    require('../server/openre/openre-client')._reset();
    const whip = require('../server/streaming/whip-handler');
    const publish = async (id, { bearer, key } = {}) => {
        const out = {};
        const res = { status(c) { out.status = c; return this; }, set(k, v) { out[String(k).toLowerCase()] = v; return this; }, json(b) { out.body = b; return this; } };
        const req = { params: { streamId: String(id) }, headers: bearer ? { authorization: `Bearer ${bearer}` } : {}, query: key ? { key } : {}, body: 'v=0\r\n' };
        await whip.handleWhipPost(req, res);
        return out;
    };
    const streamCount = async () => (await d.prepare('SELECT COUNT(*) AS n FROM streams').get()).n;
    const before = await streamCount();
    for (const [label, call] of [
        ['key in the path', () => publish(openReWhipKey)],
        ['slot id + key', () => publish(704, { key: openReWhipKey })],
    ]) {
        const r = await call();
        assert.strictEqual(r.status, 401, `WHIP ${label} on an OpenRe slot is refused`);
        assert.ok(!/openre/i.test(JSON.stringify(r.body)), 'the refusal does not say OpenRe exists');
    }
    assert.strictEqual(await streamCount(), before, 'a refused WHIP publish creates no stream row');
    const admitted = await publish(liveWhipKey);
    assert.notStrictEqual(admitted.status, 401, 'a Live slot is still admitted (here it reaches the SFU check)');
    for (const r of [admitted, await publish(705, { key: liveWhipKey })]) assert.ok([200, 201, 503].includes(r.status), `live slot: ${r.status}`);
    // The switch landing between publishes: the next check refuses.
    await d.prepare("UPDATE managed_streams SET ingest_authority = 'openre' WHERE id = 705").run();
    assert.strictEqual((await publish(liveWhipKey)).status, 401, 'refused as soon as the slot is on OpenRe');
    await d.prepare("UPDATE managed_streams SET ingest_authority = 'live' WHERE id = 705").run();

    // The Go Live page's in-browser broadcaster (/ws/broadcast, role=broadcaster) is WebRTC ingest too.
    const broadcastServer = require('../server/streaming/broadcast-server');
    const connectBroadcaster = async (streamId, token) => {
        const closed = [];
        const ws = { readyState: 1, on() {}, send() {}, ping() {}, close(code, reason) { closed.push([code, reason]); } };
        try {
            await broadcastServer.handleConnection(ws, { url: `/ws/broadcast?streamId=${streamId}&role=broadcaster&token=${token}`, headers: {}, socket: {} });
        } catch { /* past the ingest checks: the SFU is not running here */ }
        broadcastServer.clients.delete(ws);
        broadcastServer.rooms.clear();
        return closed;
    };
    const browserOnOpenre = Number((await db.createStream({ user_id: 603, managed_stream_id: 704, title: 'browser', protocol: 'webrtc' })).lastInsertRowid);
    const browserOnLive = Number((await db.createStream({ user_id: 602, managed_stream_id: 705, title: 'browser', protocol: 'webrtc' })).lastInsertRowid);
    const browserPersonal = Number((await db.createStream({ user_id: 603, title: 'browser', protocol: 'webrtc' })).lastInsertRowid);
    assert.deepStrictEqual(await connectBroadcaster(browserOnOpenre, 'tok-603'), [[4003, 'Stream key not recognized']], 'browser broadcaster on an OpenRe slot is refused');
    assert.deepStrictEqual(await connectBroadcaster(browserPersonal, 'tok-603'), [[4003, 'Stream key not recognized']], 'a slot-less stream of an owner with an OpenRe slot is refused');
    assert.deepStrictEqual(await connectBroadcaster(browserOnLive, 'tok-602'), [], 'browser broadcaster on a Live slot is admitted');

    const relay = require('../server/streaming/jsmpeg-relay');
    relay.nextVideoPort = 29710 + (process.pid % 1000) * 4;
    relay.nextAudioPort = relay.nextVideoPort + 1;
    const post = (port, key) => new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/${key}`, agent: false }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        r.on('error', reject);
        r.end(Buffer.from('mpeg'));
    });
    const openreCh = relay.createChannel('jsmpegopenre706');
    const liveCh = relay.createChannel('jsmpeglive707');
    const personalCh = relay.createChannel('personalkey601');
    await new Promise(r => setTimeout(r, 200));
    assert.strictEqual(await post(openreCh.videoPort, 'jsmpegopenre706'), 404, 'JSMPEG video: an OpenRe slot key is refused');
    assert.strictEqual(await post(openreCh.audioPort, 'jsmpegopenre706'), 404, 'JSMPEG audio: an OpenRe slot key is refused');
    assert.strictEqual(await post(personalCh.videoPort, 'personalkey601'), 404, "JSMPEG: the owner's personal key is refused while a slot is on OpenRe");
    assert.strictEqual(await post(liveCh.videoPort, 'jsmpeglive707'), 200, 'JSMPEG: a Live slot is admitted');
    assert.strictEqual(await post(liveCh.audioPort, 'jsmpeglive707'), 200);

    // OPENRE_URL unset: nothing is refused, for any protocol.
    delete process.env.OPENRE_URL;
    for (const protocol of ['rtmp', 'webrtc', 'jsmpeg']) {
        assert.strictEqual(await authority.refusesLiveIngest({ managedStream: await db.getManagedStreamById(704), protocol }), false);
        assert.strictEqual(await authority.refusesLiveIngest({ managedStream: null, user: { id: 603 }, protocol }), false);
    }
    assert.notStrictEqual((await publish(openReWhipKey)).status, 401, 'without OPENRE_URL the WHIP slot is admitted again');
    assert.deepStrictEqual(await connectBroadcaster(browserOnOpenre, 'tok-603'), [], 'without OPENRE_URL the browser broadcaster is admitted again');
    assert.strictEqual(await post(openreCh.videoPort, 'jsmpegopenre706'), 200, 'without OPENRE_URL the JSMPEG slot is admitted again');
    assert.strictEqual(await post(personalCh.videoPort, 'personalkey601'), 200, 'without OPENRE_URL the personal JSMPEG key is admitted again');
    relay.closeAll();
    process.env.OPENRE_URL = stubUrl;
    require('../server/openre/openre-client')._reset();

    // The admin status lists the protocols OpenRe carries.
    const statusApp = express();
    // routes.js takes requireAdmin at load: admit the test caller before the router is first required.
    require('../server/auth/auth').requireAdmin = (req, res, next) => { req.user = { id: 1, username: 'admin', role: 'admin' }; next(); };
    statusApp.use('/api/admin/openre', require('../server/openre/routes'));
    const statusServer = await new Promise(r => { const s = statusApp.listen(0, '127.0.0.1', () => r(s)); });
    const statusRes = await fetch(`http://127.0.0.1:${statusServer.address().port}/api/admin/openre/status`);
    if (statusRes.status === 200) assert.deepStrictEqual((await statusRes.json()).protocols, ['rtmp', 'webrtc', 'jsmpeg']);
    else assert.fail(`status route answered ${statusRes.status}`);
    statusServer.close();

    // The Go Live profile and endpoint of an OpenRe WHIP/JSMPEG slot point at OpenRe, never at Live's
    // WHIP base or relay (Live refuses those publishes).
    require('../server/auth/auth').requireAuth = async (req, res, next) => { req.user = await db.getUserById(601); next(); };
    const streamsApp = express();
    streamsApp.use('/api/streams', require('../server/streaming/routes'));
    const streamsServer = await new Promise(r => { const s = streamsApp.listen(0, '127.0.0.1', () => r(s)); });
    const streamsBase = `http://127.0.0.1:${streamsServer.address().port}/api/streams`;
    const whipProfile = await (await fetch(`${streamsBase}/managed/708/profile`)).json();
    assert.deepStrictEqual([whipProfile.stream_key, whipProfile.whip_url_base, whipProfile.whip_url], [null, null, 'https://ingest.openre.stream/whip'], JSON.stringify(whipProfile));
    const jsmpegProfile = await (await fetch(`${streamsBase}/managed/709/profile`)).json();
    assert.deepStrictEqual([jsmpegProfile.stream_key, jsmpegProfile.whip_url_base, jsmpegProfile.jsmpeg_url], [null, null, 'http://ingest.openre.stream:8081'], JSON.stringify(jsmpegProfile));
    const whipStreamId = Number((await db.createStream({ user_id: 601, managed_stream_id: 708, title: 'w', protocol: 'webrtc' })).lastInsertRowid);
    const jsmpegStreamId = Number((await db.createStream({ user_id: 601, managed_stream_id: 709, title: 'j', protocol: 'jsmpeg' })).lastInsertRowid);
    const whipEndpoint = await (await fetch(`${streamsBase}/${whipStreamId}/endpoint`)).json();
    assert.deepStrictEqual([whipEndpoint.stream_key, whipEndpoint.endpoint.whipUrl, whipEndpoint.endpoint.whipUrlBase], [null, 'https://ingest.openre.stream/whip', undefined], JSON.stringify(whipEndpoint));
    const jsmpegEndpoint = await (await fetch(`${streamsBase}/${jsmpegStreamId}/endpoint`)).json();
    assert.deepStrictEqual([jsmpegEndpoint.stream_key, jsmpegEndpoint.endpoint.jsmpegUrl, jsmpegEndpoint.endpoint.videoPort], [null, 'http://ingest.openre.stream:8081', undefined], JSON.stringify(jsmpegEndpoint));
    streamsServer.close();

    // ── Rollback ─────────────────────────────────────────────
    assert.strictEqual((await authority.setAuthority(701, 'live')).status, 200);
    const back = await db.getManagedStreamById(701);
    assert.strictEqual(await authority.refusesLiveIngest({ managedStream: back }), false);
    assert.strictEqual(authority.serializeSlot(back), back);
    // Unsetting OPENRE_URL is the emergency rollback for every switched slot at once.
    await authority.setAuthority(701, 'openre');
    delete process.env.OPENRE_URL;
    assert.strictEqual(await authority.refusesLiveIngest({ managedStream: await db.getManagedStreamById(701) }), false);

    mirror._reset();
    server.close();
    stub.close();
    console.log('✅ openre switch: off = unchanged, switch/rotation, RTMP/WHIP/browser/JSMPEG refusal, OpenRe ingest URLs, signed mirror (once, ordered), reconcile, rollback');
})().catch((err) => { console.error(err); process.exit(1); });
