'use strict';
const assert = require('assert');
const { batchForUsers } = require('../server/levels/client');
(async () => {
    const calls = [];
    const subjectOf = async id => `usr_${String(id).padStart(26, '0')}`;
    const fetchImpl = async url => {
        const subjects = new URL(url).searchParams.get('subjects').split(','); calls.push(subjects);
        return { ok: true, json: async () => ({ levels: Object.fromEntries(subjects.map(s => [s, 3])) }) };
    };
    const ids = Array.from({ length: 205 }, (_, i) => i + 1);
    const first = await batchForUsers(ids, { subjectOf, fetchImpl, now: () => 1000 });
    assert.equal(first[1], 3); assert.equal(first[205], 3);
    assert.deepEqual(calls.map(c => c.length), [100, 100, 5]);
    await batchForUsers(ids, { subjectOf, fetchImpl, now: () => 2000 }); assert.equal(calls.length, 3);
    const down = await batchForUsers(ids, { subjectOf, fetchImpl: async () => { throw new Error('down'); }, now: () => 40000 });
    assert.deepEqual(down, {});
    console.log('levels: 205 people in three bounded batches, 30-second cache and graceful outage passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
