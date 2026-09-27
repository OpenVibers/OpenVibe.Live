'use strict';
// Live's release components (server/web/release-components.js; Host docs/release-acceptance.md gate 1e): a
// stylesheet-only release changes only `styles` (kind style: open tabs swap it in place, nothing reloads), a script
// or page change changes `shell` (prompted), server code only `server`; the real tree lists every stylesheet.
//   node test/release-components.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRelease } = require('openvibe-shared/release');
const { componentsFor, stylesheets } = require('../server/web/release-components');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-live-rel-'));
const put = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
put('public/css/style.css', 'body{color:red}');
put('public/css/features/chat.css', '.c{}');
put('public/js/app.js', 'console.log(1)');
put('public/index.html', '<html></html>');
put('server/index.js', 'module.exports=1');
put('server/web/assets.js', 'module.exports=2');
put('package-lock.json', '{}');
try {
    const rel = createRelease({ service: 'live', root, env: { RELEASE_COMMIT: 'abcdef1' }, components: componentsFor(root), recheckMs: 0 });
    const v = () => { const m = rel.refresh ? rel.refresh() : rel.full(); const c = (m && m.components) || rel.full().components; return { styles: c.styles.version, shell: c.shell.version, server: c.server.version, kinds: [c.styles.kind, c.shell.kind, c.server.kind] }; };
    const a = v();
    assert.deepStrictEqual(a.kinds, ['style', 'script', 'server']);
    put('public/css/style.css', 'body{color:blue}');
    const b = v();
    assert.deepStrictEqual([b.styles !== a.styles, b.shell === a.shell, b.server === a.server], [true, true, true], 'a stylesheet changes styles only');
    put('public/js/app.js', 'console.log(2)');
    const c = v();
    assert.deepStrictEqual([c.shell !== b.shell, c.styles === b.styles], [true, true], 'a script changes the shell');
    put('server/index.js', 'module.exports=3');
    const d = v();
    assert.deepStrictEqual([d.server !== c.server, d.shell === c.shell, d.styles === c.styles], [true, true, true], 'server-only code changes server only');
    put('server/web/assets.js', 'module.exports=4');
    assert.notStrictEqual(v().shell, d.shell, 'the page-stamping server code is shell');
    // The real tree: every stylesheet, and the files named exist.
    const real = componentsFor(path.join(__dirname, '..'));
    assert.ok(real.styles.assets.includes('/css/style.css') && real.styles.assets.length === stylesheets(path.join(__dirname, '..')).length && real.styles.assets.length >= 20, `${real.styles.assets.length} stylesheets`);
    assert.ok(real.shell.files.includes('public/js') && real.shell.files.includes('server/web'));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log('release components: all checks passed');
