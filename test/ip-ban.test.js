'use strict';

// IP / network bans: a bans.ip_address row is one address (exact) or a CIDR block (a whole
// home network), and the site owner (admin) passes both so a shared home network can be banned
// without locking the owner out. Runs on a temp DB.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-ipban-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
const db = require('../server/db/database');
db.initDb();

const uid = Number(db.createUser({ username: 'meanie', email: 'm@x', password_hash: 'x', display_name: 'Meanie', stream_key: 'k'.repeat(32) }).lastInsertRowid);
db.run(`INSERT INTO bans (user_id, ip_address, reason) VALUES (?, ?, ?)`, [uid, '2601:601:9181:bb00::/64', 'home network']);
db.run(`INSERT INTO bans (ip_address, reason) VALUES (?, ?)`, ['67.170.61.128', 'home v4']);
db.run(`INSERT INTO bans (ip_address, reason) VALUES (?, ?)`, ['2600:387:15:3737::/64', 'phone']);
db.run(`INSERT INTO bans (ip_address, reason, expires_at) VALUES (?, ?, datetime('now', '-1 day'))`, ['10.0.0.0/8', 'expired']);
db.invalidateIpBanCache();

// CIDR: every address in the home /64 is banned, the neighbouring /64 is not.
assert.ok(db.isIpBanned('2601:601:9181:bb00:c023:ff0f:38ee:1559', null));
assert.ok(db.isIpBanned('2601:601:9181:bb00::1', null));
assert.ok(!db.isIpBanned('2601:601:9181:bb01::1', null));
assert.ok(db.isIpBanned('2600:387:15:3737::5', null));
assert.ok(!db.isIpBanned('2600:387:15:3738::5', null));
// Exact v4, plus the IPv4-mapped form a proxy may hand us.
assert.ok(db.isIpBanned('67.170.61.128', null));
assert.ok(db.isIpBanned('::ffff:67.170.61.128', null));
assert.ok(!db.isIpBanned('67.170.61.129', null));
// Expired CIDR rows don't count; garbage input never throws.
assert.ok(!db.isIpBanned('10.1.2.3', null));
assert.ok(!db.isIpBanned('', null));
assert.ok(!db.isIpBanned('not-an-ip', null));
assert.ok(!db.isIpBanned(undefined, null));
// The ban row (and so the name on the ban page) comes back for CIDR hits.
assert.strictEqual(db.getIpBan('2601:601:9181:bb00::abcd', null).user_id, uid);
assert.strictEqual(db.getIpBan('67.170.61.128', null).reason, 'home v4');

// Stream-scoped CIDR ban only applies to that stream.
const sid = Number(db.createStream({ user_id: uid, title: 't', category: 'irl', protocol: 'rtmp' }).lastInsertRowid);
db.run(`INSERT INTO bans (ip_address, stream_id, reason) VALUES (?, ?, ?)`, ['203.0.113.0/24', sid, 'one stream']);
db.invalidateIpBanCache();
assert.ok(db.isIpBanned('203.0.113.9', sid));
assert.ok(!db.isIpBanned('203.0.113.9', null));
assert.ok(!db.isIpBanned('203.0.113.9', sid + 1));

console.log('ip-ban: OK');
