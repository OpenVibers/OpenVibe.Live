'use strict';
// Live's Vibes history words (billing.money-reason@1): a sentence, never a ledger key.
const assert = require('assert');
const money = require('../server/money/reasons');

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };

const tip = money.describe('donation', { site: 'live', subject: { name: '@alice' } });
ok(tip.text === 'for a tip to @alice', 'a tip names the creator');
ok(tip.subject.name === '@alice', 'and carries them as its subject');

const received = money.describe('donation:received', { site: 'live', subject: { name: '@bob' } });
ok(received.text === 'for a tip from @bob', 'a received tip names the sender');

ok(money.describe('purchase:vibes').text === 'for buying Vibes', 'a purchase is plain words');
ok(money.describe('cashout_request').text === 'for cashing out', 'a cashout is plain words');
ok(money.describe('recycle').text === 'for moving your cashout balance back to Vibes', 'a recycle is plain words');

const unknown = money.describe('nobody:declared-this', { site: 'live' });
ok(!unknown.known && unknown.text === 'for something on OpenVibe.Live', 'an undeclared key never shows itself');

console.log(`openvibe-live money reasons: ${n} checks passed`);
