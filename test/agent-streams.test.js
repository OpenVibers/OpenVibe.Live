'use strict';
/**
 * Agent streams, Live's part (Agent Streams S1, design 2026-11-06).
 *
 *   - an agent stream does not take one of the person's normal slots;
 *   - no route ever answers a stream_key for one (it has none, and the serializer would strip it anyway);
 *   - a private stream's join needs a view ticket: the owner gets one, a stranger does not, a person it is shared with
 *     does (the sharing system's own rows, service live, kind agent-stream);
 *   - an unlisted link works until it is rotated;
 *   - the curtain pauses the SFU consumers and resuming un-pauses exactly those;
 *   - the embed's frame-ancestors is the first-party list, never *;
 *   - the state the desk polls says whether to encode.
 *
 * Sign-in is stubbed with an x-test-user header (as authorization.test.js does); everything after that is production.
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-agent-dock-'));
const dockKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
fs.writeFileSync(path.join(keyDir, 'network.pem'), dockKeys.publicKey);
process.env.OV_NETWORK_PUBLIC_KEY = path.join(keyDir, 'network.pem');
process.env.OV_NETWORK_URL = 'https://openvibe.network';

process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};
console.error = () => {};

const SID = {
    ann: 'usr_01JAB2C3D4E5F6G7H8J9K0MNA1',
    bob: 'usr_01JAB2C3D4E5F6G7H8J9K0MNB2',
    cat: 'usr_01JAB2C3D4E5F6G7H8J9K0MNC3',
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
    await addUser(3, 'cat', 'user');
    await addUser(4, 'slash', 'admin', { is_owner: 1 });
    const link = async (uid, sid) => await raw.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (?, 'network', ?, ?)").run(uid, String(100 + uid), sid);
    await link(1, SID.ann); await link(2, SID.bob); await link(3, SID.cat); await link(4, SID.ann.replace('A1', 'D4'));

    const service = require('../server/agent-streams/service');
    const tickets = require('../server/agent-streams/tickets');
    const curtains = require('../server/streaming/curtains');
    const serializers = require('../server/web/serializers');
    const webrtcSFU = require('../server/streaming/webrtc-sfu');
    const sharing = require('../server/agent-streams/sharing');
    // The sharing system asks Network who a subject is; in this test Network is the four accounts above.
    sharing._setNetwork({
        json: async ({ path, query, json }) => {
            if (path === '/internal/identity/resolve-batch') {
                const results = {};
                for (const id of (json && json.subject_ids) || []) {
                    const username = id === SID.bob ? 'bob' : id === SID.cat ? 'cat' : 'ann';
                    results[id] = { subject: { type: 'user', id }, username, display_name: username, avatar_url: null };
                }
                return { results };
            }
            if (path === '/internal/identity/resolve') {
                const username = query && query.username;
                const id = username === 'bob' ? SID.bob : username === 'cat' ? SID.cat : SID.ann;
                return { subject: { type: 'user', id }, username, display_name: username, avatar_url: null };
            }
            return {};
        },
    });
    // The addresses the contract names (production's), not the test's localhost defaults.
    const config = require('../server/config');
    config.baseUrl = 'https://openvibe.live';
    config.whip = { ...(config.whip || {}), publicUrl: 'https://whip.openvibe.live' };
    const ann = await db.getUserById(1);
    const bob = await db.getUserById(2);
    const cat = await db.getUserById(3);

    const agent = await service.create({
        user: ann,
        title: 'Fixing the auth bug',
        task: { source: 'codes', ref: 'tsk_1', title: 'Fix auth', url: 'https://openvibe.codes/tasks/1' },
        visibility: 'private',
    });

    quiet('agent streams: the slot');
    await check('an agent stream does not take a normal slot', async () => {
        const normal = await db.createManagedStream({ user_id: 1, channel_id: null, slug: 'main', title: 'Main', protocol: 'webrtc', stream_key: 'a'.repeat(40) });
        assert.ok(normal.lastInsertRowid);
        assert.strictEqual(await db.countManagedStreamsByUser(1), 1, 'only the normal slot counts');
        const listed = await db.getManagedStreamsByUserId(1);
        assert.deepStrictEqual(listed.map((s) => s.kind), ['normal'], 'the dashboard lists normal slots only');
    });
    await check('an agent row has no stream key anywhere in the database', async () => {
        const row = await db.get('SELECT stream_key, kind, public_id FROM managed_streams WHERE id = ?', [agent.managed_stream_id]);
        assert.strictEqual(row.kind, 'agent');
        assert.strictEqual(row.stream_key, null);
        assert.match(row.public_id, /^ags_[0-9A-HJKMNP-TV-Z]{26}$/);
    });

    // ── The API ─────────────────────────────────────────────────
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = { 1: ann, 2: bob, 3: cat }[req.get('x-test-user')] || null; next(); });
    app.use('/api/streams/agent', require('../server/agent-streams/routes'));
    // The sharing system's own router, as server/index.js mounts it (the Share sheet's access part).
    const shareRouter = sharing.router({
        authenticate: async (req) => {
            const user = { 1: ann, 2: bob, 3: cat }[req.get('x-test-user')] || null;
            if (!user) return null;
            const subject = await require('../server/agent-streams/auth').viewerSubject(user);
            return subject ? { subject: { type: 'user', id: subject }, staff: false } : null;
        },
        describe: async () => ({}),
    });
    if (shareRouter) app.use(shareRouter);
    const server = await new Promise((ok) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => ok(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, { as = 1, body, headers = {} } = {}) => {
        const res = await fetch(`${base}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json', 'x-test-user': String(as), ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        let data; try { data = JSON.parse(text); } catch { data = text; }
        return { status: res.status, data, headers: res.headers };
    };

    const dockToken = (overrides = {}) => jwt.sign({ sub: '1', username: 'ann', subject_id: SID.ann,
        client_id: 'companion', fam: `fam_${'a'.repeat(24)}`, scope: 'agent.view', ...overrides }, dockKeys.privateKey,
    { algorithm: 'RS256', issuer: 'https://openvibe.network/dock', audience: 'openvibe.network', expiresIn: 600 });

    try {
        await check('Companion Dock token reads its own stream and mints a view ticket, but cannot control it', async () => {
            const headers = { authorization: `Bearer ${dockToken()}` };
            const mine = await call('GET', '/api/streams/agent/mine', { as: 0, headers });
            assert.equal(mine.status, 200);
            assert.ok(mine.data.streams.some((s) => s.id === agent.public_id));
            const ticket = await call('POST', `/api/streams/agent/${agent.public_id}/view-ticket`, { as: 0, headers, body: {} });
            assert.equal(ticket.status, 200);
            assert.ok(ticket.data.ticket || ticket.data.view_ticket);
            const control = await call('POST', `/api/streams/agent/${agent.public_id}/control`, { as: 0, headers, body: { control: 'pause' } });
            assert.notEqual(control.status, 200);
            for (const claims of [{ scope: 'profile' }, { client_id: 'other' }, { subject_id: SID.bob }]) {
                const denied = await call('GET', '/api/streams/agent/mine', { as: 0, headers: { authorization: `Bearer ${dockToken(claims)}` } });
                assert.ok(!denied.data.streams.some((s) => s.id === agent.public_id));
            }
        });
        quiet('agent streams: the resources');
        await check('the owner reads the resource, with no stream key and nothing secret', async () => {
            const r = await call('GET', `/api/streams/agent/${agent.public_id}`, { as: 1 });
            assert.strictEqual(r.status, 200);
            assert.deepStrictEqual(serializers.findSecrets(r.data), [], 'no secret leaf in the answer');
            assert.strictEqual(r.data.can_manage, true);
            assert.strictEqual(r.data.stream.id, agent.public_id);
            assert.strictEqual(r.data.stream.owner, SID.ann);
            assert.strictEqual(r.data.stream.channel, 'ann');
            assert.strictEqual(r.data.stream.label, 'AI agent');
            assert.strictEqual(r.data.stream.visibility, 'private');
            assert.strictEqual(r.data.stream.state, 'idle');
            assert.ok(r.data.view_ticket && /^wvt_/.test(r.data.view_ticket));
            assert.match(r.data.stream.page_url, /^https:\/\/openvibe\.live\/@ann\/agents\/ags_/);
        });
        await check('nobody else can read a private stream, nor get a view ticket', async () => {
            const read = await call('GET', `/api/streams/agent/${agent.public_id}`, { as: 2 });
            assert.strictEqual(read.status, 404);
            const mint = await call('POST', `/api/streams/agent/${agent.public_id}/view-ticket`, { as: 2, body: {} });
            assert.strictEqual(mint.status, 403);
            const anon = await call('GET', `/api/streams/agent/${agent.public_id}`, { as: 0 });
            assert.strictEqual(anon.status, 404);
        });
        await check('only the person\'s own streams are listed, the live one first, and no ticket comes with them', async () => {
            // A second stream of ann's, live, so the list has to put it first and the filter has something to keep.
            const second = await service.create({
                user: ann, title: 'Second desk', task: { source: 'desk', ref: 'desk_2', title: 'Second' }, visibility: 'private',
            });
            await raw.prepare("UPDATE agent_streams SET state = 'live', started_at = now() WHERE managed_stream_id = ?").run(second.managed_stream_id);

            const mine = await call('GET', '/api/streams/agent/mine', { as: 1 });
            assert.strictEqual(mine.status, 200, JSON.stringify(mine.data));
            assert.deepStrictEqual(mine.data.streams.map((s) => s.id), [second.public_id, agent.public_id], 'live first, then the newest');
            for (const s of mine.data.streams) {
                assert.match(s.id, /^ags_/);
                assert.deepStrictEqual(serializers.findSecrets(s), [], 'nothing secret in a listed stream');
            }
            assert.ok(!JSON.stringify(mine.data).includes('wvt_'), 'the list mints no view ticket');
            assert.ok(!JSON.stringify(mine.data).includes('wpt_'), 'and no publish ticket');

            const live = await call('GET', '/api/streams/agent/mine?live=1', { as: 1 });
            assert.deepStrictEqual(live.data.streams.map((s) => s.id), [second.public_id], '?live=1 keeps the live one only');

            const theirs = await call('GET', '/api/streams/agent/mine', { as: 2 });
            assert.deepStrictEqual(theirs.data.streams, [], 'nobody else\'s streams, not even an empty-looking one of theirs');
            const anon = await call('GET', '/api/streams/agent/mine', { as: 0 });
            assert.deepStrictEqual(anon.data.streams, [], 'no session, nothing');
            // Back to ended: the rest of the file is about one stream, and a live one would take ann's slot.
            await raw.prepare("UPDATE agent_streams SET state = 'ended', ended_at = now() WHERE managed_stream_id = ?").run(second.managed_stream_id);
        });
        await check('a person the stream is shared with can read it and gets a view ticket', async () => {
            assert.ok(sharing.available(), 'the pinned openvibe-sdk has sharing');
            // Through the public surface the Share sheet uses: the owner makes it people-only and adds bob.
            const put = await call('PUT', `/api/v1/agent-stream/${agent.public_id}/share`, {
                as: 1,
                body: { audience: 'people', members: [{ subject: { type: 'user', id: SID.bob }, role: 'viewer' }] },
                headers: { 'sec-fetch-site': 'same-origin' },
            });
            assert.strictEqual(put.status, 200, `share PUT answered ${put.status} ${JSON.stringify(put.data)}`);
            assert.strictEqual(put.data.audience, 'people');
            const read = await call('GET', `/api/streams/agent/${agent.public_id}`, { as: 2 });
            assert.strictEqual(read.status, 200, 'bob reads it');
            assert.ok(read.data.view_ticket, 'and gets a view ticket');
            const anon = await call('POST', `/api/streams/agent/${agent.public_id}/view-ticket`, { as: 3, body: {} });
            assert.strictEqual(anon.status, 403, 'cat still cannot');
        });
        await check('an unlisted link works until it is rotated', async () => {
            const put = await call('PUT', `/api/streams/agent/${agent.public_id}/visibility`, { as: 1, body: { visibility: 'unlisted' } });
            assert.strictEqual(put.status, 200);
            const link = put.data.stream.page_url;
            assert.match(link, /\?k=[A-Za-z0-9_-]{22}$/);
            const k = new URL(link).searchParams.get('k');
            const withLink = await call('GET', `/api/streams/agent/${agent.public_id}?k=${encodeURIComponent(k)}`, { as: 3 });
            assert.strictEqual(withLink.status, 200, 'anyone with the link reads it');
            assert.strictEqual(withLink.data.can_manage, false);
            const mint = await call('POST', `/api/streams/agent/${agent.public_id}/view-ticket`, { as: 3, body: { k } });
            assert.strictEqual(mint.status, 200);
            const rotated = await call('POST', `/api/streams/agent/${agent.public_id}/rotate-link`, { as: 1, body: {} });
            assert.strictEqual(rotated.status, 200);
            const old = await call('GET', `/api/streams/agent/${agent.public_id}?k=${encodeURIComponent(k)}`, { as: 3 });
            assert.strictEqual(old.status, 404, 'the old link is closed');
            const freshK = new URL(rotated.data.stream.page_url).searchParams.get('k');
            assert.notStrictEqual(freshK, k, 'the new link is a new secret');
            const fresh = await call('GET', `/api/streams/agent/${agent.public_id}?k=${encodeURIComponent(freshK)}`, { as: 3 });
            assert.strictEqual(fresh.status, 200, 'the new link works');
        });
        await check('the resource never carries a stream key, on any answer', async () => {
            for (const [method, path, opts] of [
                ['GET', `/api/streams/agent/${agent.public_id}`, { as: 1 }],
                ['POST', `/api/streams/agent/${agent.public_id}/ticket`, { as: 1, body: {} }],
                ['GET', `/api/streams/agent/${agent.public_id}/state`, { as: 1 }],
            ]) {
                const r = await call(method, path, opts);
                assert.deepStrictEqual(serializers.findSecrets(r.data), [], `${method} ${path}`);
                assert.ok(!JSON.stringify(r.data).includes('stream_key'));
            }
        });
        await check('the desk\'s state says whether to encode, and ends when the ticket does', async () => {
            const created = await call('POST', '/api/streams/agent', {
                as: 1,
                body: { title: 'Second', task: { source: 'desk', ref: 'd1', title: 'Work' }, visibility: 'private' },
            });
            assert.strictEqual(created.status, 201);
            const { stream, publish } = created.data;
            assert.match(publish.ticket, /^wpt_[A-Za-z0-9_-]{43}$/);
            assert.match(publish.whip_url, /^https:\/\/whip\.openvibe\.live\/whip\/agent\/ags_/);
            const state = await call('GET', `/api/streams/agent/${stream.id}/state`, { as: 1, headers: { Authorization: `Bearer ${publish.ticket}` } });
            assert.strictEqual(state.status, 200);
            assert.strictEqual(state.data.encode, false, 'nobody watches and it is private');
            assert.ok(state.data.ends_at, 'the ticket expiry bounds the stream');
            const bad = await call('GET', `/api/streams/agent/${stream.id}/state`, { as: 1, headers: { Authorization: `Bearer wpt_${'x'.repeat(43)}` } });
            assert.strictEqual(bad.status, 401, 'a ticket that does not verify');
            // A public stream is always encoded, watched or not.
            await call('PUT', `/api/streams/agent/${stream.id}/visibility`, { as: 1, body: { visibility: 'public' } });
            const pub = await call('GET', `/api/streams/agent/${stream.id}/state`, { as: 1, headers: { Authorization: `Bearer ${publish.ticket}` } });
            assert.strictEqual(pub.data.encode, true);
        });

        await check('ending the stream and revoking the ticket answer 200 and stop the desk', async () => {
            const made = await call('POST', '/api/streams/agent', {
                as: 1,
                body: { title: 'Ended', task: { source: 'node', ref: 'n1', title: 'End' }, visibility: 'private' },
            });
            assert.strictEqual(made.status, 201);
            const id = made.data.stream.id;
            const ended = await call('POST', `/api/streams/agent/${id}/end`, { as: 1, body: {} });
            assert.strictEqual(ended.status, 200);
            assert.strictEqual(ended.data.stream.state, 'ended');
            const stale = await call('GET', `/api/streams/agent/${id}/state`, { as: 1, headers: { Authorization: `Bearer ${made.data.publish.ticket}` } });
            assert.strictEqual(stale.status, 401, 'the publish ticket is gone with the stream');

            const second = await call('POST', '/api/streams/agent', {
                as: 1,
                body: { title: 'Revoked', task: { source: 'node', ref: 'n2', title: 'Revoke' }, visibility: 'private' },
            });
            assert.strictEqual(second.status, 201);
            const revoked = await call('DELETE', `/api/streams/agent/${second.data.stream.id}/ticket`, { as: 1 });
            assert.strictEqual(revoked.status, 200);
            assert.strictEqual(revoked.data.stream.state, 'ended');
        });

        quiet('agent streams: the curtain');
        await check('up pauses every viewer consumer, down resumes exactly those', async () => {
            const roomId = 'stream-999';
            const made = [];
            const room = { producers: new Map(), consumers: new Map(), transports: new Map(), router: null };
            for (const id of ['c1', 'c2', 'restream']) {
                const consumer = { paused: false, pause() { this.paused = true; }, resume() { this.paused = false; } };
                room.consumers.set(id, { consumer, peerId: id === 'restream' ? '__restream__' : `peer-${id}` });
                made.push({ id, consumer });
            }
            webrtcSFU.rooms.set(roomId, room);
            try {
                assert.strictEqual(curtains.raise(999), 2, 'the two viewers pause, the restream passthrough does not');
                assert.deepStrictEqual(made.map((m) => m.consumer.paused), [true, true, false]);
                assert.strictEqual(curtains.lower(999), 2);
                assert.deepStrictEqual(made.map((m) => m.consumer.paused), [false, false, false]);
                // A consumer that appears while the curtain is up starts paused, and nothing else does.
                curtains.raise(999);
                const late = { paused: false, pause() { this.paused = true; }, resume() { this.paused = false; } };
                room.consumers.set('c3', { consumer: late, peerId: 'peer-c3' });
                assert.strictEqual(curtains.applyToConsumer(999, 'c3'), true);
                assert.strictEqual(late.paused, true);
                curtains.lower(999);
            } finally {
                webrtcSFU.rooms.delete(roomId);
                curtains._reset();
            }
        });

        quiet('agent streams: the page and the embed code');
        await check('the owner page and the embed join with a view ticket and never a stream key', async () => {
            const fs = require('fs');
            const path = require('path');
            const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
            const player = read('public/js/agent-player.js');
            assert.match(player, /role=viewer/, 'the viewer socket');
            assert.match(player, /vt=\$\{encodeURIComponent\(viewTicket\)\}/, 'the view ticket on the join');
            assert.ok(!/stream_key/.test(player));
            const page = read('public/js/agent-stream.js');
            assert.match(page, /view-ticket/);
            assert.match(page, /loadAgentStreamPage/);
            assert.ok(!/stream_key/.test(page), 'the page asks for no key');
            const embed = read('public/js/agent-embed.js');
            assert.match(embed, /AgentPlayer\.create/);
            assert.match(embed, /renew/);
            // The housekeeping loop starts no timer when it is loaded (a drill never starts one).
            const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
            const sweep = require('../server/agent-streams/sweep');
            assert.strictEqual(process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length, before, 'no timer at load');
            assert.strictEqual(sweep.EVERY_MS, 60000);
            const t = sweep.start();
            assert.ok(t && typeof t.unref === 'function');
            sweep.stop();
        });

        await check('the owner page: one status line, the label on the player, an in-page End, no confirm()', async () => {
            const fs = require('fs');
            const path = require('path');
            const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
            const page = read('public/js/agent-stream.js');
            const fragment = read('public/fragments/agent-stream.html');
            // One status line: Live, N watching, worked X min — or Waiting for the desk, or Ended.
            assert.strictEqual((fragment.match(/id="agent-status-line"/g) || []).length, 1, 'one status line');
            assert.match(page, /Live · \$\{count\} watching · worked/);
            assert.match(page, /Waiting for the desk/);
            assert.match(page, /Ended · worked/);
            // The AI agent label rides on the player; the curtain says Private screen, the button offers to lift it.
            assert.match(fragment, /class="agent-label agent-player-label">AI agent/);
            assert.match(fragment, /id="agent-curtain"[^>]*>Private screen/);
            assert.match(page, /Lift the curtain/);
            // End asks in the page; a browser dialog is never used.
            assert.match(fragment, /id="agent-end-confirm"/);
            assert.ok(!/\bconfirm\(/.test(page), 'no confirm()');
            // S2 turns Public on: the owner's switch lists the Agents tab and the Agents live row as its home.
            assert.match(fragment, /<option value="public">Everyone/);
            assert.doesNotMatch(fragment, /<option value="public"[^>]*disabled/);
            assert.match(fragment, /Agents tab and Agents live/);
            // The Reset link hint says the old links stop working.
            assert.match(page, /old links stop working/);
        });

        await check('the embed: the picture fills the frame, with the label, the curtain and a small count on it', async () => {
            const fs = require('fs');
            const path = require('path');
            const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
            const css = read('public/css/features/agent-stream.css');
            const pages = read('server/agent-streams/pages.js');
            assert.match(css, /object-fit: contain/, 'the picture is contained');
            assert.match(css, /\.agent-embed-stage[^}]*align-items: center; justify-content: center/, 'centred in the frame');
            assert.match(css, /\.agent-embed-viewers[^}]*font-size: 0\.6\drem/, 'the viewer count is small');
            // The label, the curtain and the count ride on the picture, not in a bar above it.
            const start = pages.indexOf('<div class="agent-embed-media"');
            assert.ok(start > 0, 'the embed has a picture');
            let depth = 0;
            let media = '';
            for (let i = start; i < pages.length; i++) {
                if (pages.startsWith('<div', i)) depth++;
                else if (pages.startsWith('</div>', i)) { depth--; if (depth === 0) { media = pages.slice(start, i + 6); break; } }
            }
            assert.ok(media, 'the picture is closed');
            for (const part of ['agent-embed-label', 'agent-embed-curtain', 'agent-embed-viewers']) {
                assert.ok(media.includes(part), `${part} is on the picture`);
            }
            assert.match(media, /Private screen/, 'the curtain says Private screen');
        });
        quiet('agent streams: the embed');
        await check('frame-ancestors lists the first-party origins and never *', async () => {
            const pages = require('../server/agent-streams/pages');
            const embedApp = express();
            embedApp.get('/embed/agent/:id', pages.embed);
            const s = await new Promise((ok) => { const srv = http.createServer(embedApp).listen(0, '127.0.0.1', () => ok(srv)); });
            try {
                const res = await fetch(`http://127.0.0.1:${s.address().port}/embed/agent/${agent.public_id}`);
                assert.strictEqual(res.status, 200);
                const csp = res.headers.get('content-security-policy');
                assert.match(csp, /frame-ancestors 'self' /);
                for (const origin of ['https://openvibe.live', 'https://openvibe.codes', 'https://openvibe.actor']) {
                    assert.ok(csp.includes(origin), `${origin} may frame it`);
                }
                assert.ok(!/frame-ancestors[^;]*\*/.test(csp), 'never *');
                assert.match(await res.text(), /id="agent-embed-video"/);
                const bad = await fetch(`http://127.0.0.1:${s.address().port}/embed/agent/ags_00000000000000000000000000`);
                assert.strictEqual(bad.status, 404);
            } finally { s.close(); }
        });

        await check('AGENT_EMBED_EXTENSION_ORIGINS adds exactly one chrome-extension id, and only that', async () => {
            const p = require('../server/agent-streams/pages');
            const id = 'a'.repeat(32);
            const origin = `chrome-extension://${id}`;
            // Unset: today's header, no extension origin at all.
            assert.ok(!p.embedCsp().includes('chrome-extension://'), 'unset: the CSP is unchanged');
            assert.ok(!p.frameAncestors().includes('chrome-extension:'), 'unset: no extension may frame it');
            // A valid id is added to the header the page serves.
            delete process.env.AGENT_EMBED_EXTENSION_ORIGINS;
            process.env.AGENT_EMBED_EXTENSION_ORIGINS = `${origin},${'b'.repeat(32)}`;
            delete require.cache[require.resolve('../server/agent-streams/pages')];
            const set = require('../server/agent-streams/pages');
            assert.ok(set.frameAncestors().includes(origin), 'the valid id is added');
            assert.ok(set.embedCsp().includes(origin), 'and it frames the page in the CSP');
            assert.ok(!set.frameAncestors().includes('chrome-extension://bb'), 'a bare 32 letters without the scheme is ignored');
            // Anything that is not one exact origin is dropped, with one warning at boot.
            const warned = [];
            assert.deepStrictEqual(p.parseExtensionOrigins(`${origin}, chrome-extension:, moz-extension://abc, chrome-extension://${'A'.repeat(32)}, https://evil.example`, { warn: (m) => warned.push(m) }), [origin]);
            assert.strictEqual(warned.length, 1, 'one warning at boot');
            assert.ok(!p.frameAncestors(p.parseExtensionOrigins('chrome-extension:, moz-extension://abc', { warn() {} })).includes('moz-extension:'), 'never a scheme-wide source');
            delete process.env.AGENT_EMBED_EXTENSION_ORIGINS;
            delete require.cache[require.resolve('../server/agent-streams/pages')];
        });
    } finally {
        server.close();
        fs.rmSync(keyDir, { recursive: true, force: true });
    }

    if (failures) { quiet(`${failures} agent stream check(s) failed`); process.exit(1); }
    quiet('agent streams: ok');
})().catch((e) => { quiet(e && e.stack || String(e)); process.exit(1); });
