/**
 * Duplicate attributes on one element.
 *
 * An HTML parser keeps the first occurrence of an attribute and silently drops the rest, so
 * `<div style="--sc:#fff" style="display:none">` renders visible. This has shipped three times on
 * the home page — the changelog header lost its margin, and the canvas and leaderboard headers lost
 * `display:none` and showed as titles over empty sections whenever their loaders failed. Nothing in
 * a browser reports it, so it is checked here.
 *
 *   node test/html-attributes.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const files = fs.readdirSync(PUBLIC).filter(f => f.endsWith('.html'));
let problems = [];

for (const f of files) {
    const src = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
    // Strip comments, scripts and styles so their contents are not read as tags.
    const clean = src
        .replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '))
        .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, m => m.replace(/[^\n]/g, ' '));
    const tagRe = /<([a-zA-Z][\w-]*)(\s[^<>]*?)?\/?>/g;
    let m;
    while ((m = tagRe.exec(clean))) {
        const attrs = m[2] || '';
        // Remove quoted values before collecting names, so "a=b" inside a value is not a name.
        const bare = attrs.replace(/"[^"]*"|'[^']*'/g, '""');
        const names = [...bare.matchAll(/([^\s"'=<>\/]+)\s*(?==|\s|$)/g)].map(x => x[1].toLowerCase());
        const seen = new Set();
        for (const n of names) {
            if (seen.has(n)) {
                const line = clean.slice(0, m.index).split('\n').length;
                problems.push(`${f}:${line} <${m[1]}> has "${n}" twice`);
                break;
            }
            seen.add(n);
        }
    }
}

assert.deepStrictEqual(problems, [], 'duplicate attributes found:\n  ' + problems.join('\n  '));
console.log(`  ok - no duplicate attributes across ${files.length} HTML files`);
