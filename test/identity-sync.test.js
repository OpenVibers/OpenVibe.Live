'use strict';

// Canonical subjects on the Live side (roadmap Wave 1): the Network token's subject_id lands on
// req.user and linked_accounts, and every Live<->Network link is pushed to Network's
// identity_legacy_map in batches (against a stub Network).

const assert = require('assert');
const http = require('http');

process.env.OV_OAUTH_CLIENT_SECRET = 'live-secret';
const { tokenReply, sentToken } = require('./helpers/network-token-stub');

const received = [];
const resolveCalls = [];
const mode = { old: false };
// A well-formed subject per Network user id (Crockford base32, 26 chars).
const subjectFor = (n) => `usr_01J${String(n).padStart(23, '0')}`;
const network = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        if (req.url === '/oauth/token') return tokenReply(res);
        if (mode.old) { res.statusCode = 404; return res.end('{}'); }
        assert.ok(sentToken(req), 'Live sends its service token, never the internal key');
        if (req.url === '/internal/identity/resolve-batch') {
            const q = JSON.parse(body);
            resolveCalls.push(q);
            const results = {};
            for (const id of q.ids) {
                const n = Number(id);
                if (n === 1002) results[id] = null;                                                              // Network does not know it
                else if (n === 1003) results[id] = { subject: { type: 'user', id: subjectFor(n) }, network_user_id: 7 };  // answers for someone else
                else if (n === 1004) results[id] = { subject: { type: 'user', id: 'not-a-subject' }, network_user_id: n };
                else results[id] = { subject: { type: 'user', id: subjectFor(n) }, network_user_id: n };
            }
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ results }));
        }
        assert.strictEqual(req.url, '/internal/identity/legacy-map');
        const { entries } = JSON.parse(body);
        received.push(entries);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ inserted: entries.length - 1, unchanged: 0, conflicts: [{ index: 0, source: `live:user:${entries[0].source_id}`, mapped_to: 'usr_A', requested: 'usr_B' }], rejected: [] }));
    });
});

(async () => {
    await new Promise((r) => network.listen(0, '127.0.0.1', r));
    process.env.OV_NETWORK_INTERNAL_URL = `http://127.0.0.1:${network.address().port}`;

    const db = require('../server/db/database');
    await db.initDb();
    const sync = require('../server/auth/identity-sync');
    const d = db.getDb();

    assert.ok(await d.prepare("SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'linked_accounts' AND column_name = 'subject_id'").get(), 'linked_accounts.subject_id exists');

    // 600 linked users (two batches) plus one legacy non-numeric row that must not be sent.
    const insUser = d.prepare("INSERT INTO users (username, password_hash, stream_key) VALUES (?, 'x', ?) RETURNING id");
    const insLink = d.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, service_username) VALUES (?, 'network', ?, ?)");
    for (let i = 1; i <= 600; i++) {
        const id = (await insUser.run(`u${i}`, `key${i}`)).lastInsertRowid;
        await insLink.run(id, String(1000 + i), `u${i}`);
    }
    const odd = (await insUser.run('odd', 'keyodd')).lastInsertRowid;
    await insLink.run(odd, 'network:odd', 'odd');

    const out = await sync.syncLegacyMap();
    assert.strictEqual(received.length, 2, 'batched by 500');
    assert.strictEqual(out.sent, 600, 'non-numeric links are skipped');
    assert.strictEqual(out.conflicts, 2, 'conflicts are counted, not retried');
    const first = received[0][0];
    assert.deepStrictEqual(Object.keys(first).sort(), ['network_user_id', 'source_id', 'source_system', 'source_type', 'verified']);
    assert.strictEqual(first.source_system, 'live');
    assert.strictEqual(typeof first.network_user_id, 'number');

    // A token's subject_id is stored once, only for a well-formed id and the matching link.
    const uid = (await d.prepare("SELECT user_id FROM linked_accounts WHERE service_user_id = '1001'").get()).user_id;
    await sync.noteSubject(uid, 1001, 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ');
    assert.strictEqual(await sync.subjectOf(uid), 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ');
    await sync.noteSubject(uid, 1001, '42');
    assert.strictEqual(await sync.subjectOf(uid), 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', 'malformed subject ignored');
    await sync.noteSubject(uid, 9999, 'usr_01JAB2C3D4E5F6G7H8J9K0MNPR');
    assert.strictEqual(await sync.subjectOf(uid), 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', 'a token for a different network id cannot rewrite the link');

    // Backfill: every link without a subject is asked by Network user id, in batches; only an answer
    // naming the same Network user id with a well-formed subject is stored, and a known one is kept.
    const back = await sync.backfillSubjects();
    assert.strictEqual(resolveCalls.length, 2, 'batched by 500');
    assert.strictEqual(resolveCalls[0].system, 'network');
    assert.strictEqual(resolveCalls[0].type, 'user');
    assert.ok(!resolveCalls.flatMap(q => q.ids).includes('1001'), 'a link with a subject is not asked');
    assert.ok(!resolveCalls.flatMap(q => q.ids).includes('network:odd'), 'non-numeric links are not asked');
    assert.deepStrictEqual(back, { asked: 599, stored: 596, unknown: 3 });
    assert.strictEqual(await sync.subjectOf(uid), 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', 'the token subject stays');
    const linkOf = async (n) => (await d.prepare('SELECT user_id FROM linked_accounts WHERE service_user_id = ?').get(String(n))).user_id;
    assert.strictEqual(await sync.subjectOf(await linkOf(1600)), subjectFor(1600));
    assert.strictEqual(await sync.subjectOf(await linkOf(1002)), null, 'unknown to Network');
    assert.strictEqual(await sync.subjectOf(await linkOf(1003)), null, 'an answer for another Network user is ignored');
    assert.strictEqual(await sync.subjectOf(await linkOf(1004)), null, 'a malformed subject is ignored');
    resolveCalls.length = 0;
    assert.deepStrictEqual(await sync.backfillSubjects(), { asked: 3, stored: 0, unknown: 3 }, 'the next run asks only what is still missing');

    // Network without the endpoint yet: skip quietly.
    mode.old = true;
    assert.deepStrictEqual(await sync.syncLegacyMap(), { skipped: 'network has no /internal/identity yet' });
    assert.deepStrictEqual(await sync.backfillSubjects(), { asked: 3, stored: 0, unknown: 0, skipped: 'network has no /internal/identity yet' });
    network.close();

    console.log('identity sync: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
