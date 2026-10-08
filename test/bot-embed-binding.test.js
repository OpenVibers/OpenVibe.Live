/**
 * Binding a channel to an OpenVibe.Bot robot (roadmap T15 R9, server/bot/).
 *
 * With LIVE_BOT_EMBED off the binding route answers 404 and the channel JSON has no `bot_embed` key.
 * With it on, only the channel owner binds (mods and others 403, anonymous 401), bad ids are 400, null
 * unbinds, and the channel GET carries { enabled, robot_id, url } built from LIVE_BOT_URL.
 * The real routers run on the test database; only sign-in is stubbed (`x-test-user` header).
 *
 *   node test/bot-embed-binding.test.js
 */
'use strict';
const assert = require('assert');
const http = require('http');

process.env.NODE_ENV = 'test';
delete process.env.LIVE_BOT_EMBED;
delete process.env.LIVE_BOT_URL;
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
const warnings = [];
console.warn = (...a) => { warnings.push(a.join(' ')); };

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
        `INSERT INTO users (id, username, display_name, email, password_hash, role) OVERRIDING SYSTEM VALUE VALUES (?, ?, ?, ?, 'x', ?)`)
        .run(id, username, username, `${username}@x`, role);
    await addUser(1, 'rover', 'streamer');
    await addUser(2, 'modguy', 'user');
    await addUser(3, 'stranger', 'streamer');
    await db.ensureChannel(1);
    const chan = await db.getChannelByUserId(1);

    // modguy is a channel moderator of rover (read from Chat through the moderation client).
    const moderation = require('../server/chat/moderation-client');
    moderation.getChannelModeration = async (channelId) => ({ settings: {}, moderator_ids: channelId === chan.id ? [2] : [] });

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/streams', require('../server/bot/routes'));
    app.use('/api/streams', require('../server/streaming/routes'));

    let failures = 0;
    async function check(name, fn) {
        try { await fn(); console.log('  ✓', name); }
        catch (e) { failures++; console.log('  ✗', name, '\n     ', e.stack.split('\n').slice(0, 3).join('\n      ')); }
    }

    const server = http.createServer(app).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const call = (method, p, { user, body } = {}) => new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const headers = {};
        if (user) headers['x-test-user'] = String(user);
        if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
        const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: p, headers }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode, body: json, text }); });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
    const channelGet = () => call('GET', '/api/streams/channel/rover?pollOnly=1');
    const bind = (robot_id, user = 1) => call('PUT', '/api/streams/channel/rover/bot', { user, body: { robot_id } });

    await check('flag off: PUT answers 404 as if the route did not exist, the column stays unset', async () => {
        const r = await bind('rob_sim123');
        assert.strictEqual(r.status, 404);
        assert.deepStrictEqual(r.body, { error: 'Not found' });
        assert.strictEqual((await db.getChannelByUserId(1)).bot_robot_id, null);
    });

    await check('flag off: the channel GET has no bot_embed key and no bot_robot_id even when one is stored', async () => {
        await raw.prepare('UPDATE channels SET bot_robot_id = ? WHERE id = ?').run('rob_stored1', chan.id);
        const r = await channelGet();
        assert.strictEqual(r.status, 200, r.text.slice(0, 200));
        assert.ok(!('bot_embed' in r.body), 'no bot_embed key');
        assert.ok(!('bot_robot_id' in r.body.channel), 'no raw column on the public channel');
        assert.ok(!r.text.includes('rob_stored1'));
        await raw.prepare('UPDATE channels SET bot_robot_id = NULL WHERE id = ?').run(chan.id);
    });

    process.env.LIVE_BOT_EMBED = '1';

    await check('flag on, unbound: bot_embed is enabled with no robot', async () => {
        const r = await channelGet();
        assert.deepStrictEqual(r.body.bot_embed, { enabled: true, robot_id: null, url: null });
    });

    await check('flag on: anonymous 401, non-owner 403, channel mod 403', async () => {
        assert.strictEqual((await call('PUT', '/api/streams/channel/rover/bot', { body: { robot_id: 'rob_sim123' } })).status, 401);
        assert.strictEqual((await bind('rob_sim123', 3)).status, 403);
        assert.strictEqual((await bind('rob_sim123', 2)).status, 403);
        assert.strictEqual((await db.getChannelByUserId(1)).bot_robot_id, null);
    });

    await check('flag on: bad ids are 400', async () => {
        const bad = ['sim123', 'rob_', 'rob_ab', 'rob_has space', 'rob_../../x', 'rob_' + 'a'.repeat(61), 42, {}, ['rob_sim123']];
        const statuses = await Promise.all(bad.map((b) => bind(b).then((r) => r.status)));
        assert.deepStrictEqual(statuses, bad.map(() => 400));
        assert.strictEqual((await call('PUT', '/api/streams/channel/rover/bot', { user: 1, body: {} })).status, 400, 'missing robot_id');
        assert.strictEqual((await db.getChannelByUserId(1)).bot_robot_id, null);
    });

    await check('flag on: unknown channel is 404', async () => {
        const r = await call('PUT', '/api/streams/channel/nobody/bot', { user: 1, body: { robot_id: 'rob_sim123' } });
        assert.strictEqual(r.status, 404);
    });

    await check('flag on: the owner binds rob_sim123 and the channel GET returns the embed', async () => {
        const r = await bind('rob_sim123');
        assert.strictEqual(r.status, 200, r.text);
        const g = await channelGet();
        assert.deepStrictEqual(g.body.bot_embed, { enabled: true, robot_id: 'rob_sim123', url: 'https://openvibe.bot/panel/rob_sim123/embed' });
        assert.ok(!('bot_robot_id' in g.body.channel));
    });

    await check('a custom LIVE_BOT_URL changes the origin', async () => {
        process.env.LIVE_BOT_URL = 'https://bot.example.test/';
        assert.strictEqual((await channelGet()).body.bot_embed.url, 'https://bot.example.test/panel/rob_sim123/embed');
        process.env.LIVE_BOT_URL = 'http://localhost:3020';
        assert.strictEqual((await channelGet()).body.bot_embed.url, 'http://localhost:3020/panel/rob_sim123/embed');
    });

    await check('a garbage LIVE_BOT_URL falls back to the default with a warning', async () => {
        const embed = require('../server/bot/embed');
        const garbage = ['not a url', 'http://bot.example.test', 'https://bot.example.test/path', 'https://u:p@bot.example.test', 'javascript:alert(1)'];
        const results = garbage.map((bad) => {
            warnings.length = 0;
            process.env.LIVE_BOT_URL = bad;
            return [bad, embed.botOrigin(), warnings.some((w) => w.includes('LIVE_BOT_URL'))];
        });
        assert.deepStrictEqual(results, garbage.map((bad) => [bad, 'https://openvibe.bot', true]));
        process.env.LIVE_BOT_URL = 'http://localhost:3020';
        process.env.NODE_ENV = 'production';
        assert.strictEqual(embed.botOrigin(), 'https://openvibe.bot', 'no http localhost in production');
        process.env.NODE_ENV = 'test';
        process.env.LIVE_BOT_URL = 'not a url';
        assert.strictEqual((await channelGet()).body.bot_embed.url, 'https://openvibe.bot/panel/rob_sim123/embed');
        delete process.env.LIVE_BOT_URL;
    });

    await check('null and empty string unbind; url is null', async () => {
        const unbound = { enabled: true, robot_id: null, url: null };
        await bind('rob_sim123');
        const a = await bind(null);
        assert.strictEqual(a.status, 200, a.text);
        assert.deepStrictEqual(a.body.bot_embed, unbound);
        assert.deepStrictEqual((await channelGet()).body.bot_embed, unbound);
        await bind('rob_sim123');
        const b = await bind('');
        assert.strictEqual(b.status, 200, b.text);
        assert.deepStrictEqual((await channelGet()).body.bot_embed, unbound);
        assert.strictEqual((await db.getChannelByUserId(1)).bot_robot_id, null);
    });

    await check('turning the flag off again hides the binding', async () => {
        await bind('rob_sim123');
        delete process.env.LIVE_BOT_EMBED;
        assert.ok(!('bot_embed' in (await channelGet()).body));
        assert.strictEqual((await bind(null)).status, 404);
        assert.strictEqual((await db.getChannelByUserId(1)).bot_robot_id, 'rob_sim123', 'binding kept for when the flag returns');
    });

    server.close();
    if (failures) { console.log(`bot-embed-binding: ${failures} failed`); process.exit(1); }
    console.log('bot-embed-binding: all passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
