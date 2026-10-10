/**
 * The wrapper maps deploy flags to ovhost and fails when ovhost cannot manage Live.
 *   node test/deploy-wrapper.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const WRAPPER = path.join(__dirname, '..', 'deploy', 'scripts', 'deploy.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-deploy-wrapper-'));
const log = path.join(tmp, 'calls.log');

// Fake ovhost: `capabilities live` prints what FAKE_CAPS says (or fails with FAKE_OLD); anything else is recorded.
const ovhost = path.join(tmp, 'ovhost');
fs.writeFileSync(ovhost, `#!/usr/bin/env bash
if [ "$1" = capabilities ]; then
  [ -n "$FAKE_OLD" ] && { echo "unknown command \\"capabilities\\""; exit 1; }
  printf '%b\\n' "\${FAKE_CAPS:-ovhost=0.3.0\\ndeploy-api=1\\nstrategies=git-checkout,multi-app,static-build,pnpm-build,release-layout\\nservice=live\\nstrategy=release-layout\\nmanaged=yes\\nlayout=release}"
  exit 0
fi
echo "ovhost $*" >> "${log}"
exit "\${FAKE_EXIT:-0}"
`, { mode: 0o755 });
const run = (args = [], env = {}) => {
    fs.rmSync(log, { force: true });
    const r = spawnSync('bash', [WRAPPER, ...args], { env: { PATH: process.env.PATH, OVHOST: ovhost, OVHOST_SUDO: '', ...env }, encoding: 'utf8' });
    let calls = [];
    try { calls = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean); } catch { /* none */ }
    return { code: r.status, out: r.stdout + r.stderr, calls };
};

let failures = 0;
function check(name, fn) {
    try { fn(); console.log('  ✓', name); } catch (e) { failures++; console.log('  ✗', name, '\n     ', String(e.message).split('\n').slice(0, 12).join('\n      ')); }
}

check('the flags map onto ovhost deploy|rollback|plan live', () => {
    assert.deepStrictEqual(run().calls, ['ovhost deploy live']);
    assert.deepStrictEqual(run(['--wait-idle']).calls, ['ovhost deploy live --wait-idle']);
    assert.deepStrictEqual(run(['--restart', '--wait-idle']).calls, ['ovhost deploy live --restart --wait-idle']);
    assert.deepStrictEqual(run(['--rollback']).calls, ['ovhost rollback live']);
    assert.deepStrictEqual(run([], { DRY_RUN: '1' }).calls, ['ovhost plan live']);
    assert.deepStrictEqual(run([], { READY_TIMEOUT: '120' }).calls, ['ovhost deploy live --ready-timeout 120']);
    const r = run(['--wait-idle']);
    assert.match(r.out, /\[Deploy\] ovhost deploy live --wait-idle/);
});

check("ovhost's exit code is the wrapper's (3: not ready, rolled back)", () => {
    assert.strictEqual(run([], { FAKE_EXIT: '3' }).code, 3);
    assert.strictEqual(run([], { FAKE_EXIT: '5' }).code, 5);
});

check('--force is refused on the ovhost path (it would drop live streams), never passed on', () => {
    const r = run(['--force']);
    assert.strictEqual(r.code, 1, r.out);
    assert.deepStrictEqual(r.calls, []);
    assert.match(r.out, /--force drops live streams/);
});

check('an unknown flag is a usage error', () => {
    const r = run(['--nope']);
    assert.strictEqual(r.code, 1);
    assert.deepStrictEqual(r.calls, []);
});

check('missing or incompatible ovhost fails without deploying', () => {
    let r = run(['--wait-idle'], { OVHOST: path.join(tmp, 'missing-ovhost') });
    assert.strictEqual(r.code, 1, r.out);
    assert.deepStrictEqual(r.calls, []);
    assert.match(r.out, /ovhost not found/);

    r = run([], { FAKE_OLD: '1' });
    assert.strictEqual(r.code, 1, r.out);
    assert.deepStrictEqual(r.calls, []);
    assert.match(r.out, /no 'capabilities'/);

    r = run([], { FAKE_CAPS: 'deploy-api=0\\nstrategy=release-layout\\nmanaged=yes' });
    assert.strictEqual(r.code, 1, r.out);
    assert.deepStrictEqual(r.calls, []);
    assert.match(r.out, /deploy-api is 0/);

    r = run([], { FAKE_CAPS: 'deploy-api=1\\nstrategy=none\\nmanaged=no' });
    assert.strictEqual(r.code, 1, r.out);
    assert.deepStrictEqual(r.calls, []);
    assert.match(r.out, /strategy release-layout/);
});

check('the wrapper has no fallback path', () => {
    const wrapper = fs.readFileSync(WRAPPER, 'utf8');
    assert.ok(wrapper.split('\n').length < 120);
    assert.match(wrapper, /^set -euo pipefail$/m);
    assert.doesNotMatch(wrapper, /LEGACY|exec bash/);
});

fs.rmSync(tmp, { recursive: true, force: true });
if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\ndeploy wrapper: all checks passed');
