'use strict';

/**
 * C-77 — ALLOW_P2P_FALLBACK is gone; the env name is inert.
 *
 * A broadcast must behave exactly the same whether the legacy variable is set
 * or not. We prove that at two levels:
 *   1. Building the server config with ALLOW_P2P_FALLBACK set to various values
 *      yields a config byte-identical to the default build, and no
 *      `allowP2pFallback` field exists to read.
 *   2. No broadcast code path (server or client) names the variable at all, so
 *      every downstream decision is taken without it.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = require.resolve('../server/config');

function buildConfig(envValue) {
    delete require.cache[CONFIG_PATH];
    if (envValue === undefined) {
        delete process.env.ALLOW_P2P_FALLBACK;
    } else {
        process.env.ALLOW_P2P_FALLBACK = envValue;
    }
    // JSON round-trip drops functions (refreshRegistry, _normalizeTurnUrl) so the
    // snapshot is a pure comparison of the config values a broadcast would read.
    return JSON.stringify(require('../server/config'));
}

const withoutFlag = buildConfig(undefined);
delete process.env.ALLOW_P2P_FALLBACK; // leave the process clean for any later test

assert.ok(
    !Object.prototype.hasOwnProperty.call(JSON.parse(withoutFlag), 'allowP2pFallback'),
    'server config must not expose an allowP2pFallback field'
);
assert.strictEqual(
    buildConfig('true'), withoutFlag,
    'config with ALLOW_P2P_FALLBACK=true must be identical to config without it'
);
assert.strictEqual(
    buildConfig('1'), withoutFlag,
    'config with ALLOW_P2P_FALLBACK=1 must be identical to config without it'
);
assert.strictEqual(
    buildConfig('false'), withoutFlag,
    'config with ALLOW_P2P_FALLBACK=false must be identical to config without it'
);
delete process.env.ALLOW_P2P_FALLBACK;

// No broadcast code reads or emits the name — the variable cannot influence a broadcast.
const SOURCES = [
    '../server/config.js',
    '../server/streaming/broadcast-server.js',
    '../public/js/broadcast.js',
    '../public/js/broadcast-state.js',
    '../public/js/stream-player.js',
];
for (const rel of SOURCES) {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    assert.ok(
        !src.includes('ALLOW_P2P_FALLBACK') && !src.includes('allowP2pFallback'),
        `${rel} must not reference ALLOW_P2P_FALLBACK (it is ignored)`
    );
}

console.log('OK: ALLOW_P2P_FALLBACK is ignored — a broadcast behaves the same with or without it');
