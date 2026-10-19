/**
 * Every stylesheet Live serves parses as CSS (PostCSS, which sanitize-html already brings in). A stray `}` is not
 * harmless: in a browser it turns the next rule's selector into garbage, so that rule is dropped without a word
 * (style.css had an orphaned keyframe step that did exactly this, and home.css a trailing brace, until 2026-10-16).
 *
 *   node test/css-syntax.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const postcss = require('postcss');

const root = path.join(__dirname, '..', 'public');
const files = [];
(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'vendor') walk(f); continue; }
        if (e.name.endsWith('.css') && !e.name.endsWith('.min.css')) files.push(f);
    }
})(root);
assert.ok(files.length >= 10, `found the stylesheets (${files.length})`);
const errors = [];
for (const f of files) {
    try { postcss.parse(fs.readFileSync(f, 'utf8'), { from: f }); } catch (e) { errors.push(`${path.relative(root, f)}:${e.line}:${e.column} ${e.reason}`); }
}
assert.deepStrictEqual(errors, [], 'stylesheets with syntax errors');
console.log(`css syntax: ${files.length} stylesheets parse`);
