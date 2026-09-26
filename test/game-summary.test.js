'use strict';
// A channel's game summary (server/auth/game-summary.js, roadmap WS-M task 2): the owner's public
// games.progress.summary fields from Network's public module endpoint; misses are cached, Network
// trouble is not; nothing without a usr_ subject.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-game-summary-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.OV_NETWORK_INTERNAL_URL = 'http://network.test';
const log = console.log; console.log = () => {};
const identity = require('../server/auth/identity-sync');
const game = require('../server/auth/game-summary');
console.log = log;

const SUBJECTS = { 1: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', 2: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPR', 3: null };
identity.subjectOf = (id) => SUBJECTS[id] || null;

(async () => {
    const calls = [];
    const answers = {};
    const fetchImpl = async (url) => {
        calls.push(url);
        const a = answers[url.split('/').pop()];
        if (a instanceof Error) throw a;
        return { status: a ? a.status : 404, json: async () => (a && a.body) || {} };
    };
    answers[SUBJECTS[1]] = { status: 200, body: { subject: { type: 'user', id: SUBJECTS[1] }, namespace: 'games.progress.summary', version: 1, data: { level: 12, achievements: 3, playtime_hours: 7.26 } } };

    let r = await game.forUser(1, { fetchImpl, now: 1000 });
    assert.deepStrictEqual(r, { game: 'Scraplandia', url: 'https://openvibe.games/', level: 12, achievements: 3, playtime_hours: 7.3 });
    assert.strictEqual(calls[0], `http://network.test/api/modules/games.progress.summary/public/${SUBJECTS[1]}`, 'the public endpoint, no token');
    await game.forUser(1, { fetchImpl, now: 2000 });
    assert.strictEqual(calls.length, 1, 'cached');
    await game.forUser(1, { fetchImpl, now: 1000 + 11 * 60 * 1000 });
    assert.strictEqual(calls.length, 2, 'refreshed after 10 minutes');

    assert.strictEqual(await game.forUser(2, { fetchImpl, now: 1000 }), null, 'no record');
    await game.forUser(2, { fetchImpl, now: 2000 });
    assert.strictEqual(calls.filter((u) => u.endsWith(SUBJECTS[2])).length, 1, 'a miss is cached too');

    assert.strictEqual(await game.forUser(3, { fetchImpl }), null, 'no Network subject: nothing asked');
    assert.ok(!calls.some((u) => u.endsWith('null')));

    game._reset();
    answers[SUBJECTS[1]] = new Error('ECONNREFUSED');
    assert.strictEqual(await game.forUser(1, { fetchImpl, now: 5000 }), null);
    answers[SUBJECTS[1]] = { status: 200, body: { data: { level: 13 } } };
    assert.strictEqual((await game.forUser(1, { fetchImpl, now: 6000 })).level, 13, 'Network trouble is not cached');
    answers[SUBJECTS[1]] = { status: 503 };
    game._reset();
    assert.strictEqual(await game.forUser(1, { fetchImpl, now: 7000 }), null);

    assert.strictEqual(game.shape({ level: -1 }), null);
    assert.strictEqual(game.shape({ achievements: 3 }), null, 'no level, no badge');
    assert.deepStrictEqual(game.shape({ level: 0, playtime_hours: 'x', achievements: 1.5 }), { game: 'Scraplandia', url: 'https://openvibe.games/', level: 0 });

    // The route and the page wiring.
    const routes = fs.readFileSync(path.join(__dirname, '..', 'server', 'streaming', 'routes.js'), 'utf8');
    assert.match(routes, /router\.get\('\/channel\/:username\/game'/);
    const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-channel.js'), 'utf8');
    assert.match(page, /\/streams\/channel\/\$\{encodeURIComponent\(username\)\}\/game/);
    assert.ok(!/_loadGameBadge[\s\S]{0,1200}innerHTML/.test(page.slice(page.indexOf('async function _loadGameBadge'))), 'the badge is built with DOM nodes');
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('game summary: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
