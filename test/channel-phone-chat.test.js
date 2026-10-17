/**
 * A live channel on a phone held upright: the video on top, the chat under it filling the rest of the screen, the stream
 * info after the chat (public/css/features/channel.css). Before, the stream area filled the screen while the chat waited
 * behind a floating button (2026-10-16); then the docked chat had `height: auto` and grew with its history, 19,000 px on
 * a busy channel, so its message box was a long scroll away (2026-10-17). Docked, the chat's button and the DM bubble
 * (which covered the chat's emoji button) step aside.
 *
 * A real browser pass at phone width is in the PR (local Live, a live test stream, a signed-out phone viewer).
 *
 *   node test/channel-phone-chat.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'features', 'channel.css'), 'utf8');
const at = css.lastIndexOf('@media (max-width: 768px) and (orientation: portrait) {\n    #page-channel #ch-live-area .stream-main');
assert.ok(at > 0, 'the portrait-phone block for a live channel exists');
let depth = 0, end = css.indexOf('{', at);
for (; end < css.length; end++) { if (css[end] === '{') depth++; else if (css[end] === '}' && --depth === 0) break; }
const block = css.slice(at, end + 1);

assert.match(block, /#ch-live-area \.stream-main \{ display: contents; \}/, 'the video and the info take their own places');
assert.match(block, /> #video-container \{ order: 1; \}/, 'the video first');
assert.match(block, /\.stream-layout > \.chat-sidebar \{[^}]*order: 4;[^}]*position: relative;[^}]*transform: none;[^}]*flex: none;/, 'the chat under it');
assert.match(block, /height: max\(260px, calc\(100dvh - var\(--navbar-h\) - 56\.25vw\)\);/, 'sized to the rest of the screen, never by its history');
assert.match(block, /\.stream-main > \* \{ order: 5; \}/, 'the stream info after the chat');
assert.match(block, /\.chat-sidebar \.chat-messages \{ flex: 1 1 0; min-height: 0; overflow-y: auto; \}/, 'the messages scroll inside the chat');
assert.ok(!/height: auto;/.test(block.slice(block.indexOf('.chat-sidebar {'), block.indexOf('}', block.indexOf('.chat-sidebar {')))), 'no growing height');
assert.match(block, /\.chat-sidebar > \.chat-grip \{ display: none; \}|> \.chat-grip \{ display: none; \}/, 'no bottom-sheet grip on the docked chat');
assert.match(block, /\.mobile-chat-toggle,\s*body:has\([^)]*\) #messenger-toggle \{ display: none !important; \}/, 'its button and the DM bubble step aside');
console.log('channel phone chat: all checks passed');
