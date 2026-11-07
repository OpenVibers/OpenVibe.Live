'use strict';
/**
 * The channel page's Ask your agent chip (openvibe-shared 4.135.0, plan Z3): one [data-ov-ask] beside Share, with the
 * stream's channel and title while live ("About this stream on OpenVibe.Live: …"), the channel's own line offline
 * ("About <name>'s channel on OpenVibe.Live. "), and kit.askAgent's escaping. The fragment leaves the slot; the SEO
 * renderer fills it where the channel and its stream are known.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

const express = require('express');
const db = require('../server/db/database');
const media = require('../server/media-client');
const follows = require('../server/social/network-follows');

(async () => {
    await db.initDb();
    const raw = db.getDb();
    const addUser = (id, username, displayName) => raw.prepare(
        `INSERT INTO users (id, username, display_name, email, password_hash, role, created_at) OVERRIDING SYSTEM VALUE
         VALUES (?, ?, ?, ?, 'x', 'user', '2025-01-01 00:00:00')`).run(id, username, displayName, `${username}@x`);
    await addUser(1, 'alice', 'Alice');
    await addUser(2, 'bob', 'Bob');
    await addUser(3, 'escapee', 'Al<b> & "Co"');
    for (const id of [1, 2, 3]) await db.ensureChannel(id);
    const alice = await db.getChannelByUserId(1);
    await db.createStream({ user_id: 1, channel_id: alice.id, title: 'Live & loud', protocol: 'webrtc' });
    const escapee = await db.getChannelByUserId(3);
    await db.createStream({ user_id: 3, channel_id: escapee.id, title: 'Sneaky "title" & <tag>', protocol: 'webrtc' });

    // No upstreams in this test: the channel page only needs the account and its streams.
    media.listVods = async () => ({ vods: [] });
    media.listClips = async () => ({ clips: [] });
    follows.followerCount = async () => 0;

    const app = express();
    require('../server/seo').register(app);
    app.use((req, res) => res.status(404).type('text').send('not found'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = async (p) => {
        const r = await fetch(base + p, { headers: { accept: 'text/html,application/xhtml+xml' } });
        return { status: r.status, text: await r.text() };
    };
    const chips = (text) => text.match(/<button[^>]*data-ov-ask[^>]*>/g) || [];

    try {
        const live = await page('/@alice');
        assert.strictEqual(live.status, 200);
        const asks = chips(live.text);
        assert.strictEqual(asks.length, 1, 'one Ask your agent chip: ' + asks.join(' | '));
        assert.ok(asks[0].includes('data-ov-ask="About this stream on OpenVibe.Live: Alice — Live &amp; loud. "'), asks[0]);
        assert.ok(asks[0].includes('class="ovk-ask ovk-btn'), 'the shared kit chip');
        assert.ok(live.text.includes('id="ch-ask-slot"'), 'the fragment slot is filled');

        const offline = await page('/@bob');
        assert.strictEqual(offline.status, 200);
        const offAsks = chips(offline.text);
        assert.strictEqual(offAsks.length, 1, 'one Ask your agent chip offline too');
        assert.ok(offAsks[0].includes('data-ov-ask="About Bob&#39;s channel on OpenVibe.Live. "'), offAsks[0]);

        const nasty = await page('/@escapee');
        const nastyAsks = chips(nasty.text);
        assert.strictEqual(nastyAsks.length, 1, 'one Ask your agent chip');
        assert.ok(nastyAsks[0].includes('data-ov-ask="About this stream on OpenVibe.Live: Al&lt;b&gt; &amp; &quot;Co&quot; — Sneaky &quot;title&quot; &amp; &lt;tag&gt;. "'), nastyAsks[0]);
        assert.ok(!nastyAsks[0].includes('<tag>'), 'the channel and stream names are escaped in the chip');

        // The client keeps the chip beside Share in whichever action row is shown (live vs offline).
        const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-channel.js'), 'utf8');
        assert.match(client, /ch-ask-slot/);
        assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'fragments', 'channel.html'), 'utf8'), /id="ch-ask-slot"/);
        console.log('ask agent channel chip ok');
    } finally {
        await new Promise((r) => server.close(r));
        if (db.closeDb) await db.closeDb().catch(() => {});
        process.exit(0);
    }
})().catch((e) => { console.error(e); process.exit(1); });
