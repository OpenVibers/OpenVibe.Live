'use strict';
// The streamer dashboard's tab is in the address: /dashboard/money opens Money (a refresh or a shared link keeps the tab),
// switching tabs updates the address in place, Home is /dashboard and an unknown tab falls back to Home. Before
// 2026-10-17 every /dashboard/<tab> opened Home and the address kept whatever path it was opened with. (Checked in a
// browser against production with this file; the server already answers 200 for /dashboard/* — server/web/page-status.js.)
//
//   node test/dashboard-tab-urls.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../public/js/dashboard.js'), 'utf8');
const fn = (name) => { const i = src.indexOf(`function ${name}(`); assert.ok(i >= 0, name); return src.slice(i, src.indexOf('\n}\n', i)); };
const sw = fn('switchDashTab');
assert.ok(/tab === 'home' \? '\/dashboard' : '\/dashboard\/' \+ tab/.test(sw) && sw.includes('history.replaceState('), 'a tab switch writes its address in place');
assert.ok(sw.includes("location.pathname.startsWith('/dashboard')"), 'only while the dashboard is the page');
const load = fn('loadDashboard');
assert.ok(/location\.pathname\.match\(\/\^\\\/dashboard\\\/\(\[a-z\]\+\)\/\)/.test(load), 'the tab is read from the address');
assert.ok(load.includes('data-dtab="${fromUrl}"') && load.includes(": 'home'"), 'an unknown tab opens Home');
const tabs = [...fs.readFileSync(path.join(__dirname, '../public/fragments/dashboard.html'), 'utf8').matchAll(/data-dtab="([a-z]+)"/g)].map((m) => m[1]);
assert.ok(['home', 'money', 'content', 'moderation'].every((t) => tabs.includes(t)), 'the tabs the addresses name exist');
console.log('dashboard tab urls: all checks passed');
