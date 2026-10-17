/**
 * A live channel on a phone held upright shows its chat under the stream info, filling the screen below the video
 * (public/css/features/channel.css). Before, the stream area was sized to the whole screen while the chat waited
 * behind a floating button, which left about a third of the screen empty (seen 2026-10-16 at phone width). Docked,
 * the chat's button and the DM bubble (which covered the chat's emoji button) step aside.
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

assert.match(block, /#ch-live-area \.stream-main \{ flex: none; overflow: visible; \}/, 'the stream area keeps its own height');
assert.match(block, /\.stream-layout > \.chat-sidebar \{[^}]*position: relative;[^}]*transform: none;[^}]*flex: 1 1 auto;[^}]*min-height: 220px;/, 'the chat docks below and fills the rest');
assert.match(block, /\.chat-sidebar > \.chat-grip \{ display: none; \}|> \.chat-grip \{ display: none; \}/, 'no bottom-sheet grip on the docked chat');
assert.match(block, /\.mobile-chat-toggle,\s*body:has\([^)]*\) #messenger-toggle \{ display: none !important; \}/, 'its button and the DM bubble step aside');
console.log('channel phone chat: all checks passed');
