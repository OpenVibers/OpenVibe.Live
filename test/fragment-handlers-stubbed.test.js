'use strict';
// Every function a feature's fragment calls from an inline handler (onclick="name(…)") that only the feature's own
// scripts define is one of its stubs (features.json), so a click before those scripts arrive loads the feature and runs
// it instead of throwing "name is not defined" (RUM 11-28: wsFirstAppStream on the broadcast page; 67 such handlers
// across six features had no stub). AGENTS.md, "Inline handlers on lazy features".
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const pub = path.join(root, 'public');
const reg = JSON.parse(fs.readFileSync(path.join(pub, 'features.json'), 'utf8'));
const read = (rel) => { try { return fs.readFileSync(path.join(pub, rel.replace(/^\//, '')), 'utf8'); } catch { return ''; } };
const defines = (src, name) => new RegExp(`(?:function\\s+${name}\\s*\\(|(?:window|globalThis)\\.${name}\\s*=|(?:^|[^.\\w])${name}\\s*=\\s*(?:async\\s*)?(?:function|\\())`, 'm').test(src);
// Core: the scripts index.html loads on every page.
const index = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const coreSrc = [...index.matchAll(/<script[^>]+src="(\/js\/[^"?]+)/g)].map((m) => read(m[1])).join('\n');
const out = {};
for (const [name, f] of Object.entries(reg.features || {})) {
    if (!f.fragment) continue;
    const html = read(`fragments/${f.fragment}.html`) || read(`fragments/${f.fragment}`);
    if (!html) continue;
    const calls = new Set([...html.matchAll(/\son[a-z]+="(?:[^"]*?[;\s(!])?([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1]).filter((n) => !/^(if|return|event|this|window|document|location|history|console|alert|setTimeout|encodeURIComponent)$/.test(n)));
    const own = (Array.isArray(f.js) ? f.js : []).map(read).join('\n');
    const stubs = new Set(f.stubs || []);
    const missing = [...calls].filter((n) => !defines(coreSrc, n) && defines(own, n) && !stubs.has(n)).sort();
    if (missing.length) out[name] = missing;
}
assert.deepStrictEqual(out, {}, `inline handlers with no stub (add them to the feature's stubs in public/features.json): ${JSON.stringify(out)}`);
console.log('fragment-handlers-stubbed: every inline handler a lazy feature defines is a stub');
