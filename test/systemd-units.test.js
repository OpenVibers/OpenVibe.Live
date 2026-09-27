'use strict';
/**
 * The systemd units Live runs under (deploy/systemd, and deploy/systemd/release for the release layout).
 *
 * From 2026-09-25 to 2026-09-26 the release layout's socket unit still listened on 0.0.0.0:3000 (the
 * 2026-09-23 loopback fix had reached only the in-place copy) and carried NonBlocking= in [Socket],
 * which systemd ignores. Installing it dropped the socket's descriptor, the service bound the port
 * itself on 0.0.0.0, Live answered on the public IP past Cloudflare and nginx, and every restart
 * refused connections for a moment. So:
 *   - both copies are the same file (one socket, one drop-in);
 *   - the socket listens on loopback only, and NonBlocking= lives in the service drop-in;
 *   - the process binds loopback in production when systemd did not hand it a socket.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'deploy', 'systemd');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

for (const f of ['openvibe-live.socket', path.join('openvibe-live.service.d', 'socket.conf')]) {
    assert.strictEqual(read('release', f), read(f), `deploy/systemd/release/${f} is the same file as deploy/systemd/${f}`);
}

const socket = read('openvibe-live.socket');
const section = (text, name) => (text.split(/^\[/m).find((s) => s.startsWith(`${name}]`)) || '');
const listens = [...section(socket, 'Socket').matchAll(/^ListenStream=(.+)$/gm)].map((m) => m[1].trim());
assert.deepStrictEqual(listens, ['127.0.0.1:3000'], 'the socket listens on loopback only');
assert.ok(!/^NonBlocking=/m.test(section(socket, 'Socket')), 'NonBlocking= is a [Service] option, not a [Socket] one');
assert.ok(!/^PartOf=/m.test(section(socket, 'Unit')), 'no PartOf=: the socket outlives every restart');
assert.match(section(read('openvibe-live.service.d', 'socket.conf'), 'Service'), /^NonBlocking=true$/m);

// The fallback bind when there is no LISTEN_FDS.
const load = (env) => {
    const keep = { ...process.env };
    for (const k of ['NODE_ENV', 'HOST', 'LISTEN_HOST', 'BASE_URL']) delete process.env[k];
    Object.assign(process.env, env);
    for (const k of Object.keys(require.cache)) if (k.endsWith(`${path.sep}server${path.sep}config.js`)) delete require.cache[k];
    try { return require('../server/config'); } finally { process.env = keep; }
};
assert.strictEqual(load({ NODE_ENV: 'production', HOST: '0.0.0.0', BASE_URL: 'https://openvibe.live' }).listenHost, '127.0.0.1', 'production binds loopback whatever HOST says');
assert.strictEqual(load({ NODE_ENV: 'production', LISTEN_HOST: '10.0.0.5', BASE_URL: 'https://openvibe.live' }).listenHost, '10.0.0.5', 'LISTEN_HOST overrides');
assert.strictEqual(load({ NODE_ENV: 'development' }).listenHost, '0.0.0.0', 'development keeps HOST (default 0.0.0.0)');
assert.strictEqual(load({ NODE_ENV: 'production', HOST: '0.0.0.0', BASE_URL: 'https://openvibe.live' }).host, '0.0.0.0', 'HOST still builds URLs');

// Deploys check that systemd really holds the listener, and restart a socket unit that changed. Since
// WS-N task 11 deploy.sh hands over to `ovhost deploy live` (OpenVibe.Host strategy release-layout:
// systemd.socketHeld + rebindSocket, test/strategy-release-layout.test.js there) and falls back to
// deploy-legacy.sh, the previous script, which still does it itself.
const legacy = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'scripts', 'deploy-legacy.sh'), 'utf8');
assert.match(legacy, /socket_held\(\)/, 'deploy-legacy.sh has the listener check');
assert.match(legacy, /SOCKET_CHANGED=true/, 'a changed socket unit is noted');
assert.match(legacy, /\$SYSTEMCTL restart "\$\{SERVICE\}\.socket"/, 'and restarted');
const wrapper = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'scripts', 'deploy.sh'), 'utf8');
assert.match(wrapper, /^STRATEGY=release-layout$/m, 'deploy.sh only hands over to an ovhost that deploys live with release-layout (the socket rule)');
assert.match(wrapper, /deploy-api/, 'and checks the deploy API version before it does');
assert.match(wrapper, /exec bash "\$LEGACY"/, 'anything else falls back to deploy-legacy.sh');

console.log('systemd units: all checks passed');
