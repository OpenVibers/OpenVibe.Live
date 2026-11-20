'use strict';
/**
 * The first-paint subset of public/css/style.css.
 *
 * style.css holds every page's rules (~440 KB raw, ~97 KB brotli) and blocked the first paint of every route, while a
 * public page's first view uses about a sixth of it (CDP rule coverage over the public routes at phone and desktop
 * widths). On a public route the shell now links this subset as the blocking stylesheet, and the full style.css right
 * after it without blocking (media="print", flipped to all on load; a <noscript> copy). Both links sit where style.css
 * always sat, so once the full file has arrived the cascade is exactly what it was: the subset's rules come earlier and
 * are repeated, unchanged, by the full file. Only the moment before it arrives differs, and that moment is painted with
 * the rules the first view uses.
 *
 * Which rules: those whose selector list names a selector in public/css/critical-selectors.json (written by
 * scripts/perf/critical-css.js from coverage), the document-level rules (`:root`, `html`, `body`, `*`), each inside the
 * @media/@supports/@container blocks it came from, and the @keyframes the kept rules animate with. Built from the file
 * on disk and rebuilt when it changes; a rule added to style.css later simply arrives with the full file until the
 * selector list is regenerated.
 *
 *   parse(css)                 → nodes: { type: 'rule', selector, start, end, text } | { type: 'block', prelude, children, text }
 *                                | { type: 'raw', name, text } (@keyframes, @font-face, statements)
 *   splitSelectors(selector)   → the selector list, split on top-level commas (not inside :is()/:not()/[...])
 *   extract(css, selectors)    → the subset's CSS text
 *   core()                     → { css, hash, bytes, from } for the current style.css (cached by mtime)
 */
const fs = require('fs');
const path = require('path');

// The same public directory server/web/assets.js serves (OV_PUBLIC_DIR overrides it in tests).
const PUBLIC_DIR = path.resolve(process.env.OV_PUBLIC_DIR
    || (process.env.OV_APP_ROOT ? path.join(process.env.OV_APP_ROOT, 'public') : path.join(__dirname, '../../public')));
