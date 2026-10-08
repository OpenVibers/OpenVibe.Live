'use strict';
// Renamed channels (WS-B task 6): Live follows a Network rename (from the signed token, or from the
// Network names lookup for a name it has not seen), keeps a history, and /@old answers 301 → /@current
// (sub-path and query kept); a bare /old stays a 404, unknown names stay 404, clashes never rename.
const assert = require('assert');
const http = require('http');

process.env.NODE_ENV = 'test';
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

(async () => {
    // Stub Network: GET /api/v1/users/names/:name
    const names = { carl_2: { current: 'carl_2', network_id: 88, renamed: false, previous_names: ['carl'] } };
    const net = http.createServer((req, res) => {
        const m = /^\/api\/v1\/users\/names\/([^/?]+)/.exec(req.url);
        const rec = m && names[decodeURIComponent(m[1]).toLowerCase()];
        res.writeHead(rec ? 200 : 404, { 'content-type': 'application/json' });
        res.end(JSON.stringify(rec || { error: 'not_found' }));
    });
    await new Promise((r) => net.listen(0, '127.0.0.1', r));
    process.env.OV_NETWORK_INTERNAL_URL = `http://127.0.0.1:${net.address().port}`;

    const express = require('express');
    const db = require('../server/db/database');
    await db.initDb();
    const usernames = require('../server/auth/usernames');
    const auth = require('../server/auth/auth');
    const pageStatus = require('../server/web/page-status');
    const add = async (name, networkId) => {
        const { lastInsertRowid: id } = await db.getDb().prepare("INSERT INTO users (username, password_hash, display_name) VALUES (?, 'x', ?) RETURNING id").run(name, name);
        if (networkId) await db.getDb().prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, service_username) VALUES (?, 'network', ?, ?)").run(id, String(networkId), name);
        return id;
    };
    const ann = await add('ann_old', 57), bob = await add('bob', 58), carl = await add('carl', 88);

    const app = express();
    app.get('*', pageStatus.spaFallback((res) => { res.type('html').send('<shell>'); return true; }));
    const srv = http.createServer(app);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const get = (p) => fetch(`http://127.0.0.1:${srv.address().port}${p}`, { redirect: 'manual' }).then((r) => ({ status: r.status, location: r.headers.get('location') }));
    try {
        // Follow a rename carried by the signed token (resolveNetworkUser runs the SSO field sync).
        const u = await auth.resolveNetworkUser({ sub: 57, id: 57, username: 'ann_new', role: 'user' });
        assert.strictEqual(u && u.username, 'ann_new');
        assert.strictEqual(await usernames.localRenamedTo('ANN_OLD'), 'ann_new');
        assert.strictEqual(await usernames.syncUsername(bob, 'ann_new'), false, 'never onto someone else\'s name');
        assert.strictEqual(await usernames.syncUsername(ann, 'ANN_NEW'), false, 'case-only is not a rename');

        assert.deepStrictEqual(await get('/@ann_new'), { status: 200, location: null });
        assert.deepStrictEqual(await get('/@ann_old'), { status: 301, location: '/@ann_new' });
        assert.deepStrictEqual(await get('/@ann_old/slot2?ref=hat'), { status: 301, location: '/@ann_new/slot2?ref=hat' });
        assert.strictEqual((await get('/ann_old')).status, 404, 'a bare /name is never a channel URL');
        assert.strictEqual((await get('/@nobody_here')).status, 404);

        // A new name Live has not seen yet: picked up from the Network, and the old one redirects.
        assert.strictEqual((await get('/@carl_2')).status, 200);
        assert.strictEqual((await db.getUserById(carl)).username, 'carl_2');
        assert.deepStrictEqual(await get('/@carl'), { status: 301, location: '/@carl_2' });
    } finally {
        srv.close(); net.close();
    }
    quiet('renamed channels: all checks passed');
})().catch((e) => { console.error = quiet; quiet(e); process.exit(1); });
