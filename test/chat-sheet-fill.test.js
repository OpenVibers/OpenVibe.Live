'use strict';
// A phone watching live (ask 371, 2026-11-13): the chat sheet runs to the bottom of the screen, its grip lies over the
// header instead of taking a row, and in the Robot tab the header's gear and people button still open their panels.
//
// The browser check that measured it: the sheet stopped at 804 of an 844 px screen (a live tabs bar the phone hid still
// took 40 px, and the page kept 32 px of bottom padding), the header was 49 px, and the gear did nothing in the Robot tab
// (its panel was inside the chat that tab hides). After: 844, 45 px, and the panel over the robot's.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'features', 'channel.css'), 'utf8');

assert.ok(css.includes('#page-channel.ch-is-live.has-live-tabs:has(.live-stream-tabs .live-tab:nth-child(2)) .stream-layout { --live-tabs-h: 40px; }'),
    'the live tabs bar takes its height only while it is shown (a phone hides it with one stream)');
assert.ok(!/#page-channel\.ch-is-live\.has-live-tabs \.stream-layout \{ --live-tabs-h: 40px; \}/.test(css), 'never for a bar the phone hid');
assert.ok(css.includes('#page-channel.ch-is-live.page { padding-bottom: 0; }'), 'no bottom padding under the sheet');
assert.ok(/> \.chat-sidebar > :not\(\.chat-header\):not\(\.chat-settings-panel\):not\(\.chat-users-panel\) \{ display: none !important; \}/.test(css),
    'the Robot tab hides the chat but not the settings and people panels');
assert.ok(/> \.chat-sidebar > :is\(\.chat-settings-panel, \.chat-users-panel\) \{\s*position: absolute; top: 100%;/.test(css),
    'which open over the robot\'s panel, under the header');
assert.ok(/> \.chat-sidebar \.chat-header \{ padding-top: 4px; padding-bottom: 4px; min-height: 44px; \}/.test(css), 'a compact header');
assert.ok(/> \.chat-sidebar > \.chat-grip \{ position: absolute; top: 0; height: 14px;/.test(css), 'the grip over its top edge, no row of its own');
const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-channel.js'), 'utf8');
assert.ok(/function _wireChannelMoreLayer\(menu\)/.test(js) && /pop\.setAttribute\('popover', 'manual'\)/.test(js) && /_wireChannelMoreLayer\(menu\);\n    menu\.open = false;/.test(js),
    'the ⋯ menu opens in the top layer, placed on the screen (a phone\'s live layout clipped it)');
assert.ok(css.includes('#page-channel .ch-more-menu.is-layer { position: fixed;'), 'and is fixed there');
assert.ok(css.includes('.ch-bot-tabs button > :is(i, svg) { flex: none; display: inline-grid; place-items: center; width: 20px; height: 20px;'),
    'every tab icon fills the same box (the robot was drawn smaller than the chat bubble)');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'fragments', 'channel.html'), 'utf8');
assert.strictEqual((html.match(/fa-chevron-down ch-ic-sheet/g) || []).length, 2, 'the sheet folds with the set\'s solid chevron');
console.log('chat-sheet-fill: to the bottom of the screen, a compact header, the gear and people in the Robot tab, the ⋯ menu, the tab icons');
