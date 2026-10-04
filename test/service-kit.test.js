/**
 * openvibe-sdk/service in Live (plan T1, the last kit consumer): the non-drill SIGTERM/SIGINT shutdown is the
 * kit's gracefulStop, not a hand-written setTimeout chain. The stop steps flip readiness and stop the jobs,
 * beforeDrain closes sockets and child processes while the server still listens, the HTTP server drains for
 * 4 s, then analytics and the database close; past 5 s the process exits 1. The drill branch stays its own.
 * The static half reads server/index.js; the behavioural half drives gracefulStop with Live's options.
 *
 *   node test/service-kit.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { gracefulStop } = require('openvibe-sdk/service');

const source = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
const quiet = { log() {}, warn() {}, error() {} };

// ── Static: server/index.js ──────────────────────────────────────────────────────
assert.match(source, /const \{ gracefulStop \} = require\('openvibe-sdk\/service'\)/);
assert.strictEqual(source.split('gracefulStop(').length - 1, 1, 'exactly one gracefulStop( call');
const at = source.indexOf('gracefulStop(');
const call = source.slice(at, source.indexOf('\n});', at));
assert.match(call, /name: 'Live'/);
assert.match(call, /signals: false/);
assert.match(call, /drainMs: 4000/);
assert.match(call, /deadlineMs: 5000/);
assert.match(call, /deadlineExitCode: 1/);
assert.match(call, /beforeDrain:/);
assert.ok(at > source.indexOf('const server = http.createServer(app);'), 'the stopper is created after the server exists');
const stopAt = call.indexOf('stop: [');
assert.ok(stopAt > 0 && call.indexOf('_bootComplete = false', stopAt) < call.indexOf("require('./chat/chat-delivery')", stopAt),
    'readiness flips before anything else stops');

const fn = source.slice(source.indexOf('function shutdown('), source.indexOf("process.on('SIGTERM', shutdown)"));
assert.match(fn, /if \(drill\.enabled\) \{/, 'the drill branch is still there');
const nonDrill = fn.slice(fn.indexOf('        return;\n    }\n'));
assert.match(nonDrill, /stopper\.stop\(signal\)/);
assert.doesNotMatch(nonDrill, /process\.exit\(1\), 5000/, 'the old 5 s exit-1 timer is gone');
assert.doesNotMatch(nonDrill, /server\.close\(/);
assert.match(source, /process\.on\('SIGTERM', shutdown\)/);
assert.match(source, /process\.on\('SIGINT', shutdown\)/);

// ── Behaviour: Live's options, exits stubbed ─────────────────────────────────────
(async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const order = [];
    const mark = (what) => () => { order.push(`${what}${server.listening ? '' : ' (closed)'}`); };
    let exited = null;
    let exits = 0;
    const kit = gracefulStop({
        name: 'Live', server, signals: false, drainMs: 4000, deadlineMs: 5000, deadlineExitCode: 1,
        stop: [mark('ready off'), () => { throw new Error('a failing stop step does not stop the stop'); }, mark('jobs')],
        beforeDrain: mark('sockets'),
        close: [mark('analytics'), mark('db')],
        exit: (c) => { exited = c; exits++; },
        log: quiet,
    });
    const [code, again] = await Promise.all([kit.stop('SIGTERM'), kit.stop('SIGINT')]);
    assert.deepStrictEqual(order, ['ready off', 'jobs', 'sockets', 'analytics (closed)', 'db (closed)'],
        'stop steps and beforeDrain run while listening; close steps after the drain');
    assert.strictEqual(code, 0);
    assert.strictEqual(again, 0, 'a second signal changes nothing');
    assert.strictEqual(exited, 0);
    assert.strictEqual(exits, 1, 'exit is called once');
    assert.strictEqual(server.listening, false);
    console.log('service-kit: ok');
})().catch((err) => { console.error(err); process.exit(1); });
