'use strict';
// /shared/<file> serves every file openvibe-shared lists for sites, each with its own Content-Type
// (server/web/shared-files.js). Until 2026-11-05 Live served only scripts and fonts: the navbar's ov-forms.css
// answered 404 text/plain on six pages and the browser refused it (phone sweep 11-05).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const files = require('openvibe-shared/files');
const shared = require('../server/web/shared-files');

// 1. Each kind the package lists gets its type.
assert.strictEqual(shared.typeOf('navbar.js'), 'application/javascript; charset=utf-8');
if ((files.STYLES || []).includes('ov-forms.css')) assert.strictEqual(shared.typeOf('ov-forms.css'), 'text/css; charset=utf-8', 'the navbar links ov-forms.css');
for (const name of files.STYLES || []) assert.strictEqual(shared.typeOf(name), 'text/css; charset=utf-8', `${name} is a stylesheet`);
for (const name of files.FONTS || []) assert.strictEqual(shared.typeOf(name), 'font/woff2', `${name} is a font`);
for (const name of files.IMAGES || []) assert.strictEqual(shared.typeOf(name), 'image/svg+xml', `${name} is an image`);

// 2. Anything else is not served: the package's own code, a path, an unknown name.
for (const name of ['package.json', 'files.js', '../server/index.js', 'nope.css', '']) assert.strictEqual(shared.typeOf(name), null, `${name || '(empty)'} is not served`);

// 3. Every listed file exists in the package (a missing one would answer 503, never a cacheable 404).
for (const name of shared.names()) assert.ok(fs.existsSync(path.join(shared.dir, name)), `${name} is in openvibe-shared`);

// 4. The route uses this list, not a list of its own.
const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
assert.ok(src.includes("require('./web/shared-files')") && src.includes('sharedFiles.typeOf(fileName)'), 'the /shared route asks shared-files.js');
assert.ok(!src.includes('sharedFileSet'), 'no second list in index.js');

console.log(`shared files: ${shared.names().length} files served with their own types`);
