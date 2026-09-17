/**
 * Public stream and channel responses carry no secrets.
 *
 * The public channel endpoint returned every slot's ingest key (managed_streams[].stream_key),
 * enough to publish to anyone's slot over RTMP or WHIP. This mounts the real streaming router on a
 * temp database with a slot that has a key and a home ZIP, calls the public endpoints anonymously,
 * and fails on any secret column anywhere in the JSON.
 *
 *   node test/public-serializers.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = path.join(os.tmpdir(), `ov-serializers-${process.pid}.db`);
process.env.DB_PATH = tmp;
process.env.NODE_ENV = 'test';

const { findSecrets, publicManagedStream, publicChannel, publicStream, publicUserProfile } = require('../server/web/serializers');

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); }
    catch (e) { failures++; console.log('  ✗', name, '\n     ', e.stack.split('\n').slice(0, 3).join('\n      ')); }
}

(async () => {
    await check('serializers drop secrets without mutating their input', () => {
        const slot = { id: 1, title: 'Main', stream_key: 'k'.repeat(40), weather_zip: '90210', broadcast_settings: '{}' };
        const pub = publicManagedStream(slot);
        assert.strictEqual(pub.stream_key, undefined);
        assert.strictEqual(pub.weather_zip, undefined);
        assert.strictEqual(pub.title, 'Main');
        assert.strictEqual(slot.stream_key.length, 40, 'input untouched');
        const ch = publicChannel({ id: 2, weather_zip: '90210', weather_detail: 'detailed', title: 'x' });
        assert.strictEqual(ch.weather_zip, undefined);
        assert.strictEqual(ch.weather_enabled, true);
        const st = publicStream({ id: 3, stream_key: 'a', managed_stream_key: 'b', channel: { weather_zip: '1' } });
        assert.deepStrictEqual(findSecrets(st), []);
        assert.strictEqual(st.channel.weather_zip, undefined);
        const prof = publicUserProfile({ id: 4, email: 'e@x', openvibe_bucks_balance: 50, password_hash: 'h' });
        assert.deepStrictEqual(Object.keys(prof), ['id']);
    });

    await check('findSecrets reports nested keys', () => {
        assert.deepStrictEqual(findSecrets({ a: [{ stream_key: 'x' }], b: { token: '' } }), ['$.a[0].stream_key']);
    });

    const db = require('../server/db/database');
    db.initDb();
    const raw = db.getDb();
    raw.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role, stream_key)
                 VALUES (901, 'keyowner', 'Key Owner', 'owner@example.com', 'x', 'streamer', ?)`).run('u'.repeat(32));
    db.ensureChannel(901);
    const channel = db.getChannelByUserId(901);
    raw.prepare('UPDATE channels SET weather_zip = ?, weather_detail = ? WHERE id = ?').run('90210', 'detailed', channel.id);
    raw.prepare(`INSERT INTO managed_streams (user_id, channel_id, slug, title, protocol, stream_key, weather_zip)
                 VALUES (901, ?, 'main', 'Main slot', 'rtmp', ?, '90210')`).run(channel.id, 'S'.repeat(40));
    const ms = raw.prepare('SELECT id FROM managed_streams WHERE user_id = 901').get();
    raw.prepare(`INSERT INTO streams (user_id, channel_id, title, protocol, is_live, managed_stream_id, started_at)
                 VALUES (901, ?, 'Live now', 'rtmp', 1, ?, CURRENT_TIMESTAMP)`).run(channel.id, ms.id);

    const express = require('express');
    const app = express();
    app.use('/api/streams', require('../server/streaming/routes'));
    const server = http.createServer(app).listen(0);
    await new Promise((r) => server.once('listening', r));
    const getJson = (p) => new Promise((resolve, reject) => {
        http.get({ port: server.address().port, path: p }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(body), text: body }); } catch (e) { reject(new Error(`${p}: ${res.statusCode} ${body.slice(0, 200)}`)); } });
        }).on('error', reject);
    });

    for (const p of ['/api/streams/channel/keyowner', '/api/streams/channel/keyowner?pollOnly=1', '/api/streams', '/api/streams/recent']) {
        await check(`anonymous GET ${p} contains no secret column, key or ZIP`, async () => {
            const r = await getJson(p);
            assert.strictEqual(r.status, 200, r.text.slice(0, 200));
            assert.deepStrictEqual(findSecrets(r.body), []);
            assert.ok(!r.text.includes('S'.repeat(40)), 'slot key string present');
            assert.ok(!r.text.includes('u'.repeat(32)), 'account key string present');
            assert.ok(!r.text.includes('90210'), 'home ZIP present');
            assert.ok(!r.text.includes('owner@example.com'), 'email present');
        });
    }

    await check('the channel response still lists the slot for the page to render', async () => {
        const r = await getJson('/api/streams/channel/keyowner');
        assert.strictEqual(r.body.managed_streams.length, 1);
        assert.strictEqual(r.body.managed_streams[0].title, 'Main slot');
    });

    await check('stream detail keeps the channel but not its ZIP', async () => {
        const live = raw.prepare('SELECT id FROM streams WHERE user_id = 901').get();
        const r = await getJson(`/api/streams/${live.id}`);
        assert.strictEqual(r.status, 200);
        assert.ok(r.body.stream && r.body.stream.channel, 'channel attached: ' + r.text.slice(0, 300));
        assert.deepStrictEqual(findSecrets(r.body), []);
        assert.ok(!r.text.includes('90210'));
    });

    server.close();
    for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmp + ext); } catch { /* */ } }
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
    console.log('\npublic serializers: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
