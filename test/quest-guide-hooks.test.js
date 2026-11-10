'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../public/js/guides-live'), 'utf8');
assert.match(source, /data-ov-guide="live\.setup\.\$\{esc\(next\.id\)\}"/);
assert.match(source, /data-ov-guide="live\.setup\.\$\{esc\(t\.id\)\}"/);
process.stdout.write('Live setup controls expose quest guide hooks\n');
