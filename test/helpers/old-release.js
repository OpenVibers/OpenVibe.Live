'use strict';
/**
 * An older release checked out next to this one, for the tests that run old code or old SQL against
 * this release (test/rollback-newer-writes.test.js, test/n-1/harness.js, and the recorder
 * scripts/n-1-record.js uses). The checkout shares this checkout's node_modules.
 *
 * Two things bite when test/run.js runs the files that need one at the same time, and both are
 * handled here rather than in every caller:
 *
 *   - Git names the metadata of a linked worktree after the basename of its directory, in the one
 *     shared `.git/worktrees/` (a linked worktree's `git-dir` file points at the main repository's
 *     common directory). Two checkouts both called `old` therefore share `.git/worktrees/old`, and
 *     git serialises them through that one index: whichever arrives second finds
 *     `Unable to create '…/.git/worktrees/old/index.lock': File exists` and exits 128 — or worse,
 *     deletes the first one's directory and succeeds, so a test then runs a half-written checkout.
 *     Every checkout here gets a basename unique to this process (`old-<pid>-<n>`), so concurrent
 *     callers never contend on the same metadata.
 *   - Even with distinct basenames git keeps other locks in the common directory, so a stray
 *     `git add`/`gc` from elsewhere can still hold one briefly. `run()` retries on exactly the
 *     lock-contention failures and gives up with git's own message, which `stdio: 'ignore'` used to
 *     swallow (the caller only ever saw a bare exit 128).
 *
 *   const old = oldRelease(ROOT, 'HEAD');
 *   try { runIn(old.dir, …); } finally { old.remove(); }
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let counter = 0;
/** git exiting 128 because another process holds the repository's worktree/index metadata. */
const CONTENDED = /index\.lock|File exists|Unable to create|already exists|cannot create directory|unable to create file/;

/** Blocking sleep, so the retry does not need a promise: this runs before any async work starts. */
function pause(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** git in `root`, with stderr kept for diagnostics and a retry while the repository is locked. */
function git(root, args, { attempts = 40, waitMs = 250 } = {}) {
    for (let i = 1; ; i++) {
        try {
            return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            const stderr = String(e.stderr || '');
            if (i >= attempts || !CONTENDED.test(stderr)) {
                throw new Error(`git ${args.join(' ')} in ${root} failed (exit ${e.status}) after ${i} attempt${i > 1 ? 's' : ''}: ${stderr.trim() || '(no message)'}`);
            }
            pause(waitMs);
        }
    }
}

/**
 * A checkout of `ref` (default: HEAD) in its own temp directory, sharing root's node_modules.
 * → { dir, sha, remove() }. `remove()` never throws: a leftover temp directory is worse than a
 * stale metadata entry, which `git worktree prune` clears on any later run.
 */
function oldRelease(root, ref = 'HEAD') {
    const sha = git(root, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-old-release-'));
    const dir = path.join(tmp, `release-${process.pid}-${counter++}`);
    git(root, ['worktree', 'add', '--detach', dir, sha]);
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    return {
        dir, sha,
        remove() {
            try { git(root, ['worktree', 'remove', '--force', dir], { attempts: 5 }); } catch { /* best effort */ }
            fs.rmSync(tmp, { recursive: true, force: true });
        },
    };
}

module.exports = { oldRelease };