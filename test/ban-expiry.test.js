'use strict';
// A ban ends at expires_at read as a UTC instant, not as text (roadmap WS-I task 6, found by Chat's
// parity script): /timeout stores ISO ('…T…Z'), which as TEXT sorts after the same day's
// 'YYYY-MM-DD HH:MM:SS', so a 60-second timeout blocked the user on Live until midnight UTC.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-live-banexp-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.NODE_ENV = 'test';
const log = console.log; console.log = () => {};
const db = require('../server/db/database');
db.initDb();
console.log = log;
const d = db.getDb();
d.prepare("INSERT INTO users (id, username, email, password_hash) VALUES (1, 'ann', 'a@x', 'x'), (2, 'bob', 'b@x', 'x'), (3, 'cat', 'c@x', 'x')").run();
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const sqlite = (ms) => new Date(Date.now() + ms).toISOString().replace('T', ' ').slice(0, 19);
// ann: an ISO timeout that ended a minute ago (the bug kept it until midnight UTC)
d.prepare('INSERT INTO bans (user_id, stream_id, reason, expires_at) VALUES (1, NULL, ?, ?)').run('timeout', iso(-60000));
// bob: an ISO timeout that ends in a minute; cat: SQLite-format, ended an hour ago
d.prepare('INSERT INTO bans (user_id, stream_id, reason, expires_at) VALUES (2, NULL, ?, ?)').run('timeout', iso(60000));
d.prepare('INSERT INTO bans (user_id, stream_id, reason, expires_at) VALUES (3, NULL, ?, ?)').run('timeout', sqlite(-3600000));
assert.strictEqual(db.isUserBanned(1, null), false, 'an ISO timeout that ended is over');
assert.strictEqual(db.isUserBanned(2, null), true, 'an ISO timeout still running holds');
assert.strictEqual(db.isUserBanned(3, null), false, 'a SQLite-format expiry in the past is over');
d.prepare('INSERT INTO bans (user_id, stream_id, reason, expires_at) VALUES (3, NULL, ?, NULL)').run('ban');
assert.strictEqual(db.isUserBanned(3, null), true, 'a ban without an end holds');
fs.rmSync(tmp, { recursive: true, force: true });
console.log('ban expiry: all checks passed');
