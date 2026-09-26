'use strict';

// The staged chat tables (roadmap C-04; OpenVibe.Chat docs/staged-tables-cutover.md): the authority
// per table (app_state, 'live' by default, and 'live' whatever it says without CHAT_AUTHORITY=chat);
// at 'live' Live writes locally and its captured changes reach Chat's copy (ordered, newest state,
// kept while Chat is down); the dual-read counter (matched, mismatched, inconclusive; Live's answer
// never changes); the internal status and flip routes; the handoff to 'chat' (Live's queued
// changes first, then Chat, then Live stops writing); Live's writers going to Chat when flipped —
// through a real route — with Live's copy following Chat's answer, Chat's mirror accepted only for
// a table Chat writes; a refused or unreachable Chat changes nothing; the flip back. Against stub
// Network and Chat servers (the stub keeps its copy in SQLite and hashes slices like Chat does).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const { serviceAuth } = require('openvibe-contracts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-chattables-'));
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
fs.writeFileSync(path.join(tmp, 'network.pem'), keys.publicKey);
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.OV_NETWORK_PUBLIC_KEY = path.join(tmp, 'network.pem');
process.env.OV_NETWORK_URL = 'https://openvibe.network';
process.env.OV_OAUTH_CLIENT_ID = 'live';
process.env.OV_OAUTH_CLIENT_SECRET = 'live-secret';
process.env.INTERNAL_API_KEY = 'internal-test-key';
process.env.CHAT_AUTHORITY = 'chat';
const quiet = console.log;
console.log = () => {};
console.warn = () => {};

const ISS = 'https://openvibe.network';
const now = () => Math.floor(Date.now() / 1000);
let jti = 0;
const serviceToken = (cap, aud) => serviceAuth.signServiceToken({ iss: ISS, sub: 'svc:live', actor_type: 'service', aud: [aud], cap, iat: now(), exp: now() + 300, jti: `tok_test_${++jti}` }, keys.privateKey);

const network = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: serviceToken(['chat.live_bridge.write'], new URLSearchParams(raw).get('audience')), expires_in: 300 }));
        res.statusCode = 404; res.end('{}');
    });
});

