'use strict';
/**
 * N-1 (roadmap WS-P task 11, ADR-016): during a deploy, and for the 24-hour mixed-version window after
 * it, open tabs run the previous release's client against this release's server, and a previous-release
 * process can still be working on the database this release migrated. Both must keep working.
 *
 *   - An N-1 client against the N server: test/fixtures/n-1/client.json is every call the previous
 *     release's client code makes (found statically, made concrete with seeded values) with what that
 *     release answered: status, JSON or not, and the response fields the old client reads with their
 *     types. This checkout boots (test/n-1/service.js) and must answer each call compatibly: any 2xx
 *     for a 2xx, the same status otherwise (a 5xx only needs the route), JSON where there was JSON,
 *     every read field still there with a type it had. The run sits inside openvibe-shared's
 *     mixed-version matrix (release-compat assertMixedVersion) with both releases' manifests.
 *   - N-1 SQL against the N schema: test/fixtures/n-1/worker.json holds the previous release's schema
 *     (and migration ledger, and what it creates on first use) and every statement it ran or has as a
 *     literal. The database this test boots on is created from that schema, so this release's
 *     migrations run over it; afterwards every N-1 statement must still prepare (no table or column it
 *     names is gone), and no N-1 INSERT may miss a column this release made NOT NULL without a default.
 *
 * The fixtures come from the release in production: `npm run n-1:record` after each deploy (see
 * scripts/n-1-record.js). This test needs no git history and no network.
 *
 *   node test/n-1.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const compat = require('openvibe-shared/release-compat');
const h = require('./n-1/harness');
const svc = require('./n-1/service');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures', 'n-1');
const client = JSON.parse(fs.readFileSync(path.join(FIX, 'client.json'), 'utf8'));
const worker = JSON.parse(fs.readFileSync(path.join(FIX, 'worker.json'), 'utf8'));

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failures++; console.log(`  ✗ ${name}\n    ${String(err.message).split('\n').join('\n    ')}`); }
}

(async () => {
    const age = Math.round((Date.now() - Date.parse(client.recorded_at)) / 86400000);
    console.log(`n-1: ${svc.service} N-1 = ${client.release.slice(0, 12)}, recorded ${client.recorded_at.slice(0, 10)} (${age} d ago); ${client.calls.length} calls, ${worker.statements.length} statements`);

    console.log('n-1: the harness');
    await check('finds call sites, their method and template, and skips computed paths', () => {
        const files = [{ name: 'a.js', text: "api('/streams'); api(`/users/${encodeURIComponent(u.username)}/follow`, { method: 'POST', body: {} }); fetch(`${API}/api/x?limit=${n}`); api(path); fetch('https://elsewhere/x'); api(`/b/${on ? 'mute' : 'unmute'}`, { method: 'post' });" }];
        const { calls, dynamic } = h.extractCalls({ files, callers: [{ name: 'api', prefix: '/api' }, { name: 'fetch' }], strip: ['API'] });
        assert.deepStrictEqual(calls.map((c) => `${c.method} ${c.template}`), ['POST /api/b/{on ? \'mute\' : \'unmute\'}', 'GET /api/streams', 'POST /api/users/{encodeURIComponent(u.username)}/follow', 'GET /api/x?limit={n}']);
        assert.strictEqual(dynamic, 1);
        const samples = [[/id\)*$/i, '1'], [/name\)*$/i, 'n1star']];
        assert.deepStrictEqual(calls.map((c) => h.concretePath(c.parts, samples)), ['/api/b/mute', '/api/streams', '/api/users/n1star/follow', '/api/x?limit=']);
    });
    await check('reads: the key paths the client names; a gone or retyped one is a problem, an empty list or null parent is not', () => {
        const ids = h.clientIdentifiers(['x.streams.map((s) => s.title); const { total } = d; s?.viewer_count']);
        const reads = h.readsOf({ streams: [{ title: 'a', viewer_count: 1, secret: 'k' }], total: 3, other: 1 }, ids);
        assert.deepStrictEqual(reads, { streams: 'array', 'streams[]': 'object', 'streams[].title': 'string', 'streams[].viewer_count': 'number', total: 'number' });
        assert.deepStrictEqual(h.readProblems(reads, { streams: [{ title: 'b', viewer_count: 2 }], total: 1 }), []);
        assert.deepStrictEqual(h.readProblems(reads, { streams: [], total: 0 }), []);
        assert.deepStrictEqual(h.readProblems(reads, { streams: [{ title: 'b', viewer_count: '2' }] }), ['streams[].viewer_count was number, now string', 'total is gone']);
        assert.ok(h.statusCompatible(200, 201) && h.statusCompatible(502, 503) && !h.statusCompatible(401, 403) && !h.statusCompatible(502, 404) && !h.statusCompatible(200, 404));
    });
    await check('SQL: a dropped column fails the prepare; a new NOT NULL column without a default fails an old INSERT', () => {
        const d = new Database(':memory:');
        d.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b TEXT NOT NULL, c TEXT NOT NULL DEFAULT \'x\')');
        assert.deepStrictEqual(h.prepareProblems(d, ['SELECT a, gone FROM t']).map((p) => p.error), ['no such column: gone']);
        assert.deepStrictEqual(h.insertProblems(d, ['INSERT INTO t (a, b) VALUES (?, ?)', 'INSERT INTO t (a) VALUES (?)']).map((p) => p.error), ['t.b is NOT NULL without a default, and N-1 does not set it']);
        d.close();
    });

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-n-1-test-'));
    const dbPath = path.join(tmp, 'db', `${svc.service}.db`);
    const dataDir = path.join(tmp, 'data');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    let server = null;
    try {
        console.log(`n-1: this release on a database N-1 created`);
        await check('N-1\'s schema, ledger and first-use tables load, and this release migrates and seeds it', () => {
            const d = new Database(dbPath);
            d.transaction(() => {
                for (const ddl of worker.schema) d.exec(ddl);
                for (const [table, rows] of Object.entries(worker.ledger || {})) {
                    for (const row of rows) {
                        const cols = Object.keys(row);
                        d.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
                    }
                }
                for (const ddl of worker.lazy || []) d.exec(ddl);
            })();
            d.pragma(`user_version = ${Number(worker.user_version) || 0}`);
            d.close();
            svc.seed({ dir: ROOT, dbPath, dataDir });
        });
        server = await svc.boot({ dir: ROOT, dbPath, dataDir });
        const manifest = await (await fetch(`${server.url}/release.json`)).json();

        console.log('n-1: the N-1 client against this server');
        const sockets = client.ws ? `, and ${client.ws.sends.length} socket message types in ${client.ws.sessions.length} sessions` : '';
        await check(`every call the N-1 client makes is answered compatibly (${client.calls.length} requests${sockets}, in openvibe-shared's mixed-version matrix)`, async () => {
            const broken = [];
            const n1Client = async (url) => {
                const probe = await h.notFoundProbe(url);
                for (const rec of client.calls) {
                    const got = await h.send(url, { method: rec.method, path: h.fillPath(rec.path, server.ids), headers: { ...(rec.accept ? { accept: 'text/html' } : {}), ...server.headers(rec.auth) }, body: rec.method === 'GET' ? undefined : {} });
                    const problems = h.callProblems(rec, got, probe);
                    if (problems.length) broken.push(`${rec.auth} ${rec.method} ${rec.path} (${rec.from.join(', ')}): ${problems.join('; ')}`);
                }
                for (const session of (client.ws && client.ws.sessions) || []) {
                    const messages = h.wsMessages(client.ws.sends, { order: svc.ws.order, values: server.wsValues(session.auth) });
                    const received = await h.wsSession({ url: url.replace(/^http/, 'ws') + client.ws.path, headers: svc.ws.headers, messages });
                    broken.push(...h.wsProblems(session.received, received).map((p) => `socket ${client.ws.path} (${session.auth}): ${p}`));
                }
                if (broken.length) throw new Error(`${broken.length} broken:\n${h.summarize(broken)}`);
            };
            await compat.assertMixedVersion({ releases: [
                { name: 'N-1', manifest: client.manifest, client: n1Client },
                { name: 'N', manifest, server: async () => ({ url: server.url }) },
            ] });
        });
        await server.close();
        server = null;

        console.log('n-1: N-1\'s SQL on the schema this release migrated');
        await check(`every statement N-1 runs still prepares (${worker.statements.length}), and none of its INSERTs misses a new required column`, () => {
            const d = new Database(dbPath, { readonly: true });
            const problems = [...h.prepareProblems(d, worker.statements), ...h.insertProblems(d, worker.statements)];
            d.close();
            assert.deepStrictEqual(problems.map((p) => `${p.error}: ${p.sql.slice(0, 160)}`), [], 'N-1 SQL that breaks on this schema (expand first, contract a release later: ADR-028)');
        });
    } finally {
        if (server) { console.log(server.log().slice(-1500)); await server.close(); }
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    if (failures) { console.log(`\nn-1: ${failures} check(s) failed`); process.exit(1); }
    console.log('\nn-1: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
