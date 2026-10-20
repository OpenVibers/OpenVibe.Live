/**
 * /tts messages show in chat (owner, 2026-10-20: "the /tts command doesnt show in chat so people are like wtf").
 * OpenVibe.Chat sends a /tts as a `tts` event only (speech); nothing put it in the chat. Live's chat and the OBS chat
 * overlay now show it as a chat line tagged "TTS", and speaking it is unchanged (the line is added directly, not
 * through the `chat` case, so a broadcaster's self-TTS mode does not read it a second time).
 *
 *   node test/tts-in-chat.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const chat = read('public/js/chat.js');
// The main socket's tts case adds the line before it decides whether this tab speaks.
const ttsCase = /case 'tts':\n\s*\/\/ Shown as a chat line too[^\n]*\n\s*addChatMessage\(\{ \.\.\.msg, type: 'chat', message_type: 'tts' \}\);\n\s*\/\/ Legacy browser-side TTS/.exec(chat);
assert.ok(ttsCase, "the main socket's tts case shows the message in chat first");
assert.strictEqual(chat.split("addChatMessage({ ...msg, type: 'chat', message_type: 'tts' })").length - 1, 1, 'once (the broadcast page\'s background socket does not add a second line)');
assert.ok(chat.includes(`if (msg.message_type === 'tts') text = \`<span class="chat-tts-tag" title="Read aloud (/tts)"><i class="fa-solid fa-volume-high"></i> TTS</span> \${text}\`;`), 'tagged TTS');

// The OBS overlay shows it the same way.
const obs = read('public/obs/chat.html');
assert.ok(obs.includes("if (msg.type === 'tts') msg = { ...msg, type: 'chat', message_type: 'tts' };"));
assert.ok(obs.indexOf("if (msg.type === 'tts') msg =") < obs.indexOf("if (msg.type !== 'chat') return;"), 'converted before non-chat events are dropped');
assert.match(obs, /if \(msg\.message_type === 'tts'\) text = `<span class="channel-sound-pill tts-pill">/);

assert.match(read('public/css/chat-shared.css'), /\.chat-tts-tag \{/);
console.log('tts in chat: /tts messages show in chat and on the overlay, tagged — all checks passed');
