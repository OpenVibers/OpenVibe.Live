/**
 * A streamer can turn AI Moments off for their channel (roadmap 33.7, 33.10 acceptance: "a creator
 * can disable derivation for a channel"). channels.ai_derivation_enabled, on by default, set from
 * the dashboard through PUT /api/streams/channel, is read by every job that makes Moments:
 *   - the auto-clip job (live spikes, VOD backfill pool, clipVodMoment) cuts nothing;
 *   - the AI moments job never picks the channel's VODs (so no moment pastes, no clips from them);
 *   - the stream-memory job posts no "caught live" pastes;
 *   - the after-show report is the stats-only one (no model call, not an AI Moment).
 * Channels that did not opt out are unaffected. The channel page's category pill says "inferred"
 * when the AI chose it (public/js/app-channel.js, run against a small stand-in DOM).
 *
 *   node test/ai-derivation-optout.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');

const tmp = path.join(os.tmpdir(), `ov-ai-optout-${process.pid}.db`);
process.env.DB_PATH = tmp;
process.env.NODE_ENV = 'test';
delete process.env.AI_SERVICE;
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};
console.error = () => {};

const db = require('../server/db/database');
db.initDb();
const raw = db.getDb();

const auth = require('../server/auth/auth');
const signIn = (req) => { const id = Number(req.headers['x-test-user'] || 0); const u = id ? db.getUserById(id) : null; if (u) req.user = u; return u; };
auth.requireAuth = (req, res, next) => (signIn(req) ? next() : res.status(401).json({ error: 'Authentication required' }));
auth.optionalAuth = (req, res, next) => { signIn(req); next(); };

const addUser = (id, username) => raw.prepare(
    `INSERT INTO users (id, username, display_name, email, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, 'x', 'streamer', '2025-01-01 00:00:00')`).run(id, username, username, `${username}@x`);
addUser(3, 'alice');     // keeps AI Moments on (the default)
addUser(4, 'olive');     // opts out
addUser(5, 'nochan');    // no channel row at all
db.ensureChannel(3);
db.ensureChannel(4);
const mkStream = (userId, title) => {
    const ch = db.getChannelByUserId(userId);
    const id = Number(db.createStream({ user_id: userId, channel_id: ch.id, title, protocol: 'rtmp' }).lastInsertRowid);
    return id;
};
const sAlice = mkStream(3, 'Alice live'), sOlive = mkStream(4, 'Olive live');
for (const [sid, uid] of [[sAlice, 3], [sOlive, 4]]) db.addStreamMemory({ stream_id: sid, user_id: uid, offset_seconds: 60, description: 'a scene' });

// ── Stand-ins: Media, Community, the recorder, the model ──
const media = require('../server/media-client');
const created = [];
media.createClip = async (body) => { created.push(body); return { id: 900 + created.length, status: 'processing' }; };
media.listVods = async () => ({ vods: [
    { id: 10, user_id: 3, stream_id: sAlice, title: 'Alice VOD', visibility: 'public', is_public: true, view_count: 5, duration_seconds: 600, status: 'ready' },
    { id: 11, user_id: 4, stream_id: sOlive, title: 'Olive VOD', visibility: 'public', is_public: true, view_count: 9, duration_seconds: 600, status: 'ready' },
] });
media.listClips = async () => ({ clips: [] });
media.getVod = async () => { throw new media.MediaApiError('stubbed', 0, null); };
media.request = async () => { throw new media.MediaApiError('stubbed', 0, null); };
const pastesClient = require('../server/pastes-client');
const posted = [];
pastesClient.createPaste = async (fields, opts) => { posted.push({ fields, opts }); return { slug: `p${posted.length}` }; };
const recorder = require('../server/streaming/recorder');
const recorderAsked = [];
recorder.getActiveRecording = (streamId) => { recorderAsked.push(streamId); return null; };
db.isStreamClipRecordingEnabled = () => true;
const llm = require('../server/ai/llm');
const modelCalls = [];
llm.isEnabled = () => true;
llm.withinBudget = () => true;
llm.complete = async (o) => { modelCalls.push(o); return { json: { headline: 'What a night', summary: 'Chat was loud.', moment: '', tags: ['loud'], grade: 'A' } }; };

const autoClip = require('../server/ai/auto-clip-job');
const moments = require('../server/ai/ai-moments-job');
const memory = require('../server/ai/stream-memory-job');
const recap = require('../server/recap/recap');

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/streams', require('../server/streaming/routes'));
const server = http.createServer(app).listen(0);
function call(method, p, user, body) {
    return new Promise((resolve, reject) => {
        const headers = { 'content-type': 'application/json' };
        if (user) headers['x-test-user'] = String(user);
        const req = http.request({ port: server.address().port, path: p, method, headers }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode, json }); });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

let failures = 0;
async function check(name, fn) {
    try { await fn(); quiet('  ✓', name); }
    catch (e) { failures++; quiet('  ✗', name, '\n     ', e.stack.split('\n').slice(0, 3).join('\n      ')); }
}

(async () => {
    await new Promise((r) => server.once('listening', r));
    quiet('AI derivation opt-out');

    await check('on by default, for every channel and for an account with no channel row', () => {
        const cols = raw.prepare("PRAGMA table_info('channels')").all();
        const col = cols.find((c) => c.name === 'ai_derivation_enabled');
        assert.ok(col, 'channels.ai_derivation_enabled exists');
        assert.strictEqual(String(col.dflt_value), '1');
        assert.strictEqual(db.isAiDerivationEnabled(3), true);
        assert.strictEqual(db.isAiDerivationEnabled(5), true);
    });

    await check('the streamer turns it off (and on) from the dashboard: PUT /api/streams/channel', async () => {
        const off = await call('PUT', '/api/streams/channel', 4, { ai_derivation_enabled: 0 });
        assert.strictEqual(off.status, 200);
        assert.strictEqual(Number(off.json.channel.ai_derivation_enabled), 0);
        assert.strictEqual(db.isAiDerivationEnabled(4), false);
        const mine = await call('GET', '/api/streams/channel', 4);
        assert.strictEqual(Number(mine.json.ai_derivation_enabled), 0, 'the dashboard reads it back');
        await call('PUT', '/api/streams/channel', 3, { ai_derivation_enabled: 'true' });
        assert.strictEqual(db.isAiDerivationEnabled(3), true);
        const other = await call('PUT', '/api/streams/channel', 3, { title: 'x' });
        assert.strictEqual(other.status, 200);
        assert.strictEqual(db.isAiDerivationEnabled(4), false, "one streamer's save never touches another's");
    });

    await check('the auto-clip job skips an opted-out live stream before touching its recording', async () => {
        recorderAsked.length = 0;
        await autoClip._internals.checkLiveStream(db.getStreamById(sOlive));
        assert.deepStrictEqual(recorderAsked, [], 'opted out: never looked');
        await autoClip._internals.checkLiveStream(db.getStreamById(sAlice));
        assert.deepStrictEqual(recorderAsked, [sAlice], 'opted in: checked as before');
    });

    await check('the auto-clip job cuts nothing from an opted-out VOD, and still cuts for others', async () => {
        // (asked first: once a VOD has an auto-clip the pool skips it)
        const pool = await autoClip._internals.backfillPool(5);
        assert.deepStrictEqual(pool.map((v) => v.vod_id), [10], 'the VOD backfill pool leaves the opted-out channel out');
        created.length = 0;
        const none = await autoClip.clipVodMoment({ vod: { vod_id: 11, user_id: 4, stream_id: sOlive }, offset: 300, title: 'Olive moment' });
        assert.strictEqual(none, null);
        assert.strictEqual(created.length, 0);
        const clip = await autoClip.clipVodMoment({ vod: { vod_id: 10, user_id: 3, stream_id: sAlice }, offset: 300, title: 'Alice moment' });
        assert.ok(clip && clip.id, 'Alice still gets auto-clips');
        assert.strictEqual(created.length, 1);
        assert.strictEqual(created[0].auto_generated, true);
    });

    await check("the AI moments job never picks an opted-out channel's VODs", async () => {
        const pool = await moments._internals.momentPool(10);
        assert.deepStrictEqual(pool.map((v) => v.vod_id), [10]);
    });

    await check('no "caught live" paste from an opted-out stream', async () => {
        posted.length = 0;
        const frame = Buffer.alloc(4000, 7);
        const r = { worthy: true, title: 'Lights out', description: 'The lights go out mid-sentence.', tags: ['dark'] };
        await memory._internals.maybeLivePaste({ ...db.getStreamById(sOlive), username: 'olive' }, frame, r, 120);
        assert.strictEqual(posted.length, 0);
        await memory._internals.maybeLivePaste({ ...db.getStreamById(sAlice), username: 'alice' }, frame, r, 120);
        assert.strictEqual(posted.length, 1, 'opted in: posted as before');
        assert.strictEqual(posted[0].opts.origin, 'ai');
    });

    await check('an opted-out channel gets the stats-only after-show report: no model call, not AI', async () => {
        db.endStream(sOlive); db.endStream(sAlice);
        modelCalls.length = 0;
        const out = await recap.buildRecap(sOlive);
        assert.ok(out, 'a report is still made');
        assert.strictEqual(out.ai, false);
        assert.strictEqual(modelCalls.length, 0);
        assert.strictEqual(raw.prepare('SELECT ai FROM stream_recaps WHERE stream_id = ?').get(sOlive).ai, 0);
        const theirs = await recap.buildRecap(sAlice);
        assert.strictEqual(theirs.ai, true, 'opted in: the AI writes it');
        assert.strictEqual(modelCalls.length, 1);
    });

    await check('the channel page marks an AI-inferred category "inferred", and a chosen one plain', () => {
        const src = fs.readFileSync(path.join(__dirname, '../public/js/app-channel.js'), 'utf8');
        const start = src.indexOf('function _isInferredCategory(');
        const end = src.indexOf('\n}\n', src.indexOf('function _setCategoryBadge(')) + 3;
        class El {
            constructor() { this.children = []; this.attrs = {}; this.cls = new Set(); this.className = ''; this.classList = { toggle: (c, on) => (on ? this.cls.add(c) : this.cls.delete(c)) }; }
            set textContent(v) { this.children = [String(v)]; }
            get textContent() { return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
            append(n) { this.children.push(n); }
            set title(v) { this.attrs.title = v; }
            removeAttribute(k) { delete this.attrs[k]; }
        }
        const ctx = { document: { createElement: () => new El() }, _capTag: (x) => x.charAt(0).toUpperCase() + x.slice(1) };
        vm.createContext(ctx);
        vm.runInContext(`${src.slice(start, end)}\nthis.set = _setCategoryBadge; this.inferred = _isInferredCategory;`, ctx);
        const el = new El();
        ctx.set(el, 'gaming', ctx.inferred({ category: 'gaming', ai_category: 'gaming' }));
        assert.strictEqual(el.textContent, 'Gaming · inferred');
        assert.ok(el.cls.has('is-inferred') && /inferred by OpenVibe/.test(el.attrs.title));
        const chosen = new El();
        ctx.set(chosen, 'irl', ctx.inferred({ category: 'irl', ai_category: null }));
        assert.strictEqual(chosen.textContent, 'Irl');
        assert.ok(!chosen.cls.has('is-inferred') && !chosen.attrs.title);
    });

    server.close();
    try { fs.unlinkSync(tmp); } catch { /* */ }
    for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch { /* */ } }
    quiet(failures ? `\n${failures} check(s) failed` : '\nAI derivation opt-out: all checks passed');
    process.exit(failures ? 1 : 0);
})();
