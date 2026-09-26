#!/usr/bin/env node
'use strict';
/**
 * Records the N-1 fixtures (roadmap WS-P task 11) from a release: what its client calls and reads,
 * and what SQL it runs on which schema. test/n-1.test.js replays them against this checkout.
 *
 *   npm run n-1:record                 # from HEAD: run it right after a deploy, from the deployed commit,
 *                                      # so the fixture is N-1 for the next release
 *   npm run n-1:record -- <ref>        # from another commit (e.g. the sha in production's /release.json)
 *
 * The release is checked out into a temporary git worktree (sharing node_modules), seeded and booted
 * the way test/n-1/service.js says, and every call its client code makes (test/n-1/harness.js finds
 * them) is replayed against it. Writes test/fixtures/n-1/client.json and worker.json; commit them.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const h = require('../test/n-1/harness');
const svc = require('../test/n-1/service');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'fixtures', 'n-1');

(async () => {
    const ref = process.argv[2] || 'HEAD';
    const wt = h.worktree(ROOT, ref);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-n-1-record-'));
    const dbPath = path.join(tmp, 'db', `${svc.service}.db`);
    const dataDir = path.join(tmp, 'data');
    const sqlOut = path.join(tmp, 'sql.json');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    let server = null;
    try {
        console.log(`n-1:record: ${svc.service} at ${wt.sha.slice(0, 12)} (${ref})`);

        // 1. The client: its calls, and the names it reads.
        const files = svc.clientFiles(wt.dir);
        const { calls, dynamic } = h.extractCalls({ files, callers: svc.callers, strip: svc.strip, keep: svc.keep });
        const ids = h.clientIdentifiers(files.map((f) => f.text));
        console.log(`  client: ${files.length} files, ${calls.length} call sites with a path (${dynamic} with a computed one, not replayed)`);

        // 2. The release, seeded and booted; every call replayed.
        await svc.seed({ dir: wt.dir, dbPath, dataDir });
        server = await svc.boot({ dir: wt.dir, dbPath, dataDir, sqlOut });
        const manifest = await (await fetch(`${server.url}/release.json`)).json();
        const recorded = [];
        let unanswered = 0; let noRoute = 0;
        for (const req of h.requestsFor(calls, svc.samples, { signedIn: svc.signedIn !== false })) {
            const got = await h.send(server.url, { method: req.method, path: req.path, headers: server.headers(req.auth), body: req.method === 'GET' ? undefined : {} });
            if (got.status === 0) { unanswered++; continue; }
            // No route for this path on N-1 itself (a sample value its route does not take, or a dead call):
            // nothing N has to keep.
            if (got.status === 404 && got.kind !== 'json') { noRoute++; continue; }
            const rec = { method: req.method, path: req.path, auth: req.auth, status: got.status, kind: got.kind };
            if (got.location) rec.location = got.location;
            if (got.json != null && got.status >= 200 && got.status < 300) {
                const reads = h.readsOf(got.json, ids);
                if (Object.keys(reads).length) rec.reads = reads;
            }
            rec.from = req.from;
            recorded.push(rec);
        }
        const extra = svc.recordExtra ? await svc.recordExtra({ server, dir: wt.dir, files, ids }) : null;
        await server.close();
        server = null;
        console.log(`  replayed: ${recorded.length} requests (left out: ${unanswered} unanswered, ${noRoute} with no route on N-1)`);

        // 3. The schema N-1 left, and the SQL it runs on it.
        const db = new Database(dbPath);
        const schema = h.schemaDDL(db);
        const ledger = {};
        for (const t of svc.ledgerTables || []) {
            try { ledger[t] = db.prepare(`SELECT * FROM "${t}"`).all(); } catch { /* not there */ }
        }
        const userVersion = db.pragma('user_version', { simple: true });
        const serverFiles = h.readTree(wt.dir, svc.sqlDirs);
        // What N-1 creates itself on first use or at a full boot: in production it exists before N deploys.
        const lazy = h.lazyDDL(serverFiles, db);
        const ran = fs.existsSync(sqlOut) ? JSON.parse(fs.readFileSync(sqlOut, 'utf8')) : [];
        const candidates = [...new Set([...ran.map(h.normalizeSql).filter((s) => /^\s*(SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH)\b/i.test(s)), ...h.sqlLiterals(serverFiles)])].sort();
        const failing = new Set(h.prepareProblems(db, candidates).map((p) => p.sql));
        const statements = candidates.filter((s) => !failing.has(s));
        db.close();
        console.log(`  sql: ${statements.length} statements (${ran.length} ran, ${failing.size} candidates that do not prepare on N-1's own schema left out), ${schema.length} schema objects, ${lazy.length} created on first use`);

        fs.mkdirSync(OUT, { recursive: true });
        const head = { service: svc.service, release: wt.sha, recorded_at: new Date().toISOString(), note: 'N-1 fixture: written by `npm run n-1:record`, replayed by test/n-1.test.js' };
        fs.writeFileSync(path.join(OUT, 'client.json'), `${JSON.stringify({ ...head, manifest, dynamic_calls: dynamic, calls: recorded, ...(extra ? { extra } : {}) }, null, 1)}\n`);
        fs.writeFileSync(path.join(OUT, 'worker.json'), `${JSON.stringify({ ...head, user_version: userVersion, schema, ledger, lazy, statements }, null, 1)}\n`);
        console.log(`  wrote ${path.relative(ROOT, OUT)}/client.json and worker.json`);
    } finally {
        if (server) await server.close();
        wt.remove();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err.stack || err.message); process.exit(1); });

