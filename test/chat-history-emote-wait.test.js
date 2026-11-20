'use strict';
// A chat's history never waits more than 1.5 s on the emote list (2026-11-20: Chat's /api/emotes/all took 8 s as long
// as a third-party emote provider did not answer, and every chat's history appeared 8 s late).
//   node test/chat-history-emote-wait.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chat.js'), 'utf8');
const at = src.indexOf('async function hydrateActiveChatHistory(');
const body = src.slice(at, src.indexOf('\n}\n', at));
assert.match(body, /const emotesOrLate = emotes \? Promise\.race\(\[emotes, new Promise\(\(r\) => setTimeout\(r, 1500\)\)\]\) : null;/);
assert.match(body, /await Promise\.all\(\[_fetchHistoryPayload\(streamId\), emotesOrLate,/, 'the history waits on the bounded emotes, not the emote list itself');
console.log('chat history: at most 1.5 s on the emotes');
