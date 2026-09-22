'use strict';

// Canonical subjects on the Live side (roadmap Wave 1): the Network token's subject_id lands on
// req.user and linked_accounts, and every Live<->Network link is pushed to Network's
// identity_legacy_map in batches (against a stub Network).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-identity-'));
process.env.DB_PATH = path.join(tmp, 'live.db');
process.env.INTERNAL_API_KEY = 'k-test';

const received = [];
const mode = { old: false };
const network = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        if (mode.old) { res.statusCode = 404; return res.end('{}'); }
        assert.strictEqual(req.headers['x-internal-key'], 'k-test');
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
    db.initDb();
    const sync = require('../server/auth/identity-sync');
    const d = db.getDb();

    assert.ok(d.prepare('PRAGMA table_info(linked_accounts)').all().some((c) => c.name === 'subject_id'), 'linked_accounts.subject_id exists');

    // 600 linked users (two batches) plus one legacy non-numeric row that must not be sent.
    const insUser = d.prepare("INSERT INTO users (username, password_hash, stream_key) VALUES (?, 'x', ?)");
    const insLink = d.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, service_username) VALUES (?, 'network', ?, ?)");
    for (let i = 1; i <= 600; i++) {
        const id = insUser.run(`u${i}`, `key${i}`).lastInsertRowid;
        insLink.run(id, String(1000 + i), `u${i}`);
    }
    const odd = insUser.run('odd', 'keyodd').lastInsertRowid;
    insLink.run(odd, 'network:odd', 'odd');

    const out = await sync.syncLegacyMap();
    assert.strictEqual(received.length, 2, 'batched by 500');
    assert.strictEqual(out.sent, 600, 'non-numeric links are skipped');
    assert.strictEqual(out.conflicts, 2, 'conflicts are counted, not retried');
    const first = received[0][0];
    assert.deepStrictEqual(Object.keys(first).sort(), ['network_user_id', 'source_id', 'source_system', 'source_type', 'verified']);
    assert.strictEqual(first.source_system, 'live');
    assert.strictEqual(typeof first.network_user_id, 'number');

    // A token's subject_id is stored once, only for a well-formed id and the matching link.
    const uid = d.prepare("SELECT user_id FROM linked_accounts WHERE service_user_id = '1001'").get().user_id;
    sync.noteSubject(uid, 1001, 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ');
    assert.strictEqual(sync.subjectOf(uid), 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ');
    sync.noteSubject(uid, 1001, '42');
    assert.strictEqual(sync.subjectOf(uid), 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', 'malformed subject ignored');
    sync.noteSubject(uid, 9999, 'usr_01JAB2C3D4E5F6G7H8J9K0MNPR');
    assert.strictEqual(sync.subjectOf(uid), 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', 'a token for a different network id cannot rewrite the link');

    // Network without the endpoint yet: skip quietly.
    mode.old = true;
    assert.deepStrictEqual(await sync.syncLegacyMap(), { skipped: 'network has no /internal/identity yet' });
    network.close();

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('identity sync: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
