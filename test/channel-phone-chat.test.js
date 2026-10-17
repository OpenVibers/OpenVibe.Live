/**
 * A live channel on a phone held upright: the chat waits behind the round chat button in the corner (with its unread
 * count) and opens as a sheet over the page's lower part, the video staying in view above it. The owner asked for the
 * button back on 2026-10-17: Live#163/#177 had docked the chat under the video, and on a vertical stream (the video
 * most of the screen, the goal and pinned banners on top of the chat) one chat line was left between them.
 *
 * Proof at phone width on production (412×915, a live channel, a real tap on the button) is in the PR.
 *
 *   node test/channel-phone-chat.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const channel = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'features', 'channel.css'), 'utf8');
const style = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');

// No portrait-phone rule docks the chat into the page or hides its button.
assert.ok(!/#ch-live-area \.stream-main \{ display: contents; \}/.test(channel), 'the chat is not docked under the video');
assert.ok(!/body:has\(#page-channel\.active #ch-live-area \.stream-layout > \.chat-sidebar\) \.mobile-chat-toggle/.test(channel), 'nothing hides the chat button on a live channel');

// Phones: the chat is a sheet that the button opens, and the button shows while it is closed.
const phone = style.slice(style.indexOf('.chat-sidebar.mobile-chat-open'), style.indexOf('.chat-sidebar.mobile-chat-open') + 2000);
assert.match(phone, /\.chat-sidebar\.mobile-chat-open \{\s*transform: translateY\(0\);/, 'the open sheet slides into view');
assert.match(phone, /\.mobile-chat-toggle \{\s*display: flex;/, 'the chat button shows on phones');
assert.match(phone, /body\.mobile-chat-visible \.mobile-chat-toggle \{ display: none !important; \}/, 'and steps aside while the sheet is open');
console.log('channel phone chat: all checks passed');
