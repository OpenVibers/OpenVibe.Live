'use strict';
/**
 * openvibe-shared's ov-glyphs.js (loaded by the shared navbar on every page that uses Font Awesome) draws each icon as
 * <i class="fa-solid fa-… ovg"><svg>…</svg></i>. A rule of Live's own on the bare class .ovg styles every one of those
 * icons too: the go-live guide's root was .ovg { position: fixed; inset: 0; display: none }, so once its stylesheet
 * loaded (a couple of seconds in, for signed-in streamers) every icon vanished and the rest were pinned to the
 * top-left corner (the owner, 2026-11-01: "broken icons… the play button in the top left… cubes"). Live's own classes
 * may start with "ovg-" (the guide's .ovg-quest, .ovg-root …) but never be exactly "ovg".
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');
const files = [];
(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); } else if (/\.(css|js|html)$/.test(e.name)) files.push(p);
    }
})(ROOT);

const BARE_SELECTOR = /(^|[\s,}>~+(])\.ovg(?![\w-])/;            // .ovg as a whole class in a selector
const BARE_CLASS = /(class(Name)?\s*=\s*['"]|classList\.(add|toggle|contains)\(\s*['"])ovg(?=['"\s])/;   // class="ovg …", className = 'ovg'
const offenders = [];
for (const f of files) {
    const text = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    text.split('\n').forEach((line, i) => {
        if (BARE_SELECTOR.test(line) || BARE_CLASS.test(line)) offenders.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
}
assert.deepStrictEqual(offenders, [], `the class "ovg" belongs to the shared glyph icons; use .ovg-root or another ovg-… name:\n${offenders.join('\n')}`);
console.log(`  ✓ no rule or element of Live's own uses the glyph icons' class "ovg" (${files.length} files)`);
