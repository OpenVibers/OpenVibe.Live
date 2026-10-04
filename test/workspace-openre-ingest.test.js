#!/usr/bin/env node
'use strict';
/**
 * The Go Live workspace's ingest URLs for a slot ingested by OpenRe: WHIP and JSMPEG point at
 * OpenRe's servers with the key in the path, never at Live's /whip/<slot> or JSMPEG relay (Live
 * refuses those publishes). Slots on Live's own ingest keep Live's URLs.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '../public/js/broadcast-workspace.js'), 'utf8');
const ctx = {
    window: { location: { origin: 'https://openvibe.live' }, addEventListener() {} },
    document: { addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; } },
    localStorage: { getItem() { return null; }, setItem() {} },
    console,
    esc: (s) => String(s),
};
vm.createContext(ctx);
vm.runInContext(`${src}\n;this.__ws = { _wsState, _wsWhipUrl, _wsRenderMethodEndpoint };`, ctx);
const { _wsState, _wsWhipUrl, _wsRenderMethodEndpoint } = ctx.__ws;

// Live's own ingest: the slot id goes after Live's WHIP base, JSMPEG keeps the relay placeholder.
_wsState.whipUrlBase = 'https://whip.openvibe.live/';
assert.strictEqual(_wsWhipUrl(708, 'livekey'), 'https://whip.openvibe.live/whip/708');
assert.ok(_wsRenderMethodEndpoint('cli', 'livekey', 708).includes('http://openvibe.live:PORT/livekey/640/480/'));

// OpenRe: its WHIP URL takes the key, its JSMPEG server takes key/width/height.
Object.assign(_wsState, { whipUrlBase: null, openreWhipUrl: 'https://ingest.openre.stream/whip', openreJsmpegUrl: 'http://ingest.openre.stream:8081' });
assert.strictEqual(_wsWhipUrl(708, 'ork_key'), 'https://ingest.openre.stream/whip/ork_key');
const whipInfo = _wsRenderMethodEndpoint('whip', 'ork_key', 708);
assert.ok(whipInfo.includes('https://ingest.openre.stream/whip/ork_key'), whipInfo);
assert.ok(!whipInfo.includes('/whip/708'));
const cli = _wsRenderMethodEndpoint('cli', 'ork_key', 709);
assert.ok(cli.includes('http://ingest.openre.stream:8081/ork_key/640/480/'), 'JSMPEG commands use OpenRe');
assert.ok(!cli.includes('openvibe.live:PORT'));
assert.ok(cli.includes('https://ingest.openre.stream/whip/ork_key'), 'the CLI WHIP tab uses OpenRe');

console.log('✅ workspace OpenRe ingest: WHIP and JSMPEG URLs point at OpenRe for switched slots, at Live otherwise');
