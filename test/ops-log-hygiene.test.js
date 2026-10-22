// Log hygiene and shutdown: the Effective URLs block prints once per change, the PowerChat relay
// failure is logged once an hour per person while it stays the same, and a pg connection drop is
// recognised (the process handler lets it pass while shutting down).
const assert = require('assert');

const lines = [];
const origLog = console.log;
const origWarn = console.warn;
console.log = (...a) => { lines.push(a.join(' ')); };
console.warn = (...a) => { lines.push(a.join(' ')); };
const count = (re) => lines.filter((l) => re.test(l)).length;

(async () => {
    try {
        // ── Effective URLs: printed at load, not again by a refresh that changes nothing ──
        process.env.OV_OAUTH_CLIENT_SECRET = 'live-secret';
        const config = require('../server/config');
        assert.strictEqual(count(/\[Config\] Effective URLs/), 1, 'printed once at load');
        const { tokenBody } = require('./helpers/network-token-stub');
        let base = config.baseUrl;
        const originalFetch = global.fetch;
        global.fetch = async (url) => String(url).endsWith('/oauth/token')
            ? new Response(JSON.stringify(tokenBody()), { status: 200, headers: { 'content-type': 'application/json' } })
            : { ok: true, json: async () => ({ registry: { BASE_URL: { value: base, source: 'bootstrap' } } }) };
        config.openvibeToolsInternalUrl = 'http://127.0.0.1:3100';
        await config.refreshRegistry();
        const afterFirst = count(/\[Config\] Effective URLs/);
        await config.refreshRegistry();
        await config.refreshRegistry();
        assert.strictEqual(count(/\[Config\] Effective URLs/), afterFirst, 'unchanged refreshes print nothing');
        base = 'https://changed.example';
        await config.refreshRegistry();
        assert.strictEqual(count(/\[Config\] Effective URLs/), afterFirst + 1, 'a change prints the block again');
        assert.ok(lines.some((l) => l.includes('BASE_URL= https://changed.example')));
        global.fetch = originalFetch;

        // ── PowerChat relay failure: once an hour per person while the reason is the same ──
        const pc = require('../server/integrations/powerchat-platform');
        const { relayFail, relayReset } = pc._test;
        relayReset();
        lines.length = 0;
        const t0 = Date.parse('2026-10-22T00:00:00Z');
        assert.strictEqual(relayFail(1, 'HTTP 404', t0), true);
        for (let i = 1; i <= 4; i++) assert.strictEqual(relayFail(1, 'HTTP 404', t0 + i * 15 * 60 * 1000 - 1), false);
        assert.strictEqual(count(/chat relay failed for user 1/), 1);
        assert.strictEqual(relayFail(2, 'HTTP 404', t0), true, 'another person is logged on their own');
        assert.strictEqual(relayFail(1, 'HTTP 500', t0 + 1000), true, 'a different reason is logged at once');
        assert.strictEqual(relayFail(1, 'HTTP 500', t0 + 2000), false);
        assert.strictEqual(relayFail(1, 'HTTP 500', t0 + 1000 + 60 * 60 * 1000), true, 'an hour later it is logged again');
        assert.ok(lines[lines.length - 1].includes('(1 more since the last report)'), lines[lines.length - 1]);
        relayReset();

        // ── pg connection errors ──
        const { isPgConnectionError } = require('../server/utils/pg-errors');
        assert.strictEqual(isPgConnectionError(new Error('Connection terminated unexpectedly')), true);
        assert.strictEqual(isPgConnectionError(Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' })), true);
        assert.strictEqual(isPgConnectionError(Object.assign(new Error('x'), { code: '08006' })), true);
        const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
        reset.stack = 'Error: read ECONNRESET\n    at Socket.<anonymous> (/opt/x/node_modules/pg/lib/connection.js:1:1)';
        assert.strictEqual(isPgConnectionError(reset), true, 'a socket error from the pg driver');
        const otherReset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', stack: 'Error: read ECONNRESET\n    at ws.js:1:1' });
        assert.strictEqual(isPgConnectionError(otherReset), false, 'a socket error elsewhere is not');
        assert.strictEqual(isPgConnectionError(new TypeError('x is not a function')), false);
        assert.strictEqual(isPgConnectionError(Object.assign(new Error('duplicate key'), { code: '23505' })), false);
        assert.strictEqual(isPgConnectionError(null), false);

        // ── the process handler: pg drop while stopping passes, anything else still exits 1 ──
        const src = require('fs').readFileSync(require('path').join(__dirname, '../server/index.js'), 'utf8');
        assert.ok(/else if \(_shuttingDown && isPgConnectionError\(err\)\)/.test(src), 'uncaughtException lets a pg drop pass while shutting down');
        assert.ok(/function shutdown\(signal\) \{\s*_shuttingDown = true;/.test(src), 'shutdown() marks the process as stopping first');

        console.log = origLog;
        console.warn = origWarn;
        console.log('✅ ops log hygiene test passed');
        process.exit(0);
    } catch (err) {
        console.log = origLog;
        console.warn = origWarn;
        console.error(err);
        process.exit(1);
    }
})();
