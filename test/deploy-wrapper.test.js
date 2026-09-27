/**
 * deploy/scripts/deploy.sh is a thin wrapper around `ovhost deploy live` (OpenVibe.Host, strategy
 * release-layout; roadmap WS-N task 11), with deploy-legacy.sh (the previous script, unchanged) as its
 * fallback. A fake ovhost records what the wrapper asked for; a fake legacy script records the fallback.
 *   - the flags map: (none) → deploy live, --wait-idle, --restart, --rollback → rollback live,
 *     DRY_RUN=1 → plan live, READY_TIMEOUT → --ready-timeout;
 *   - --force (legacy: discard local changes) is refused on the ovhost path, never passed on;
 *   - the fallback runs, with the original arguments and a message, when ovhost is missing, has no
 *     `capabilities`, reports deploy-api 0, does not deploy live with release-layout, or OVHOST_LEGACY=1;
 *   - deploy-legacy.sh is the old script: it still holds the listener check and the socket restart.
 *
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
const legacy = path.join(tmp, 'legacy.sh');
fs.writeFileSync(legacy, `#!/usr/bin/env bash\necho "legacy $* DRY_RUN=\${DRY_RUN:-}" >> "${log}"\nexit 0\n`, { mode: 0o755 });

const run = (args = [], env = {}) => {
    fs.rmSync(log, { force: true });
    const r = spawnSync('bash', [WRAPPER, ...args], { env: { PATH: process.env.PATH, OVHOST: ovhost, OVHOST_SUDO: '', DEPLOY_LEGACY: legacy, ...env }, encoding: 'utf8' });
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
    assert.match(r.out, /--force meant 'discard local tracked changes'/);
});

check('an unknown flag is a usage error', () => {
    const r = run(['--nope']);
    assert.strictEqual(r.code, 1);
    assert.deepStrictEqual(r.calls, []);
});

check('the fallback runs deploy-legacy.sh with the original arguments, and says why', () => {
    let r = run(['--wait-idle'], { OVHOST: path.join(tmp, 'missing-ovhost') });
    assert.strictEqual(r.code, 0, r.out);
    assert.deepStrictEqual(r.calls, ['legacy --wait-idle DRY_RUN=']);
    assert.match(r.out, /ovhost not found .* — running deploy-legacy\.sh/);

    r = run(['--force'], { FAKE_OLD: '1' });
    assert.deepStrictEqual(r.calls, ['legacy --force DRY_RUN='], 'the legacy script keeps its own --force');
    assert.match(r.out, /no 'capabilities' \(too old\)/);

    r = run([], { FAKE_CAPS: 'ovhost=0.2.9\\ndeploy-api=0\\nstrategy=release-layout\\nmanaged=yes' });
    assert.deepStrictEqual(r.calls, ['legacy  DRY_RUN=']);
    assert.match(r.out, /deploy-api is 0, 1 is needed/);

    r = run([], { FAKE_CAPS: 'ovhost=0.3.0\\ndeploy-api=1\\nstrategy=none\\nmanaged=no' });
    assert.deepStrictEqual(r.calls, ['legacy  DRY_RUN=']);
    assert.match(r.out, /does not deploy live with strategy release-layout \(none\)/);

    r = run(['--rollback'], { OVHOST_LEGACY: '1', DRY_RUN: '1' });
    assert.deepStrictEqual(r.calls, ['legacy --rollback DRY_RUN=1']);
});

check('deploy-legacy.sh is the previous script: listener check, changed-socket restart, release layout', () => {
    const text = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'scripts', 'deploy-legacy.sh'), 'utf8');
    assert.match(text, /socket_held\(\)/);
    assert.match(text, /SOCKET_CHANGED=true/);
    assert.match(text, /\$SYSTEMCTL restart "\$\{SERVICE\}\.socket"/);
    assert.match(text, /KEEP_RELEASES/);
    const wrapper = fs.readFileSync(WRAPPER, 'utf8');
    assert.ok(wrapper.split('\n').length < 120, 'the wrapper stays thin');
    assert.match(wrapper, /^set -euo pipefail$/m);
});

fs.rmSync(tmp, { recursive: true, force: true });
if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\ndeploy wrapper: all checks passed');
