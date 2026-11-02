'use strict';
// The look before first paint (openvibe-shared 4.64.0 look-boot, plan L42; the owner, 10-31: seasonal turned off on
// Network was still on, and orange, on Live). theme-loader.js loads with defer here, so the document's head carries
// look-boot: the look this browser last painted on Live (ov_paint), or the one a link from another OpenVibe page just
// carried (?ov_look=), with the display settings. It sits above every stylesheet, and the marker never reaches a page.
const assert = require('assert');
const assets = require('../server/web/assets');
const { BOOT } = require('openvibe-shared/look-boot');

const doc = assets.document('index.html').html;
const at = doc.indexOf(BOOT);
assert.ok(at > 0, 'the head carries look-boot');
assert.ok(!doc.includes('<!--ov:look-boot-->'), 'the marker is replaced');
const firstSheet = doc.search(/<link[^>]+rel="stylesheet"/);
assert.ok(firstSheet > 0 && at < firstSheet, 'it paints before any stylesheet');
assert.ok(at < doc.indexOf('/shared/theme-loader.js'), 'and before the loader');
assert.strictEqual(doc.split(BOOT).length, 2, 'once');
// A browser from before look-boot (ov_theme only) is painted once from its theme, colours only.
const legacy = doc.slice(at, firstSheet);
assert.match(legacy, /if \(localStorage\.getItem\('ov_paint'\)\) return;/);
assert.match(legacy, /!\/url\|expression\/i\.test/);
// Every route's document keeps it (renderRoute works on the same base).
assert.ok(assets.renderRoute(doc, '/@someone').includes(BOOT), 'a channel page too');
console.log('look boot: the head paints the kept or carried look before any stylesheet, once, on every route');
