'use strict';
// Live's styles name only colour variables its themes define. Eleven names (--text, --surface, --primary, …) were
// used across the CSS and two scripts while no theme set them, so the browser fell back to a dark-theme literal
// (light grey text and near-black cards on Daylight) or, with no fallback, dropped the declaration (see-through
// studio panels, no hover). They now point at the theme tokens (--text-primary, --bg-card, --accent, …).
//   node test/theme-tokens-defined.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'public');
function walk(dir, ext) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
        const p = path.join(dir, d.name);
        return d.isDirectory() ? walk(p, ext) : (p.endsWith(ext) ? [p] : []);
    });
}
const files = [...walk(path.join(root, 'css'), '.css'), ...walk(path.join(root, 'js'), '.js')];
const UNDEFINED = ['text', 'primary', 'surface', 'surface-raised', 'bg', 'bg-elevated', 'card-bg', 'bg-main', 'bg-active',
    'border-color', 'accent-hover'];
const use = new RegExp(`var\\(--(${UNDEFINED.map((n) => n.replace(/-/g, '\\-')).join('|')})(?![\\w-])`);

// No theme defines them (so the test is about the SPA, not the standalone pages that define their own).
const style = fs.readFileSync(path.join(root, 'css', 'style.css'), 'utf8');
for (const n of UNDEFINED) assert.ok(!new RegExp(`(^|[\\s;{])--${n}\\s*:`, 'm').test(style), `style.css defines --${n}: drop it from this list`);

const hits = [];
for (const f of files) {
    const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    src.split('\n').forEach((line, i) => { if (use.test(line)) hits.push(`${path.relative(root, f)}:${i + 1}  ${line.trim().slice(0, 100)}`); });
}
assert.deepStrictEqual(hits, [], 'a style names a colour variable no theme defines:\n' + hits.join('\n'));

// The two scripts that paint their own boxes use the theme's card colour.
const uploads = fs.readFileSync(path.join(root, 'js', 'channel-uploads.js'), 'utf8');
assert.match(uploads, /\.cu-modal\{background:var\(--bg-tertiary\);color:var\(--text-primary\)/, 'the upload dialog wears the theme');
const player = fs.readFileSync(path.join(root, 'js', 'stream-player.js'), 'utf8');
assert.ok(!/#1a1a2e/.test(player), 'the player has no fixed dark card colour');

// A focused text box keeps the theme's field colour (a fixed near-black hid the typed text on light themes).
const focus = /\.form-input:focus \{([^}]*)\}/.exec(style);
assert.ok(focus, '.form-input:focus exists');
assert.match(focus[1], /background: var\(--bg-input\)/);

// The channel's language chip mixes its gold with the theme's text instead of a pale fixed gold.
const channel = fs.readFileSync(path.join(root, 'css', 'features', 'channel.css'), 'utf8');
assert.match(channel, /\.ch-lang-chip \{[^}]*color: color-mix\(in srgb, #f59e0b 35%, var\(--text-primary\)\)/);
// Violet reward words and platform-coloured relay badges are mixed with the theme's text: the fixed #b388ff and
// Kick's #53fc18 were pale on light themes.
const allCss = files.filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
assert.ok(!/(^|[^-\w])color:\s*(#b388ff|var\(--reward-color, #b388ff\))/m.test(allCss), 'no fixed pale violet text');
assert.match(style, /\.chat-relay-badge \{ color: color-mix\(in srgb, var\(--relay-color, #888\) 55%, var\(--text-primary\)\)/);
// The hero frame's veil is the theme's: white on light themes (a black veil greyed the whole hero on Daylight).
assert.match(style, /\.hero-bg \{ --hero-veil: rgba\(0, 0, 0, 0\.5\); \}/);
assert.match(style, /html\[data-theme-mode="light"\] \.hero-bg \{ --hero-veil: rgba\(255, 255, 255, 0\.62\); \}/);
const home = fs.readFileSync(path.join(root, 'js', 'app-home.js'), 'utf8');
assert.ok(!/linear-gradient\(rgba\(0,0,0,0\.5\)/.test(home), 'no fixed black veil on the hero frames');
console.log('theme tokens defined: all checks passed');
