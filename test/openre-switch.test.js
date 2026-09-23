'use strict';

// OpenRe ingest switch (roadmap Wave 7, ADR-009). With OPENRE_URL unset, or a slot on 'live' (the
// default), nothing changes. With a slot switched to 'openre': Live's RTMP refuses its key, the
// Go Live helpers show OpenRe's URL and rotate OpenRe's key, and OpenRe session events (signed
// Events deliveries, applied once, in revision order) become ordinary `streams` rows.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-openre-switch-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
delete process.env.OPENRE_URL;
delete process.env.OPENRE_EVENTS_SECRET;

const SUBJECT = 'usr_01J0000000000000000000000Q';
const SES = (n) => `ses_01J00000000000000000000${String(n).padStart(3, '0')}`.slice(0, 30);
const openreCalls = [];
let openreSessions = {};
let openreStreams = [];

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
        const stream = (id) => ({ id, ingest: { rtmp: { url: 'rtmp://ingest.openre.stream:1936/live', key_hint: 'WXYZ' } } });
        if (req.method === 'GET' && req.url.startsWith('/api/v1/streams?external_ref=')) return send(200, { streams: openreStreams });
        if (req.method === 'POST' && req.url === '/api/v1/streams') { openreStreams = [stream('std_01J0000000000000000000000S')]; return send(201, { stream: openreStreams[0], key: { key: 'ork_dropped' } }); }
        if (req.method === 'GET' && req.url.startsWith('/api/v1/streams/std_')) return send(200, { stream: stream(req.url.split('/').pop()) });
        if (req.method === 'POST' && req.url.endsWith('/keys/rotate')) return send(200, { key: { key: 'ork_newkey_shown_once' }, ingest: { rtmp: { url: 'rtmp://ingest.openre.stream:1936/live' } } });
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

