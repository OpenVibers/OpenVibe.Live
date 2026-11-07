/**
 * The chat send button sits on an accent fill, so it takes the on-accent ink. It used to take
 * `var(--text-primary)`, which is the theme's *page* ink: fine on the dark themes (near-white on
 * #1d4ed8) and unreadable on the light ones, where daylight's #1a1a2e sat on #6d28d9 at 2.4:1
 * (measured at 390 px, signed out, openvibe.live/chat). That is below even the 3:1 a UI icon needs.
 *
 *   node test/send-button-ink.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');

// Every rule that paints the send button: selector, then its declarations.
const rules = [...css.matchAll(/([^{}]*\.chat-send-btn[^{}]*)\{([^{}]*)\}/g)]
    .map(([, sel, body]) => ({ sel: sel.trim().split('\n').pop().trim(), body }))
    .filter((r) => r.sel.startsWith('.chat-send-btn') || r.sel.includes('.chat-send-btn'));

assert.ok(rules.length >= 2, `found the send button's rules (${rules.length})`);

for (const r of rules) {
    const color = (/(?:^|;|\s)color:\s*([^;]+)/.exec(r.body) || [])[1];
    const overrides = /\.chat-send-btn/.test(r.sel) && !/^\.chat-send-btn(\.[\w-]+)?(:[\w-]+)?$/.test(r.sel.split(',')[0].trim());
    if (!color || overrides) continue;   // layout-only or a wider context rule
    assert.ok(
        /var\(--on-accent\b/.test(color),
        `${r.sel}: "${color.trim()}" is the page ink; an accent fill takes var(--on-accent, #fff)`
    );
}

// The touch-device block must not put the page ink back on the fill.
const touch = /@media \(hover: none\) \{([\s\S]*?)\n\}/.exec(css);
assert.ok(touch, 'the touch-device block is still there');
assert.ok(
    !/\.chat-send-btn:hover\s*\{[^}]*color:\s*var\(--text-primary\)/.test(touch[1]),
    'the touch-device hover rule still paints the page ink on the send button'
);

console.log(`send button ink: ${rules.length} rules take the on-accent ink`);
