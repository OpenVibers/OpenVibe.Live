'use strict';
// The chat name card never waits (11-03: Maticus's "Loading..." box sat for minutes while Chat restarted in a deploy
// round). Clicking a name shows the basic card at once (the name, Message, Channel) and upgrades it when the profile
// arrives, within eight seconds; the chat logs give up after ten with a way to try again.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chat.js'), 'utf8');
assert.ok(!src.includes('<div class="ctx-loading">'), 'no "Loading..." box in the name card');
assert.match(src, /menu\.innerHTML = basicContextCard\(username\);/, 'the basic card is shown at once');
assert.match(src, /api\(`\/chat\/user\/\$\{encodeURIComponent\(username\)\}\/profile`, \{ signal: AbortSignal\.timeout\(8000\) \}\)/, 'the profile waits eight seconds at most');
assert.match(src, /if \(!menu\.isConnected\) return;/, 'a dismissed card is left alone');

const fn = /function basicContextCard\(username\) \{[\s\S]*?\n\}/.exec(src);
assert.ok(fn, 'basicContextCard exists');
const ctx = { esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') };
vm.createContext(ctx);
vm.runInContext(`${fn[0]}\nthis.card = basicContextCard;`, ctx);
const html = ctx.card('maticus');
assert.match(html, /<span class="ctx-avatar-letter">M<\/span>/);
assert.match(html, /ctxWhisper\(this\.dataset\.username\)[\s\S]*Message/);
assert.match(html, /ctxViewChannel\(this\.dataset\.username\)[\s\S]*Channel/);
assert.ok(!/spin|Loading/.test(html), 'nothing loading in it');
assert.ok(!ctx.card('<b>x</b>').includes('<b>'), 'the name is escaped');

const logs = /async function loadChatLogs\(\) \{[\s\S]*?\n\}/.exec(src)[0];
assert.match(logs, /const signal = AbortSignal\.timeout\(10000\);/);
assert.strictEqual((logs.match(/await api\(url, \{ signal \}\)/g) || []).length, 4, 'every logs request has the limit');
assert.match(logs, /taking too long right now[\s\S]*onclick="loadChatLogs\(\)">Try again/);
console.log('chat card never waits: all checks passed');
