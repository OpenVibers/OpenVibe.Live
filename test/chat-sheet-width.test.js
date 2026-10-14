'use strict';
// The channel chat's saved sizes (public/js/channel-chat-resize.js) belong to their own layouts: --chat-w to the side
// column (1181px and wider), --chat-ow to the landscape overlay, --chat-sheet-h to the portrait sheet. On 2026-10-14 the
// side width's rule sat outside any media query and outranked the sheet's (its :not(:has()) added specificity), so a
// width saved on a wide screen made a phone's bottom sheet 260px wide with the page showing beside it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Comments out first: a comment before a rule would otherwise read as part of its selector or at-rule.
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', 'public', 'css', ...p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const css = read('features', 'channel.css');
const style = read('style.css');

/** The @media condition enclosing position `i` of `text` (null at top level). */
function mediaAt(text, i) {
    let depth = 0;
    for (let j = i; j >= 0; j--) {
        if (text[j] === '}') depth++;
        else if (text[j] === '{') {
            if (depth === 0) {
                const head = text.slice(text.lastIndexOf('}', j) + 1, j).trim();
                if (head.startsWith('@media')) return head;
            } else depth--;
        }
    }
    return null;
}

const uses = (text, v) => [...text.matchAll(new RegExp(`var\\(${v}[,)]`, 'g'))].map((m) => m.index);
// The channel page's own rules (#page-channel …) are the ones that outrank the layouts' rules; style.css's base
// `.chat-sidebar { width: var(--chat-w) }` (0,1,0) loses to both the overlay and the sheet rule, so it may stay.
assert.match(style, /\.chat-sidebar \{\s*width: var\(--chat-w\);/, 'the base default');
for (const [name, text] of [['channel.css', css]]) {
    for (const i of uses(text, '--chat-w')) {
        assert.match(String(mediaAt(text, i)), /min-width:\s*1181px/, `${name}: --chat-w is used outside the side layout (min-width: 1181px)`);
    }
    for (const i of uses(text, '--chat-ow')) {
        assert.match(String(mediaAt(text, i)), /max-width:\s*1180px\)\s*and\s*\(orientation:\s*landscape/, `${name}: --chat-ow outside the landscape overlay`);
    }
    for (const i of uses(text, '--chat-sheet-h')) {
        assert.match(String(mediaAt(text, i)), /max-width:\s*1180px\)\s*and\s*\(orientation:\s*portrait/, `${name}: --chat-sheet-h outside the portrait sheet`);
    }
}
assert.ok(uses(css, '--chat-w').length === 1, 'the side width is set in one place');
// The sheet itself is the full width of the screen.
assert.match(css, /@media \(max-width: 1180px\) and \(orientation: portrait\) \{ #page-channel \.stream-layout > \.chat-sidebar \{ width: 100%;/);
console.log('chat-sheet-width: each saved chat size applies only in its own layout');
