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
        // The phone's docked chat (768px and narrower, upright; ask 353) is the same sheet on a smaller screen.
        assert.match(String(mediaAt(text, i)), /max-width:\s*(1180|768)px\)\s*and\s*\(orientation:\s*portrait/, `${name}: --chat-sheet-h outside the portrait sheet`);
    }
}
assert.ok(uses(css, '--chat-w').length === 1, 'the side width is set in one place');
// The sheet itself is the full width of the screen.
assert.match(css, /@media \(max-width: 1180px\) and \(orientation: portrait\) \{ #page-channel \.stream-layout > \.chat-sidebar \{ width: 100%;/);
// The phone's docked chat (ask 353, 2026-11-11): it fills up to the player until it has a height of its own
// (ch-chat-sized, set by public/js/channel-chat-resize.js with --chat-sheet-h), its grip is shown, and letting go low
// folds it to the round chat button rather than the tablet sheet's close.
const resize = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'channel-chat-resize.js'), 'utf8');
assert.match(resize, /if \(mode === 'sheet'\) p\.classList\.toggle\('ch-chat-sized', !!v\);/, 'a saved height marks the page');
assert.match(resize, /max: \(\) => \(docked\(\) \? dockRoom\(\) : window\.innerHeight \* 0\.92\)/, 'docked, the room under the player is the most');
assert.match(resize, /if \(d\.cur < m\.min\) \{\s*setSize\('sheet', read\(m\.key\)\);\s*if \(typeof window\.toggleChannelChat === 'function'\) window\.toggleChannelChat\(true\);/, 'low folds the chat');
assert.match(resize, /if \(d\.cur >= m\.max\(\) - 16\) \{ reset\('sheet'\);/, 'all the way up is the default again');
assert.match(css, /#page-channel\.ch-is-live:not\(\.ch-chat-sized\):not\(\.chat-collapsed\) [^{]*:is\(\.ch-info-bar, \.ch-weather-widget\) \{ display: none !important; \}/, 'full: the chat reaches the player');
assert.match(css, /#page-channel\.ch-is-live\.ch-chat-sized\.page [^{]*> \.chat-sidebar \{ flex: 0 1 var\(--chat-sheet-h, 60%\); min-height: 120px; \}/, 'sized: the chat keeps its height');
assert.match(css, /> \.chat-sidebar > \.chat-grip \{ display: block !important;/, 'the grip shows on the docked chat');
console.log('chat-sheet-width: each saved chat size applies only in its own layout');
