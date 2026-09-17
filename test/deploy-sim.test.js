/**
 * deploy/scripts/deploy.sh against a simulated host.
 *
 * A temp directory stands in for /opt/openvibe.live with a real git "origin", the release layout
 * (repo, releases/<id>, current, shared/data), a fake `systemctl` that runs a tiny app, and a fake
 * `npm` that writes a marker into node_modules. It proves the deploy claims instead of asserting them:
 *   - a public/-only change switches `current` WITHOUT restarting the process;
 *   - a server/ change restarts it;
 *   - a release that never becomes ready is rolled back automatically (exit 3), still serving;
 *   - --rollback returns to the previous release, restarting only if server code differs;
 *   - a lockfile change installs into the NEW release, so rolling back gets the OLD node_modules;
 *   - the legacy in-place layout also skips the restart for public/-only changes.
 *
 *   node test/deploy-sim.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawnSync } = require('child_process');

const DEPLOY = path.join(__dirname, '..', 'deploy', 'scripts', 'deploy.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-deploy-sim-'));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const sh = (cmd, opts = {}) => execFileSync('bash', ['-c', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); }
    catch (e) { failures++; console.log('  ✗', name, '\n     ', String(e.message).split('\n').slice(0, 12).join('\n      ')); }
}
const get = (p) => new Promise((resolve) => {
    http.get({ port: PORT, path: p, timeout: 2000 }, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => resolve({ status: r.statusCode, body: b })); })
        .on('error', () => resolve({ status: 0, body: '' }));
});

// ── The fake app: reads its "static" file through OV_APP_ROOT like the real server ──
const APP = `
const http = require('http'); const fs = require('fs'); const path = require('path');
const root = process.env.OV_APP_ROOT;
const broken = fs.existsSync(path.join(__dirname, 'BROKEN'));
http.createServer((req, res) => {
  if (req.url === '/api/ready') { res.statusCode = broken ? 503 : 200; return res.end('ok'); }
  if (req.url === '/api/streams') return res.end('{"streams":[]}');
  if (req.url === '/api/health') return res.end('{}');
  if (req.url === '/static') return res.end(fs.readFileSync(path.join(root, 'public/x.txt'), 'utf8'));
  if (req.url === '/code') return res.end(fs.readFileSync(path.join(__dirname, 'version.txt'), 'utf8').trim() + ' pid=' + process.pid);
  if (req.url === '/deps') { try { return res.end(fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'marker'), 'utf8')); } catch { return res.end('none'); } }
  res.statusCode = 404; res.end();
}).listen(${PORT}, '127.0.0.1');
`;

(async () => {
    const origin = path.join(tmp, 'origin.git');
    const work = path.join(tmp, 'work');
    const base = path.join(tmp, 'opt');
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin, { recursive: true });

    // Author repo → bare origin.
    sh(`git init -q -b main "${work}" && cd "${work}" && git config user.email t@t && git config user.name t`);
    const write = (rel, content) => { fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true }); fs.writeFileSync(path.join(work, rel), content); };
    const commit = (msg) => sh(`cd "${work}" && git add -A && git commit -qm "${msg}" && git push -q origin main 2>/dev/null || (git remote add origin "${origin}" 2>/dev/null; git push -q origin main)`);
    write('server/index.js', APP);
    write('server/version.txt', 'v1');
    write('public/x.txt', 'static-1');
    write('package.json', JSON.stringify({ name: 'sim', dependencies: { a: '1' } }));
    write('package-lock.json', JSON.stringify({ lockfileVersion: 3, v: 1 }));
    sh(`git init -q --bare -b main "${origin}"`);
    commit('v1');

    // Fake systemctl: runs the current release's server in the background; `is-active` checks the pid.
    const pidFile = path.join(tmp, 'app.pid');
    fs.writeFileSync(path.join(bin, 'systemctl'), `#!/usr/bin/env bash
PID_FILE="${pidFile}"
case "$1" in
  restart|start)
    if [ -f "$PID_FILE" ]; then kill "$(cat "$PID_FILE")" 2>/dev/null; sleep 0.3; fi
    OV_APP_ROOT="${base}/current" nohup node "${base}/current/server/index.js" >/dev/null 2>&1 &
    echo $! > "$PID_FILE"; exit 0 ;;
  stop) [ -f "$PID_FILE" ] && kill "$(cat "$PID_FILE")" 2>/dev/null; exit 0 ;;
  is-active) shift; [ "$1" = "--quiet" ] && shift; case "$1" in *.socket) exit 1 ;; esac
    [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null ;;
  is-enabled|list-unit-files) exit 1 ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'npm'), `#!/usr/bin/env bash\nmkdir -p node_modules && echo "lock-$(node -e 'console.log(require(\"./package-lock.json\").v)')" > node_modules/marker\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'journalctl'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

    // Release layout, as migrate-to-releases.sh leaves it.
    fs.mkdirSync(path.join(base, 'releases'), { recursive: true });
    fs.mkdirSync(path.join(base, 'shared', 'data'), { recursive: true });
    sh(`git clone -q --no-checkout "${origin}" "${base}/repo"`);
    const firstId = 'r0';
    sh(`git -C "${base}/repo" worktree add -q --detach "${base}/releases/${firstId}" origin/main && cd "${base}/releases/${firstId}" && "${bin}/npm" && ln -s ../../shared/data data && ln -s releases/${firstId} "${base}/current"`);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, BASE_DIR: base, SYSTEMCTL: path.join(bin, 'systemctl'), NPM: path.join(bin, 'npm'), API_URL: `http://127.0.0.1:${PORT}`, SYSTEMD_DIR: path.join(tmp, 'systemd'), READY_TIMEOUT: '6', LOCK_FILE: path.join(tmp, 'lock'), BROADCAST_ENDPOINT: '/nope' };
    const deploy = (...args) => spawnSync('bash', [DEPLOY, ...args], { env, encoding: 'utf8' });
    sh(`"${bin}/systemctl" start x`, { env });
    await new Promise((r) => setTimeout(r, 800));
    const pid = async () => (await get('/code')).body.split('pid=')[1];

    await check('initial release serves', async () => {
        assert.strictEqual((await get('/static')).body, 'static-1');
        assert.ok((await get('/code')).body.startsWith('v1'));
    });

    await check('public/-only change: current switches, process is NOT restarted', async () => {
        const before = await pid();
        write('public/x.txt', 'static-2'); commit('static');
        const r = deploy();
        assert.strictEqual(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /without a restart/);
        assert.strictEqual((await get('/static')).body, 'static-2');
        assert.strictEqual(await pid(), before, 'pid changed');
    });

    await check('server/ change: restarted, new code serving', async () => {
        const before = await pid();
        write('server/version.txt', 'v2'); commit('server');
        const r = deploy();
        assert.strictEqual(r.status, 0, r.stdout + r.stderr);
        await new Promise((res) => setTimeout(res, 300));
        const code = (await get('/code')).body;
        assert.ok(code.startsWith('v2'), code);
        assert.notStrictEqual(await pid(), before);
    });

    await check('lockfile change installs into the new release only', async () => {
        write('package-lock.json', JSON.stringify({ lockfileVersion: 3, v: 2 })); write('server/version.txt', 'v3'); commit('deps');
        const r = deploy();
        assert.strictEqual(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /installing into the new release/);
        await new Promise((res) => setTimeout(res, 300));
        assert.strictEqual((await get('/deps')).body.trim(), 'lock-2');
    });

    await check('--rollback returns code AND node_modules of the previous release', async () => {
        const r = deploy('--rollback');
        assert.strictEqual(r.status, 0, r.stdout + r.stderr);
        await new Promise((res) => setTimeout(res, 500));
        assert.ok((await get('/code')).body.startsWith('v2'));
        assert.strictEqual((await get('/deps')).body.trim(), 'lock-1');
    });

    await check('a release that never becomes ready is rolled back automatically (exit 3)', async () => {
        // Move forward again first so there is a clean "current" to fall back to.
        write('server/version.txt', 'v4'); commit('v4');
        assert.strictEqual(deploy().status, 0);
        write('server/BROKEN', '1'); write('server/version.txt', 'v5-broken'); commit('broken');
        const r = deploy();
        assert.strictEqual(r.status, 3, r.stdout + r.stderr);
        await new Promise((res) => setTimeout(res, 500));
        const code = (await get('/code')).body;
        assert.ok(code.startsWith('v4'), code);
        assert.strictEqual((await get('/api/ready')).status, 200);
    });

    await check('nothing new: no action, exit 0', async () => {
        // origin still has the broken commit; the deploy would try again, so first fix forward.
        fs.unlinkSync(path.join(work, 'server/BROKEN')); write('server/version.txt', 'v6'); commit('fix');
        assert.strictEqual(deploy().status, 0);
        const r = deploy();
        assert.strictEqual(r.status, 0);
        assert.match(r.stdout, /nothing to deploy/);
    });

    await check('old releases are pruned to KEEP_RELEASES', async () => {
        const n = fs.readdirSync(path.join(base, 'releases')).length;
        assert.ok(n <= 5, `${n} releases kept`);
    });

    // ── Legacy in-place layout ──
    sh(`"${bin}/systemctl" stop x`, { env });
    await new Promise((r) => setTimeout(r, 800));   // let the port close before the legacy app binds it
    const legacy = path.join(tmp, 'legacy');
    sh(`git clone -q "${origin}" "${legacy}" && cd "${legacy}" && git config user.email t@t && git config user.name t && "${bin}/npm"`);
    fs.writeFileSync(path.join(bin, 'systemctl'), fs.readFileSync(path.join(bin, 'systemctl'), 'utf8').replaceAll(`${base}/current`, legacy));
    const lenv = { ...env, BASE_DIR: legacy };
    sh(`"${bin}/systemctl" start x`, { env: lenv });
    await new Promise((r) => setTimeout(r, 800));
    await check('legacy layout: public/-only change pulls without restarting', async () => {
        const before = await pid();
        write('public/x.txt', 'legacy-static'); commit('legacy static');
        const r = spawnSync('bash', [DEPLOY], { env: lenv, encoding: 'utf8' });
        assert.strictEqual(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /no restart needed/);
        assert.strictEqual((await get('/static')).body, 'legacy-static', r.stdout + r.stderr + ' ready=' + (await get('/api/ready')).status);
        assert.strictEqual(await pid(), before);
    });

    sh(`"${bin}/systemctl" stop x`, { env: lenv });
    fs.rmSync(tmp, { recursive: true, force: true });
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
    console.log('\ndeploy simulation: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
