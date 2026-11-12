'use strict';
/**
 * The Rundown's episode pictures (server/rundown/pictures.js) on a temp DB, with recorded AI answers, no network:
 *   requests      the episode's words and the style make the prompt; model, size, cap and Idempotency-Key go along
 *   storage       the answer is resized to 1200×630 and uploaded through Media; the episode read carries it
 *   one per episode  a second ensure/tick never makes a second picture; the same idempotency key is reused after a
 *                 storage failure, so the provider is asked once
 *   refusals      explicit.js's sex acts and any mention of a minor refuse before any prompt leaves Live; a provider
 *                 safety refusal is final, not retried
 *   cap           the month's spend stops the job and waits for the next month
 *   back-off      a network failure waits; the next tick before it is due asks nothing; four failures are final
 *   admin         the settings and the remake are owner-only, validated before they are written
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};
// console.error suppressed only after a failure is printed

const db = require('../server/db/database');
const auth = require('../server/auth/auth');
const permissions = require('../server/auth/permissions');
const pictures = require('../server/rundown/pictures');
assert.ok(permissions.isSensitiveSettingKey('rundown_picture_enabled') && permissions.isSensitiveSettingKey('rundown_picture_monthly_cap_usd'), 'the picture keys are owner-only in the general settings path too');
const media = require('../server/media-client');
const ai = require('../server/ai/ai-service');
const read = require('../server/rundown/read');
const fixtures = require('./fixtures/rundown-pictures');
const principal = require('../server/net/network-principal');

// ── The AI request itself: the model, size, cap and Idempotency-Key, against recorded answers ─
async function aiRequestTest() {
    let seen = null;
    let reply = { status: 200, body: fixtures.IMAGE_RESPONSE };
    const srv = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            seen = { method: req.method, path: req.url, headers: req.headers, body: JSON.parse(body || '{}') };
            res.statusCode = reply.status;
            res.setHeader('content-type', 'application/json');
            res.end(reply.body);
        });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const oldUrl = process.env.OV_AI_INTERNAL_URL;
    process.env.OV_AI_INTERNAL_URL = `http://127.0.0.1:${srv.address().port}`;
    const oldHeaders = principal.serviceHeaders;
    principal.serviceHeaders = async () => ({ Authorization: 'Bearer test' });
    const realImage = ai.image;
    try {
        const got = await ai.image({ prompt: 'a fridge in a courtroom', model: 'openai/gpt-image-1-mini', size: '1536x1024', n: 1, maxCostUsd: 2.5, idempotencyKey: 'rundown-picture:42:1' });
        assert.strictEqual(got.ok, true);
        assert.strictEqual(got.cost_usd, 0.042);
        assert.strictEqual(got.run_id, 'run_pic_fixture');
        assert.strictEqual(seen.method, 'POST');
        assert.strictEqual(seen.path, '/v1/images/generations');
        assert.strictEqual(seen.headers['idempotency-key'], 'rundown-picture:42:1');
        assert.strictEqual(seen.body.model, 'openai/gpt-image-1-mini');
        assert.strictEqual(seen.body.size, '1536x1024');
        assert.strictEqual(seen.body.n, 1);
        assert.strictEqual(seen.body.max_cost_usd, 2.5);
        assert.strictEqual(seen.body.response_format, 'b64_json');
        reply = { status: 400, body: fixtures.REFUSAL_RESPONSE };
        const refused = await ai.image({ prompt: 'a thing', model: 'openai/gpt-image-1-mini', size: '1536x1024', idempotencyKey: 'rundown-picture:43:1' });
        assert.strictEqual(refused.ok, false);
        assert.strictEqual(refused.status, 400);
        assert.strictEqual(refused.code, 'provider.http');
        assert.ok(/safety system/i.test(refused.detail));
    } finally {
        ai.image = realImage;
        principal.serviceHeaders = oldHeaders;
        if (oldUrl === undefined) delete process.env.OV_AI_INTERNAL_URL; else process.env.OV_AI_INTERNAL_URL = oldUrl;
        srv.close();
    }
}

const settings = async (patch = {}) => {
    const st = await pictures.settings();
    for (const [k, v] of Object.entries(patch)) await db.setSetting(pictures.SETTINGS[k], v == null ? '' : String(v));
    return { ...st, ...patch };
};

(async () => {
await db.initDb();
await db.setSetting('ai_enabled', 'true');
await settings({ enabled: true, model: 'openai/gpt-image-1-mini', size: '1536x1024', style: 'thick ink lines and flat colour', monthly_cap_usd: 5 });

const mk = async (username, display) => {
    await db.createUser({ username, email: `${username}@x`, password_hash: 'x', display_name: display || username, stream_key: username.padEnd(32, '0') });
    const id = (await db.get('SELECT id FROM users WHERE username = ?', [username])).id;
    await db.ensureChannel(id);
    return id;
};
const goose = await mk('goosely', 'goosely');
const stream = async (title, live = false) => {
    const id = Number((await db.createStream({ user_id: goose, title, category: 'Science & Technology', protocol: 'rtmp' })).lastInsertRowid);
    await db.run(`UPDATE streams SET is_live = ?, started_at = datetime('now', '-2 hours'), ended_at = ${live ? 'NULL' : "datetime('now', '-1 hour')"}, duration_seconds = 3600 WHERE id = ?`, [live ? 1 : 0, id]);
    return id;
};
const writeEpisode = async (streamId, word) => {
    await db.run(`INSERT INTO rundown_episodes (stream_id, user_id, title, logline, recap, chapters_json, vod_id, minutes, aired_at)
        VALUES (?, ?, ?, ?, ?, '[]', 99, 60, ov_now())`, [streamId, goose, `${word}: the case against smooth apologies`, `A night of ${word}.`, `He opened with ${word} and then ranked.`]);
    await db.run(`INSERT INTO rundown_segments (stream_id, user_id, topic_id, start_sec, end_sec, title, what, take, score, quotes_json, mentions, said_at)
        VALUES (?, ?, NULL, 0, 20, ?, ?, ?, 4, '[]', '{}', ov_now())`, [streamId, goose, `The ${word} bit`, `He read about ${word}.`, `He thinks ${word} should stay offline.`]);
    return await db.get('SELECT * FROM rundown_episodes WHERE stream_id = ?', [streamId]);
};

let imageCalls = [], runCalls = [], uploads = [];
const setImage = (impl) => { ai.image = async (o) => { imageCalls.push(o); return impl(o); }; };
const setRun = (impl = async () => null) => { ai.run = async (workflow, input, opts) => { runCalls.push({ workflow, input, opts }); return impl(workflow, input, opts); }; };
const resetCalls = () => { imageCalls = []; runCalls = []; uploads = []; };
media.uploadFile = async (file, fields) => { uploads.push({ size: file.buffer.length, fields }); return { key: 'rundown-test.jpg', url: '/f/rundown-test.jpg' }; };
media.publicUrl = (u) => (u ? (String(u).startsWith('https://') ? String(u) : `https://openvibe.media${u}`) : null);
setRun();
setImage(async () => ({ ok: true, b64: fixtures.PNG_1X1, model: 'gpt-image-1-mini', cost_usd: 0.04, run_id: 'run_pic_1' }));

// ── Requests, storage, one picture ───────────────────────────
const s1 = await stream('Smooth apologies');
const e1 = await writeEpisode(s1, 'apologies');
await pictures.ensure({ id: s1, user_id: goose }, { id: goose }, e1, [{ title: 'Smooth apologies' }]);
let out = await pictures.tick({ force: true, streamId: s1 });
assert.strictEqual(out.status, 'done', 'the picture is made');
assert.strictEqual(imageCalls.length, 1, 'one request');
assert.strictEqual(imageCalls[0].model, 'openai/gpt-image-1-mini');
assert.strictEqual(imageCalls[0].size, '1536x1024');
assert.strictEqual(imageCalls[0].maxCostUsd, 5, 'the month cap is left as the ceiling');
assert.ok(/apologies/i.test(imageCalls[0].prompt), 'the episode title is in the prompt');
assert.ok(/thick ink lines/i.test(imageCalls[0].prompt), 'the style line is in the prompt');
assert.ok(/no real person/i.test(imageCalls[0].prompt) && /no minors/i.test(imageCalls[0].prompt), 'the hard rules are in the prompt');
assert.ok(/^rundown-picture:/.test(imageCalls[0].idempotencyKey), 'an idempotency key is sent');
assert.strictEqual(uploads.length, 1, 'the picture goes through Media');
assert.ok(uploads[0].size > 500, 'the 1×1 answer is resized to a real JPEG');
const row = await db.get('SELECT * FROM rundown_pictures WHERE stream_id = ?', [s1]);
assert.strictEqual(row.status, 'done');
assert.strictEqual(row.media_url, 'https://openvibe.media/f/rundown-test.jpg');
assert.strictEqual(Number(row.cost_usd), 0.04);
const feed = await read.streamsFeed({});
assert.strictEqual(feed.streams[0].episode.picture_url, 'https://openvibe.media/f/rundown-test.jpg', 'the episode read carries the picture');
const episode = await read.episode(s1);
assert.strictEqual(episode.episode.picture_url, 'https://openvibe.media/f/rundown-test.jpg');

resetCalls();
await pictures.ensure({ id: s1, user_id: goose }, { id: goose }, e1, [{ title: 'Smooth apologies' }]);
out = await pictures.tick({ force: true, streamId: s1 });
assert.strictEqual(imageCalls.length, 0, 'a done episode is never asked for again');
assert.strictEqual(out.processed, 0);

// ── A storage failure reuses the idempotency key ─────────────
const s2 = await stream('Fridge security');
const e2 = await writeEpisode(s2, 'fridges');
await pictures.ensure({ id: s2, user_id: goose }, { id: goose }, e2, [{ title: 'Fridge security' }]);
const realUpload = media.uploadFile;
media.uploadFile = async () => { throw new Error('Media is down'); };
out = await pictures.tick({ force: true, streamId: s2 });
assert.strictEqual(out.status, 'retry');
const firstKey = imageCalls[0].idempotencyKey;
media.uploadFile = realUpload;
out = await pictures.tick({ force: true, streamId: s2 });
assert.strictEqual(out.status, 'done');
assert.strictEqual(imageCalls[1].idempotencyKey, firstKey, 'the retry is the same AI run, never a second charge');

// ── Refusals: explicit words and a minor, before any request ─
resetCalls();
const s3 = await stream('Porn and the fridge');
const e3 = await writeEpisode(s3, 'porn');
await pictures.ensure({ id: s3, user_id: goose }, { id: goose }, e3, []);
out = await pictures.tick({ force: true, streamId: s3 });
assert.strictEqual(out.processed, 0, 'a refused row is not due');
assert.strictEqual(imageCalls.length, 0, 'explicit words never leave Live');
assert.strictEqual((await db.get('SELECT status FROM rundown_pictures WHERE stream_id = ?', [s3])).status, 'refused');

const s3b = await stream('The kid at the shop');
const e3b = await writeEpisode(s3b, 'kid');
await pictures.ensure({ id: s3b, user_id: goose }, { id: goose }, e3b, []);
out = await pictures.tick({ force: true, streamId: s3b });
assert.strictEqual(out.processed, 0, 'a refused row is not due');
assert.strictEqual(imageCalls.length, 0, 'a minor in the words is never pictured');
assert.strictEqual((await db.get('SELECT status FROM rundown_pictures WHERE stream_id = ?', [s3b])).status, 'refused');

// A provider's safety refusal is final too.
const s4 = await stream('A provider refusal');
const e4 = await writeEpisode(s4, 'refusal');
await pictures.ensure({ id: s4, user_id: goose }, { id: goose }, e4, []);
setImage(async () => ({ ok: false, status: 400, code: 'provider.http', detail: 'Your request was rejected by the safety system.' }));
resetCalls();
out = await pictures.tick({ force: true, streamId: s4 });
assert.strictEqual(out.status, 'refused');
assert.strictEqual(imageCalls.length, 1);
assert.strictEqual((await db.get('SELECT status FROM rundown_pictures WHERE stream_id = ?', [s4])).status, 'refused');

// ── The monthly cap stops the job until next month ────────────
const s5 = await stream('Over the cap');
const e5 = await writeEpisode(s5, 'cap');
await settings({ monthly_cap_usd: 0.04 });
await pictures.ensure({ id: s5, user_id: goose }, { id: goose }, e5, []);
setImage(async () => ({ ok: true, b64: fixtures.PNG_1X1, cost_usd: 0.01 }));
resetCalls();
out = await pictures.tick({ force: true, streamId: s5 });
assert.strictEqual(out.status, 'cap');
assert.strictEqual(imageCalls.length, 0, 'no request over the cap');
const capRow = await db.get('SELECT * FROM rundown_pictures WHERE stream_id = ?', [s5]);
assert.strictEqual(capRow.status, 'pending');
assert.ok(capRow.next_attempt_at > new Date().toISOString().slice(0, 19), 'it waits for the next month');
await settings({ monthly_cap_usd: 5 });

// ── Back-off: a network failure waits, and four are final ─────
const s6 = await stream('A network failure');
const e6 = await writeEpisode(s6, 'failure');
await pictures.ensure({ id: s6, user_id: goose }, { id: goose }, e6, []);
setImage(async () => ({ ok: false, status: 0, code: 'ai.unreachable', detail: 'connect ECONNREFUSED' }));
resetCalls();
out = await pictures.tick({ force: true, streamId: s6 });
assert.strictEqual(out.status, 'retry');
const retryRow = await db.get('SELECT * FROM rundown_pictures WHERE stream_id = ?', [s6]);
assert.strictEqual(retryRow.attempts, 1);
const retryAt = Date.parse(`${String(retryRow.next_attempt_at).replace(' ', 'T')}Z`);
assert.ok(retryAt >= Date.now() + 5 * 60_000, 'a failed attempt waits');
out = await pictures.tick();
assert.strictEqual(out.processed, 0, 'the due time is respected: nothing is retried at once');
for (let i = 0; i < 3; i++) await pictures.tick({ force: true, streamId: s6 });
assert.strictEqual((await db.get('SELECT status FROM rundown_pictures WHERE stream_id = ?', [s6])).status, 'failed', 'four failures are final');

// ── The fallback: the named model has no route, the workflow answers ─
const s7 = await stream('Fallback picture');
const e7 = await writeEpisode(s7, 'fallback');
await pictures.ensure({ id: s7, user_id: goose }, { id: goose }, e7, []);
setImage(async () => ({ ok: false, status: 503, code: 'route.unavailable', detail: 'no image route for that model' }));
setRun(async () => ({ id: 'run_fb', status: 'succeeded', output: { images: [{ b64: fixtures.PNG_1X1, url: null }], count: 1 }, usage: { cost_usd: 0.02 }, provenance: { model: 'shared-image' } }));
resetCalls();
out = await pictures.tick({ force: true, streamId: s7 });
assert.strictEqual(out.status, 'done');
assert.strictEqual(runCalls.length, 1, 'the ordinary ai.image workflow is asked once');
assert.strictEqual(runCalls[0].workflow, 'ai.image');
setRun();

// ── The admin settings and the remake are owner-only ─────────
const signIn = async (req) => {
    const id = Number(req.headers['x-test-user'] || 0);
    const u = id ? await db.getUserById(id) : null;
    if (u) req.user = { ...u, subject_id: `usr_TEST${String(id).padStart(22, '0')}` };
    return u;
};
auth.requireAuth = async (req, res, next) => ((await signIn(req)) ? next() : res.status(401).json({ error: 'Authentication required' }));
const siteConfig = require('../server/admin/site-config');
siteConfig.change = async ({ set }) => { for (const [k, v] of Object.entries(set)) await db.setSetting(k, v); return { revision: 1 }; };
const picturesTick = pictures.tick;
pictures.tick = async () => ({ skipped: 'test' });
const adminRouter = require('../server/rundown/admin').router;
const app = express();
app.use(express.json());
app.use('/api/admin/rundown', adminRouter);
const server = http.createServer(app).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api/admin/rundown`;
const call = async (method, path, body, user = 1) => {
    const r = await fetch(base + path, { method, headers: { 'x-test-user': String(user), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
};
const owner = await mk('owner', 'owner');
const helper = await mk('helper', 'helper');
await db.run("UPDATE users SET role = 'admin', is_owner = 1 WHERE id = ?", [owner]);
await db.run("UPDATE users SET role = 'admin', is_owner = 0 WHERE id = ?", [helper]);
let r = await call('GET', '', undefined, helper);
assert.strictEqual(r.status, 403, 'a non-owner admin cannot read the picture settings');
r = await call('PUT', '/settings', { settings: { enabled: false } }, helper);
assert.strictEqual(r.status, 403, 'a non-owner admin cannot write them');
r = await call('GET', '', undefined, owner);
assert.strictEqual(r.status, 200);
assert.ok(r.body.settings && typeof r.body.settings.enabled === 'boolean');
assert.ok(r.body.spend && typeof r.body.spend.usd === 'number');
assert.ok(Array.isArray(r.body.pictures));
r = await call('PUT', '/settings', { settings: { size: 'huge' } }, owner);
assert.strictEqual(r.status, 400, 'an invalid size is refused');
r = await call('PUT', '/settings', { settings: { enabled: false, model: 'openai/gpt-image-1', size: '1024x1024', style: 'paper cut-outs', monthly_cap_usd: 2.5 } }, owner);
assert.strictEqual(r.status, 200);
assert.deepStrictEqual([r.body.settings.enabled, r.body.settings.model, r.body.settings.size, r.body.settings.style, r.body.settings.monthly_cap_usd], [false, 'openai/gpt-image-1', '1024x1024', 'paper cut-outs', 2.5]);
r = await call('POST', `/episodes/${s2}/remake`, {}, owner);
assert.strictEqual(r.status, 202);
assert.strictEqual(r.body.picture.status, 'pending');
assert.strictEqual(r.body.picture.attempts, 0);
r = await call('POST', '/episodes/999999/remake', {}, owner);
assert.strictEqual(r.status, 404);
pictures.tick = picturesTick;
server.close();

console.log('rundown pictures: requests, storage, one per episode, refusals, cap, back-off and owner-only ok');
process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
