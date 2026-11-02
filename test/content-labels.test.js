'use strict';
// Content labels (L1, 2026-10-31; Contracts 0.257.0 common.content-labels@1): a creator labels a stream slot, each
// live session copies them, the channel page and the watch screen return them, the home list skips 18+, and the AI's
// suggestion is stored in `suggested` and never applied until the creator confirms it.
//   node test/content-labels.test.js
const assert = require('assert');
const http = require('http');
process.env.NODE_ENV = 'test';
console.log = () => {};
console.warn = () => {};

(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    const raw = db.getDb();

    // Requests carry their user in x-test-user (the auth middleware is replaced before the routes load).
    const auth = require('../server/auth/auth');
    const signIn = async (req) => { const u = await db.getUserById(Number(req.headers['x-test-user'] || 0)); if (u) req.user = u; return u; };
    auth.requireAuth = async (req, res, next) => ((await signIn(req)) ? next() : res.status(401).json({ error: 'Authentication required' }));
    auth.optionalAuth = async (req, res, next) => { await signIn(req); next(); };
    require('../server/integrations/robotstreamer-service').startForStream = async () => {};
    require('../server/integrations/chat-relay-service').startForStream = async () => {};
    require('../server/streaming/live-events').announceGoLive = () => {};

    await raw.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role) OVERRIDING SYSTEM VALUE VALUES (1, 'labels', 'Labels', 'l@x', 'x', 'streamer')`).run();
    const channel = await db.ensureChannel(1);

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/streams', require('../server/streaming/routes'));
    const server = http.createServer(app).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}/api/streams`;
    const call = (method, path, body) => fetch(base + path, {
        method, headers: { 'content-type': 'application/json', 'x-test-user': '1' }, body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const makeSlot = (title, labels) => db.createManagedStream({
        user_id: 1, channel_id: channel.id, title, protocol: 'webrtc',
        stream_key: `${title}`.repeat(32).slice(0, 32), content_labels: { labels, suggested: [] },
    }).then((r) => Number(r.lastInsertRowid || r.id));
    const labelsOf = (body) => require('../server/labels').labelsOf(body);

    const { suggestFrom } = require('../server/labels');
    let pass = 0;
    const ok = () => { pass++; };

    try {
        // The AI's suggestion: nudity and 18+ from the scene, language from the transcript; spoilers are never guessed.
        assert.deepStrictEqual(suggestFrom({ description: 'The streamer appears naked in the room', transcript: 'that was fucking wild' }), ['nudity', 'language', '18+']);
        assert.deepStrictEqual(suggestFrom({ description: 'Blood covers the floor after a graphic fight' }), ['graphic']);
        assert.deepStrictEqual(suggestFrom({ description: 'A strobing light fills the stage' }), ['flashing']);
        assert.deepStrictEqual(suggestFrom({ description: 'A player wins a round in Fortnite', transcript: 'nice shot' }), []);
        ok('the suggester reads the scene and the transcript, never a spoiler');

        // Two slots: one plain, one labelled 18+. Their live sessions carry the labels.
        const plain = await makeSlot('plain', ['language']);
        const adult = await makeSlot('adult', ['18+']);
        const plainLive = await call('POST', '', { managed_stream_id: plain, title: 'A quiet stream' });
        const adultLive = await call('POST', '', { managed_stream_id: adult, title: 'An adult stream' });
        assert.strictEqual(plainLive.status, 201, JSON.stringify(plainLive.body));
        assert.strictEqual(adultLive.status, 201, JSON.stringify(adultLive.body));
        assert.deepStrictEqual(labelsOf(plainLive.body.stream).labels, ['language'], 'a live session copies the slot labels');
        assert.deepStrictEqual(labelsOf(adultLive.body.stream).labels, ['18+']);

        // The home list (GET /api/streams, what the home live rail polls) skips 18+; the channel page does not.
        const home = await call('GET', '');
        const homeIds = home.body.streams.map((s) => Number(s.id));
        assert.ok(homeIds.includes(Number(plainLive.body.stream.id)), 'the plain stream is on the home list');
        assert.ok(!homeIds.includes(Number(adultLive.body.stream.id)), 'nothing labelled 18+ is on the home list');
        assert.ok(!JSON.stringify(home.body).includes('An adult stream'), 'the 18+ stream is not in the home payload at all');
        const onChannel = await call('GET', '/channel/labels/live');
        const shown = onChannel.body.streams.find((s) => Number(s.id) === Number(adultLive.body.stream.id));
        assert.ok(shown, 'the channel page still shows it');
        assert.deepStrictEqual(labelsOf(shown).labels, ['18+'], 'with its chip');
        ok('the home page skips 18+; the channel page shows it with its label');

        // The AI suggests on the plain stream: stored as suggested, never applied.
        const streamId = Number(plainLive.body.stream.id);
        const suggested = await db.suggestStreamContentLabels(streamId, ['nudity', '18+']);
        assert.deepStrictEqual(suggested.suggested, ['nudity', '18+']);
        let live = await call('GET', `/${streamId}`);
        assert.deepStrictEqual(labelsOf(live.body.stream), { labels: ['language'], suggested: ['nudity', '18+'] }, 'a suggestion changes no label');
        ok('the AI suggestion is stored as suggested, never applied');

        // The creator confirms: the labels apply, the confirmed ones leave the suggestions.
        let r = await call('PUT', `/${streamId}`, { labels: ['language', 'nudity', '18+'] });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(labelsOf(r.body.stream), { labels: ['language', 'nudity', '18+'], suggested: [] }, 'confirming applies and clears the suggestion');
        r = await call('GET', '');
        assert.ok(!r.body.streams.some((s) => Number(s.id) === streamId), 'a newly labelled 18+ stream leaves the home list');
        assert.strictEqual((await call('PUT', `/${streamId}`, { labels: ['gore'] })).status, 400, 'an unknown label is refused');
        ok('the creator confirms; an unknown label is refused');

        // The setup/dashboard writes the slot: the live session follows, and its suggestions are kept.
        await db.suggestStreamContentLabels(streamId, ['flashing']);
        r = await call('PUT', `/managed/${plain}`, { labels: ['language', 'spoilers'] });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(labelsOf(r.body.managed_stream), { labels: ['language', 'spoilers'], suggested: [] }, 'the slot stores the creator labels');
        live = await call('GET', `/${streamId}`);
        assert.deepStrictEqual(labelsOf(live.body.stream), { labels: ['language', 'spoilers'], suggested: ['flashing'] }, 'the live session takes the new labels and keeps the AI suggestion');
        assert.strictEqual((await call('PUT', `/managed/${plain}`, { labels: ['gore'] })).status, 400, 'the setup refuses an unknown label');
        ok('the setup writes the slot and the live session follows');

        // A signed-out viewer sees the same labels: nothing is hidden from anyone by the label itself.
        const anon = await fetch(`http://127.0.0.1:${server.address().port}/api/streams/channel/labels/live`).then((x) => x.json());
        assert.deepStrictEqual(labelsOf(anon.streams.find((s) => Number(s.id) === streamId)).labels, ['language', 'spoilers'], 'a signed-out visitor gets the chip data');
        ok('a signed-out visitor sees the labels');
    } finally {
        await new Promise((r) => server.close(r));
    }
    console.log(`content labels: ${pass} checks — home skips 18+, suggestions stay suggestions`);
})().catch((err) => { console.error(err); process.exit(1); });
