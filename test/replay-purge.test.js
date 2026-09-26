/**
 * Legacy parity (roadmap D20): purging chat and deleting replays stays consistent.
 *
 * 1. Chat purge ↔ VOD chat replay. The dashboard's "Purge Range" (and its preview and log filter)
 *    sends ISO instants ('2026-09-20T10:00:00.000Z'); chat_messages keeps SQLite's
 *    '2026-09-20 10:00:00'. Compared as TEXT ('T' sorts after ' '), a range matched nothing on its
 *    first day and ALL of its last day: the purge removed lines outside the chosen range, kept the ones
 *    inside it, and VOD chat replay went on showing them. Live's local routes (CHAT_AUTHORITY=live, and
 *    the mirror Live keeps under CHAT_AUTHORITY=chat) now read both forms as UTC, as OpenVibe.Chat does.
 *
 * 2. Deleting a VOD or clip. Media deletes the item; Live used to only hide the comment thread, and
 *    kept its own rows: the AI state the backfill takes newest-first (a deleted VOD's row sat at the
 *    head of the overview queue for good) and the unique views. The admin storage page and the
 *    "older than" action also left the item's Search document until the daily refresh. Every delete
 *    path now goes through server/media-proxy/purge.js.
 *
 *   node test/replay-purge.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-replay-purge-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

const db = require('../server/db/database');
db.initDb();
const raw = db.getDb();

const auth = require('../server/auth/auth');
const signIn = (req) => {
    const id = Number(req.headers['x-test-user'] || 0);
    const u = id ? db.getUserById(id) : null;
    if (u) { req.user = u; req.authSource = 'network'; }
    return u;
};
auth.requireAuth = (req, res, next) => (signIn(req) ? next() : res.status(401).json({ error: 'Authentication required' }));
auth.optionalAuth = (req, res, next) => { signIn(req); next(); };

const addUser = (id, username, role) => raw.prepare(
    `INSERT INTO users (id, username, display_name, email, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, 'x', ?, '2025-01-01 00:00:00')`).run(id, username, username, `${username}@x`, role);
addUser(1, 'admin', 'admin');
addUser(3, 'alice', 'streamer');
addUser(7, 'mallory', 'streamer');
db.ensureChannel(3);
db.ensureChannel(7);
const streamA = Number(db.createStream({ user_id: 3, channel_id: db.getChannelByUserId(3).id, title: 'A', protocol: 'webrtc' }).lastInsertRowid);
raw.prepare("UPDATE streams SET started_at = '2026-09-20 09:00:00', ended_at = '2026-09-21 03:00:00', is_live = 0 WHERE id = ?").run(streamA);
Number(db.createStream({ user_id: 7, channel_id: db.getChannelByUserId(7).id, title: 'M', protocol: 'webrtc' }).lastInsertRowid);

// Alice's chat during her stream, as Live stores it (UTC, SQLite form).
const LINES = [
    ['2026-09-20 09:59:59', 'before'],
    ['2026-09-20 10:00:00', 'first in range'],
    ['2026-09-20 10:30:00', 'middle'],
    ['2026-09-20 11:00:00', 'last in range'],
    ['2026-09-20 11:00:01', 'just after'],
    ['2026-09-20 23:30:00', 'late that evening'],
    ['2026-09-21 01:00:00', 'after midnight'],
    ['2026-09-21 02:30:00', 'next morning'],
];
for (const [ts, text] of LINES) {
    raw.prepare(`INSERT INTO chat_messages (stream_id, channel_user_id, user_id, username, message, message_type, timestamp)
        VALUES (?, 3, 7, 'mallory', ?, 'chat', ?)`).run(streamA, text, ts);
}

// ── the chat server the purge route announces to ──
const announced = [];
require.cache[require.resolve('../server/chat/chat-server')] = {
    id: 'chat-server-stub', filename: 'chat-server-stub', loaded: true,
    exports: { broadcastToStream: (sid, p) => announced.push([sid, p]), broadcastGlobal: (p) => announced.push(['global', p]) },
};

// ── Media, Community and Search stubs for the delete paths ──
const media = require('../server/media-client');
const VODS = {
    100: { id: 100, user_id: 3, title: 'one', visibility: 'public', is_public: 1, status: 'ready', created_at: '2020-01-01 00:00:00' },
    101: { id: 101, user_id: 3, title: 'bulk', visibility: 'public', is_public: 1, status: 'ready', created_at: '2020-01-01 00:00:00' },
    102: { id: 102, user_id: 3, title: 'kept', visibility: 'public', is_public: 1, status: 'ready', created_at: '2020-01-01 00:00:00' },
    103: { id: 103, user_id: 3, title: 'old', visibility: 'public', is_public: 1, status: 'ready', created_at: '2020-01-01 00:00:00' },
    104: { id: 104, user_id: 3, title: 'media refuses', visibility: 'public', is_public: 1, status: 'ready', created_at: '2020-01-01 00:00:00' },
};
const CLIPS = { 200: { id: 200, user_id: 3, channel_user_id: 3, title: 'clip', visibility: 'public', is_public: 1, status: 'ready' } };
const missing = (what) => new media.MediaApiError(`${what} not found`, 404, { error: `${what} not found` });
media.getVod = async (id) => { const v = VODS[Number(id)]; if (!v) throw missing('VOD'); return { ...v }; };
media.getClip = async (id) => { const c = CLIPS[Number(id)]; if (!c) throw missing('Clip'); return { ...c }; };
media.deleteVod = async (id) => { if (Number(id) === 104) throw new media.MediaApiError('busy', 409, { error: 'busy' }); delete VODS[Number(id)]; };
media.deleteClip = async (id) => { delete CLIPS[Number(id)]; };
media.listVods = async (q) => ({ vods: q.user_id === 3 ? [VODS[103]].filter(Boolean) : [] });
media.listClips = async () => ({ clips: [] });
const commentsClient = require('../server/comments-client');
const hidden = [];
commentsClient.hideThreadOf = (type, id) => { hidden.push(`${type}:${id}`); return Promise.resolve(); };
const searchDocs = require('../server/events/search-media-documents');
const touched = [];
searchDocs.touchLater = (kind, ids) => { touched.push(`${kind}:${ids}`); };

for (const id of [100, 101, 102, 103, 104]) {
    raw.prepare("INSERT INTO vod_ai_state (vod_id, transcript_status) VALUES (?, 'pending')").run(id);
    raw.prepare("INSERT INTO content_views (content_type, content_id, ip) VALUES ('vod', ?, '10.0.0.1')").run(id);
}
raw.prepare("INSERT INTO clip_ai_state (clip_id, transcript_status) VALUES (200, 'pending')").run();
raw.prepare("INSERT INTO content_views (content_type, content_id, ip) VALUES ('clip', 200, '10.0.0.1')").run();

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/chat', require('../server/chat/routes'));
app.use('/api/vods', require('../server/media-proxy/vods'));
app.use('/api/clips', require('../server/media-proxy/clips'));
const server = http.createServer(app).listen(0);

function call(method, p, user, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const headers = { 'content-type': 'application/json' };
        if (data) headers['content-length'] = Buffer.byteLength(data);
        if (user) headers['x-test-user'] = String(user);
        const req = http.request({ port: server.address().port, path: p, method, headers }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode, json }); });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}
const replayTexts = async () => (await call('GET', `/api/chat/${streamA}/replay?from=${encodeURIComponent('2026-09-20 09:00:00')}&to=${encodeURIComponent('2026-09-21 03:00:00')}`)).json.messages.map((m) => m.message);
const aiRow = (id) => raw.prepare('SELECT 1 FROM vod_ai_state WHERE vod_id = ?').get(id);
const views = (type, id) => raw.prepare('SELECT COUNT(*) AS n FROM content_views WHERE content_type = ? AND content_id = ?').get(type, id).n;

let failures = 0;
async function check(name, fn) {
    try { await fn(); quiet('  ✓', name); } catch (e) { failures++; quiet('  ✗', name, '\n     ', e.stack || e.message); }
}

(async () => {
    await new Promise((r) => server.once('listening', r));
    const all = LINES.map(([, t]) => t);

    await check('chat replay covers the whole stream before any purge', async () => {
        assert.deepStrictEqual(await replayTexts(), all);
    });

    // What the dashboard sends for 10:00–11:00 UTC (new Date(input).toISOString()).
    const range = { from: '2026-09-20T10:00:00.000Z', to: '2026-09-20T11:00:00.000Z' };

    await check('the log filter, the purge preview and the purge agree on an ISO range', async () => {
        const q = new URLSearchParams(range).toString();
        const logs = await call('GET', `/api/chat/admin/logs?${q}`, 3);
        assert.strictEqual(logs.status, 200);
        assert.deepStrictEqual(logs.json.rows.map((r) => r.message).sort(), ['first in range', 'last in range', 'middle']);
        const preview = await call('POST', '/api/chat/admin/purge/preview', 3, range);
        assert.deepStrictEqual(preview.json, { count: 3 }, 'the preview counts exactly the lines in the range');
        const purge = await call('DELETE', '/api/chat/admin/purge', 3, range);
        assert.deepStrictEqual(purge.json, { deleted: 3 }, 'and the purge removes exactly those');
        assert.deepStrictEqual(announced.pop(), [streamA, { type: 'purge', streamId: streamA, ...range, by: 'alice' }], 'live chat is told');
    });

    await check('VOD chat replay no longer shows the purged lines, and still shows every other one', async () => {
        assert.deepStrictEqual(await replayTexts(), ['before', 'just after', 'late that evening', 'after midnight', 'next morning']);
    });

    await check('a range across midnight purges only its own hours, not the whole last day', async () => {
        const overnight = { from: '2026-09-20T23:00:00.000Z', to: '2026-09-21T01:30:00.000Z' };
        assert.deepStrictEqual((await call('POST', '/api/chat/admin/purge/preview', 3, overnight)).json, { count: 2 });
        assert.deepStrictEqual((await call('DELETE', '/api/chat/admin/purge', 3, overnight)).json, { deleted: 2 });
        assert.deepStrictEqual(await replayTexts(), ['before', 'just after', 'next morning'], '02:30 the next morning is kept');
    });

    await check('a clip\'s replay window (SQLite form) still works, and staff see purged lines only on request', async () => {
        const r = await call('GET', `/api/chat/${streamA}/replay?from=${encodeURIComponent('2026-09-20 09:59:00')}&to=${encodeURIComponent('2026-09-20 11:00:05')}`);
        assert.deepStrictEqual(r.json.messages.map((m) => m.message), ['before', 'just after']);
        const staff = await call('GET', `/api/chat/admin/logs?streamId=${streamA}&includeDeleted=true&limit=50`, 1);
        assert.strictEqual(staff.json.total, LINES.length, 'the purge is a soft delete an admin can still audit');
        const owner = await call('GET', `/api/chat/admin/logs?streamId=${streamA}&includeDeleted=true&limit=50`, 3);
        assert.strictEqual(owner.json.total, 3, 'the streamer sees only what is left');
    });

    await check('nobody purges someone else\'s stream', async () => {
        const r = await call('DELETE', '/api/chat/admin/purge', 7, { streamId: streamA, from: '2026-09-20T00:00:00Z', to: '2026-09-22T00:00:00Z' });
        assert.strictEqual(r.status, 403);
        assert.deepStrictEqual(await replayTexts(), ['before', 'just after', 'next morning']);
    });

    const before = db.getVodsNeedingOverview(6).map((r) => r.id);
    await check('deleting a VOD drops Live\'s rows about it, hides its thread and re-reads its Search document', async () => {
        assert.ok(before.includes(100), 'the VOD was queued for an AI overview');
        const r = await call('DELETE', '/api/vods/100', 3);
        assert.strictEqual(r.status, 200);
        assert.ok(!aiRow(100), 'vod_ai_state row gone');
        assert.strictEqual(views('vod', 100), 0, 'unique views gone');
        assert.ok(!db.getVodsNeedingOverview(6).some((row) => row.id === 100), 'no longer at the head of the AI backfill');
        assert.ok(hidden.includes('vod:100') && touched.includes('vod:100'));
    });

    await check('bulk delete and "older than" delete do the same; a delete Media refused keeps everything', async () => {
        const bulk = await call('POST', '/api/vods/bulk', 3, { ids: [101, 104], action: 'delete' });
        assert.deepStrictEqual(bulk.json, { done: 1, skipped: 1 });
        const old = await call('POST', '/api/vods/bulk-delete-old', 3, { olderThanDays: 1, deleteClips: false });
        assert.strictEqual(old.json.deleted.vods, 1);
        for (const id of [101, 103]) {
            assert.ok(!aiRow(id) && views('vod', id) === 0, `VOD ${id}: Live's rows gone`);
            assert.ok(hidden.includes(`vod:${id}`) && touched.includes(`vod:${id}`), `VOD ${id}: thread hidden, Search touched`);
        }
        assert.ok(aiRow(104) && views('vod', 104) === 1 && !hidden.includes('vod:104'), 'Media refused 104: nothing of it is dropped');
        assert.ok(aiRow(102) && views('vod', 102) === 1, 'an untouched VOD keeps its rows');
    });

    await check('deleting a clip drops its AI state (and pending chat announce) and views', async () => {
        const r = await call('DELETE', '/api/clips/200', 3);
        assert.strictEqual(r.status, 200);
        assert.ok(!raw.prepare('SELECT 1 FROM clip_ai_state WHERE clip_id = 200').get());
        assert.strictEqual(views('clip', 200), 0);
        assert.ok(hidden.includes('clip:200') && touched.includes('clip:200'));
    });

    await check('every delete path, the admin storage page included, goes through purge.afterDelete', async () => {
        const root = path.join(__dirname, '..', 'server');
        const admin = fs.readFileSync(path.join(root, 'admin', 'routes.js'), 'utf8');
        assert.match(admin, /await mediaClient\.deleteVod\(id\);\s*purge\.afterDelete\('vod', id\);/);
        assert.match(admin, /await mediaClient\.deleteClip\(id\);\s*purge\.afterDelete\('clip', id\);/);
        for (const f of ['media-proxy/vods.js', 'media-proxy/clips.js', 'admin/routes.js']) {
            const src = fs.readFileSync(path.join(root, f), 'utf8');
            assert.ok(!/hideThreadOf/.test(src), `${f} hides threads only through purge.afterDelete`);
        }
    });

    server.close();
    if (failures) { quiet(`\n${failures} check(s) failed`); process.exit(1); }
    quiet('\nAll replay/purge consistency checks passed');
    process.exit(0);
})().catch((e) => { quiet(e); process.exit(1); });
