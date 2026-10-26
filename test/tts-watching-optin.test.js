/**
 * A viewer's browser does not read chat TTS aloud on channels they watch unless they turn it on (owner and Maticus,
 * 2026-10-26: "viewers hear tts through their own browser now"; another developer opening Maticus's stream heard every
 * TTS line read in their own browser over the stream, which already carries it).
 *
 * The speaker button under the chat input (ttsEnabled) is the sender's switch: whether your own messages are read.
 * It defaults on, and it also gated local playback on other channels, so every viewer heard TTS. Local playback on a
 * watched channel is now its own setting, ttsHearWatching, off by default; the streamer's own-channel paths are
 * unchanged.
 *
 *   node test/tts-watching-optin.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const chat = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chat.js'), 'utf8');

assert.match(chat, /\n {4}ttsHearWatching: false, /, 'off by default');
assert.match(chat, /\n {4}ttsEnabled: true, /, 'the sender switch keeps its default');

// Both viewer branches (browser speech and server audio) need the new setting.
const viewerSpeak = chat.match(/\} else if \(([^)]*?)isChatTTSEnabled\(\) && !_isOwnTtsMessage\(msg\) && _isTTSEnabledForSource\(msg\.source_platform\)\) \{\n\s*(speakTTS|playTTSAudio)\(/g) || [];
assert.strictEqual(viewerSpeak.length, 2, 'the tts and tts-audio cases each have one viewer branch');
for (const b of viewerSpeak) assert.ok(b.includes('chatSettings.ttsHearWatching && isChatTTSEnabled()'), `gated: ${b.slice(0, 80)}`);
assert.ok(!/\} else if \(isChatTTSEnabled\(\) && !_isOwnTtsMessage/.test(chat), 'no viewer branch speaks on ttsEnabled alone');

// The setting is in the panel, and turning it off stops what is being read.
assert.ok(chat.includes('<span>Read TTS Aloud On Channels I Watch</span>') && chat.includes('data-setting="ttsHearWatching"'));
assert.ok(chat.includes("if (key === 'ttsHearWatching' && !chatSettings.ttsHearWatching && typeof cancelAllTTS === 'function') cancelAllTTS();"));

// Not part of the synced record (Chat's chat.tts_defaults schema has no such field).
const ttsModule = chat.slice(chat.indexOf('function _ttsModuleFromSettings'), chat.indexOf('const CHAT_MODULES'));
assert.ok(!ttsModule.includes('ttsHearWatching'), 'local to this browser');

console.log('tts watching opt-in: viewers hear TTS from the stream only, unless they turn on reading it here');