const STYLE = path.join(PUBLIC_DIR, 'css', 'style.css');
const SELECTORS = path.join(PUBLIC_DIR, 'css', 'critical-selectors.json');
// The home page's own stylesheet (features/home.css, ~100 KB raw, 24 KB brotli) was the last render-blocking file on
// the home, about 120-180 ms after style.core.css (lab, 11-20); what the first screen uses is about 15 KB of it. Its
// subset, measured on "/" alone (scripts/perf/critical-home-css.js: the rules styling what is on screen before any
// scroll, with and without JavaScript, at four widths), blocks there instead, and the full file follows without blocking.
const HOME = path.join(PUBLIC_DIR, 'css', 'features', 'home.css');
const HOME_SELECTORS = path.join(PUBLIC_DIR, 'css', 'critical-home.json');
// The home's effects layer (home-fx.css, 27 KB raw) also blocked the first paint, for the hero's buttons; real visitors'
// last blocking stylesheet arrived at 2.8 s (p75, desktop, 11-20). Its first-screen rules are measured the same way.
const HOME_FX = path.join(PUBLIC_DIR, 'css', 'home-fx.css');
const HOME_FX_SELECTORS = path.join(PUBLIC_DIR, 'css', 'critical-home-fx.json');
// Each generated subset: the URL it is served at, the file it comes from, its selector list, the full stylesheet's URL
// it stands in for, and the routes whose first view it was measured on (null: the shell decides, as for style.css).
const SUBSETS = {
    '/css/style.core.css': { source: STYLE, selectors: SELECTORS, full: '/css/style.css', routes: null },
    '/css/features/home.core.css': { source: HOME, selectors: HOME_SELECTORS, full: '/css/features/home.css', routes: /^\/$/ },
    '/css/home-fx.core.css': { source: HOME_FX, selectors: HOME_FX_SELECTORS, full: '/css/home-fx.css', routes: /^\/$/ },
};
/** The subset URL that stands in for a full stylesheet on a route, or null. */
function subsetFor(fullHref, urlPath) {
    for (const [url, s] of Object.entries(SUBSETS)) {
        if (s.full !== fullHref) continue;
        if (s.routes && !s.routes.test(String(urlPath || '/').split(/[?#]/)[0] || '/')) return null;
        return url;
    }
    return null;
}
const DOCUMENT_LEVEL = new Set([':root', 'html', 'body', '*', '*::before', '*::after', 'body::before', 'body::after']);
const NESTING = /^@(media|supports|container|layer)\b/i;

/** Skip a comment or string starting at i; returns the index after it, or i when there is none. */
function skip(css, i) {
    if (css[i] === '/' && css[i + 1] === '*') { const e = css.indexOf('*/', i + 2); return e === -1 ? css.length : e + 2; }
    if (css[i] === '"' || css[i] === "'") {
        const q = css[i];
        let j = i + 1;
        while (j < css.length && css[j] !== q) j += css[j] === '\\' ? 2 : 1;
        return j + 1;
    }
    return i;
}

/** The index just after the `}` that closes the block whose `{` is at open. */
function closeOf(css, open) {
    let depth = 0;
    for (let i = open; i < css.length;) {
        const n = skip(css, i);
        if (n !== i) { i = n; continue; }
        if (css[i] === '{') depth++;
        else if (css[i] === '}' && --depth === 0) return i + 1;
        i++;
    }
    return css.length;
}

function parse(css, from = 0, to = css.length) {
    const nodes = [];
    let i = from;
    while (i < to) {
        const n = skip(css, i);
        if (n !== i) { i = n; continue; }
        if (/\s/.test(css[i]) || css[i] === ';' || css[i] === '}') { i++; continue; }
        // A prelude runs to the first `{` or `;` outside strings and comments.
        const start = i;
        let j = i;
        while (j < to && css[j] !== '{' && css[j] !== ';') { const k = skip(css, j); j = k !== j ? k : j + 1; }
        const prelude = css.slice(start, j).replace(/\/\*[\s\S]*?\*\//g, '').trim();
        if (j >= to || css[j] === ';') { nodes.push({ type: 'raw', name: prelude.split(/\s/)[0], text: css.slice(start, Math.min(j + 1, to)) }); i = j + 1; continue; }
        const end = closeOf(css, j);
        if (prelude.startsWith('@')) {
            if (NESTING.test(prelude)) nodes.push({ type: 'block', prelude, start, end, children: parse(css, j + 1, end - 1), text: css.slice(start, end) });
            else nodes.push({ type: 'raw', name: prelude.split(/\s/)[0].toLowerCase(), prelude, start, end, text: css.slice(start, end) });
        } else {
            nodes.push({ type: 'rule', selector: prelude, start, end, text: css.slice(start, end) });
        }
        i = end;
    }
    return nodes;
}

/** "a, b:is(c, d), [x=','] e" → ['a', 'b:is(c, d)', "[x=','] e"], each with its whitespace collapsed. */
function splitSelectors(selector) {
    const out = [];
    let depth = 0, cur = '', q = null;
    for (const ch of String(selector)) {
        if (q) { cur += ch; if (ch === q) q = null; continue; }
        if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth--;
        if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
        cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function keepRule(node, wanted) {
    return splitSelectors(node.selector).some((s) => wanted.has(s) || DOCUMENT_LEVEL.has(s));
}

function pick(nodes, wanted) {
    const out = [];
    for (const node of nodes) {
        if (node.type === 'rule') { if (keepRule(node, wanted)) out.push(node.text.trim()); continue; }
        if (node.type === 'block') {
            const inner = pick(node.children, wanted);
            if (inner.length) out.push(`${node.prelude} {\n${inner.join('\n')}\n}`);
        }
    }
    return out;
}

function extract(css, selectors, from = 'style.css') {
    const wanted = selectors instanceof Set ? selectors : new Set(selectors);
    const nodes = parse(css);
    const kept = pick(nodes, wanted);
    const body = kept.join('\n');
    // The @keyframes (and @font-face) the kept rules use; nothing else that is raw.
    const raws = [];
    const walk = (list) => {
        for (const node of list) {
            if (node.type === 'block') walk(node.children);
            if (node.type !== 'raw') continue;
            if (node.name === '@font-face') raws.push(node.text.trim());
            if (/^@(-webkit-)?keyframes$/.test(node.name)) {
                const name = (node.prelude || '').split(/\s+/)[1];
                if (name && new RegExp(`(^|[\\s,:])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s,;!]|$)`, 'm').test(body)) raws.push(node.text.trim());
            }
        }
    };
    walk(nodes);
    return `/* Generated by server/web/critical-css.js from ${from}: the rules a public page's first view uses. */\n${body}\n${raws.join('\n')}\n`;
}

const _cache = new Map();   // subset URL -> { key, css, hash, bytes, from }
/** A subset for its source file on disk, rebuilt when the file or its selector list changes; null when it has none. */
function subset(url) {
    const def = SUBSETS[url];
    if (!def) return null;
    let st, sel;
    try { st = fs.statSync(def.source); sel = fs.statSync(def.selectors); } catch { return null; }
    const key = `${st.mtimeMs}:${st.size}:${sel.mtimeMs}:${sel.size}`;
    const hit = _cache.get(url);
    if (hit && hit.key === key) return hit;
    let selectors = [];
    try { selectors = JSON.parse(fs.readFileSync(def.selectors, 'utf8')).selectors || []; } catch { selectors = []; }
    if (!selectors.length) return null;
    const css = extract(fs.readFileSync(def.source, 'utf8'), selectors, path.relative(path.join(PUBLIC_DIR, 'css'), def.source));
    const made = { key, css, hash: require('crypto').createHash('sha256').update(css).digest('hex').slice(0, 12), bytes: Buffer.byteLength(css), from: st.size };
    _cache.set(url, made);
    return made;
}
/** The subset for the style.css on disk, rebuilt when it or the selector list changes. */
function core() {
    return subset('/css/style.core.css');
}

module.exports = { parse, splitSelectors, extract, core, subset, subsetFor, SUBSETS, STYLE, SELECTORS, HOME, HOME_SELECTORS, HOME_FX, HOME_FX_SELECTORS, DOCUMENT_LEVEL };
