'use strict';
// The players' libraries come from Live itself, one version each (2026-11-18): hls.js and flv.js were fetched from
// cdn.jsdelivr.net as @latest, so every viewer ran whatever was published last (the unminified build) from a third
// party. No page script names a CDN for them again; every /js/vendor/ path a script names is here; the files are the
// npm releases' own bytes (a changed file fails here); the server serves the folder as immutable.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'public', 'js');
const PINNED = {
    'hls-1.7.4.min.js': 'cfc70cc9e9fc63d071919e087670abc760c8fd1bc889b88588026e4d22193bbe',   // npm hls.js@1.7.4 dist/hls.min.js
    'flv-1.6.2.min.js': '733b9b325dbc59871a652c0a84f2f285a2cfd06cf2efcedcd87cb1e194cd1e8f',   // npm flv.js@1.6.2 dist/flv.min.js
};
const scripts = fs.readdirSync(JS).filter((f) => f.endsWith('.js'));
const named = new Set();
for (const f of scripts) {
    const src = fs.readFileSync(path.join(JS, f), 'utf8');
    assert.ok(!/(cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com)\/[^'"`]*\b(hls|flv)\.js/.test(src), `${f} loads a player library from a CDN`);
    for (const m of src.matchAll(/['"`]\/js\/vendor\/([^'"`?]+)['"`]/g)) named.add(m[1]);
}
assert.ok(named.size >= 2, `the players name their vendored files (${[...named]})`);
for (const f of named) assert.ok(fs.existsSync(path.join(JS, 'vendor', f)), `/js/vendor/${f} is here`);
for (const [f, sha] of Object.entries(PINNED)) {
    const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(JS, 'vendor', f))).digest('hex');
    assert.strictEqual(got, sha, `${f} is the release's own bytes`);
}
const server = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
assert.match(server, /app\.use\('\/js\/vendor', express\.static\([^)]*'vendor'\)[\s\S]{0,200}immutable: true/, 'the folder is served immutable');
assert.ok(server.indexOf("app.use('/js/vendor'") < server.indexOf("app.use('/js', assets.versionedStatic"), 'before the /js mount');
console.log('vendor-players: hls.js and flv.js from Live, pinned and checked, served immutable');
