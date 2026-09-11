'use strict';

// The cashout ledger behind the RobotStreamer switch bonus: one switch claim per account,
// referral rows minted on approval (VIP rate for the VIP recruiter), payout details + cashout
// requests, owner decisions, balances. Temp DB, no network (notifications are best-effort).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-claims-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.RS_PROMO_VIP_USER = 'Patrick';
process.env.RS_PROMO_REFERRAL_VIP = '20';
process.env.RS_PROMO_REFERRAL = '10';
process.env.RS_PROMO_AMOUNT = '50';

const db = require('../server/db/database');
db.initDb();
const claims = require('../server/promo/claims');

const mk = (username) => Number(db.createUser({ username, email: `${username}@x`, password_hash: 'x', display_name: username, stream_key: username.padEnd(32, '0') }).lastInsertRowid);
const convert = mk('rsguy'), patrick = mk('Patrick'), normie = mk('normie'), convert2 = mk('rsguy2');

// Validation
assert.throws(() => claims.submitSwitch(convert, { rs_username: '', method: 'zelle', payout_detail: '555' }), /RobotStreamer username/);
assert.throws(() => claims.submitSwitch(convert, { rs_username: 'rsguy', method: 'venmo', payout_detail: '555' }), /Zelle, PayPal or crypto/);
assert.throws(() => claims.submitSwitch(convert, { rs_username: 'rsguy', method: 'paypal', payout_detail: '' }), /PayPal email/);
assert.throws(() => claims.submitSwitch(convert, { rs_username: 'rsguy', method: 'zelle', payout_detail: '555-0100', referrer: 'nobody_here' }), /No OpenVibe user/);
assert.throws(() => claims.submitSwitch(convert, { rs_username: 'rsguy', method: 'zelle', payout_detail: '555-0100', referrer: 'rsguy' }), /refer yourself/);

// A convert files a claim naming Patrick (the VIP recruiter)
const c1 = claims.submitSwitch(convert, { rs_username: 'RSGuy', method: 'crypto', payout_detail: 'USDC / Solana / 9xy…', referrer: '@Patrick', note: 'build me a cozmo bridge' });
assert.strictEqual(c1.status, 'pending'); assert.strictEqual(c1.amount, 50); assert.strictEqual(c1.referrer_username, 'Patrick'); assert.strictEqual(c1.method, 'crypto');
assert.throws(() => claims.submitSwitch(convert, { rs_username: 'RSGuy', method: 'zelle', payout_detail: '555' }), /already have a switch claim/);
let mine = claims.mine(convert);
assert.deepStrictEqual(mine.balance, { pending: 50, approved: 0, paid: 0 }); assert.strictEqual(mine.has_switch_claim, true); assert.strictEqual(mine.referral_rate, 10);
assert.strictEqual(claims.mine(patrick).referral_rate, 20, 'the VIP recruiter sees his rate');
console.log('✅ switch claim filed with validation');

// Owner approves at $40 → Patrick gets a $20 referral row (approved, no payout details yet)
const a1 = claims.setStatus(c1.id, { status: 'approved', amount: 40, admin_note: 'welcome' }, 1);
assert.strictEqual(a1.status, 'approved'); assert.strictEqual(a1.amount, 40); assert.strictEqual(a1.admin_note, 'welcome');
let pm = claims.mine(patrick);
assert.strictEqual(pm.claims.length, 1); assert.strictEqual(pm.claims[0].kind, 'referral'); assert.strictEqual(pm.claims[0].amount, 20); assert.strictEqual(pm.claims[0].status, 'approved'); assert.strictEqual(pm.claims[0].source_claim_id, c1.id);
assert.deepStrictEqual(pm.balance, { pending: 0, approved: 20, paid: 0 });
claims.setStatus(c1.id, { status: 'approved' }, 1);
assert.strictEqual(claims.mine(patrick).claims.length, 1, 're-approving never mints a second referral');
// Patrick adds payout details → cashout requested
const pr = claims.setPayout(pm.claims[0].id, patrick, { method: 'paypal', payout_detail: 'patrick@example.com' });
assert.strictEqual(pr.status, 'cashout_requested'); assert.strictEqual(pr.method, 'paypal');
assert.throws(() => claims.setPayout(pm.claims[0].id, normie, { method: 'paypal', payout_detail: 'x@y.z' }), /No such claim/, 'only the owner of a claim can edit it');
console.log('✅ approval mints the VIP referral; payout details → cashout requested');

// A normal referrer gets the normal rate; rejection pays nothing
const c2 = claims.submitSwitch(convert2, { rs_username: 'rsguy2', method: 'zelle', payout_detail: '555-0199', referrer: 'normie' });
claims.setStatus(c2.id, { status: 'approved' }, 1);
assert.strictEqual(claims.mine(normie).claims[0].amount, 10);
claims.setStatus(c2.id, { status: 'paid' }, 1);
const paid = claims.mine(convert2);
assert.strictEqual(paid.claims[0].status, 'paid'); assert.ok(paid.claims[0].paid_at); assert.deepStrictEqual(paid.balance, { pending: 0, approved: 0, paid: 50 });
assert.throws(() => claims.setPayout(paid.claims[0].id, convert2, { method: 'zelle', payout_detail: '555' }), /closed/);
assert.throws(() => claims.setStatus(999, { status: 'paid' }, 1), /No such claim/);
assert.throws(() => claims.setStatus(c2.id, { status: 'nope' }, 1), /Bad status/);
const all = claims.listAll();
assert.strictEqual(all.totals.count, 4); assert.strictEqual(all.totals.paid, 50); assert.strictEqual(all.totals.approved, 70);
assert.strictEqual(all.claims[0].status, 'cashout_requested', 'owner list: actionable rows first');
assert.deepStrictEqual(claims.stats(), { claims: 4, converted: 2, paid: 50 });
console.log('✅ normal referral rate, paid, rejected/closed rules, owner totals');

console.log('\n✅ All promo cashout ledger tests passed');
process.exit(0);