/** POST a delivery: all three signature headers by default; `v1Only` sends only X-OpenVibe-Signature; `now` backdates the v2 timestamp. */
async function deliver(base, event, { secret = 'whsec_test', headers, v1Only = false, now } = {}) {
    const s = signed(event, secret, { now });
    const res = await fetch(`${base}/internal/openre-events`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || (v1Only ? s.v1 : s.headers)) }, body: s.raw });
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
    db.initDb();
    const d = db.getDb();
    d.prepare("INSERT INTO users (id, username, display_name, password_hash, stream_key) VALUES (601, 'caster', 'Caster', 'x', 'personalkey601')").run();
    d.prepare("INSERT INTO users (id, username, display_name, password_hash) VALUES (602, 'nosub', 'NoSub', 'x')").run();
    d.prepare(`INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (601, 'network', '91', '${SUBJECT}')`).run();
    d.prepare("INSERT INTO managed_streams (id, user_id, title, protocol, stream_key, streaming_method) VALUES (701, 601, 'OBS slot', 'rtmp', 'livekey701aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'obs')").run();
    d.prepare("INSERT INTO managed_streams (id, user_id, title, protocol, stream_key) VALUES (702, 601, 'Browser slot', 'webrtc', 'livekey702aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')").run();
    d.prepare("INSERT INTO managed_streams (id, user_id, title, protocol, stream_key) VALUES (703, 602, 'No subject', 'rtmp', 'livekey703aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')").run();

    const authority = require('../server/openre/authority');
    const mirror = require('../server/openre/mirror');

    // ── Switch off ────────────────────────────────────────────
    const cols = d.prepare('PRAGMA table_info(managed_streams)').all().map(c => c.name);
    assert.ok(cols.includes('ingest_authority') && cols.includes('openre_stream_id'));
    assert.strictEqual(db.getManagedStreamById(701).ingest_authority, 'live', "every slot starts on 'live'");
    const slot701 = db.getManagedStreamById(701);
    assert.strictEqual(authority.serializeSlot(slot701), slot701, 'the same object: responses unchanged');
    assert.strictEqual(authority.refusesLiveIngest({ managedStream: slot701 }), false);
    assert.strictEqual(authority.refusesLiveIngest({ managedStream: null, user: { id: 601 } }), false);
    // Even a slot marked 'openre' behaves as before while OpenRe is not configured.
    d.prepare("UPDATE managed_streams SET ingest_authority = 'openre' WHERE id = 701").run();
    const marked = db.getManagedStreamById(701);
    assert.strictEqual(authority.authorityOf(marked), 'live');
    assert.strictEqual(authority.refusesLiveIngest({ managedStream: marked }), false);
    assert.strictEqual(authority.serializeSlot(marked), marked);
    assert.strictEqual(authority.slotIsOpenre(701), false);
    assert.strictEqual(mirror.hasLiveSession(1), false);
    assert.strictEqual(mirror.ownsStream(1), false);
    assert.strictEqual(await mirror.reconcileOnce(), 0);
    d.prepare("UPDATE managed_streams SET ingest_authority = 'live' WHERE id = 701").run();

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
    assert.strictEqual(authority.refusesLiveIngest({ managedStream: db.getManagedStreamById(701) }), false);
    assert.strictEqual(await deliver(base, sessionEvent('started', SES(2), 2)), 204);
    assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM streams').get().n, 0, 'a slot on live is never mirrored');

    // ── The switch ───────────────────────────────────────────
    assert.strictEqual((await authority.setAuthority(702, 'openre')).status, 409, 'a browser slot needs force');
    assert.strictEqual((await authority.setAuthority(703, 'openre')).status, 409, 'no canonical subject');
    const liveRow = db.createStream({ user_id: 601, managed_stream_id: 701, title: 'on Live', protocol: 'rtmp' });
    assert.strictEqual((await authority.setAuthority(701, 'openre')).status, 409, 'refused while live on Live');
    db.endStream(liveRow.lastInsertRowid);
    const flip = await authority.setAuthority(701, 'openre');
    assert.strictEqual(flip.status, 200, JSON.stringify(flip));
    assert.strictEqual(flip.body.openre_stream_id, 'std_01J0000000000000000000000S');
    const created = openreCalls.find(c => c.method === 'POST' && c.url === '/api/v1/streams');
    assert.strictEqual(created.subject, SUBJECT, 'created for the owner subject');
    assert.deepStrictEqual(created.body.external_refs.map(r => `${r.service}:${r.type}:${r.id}`), ['live:managed_stream:701', 'live:user:601']);
    assert.strictEqual(created.body.mirror_to_live, true);
    const switched = db.getManagedStreamById(701);
    assert.strictEqual(switched.ingest_authority, 'openre');
    assert.strictEqual(db.getManagedStreamByStreamKey('livekey701aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), undefined, "Live's old key is rotated away");
    assert.strictEqual(authority.refusesLiveIngest({ managedStream: switched }), true, "Live's RTMP refuses the slot");
    assert.strictEqual(authority.refusesLiveIngest({ managedStream: switched, protocol: 'whip' }), false, 'only RTMP moved');
    assert.strictEqual(authority.refusesLiveIngest({ managedStream: null, user: { id: 602 } }), false, 'personal keys of users without an OpenRe slot stay on Live');
    assert.strictEqual(authority.refusesLiveIngest({ managedStream: null, user: { id: 601 } }), true, 'a personal key cannot double-ingest a switched channel');
    const shown = authority.serializeSlot(switched);
    assert.strictEqual(shown.stream_key, null);
    assert.strictEqual(shown.stream_key_managed_by, 'openre');
    const ingest = await authority.ingestFor(switched, SUBJECT);
    assert.strictEqual(ingest.rtmp_url, 'rtmp://ingest.openre.stream:1936/live');
    assert.match(ingest.stream_key_hint, /…WXYZ/);
    const rotated = await authority.rotateFor(switched, SUBJECT);
    assert.strictEqual(rotated.stream_key, 'ork_newkey_shown_once');
    assert.strictEqual(openreCalls.filter(c => c.url.endsWith('/keys/rotate')).pop().subject, SUBJECT);

    // ── Mirror ────────────────────────────────────────────────
    assert.strictEqual(await deliver(base, sessionEvent('started', SES(3), 2), { headers: { 'X-OpenVibe-Signature': 'sha256=00', 'X-OpenVibe-Timestamp': '1', 'X-OpenVibe-Signature-V2': 't=1,v2=00' } }), 401, 'bad signature');
    assert.strictEqual(await deliver(base, sessionEvent('started', SES(3), 2), { v1Only: true }), 401, 'v1 only (no v2 header): refused');
    assert.strictEqual(await deliver(base, sessionEvent('started', SES(3), 2), { now: Date.now() - 301000 }), 401, 'stale v2 (outside the 300 s window): refused');
    assert.strictEqual(await deliver(base, sessionEvent('started', SES(3), 2, { mirror_to_live: false })), 204);
    assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM streams WHERE is_live = 1').get().n, 0, 'no consent, no mirror');

    const started = sessionEvent('started', SES(4), 2);
    assert.strictEqual(await deliver(base, started), 204);
    assert.strictEqual(await deliver(base, started), 204, 'redelivery');
    const rows = d.prepare('SELECT * FROM streams WHERE is_live = 1').all();
    assert.strictEqual(rows.length, 1, 'exactly one live row');
    assert.strictEqual(rows[0].protocol, 'rtmp');
    assert.strictEqual(rows[0].managed_stream_id, 701);
    assert.strictEqual(rows[0].user_id, 601);
    const streamId = rows[0].id;
    assert.strictEqual(mirror.sessionForStream(streamId).session_id, SES(4));
    assert.strictEqual(mirror.hasLiveSession(streamId), true, 'stale cleanup leaves it alone');
    assert.strictEqual(mirror.ownsStream(streamId), true, 'Live does not resume its own restreams for it');

    // Reconcile: OpenRe says live → heartbeat refreshed; says ended → row ended.
    openreSessions[SES(4)] = { id: SES(4), state: 'live', revision: 2 };
    d.prepare("UPDATE streams SET last_heartbeat = datetime('now', '-10 minutes') WHERE id = ?").run(streamId);
    await mirror.reconcileOnce();
    assert.ok(d.prepare("SELECT last_heartbeat > datetime('now', '-1 minute') AS fresh FROM streams WHERE id = ?").get(streamId).fresh);
    openreSessions[SES(4)] = { id: SES(4), state: 'ended', revision: 4, ended_at: new Date().toISOString() };
    await mirror.reconcileOnce();
    assert.strictEqual(db.getStreamById(streamId).is_live, 0);
    // The ended event arriving afterwards changes nothing (revision guard).
    assert.strictEqual(await deliver(base, sessionEvent('ended', SES(4), 4)), 204);

    // Out of order: ended (rev 4) before started (rev 2) never creates a live row.
    assert.strictEqual(await deliver(base, sessionEvent('ended', SES(5), 4)), 204);
    assert.strictEqual(await deliver(base, sessionEvent('started', SES(5), 2)), 204);
    assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM streams WHERE is_live = 1').get().n, 0);

    // A normal started → failed pair.
    assert.strictEqual(await deliver(base, sessionEvent('started', SES(6), 2)), 204);
    const s6 = d.prepare('SELECT id FROM streams WHERE is_live = 1').get().id;
    assert.strictEqual(await deliver(base, sessionEvent('failed', SES(6), 3, { failure_reason: 'worker_lost' })), 204);
    assert.strictEqual(db.getStreamById(s6).is_live, 0);

    // Live ends a mirrored row itself (End Stream): reconcile stops tracking it.
    assert.strictEqual(await deliver(base, sessionEvent('started', SES(7), 2)), 204);
    const s7 = d.prepare('SELECT id FROM streams WHERE is_live = 1').get().id;
    openreSessions[SES(7)] = { id: SES(7), state: 'live', revision: 2 };
    db.endStream(s7);
    await mirror.reconcileOnce();
    assert.strictEqual(d.prepare('SELECT state FROM openre_sessions WHERE session_id = ?').get(SES(7)).state, 'detached');
    assert.strictEqual(mirror.hasLiveSession(s7), false);
    // A signed event without an id is acknowledged, not retried forever.
    const noId = sessionEvent('started', SES(8), 2);
    delete noId.event_id;
    assert.strictEqual(await deliver(base, noId), 204);

    // ── Rollback ─────────────────────────────────────────────
    assert.strictEqual((await authority.setAuthority(701, 'live')).status, 200);
    const back = db.getManagedStreamById(701);
    assert.strictEqual(authority.refusesLiveIngest({ managedStream: back }), false);
    assert.strictEqual(authority.serializeSlot(back), back);
    // Unsetting OPENRE_URL is the emergency rollback for every switched slot at once.
    await authority.setAuthority(701, 'openre');
    delete process.env.OPENRE_URL;
    assert.strictEqual(authority.refusesLiveIngest({ managedStream: db.getManagedStreamById(701) }), false);

    mirror._reset();
    server.close();
    stub.close();
    console.log('✅ openre switch: off = unchanged, switch/rotation, RTMP refusal, signed mirror (once, ordered), reconcile, rollback');
})().catch((err) => { console.error(err); process.exit(1); });
