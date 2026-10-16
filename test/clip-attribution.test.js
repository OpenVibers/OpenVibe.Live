/**
 * AI clips are never filed as something a person made (roadmap 33.4, 33.6, 33.7).
 *
 * The auto-clip job cuts in the streamer's name (Media user_id = the streamer), so every list that
 * asks Media for "clips by user X" used to show the AI's clips as the streamer's own. Checked here:
 *   - GET /api/clips/mine ("clips I made") holds people's clips only, whatever the query says, and
 *     drops an AI row even when Media ignores the filter;
 *   - GET /api/clips/my-stream splits into the clips people took (?auto_generated=0) and the AI
 *     Moments (?auto_generated=1), each labelled;
 *   - the channel page lists people's clips (by and of the streamer) apart from its AI clips, which
 *     come back as their own labelled list with a total; "Clips Taken" asks for people's clips;
 *   - (the clip page and its attribution line are OpenVibe.Video's since the handover,
 *     server/web/video-handover.js).
 *
 *   node test/clip-attribution.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};
console.error = () => {};

// ── OpenVibe.Media stand-in. `honour` = whether it applies auto_generated (an old Media did not). ──
const CLIPS = [
    { id: 1, user_id: 3, channel_user_id: 3, title: 'AI: chat lost it', visibility: 'public', is_public: true, status: 'ready', auto_generated: true },
    { id: 2, user_id: 3, channel_user_id: 3, title: 'AI: the lights went out', visibility: 'public', is_public: true, status: 'ready', auto_generated: true },
    { id: 3, user_id: 4, channel_user_id: 3, title: 'Bob clipped Alice', visibility: 'public', is_public: true, status: 'ready', auto_generated: false },
    { id: 4, user_id: 3, channel_user_id: 4, title: 'Alice clipped Bob', visibility: 'public', is_public: true, status: 'ready', auto_generated: false },
];
const asked = [];
let honour = true;

const ids = (rows) => (rows || []).map((c) => c.id).sort();

let failures = 0;
async function check(name, fn) {
    try { asked.length = 0; honour = true; await fn(); quiet('  ✓', name); }
    catch (e) { failures++; quiet('  ✗', name, '\n     ', e.stack.split('\n').slice(0, 3).join('\n      ')); }
}

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    const raw = db.getDb();

    // ── Sign-in stub (before any router captures the middleware) ──
    const auth = require('../server/auth/auth');
    const signIn = async (req) => {
        const id = Number(req.headers['x-test-user'] || 0);
        const u = id ? await db.getUserById(id) : null;
        if (u) { req.user = u; req.authSource = 'network'; }
        return u;
    };
    auth.requireAuth = async (req, res, next) => ((await signIn(req)) ? next() : res.status(401).json({ error: 'Authentication required' }));
    auth.optionalAuth = async (req, res, next) => { await signIn(req); next(); };

    const addUser = (id, username, display) => raw.prepare(
        `INSERT INTO users (id, username, display_name, email, password_hash, role, created_at) OVERRIDING SYSTEM VALUE
         VALUES (?, ?, ?, ?, 'x', 'streamer', '2025-01-01 00:00:00')`).run(id, username, display, `${username}@x`);
    await addUser(3, 'alice', 'Alice');
    await addUser(4, 'bob', 'Bob');
    await db.ensureChannel(3);

    const media = require('../server/media-client');
    media.listClips = async (q = {}) => {
        asked.push({ ...q });
        const rows = CLIPS.filter((c) => (q.user_id == null || String(c.user_id) === String(q.user_id))
            && (q.channel_user_id == null || String(c.channel_user_id) === String(q.channel_user_id))
            && (!q.hide_self || c.user_id !== c.channel_user_id)
            && (!honour || q.auto_generated == null || Number(c.auto_generated) === Number(q.auto_generated)));
        return { clips: rows.map((c) => ({ ...c })), total: rows.length };
    };
    media.listVods = async () => ({ vods: [], total: 0 });
    media.request = async () => { throw new media.MediaApiError('stubbed', 0, null); };
    media.getClip = async () => { throw new media.MediaApiError('not found', 404, null); };
    const pastesClient = require('../server/pastes-client');
    pastesClient.request = async () => ({ pastes: [], total: 0 });
    pastesClient.listPastes = async () => ({ pastes: [], total: 0 });

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/clips', require('../server/media-proxy/clips'));
    app.use('/api/streams', require('../server/streaming/routes'));
    const server = http.createServer(app).listen(0);
    function call(p, user) {
        return new Promise((resolve, reject) => {
            const headers = {};
            if (user) headers['x-test-user'] = String(user);
            const req = http.request({ port: server.address().port, path: p, method: 'GET', headers }, (res) => {
                let text = '';
                res.on('data', (c) => { text += c; });
                res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode, json }); });
            });
            req.on('error', reject);
            req.end();
        });
    }

    if (!server.listening) await new Promise((r) => server.once('listening', r));
    quiet('Clip attribution');

    await check('"My Clips" asks Media for people\'s clips only, even when the query asks for AI ones', async () => {
        const r = await call('/api/clips/mine?auto_generated=1', 3);
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(ids(r.json.clips), [4], 'only the clip Alice took');
        assert.strictEqual(asked[0].auto_generated, 0);
        assert.strictEqual(String(asked[0].user_id), '3');
    });

    await check('"My Clips" drops AI rows a Media that ignores the filter still returns', async () => {
        honour = false;
        const r = await call('/api/clips/mine', 3);
        assert.deepStrictEqual(ids(r.json.clips), [4]);
    });

    await check('clips of my stream split into what people took and the AI Moments, each labelled', async () => {
        const people = await call('/api/clips/my-stream?auto_generated=0', 3);
        assert.deepStrictEqual(ids(people.json.clips), [3]);
        assert.ok(people.json.clips.every((c) => c.ai_label === null));
        const ai = await call('/api/clips/my-stream?auto_generated=1', 3);
        assert.deepStrictEqual(ids(ai.json.clips), [1, 2]);
        assert.ok(ai.json.clips.every((c) => c.ai_label === 'AI clip'));
        assert.strictEqual(ai.json.total, 2, 'the count the dashboard shows');
        honour = false;
        const aiLoose = await call('/api/clips/my-stream?auto_generated=1', 3);
        assert.deepStrictEqual(ids(aiLoose.json.clips), [1, 2], 'split holds when Media ignores the filter');
        const both = await call('/api/clips/my-stream', 3);
        assert.deepStrictEqual(ids(both.json.clips), [1, 2, 3], 'no filter: both, labelled');
    });

    await check("the channel page lists people's clips apart from its AI clips", async () => {
        const r = await call('/api/streams/channel/alice');
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(ids(r.json.clips), [4], 'clips by Alice: only the one she took');
        assert.deepStrictEqual(ids(r.json.clipsOfStreams), [3], "clips of Alice's streams: only people's");
        assert.deepStrictEqual(ids(r.json.aiClips), [1, 2], 'the AI clips are their own list');
        assert.strictEqual(r.json.aiClipsTotal, 2);
        assert.ok(r.json.aiClips.every((c) => c.ai_label === 'AI clip' && c.source_streamer_username === 'alice'));
        const clipAsks = asked.filter((q) => 'auto_generated' in q);
        assert.strictEqual(clipAsks.length, 3, 'every clip list says which kind it wants');
        honour = false;
        const loose = await call('/api/streams/channel/alice');
        assert.deepStrictEqual(ids(loose.json.clips), [4]);
        assert.deepStrictEqual(ids(loose.json.clipsOfStreams), [3]);
        assert.deepStrictEqual(ids(loose.json.aiClips), [1, 2]);
    });

    await check('"Clips Taken" asks for the clips a person took', async () => {
        const r = await call('/api/streams/channel/alice/clips-taken?includeSelf=1');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(asked[0].auto_generated, 0);
        assert.ok(!r.json.clips.some((c) => c.auto_generated), 'no AI clip');
    });

    server.close();
    quiet(failures ? `\n${failures} check(s) failed` : '\nclip attribution: all checks passed');
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
