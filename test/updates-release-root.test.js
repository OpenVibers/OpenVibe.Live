'use strict';
/**
 * /api/updates (the patch notes list) reads the git log of the release that is live. A static-only release switches
 * the `current` link without restarting the process, so a list read from __dirname (the release the process booted
 * from) stopped at that release's commit: on 2026-10-17 it showed #206 while #207–#210 were live. It reads through
 * OV_APP_ROOT (the `current` link, as the static files do), and git follows a repointed link on every run.
 *
 *   node test/updates-release-root.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const src = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
assert.match(src, /const REPO_DIR = process\.env\.OV_APP_ROOT \|\| path\.resolve\(__dirname, '\.\.'\);/, 'the list reads through OV_APP_ROOT');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-updates-root-'));
const git = (cwd, ...a) => execFileSync('git', ['-c', 'safe.directory=*', '-c', 'user.name=t', '-c', 'user.email=t@x', ...a], { cwd, encoding: 'utf8' });
const release = (name, subject) => {
    const dir = path.join(tmp, 'releases', name);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    fs.writeFileSync(path.join(dir, 'f'), name);
    git(dir, 'add', 'f');
    git(dir, 'commit', '-qm', subject);
    return dir;
};
const a = release('a', 'release a');
const b = release('b', 'release b');
const current = path.join(tmp, 'current');
fs.symlinkSync(a, current);
const top = () => git(current, '--no-pager', 'log', '--pretty=format:%s', '-1').trim();
assert.strictEqual(top(), 'release a');
fs.unlinkSync(current);
fs.symlinkSync(b, current);
assert.strictEqual(top(), 'release b', 'a repointed link is followed by the next git run');
fs.rmSync(tmp, { recursive: true, force: true });
console.log('updates release root: all checks passed');
