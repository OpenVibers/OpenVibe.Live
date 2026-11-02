'use strict';
// Route placeholders (public/js/ov-skeleton.js; plan L52 step 6): while a route's code loads, its section shows the
// shape of the page on its way instead of an empty 40vh box. Every page section has a shape, every shape draws, a
// phone gets fewer cards than a computer, and nothing in them spins.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ov-skeleton.js'), 'utf8');
function load(innerWidth) {
    const window = { innerWidth };
    const document = { body: null, addEventListener() {}, getElementById() { return null; } };
    vm.runInNewContext(src, { window, document, setTimeout, clearTimeout });
    return window.OVSkeleton;
}

const phone = load(390);
const computer = load(1280);
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const sections = [...html.matchAll(/<section id="(page-[a-z-]+)"/g)].map((m) => m[1]).filter((id) => id !== 'page-not-found');
assert.ok(sections.length >= 14, `found ${sections.length} page sections`);
for (const id of sections) assert.ok(phone.ROUTE_SHAPE[id], `${id} has a placeholder shape`);

const kinds = [...new Set(Object.values(phone.ROUTE_SHAPE))];
for (const k of kinds) {
    const out = phone.routeShape(k);
    assert.ok(out.length > 100 && /ovsk-bar/.test(out), `${k} draws`);
}
const count = (s) => (s.match(/ovsk-r-card"/g) || []).length;
assert.strictEqual(count(phone.routeShape('cards')), 3, 'a phone gets three cards');
assert.strictEqual(count(computer.routeShape('cards')), 8, 'a computer gets two rows of four');
assert.ok(/ovsk-r-video/.test(phone.routeShape('player')), 'a channel waits as a 16:9 player and its chat');
assert.ok(!/spin|rotate/.test(src), 'a placeholder shimmers; nothing spins');
console.log(`route skeletons: ${sections.length} sections, ${kinds.length} shapes (${kinds.join(', ')})`);
