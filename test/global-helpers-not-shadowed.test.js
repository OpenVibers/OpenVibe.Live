'use strict';
// A page script must never declare a local with the name of a global helper it also calls: the local wins in the whole
// function, so the helper call throws. 11-19 (Live #996): loadChannelPage's \`const channelPath = '/streams/…'\` made
// every live channel stop at "TypeError: d is not a function" before its player started, for about 19 hours.
//
// For each helper app.js defines at top level, no function in public/js that calls it may also declare it with
// const/let/var or as a parameter.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const JS = path.join(__dirname, '..', 'public', 'js');
const HELPERS = ['channelPath', 'navigate', 'api', 'esc', 'toast', 'escapeHtml', 'formatNumber', 'timeAgo'];
const app = fs.readFileSync(path.join(JS, 'app.js'), 'utf8');
const defined = HELPERS.filter((h) => new RegExp(`^(?:async\\s+)?function\\s+${h}\\s*\\(`, 'm').test(app));
assert.ok(defined.includes('channelPath'), 'app.js defines channelPath()');

/** Each top-level-ish function body in a file: from "function name(" or "name = async (" to its matching brace. */
function bodies(src) {
    const out = [];
    const re = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g;
    let m;
    while ((m = re.exec(src))) {
        let depth = 0, i = re.lastIndex - 1;
        for (; i < src.length; i++) {
            const c = src[i];
            if (c === '{') depth++;
            else if (c === '}' && --depth === 0) break;
        }
        out.push({ name: m[1], params: m[2], body: src.slice(re.lastIndex, i) });
    }
    return out;
}

let checked = 0;
const found = [];
for (const file of fs.readdirSync(JS).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(JS, file), 'utf8');
    for (const fn of bodies(src)) {
        for (const h of defined) {
            if (fn.name === h) continue;
            const calls = new RegExp(`(^|[^.\\w$])${h}\\s*\\(`).test(fn.body);
            if (!calls) continue;
            checked++;
            const declares = new RegExp(`\\b(?:const|let|var)\\s+${h}\\b`).test(fn.body)
                || new RegExp(`(^|[,\\s(])${h}\\s*(=|,|$)`).test(fn.params);
            if (declares) found.push(`${file}: ${fn.name}() calls ${h}() and declares its own ${h}`);
        }
    }
}
assert.deepStrictEqual(found, [], `a local shadows a global helper it calls:\n${found.join('\n')}`);
console.log(`  ✓ no page function shadows a global helper it calls (${checked} calls in ${defined.length} helpers checked)`);
