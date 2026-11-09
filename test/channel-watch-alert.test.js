'use strict';
// "Get an alert" in the channel's More menu opens OpenVibe.Watch's form for live.stream.started, so an
// alert can reach an email, a webhook or an agent. Hidden on one's own channel and until the channel is known.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const fragment = fs.readFileSync(path.join(ROOT, 'public/fragments/channel.html'), 'utf8');
assert.match(fragment, /<a class="ch-more-item ch-watch-alert" id="ch-watch-offline" href="https:\/\/openvibe\.watch\/" target="_blank" rel="noopener" hidden>/, 'the link is in More, hidden until filled');

const src = fs.readFileSync(path.join(ROOT, 'public/js/app-channel.js'), 'utf8');
const fn = /function _setWatchAlert\(a, username\) \{[\s\S]*?\n\}/.exec(src);
assert.ok(fn, '_setWatchAlert exists');
assert.match(src, /_setWatchAlert\(document\.getElementById\('ch-watch-offline'\), username\);/, 'More fills it for either header');

const run = (viewer, username) => {
    const a = { hidden: true, href: 'https://openvibe.watch/', title: '' };
    const ctx = { currentUser: viewer, URLSearchParams };
    vm.createContext(ctx);
    vm.runInContext(`${fn[0]}\n_setWatchAlert(a, ${JSON.stringify(username)});`, Object.assign(ctx, { a }));
    return a;
};

const a = run({ username: 'someone' }, 'goosely');
assert.strictEqual(a.hidden, false);
const u = new URL(a.href);
assert.strictEqual(u.origin + u.pathname, 'https://openvibe.watch/watches/new');
assert.deepStrictEqual(Object.fromEntries(u.searchParams), { template: 'event', event: 'live.stream.started', event_filter: 'goosely', name: '@goosely goes live' });
assert.match(a.title, /@goosely goes live: by email, a webhook or your agent/);
assert.strictEqual(run(null, 'goosely').hidden, false, 'signed out too: Watch asks them to sign in');
assert.strictEqual(run({ username: 'goosely' }, 'goosely').hidden, true, 'not on one\'s own channel');
assert.strictEqual(run(null, '').hidden, true, 'not before the channel is known');
console.log('channel watch alert: all checks passed');
