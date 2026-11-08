'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/js/app.js'), 'utf8');
const start = source.indexOf('function _trySilentSso(');
const end = source.indexOf('let _ssoClientPromise', start);
for (const scenario of [
    { name: 'first visit', hint: null, expected: true },
    { name: 'returning person', hint: 'account', expected: true },
    { name: 'explicit sign-out', hint: 'guest' },
    { name: 'guest callback', search: '?sso=none' },
    { name: 'already signed in', currentUser: { id: 1 } },
    { name: 'crawler', userAgent: 'Googlebot' },
    { name: 'blocked tab storage', blocked: true },
    { name: 'banned page', pathname: '/banned' },
    { name: 'API page', pathname: '/api/auth' },
]) {
    const tab = new Map(), redirects = [];
    const context = vm.createContext({
        currentUser: scenario.currentUser || null,
        _ssoHint: () => scenario.hint,
        navigator: { userAgent: scenario.userAgent || 'Chrome' },
        sessionStorage: { getItem(k) { if (scenario.blocked) throw Error('blocked'); return tab.get(k); }, setItem: (k,v) => tab.set(k,v) },
        location: { pathname: scenario.pathname || '/channel/probe', search: scenario.search || '?tab=chat', hash: '#latest', replace: url => redirects.push(url) },
    });
    vm.runInContext(source.slice(start, end), context);
    assert.equal(vm.runInContext('_trySilentSso()', context), !!scenario.expected, scenario.name);
    assert.equal(vm.runInContext('_trySilentSso()', context), false, 'never repeat the round trip');
    if (scenario.expected) assert.deepEqual(redirects, ['/api/auth/sso/login?silent=1&next=%2Fchannel%2Fprobe%3Ftab%3Dchat%23latest']);
    else assert.equal(redirects.length, 0);
}
console.log('silent first visit: all checks passed');
