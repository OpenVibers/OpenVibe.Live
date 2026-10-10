/**
 * The openvibe-shared and openvibe-contracts pins carry everything Live takes from them. A major bump
 * (openvibe-shared 1.30.1 -> 2.3.1 removed exports and a module alias) must fail here, not on the host:
 *   - node_modules holds exactly the release package.json and package-lock.json pin (a stale install or a
 *     lockfile left behind by a package.json edit is caught before a deploy reinstalls from the lockfile);
 *   - every openvibe-shared / openvibe-contracts module server/ and scripts/ require resolves, and every
 *     name they destructure from it exists;
 *   - every /shared/<file> that public/ or server/ references is a browser file the pinned package serves.
 *
 *   node test/shared-pins.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PACKAGES = ['openvibe-shared', 'openvibe-contracts'];

let failures = 0;
function check(name, fn) {
    try { fn(); console.log('  ✓', name); }
    catch (e) { failures++; console.log('  ✗', name, '\n     ', e.message); }
}

function walk(dir, exts, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, exts, out);
        else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
    }
    return out;
}
const rel = (p) => path.relative(ROOT, p);

console.log('Shared pins');

check('node_modules holds the release package.json and package-lock.json pin', () => {
    const pkg = require('../package.json');
    const lock = require('../package-lock.json');
    for (const name of PACKAGES) {
        const spec = pkg.dependencies[name];
        const tag = /\/tags\/v(\d+\.\d+\.\d+)$/.exec(spec || '');
        assert.ok(tag, `${name} is pinned to a release tag in package.json (${spec})`);
        assert.strictEqual(lock.packages[''].dependencies[name], spec, `package-lock.json's root ${name} is package.json's`);
        const locked = lock.packages[`node_modules/${name}`];
        assert.strictEqual(locked && locked.version, tag[1], `package-lock.json locks ${name} ${tag[1]}`);
        assert.strictEqual(locked.resolved, spec, `package-lock.json resolves ${name} from package.json's URL`);
        const installed = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version;
        assert.strictEqual(installed, tag[1], `node_modules/${name} is ${tag[1]} (npm ci)`);
    }
});

// require('openvibe-x[/sub]'), optionally destructured: const { a, b: c } = require('openvibe-x/sub')
const REQUIRE_RE = /(?:const\s*\{([^}]*)\}\s*=\s*)?require\(\s*'((?:openvibe-shared|openvibe-contracts)(?:\/[^']*)?)'\s*\)(?:\.([A-Za-z_$][\w$]*))?/g;
const uses = new Map();   // module -> Map(name -> [files])
for (const file of walk(path.join(ROOT, 'server'), ['.js']).concat(walk(path.join(ROOT, 'scripts'), ['.js']))) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(REQUIRE_RE)) {
        if (!uses.has(m[2])) uses.set(m[2], new Map());
        const names = (m[1] ? m[1].split(',').map((s) => s.split(':')[0].trim()) : []).concat(m[3] ? [m[3]] : []).filter(Boolean);
        for (const n of names.length ? names : ['']) {
            const at = uses.get(m[2]);
            if (!at.has(n)) at.set(n, []);
            at.get(n).push(rel(file));
        }
    }
}

check('server/ and scripts/ take something from both packages (the scan sees the requires)', () => {
    for (const name of PACKAGES) assert.ok([...uses.keys()].some((m) => m === name || m.startsWith(`${name}/`)), `no require of ${name} found`);
});

// Requiring a module runs it; a CLI entry point would be resolved only (none is used since openvibe-shared 3.0.0
// removed analytics/prune-cli).
const RESOLVE_ONLY = new Set();
for (const [mod, names] of [...uses].sort(([a], [b]) => a.localeCompare(b))) {
    check(`${mod} resolves${names.size > 1 || !names.has('') ? ` and exports ${[...names.keys()].filter(Boolean).join(', ')}` : ''}`, () => {
        const where = [...new Set([...names.values()].flat())].join(', ');
        let resolved;
        try { resolved = require.resolve(mod); } catch (e) { throw new Error(`${mod} does not resolve (required by ${where}): ${e.message}`); }
        if (RESOLVE_ONLY.has(mod)) return;
        const exp = require(resolved);
        for (const [n, files] of names) {
            if (n) assert.ok(exp[n] !== undefined, `${mod} has no export ${n} (used by ${files.join(', ')})`);
        }
    });
}

check('every /shared/<file> public/ and server/ reference is a browser file the pinned openvibe-shared serves', () => {
    const files = require('openvibe-shared/files');
    const missing = [];
    const sources = walk(path.join(ROOT, 'public'), ['.js', '.html', '.css']).concat(walk(path.join(ROOT, 'server'), ['.js', '.html']));
    let seen = 0;
    for (const file of sources) {
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(/\/shared\/([A-Za-z0-9._-]+\.(?:js|css))\b/g)) {
            seen++;
            const name = m[1];
            if (!files.isBrowserFile(name) || !fs.existsSync(path.join(files.dir, name))) missing.push(`${name} (${rel(file)})`);
        }
    }
    assert.ok(seen > 0, 'no /shared/ references found');
    assert.deepStrictEqual([...new Set(missing)], [], 'referenced but not served by openvibe-shared');
});

console.log(failures ? `\n${failures} check(s) failed` : '\nshared pins: all checks passed');
process.exit(failures ? 1 : 0);
