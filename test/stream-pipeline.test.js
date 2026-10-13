'use strict';
// A file or an upstream body sent to a response goes through stream.pipeline, never .pipe(res): when the viewer leaves,
// the response is destroyed and .pipe() does not destroy its source, so the file stayed open for the life of the process
// (36 deleted live thumbnails still open after 12 h, 2026-10-13) and a proxied body kept downloading into nothing.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server');
const files = [];
(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) files.push(p);
    }
})(SERVER);

const offenders = [];
for (const f of files) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        if (/createReadStream\([^)]*\)\s*\.pipe\(/.test(line) || /fromWeb\([^)]*\)\s*\.pipe\(/.test(line)) offenders.push(`${path.relative(SERVER, f)}:${i + 1}`);
    });
}
assert.deepStrictEqual(offenders, [], `use stream.pipeline(source, res, cb): ${offenders.join(', ')}`);

const thumbs = fs.readFileSync(path.join(SERVER, 'media-proxy', 'thumbnails.js'), 'utf8');
assert.strictEqual((thumbs.match(/pipeline\(fs\.createReadStream\(/g) || []).length, 2, 'both live-thumbnail responses use pipeline');
console.log(`stream-pipeline: ${files.length} server files checked`);
