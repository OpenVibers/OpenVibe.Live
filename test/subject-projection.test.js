'use strict';
// Live's subject_projection from Network's network.user.updated (WS-B task 2, Contracts 0.43.0): signed
// deliveries through POST /internal/network-events; the linked account follows the role both ways (a
// downgrade too), picture, colour, display name and username (with /@old kept); an older revision changes
// nothing; the local owner keeps admin; a Network ban never touches Live's own ban; someone with no Live
// account is projected only; a bad payload is ignored; the subscribe script asks for the topic.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-live-subjproj-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.NODE_ENV = 'test';
process.env.LIVE_EVENTS_SECRET = 's'.repeat(40);
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

const express = require('express');
const { ids, validate } = require('openvibe-contracts');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const db = require('../server/db/database');
db.initDb();
const networkEvents = require('../server/auth/network-events');
const projection = require('../server/auth/subject-projection');
const { NETWORK_TOPICS } = require('../scripts/subscribe-media-events');

const ALEX = ids.newId('user'), OWNER = ids.newId('user'), GHOST = ids.newId('user');
const d = db.getDb();
d.prepare("INSERT INTO users (id, username, email, password_hash, role, display_name) VALUES (1, 'alex', NULL, '$sso$x', 'admin', 'Alex'), (2, 'boss', NULL, '$sso$y', 'admin', 'Boss')").run();
d.prepare('UPDATE users SET is_owner = 1 WHERE id = 2').run();
d.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, service_username, subject_id) VALUES (1, 'network', '7', 'alex', ?), (2, 'network', '1', 'boss', ?)").run(ALEX, OWNER);
const payload = (subject, nid, revision, over = {}) => ({ subject: { type: 'user', id: subject }, network_user_id: nid, revision, username: 'alex', display_name: 'Alex', avatar_url: null, profile_color: null, role: 'user', banned: false, changed: ['role'], ...over });
const envelope = (p) => ({ event_id: ids.newId('event'), event_type: 'network.user.updated', version: 1, source: 'network', actor: { type: 'service', id: 'network' },
    timestamp: new Date().toISOString(), visibility: 'internal', subject: { type: 'user', id: p.subject.id }, payload: p });

(async () => {
    const app = express();
    app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
    app.post('/internal/network-events', networkEvents.handler);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/internal/network-events`;
    const deliver = (p) => {
        const body = JSON.stringify({ event: envelope(p), seq: 1 });
        return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, process.env.LIVE_EVENTS_SECRET) }, body }).then((r) => r.status);
    };
    const user = (id) => db.getUserById(id);
    try {
        const p1 = payload(ALEX, 7, 3, { profile_color: '#22c55e', avatar_url: 'https://openvibe.media/avatar/alex', changed: ['role', 'profile_color', 'avatar_url'] });
        assert.ok(validate('network.user.updated@1', p1).valid, 'the payload matches the contract');
        assert.strictEqual(await deliver(p1), 204);
        assert.strictEqual(user(1).role, 'user', 'a downgrade applies (the token sync never downgrades)');
        assert.strictEqual(user(1).profile_color, '#22c55e');
        assert.strictEqual(projection.get(ALEX).revision, 3);

        assert.strictEqual(await deliver(payload(ALEX, 7, 2, { role: 'admin' })), 204);
        assert.strictEqual(user(1).role, 'user', 'an older revision changes nothing');
        assert.strictEqual(networkEvents.stats.unchanged, 1);

        assert.strictEqual(await deliver(payload(ALEX, 7, 4, { role: 'streamer', username: 'alex_new', changed: ['username', 'role'] })), 204);
        assert.strictEqual(user(1).role, 'streamer', 'an upgrade applies');
        assert.strictEqual(user(1).username, 'alex_new', 'the rename follows');

        // 'streamer' is Live's own: a Live streamer stays one whatever Network's role says.
        d.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (3, 'cam', '$sso$z', 'streamer')").run();
        const CAM = ids.newId('user');
        d.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, service_username, subject_id) VALUES (3, 'network', '30', 'cam', ?)").run(CAM);
        d.prepare("INSERT INTO streams (user_id, title, is_live) VALUES (3, 'first stream', 0)").run();
        assert.strictEqual(await deliver(payload(CAM, 30, 1, { username: 'cam', role: 'user', avatar_url: 'https://openvibe.media/avatar/cam', changed: ['avatar_url'] })), 204);
        assert.strictEqual(user(3).role, 'streamer', 'a profile event never lowers the role');
        assert.strictEqual(await deliver(payload(CAM, 30, 2, { username: 'cam', role: 'global_mod', changed: ['role'] })), 204);
        assert.strictEqual(user(3).role, 'global_mod', 'Network makes them staff');
        assert.strictEqual(await deliver(payload(CAM, 30, 3, { username: 'cam', role: 'user', changed: ['role'] })), 204);
        assert.strictEqual(user(3).role, 'streamer', 'staff removed by Network: someone who has streamed keeps streamer');
        assert.strictEqual(await deliver(payload(CAM, 30, 4, { username: 'cam', display_name: 'CAM', changed: ['display_name'] })), 204);
        assert.strictEqual(user(3).display_name, 'CAM', 'a re-cased display name follows');
        assert.strictEqual(await deliver(payload(CAM, 30, 5, { username: 'cam', display_name: 'Someone Else', changed: ['display_name'] })), 204);
        assert.strictEqual(user(3).display_name, 'CAM', "a display name that is not the username keeps Live's (Live only re-cases)");

        assert.strictEqual(await deliver(payload(ALEX, 7, 5, { username: 'alex_new', role: 'streamer', banned: true, changed: ['banned'] })), 204);
        assert.strictEqual(projection.get(ALEX).banned, 1);
        assert.ok(!user(1).is_banned, "a Network ban never sets Live's own ban");

        assert.strictEqual(await deliver(payload(OWNER, 1, 1, { username: 'boss', role: 'user', changed: ['role'] })), 204);
        assert.strictEqual(user(2).role, 'admin', 'the local owner keeps admin');

        assert.strictEqual(await deliver(payload(GHOST, 99, 1, { username: 'ghost' })), 204);
        assert.strictEqual(projection.get(GHOST).username, 'ghost', 'someone with no Live account is projected only');

        assert.strictEqual(await deliver(payload(ALEX, 7, 9, { role: 'owner' })), 204);
        assert.strictEqual(user(1).role, 'streamer', 'a bad payload is ignored');
        assert.ok(NETWORK_TOPICS.includes('network.user.updated'), 'the subscribe script asks for the topic');
    } finally {
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    quiet('subject projection: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
