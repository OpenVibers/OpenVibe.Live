// Browser TTS (chat.js speakTTS, broadcast.js's queue) speaks an emote by its name only (the owner, 2026-11-06):
// public/js/chat-shared.js ttsReplaceLinks runs ttsSpeakableEmotes first, the same rule as OpenVibe.Chat's server TTS.
const assert = require('assert');
global.window = {};
global.document = { addEventListener() {}, querySelector() { return null; } };
require('../public/js/chat-shared.js');
const C = global.window.OpenVibeChat;
const cases = [
    ['lol [emote:37226:KEKLEO] that was funny', 'lol KEKLEO that was funny'],
    ['[emoji:emojiSmile]', 'emojiSmile'],
    ['hi <:pepe_hands:123456789> and <a:catJAM:42>', 'hi pepe hands and catJAM'],
    ['nice :PogChamp: play', 'nice PogChamp play'],
    ['[emote:1:KEKW] [emote:1:KEKW] [emote:1:KEKW] [emote:1:KEKW]', 'KEKW'],
    ['no no', 'no no'],
    ['time 10:30:45 ok', 'time 10:30:45 ok'],
];
cases.forEach(([input, want]) => assert.strictEqual(C.ttsSpeakableEmotes(input), want, input));
assert.strictEqual(C.ttsReplaceLinks('gg [emote:37226:KEKLEO] see https://openvibe.live/x', 'bob'), 'gg KEKLEO see (bob sent a link to openvibe)', 'emotes first, then links');
console.log(`tts-emotes-client: ${cases.length + 1} checks passed`);
