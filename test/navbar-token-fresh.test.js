'use strict';
// The navbar's token stays live (2026-11-17, the owner: "The history tab no longer loads or is broken"). The menu
// reads the navbar's token for History, the feed and notifications; Live refreshed only its own copy, only after a
// call failed, so after an hour the menu asked the Network with an expired token (401) and History said "Nothing here
// yet". Every refresh now reaches the navbar, a refresh is planned before expiry, and a tab coming back refreshes.
//   node test/navbar-token-fresh.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const fnSrc = (name) => {
    const m = src.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    assert.ok(m, `${name} is defined`);
    return m[0];
};

// The expiry is read from the token itself.
const box = { atob: (s) => Buffer.from(s, 'base64').toString('binary'), result: null, tok: `x.${Buffer.from(JSON.stringify({ exp: 1900000000 })).toString('base64url')}.y` };
vm.runInNewContext(`${fnSrc('_tokenExpiry')}; result = [_tokenExpiry(tok), _tokenExpiry('nope'), _tokenExpiry(null)];`, box);
assert.strictEqual(JSON.stringify(box.result), JSON.stringify([1900000000 * 1000, 0, 0]));

// A refresh reaches the navbar and plans the next one.
assert.match(fnSrc('tryRefreshToken'), /localStorage\.setItem\('token', data\.access_token\);[\s\S]*_tokenToNavbar\(\);[\s\S]*return true;/, 'a refreshed token goes to the navbar');
assert.match(fnSrc('_tokenToNavbar'), /window\.LiveNav\.sync\(currentUser\)[\s\S]*_planTokenRefresh\(\);/);
assert.match(fnSrc('_planTokenRefresh'), /exp - Date\.now\(\) - 60000/, 'a minute before it expires');
assert.match(src, /document\.addEventListener\('visibilitychange', \(\) => \{[\s\S]*?exp - Date\.now\(\) < 90000\) tryRefreshToken\(\)/, 'a tab back in front refreshes a stale token');
assert.match(src, /window\.LiveNav\.sync\(currentUser \|\| null\);\n\s+_planTokenRefresh\(\);/, 'and the plan starts when the bar learns who is here');
console.log('navbar-token-fresh: refreshes reach the navbar, planned before expiry, and on a tab coming back');
