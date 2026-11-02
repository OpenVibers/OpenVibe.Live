'use strict';
// Setting up to go live on a phone keeps the app's bottom bar like every other page (the owner, 2026-11-01: "the buttons
// at the bottom don't show like our mobile buttons"); only the live studio owns the whole screen. The Go live dock sits
// above whatever is at the bottom edge, and the page keeps room at its foot for the dock and the bar.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const css = fs.readFileSync(path.join(__dirname, '..', 'public/css/features/broadcast.css'), 'utf8');

assert.ok(!/html:has\(#page-broadcast\.active\) \.ovnav-appbar \{ display: none; \}/.test(css), 'the bar stays while setting up');
assert.ok(!/html:has\(#page-broadcast\.active\) \{ --ovnav-appbar-h: 0px; \}/.test(css), 'and keeps its room');
assert.match(css, /body\.bc-studio-on \.ovnav-appbar \{ display: none !important; \}/, 'the live studio still owns the screen');
assert.match(css, /\.bcs-golive \{\s*position: fixed; left: 0; right: 0; bottom: var\(--ovnav-appbar-h, 0px\);/, 'the dock sits above the bottom edge');
assert.match(css, /body\.bc-golive-dock-on #page-broadcast \{ padding-bottom: calc\(104px \+ var\(--ovnav-appbar-h, 0px\) \+ env\(safe-area-inset-bottom, 0px\)\); \}/, 'room for the dock and the bar');
console.log('go live dock: setting up keeps the app bar; the dock sits above it and never covers the last fields');
