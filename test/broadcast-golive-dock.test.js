'use strict';
// The studio is a going-live screen, so on a phone it owns the screen (owner, 2026-10-31: the "Go live" button sat under
// the app's bottom bar). The app bar steps aside on the broadcast page, the Go live dock sits above whatever is at the
// bottom edge, and the page keeps room at its foot so its last fields are never under the dock.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const css = fs.readFileSync(path.join(__dirname, '..', 'public/css/features/broadcast.css'), 'utf8');

const phone = css.slice(css.indexOf('@media (max-width: 760px) {\n    html:has(#page-broadcast.active)'));
assert.ok(phone.startsWith('@media (max-width: 760px)'), 'a phone rule');
assert.match(phone, /html:has\(#page-broadcast\.active\) \{ --ovnav-appbar-h: 0px; \}/, 'no room kept for the bar');
assert.match(phone, /html:has\(#page-broadcast\.active\) \.ovnav-appbar \{ display: none; \}/, 'the bar steps aside');
assert.match(css, /\.bcs-golive \{\s*position: fixed; left: 0; right: 0; bottom: var\(--ovnav-appbar-h, 0px\);/, 'the dock sits above the bottom edge');
assert.match(css, /body\.bc-golive-dock-on #page-broadcast \{ padding-bottom: calc\(104px \+ env\(safe-area-inset-bottom, 0px\)\); \}/, 'room for the dock');
console.log('go live dock: the broadcast page owns a phone screen, and the dock never covers the bar or the last fields');