// ── Stub OpenVibe.Chat: the bridge ops of the staged tables, on a SQLite copy ──
const TABLES = ['channel_moderators', 'channel_moderation_settings', 'emotes', 'user_tags', 'chat_ai_summaries', 'chat_timeline_events'];
const PK = { channel_moderation_settings: 'channel_id' };
const pkOf = (t) => PK[t] || 'id';
const stub = { calls: [], down: false, refuseHandback: false, authority: Object.fromEntries(TABLES.map((t) => [t, 'live'])), copy: null };
const hash = (cols, rows) => crypto.createHash('sha256').update(JSON.stringify(rows.map((r) => cols.map((c) => (r[c] === undefined ? null : r[c]))))).digest('hex');
function stubOp(o) {
    const c = stub.copy;
    const [fn, ...a] = o.op === 'db' ? o.args : [];
    const rowOf = (t, id) => c.prepare(`SELECT * FROM ${t} WHERE ${pkOf(t)} = ?`).get(id);
    const answer = (value, t, ids = [], deleted = []) => ({ value, mirror: [...deleted.map((id) => ({ table: t, op: 'delete', pk: { [pkOf(t)]: id } })), ...ids.map((id) => ({ table: t, op: 'upsert', row: rowOf(t, id) }))] });
    const plain = (r) => ({ changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) });
    switch (o.op) {
        case 'tableAuthority': return { ...stub.authority };
        case 'setTableAuthority':
            if (o.args[1] === 'live' && stub.refuseHandback) throw new Error(`1 change(s) to ${o.args[0]} not in Live yet`);
            stub.authority[o.args[0]] = o.args[1];
            return { table: o.args[0], authority: o.args[1], mirror_pending: 0 };
        case 'stagedApply': {
            const out = { applied: 0, skipped: [] };
            for (const ch of o.args[0]) {
                if (stub.authority[ch.table] !== 'live') { out.skipped.push({ table: ch.table, reason: 'Chat writes this table (table_authority chat)' }); continue; }
                if (ch.op === 'delete') c.prepare(`DELETE FROM ${ch.table} WHERE ${pkOf(ch.table)} = ?`).run(ch.pk[pkOf(ch.table)]);
                else { const cols = Object.keys(ch.row); c.prepare(`INSERT OR REPLACE INTO ${ch.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((k) => ch.row[k])); }
                out.applied++;
            }
            return out;
        }
        case 'stagedSlice': {
            const [t, where, cols] = o.args;
            const ks = Object.keys(where);
            const use = [...cols].sort();
            const rows = c.prepare(`SELECT ${use.join(', ')} FROM ${t} WHERE ${ks.map((k) => `${k} IS ?`).join(' AND ') || '1'} ORDER BY ${pkOf(t)}`).all(...ks.map((k) => where[k]));
            return { count: rows.length, hash: hash(use, rows), columns: use, rows: rows.length <= 50 ? rows : undefined };
        }
        case 'db': {
            const table = { addChannelModerator: 'channel_moderators', removeChannelModerator: 'channel_moderators', upsertChannelModerationSettings: 'channel_moderation_settings', setChannelAlertSound: 'channel_moderation_settings', createEmote: 'emotes', updateEmote: 'emotes', deleteEmote: 'emotes', setEmoteMedia: 'emotes', upsertChatAiSummary: 'chat_ai_summaries', addChatTimelineEvents: 'chat_timeline_events' }[fn];
            if (stub.authority[table] !== 'chat') throw new Error(`${table} is written by Live (table_authority live)`);
            if (fn === 'addChannelModerator') {
                const r = c.prepare('INSERT OR IGNORE INTO channel_moderators (channel_id, user_id, added_by) VALUES (?, ?, ?)').run(...a);
                return answer(plain(r), table, [c.prepare('SELECT id FROM channel_moderators WHERE channel_id = ? AND user_id = ?').get(a[0], a[1]).id]);
            }
            if (fn === 'removeChannelModerator') {
                const gone = c.prepare('SELECT id FROM channel_moderators WHERE channel_id = ? AND user_id = ?').all(a[0], a[1]).map((r) => r.id);
                return answer(plain(c.prepare('DELETE FROM channel_moderators WHERE channel_id = ? AND user_id = ?').run(a[0], a[1])), table, [], gone);
            }
            if (fn === 'upsertChannelModerationSettings') {
                c.prepare('INSERT OR IGNORE INTO channel_moderation_settings (channel_id) VALUES (?)').run(a[0]);
                for (const [k, v] of Object.entries(a[1])) if (v !== undefined && /^[a-z_]+$/.test(k) && k !== 'slowmode_seconds') c.prepare(`UPDATE channel_moderation_settings SET ${k} = ? WHERE channel_id = ?`).run(typeof v === 'boolean' ? Number(v) : v, a[0]);
                return answer(rowOf(table, a[0]), table, [a[0]]);
            }
            if (fn === 'createEmote') {
                const e = a[0];
                const r = c.prepare('INSERT INTO emotes (user_id, code, url, animated, channel_owner_id, size) VALUES (?, ?, ?, ?, ?, ?)').run(e.user_id, e.code, e.url, e.animated ? 1 : 0, e.channel_owner_id || null, e.size || 100);
                return answer(plain(r), table, [Number(r.lastInsertRowid)]);
            }
            if (fn === 'deleteEmote') return answer(plain(c.prepare('DELETE FROM emotes WHERE id = ?').run(a[0])), table, [], [a[0]]);
            if (fn === 'upsertChatAiSummary') {
                const s = a[0];
                c.prepare(`INSERT INTO chat_ai_summaries (scope, subject_id, window, overview) VALUES (?, ?, ?, ?)
                    ON CONFLICT(scope, subject_id, window) DO UPDATE SET overview = excluded.overview`).run(s.scope, s.subject_id || 0, s.window, s.overview || '');
                return answer({ changes: 1, lastInsertRowid: 0 }, table, [c.prepare('SELECT id FROM chat_ai_summaries WHERE scope = ? AND subject_id = ? AND window = ?').get(s.scope, s.subject_id || 0, s.window).id]);
            }
            throw new Error(`stub has no ${fn}`);
        }
        default: throw new Error(`unknown op ${o.op}`);
    }
}
const chat = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        if (stub.down) { req.socket.destroy(); return; }
        res.setHeader('Content-Type', 'application/json');
        const auth = String(req.headers.authorization || '');
        const v = serviceAuth.verifyServiceToken(auth.slice(7), { publicKey: keys.publicKey, issuer: ISS, audience: 'openvibe.chat' });
        if (!v.ok || !v.claims.cap.includes('chat.live_bridge.write')) { res.statusCode = 401; return res.end('{}'); }
        if (req.url !== '/internal/live/calls') { res.statusCode = 404; return res.end('{}'); }
        const body = JSON.parse(raw);
        const results = body.ops.map((o) => {
            stub.calls.push({ op: o.op, args: o.args, key: o.key });
            try { return { seq: o.seq, ok: true, result: stubOp(o) }; } catch (err) { return { seq: o.seq, ok: false, error: err.message }; }
        });
        res.end(JSON.stringify({ ok: true, results }));
    });
});

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    process.env.OV_NETWORK_INTERNAL_URL = `http://127.0.0.1:${await listen(network)}`;
    process.env.OV_CHAT_INTERNAL_URL = `http://127.0.0.1:${await listen(chat)}`;

    const db = require('../server/db/database');
    db.initDb();
    require('../server/chat/tags').ensureTagTables();
    for (const col of ['media_url TEXT', 'media_asset_id INTEGER']) { try { db.getDb().exec(`ALTER TABLE emotes ADD COLUMN ${col}`); } catch { /* present */ } }
    const d = db.getDb();
    // The stub's copy: the same tables, created from Live's own definitions (no foreign keys to follow).
    stub.copy = new Database(':memory:');
    stub.copy.pragma('foreign_keys = OFF');
    for (const t of TABLES) stub.copy.exec(d.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql);
    for (const r of d.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND tbl_name IN (${TABLES.map(() => '?').join(',')})`).all(...TABLES)) stub.copy.exec(r.sql);

    const mkUser = (username, role = 'user') => {
        const id = Number(db.createUser({ username, email: `${username}@example.test`, password_hash: '!x', display_name: username.toUpperCase(), stream_key: `key-${username}` }).lastInsertRowid);
        d.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
        return id;
    };
    const streamer = mkUser('streamer', 'streamer');
    const mod = mkUser('moddy');
    const viewer = mkUser('viewer');
    d.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (?, 'network', '601', 'usr_01J9SSSSSSSSSSSSSSSSSSSSSS')").run(streamer);
    db.createChannel({ user_id: streamer, title: 'Streamer TV' });
    const channel = db.getChannelByUserId(streamer);
    db.createChannel({ user_id: viewer, title: 'Viewer TV' });
    const channel2 = db.getChannelByUserId(viewer);
    const streamerJwt = jwt.sign({ sub: '601', username: 'streamer', subject_id: 'usr_01J9SSSSSSSSSSSSSSSSSSSSSS' }, keys.privateKey, { algorithm: 'RS256', issuer: ISS, expiresIn: 600 });

    const express = require('express');
    const app = express();
    app.use(express.json());
    const routes = require('../server/chat/live-context-routes');
    app.use('/internal/chat-effects', routes.effectsRouter);
    app.use('/internal', require('../server/internal/routes'));
    app.use('/api/channels', require('../server/admin/channel-mod-routes'));
    const port = await listen(http.createServer(app));
    const call = async (method, p, { body, headers = {} } = {}) => {
        const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch { /* */ }
        return { status: res.status, body: json, text };
    };
    const KEY = { 'X-Internal-Key': 'internal-test-key' };
    const internal = (method, p, body) => call(method, `/internal${p}`, { body, headers: KEY });
    const MIRROR = serviceToken(['live.chat_mirror.write'], 'openvibe.live');
    const mirror = (changes) => call('POST', '/internal/chat-effects/mirror', { body: { changes }, headers: { Authorization: `Bearer ${MIRROR}` } });

    const chatTables = require('../server/chat/chat-tables');
    const sync = require('../server/chat/chat-tables-sync');
    const outbox = (t) => d.prepare('SELECT tbl, op, pk FROM chat_staged_outbox WHERE tbl = ? ORDER BY seq').all(t);
    const stats = (t) => sync.dualReadStats(t);
    const stubRows = (t) => stub.copy.prepare(`SELECT * FROM ${t} ORDER BY ${pkOf(t)}`).all();

    let exit = 0;
    try {
        // 1. Deploying changes nothing: every table 'live', writes local, and without CHAT_AUTHORITY=chat
        //    a stored 'chat' does not count.
        for (const t of TABLES) assert.strictEqual(chatTables.authority(t), 'live', t);
        await chatTables.write('addChannelModerator', channel.id, mod, streamer);
        assert.ok(db.isChannelModerator(mod, channel.id));
        db.setState(chatTables.AUTHORITY_KEY, JSON.stringify({ emotes: 'chat' }));
        chatTables._resetCache();
        assert.strictEqual(chatTables.authority('emotes'), 'chat');
        process.env.CHAT_AUTHORITY = '';
        assert.strictEqual(chatTables.authority('emotes'), 'live', 'Live runs chat itself: it writes everything');
        assert.strictEqual(chatTables.init(), false, 'and starts nothing');
        process.env.CHAT_AUTHORITY = 'chat';
        db.setState(chatTables.AUTHORITY_KEY, '{}');
        chatTables._resetCache();
        await assert.rejects(chatTables.write('grantUserTag', viewer, 'x'), /not a staged-table write/, 'user_tags has no writer in Live');

        // 2. init: capture, dual read, relay (the relay's timer is stopped; the test flushes by hand).
        assert.strictEqual(chatTables.init(), true);
        require('../server/utils/jobs').stopAll();
        assert.strictEqual(sync.pending(), 0, 'what was written before init is the import’s business');

        // 3. At 'live': every change to a staged table is captured, whoever writes it.
        await chatTables.write('upsertChannelModerationSettings', channel.id, { slow_mode_seconds: 5 });
        await chatTables.write('upsertChannelModerationSettings', channel.id, { emote_scale: 150 });
        const e1 = Number((await chatTables.write('createEmote', { user_id: streamer, code: 'pog', url: '/data/emotes/pog.png', channel_owner_id: streamer })).lastInsertRowid);
        await chatTables.write('removeChannelModerator', channel.id, mod);
        await chatTables.write('upsertChatAiSummary', { scope: 'global', subject_id: 0, window: 'global', overview: 'busy' });
        await chatTables.write('addChatTimelineEvents', 'global', 0, [{ ts: '2026-09-25 10:00:00', label: 'raid' }]);
        d.prepare("INSERT INTO user_tags (user_id, tag_id, source) VALUES (?, 'legacy', 'migration')").run(viewer);
        assert.deepStrictEqual(outbox('channel_moderation_settings').map((r) => r.op), ['upsert', 'upsert'], 'the insert and the update');
        assert.deepStrictEqual(outbox('channel_moderators').map((r) => [r.op, JSON.parse(r.pk).id > 0]), [['delete', true]]);
        assert.strictEqual(outbox('user_tags').length, 1, 'a raw write is captured too');

        // 4. The relay: newest state per row, in order; kept while Chat is down; acknowledged rows go.
        stub.down = true;
        let r = await sync.flush();
        assert.ok(r.pending >= 6 && /unreachable/.test(r.error), JSON.stringify(r));
        stub.down = false;
        stub.calls.length = 0;
        r = await sync.flush();
        assert.deepStrictEqual([r.pending, r.error], [0, null]);
        const applied = stub.calls.filter((c) => c.op === 'stagedApply').flatMap((c) => c.args[0]);
        const cms = applied.filter((c) => c.table === 'channel_moderation_settings');
        assert.strictEqual(cms.length, 1, 'two changes to one row: one upsert');
        assert.deepStrictEqual([cms[0].row.slow_mode_seconds, cms[0].row.emote_scale], [5, 150]);
        assert.deepStrictEqual(applied.find((c) => c.table === 'channel_moderators'), { table: 'channel_moderators', op: 'delete', pk: { id: 1 } });
        assert.strictEqual(stubRows('emotes')[0].code, 'pog');
        assert.strictEqual(stubRows('user_tags').length, 1);
        // Paused for an import: the capture goes on, nothing is sent; resumed, everything since goes.
        assert.strictEqual((await internal('POST', '/chat-tables/relay', { paused: true })).body.relay.paused, true);
        await chatTables.write('addChatTimelineEvents', 'global', 0, [{ ts: '2026-09-25 10:05:00', label: 'after the pause' }]);
        r = await sync.flush();
        assert.deepStrictEqual([r.error, r.pending], ['relay paused', 1]);
        assert.strictEqual(stubRows('chat_timeline_events').length, 1);
        assert.strictEqual((await internal('POST', '/chat-tables/relay', { paused: false })).body.relay.paused, false);
        assert.strictEqual((await sync.flush()).pending, 0);
        assert.strictEqual(stubRows('chat_timeline_events').length, 2);

        // 5. The dual read: off by default; on, a read is compared in the background; Live's answer never changes.
        const liveAnswer = db.getChannelModerationSettings(channel.id);
        await sleep(50);
        assert.strictEqual(stats('channel_moderation_settings').compared, 0, 'off: nothing compared');
        assert.strictEqual((await internal('POST', '/chat-tables/channel_moderation_settings', { dual_read: true })).body.table.dual_read, true);
        assert.deepStrictEqual(db.getChannelModerationSettings(channel.id), liveAnswer);
        await sleep(150);
        assert.deepStrictEqual([stats('channel_moderation_settings').compared, stats('channel_moderation_settings').matched], [1, 1]);
        // Chat's copy differs for another channel: counted, sampled, logged; Live answers from its own row.
        await chatTables.write('upsertChannelModerationSettings', channel2.id, { slow_mode_seconds: 30 });
        await sync.flush();
        stub.copy.prepare('UPDATE channel_moderation_settings SET slow_mode_seconds = 31 WHERE channel_id = ?').run(channel2.id);
        assert.strictEqual(db.getChannelModerationSettings(channel2.id).slow_mode_seconds, 30);
        await sleep(150);
        let st = stats('channel_moderation_settings');
        assert.deepStrictEqual([st.compared, st.mismatched], [2, 1]);
        assert.deepStrictEqual(st.last_mismatch.where, { channel_id: channel2.id });
        assert.deepStrictEqual(st.last_mismatch.differ, [JSON.stringify([channel2.id])]);
        // A change still on its way to Chat: no verdict.
        await internal('POST', '/chat-tables/emotes', { dual_read: true });
        await chatTables.write('updateEmote', e1, { size: 120 });
        db.getEmoteById(e1);
        await sleep(150);
        assert.deepStrictEqual([stats('emotes').inconclusive, stats('emotes').mismatched], [1, 0]);
        await sync.flush();
        // The same slice is compared at most once a minute.
        db.getChannelModerationSettings(channel2.id);
        await sleep(100);
        assert.strictEqual(stats('channel_moderation_settings').compared, 2);
        assert.strictEqual((await internal('POST', '/chat-tables/channel_moderation_settings', { reset_counters: true })).body.table.dual_read_stats.compared, 0);

        // 6. The status route: loopback + internal key; both sides' view of every table.
        assert.strictEqual((await call('GET', '/internal/chat-tables')).status, 403);
        assert.strictEqual((await call('GET', '/internal/chat-tables', { headers: { ...KEY, 'X-Forwarded-For': '203.0.113.1' } })).status, 403);
        let s = (await internal('GET', '/chat-tables')).body;
        assert.strictEqual(s.chat_authority, 'chat');
        assert.deepStrictEqual([s.tables.emotes.authority, s.tables.emotes.chat_authority, s.tables.emotes.dual_read, s.tables.emotes.outbox_pending], ['live', 'live', true, 0]);
        assert.strictEqual((await internal('POST', '/chat-tables/chat_messages', { authority: 'chat' })).status, 404);

        // 7. While Live writes a table, Chat's mirror rows for it are refused.
        let m = await mirror([{ table: 'channel_moderators', op: 'upsert', row: { id: 900, channel_id: channel.id, user_id: viewer, added_by: streamer } }]);
        assert.deepStrictEqual([m.body.applied, m.body.skipped[0].reason], [0, 'Live writes this table (chat_table_authority live)']);

        // 8. Handoff to 'chat': Live's queued change reaches Chat first, then Chat takes it, then Live stops.
        await chatTables.write('addChannelModerator', channel.id, viewer, streamer);
        assert.strictEqual(outbox('channel_moderators').length, 1);
        stub.calls.length = 0;
        let f = await internal('POST', '/chat-tables/channel_moderators', { authority: 'chat', by: 'test' });
        assert.strictEqual(f.status, 200, f.text);
        // (chat-remote's own traffic — invalidations, forwarded moderation-log rows — is not this.)
        const tableOps = () => stub.calls.filter((c) => ['stagedApply', 'setTableAuthority', 'tableAuthority'].includes(c.op) || (c.op === 'db' && c.args[0] in chatTables.OPS));
        assert.deepStrictEqual(tableOps().map((c) => c.op), ['stagedApply', 'setTableAuthority', 'tableAuthority']);
        assert.deepStrictEqual([f.body.handoff.before, f.body.handoff.authority, f.body.table.authority, f.body.table.chat_authority], ['live', 'chat', 'chat', 'chat']);
        assert.strictEqual(stubRows('channel_moderators').length, 1, 'Chat has the row Live wrote last');
        d.prepare('DELETE FROM channel_moderators WHERE user_id = ?').run(viewer);
        assert.strictEqual(outbox('channel_moderators').length, 0, 'Live’s copy is the mirror now: nothing captured');
        m = await mirror([{ table: 'channel_moderators', op: 'upsert', row: stubRows('channel_moderators')[0] }]);
        assert.strictEqual(m.body.applied, 1, 'and Chat’s mirror is taken');
        assert.ok(db.isChannelModerator(viewer, channel.id));

        // 9. Live's writers go to Chat: the real route, Chat's id, Live's copy right away, nothing written locally first.
        stub.calls.length = 0;
        let res = await call('POST', `/api/channels/${channel.id}/mods`, { body: { username: 'moddy' }, headers: { Authorization: `Bearer ${streamerJwt}` } });
        assert.strictEqual(res.status, 200, res.text);
        const dbCall = tableOps().find((c) => c.op === 'db');
        assert.deepStrictEqual(dbCall.args, ['addChannelModerator', channel.id, mod, streamer]);
        assert.match(dbCall.key, /^staged:/, 'an idempotency key');
        const chatRow = stubRows('channel_moderators').find((x) => x.user_id === mod);
        assert.deepStrictEqual(res.body.moderators.map((x) => x.user_id).sort(), [mod, viewer].sort(), 'the answer reads Live’s copy, already current');
        assert.strictEqual(d.prepare('SELECT id FROM channel_moderators WHERE user_id = ?').get(mod).id, chatRow.id, 'Chat’s id');
        assert.strictEqual(outbox('channel_moderators').length, 0);
        res = await call('DELETE', `/api/channels/${channel.id}/mods/${mod}`, { headers: { Authorization: `Bearer ${streamerJwt}` } });
        assert.strictEqual(res.status, 200, res.text);
        assert.ok(!db.isChannelModerator(mod, channel.id) && !stubRows('channel_moderators').some((x) => x.user_id === mod));
        // Chat unreachable: the write fails and Live's copy is untouched.
        stub.down = true;
        res = await call('POST', `/api/channels/${channel.id}/mods`, { body: { username: 'moddy' }, headers: { Authorization: `Bearer ${streamerJwt}` } });
        assert.strictEqual(res.status, 500);
        assert.ok(!db.isChannelModerator(mod, channel.id), 'no local write when Chat writes the table');
        stub.down = false;
        // Other tables keep their own authority: emotes is still Live's.
        const e2 = Number((await chatTables.write('createEmote', { user_id: viewer, code: 'kek', url: '/e/kek.png' })).lastInsertRowid);
        assert.ok(db.getEmoteById(e2) && outbox('emotes').length === 1 && !stubRows('emotes').some((x) => x.code === 'kek'));
        await sync.flush();

        // 10. A handoff Chat refuses changes nothing; running it again is safe.
        stub.authority.emotes = 'chat';
        stub.refuseHandback = false;
        f = await internal('POST', '/chat-tables/emotes', { authority: 'chat' });
        assert.strictEqual(f.status, 200, 'Chat already agreed: the same call brings Live along');
        stub.down = true;
        f = await internal('POST', '/chat-tables/emotes', { authority: 'live' });
        assert.strictEqual(f.status, 503, f.text);
        assert.strictEqual(chatTables.authority('emotes'), 'chat', 'Chat unreachable: still Chat’s');
        stub.down = false;
        // Emote writes at 'chat' through the helper: Live's copy follows Chat's answer.
        const e3 = Number((await chatTables.write('createEmote', { user_id: viewer, code: 'lul', url: '/e/lul.png' })).lastInsertRowid);
        assert.strictEqual(db.getEmoteById(e3).code, 'lul');
        await chatTables.write('deleteEmote', e3);
        assert.strictEqual(db.getEmoteById(e3), undefined);

        stub.refuseHandback = true;
        f = await internal('POST', '/chat-tables/channel_moderators', { authority: 'live' });
        assert.deepStrictEqual([f.status, chatTables.authority('channel_moderators')], [409, 'chat'], 'Chat still has changes for Live: nothing moves');
        assert.match(f.body.error, /not in Live yet/);
        stub.refuseHandback = false;

        // 11. Back to 'live': Chat's changes first (the stub gave them), then Live writes and captures again.
        f = await internal('POST', '/chat-tables/channel_moderators', { authority: 'live' });
        assert.strictEqual(f.status, 200, f.text);
        assert.deepStrictEqual([f.body.table.authority, f.body.table.chat_authority], ['live', 'live']);
        await chatTables.write('addChannelModerator', channel.id, mod, streamer);
        assert.ok(db.isChannelModerator(mod, channel.id));
        assert.strictEqual(outbox('channel_moderators').length, 1, 'captured again');
        m = await mirror([{ table: 'channel_moderators', op: 'delete', pk: { id: 1 } }]);
        assert.strictEqual(m.body.applied, 0, 'Chat’s mirror is refused again');
        s = (await internal('GET', '/chat-tables')).body;
        assert.deepStrictEqual(Object.fromEntries(Object.entries(s.tables).map(([t, v]) => [t, v.authority])), { channel_moderators: 'live', channel_moderation_settings: 'live', emotes: 'chat', user_tags: 'live', chat_ai_summaries: 'live', chat_timeline_events: 'live' });
        assert.ok(Object.values(s.tables).every((v) => !v.disagree), 'Live and Chat agree on every table');

        // 12. Chat down with a table at 'chat': Live takes it back by force (after the operator drained
        //     Chat's mirror); until Chat's side is set too, Chat refuses Live's changes and they wait.
        stub.down = true;
        assert.strictEqual((await internal('POST', '/chat-tables/emotes', { authority: 'chat', force: true })).status, 400, 'force only takes back');
        f = await internal('POST', '/chat-tables/emotes', { authority: 'live', force: true, by: 'test' });
        assert.strictEqual(f.status, 200, f.text);
        assert.strictEqual(chatTables.authority('emotes'), 'live');
        stub.down = false;
        await chatTables.write('updateEmote', e1, { code: 'pog2' });
        r = await sync.flush();
        assert.match(r.error, /OpenVibe.Chat writes emotes but Live does too/);
        assert.strictEqual(outbox('emotes').length, 1, 'Live’s change is kept');
        assert.strictEqual((await internal('GET', '/chat-tables')).body.tables.emotes.disagree, true);
        stub.authority.emotes = 'live';   // scripts/table-authority.js set emotes live --force, in Chat
        r = await sync.flush();
        assert.deepStrictEqual([r.pending, r.error], [0, null]);
        assert.strictEqual(stubRows('emotes').find((x) => x.id === e1).code, 'pog2');

        quiet('chat tables (C-04, Live side): all checks passed');
    } catch (err) {
        console.error(err);
        exit = 1;
    } finally {
        try { db.close(); } catch { /* */ }
        fs.rmSync(tmp, { recursive: true, force: true });
        process.exit(exit);
    }
})();
