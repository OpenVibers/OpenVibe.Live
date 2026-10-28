'use strict';
/**
 * Live's account menu (public/js/ov-navbar-live.js on openvibe-shared's navbar; the owner, 2026-10-28: "duplicated things …
 * could just be organized better … needs a full review"): Live's own rows in one section, and nothing the bar or the
 * network's rows already have. The balances are the bar's chips, Support Us was the Vibes chip's click, My Account,
 * My Channel, History and Admin are the network's "You" rows, and Switch account was the menu's own accounts list.
 *
 *   node test/navbar-menu-live.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ov-navbar-live.js'), 'utf8');
const menu = src.slice(src.indexOf('function menu(user)'), src.indexOf('function config(user)'));

assert.ok(menu.length > 100, 'the menu is defined');
assert.ok(!/headerChips/.test(menu), 'the balances are the bar\'s chips, not repeated in the menu');
assert.ok(!/defaults:\s*false/.test(menu), 'the network\'s own rows (You, Display) are kept, as on every OpenVibe site');
['Support Us', 'Switch account', 'My Account', 'My Channel', 'History', 'Admin Panel', "id: 'you'"].forEach((gone) => {
    assert.ok(!menu.includes(gone), `no "${gone}" here: the network's rows or the bar have it`);
});
const sections = menu.match(/\{ id: '[a-z]+', label: '[^']+', items: \[/g) || [];
assert.deepStrictEqual(sections, ["{ id: 'live', label: 'Live', items: ["], 'one section, Live\'s own');
['Dashboard', 'Streamer setup', 'Cosmetics', 'Screenshot this page', 'Help & docs', 'Browse as guest'].forEach((row) => {
    assert.ok(menu.includes(`label: '${row}'`), `Live's "${row}" row`);
});
assert.ok(!/\bafter:/.test(menu), 'no rows after the network\'s');

console.log('navbar menu live: all checks passed');
