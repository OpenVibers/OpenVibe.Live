/**
 * TURN credentials: short-lived HMAC pairs with TURN_AUTH_SECRET, the static pair without it, and
 * never a turn: entry without credentials.
 *   node test/turn-credentials.test.js
 */
'use strict';
const assert = require('assert');
const crypto = require('crypto');
process.env.NODE_ENV = 'test';
delete process.env.TURN_AUTH_SECRET;
const config = require('../server/config');
const turn = require('../server/net/turn');

config.turn = config.turn || {};
config.turn.url = 'turn:turn.example.org';
config.turn.username = 'static-user'; config.turn.credential = 'static-pass';
let e = turn.turnEntries(config.turn.url, 'u7');
assert.strictEqual(e.length, 2);
assert.strictEqual(e[0].username, 'static-user');
assert.strictEqual(e[1].urls, 'turn:turn.example.org?transport=tcp');

config.turn.username = ''; config.turn.credential = '';
assert.deepStrictEqual(turn.turnEntries(config.turn.url, 'u7'), [], 'no credentials → no turn: entry');

process.env.TURN_AUTH_SECRET = 'top-secret';
e = turn.turnEntries(config.turn.url, 'u7');
const [expiry, tag] = e[0].username.split(':');
assert.strictEqual(tag, 'u7');
assert.ok(Number(expiry) > Date.now() / 1000 + 3000 && Number(expiry) < Date.now() / 1000 + 3700, 'expires in about an hour');
assert.strictEqual(e[0].credential, crypto.createHmac('sha1', 'top-secret').update(e[0].username).digest('base64'));
assert.strictEqual(turn.turnEntries(config.turn.url, 'bad tag/;').at(-1).username.split(':')[1], 'badtag');
console.log('turn credentials: all checks passed');
