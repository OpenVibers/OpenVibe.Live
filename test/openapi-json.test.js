'use strict';
// SEO-3: /openapi.json answered 404 here (11-03). It is the contracts' OpenAPI 3.1 document for this service
// (openvibe-contracts), without the operations they mark internal-only.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const doc = require('openvibe-contracts').openapi.document('live');
assert.ok(doc && doc.openapi && /^3\.1/.test(doc.openapi), 'the contracts carry an OpenAPI 3.1 document for live');
const src = fs.readFileSync(path.join(__dirname, '..', 'server/index.js'), 'utf8');
assert.match(src, /app\.get\('\/openapi\.json'/, 'the route is mounted');
assert.match(src, /openapi\.document\('live'\)/);
assert.match(src, /vis\.every\(\(v\) => v === 'internal'\)\) continue;/, 'internal-only operations are left out');
console.log('openapi.json: ok');
