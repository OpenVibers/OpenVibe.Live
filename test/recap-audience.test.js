'use strict';
/**
 * An after-show report follows its stream's Rundown audience (RUNDOWN-CONTROLS design 2026-11-06): a stream whose
 * recording is private has no public report, the channel's report list leaves it out, and a public one still answers.
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const db = require('../server/db/database');

(async () => {
    await db.initDb();
    const visibility = require('../server/rundown/visibility');
    const recap = require('../server/recap/recap');
    // The report itself is not under test: a stand-in answers for any stream the gate lets through.
    const served = [];
    recap.getRecap = async (id) => { served.push(id); return { stream_id: id, streamer: { id: 0 }, headline: 'x' }; };
    recap.listRecaps = async () => [{ stream_id: privateId }, { stream_id: publicId }];

    await db.createUser({ username: 'recapper', email: 'recapper@x', password_hash: 'x', display_name: 'recapper', stream_key: 'recapper'.padEnd(32, '0') });
    const owner = Number((await db.get('SELECT id FROM users WHERE username = ?', ['recapper'])).id);
    const mkStream = async (title) => {
        const id = Number((await db.createStream({ user_id: owner, title, category: 'Just Chatting', protocol: 'rtmp' })).lastInsertRowid);
        await db.run("UPDATE streams SET is_live = 0, duration_seconds = 7200 WHERE id = ?", [id]);
        await db.run('INSERT INTO rundown_episodes (stream_id, user_id, title, vod_id) VALUES (?, ?, ?, ?)', [id, owner, title, id + 9000]).catch(() => {});
        return id;
    };
    var privateId = await mkStream('Private one');
    var publicId = await mkStream('Public one');
    await visibility.noteVodVisibility(privateId, 'private');
    await visibility.noteVodVisibility(publicId, 'public');

    const app = express();
    app.use('/api/recap', require('../server/recap/routes'));
    const server = await new Promise((ok) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => ok(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const hidden = await fetch(`${base}/api/recap/${privateId}`);
        assert.strictEqual(hidden.status, 404, 'a private recording has no public report');
        assert.ok(!served.includes(privateId), 'the report is not even read');
        const shown = await fetch(`${base}/api/recap/${publicId}`);
        assert.strictEqual(shown.status, 200, 'a public one still answers');
        assert.match(shown.headers.get('cache-control') || '', /public/);
        const list = await (await fetch(`${base}/api/recap/channel/recapper`)).json();
        assert.deepStrictEqual(list.recaps.map((r) => r.stream_id), [publicId], 'the list leaves the private one out');
        console.log('recap audience: a private recording has no public report, and lists leave it out');
    } finally {
        server.close();
    }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
