'use strict';
// The Arena judges are OpenVibe.AI templates (roadmap WS-O task 2): against a stub Network (token endpoint) and a
// stub AI, judgeMic and judgeBeef send live.arena.judge_mic / judge_beef with what Live heard (never a prompt), attributed
// to the speaker; the answer goes through Live's house rules (quotable line, clamp); no answer falls back to the
// heuristic.
//   node test/arena-judge-ai.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { serviceAuth } = require('openvibe-contracts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-live-arena-ai-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.NODE_ENV = 'test';
process.env.OV_OAUTH_CLIENT_ID = 'live';
process.env.OV_OAUTH_CLIENT_SECRET = 'live-secret';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const runs = [];
let answer = null;
const network = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        const f = new URLSearchParams(raw); const now = Math.floor(Date.now() / 1000);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ access_token: serviceAuth.signServiceToken({ iss: 'https://openvibe.network', sub: 'svc:live', actor_type: 'service', aud: [f.get('audience')], cap: ['ai.run.create'], iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(6).toString('hex')}` }, keys.privateKey), token_type: 'Bearer', expires_in: 300 }));
    });
});
const ai = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        const body = raw ? JSON.parse(raw) : null;
        runs.push(body);
        res.setHeader('Content-Type', 'application/json');
        if (!answer) { res.statusCode = 502; return res.end(JSON.stringify({ code: 'provider.unavailable' })); }
        res.statusCode = 201;
        res.end(JSON.stringify({ run: { id: 'run_01JAB2C3D4E5F6G7H8J9K0MNPA', status: 'succeeded', synthetic: false, workflow: { key: body.workflow }, output: answer, usage: { tokens_in: 10, tokens_out: 5, cost_usd: 0.0001 }, provenance: { model: 'm' } } }));
    });
});

(async () => {
    await new Promise((r) => network.listen(0, '127.0.0.1', r));
    await new Promise((r) => ai.listen(0, '127.0.0.1', r));
    process.env.OV_NETWORK_INTERNAL_URL = `http://127.0.0.1:${network.address().port}`;
    process.env.OV_AI_INTERNAL_URL = `http://127.0.0.1:${ai.address().port}`;
    const db = require('../server/db/database');
    db.initDb();
    db.setSetting('ai_enabled', 'true');
    const listener = require('../server/arena/listener');
    require('../server/arena/arena-service').ensureTables();
    try {
        answer = { is_trash_talk: true, garbled: false, quality: 12, best_line: 'chat you are the worst mods i have ever seen', about: 'the mods', aimed_at: 'The Mods', announcer: 'OH!', flagged: false };
        const mic = await listener._judgeMic(7, 'chat you are the worst mods i have ever seen');
        assert.deepStrictEqual([runs[0].workflow, runs[0].input, runs[0].attribution], ['live.arena.judge_mic', { speech: 'chat you are the worst mods i have ever seen' }, { service: 'live', type: 'user', id: '7' }]);
        assert.ok(!JSON.stringify(runs[0]).includes('You judge'), 'no prompt is sent');
        assert.deepStrictEqual([mic.is_trash_talk, mic.quality, mic.best_line, mic.aimed_at, mic.fallback], [true, 10, 'Chat you are the worst mods i have ever seen.', 'the mods', false]);
        answer = { ...answer, best_line: 'too short' };
        assert.strictEqual((await listener._judgeMic(7, 'too short a line')).is_trash_talk, false, 'the quotable-line rule still applies');
        answer = null;
        const fallback = await listener._judgeMic(7, 'you are all clowns and nobody in chat can beat me');
        assert.strictEqual(fallback.fallback, true, 'no answer: the heuristic');

        db.getDb().prepare("INSERT INTO users (id, username, display_name, password_hash) VALUES (8, 'ann', 'Ann', '$sso$')").run();
        const roster = { byId: { 8: { user: { username: 'ann', display_name: 'Ann' } } } };
        answer = { about_target: true, aimed_at_target: true, quality: 7, best_line: 'ann your stream is so boring even your bots left', about: 'her stream', announcer: 'Ouch', flagged: false };
        const beef = await listener._judgeBeef(7, 8, 'ann your stream is so boring even your bots left', roster, { context: 'called her washed', named: true, how: 'exact' });
        const b = runs[runs.length - 1];
        assert.strictEqual(b.workflow, 'live.arena.judge_beef');
        assert.deepStrictEqual(Object.keys(b.input), ['target_names', 'target_as_transcribed', 'target_named_in_new_speech', 'how_the_name_was_matched', 'what_speaker_already_said_about_target', 'new_speech']);
        assert.deepStrictEqual([b.input.target_names, b.input.what_speaker_already_said_about_target], [['ann', 'Ann'], 'called her washed']);
        assert.deepStrictEqual([beef.aimed_at_target, beef.quality, beef.fallback], [true, 7, false]);
    } finally {
        network.close(); ai.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log('arena judge via AI: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
