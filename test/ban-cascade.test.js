/**
 * Site bans must never sweep up staff.
 *
 * Staff browse from the same home and mobile networks as people who get banned (on production all
 * three admins share an IP with some other account), and the admin exemption from IP bans only
 * covers sessions that are not themselves banned. A cascade or IP-wide ban that set is_banned on an
 * admin would lock them out of their own site. These run the real SQL against an in-memory DB.
 *
 *   node test/ban-cascade.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
let Database;
try { Database = require('better-sqlite3'); }
catch { Database = require('/home/workstation/OpenVibers/OpenVibe.Live/node_modules/better-sqlite3'); }

const ROOT = path.join(__dirname, '..');
let pass = 0;
const ok = (n) => { pass++; console.log('  ok -', n); };

function freshDb() {
    const d = new Database(':memory:');
    d.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT DEFAULT 'user', is_banned INTEGER DEFAULT 0, ban_reason TEXT);
        CREATE TABLE ip_log (id INTEGER PRIMARY KEY, user_id INTEGER, anon_id TEXT, ip_address TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE bans (id INTEGER PRIMARY KEY, user_id INTEGER, ip_address TEXT, reason TEXT, banned_by INTEGER, expires_at TEXT);
    `);
    const u = d.prepare('INSERT INTO users (id, username, role) VALUES (?, ?, ?)');
    u.run(1, 'owner', 'admin'); u.run(2, 'mod', 'global_mod'); u.run(3, 'troll', 'user'); u.run(4, 'trollalt', 'user'); u.run(5, 'bystander', 'streamer');
    const ip = d.prepare('INSERT INTO ip_log (user_id, ip_address) VALUES (?, ?)');
    // One shared household IP: the admin, the troll, the troll's alt and a streamer all used it.
    for (const id of [1, 3, 4, 5]) ip.run(id, '203.0.113.7');
    ip.run(2, '198.51.100.2'); ip.run(3, '198.51.100.2');   // the mod shares a different IP with the troll
    return d;
}
const wrap = (d) => ({
    all: (sql, p = []) => d.prepare(sql).all(...p),
    get: (sql, p = []) => d.prepare(sql).get(...p),
    run: (sql, p = []) => d.prepare(sql).run(...p),
});

// ── banAllAccountsOnIp, the real function body ───────────────────────────────
{
    const src = fs.readFileSync(path.join(ROOT, 'server/db/database.js'), 'utf8');
    const m = src.match(/function banAllAccountsOnIp\([^)]*\) \{[\s\S]*?\n\}/);
    assert(m, 'banAllAccountsOnIp should exist');
    const d = freshDb(); const h = wrap(d);
    // eslint-disable-next-line no-new-func
    const fn = new Function('all', 'run', `${m[0]}; return banAllAccountsOnIp;`)(h.all, h.run);
    const banned = fn('203.0.113.7', { reason: 'test', bannedBy: 5, expires: null });
    const flag = (id) => d.prepare('SELECT is_banned FROM users WHERE id = ?').get(id).is_banned;
    assert.strictEqual(flag(1), 0, 'the admin on the shared IP must not be banned');
    assert.strictEqual(flag(5), 0, 'the moderator issuing the ban must not ban themselves');
    assert.strictEqual(flag(3), 1, 'the troll is banned');
    assert.strictEqual(flag(4), 1, 'the alt is banned');
    assert.deepStrictEqual([...banned].sort(), [3, 4]);
    assert.deepStrictEqual([...banned.skippedStaff].sort(), [1, 5]);
    ok('IP-wide ban skips staff and the acting moderator, bans everyone else');
}

// ── performGlobalBan: cascade and rank checks ────────────────────────────────
{
    const src = fs.readFileSync(path.join(ROOT, 'server/admin/mod-routes.js'), 'utf8');
    const m = src.match(/function performGlobalBan\([^)]*\) \{[\s\S]*?\n\}/);
    assert(m, 'performGlobalBan should exist');
    const src2 = src.slice(src.indexOf("router.post('/global-ban'"), src.indexOf("router.delete('/users/:id/ban'"));
    assert(/performGlobalBan\(req, res/.test(src2) && (src2.match(/performGlobalBan\(req, res/g) || []).length === 2,
        'both ban routes must go through performGlobalBan');

    const RANK = { user: 0, streamer: 1, global_mod: 2, admin: 3 };
    const permissions = { roleRank: (r) => RANK[r] ?? 0, isStaff: (u) => (RANK[u && u.role] ?? 0) >= 2 };
    const run = (actorId, targetId) => {
        const d = freshDb(); const h = wrap(d);
        const db = {
            ...h,
            getUserById: (id) => d.prepare('SELECT * FROM users WHERE id = ?').get(id),
            getLatestIpForUser: (id) => d.prepare('SELECT ip_address FROM ip_log WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(id),
            getLinkedAccounts: (uid) => d.prepare(`SELECT u.id, u.username, u.role, u.is_banned FROM ip_log mine
                JOIN ip_log shared ON mine.ip_address = shared.ip_address AND shared.user_id != ?
                JOIN users u ON shared.user_id = u.id WHERE mine.user_id = ? GROUP BY shared.user_id`).all(uid, uid),
            logModerationAction: () => {},
        };
        const chatServer = { getConnectedUserIp: () => '203.0.113.7', disconnectUser: () => {} };
        // eslint-disable-next-line no-new-func
        const fn = new Function('db', 'chatServer', 'permissions', 'console', `${m[0]}; return performGlobalBan;`)(db, chatServer, permissions, { log() {} });
        let status = 200, body = null;
        const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
        const actor = db.getUserById(actorId);
        fn({ user: actor }, res, { userId: targetId, reason: 'test' });
        return { status, body, flag: (id) => d.prepare('SELECT is_banned FROM users WHERE id = ?').get(id).is_banned };
    };

    const r1 = run(2, 3);   // the mod bans the troll, whose IP the admin also used
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r1.flag(3), 1, 'target banned');
    assert.strictEqual(r1.flag(4), 1, 'alt on the shared IP banned');
    assert.strictEqual(r1.flag(1), 0, 'the admin on the shared IP is not cascade-banned');
    assert.strictEqual(r1.flag(2), 0, 'the moderator is not cascade-banned');
    ok('global ban cascade bans alts but never staff on a shared IP');

    const r2 = run(2, 1);   // a global mod tries to ban an admin
    assert.strictEqual(r2.status, 403, 'a moderator cannot ban higher-ranked staff');
    assert.strictEqual(r2.flag(1), 0);
    const r3 = run(2, 2);
    assert.strictEqual(r3.status, 400, 'nobody can ban themselves');
    ok('bans on equal/higher-ranked staff and self-bans are refused');
}

console.log(`\n${pass} checks passed`);
