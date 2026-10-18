/**
 * A restart notice never leaves "OpenVibe is updating" on screen while chat is connected (owner's popout, 2026-10-18:
 * the notice stuck after a Live deploy). Live sends no notice (its restarts do not touch Chat's sockets); the client
 * shows "updating" only once the socket actually drops, and forgets the notice after a minute.
 *
 *   node test/chat-restart-notice.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
const chat = fs.readFileSync(path.join(root, 'public', 'js', 'chat.js'), 'utf8');

assert.ok(!/type: 'server_restart'/.test(index), "Live's shutdown sends no chat restart notice");
const at = chat.indexOf("case 'server_restart':");
assert.ok(at > 0, 'the client still understands the notice (Chat sends it)');
const body = chat.slice(at, chat.indexOf('break;', at));
assert.ok(!/_chatConnState\(/.test(body), 'the notice alone changes nothing on screen');
assert.ok(/_chatServerUpdating = true/.test(body) && /setTimeout\(\(\) => \{ _chatServerUpdating = false; \}, 60000\)/.test(body), 'it arms a quick reconnect for a minute');
assert.ok(/_chatConnState\(_chatServerUpdating \? 'updating' : 'reconnecting'\)/.test(chat), 'a drop after the notice says "updating"');
console.log('chat restart notice: all checks passed');
