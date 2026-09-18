'use strict';
// Deploy notices fold into one rolling row, never repeat a commit, and stay silent without new code.
const assert = require('assert');
const dn = require('../server/chat/deploy-notice');

const rows = []; const settings = {};
const db = {
    getSetting: (k) => settings[k], setSetting: (k, v) => { settings[k] = v; },
    get: () => rows.filter(r => r.is_global && !r.is_deleted).slice(-1)[0] || undefined,
    run: (_sql, [message, metadata, id]) => { const r = rows.find(x => x.id === id); r.message = message; r.metadata = metadata; },
    saveChatMessage: (m) => { const r = { id: rows.length + 1, is_global: 1, is_deleted: 0, message_type: m.message_type, message: m.message, metadata: m.metadata ? JSON.stringify(m.metadata) : null }; rows.push(r); return { lastInsertRowid: r.id }; },
};
const c = (n) => ({ hash: String(n).repeat(40).slice(0, 40).replace(/[^0-9a-f]/g, 'a'), short: 'c' + n, subject: 'change ' + n, date: new Date().toISOString() });

const first = dn.persist(db, [c(1)]);
assert.equal(rows.length, 1); assert.equal(first.meta.deploys, 1);
const second = dn.persist(db, [c(2), c(1)]);                     // overlap with what is already there
assert.equal(rows.length, 1, 'a second deploy updates the same row');
assert.equal(second.id, first.id);
assert.deepEqual(second.meta.commits.map(x => x.short), ['c2', 'c1'], 'each commit once, newest first');
assert.equal(second.meta.deploys, 2);
assert.ok(/^🚀 2 updates shipped/.test(rows[0].message));

rows.push({ id: 2, is_global: 1, is_deleted: 0, message_type: 'chat', message: 'hello', metadata: null });   // someone spoke
const third = dn.persist(db, [c(3)]);
assert.equal(rows.length, 3, 'after real chat, the next deploy starts a new notice');
assert.equal(third.meta.deploys, 1);

const old = JSON.parse(rows[2].metadata); old.first_at = new Date(Date.now() - 13 * 3600 * 1000).toISOString(); rows[2].metadata = JSON.stringify(old);
dn.persist(db, [c(4)]);
assert.equal(rows.length, 4, 'a notice older than the fold window is not reopened');

assert.deepEqual(dn.parseLog('zz\x1fab\x1f2026\x1fnope'), [], 'malformed git lines are dropped');
console.log('deploy notice: all checks passed');
