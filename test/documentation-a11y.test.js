'use strict';
// The documentation tab's tables scroll sideways on a phone (public/css/features/docs.css: .doc-table becomes a
// block with overflow-x: auto), so each must be a keyboard stop: axe's scrollable-region-focusable (WCAG 2.1.1),
// found on /documentation by a 390 px scan on 2026-10-15.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'fragments', 'documentation.html'), 'utf8');
const tables = html.match(/<table\b[^>]*>/g) || [];
assert.ok(tables.length > 0, 'the documentation has tables');
for (const t of tables) assert.ok(/\btabindex="0"/.test(t), `${t} is focusable`);
console.log(`documentation a11y: all ${tables.length} tables are focusable`);
