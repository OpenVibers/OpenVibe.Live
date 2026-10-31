'use strict';
// Watching on a phone (owner, 2026-10-31): the app's bottom bar covered the stream's chat button and its own "Chat" went
// to the inbox, and the phone studio's rail ran under the same bar. On a phone held upright, a live channel is a watch
// screen: no app bar, no floating buttons, the stream's chat docked under the player (over a portrait picture), and
// the studio is a full screen of its own.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const css = read('public/css/features/channel.css');
const block = css.slice(css.indexOf('Watching on a phone (2026-10-31)'));
assert.ok(block.length > 200, 'the watch block is in channel.css');
const phone = block.slice(block.indexOf('@media (max-width: 768px) and (orientation: portrait)'));
assert.ok(phone.startsWith('@media (max-width: 768px) and (orientation: portrait)'), 'only on a phone held upright');

// The app bar and every floating button step aside while a stream is live on the open channel page.
assert.match(phone, /html:has\(#page-channel\.active\.ch-is-live\) \{ --ovnav-appbar-h: 0px; \}/, 'the page keeps no room for the bar');
assert.match(phone, /html:has\(#page-channel\.active\.ch-is-live\) \.ovnav-appbar,/, 'the bar is hidden');
assert.match(phone, /:is\(\.mobile-chat-toggle, #messenger-toggle, #floating-chat-fab\) \{ display: none !important; \}/, 'no floating buttons');

// The chat is in the page under the player, taking what is left: not a sheet behind a button.
assert.match(phone, /#page-channel\.ch-is-live\.page \.stream-layout > \.chat-sidebar \{[^}]*position: relative;[^}]*flex: 1 1 0;[^}]*transform: none;/, 'the chat is docked');
// A portrait stream fills the screen; the chat runs over its lower part and the channel line over its top.
assert.match(phone, /\.stream-layout:has\(\.video-container\.is-vertical\) \.video-container\.is-vertical \{[^}]*position: absolute; inset: 0;/, 'a portrait picture fills the screen');
assert.match(phone, /\.stream-layout:has\(\.video-container\.is-vertical\) > \.chat-sidebar \{[^}]*position: absolute;[^}]*bottom: 0;/, 'the chat over its lower part');
assert.match(phone, /\.video-container\.is-tall :is\(#video-element, #video-canvas\) \{ object-fit: cover; \}/, 'a 9:16 picture is not letterboxed');

// The live state is marked on the page in both directions, and the channel line opens on a tap.
const app = read('public/js/app-channel.js');
assert.match(app, /\/\/ ── LIVE STATE ──[\s\S]{0,300}_setChannelLive\(true\);/, 'live marks the page');
assert.match(app, /getElementById\('ch-offline-area'\)\.style\.display = '';\n\s*_channelFooter\(false\);\n\s*_setChannelLive\(false\);/, 'offline unmarks it');
assert.match(app, /page\.classList\.toggle\('ch-is-live', !!live\)/);
assert.match(app, /bar\.classList\.toggle\('ch-info-open'\)/, 'a tap opens the channel line');

// The player says when a picture is phone-shaped.
assert.match(read('public/js/player-shape.js'), /box\.classList\.toggle\('is-tall', ratio < 0\.66\)/);

// The studio: no app bar over its rail, and no connection notices over the camera.
const bc = read('public/css/features/broadcast.css');
assert.match(bc, /body\.bc-studio-on \.ovnav-appbar \{ display: none !important; \}/, 'the studio hides the app bar');
assert.match(bc, /html:has\(body\.bc-studio-on\) \{ --ovnav-appbar-h: 0px; \}/);
assert.match(bc, /body\.bc-studio-on #bc-chat-messages \.chat-conn-note \{ display: none !important; \}/);
const chat = read('public/js/chat.js');
assert.match(chat, /else if \(style === 'conn'\) el\.classList\.add\('chat-conn-note'\);/);
assert.strictEqual((chat.match(/Chatting as \$\{esc\(msg\.username\)\}[^`]*`, 'conn'\)/g) || []).length, 3, 'every "Chatting as" notice is a connection note');
assert.match(chat, /Connected to chat', 'conn'\)/);

console.log('channel: a phone watching a live stream gets a watch screen (no app bar, chat docked), and the studio is full screen');
