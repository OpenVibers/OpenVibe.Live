'use strict';

// Compatibility register C-75: Media retires its predecessor-shaped public routes (the /v/<file name>
// fallback, /api/thumbnails/<name> and /f/screenshots/<name>). Live builds none of them any more: players
// ask for a recording by id (/api/vods/:id/file, /api/clips/:id/file → Media /v/:id, /c/:id), a thumbnail
// by id resolves through Media's API, and avatars and screenshots are object URLs (/o/<id>). This fails
// on any file under server/, public/js/ or scripts/ that builds one of the retired forms again.
//
//   node test/media-legacy-urls.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RETIRED = [
    [/\/api\/vods\/file\//, 'a recording by file name (/api/vods/file/<name> → Media /v/<name>)'],
    [/\/f\/screenshots\//, 'a screenshot by file name (Media /f/screenshots/<name>)'],
    [/\/data\/pastes\/screenshots\//, 'a pre-Media screenshot path (/data/pastes/screenshots/<name>)'],
    [/publicUrl\(\s*`\/api\/thumbnails\//, "Media's legacy /api/thumbnails/<name> route"],
];

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'vendor') walk(p, out); } else if (/\.(js|html)$/.test(e.name)) out.push(p);
    }
    return out;
}

const files = ['server', 'public/js', 'public/fragments', 'scripts']
    .map((d) => path.join(ROOT, d)).filter((d) => fs.existsSync(d)).flatMap((d) => walk(d));
assert.ok(files.length > 100, `scanned ${files.length} files`);

const found = [];
for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
        for (const [re, what] of RETIRED) if (re.test(line)) found.push(`${path.relative(ROOT, file)}:${i + 1} builds ${what}`);
    });
}
assert.deepStrictEqual(found, [], `retired Media URL forms are back:\n  ${found.join('\n  ')}`);

const client = require('../server/media-client');
assert.strictEqual(client.screenshotUrl, undefined, 'media-client has no file-name screenshot URL builder');
console.log(`  ✓ no retired Media URL form in ${files.length} files`);
