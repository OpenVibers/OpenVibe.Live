'use strict';
// The WHIP host answers WHIP only (server/web/whip-host.js, 2026-10-23): on whip.openvibe.live, /whip, /whip/* and
// /api/health pass; every other path is a 301 to the same path on the site. The site's own host, a missing WHIP
// host or one equal to the site's pass everything.
const assert = require('assert');
const { createWhipHostRedirect } = require('../server/web/whip-host');

const run = (mw, hostname, originalUrl) => {
    const path = originalUrl.split('?')[0];
    let out = 'next';
    mw({ hostname, path, originalUrl }, { redirect: (code, to) => { out = `${code} ${to}`; } }, () => {});
    return out;
};

let whip = 'https://whip.openvibe.live';
const mw = createWhipHostRedirect({ whipUrl: () => whip, siteUrl: () => 'https://openvibe.live' });

assert.strictEqual(run(mw, 'whip.openvibe.live', '/whip/abc123'), 'next');
assert.strictEqual(run(mw, 'whip.openvibe.live', '/whip/abc123/res_1'), 'next');
assert.strictEqual(run(mw, 'whip.openvibe.live', '/whip'), 'next');
assert.strictEqual(run(mw, 'whip.openvibe.live', '/api/health'), 'next');
assert.strictEqual(run(mw, 'whip.openvibe.live', '/'), '301 https://openvibe.live/');
assert.strictEqual(run(mw, 'whip.openvibe.live', '/@kim?tab=vods'), '301 https://openvibe.live/@kim?tab=vods');
assert.strictEqual(run(mw, 'whip.openvibe.live', '/api/streams/live'), '301 https://openvibe.live/api/streams/live');
assert.strictEqual(run(mw, 'whip.openvibe.live', '/whipped'), '301 https://openvibe.live/whipped', 'only /whip itself and below');
assert.strictEqual(run(mw, 'openvibe.live', '/'), 'next', 'the site itself is untouched');

// The WHIP host is read per request (the URL registry fills it after boot): none, or the site's own, does nothing.
whip = null;
assert.strictEqual(run(mw, 'whip.openvibe.live', '/'), 'next');
whip = 'https://openvibe.live';
assert.strictEqual(run(mw, 'openvibe.live', '/'), 'next');
whip = 'not a url';
assert.strictEqual(run(mw, 'whip.openvibe.live', '/'), 'next');

console.log('whip host: WHIP only, everything else to the site');
