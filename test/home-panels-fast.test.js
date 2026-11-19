'use strict';
/**
 * The home's panels answer without waiting (server/home/routes.js, server/home/daily-quest.js; the owner, 2026-11-19:
 * "faster responses"). What this proves:
 *   - the digest's recap links come from one read and still name each streamer's newest recap in the window;
 *   - the day-over-day changes are numbers;
 *   - a stale pulse answers at once with the last one while a single rebuild runs behind it;
 *   - the daily quest asks this host's own Quest, not openvibe.quest through Cloudflare.
 */
const assert = require('assert');
const http = require('http');
const express = require('express');

process.env.OV_NETWORK_INTERNAL_URL = 'http://127.0.0.1:9';
process.env.OV_REPORT_INTERNAL_URL = 'http://127.0.0.1:9';
delete process.env.OV_QUEST_INTERNAL_URL;
const db = require('../server/db/database');

(async () => {
    await db.initDb();
    require('../server/chat/chat-reads').windowStatsPeek = async () => ({ messages: 0 });
    require('../server/chat/chat-reads').windowStats = async () => ({ messages: 0 });
    require('../server/home/daily-quest').readDailyQuest = async () => null;

    const ago = (min) => new Date(Date.now() - min * 60000).toISOString().replace('T', ' ').slice(0, 19);
    const mk = async (username) => {
        await db.createUser({ username, email: `${username}@x`, password_hash: 'x', display_name: username, stream_key: username.padEnd(32, '0') });
        return (await db.get('SELECT id FROM users WHERE username = ?', [username])).id;
    };
    const stream = async (uid, startMin) => (await db.run('INSERT INTO streams (user_id, title, is_live, started_at, ended_at, duration_seconds) VALUES (?, ?, 0, ?, ?, 3600) RETURNING id',
        [uid, 'Night', ago(startMin), ago(startMin - 60)])).lastInsertRowid;
    const recap = (sid, uid, createdMin) => db.run('INSERT INTO stream_recaps (stream_id, user_id, json, created_at) VALUES (?, ?, ?, ?)', [sid, uid, '{}', ago(createdMin)]);

    const cora = await mk('corafast'), dev = await mk('devfast');
    const older = await stream(cora, 600), newer = await stream(cora, 300);
    await stream(dev, 400);
    await recap(older, cora, 500);
    await recap(newer, cora, 200);

    const app = express();
    app.use('/api/home', require('../server/home/routes'));
    const server = http.createServer(app);
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const base = `http://127.0.0.1:${server.address().port}/api/home`;
    try {
        const d = await (await fetch(`${base}/digest`)).json();
        const row = (name) => d.streamed.find((r) => r.username === name);
        assert.ok(row('corafast') && row('devfast'), 'both streamers are in "Who streamed"');
        assert.strictEqual(Number(row('corafast').recap_stream_id), Number(newer), 'the newest recap in the window, from one read');
        assert.strictEqual(row('devfast').recap_stream_id, null, 'no recap, no link');
        for (const k of ['streams', 'takes', 'new_follows', 'new_members']) assert.strictEqual(typeof d.changes[k], 'number', `changes.${k} is a number`);
        assert.ok(d.stats.streams >= 3, 'the window counts the streams');

        // Pulse: built, then stale; the stale one answers at once and one rebuild runs behind it.
        let builds = 0, gate = null;
        const realPulse = db.getHomePulse;
        db.getHomePulse = async () => { builds++; if (gate) await gate; return { liveChannels: [], marker: builds }; };
        const first = await (await fetch(`${base}/pulse`)).json();
        assert.strictEqual(first.marker, 1);
        let open; gate = new Promise((r) => { open = r; });
        const realNow = Date.now;
        Date.now = () => realNow() + 45_000;
        try {
            const t0 = realNow();
            const [a, b] = await Promise.all([fetch(`${base}/pulse`).then((r) => r.json()), fetch(`${base}/pulse`).then((r) => r.json())]);
            assert.ok(realNow() - t0 < 1000, 'a stale pulse answers at once');
            assert.strictEqual(a.marker, 1, 'with the last pulse');
            assert.strictEqual(b.marker, 1);
            assert.strictEqual(builds, 2, 'one rebuild, however many readers');
            open(); gate = null;
            await new Promise((r) => setTimeout(r, 50));
            assert.strictEqual((await (await fetch(`${base}/pulse`)).json()).marker, 2, 'then the rebuilt pulse');
        } finally { Date.now = realNow; db.getHomePulse = realPulse; }
    } finally { server.close(); }

    // The daily quest's default address is this host's own Quest.
    delete require.cache[require.resolve('../server/home/daily-quest')];
    const { readDailyQuest } = require('../server/home/daily-quest');
    const urls = [];
    await readDailyQuest({ fetchImpl: async (url) => { urls.push(String(url)); return { ok: false }; } });
    assert.ok(urls.length && urls.every((u) => u.startsWith('http://127.0.0.1:4980/')), `Quest is asked locally: ${urls.join(', ')}`);

    console.log('home panels: one recap read, the changes, a stale pulse at once, Quest over this host');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
