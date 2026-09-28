'use strict';
// The home slogans, the daily secret and the Star of OpenVibe are OpenVibe.AI templates (roadmap WS-O task 2): against
// a stub Network (token endpoint) and a stub AI, each job sends its data (never a prompt) to live.hero.slogans,
// live.easter_egg or live.home.star and keeps its own rules on the answer (clean lists, clues that point at their
// token, only a real candidate); no answer keeps the old fallback.
//   node test/ai-templates-jobs.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { serviceAuth } = require('openvibe-contracts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-live-ai-jobs-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.NODE_ENV = 'test';
process.env.OV_OAUTH_CLIENT_ID = 'live';
process.env.OV_OAUTH_CLIENT_SECRET = 'live-secret';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const runs = [];
const answers = {};
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
        const out = answers[body.workflow];
        if (!out) { res.statusCode = 502; return res.end(JSON.stringify({ code: 'provider.unavailable' })); }
        res.statusCode = 201;
        res.end(JSON.stringify({ run: { id: 'run_01JAB2C3D4E5F6G7H8J9K0MNPA', status: 'succeeded', synthetic: false, workflow: { key: body.workflow }, output: out, usage: { tokens_in: 1, tokens_out: 1, cost_usd: 0 }, provenance: { model: 'm' } } }));
    });
});
const last = (wf) => runs.filter((r) => r.workflow === wf).pop();

(async () => {
    await new Promise((r) => network.listen(0, '127.0.0.1', r));
    await new Promise((r) => ai.listen(0, '127.0.0.1', r));
    process.env.OV_NETWORK_INTERNAL_URL = `http://127.0.0.1:${network.address().port}`;
    process.env.OV_AI_INTERNAL_URL = `http://127.0.0.1:${ai.address().port}`;
    const db = require('../server/db/database');
    db.initDb();
    db.setSetting('ai_enabled', 'true');
    try {
        // The daily secret: AI's code, Live's clue check.
        answers['live.easter_egg'] = { title: 'Goose Run', code: ['up', 'g', 'left', 'down', 'v'], clues: ['toward the sky', "'goose' begins with it", 'the way rain falls', 'the way rain falls', "'vibe' begins with it"], effect: 'rainbow', reward: 'Honk!' };
        const egg = await require('../server/ai/easter-egg-job')._generate();
        assert.deepStrictEqual(last('live.easter_egg').input, {}, 'no vibe: an empty input, no prompt');
        assert.deepStrictEqual([egg.ai, egg.title, egg.code, egg.effect], [true, 'Goose Run', ['up', 'g', 'left', 'down', 'v'], 'rainbow']);
        assert.notStrictEqual(egg.clues[2], 'the way rain falls', 'a clue that does not point at its token is replaced');
        delete answers['live.easter_egg'];
        assert.ok(!(await require('../server/ai/easter-egg-job')._generate()).ai, 'no answer: the seeded code');

        // The star: only a real, eligible candidate.
        const star = require('../server/home/star-job');
        const cands = [{ id: 1, username: 'ann', display_name: 'Ann', sessions: 3, hours: 5, peak_viewers: 2, avg_peak: 1, chat_lines: 10, new_followers: 1, mic_moments: 0, followers: 4, last_live_at: '2026-09-27', overview: 'codes   rust', language: 'en', category: 'desktop' },
            { id: 2, username: 'bob', display_name: 'Bob', sessions: 1, hours: 1 }];
        answers['live.home.star'] = { username: 'ANN', headline: 'Rust all night', reason: 'You showed up five hours this week.' };
        const pick = await star._aiPick(cands, new Set(['bob']), 'bob');
        const sent = last('live.home.star').input;
        assert.deepStrictEqual([sent.recent_stars, sent.previous_star, sent.candidates.map((c) => c.username), sent.candidates[0].about], [['bob'], 'bob', ['ann'], 'codes rust']);
        assert.deepStrictEqual([pick.cand.username, pick.headline], ['ann', 'Rust all night']);
        answers['live.home.star'] = { username: 'bob', headline: 'x', reason: 'y' };
        assert.strictEqual(await star._aiPick(cands, new Set(['bob']), 'bob'), null, 'a recent star is refused');

        // The slogans: data in, Live's rules on the lists.
        answers['live.hero.slogans'] = { audiences: Array.from({ length: 8 }, (_, i) => `crouton fans ${i}`).concat(['free snacks', 'live streaming for coders']), quips: Array.from({ length: 8 }, (_, i) => `quip number ${i}`) };
        await require('../server/ai/slogan-job').tick();
        const sl = last('live.hero.slogans');
        assert.deepStrictEqual(Object.keys(sl.input).sort(), ['count', 'global', 'streamers', 'usernames', 'users', 'vods']);
        assert.strictEqual(sl.input.count, 20);
        assert.ok(!JSON.stringify(sl.input).includes('TASK'), 'no prompt is sent');
        const pool = JSON.parse(db.getState('home_hero_slogans'));
        assert.ok(pool.audiences.includes('crouton fans 0') && !pool.audiences.some((a) => /free/.test(a)), 'the no-free rule still applies');
        assert.ok(pool.audiences.includes('coders'), '"live streaming for" is stripped');
        // Chat messages go to live.chat.global / live.chat.profile as data, in the shape AI formats.
        const now = Date.parse('2026-09-28T01:00:00Z');
        const data = require('../server/ai/chat-ai')._msgData([
            { username: 'goosely', is_global: 1, message: '  croutons  ', timestamp: '2026-09-28 00:48:00' },
            { user_id: 5, channel_username: 'ann', message_type: 'emote', message: 'waves', timestamp: '2026-09-28 00:57:00' },
            { message: 'hi', stream_id: 3 },
        ], { includeChannel: true, now });
        assert.deepStrictEqual(data, [
            { mins_ago: 12, where: 'global', author: 'goosely', kind: null, text: 'croutons' },
            { mins_ago: 3, where: '#ann', author: 'user#5', kind: 'emote', text: 'waves' },
            { mins_ago: null, where: 'stream', author: 'anon', kind: null, text: 'hi' },
        ]);
        assert.strictEqual(require('../server/ai/chat-ai')._msgData([{ username: 'x', is_global: 1, message: 'y' }]).pop().where, null, 'no channel tag in a profile');
    } finally {
        network.close(); ai.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log('AI template jobs: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
