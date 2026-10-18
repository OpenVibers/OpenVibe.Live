/**
 * The data directory is the real folder behind ./data (server/paths.js). In production ./data is the release's
 * link to the shared data folder; on 2026-10-17 a deploy removed the release folder Live still ran from, and
 * every thumbnail and AI frame written through <release>/data failed with ENOENT for 2.5 hours.
 * And a /shared file the server lists but cannot read answers 503 no-store, never a cacheable 404.
 *
 *   node test/paths-real-data.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-paths-'));
const shared = path.join(root, 'shared', 'data');
const release = path.join(root, 'releases', 'r1');
fs.mkdirSync(shared, { recursive: true });
fs.mkdirSync(release, { recursive: true });
fs.symlinkSync('../../shared/data', path.join(release, 'data'));
process.env.DATA_DIR = path.join(release, 'data');
const paths = require('../server/paths');
try {
    assert.strictEqual(paths.dataDir(), fs.realpathSync(shared), 'the link\'s target');
    assert.strictEqual(paths.data('live-thumbs'), path.join(fs.realpathSync(shared), 'live-thumbs'));
    fs.rmSync(release, { recursive: true });
    assert.strictEqual(paths.data('ai-moments'), path.join(fs.realpathSync(shared), 'ai-moments'), 'still the shared folder once the release is gone');
    process.env.DATA_DIR = path.join(root, 'not-yet');
    assert.strictEqual(paths.dataDir(), path.join(root, 'not-yet'), 'a folder not made yet is used as given');
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}

const index = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
const shared404 = index.slice(index.indexOf("app.use('/shared', (req, res, next)"), index.indexOf("app.use('/shared', (req, res, next)") + 2200);
assert.match(shared404, /res\.sendFile\(filePath, \(err\) => \{[\s\S]*?res\.removeHeader\('CDN-Cache-Control'\);\s*res\.setHeader\('Cache-Control', 'no-store'\);\s*res\.status\(503\)/, 'an unreadable /shared file is 503 no-store');
console.log('paths real data: all checks passed');
