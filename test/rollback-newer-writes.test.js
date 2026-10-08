'use strict';
/**
 * Rollback with newer writes (roadmap WS-P task 13). Production may roll back to any release of the last
 * week while keeping the database the newer release migrated and wrote to. So a database this code
 * initialised and wrote to (its newest tables and columns filled) must still boot and work under the
 * release of seven days ago: that release's initDb runs over the newer schema without an error, reads
 * what it knows (users, streams, follows, settings) and writes (a user, a stream, a follow). Across the move to
 * PostgreSQL (plan T4) it skips: a rollback to a SQLite release reads the SQLite file kept at the cutover.
 *
 * The older release is checked out next to this one (it shares this checkout's node_modules) by
 * test/helpers/old-release.js, which also keeps a concurrently running test file off the same git
 * worktree metadata. Each release runs in its own process. Without git history (a shallow CI clone)
 * the test says so and passes; ROLLBACK_REF=<commit> picks another release.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { oldRelease } = require('./helpers/old-release');

const ROOT = path.join(__dirname, '..');
// Only a clone with no commit older than a week (a shallow CI clone) may skip: a failing git (missing
// binary, not a repository, locked metadata) is a broken environment, not a reason to pass silently.
let old = process.env.ROLLBACK_REF;
if (!old) {
    let probe;
    try {
        probe = execFileSync('git', ['-C', ROOT, 'log', '-1', '--before=7 days ago', '--format=%H'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        console.error('rollback with newer writes: git could not find a release older than 7 days:');
        console.error(String(e.stderr || e.message || e).trim());
        process.exit(1);
    }
    old = String(probe).trim();
}
if (!old) { console.log('rollback with newer writes: skipped (no git history to take the older release from)'); process.exit(0); }
// Across the move to PostgreSQL (plan T4) the two releases never share a database: a rollback to a SQLite release reads
// the SQLite file `ovhost data switch live` kept read-only at the cutover. Once the older release is on PostgreSQL too,
// this test runs: both releases on one database.
try { execFileSync('git', ['-C', ROOT, 'cat-file', '-e', `${old}:migrations/0002_live.sql`], { stdio: 'ignore' }); } catch {
    console.log(`rollback with newer writes: skipped (the release of ${old.slice(0, 8)} runs on SQLite and this one on PostgreSQL: a rollback across the switch reads the SQLite file kept at the cutover, not this database)`);
    process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-live-rollback-'));
const dataDir = path.join(tmp, 'data');
let release = null;
const cleanup = () => {
    if (release) release.remove();
    fs.rmSync(tmp, { recursive: true, force: true });
};

// One release against the database (an embedded PGlite database under DATA_DIR, which every release opens the same
// way), in its own process: prints one JSON line.
function runIn(dir, script) {
    const env = { ...process.env, DATA_DIR: dataDir, NODE_ENV: 'test', LIVE_DRILL: '' };
    delete env.DATABASE_URL; delete env.DATABASE_DIRECT_URL;
    const r = spawnSync(process.execPath, ['-e', `(async () => {${script}})().then(() => process.exit(0), (e) => { process.stderr.write(String(e.stack || e)); process.exit(1); });`], {
        cwd: dir, encoding: 'utf8', timeout: 120000, env,
    });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    return { code: r.status, out: line ? JSON.parse(line) : null, stderr: String(r.stderr || '').slice(-1500) };
}

try {
    // 1. This release: a fresh database, migrated and written through today's features.
    const now = runIn(ROOT, `
        console.log = () => {}; console.warn = () => {};
        const db = require('./server/db/database'); await db.initDb(); const d = db.getDb();
        await db.createUser({ username: 'newer', display_name: 'Newer', password_hash: 'x' });
        const u = await db.getUserByUsername('newer');
        const s = await db.createStream({ user_id: u.id, title: 'written by the newer release', category: 'tech', protocol: 'webrtc', is_nsfw: 0 });
        await db.endStream(s.lastInsertRowid);
        await db.setSetting('rollback_probe', 'newer');
        // Tables the newer release fills.
        await d.prepare("INSERT INTO search_doc_pushes (user_id, hash, revision) VALUES (?, 'h', 1)").run(u.id);
        await d.prepare("INSERT INTO search_media_pushes (kind, media_id, hash, revision) VALUES ('vod', 1, 'h', 1)").run();
        await db.recordEasterEggSolve('2026-01-01', 'rollback-probe', u.id);
        const tables = await d.value("SELECT count(*) FROM information_schema.tables WHERE table_schema = current_schema()");
        await db.close();
        process.stdout.write(JSON.stringify({ ok: true, user: u.id, tables: Number(tables) }) + '\\n');
    `);
    assert.strictEqual(now.code, 0, `the current release could not prepare the database:\n${now.stderr}`);

    // 2. The release of a week ago, on that database.
    release = oldRelease(ROOT, old);
    const back = runIn(release.dir, `
        console.log = () => {}; console.warn = () => {};
        const errors = [];
        console.error = (...a) => errors.push(a.join(' ').slice(0, 300));
        const db = require('./server/db/database'); await db.initDb();
        const u = await db.getUserByUsername('newer');
        if (!u) throw new Error('the older release cannot read the user the newer one wrote');
        if (await db.getSetting('rollback_probe') !== 'newer') throw new Error('settings unreadable');
        await db.createUser({ username: 'older', display_name: 'Older', password_hash: 'x' });
        const o = await db.getUserByUsername('older');
        const s = await db.createStream({ user_id: o.id, title: 'written after the rollback', category: 'irl', protocol: 'webrtc', is_nsfw: 0 });
        await db.endStream(s.lastInsertRowid);
        await db.run('INSERT INTO follows (follower_id, streamer_id) VALUES (?, ?)', [o.id, u.id]);
        const live = await db.getLiveStreams();
        // A boot error the older code logged while opening a newer schema counts as a failure.
        const bootErrors = errors.filter((e) => /\\[DB\\].*(error|failed)|DbError/i.test(e));
        await db.close();
        process.stdout.write(JSON.stringify({ ok: bootErrors.length === 0, bootErrors, live: Array.isArray(live) ? live.length : -1 }) + '\\n');
    `);
    assert.strictEqual(back.code, 0, `the release of ${old.slice(0, 8)} failed on the newer database:\n${back.stderr}`);
    assert.ok(back.out && back.out.ok, `the older release logged database errors: ${JSON.stringify(back.out && back.out.bootErrors)}`);

    // 3. And this release again, after the rollback wrote: roll forward works too.
    const forward = runIn(ROOT, `
        console.log = () => {}; console.warn = () => {};
        const db = require('./server/db/database'); await db.initDb();
        const o = await db.getUserByUsername('older');
        await db.close();
        process.stdout.write(JSON.stringify({ ok: !!o }) + '\\n');
    `);
    assert.strictEqual(forward.code, 0, forward.stderr);
    assert.ok(forward.out && forward.out.ok, 'rolling forward again reads what the older release wrote');
    console.log(`rollback with newer writes: the release of ${old.slice(0, 8)} works on this release's database, and back again`);
} finally {
    cleanup();
}
