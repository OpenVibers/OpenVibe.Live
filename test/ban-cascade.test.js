/** Site bans must not sweep up staff on a shared IP. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const database = require('../server/db/database');
const ROOT = path.join(__dirname, '..');

(async () => {
    await database.initDb();
    const d = database.getDb();
    const freshDb = async () => {
        await database.run('DELETE FROM bans');
        await database.run('DELETE FROM ip_log');
        await database.run('DELETE FROM users WHERE id IN (1, 2, 3, 4, 5)');
        for (const [id, username, role] of [
            [1, 'owner', 'admin'], [2, 'mod', 'global_mod'], [3, 'troll', 'user'],
            [4, 'trollalt', 'user'], [5, 'bystander', 'streamer'],
        ]) await d.prepare('INSERT INTO users (id, username, role, password_hash) OVERRIDING SYSTEM VALUE VALUES (?, ?, ?, ?)').run(id, username, role, 'x');
        for (const id of [1, 3, 4, 5]) await d.prepare('INSERT INTO ip_log (user_id, ip_address) VALUES (?, ?)').run(id, '203.0.113.7');
        await d.prepare('INSERT INTO ip_log (user_id, ip_address) VALUES (?, ?)').run(2, '198.51.100.2');
        await d.prepare('INSERT INTO ip_log (user_id, ip_address) VALUES (?, ?)').run(3, '198.51.100.2');
    };
    const wrap = {
        all: (sql, p = []) => database.all(sql, p),
        get: (sql, p = []) => database.get(sql, p),
        run: (sql, p = []) => database.run(sql, p),
    };
    const flag = async (id) => (await database.get('SELECT is_banned FROM users WHERE id = ?', [id])).is_banned;

    const src = fs.readFileSync(path.join(ROOT, 'server/db/database.js'), 'utf8');
    const m = src.match(/async function banAllAccountsOnIp\([^)]*\) \{[\s\S]*?\n\}/);
    assert(m, 'banAllAccountsOnIp should exist');
    await freshDb();
    const fn = new Function('all', 'run', `${m[0]}; return banAllAccountsOnIp;`)(wrap.all, wrap.run);
    const banned = await fn('203.0.113.7', { reason: 'test', bannedBy: 5, expires: null });
    assert.strictEqual(await flag(1), 0, 'the admin on the shared IP must not be banned');
    assert.strictEqual(await flag(5), 0, 'the moderator issuing the ban must not ban themselves');
    assert.strictEqual(await flag(3), 1, 'the troll is banned');
    assert.strictEqual(await flag(4), 1, 'the alt is banned');
    assert.deepStrictEqual([...banned].sort(), [3, 4]);
    assert.deepStrictEqual([...banned.skippedStaff].sort(), [1, 5]);
    console.log('  ok - IP-wide ban skips staff and the acting moderator');

    const modSrc = fs.readFileSync(path.join(ROOT, 'server/admin/mod-routes.js'), 'utf8');
    const modFn = modSrc.match(/async function performGlobalBan\([^)]*\) \{[\s\S]*?\n\}/);
    assert(modFn, 'performGlobalBan should exist');
    const routes = modSrc.slice(modSrc.indexOf("router.post('/global-ban'"), modSrc.indexOf("router.delete('/users/:id/ban'"));
    assert(/performGlobalBan\(req, res/.test(routes) && (routes.match(/performGlobalBan\(req, res/g) || []).length === 2,
        'both ban routes must go through performGlobalBan');
    const RANK = { user: 0, streamer: 1, global_mod: 2, admin: 3 };
    const permissions = { roleRank: (r) => RANK[r] ?? 0, isStaff: (u) => (RANK[u && u.role] ?? 0) >= 2 };
    const run = async (actorId, targetId) => {
        await freshDb();
        const db = {
            ...wrap,
            getUserById: (id) => database.get('SELECT * FROM users WHERE id = ?', [id]),
            getLatestIpForUser: (id) => database.get('SELECT ip_address FROM ip_log WHERE user_id = ? ORDER BY id DESC LIMIT 1', [id]),
            getLinkedAccounts: (uid) => database.all(`SELECT DISTINCT u.id, u.username, u.role, u.is_banned FROM ip_log mine
                JOIN ip_log shared ON mine.ip_address = shared.ip_address AND shared.user_id != ?
                JOIN users u ON shared.user_id = u.id WHERE mine.user_id = ?`, [uid, uid]),
            logModerationAction: async () => {},
        };
        const delivery = { getConnectedUserIp: () => '203.0.113.7', disconnect: async () => {}, logModeration: async () => {} };
        const perform = new Function('db', 'delivery', 'permissions', 'console', `${modFn[0]}; return performGlobalBan;`)(db, delivery, permissions, { log() {} });
        let status = 200, body = null;
        const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
        const actor = await db.getUserById(actorId);
        await perform({ user: actor }, res, { userId: targetId, reason: 'test' });
        return { status, body, flag };
    };
    const r1 = await run(2, 3);
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(await r1.flag(3), 1, 'target banned');
    assert.strictEqual(await r1.flag(4), 1, 'alt on the shared IP banned');
    assert.strictEqual(await r1.flag(1), 0, 'admin on shared IP untouched');
    assert.strictEqual(await r1.flag(2), 0, 'moderator untouched');
    console.log('  ok - global ban cascade bans alts but never staff');
    const r2 = await run(2, 1);
    assert.strictEqual(r2.status, 403, 'a moderator cannot ban higher-ranked staff');
    assert.strictEqual(await r2.flag(1), 0);
    const r3 = await run(2, 2);
    assert.strictEqual(r3.status, 400, 'nobody can ban themselves');
    console.log('  ok - staff-rank and self-ban checks hold');
    console.log('\n3 checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
