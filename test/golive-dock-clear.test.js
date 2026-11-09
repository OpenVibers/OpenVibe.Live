'use strict';
/**
 * On a phone, the Dock's pill (openvibe-shared dock.js, "Needs you" / "Working", bottom right) sat on the right half of
 * the pinned Go live button: a tap there opened the Agent panel instead of going live (11-09, measured 4,140 px² of
 * overlap at 390 px). While the Go live dock shows (body.bc-golive-dock-on) the pill rides above it, by the same
 * clearance the page keeps at its foot; a pill moved to a top corner is left alone.
 *
 *   node test/golive-dock-clear.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public/css/features/broadcast.css'), 'utf8');
const rule = /body\.bc-golive-dock-on \.ovdk-pill:not\(\[data-corner\^="top"\]\) \{\s*bottom: calc\(104px \+ var\(--ovnav-appbar-h, 0px\) \+ env\(safe-area-inset-bottom, 0px\)\);/;
assert.ok(rule.test(css), 'the pill clears the Go live dock');
assert.ok(/body\.bc-golive-dock-on #page-broadcast \{ padding-bottom: calc\(104px \+ var\(--ovnav-appbar-h, 0px\) \+ env\(safe-area-inset-bottom, 0px\)\); \}/.test(css),
    'the same 104 px the page keeps for the dock (change both together)');
assert.ok(!/body\.bc-golive-dock-on \.ovdk-pill[^{]*\{[^}]*display:\s*none/.test(css), 'the pill moves, it is never hidden');
console.log('go live dock: the Dock pill rides above it, never on the button');
