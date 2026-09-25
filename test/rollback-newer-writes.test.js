'use strict';
/**
 * Rollback with newer writes (roadmap WS-P task 13). Production may roll back to any release of the last
 * week while keeping the database the newer release migrated and wrote to. So a database this code
 * initialised and wrote to (its newest tables and columns filled) must still boot and work under the
 * release of seven days ago: that release's initDb runs over the newer schema without an error, reads
 * what it knows (users, streams, follows, settings) and writes (a user, a stream, a follow).
 *
 * The older release is checked out into a temporary git worktree (it shares this checkout's
 * node_modules). Each release runs in its own process. Without git history (a shallow CI clone) the
 * test says so and passes; ROLLBACK_REF=<commit> picks another release.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const git = (...a) => { try { return execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const old = process.env.ROLLBACK_REF || git('log', '-1', '--before=7 days ago', '--format=%H');
if (!old) { console.log('rollback with newer writes: skipped (no git history to take the older release from)'); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-live-rollback-'));
const dbPath = path.join(tmp, 'live.db');
const oldDir = path.join(tmp, 'old');
const cleanup = () => {
    try { execFileSync('git', ['-C', ROOT, 'worktree', 'remove', '--force', oldDir], { stdio: 'ignore' }); } catch { /* not created */ }
    fs.rmSync(tmp, { recursive: true, force: true });
};

// One release against the database, in its own process: prints one JSON line.
function runIn(dir, script) {
    const r = spawnSync(process.execPath, ['-e', script], {
        cwd: dir, encoding: 'utf8', timeout: 120000,
        env: { ...process.env, DB_PATH: dbPath, NODE_ENV: 'test', LIVE_DRILL: '' },
    });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    return { code: r.status, out: line ? JSON.parse(line) : null, stderr: String(r.stderr || '').slice(-1500) };
}

try {
    // 1. This release: a fresh database, migrated and written through today's features.
    const now = runIn(ROOT, `
        console.log = () => {}; console.warn = () => {};
        const db = require('./server/db/database'); db.initDb(); const d = db.getDb();
        db.createUser({ username: 'newer', display_name: 'Newer', password_hash: 'x' });
        const u = db.getUserByUsername('newer');
        const s = db.createStream({ user_id: u.id, title: 'written by the newer release', category: 'tech', protocol: 'webrtc', is_nsfw: 0 });
        db.endStream(s.lastInsertRowid);
        db.setSetting('rollback_probe', 'newer');
        // Tables the newer release added, filled the way it fills them.
        try { require('./server/events/search-documents').ensureSchema(); d.prepare("INSERT INTO search_doc_pushes (user_id, hash, revision) VALUES (?, 'h', 1)").run(u.id); } catch (e) {}
        try { require('./server/events/search-media-documents').ensureSchema(); d.prepare("INSERT INTO search_media_pushes (kind, media_id, hash, revision) VALUES ('vod', 1, 'h', 1)").run(); } catch (e) {}
        db.logModerationAction({ scope_type: 'site', actor_user_id: u.id, target_user_id: null, action_type: 'probe', details: {} });
        const tables = d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n;
        process.stdout.write(JSON.stringify({ ok: true, user: u.id, tables }) + '\\n');
    `);
    assert.strictEqual(now.code, 0, `the current release could not prepare the database:\n${now.stderr}`);

    // 2. The release of a week ago, on that database.
    execFileSync('git', ['-C', ROOT, 'worktree', 'add', '--detach', oldDir, old], { stdio: 'ignore' });
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(oldDir, 'node_modules'), 'dir');
    const back = runIn(oldDir, `
        console.log = () => {}; console.warn = () => {};
        const errors = [];
        const origError = console.error; console.error = (...a) => errors.push(a.join(' ').slice(0, 300));
        const db = require('./server/db/database'); db.initDb();
        const u = db.getUserByUsername('newer');
        if (!u) throw new Error('the older release cannot read the user the newer one wrote');
        if (db.getSetting('rollback_probe') !== 'newer') throw new Error('settings unreadable');
        db.createUser({ username: 'older', display_name: 'Older', password_hash: 'x' });
        const o = db.getUserByUsername('older');
        const s = db.createStream({ user_id: o.id, title: 'written after the rollback', category: 'irl', protocol: 'webrtc', is_nsfw: 0 });
        db.endStream(s.lastInsertRowid);
        db.followUser(o.id, u.id);
        const live = db.getLiveStreams();
        // A boot error the older code logged while migrating a newer schema counts as a failure.
        const bootErrors = errors.filter((e) => /\\[DB\\].*(error|failed)|SqliteError/i.test(e));
        process.stdout.write(JSON.stringify({ ok: bootErrors.length === 0, bootErrors, live: Array.isArray(live) ? live.length : -1 }) + '\\n');
    `);
    assert.strictEqual(back.code, 0, `the release of ${old.slice(0, 8)} failed on the newer database:\n${back.stderr}`);
    assert.ok(back.out && back.out.ok, `the older release logged database errors: ${JSON.stringify(back.out && back.out.bootErrors)}`);

    // 3. And this release again, after the rollback wrote: roll forward works too.
    const forward = runIn(ROOT, `
        console.log = () => {}; console.warn = () => {};
        const db = require('./server/db/database'); db.initDb();
        const o = db.getUserByUsername('older');
        process.stdout.write(JSON.stringify({ ok: !!o }) + '\\n');
    `);
    assert.strictEqual(forward.code, 0, forward.stderr);
    assert.ok(forward.out && forward.out.ok, 'rolling forward again reads what the older release wrote');
    console.log(`rollback with newer writes: the release of ${old.slice(0, 8)} works on this release's database, and back again`);
} finally {
    cleanup();
}
