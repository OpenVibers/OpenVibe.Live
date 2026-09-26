'use strict';
// Open redirect regression (WS-R task 5): the sign-in `next` never leaves OpenVibe's own zones. Until
// 2026-09-26 "/<TAB>/evil.com" and "/\evil.com" (both "//evil.com" to a browser) and openvibe.<any tld>
// got through.
const assert = require('assert');
const { safeNext } = require('../server/auth/safe-next');

for (const v of ['//evil.com', '/\\evil.com', '\\\\evil.com', 'https://evil.com', 'http:evil.com', '/\t/evil.com', '/\n/evil.com', '\t//evil.com',
    '/\\/evil.com', 'https:/\\evil.com', '///evil.com', 'javascript:alert(1)', 'https://openvibe.xyz/', 'https://evil.openvibe.co/',
    'https://tenant.openvibe.host/', 'https://user:pw@openvibe.live/', 'http://openvibe.live/', 'https://openvibe.live.evil.com/']) {
    assert.strictEqual(safeNext(v), '/', `${JSON.stringify(v)} goes home`);
}
for (const [v, want] of [['/@someone?tab=vods', '/@someone?tab=vods'], ['https://openvibe.network/sso/fanout?x=1', 'https://openvibe.network/sso/fanout?x=1'],
    ['https://www.openvibe.live/a', 'https://www.openvibe.live/a'], ['https://openvibe.host/', 'https://openvibe.host/'], ['https://openre.stream/x', 'https://openre.stream/x'],
    ['http://localhost:3000/', 'http://localhost:3000/']]) {
    assert.strictEqual(safeNext(v), want, `${JSON.stringify(v)} is kept`);
}
console.log('open redirect: all checks passed');
