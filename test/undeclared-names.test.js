'use strict';
// No browser script of Live's uses a name that nothing declares (11-28, from Live's real-user errors and a scan: the
// agent stream's chat-plays controls used publicId, which only the page loader had; the dashboard still asked for the
// stream controls that moved to OpenVibe.Bot; the 18+ paste gate's Continue called renderPasteView, which never
// existed; a modal entry named redeemRewardModal, which nothing defines). Classic scripts share one global scope, so
// every top-level name any Live or openvibe-shared script declares (and every window.X = …) counts as declared; a name
// read only behind a typeof check is allowed; the rest must be one of Chrome's globals or a vendor library below.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const ROOT = path.join(__dirname, '..');
// Libraries the pages load by script tag, and a browser API missing from a blank page's globals.
const VENDOR = ['Hls', 'flvjs', 'JSMpeg', 'html2canvas', 'Chart', 'ImageCapture'];
const GLOBALS = new Set(require('./fixtures/browser-globals.json').names.concat(VENDOR, ['undefined', 'NaN', 'Infinity', 'globalThis', 'module', 'exports', 'require', 'process', 'define']));
const jsDir = path.join(ROOT, 'public', 'js');
const sharedDir = path.join(ROOT, 'node_modules', 'openvibe-shared');
const files = fs.readdirSync(jsDir).filter((f) => f.endsWith('.js') && !f.endsWith('.min.js')).map((f) => path.join(jsDir, f));
const shared = fs.existsSync(sharedDir) ? fs.readdirSync(sharedDir).filter((f) => f.endsWith('.js')).map((f) => path.join(sharedDir, f)) : [];
for (const f of files.concat(shared)) {
    let ast;
    try { ast = acorn.parse(fs.readFileSync(f, 'utf8'), { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true }); } catch { continue; }
    for (const n of ast.body) {
        if ((n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') && n.id) GLOBALS.add(n.id.name);
        if (n.type === 'VariableDeclaration') n.declarations.forEach((d) => d.id.type === 'Identifier' && GLOBALS.add(d.id.name));
    }
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\b(?:window|globalThis|self|root|G|global)\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) GLOBALS.add(m[1]);
    for (const m of src.matchAll(/\b(?:window|globalThis|root)\[['"]([A-Za-z_$][\w$]*)['"]\]\s*=(?!=)/g)) GLOBALS.add(m[1]);
}
const want = (name) => !GLOBALS.has(name);
function declaredIn(pattern, out) {
    if (!pattern) return;
    switch (pattern.type) {
        case 'Identifier': out.add(pattern.name); break;
        case 'ObjectPattern': pattern.properties.forEach((p) => declaredIn(p.type === 'RestElement' ? p.argument : p.value, out)); break;
        case 'ArrayPattern': pattern.elements.forEach((e) => declaredIn(e, out)); break;
        case 'AssignmentPattern': declaredIn(pattern.left, out); break;
        case 'RestElement': declaredIn(pattern.argument, out); break;
        default: break;
    }
}
// Hoisting: collect every name a function (or the program) declares anywhere in its body, not inside nested functions.
function hoisted(body, out, blockOnlyTop) {
    const visit = (n, top) => {
        if (!n || typeof n.type !== 'string') return;
        if (n.type === 'FunctionDeclaration') { if (n.id) out.add(n.id.name); return; }
        if (/Function/.test(n.type) || n.type === 'ClassExpression') return;
        if (n.type === 'VariableDeclaration') n.declarations.forEach((d) => declaredIn(d.id, out));
        if (n.type === 'ClassDeclaration' && n.id) out.add(n.id.name);
        if (n.type === 'ImportDeclaration') n.specifiers.forEach((s) => out.add(s.local.name));
        for (const k of Object.keys(n)) {
            if (k === 'type' || k === 'start' || k === 'end') continue;
            const v = n[k];
            if (Array.isArray(v)) v.forEach((c) => visit(c, false)); else if (v && typeof v.type === 'string') visit(v, false);
        }
    };
    (Array.isArray(body) ? body : [body]).forEach((n) => visit(n, true));
    return out;
}
function check(file, acorn, want) {
    const src = fs.readFileSync(file, 'utf8');
    const guarded = new Set([...src.matchAll(/typeof\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
    let ast;
    try { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true }); } catch (e) { return [`${file}: parse error ${e.message}`]; }
    const hits = [];
    const walk = (n, scopes, parent, key) => {
        if (!n || typeof n.type !== 'string') return;
        let inner = scopes;
        if (/Function/.test(n.type)) {
            const s = new Set();
            if (n.id && n.type !== 'FunctionDeclaration') s.add(n.id.name);
            n.params.forEach((p) => declaredIn(p, s));
            if (n.body && n.body.type === 'BlockStatement') hoisted(n.body.body, s);
            s.add('arguments');
            inner = scopes.concat([s]);
        } else if (n.type === 'CatchClause' && n.param) {
            const s = new Set(); declaredIn(n.param, s); inner = scopes.concat([s]);
        } else if (n.type === 'ClassExpression' && n.id) {
            inner = scopes.concat([new Set([n.id.name])]);
        }
        if (n.type === 'Identifier' && want(n.name) && !guarded.has(n.name)) {
            const isProp = parent && ((parent.type === 'MemberExpression' && key === 'property' && !parent.computed) || (parent.type === 'Property' && key === 'key' && !parent.computed && !parent.shorthand) || (parent.type === 'MethodDefinition' && key === 'key') || (parent.type === 'PropertyDefinition' && key === 'key'));
            const isLabel = parent && /Label|Break|Continue/.test(parent.type);
            if (!isProp && !isLabel && !inner.some((s) => s.has(n.name))) {
                const line = src.slice(0, n.start).split('\n').length;
                hits.push(`${file}:${line}: ${n.name}: ${src.split('\n')[line - 1].trim().slice(0, 120)}`);
            }
        }
        for (const k of Object.keys(n)) {
            if (k === 'type' || k === 'start' || k === 'end') continue;
            const v = n[k];
            if (Array.isArray(v)) v.forEach((c) => walk(c, inner, n, k)); else if (v && typeof v.type === 'string') walk(v, inner, n, k);
        }
    };
    const top = hoisted(ast.body, new Set());
    walk(ast, [top], null, null);
    return hits;
}
assert.ok(files.length > 50, `Live's scripts are found (${files.length})`);
const found = [...new Set(files.flatMap((f) => check(f, acorn, want)))].map((h) => h.replace(ROOT + path.sep, ''));
assert.deepStrictEqual(found, [], `names nothing declares:\n${found.join('\n')}`);
console.log(`undeclared-names: ${files.length} scripts use no undeclared name`);
