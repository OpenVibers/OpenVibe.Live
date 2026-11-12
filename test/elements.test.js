'use strict';
/**
 * Elements, stage 1: the library, the deck and every refusal on the press path.
 *
 *   node --import ./test/helpers/pg-preload.mjs test/elements.test.js
 *
 * The products are stubs: Bot records its command, Chat records its message, the overlay records its
 * moment. What is real here is Live's own authorisation: the owner switch, live-only, the viewer's
 * role, cooldowns, daily caps, channel points, the declared capabilities, the state reducer and the
 * refund when a product refuses.
 */
const assert = require('assert');

process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = () => {};
console.warn = () => {};

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    const raw = db.getDb();

    const addUser = async (id, username, display) => await raw.prepare(
        `INSERT INTO users (id, username, display_name, email, password_hash, role) OVERRIDING SYSTEM VALUE
         VALUES (?, ?, ?, ?, 'x', 'user')`).run(id, username, display, `${username}@example.test`);
    await addUser(2, 'ann', 'Ann');
    await addUser(3, 'bob', 'Bob');
    await addUser(4, 'cid', 'Cid');
    const ANN = 'usr_01JAB2C3D4E5F6G7H8J9K0MNA1';
    const BOB = 'usr_01JAB2C3D4E5F6G7H8J9K0MNB2';
    const CID = 'usr_01JAB2C3D4E5F6G7H8J9K0MNC3';
    await raw.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (2, 'network', '102', ?), (3, 'network', '103', ?), (4, 'network', '104', ?)")
        .run(ANN, BOB, CID);
    const channel = await db.ensureChannel(2);
    const streamId = Number((await raw.prepare("INSERT INTO streams (user_id, channel_id, title, protocol, is_live, started_at) VALUES (2, ?, 'Ann live', 'webrtc', 1, ?) RETURNING id")
        .run(channel.id, new Date(Date.now() - 60_000).toISOString())).lastInsertRowid);
    await raw.prepare("INSERT INTO follows (follower_id, streamer_id) VALUES (3, 2)").run();
    await db.applyChannelPoints({ userId: 3, streamerId: 2, delta: 100, key: 'seed:bob' });

    // OpenVibe.Bot and OpenVibe.Chat are stubs; Live is real.
    const delivery = require('../server/chat/chat-delivery');
    const overlay = require('../server/overlay/overlay-alerts');
    const bot = require('../server/bot/bot-client');
    const permissions = require('../server/auth/permissions');
    const billing = require('../server/monetization/billing-actions');
    const streamEvents = require('../server/events/stream-events');
    const sent = { chat: [], events: [], alerts: [], bots: [], envelopes: [] };
    delivery.message = async (body) => { sent.chat.push(body); return 900 + sent.chat.length; };
    delivery.event = async (target, frame, opts) => { sent.events.push({ target, frame, opts }); return {}; };
    overlay.emit = async (args) => { sent.alerts.push(args); return { id: `a${sent.alerts.length}` }; };
    bot.command = async (...args) => { sent.bots.push(args); if (sent.botRefuse) throw new bot.BotRefusal('bot.not_an_operator', 'you are not an operator on this robot', 403); return { result: { ok: true } }; };
    bot.role = async (robotId, subject) => (subject === BOB ? 'operator' : null);
    permissions.isChannelModerator = async () => false;
    billing.entitlementOf = async () => ({ active: false, via: 'billing' });
    db.isActiveSubscriber = async () => false;
    streamEvents.enqueue = async (env) => { sent.envelopes.push(env); return env; };
    streamEvents.init = () => null;
    streamEvents.kick = () => {};

    const store = require('../server/elements/store');
    const press = require('../server/elements/press');
    const ann = { id: 2, username: 'ann', display_name: 'Ann' };
    const bob = { id: 3, username: 'bob', display_name: 'Bob', avatar_url: null };
    const cid = { id: 4, username: 'cid', display_name: 'Cid', avatar_url: null };
    const reset = () => { sent.chat.length = 0; sent.events.length = 0; sent.alerts.length = 0; sent.bots.length = 0; sent.envelopes.length = 0; sent.botRefuse = false; };

    const look = (label = 'Dance') => ({ component: 'button', label });
    const recipe = (over = {}) => ({
        triggers: [{ kind: 'press' }],
        conditions: {},
        actions: [{ kind: 'screen.counter', product: 'live', key: 'dances', by: 1 }],
        ...over,
    });
    const make = async (over = {}) => await store.create(ann, {
        name: over.name || 'Make it dance',
        look: over.look || look(),
        recipe: over.recipe || recipe(),
        capabilities: over.capabilities || ['screen.counter'],
        initial_state: over.initial_state || { dances: 0 },
        sharing: 'private',
        active: over.active === undefined ? true : over.active,
        position: over.position,
    });

    // ── The library validates through the SDK ─────────────────────────────────
    {
        const element = await make();
        assert.match(element.id, /^el_/);
        assert.equal(element.revision, 1);
        assert.deepEqual(store.elementsSdk().validate({ name: element.name, author: { name: 'Ann' }, sharing: 'private', look: element.look, recipe: element.recipe, capabilities: element.capabilities }).valid, true);
        await assert.rejects(
            store.create(ann, { name: 'Bad', look: look(), recipe: recipe(), capabilities: ['screen.alert'] }),
            (e) => e.status === 400 && e.errors.some((x) => /did not declare/.test(x.message)),
            'a recipe action the element did not declare is refused at save',
        );
        await assert.rejects(store.create(ann, { name: 'Bad', look: look(), recipe: recipe({ triggers: [{ kind: 'cheer' }] }), capabilities: ['screen.counter'] }), (e) => e.status === 400);
        const updated = await store.update(ann, element.id, { name: 'Make it dance now', position: 2 });
        assert.equal(updated.name, 'Make it dance now');
        assert.equal(updated.revision, 2);
        const list = await store.list(2);
        assert.ok(list.some((x) => x.id === element.id));
    }

    // ── The owner switch is off until the streamer turns it on ───────────────
    assert.deepEqual(await store.settings(2), { enabled: false });
    const offDeck = await press.fromPress({ channel: await store.channelByUsername('ann'), presser: bob, id: (await store.list(2))[0].id });
    assert.equal(offDeck.code, 'disabled');
    await store.setEnabled(2, true);
    assert.deepEqual(await store.settings(2), { enabled: true });

    // ── The deck: active elements only, in order, with their state ───────────
    {
        const second = await make({ name: 'Second', position: 1 });
        const hidden = await make({ name: 'Hidden', position: 2, active: false });
        const deck = await store.deck(2);
        assert.ok(deck.length >= 2);
        const ids = deck.map((x) => x.element.id);
        assert.ok(ids.includes(second.id) && !ids.includes(hidden.id));
        assert.ok(deck.every((x) => x.element.state && typeof x.element.state.values === 'object'));
    }

    // ── Live-only ────────────────────────────────────────────────────────────
    {
        const element = await make({ name: 'Live only', position: 10 });
        await raw.prepare('UPDATE streams SET is_live = 0, ended_at = ov_now() WHERE id = ?').run(streamId);
        let r = await press.fromPress({ channel: await store.channelByUsername('ann'), presser: bob, id: element.id });
        assert.equal(r.code, 'offline');
        assert.equal(r.status, 409);
        assert.equal(sent.alerts.length, 0);
        await raw.prepare('UPDATE streams SET is_live = 1, ended_at = NULL, started_at = ? WHERE id = ?').run(new Date(Date.now() - 60_000).toISOString(), streamId);
        r = await press.fromPress({ channel: await store.channelByUsername('ann'), presser: bob, id: element.id });
        assert.equal(r.ok, true);
    }

    // ── Role: a follower-only element refuses a non-follower ─────────────────
    {
        reset();
        const element = await make({ name: 'Followers only', position: 20, recipe: recipe({ conditions: { role: 'follower' } }) });
        let r = await press.fromPress({ channel: await store.channelByUsername('ann'), presser: cid, id: element.id });
        assert.equal(r.code, 'role');
        assert.equal(r.status, 403);
        assert.equal(sent.alerts.length, 0);
        r = await press.fromPress({ channel: await store.channelByUsername('ann'), presser: bob, id: element.id });
        assert.equal(r.ok, true, 'a follower gets through');
    }

    // ── Cost: checked by Live's channel-points ledger, and refunded ──────────
    {
        reset();
        const have = Number(await db.getChannelPoints(3, 2)) || 0;
        await db.applyChannelPoints({ userId: 3, streamerId: 2, delta: 100 - have, key: 'reset:bob' });
        const element = await make({ name: 'Costs 50', position: 30, recipe: recipe({ conditions: { cost: { points: 50 } } }) });
        let r = await press.fromPress({ channel: await store.channelByUsername('ann'), presser: bob, id: element.id });
        assert.equal(r.ok, true);
        assert.equal(r.points_spent, 50);
        assert.equal(r.balance, 50);
        assert.equal(await db.getChannelPoints(3, 2), 50);
        // Not enough: the owner refuses before any action runs.
        await db.applyChannelPoints({ userId: 3, streamerId: 2, delta: -45, key: 'spend:bob' });   // 5 left
        reset();
        r = await press.fromPress({ channel: await store.channelByUsername('ann'), presser: bob, id: element.id });
        assert.equal(r.code, 'points');
        assert.equal(r.status, 402);
        assert.equal(sent.alerts.length, 0);
        // A product's refusal refunds the points.
        await db.applyChannelPoints({ userId: 3, streamerId: 2, delta: 95, key: 'topup2:bob' });
        delivery.message = async () => null;
        const chained = await make({
            name: 'Counter then chat', position: 31, capabilities: ['screen.counter', 'chat.message'],
            recipe: recipe({
                conditions: { cost: { points: 10 }, cooldown: { per_person_seconds: 0 } },
                actions: [
                    { kind: 'screen.counter', product: 'live', key: 'dances', by: 1 },
                    { kind: 'chat.message', product: 'chat', text: 'the deck says hi' },
                ],
            }),
        });
        reset();
        r = await press.fromPress({ channel: await store.channelByUsername('ann'), presser: bob, id: chained.id });
        assert.equal(r.code, 'action');
        assert.equal(r.refunded, true);
        assert.equal(r.points_spent, 0);
        assert.equal(await db.getChannelPoints(3, 2), 100, 'a refused action gives the points back');
        delivery.message = async (body) => { sent.chat.push(body); return 900 + sent.chat.length; };
    }

    // ── Cooldown and daily cap ───────────────────────────────────────────────
    {
        reset();
        const element = await make({ name: 'Slow', position: 40, recipe: recipe({ conditions: { cooldown: { per_person_seconds: 60 } } }) });
        const channel = await store.channelByUsername('ann');
        let r = await press.fromPress({ channel, presser: bob, id: element.id });
        assert.equal(r.ok, true);
        r = await press.fromPress({ channel, presser: bob, id: element.id });
        assert.equal(r.code, 'cooldown');
        assert.equal(r.status, 429);
        assert.ok(r.retry_after_ms > 50000 && r.retry_after_ms <= 60000, `retry after ${r.retry_after_ms}`);
        const capped = await make({ name: 'Once a day', position: 41, recipe: recipe({ conditions: { daily_cap: { per_person: 1 } } }) });
        r = await press.fromPress({ channel, presser: bob, id: capped.id });
        assert.equal(r.ok, true);
        r = await press.fromPress({ channel, presser: bob, id: capped.id });
        assert.equal(r.code, 'daily_cap');
        assert.equal(r.status, 429);
    }

    // ── The state reducer, the press moment, the timeline and the events ─────
    {
        reset();
        const element = await make({ name: 'Dance', position: 50 });
        const before = store.shape((await store.byPublicId(2, element.id)).row, { revision: 0, values: { dances: 0 } });
        assert.equal(before.state.revision, 0);
        const r = await press.fromPress({ channel: await store.channelByUsername('ann'), presser: bob, id: element.id });
        assert.equal(r.ok, true);
        assert.deepEqual(r.state, { revision: 1, values: { dances: 1 } });
        assert.equal(sent.alerts.length, 1);
        assert.equal(sent.alerts[0].kind, 'element');
        assert.equal(sent.alerts[0].who.name, 'Bob');
        assert.equal(sent.alerts[0].text, 'Dance');
        const timeline = await raw.prepare("SELECT kind, text, start_sec FROM stream_timeline_events WHERE stream_id = ? AND kind = 'element' ORDER BY id DESC LIMIT 1").get(streamId);
        assert.equal(timeline.kind, 'element');
        assert.match(timeline.text, /Bob pressed Dance/);
        assert.ok(timeline.start_sec >= 55);
        const stateFrame = sent.events.find((e) => e.frame && e.frame.type === 'element-state');
        assert.ok(stateFrame, 'the new state goes to the channel room');
        assert.equal(stateFrame.frame.revision, 1);
        assert.deepEqual(stateFrame.frame.values, { dances: 1 });
        assert.ok(sent.envelopes.some((e) => e.event_type === 'live.element.pressed' && e.payload.element_name === 'Dance' && e.payload.presser_name === 'Bob'));
        assert.ok(sent.envelopes.some((e) => e.event_type === 'live.element.state' && e.payload.revision === 1));
    }

    // ── An undeclared capability is refused before anything runs ─────────────
    {
        reset();
        const row = await raw.prepare(`INSERT INTO elements (public_id, user_id, name, look, recipe, capabilities, initial_state, sharing, active, position)
            VALUES (?, 2, 'Sneaky', ?, ?, ?, '{}'::jsonb, 'private', 1, 60) RETURNING *`)
            .get('el_01JAB2C3D4E5F6G7H8J9K0MND4', JSON.stringify(look('Sneaky')), JSON.stringify(recipe()), JSON.stringify(['screen.alert']));
        await raw.prepare('INSERT INTO element_state (element_id, revision, values) VALUES (?, 0, ?)').run(row.id, '{}');
        const r = await press.fromPress({ channel: await store.channelByUsername('ann'), presser: bob, id: 'el_01JAB2C3D4E5F6G7H8J9K0MND4' });
        assert.equal(r.code, 'capability');
        assert.equal(r.status, 403);
        assert.equal(sent.alerts.length, 0);
        assert.equal(sent.bots.length, 0);
    }

    // ── Operator-only elements: Bot's own operators count ───────────────────
    {
        reset();
        await raw.prepare('UPDATE channels SET bot_robot_id = ? WHERE id = ?').run('rob_01J8Z4M2Q0R7T9YV3K6N8P1W2X', channel.id);
        const op = await make({ name: 'Operators only', position: 60, recipe: recipe({ conditions: { role: 'operator' } }) });
        let r = await press.fromPress({ channel: await store.channelByUsername('ann'), presser: bob, id: op.id });
        assert.equal(r.ok, true, 'a Bot operator may press an operator element');
        r = await press.fromPress({ channel: await store.channelByUsername('ann'), presser: cid, id: op.id });
        assert.equal(r.code, 'role');
        await raw.prepare('UPDATE channels SET bot_robot_id = NULL WHERE id = ?').run(channel.id);
    }

    // ── Robot actions go through Bot's command path, and the turn rule ───────
    {
        reset();
        await raw.prepare('UPDATE channels SET bot_robot_id = ? WHERE id = ?').run('rob_01J8Z4M2Q0R7T9YV3K6N8P1W2X', channel.id);
        const say = await make({
            name: 'Say hi', position: 70, capabilities: ['robot.say'],
            recipe: recipe({ actions: [{ kind: 'robot.say', product: 'bot', text: 'hello chat' }] }),
        });
        let r = await press.fromPress({ channel: await store.channelByUsername('ann'), presser: bob, id: say.id });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(sent.bots.length, 1);
        assert.equal(sent.bots[0][0], 'rob_01J8Z4M2Q0R7T9YV3K6N8P1W2X');
        assert.equal(sent.bots[0][1], BOB);
        assert.equal(sent.bots[0][2].kind, 'say');
        // Bot's refusal is a refusal, not a success.
        sent.botRefuse = true;
        r = await press.fromPress({ channel: await store.channelByUsername('ann'), presser: bob, id: say.id });
        assert.equal(r.code, 'action');
        assert.match(r.message, /not an operator/);
        // robot_turn_only with no turn answer refuses before Bot is asked.
        reset();
        const turnOnly = await make({
            name: 'Only my turn', position: 71, capabilities: ['robot.say'],
            recipe: recipe({ conditions: { robot_turn_only: true }, actions: [{ kind: 'robot.say', product: 'bot', text: 'hello' }] }),
        });
        r = await press.fromPress({ channel: await store.channelByUsername('ann'), presser: bob, id: turnOnly.id });
        assert.equal(r.code, 'robot_turn');
        assert.equal(sent.bots.length, 0);
        await raw.prepare('UPDATE channels SET bot_robot_id = NULL WHERE id = ?').run(channel.id);
    }

    // ── A chat command through Chat's own effect path ────────────────────────
    {
        reset();
        const dance = await make({
            name: 'Dance command', position: 80, recipe: recipe({ triggers: [{ kind: 'chat_command', command: '!dance' }] }),
        });
        const none = await press.fromChat({ channelUserId: 2, user: { id: 3 }, text: 'hello there' });
        assert.deepEqual(none, []);
        const results = await press.fromChat({ channelUserId: 2, user: { id: 3 }, text: '!dance please' });
        assert.equal(results.length, 1);
        assert.equal(results[0].ok, true);
        assert.equal(results[0].element_id, dance.id);
        assert.deepEqual(results[0].state.values, { dances: 1 });
        const anon = await press.fromChat({ channelUserId: 2, user: { id: null }, text: '!dance' });
        assert.deepEqual(anon, [], 'anonymous chat cannot spend or trigger in stage 1');
        void none;
    }

    // ── The owner can switch the deck off again ──────────────────────────────
    {
        await store.setEnabled(2, false);
        const r = await press.fromPress({ channel: await store.channelByUsername('ann'), presser: bob, id: (await store.list(2))[0].id });
        assert.equal(r.code, 'disabled');
    }

    // ── The HTTP API: the owner's library, the public deck, the press ────────
    {
        const auth = require('../server/auth/auth');
        auth.requireAuth = (req, res, next) => {
            const id = Number(req.headers['x-test-user'] || 0);
            db.getUserById(id).then((u) => (u ? (req.user = u, next()) : res.status(401).json({ error: 'Authentication required' }))).catch(next);
        };
        const express = require('express');
        const http = require('http');
        const routes = require('../server/elements/routes');
        const app = express();
        app.use(express.json());
        app.use('/api/me/elements', routes.ownerRouter);
        app.use('/api/channels', routes.channelRouter);
        const server = http.createServer(app);
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const call = async (method, path, body, user) => {
            const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
                method, headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': String(user) } : {}) },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
        };
        await store.setEnabled(2, true);
        const deckRead = await call('GET', '/api/channels/ann/elements');
        assert.equal(deckRead.status, 200);
        assert.equal(deckRead.json.surface, 'live.deck');
        assert.equal(deckRead.json.enabled, true);
        assert.equal(deckRead.json.live, true);
        assert.equal(deckRead.json.viewer.signed_in, false);
        assert.ok(deckRead.json.elements.length > 0);
        assert.equal(deckRead.json.elements[0].can_press, false);
        assert.equal(deckRead.json.elements[0].reason, 'sign_in');

        const library = await call('GET', '/api/me/elements', undefined, 2);
        assert.equal(library.status, 200);
        assert.equal(library.json.enabled, true);
        assert.ok(Array.isArray(library.json.elements) && library.json.elements.length > 0);

        const made = await call('POST', '/api/me/elements', {
            name: 'API button', look: look('API button'), recipe: recipe(), capabilities: ['screen.counter'], initial_state: { dances: 0 },
        }, 2);
        assert.equal(made.status, 201, JSON.stringify(made.json));
        assert.match(made.json.element.id, /^el_/);
        const patched = await call('PATCH', `/api/me/elements/${made.json.element.id}`, { name: 'API button 2' }, 2);
        assert.equal(patched.status, 200);
        assert.equal(patched.json.element.name, 'API button 2');
        const bad = await call('POST', '/api/me/elements', {
            name: 'Undeclared', look: look(), recipe: recipe(), capabilities: ['screen.alert'],
        }, 2);
        assert.equal(bad.status, 400);
        assert.ok(Array.isArray(bad.json.errors) && bad.json.errors.length > 0);

        const pressed = await call('POST', `/api/channels/ann/elements/${made.json.element.id}/press`, {}, 3);
        assert.equal(pressed.status, 200, JSON.stringify(pressed.json));
        assert.equal(pressed.json.ok, true);
        assert.deepEqual(pressed.json.state, { revision: 1, values: { dances: 1 } });
        assert.equal(typeof pressed.json.balance, 'number');
        const deleted = await call('DELETE', `/api/me/elements/${made.json.element.id}`, undefined, 2);
        assert.equal(deleted.status, 200);
        assert.equal((await call('POST', `/api/channels/ann/elements/${made.json.element.id}/press`, {}, 3)).status, 404);

        const settingsOff = await call('PUT', '/api/me/elements/settings', { enabled: false }, 2);
        assert.equal(settingsOff.status, 200);
        assert.deepEqual(settingsOff.json, { enabled: false });
        const hidden = await call('GET', '/api/channels/ann/elements');
        assert.equal(hidden.json.enabled, false);
        assert.deepEqual(hidden.json.elements, []);
        await store.setEnabled(2, true);
        server.close();
    }

    quiet('elements: all checks passed');
    process.exit(0);
})().catch((err) => { quiet(err); process.exit(1); });
