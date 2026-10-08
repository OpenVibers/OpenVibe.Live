/**
 * Legacy parity (roadmap D20): deleting a VOD or clip keeps Live's rows, its comment thread and its
 * Search document consistent.
 *
 * Media deletes the item; Live used to only hide the comment thread, and kept its own rows: the AI
 * state the backfill takes newest-first (a deleted VOD's row sat at the head of the overview queue
 * for good) and the unique views. The admin storage page and the "older than" action also left the
 * item's Search document until the daily refresh. Every delete path now goes through
 * server/media-proxy/purge.js.
 *
 * (The chat purge ↔ VOD chat replay half moved with Live's /api/chat routes: OpenVibe.Chat serves
 * them and covers that consistency in its own suite.)
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
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

let failures = 0;
async function check(name, fn) {
    try { await fn(); quiet('  ✓', name); } catch (e) { failures++; quiet('  ✗', name, '\n     ', e.stack || e.message); }
}

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    const raw = db.getDb();

    const auth = require('../server/auth/auth');
    const signIn = async (req) => {
        const id = Number(req.headers['x-test-user'] || 0);
        const u = id ? await db.getUserById(id) : null;
        if (u) { req.user = u; req.authSource = 'network'; }
        return u;
    };
    auth.requireAuth = async (req, res, next) => ((await signIn(req)) ? next() : res.status(401).json({ error: 'Authentication required' }));
    auth.optionalAuth = async (req, res, next) => { await signIn(req); next(); };

    const addUser = (id, username, role) => raw.prepare(
        `INSERT INTO users (id, username, display_name, email, password_hash, role, created_at) OVERRIDING SYSTEM VALUE
         VALUES (?, ?, ?, ?, 'x', ?, '2025-01-01 00:00:00')`).run(id, username, username, `${username}@x`, role);
    await addUser(1, 'admin', 'admin');
    await addUser(3, 'alice', 'streamer');
    await addUser(7, 'mallory', 'streamer');
    await db.ensureChannel(3);
    await db.ensureChannel(7);
    const streamA = Number((await db.createStream({ user_id: 3, channel_id: (await db.getChannelByUserId(3)).id, title: 'A', protocol: 'webrtc' })).lastInsertRowid);
    await raw.prepare("UPDATE streams SET started_at = '2026-09-20 09:00:00', ended_at = '2026-09-21 03:00:00', is_live = 0 WHERE id = ?").run(streamA);
    Number((await db.createStream({ user_id: 7, channel_id: (await db.getChannelByUserId(7)).id, title: 'M', protocol: 'webrtc' })).lastInsertRowid);

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
        await raw.prepare("INSERT INTO vod_ai_state (vod_id, transcript_status) VALUES (?, 'pending')").run(id);
        await raw.prepare("INSERT INTO content_views (content_type, content_id, ip) VALUES ('vod', ?, '10.0.0.1')").run(id);
    }
    await raw.prepare("INSERT INTO clip_ai_state (clip_id, transcript_status) VALUES (200, 'pending')").run();
    await raw.prepare("INSERT INTO content_views (content_type, content_id, ip) VALUES ('clip', 200, '10.0.0.1')").run();

    const express = require('express');
    const app = express();
    app.use(express.json());
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
    const aiRow = async (id) => await raw.prepare('SELECT 1 FROM vod_ai_state WHERE vod_id = ?').get(id);
    const views = async (type, id) => (await raw.prepare('SELECT COUNT(*) AS n FROM content_views WHERE content_type = ? AND content_id = ?').get(type, id)).n;

    await new Promise((r) => server.once('listening', r));

    // Deleting replays: Live's rows about each item, its comment thread and its Search document.
    const before = (await db.getVodsNeedingOverview(6)).map((r) => r.id);
    await check('deleting a VOD drops Live\'s rows about it, hides its thread and re-reads its Search document', async () => {
        assert.ok(before.includes(100), 'the VOD was queued for an AI overview');
        const r = await call('DELETE', '/api/vods/100', 3);
        assert.strictEqual(r.status, 200);
        assert.ok(!(await aiRow(100)), 'vod_ai_state row gone');
        assert.strictEqual(await views('vod', 100), 0, 'unique views gone');
        assert.ok(!(await db.getVodsNeedingOverview(6)).some((row) => row.id === 100), 'no longer at the head of the AI backfill');
        assert.ok(hidden.includes('vod:100') && touched.includes('vod:100'));
    });

    await check('bulk delete and "older than" delete do the same; a delete Media refused keeps everything', async () => {
        const bulk = await call('POST', '/api/vods/bulk', 3, { ids: [101, 104], action: 'delete' });
        assert.deepStrictEqual(bulk.json, { done: 1, skipped: 1 });
        const old = await call('POST', '/api/vods/bulk-delete-old', 3, { olderThanDays: 1, deleteClips: false });
        assert.strictEqual(old.json.deleted.vods, 1);
        for (const id of [101, 103]) {
            assert.ok(!(await aiRow(id)) && (await views('vod', id)) === 0, `VOD ${id}: Live's rows gone`);
            assert.ok(hidden.includes(`vod:${id}`) && touched.includes(`vod:${id}`), `VOD ${id}: thread hidden, Search touched`);
        }
        assert.ok((await aiRow(104)) && (await views('vod', 104)) === 1 && !hidden.includes('vod:104'), 'Media refused 104: nothing of it is dropped');
        assert.ok((await aiRow(102)) && (await views('vod', 102)) === 1, 'an untouched VOD keeps its rows');
    });

    await check('deleting a clip drops its AI state (and pending chat announce) and views', async () => {
        const r = await call('DELETE', '/api/clips/200', 3);
        assert.strictEqual(r.status, 200);
        assert.ok(!(await raw.prepare('SELECT 1 FROM clip_ai_state WHERE clip_id = 200').get()));
        assert.strictEqual(await views('clip', 200), 0);
        assert.ok(hidden.includes('clip:200') && touched.includes('clip:200'));
    });

    await check('every delete path, the admin storage page included, goes through purge.afterDelete', async () => {
        const root = path.join(__dirname, '..', 'server');
        const admin = fs.readFileSync(path.join(root, 'admin', 'routes.js'), 'utf8');
        assert.match(admin, /await mediaClient\.deleteVod\(id\);\s*await purge\.afterDelete\('vod', id\);/);
        assert.match(admin, /await mediaClient\.deleteClip\(id\);\s*await purge\.afterDelete\('clip', id\);/);
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
