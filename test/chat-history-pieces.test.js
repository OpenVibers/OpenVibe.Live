'use strict';
/**
 * Chat history on a channel page (public/js/chat.js hydrateActiveChatHistory): the newest 120 rows render first and
 * the older scrollback is put above them a piece at a time. Rendering all of it (up to 500 channel + 500 global rows)
 * in one idle callback was a 2.7 s task on a phone-speed CPU (2026-10-17 trace of /@goosely).
 *
 * _historyPieces splits a payload by time, in the order the renderer merges channel and global rows: every row in
 * exactly one piece, the newest piece first, each piece in time order.
 *
 *   node test/chat-history-pieces.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../public/js/chat.js'), 'utf8');
const start = src.indexOf('function _historyPieces(');
assert.ok(start > 0, '_historyPieces is in chat.js');
let depth = 0, end = src.indexOf('{', start);
for (let i = end; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
}
const _historyPieces = new Function(`${src.slice(start, end)}; return _historyPieces;`)();

const ts = (n) => `2026-10-17 10:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const channel = Array.from({ length: 300 }, (_, i) => ({ id: `c${i}`, timestamp: ts(i * 2) }));
const global = Array.from({ length: 250 }, (_, i) => ({ id: `g${i}`, timestamp: ts(i * 2 + 1) }));
const payload = { kind: 'channel', data: { messages: channel, liveSlots: [1], channel: 'goosely' }, globalMsgs: global };

const pieces = _historyPieces(payload, 120);
assert.strictEqual(pieces.length, Math.ceil(550 / 120));
const rows = (p) => p.data.messages.length + p.globalMsgs.length;
assert.deepStrictEqual(pieces.map(rows), [120, 120, 120, 120, 70], 'pieces of 120, the oldest takes the rest');
// Every row exactly once.
const ids = pieces.flatMap((p) => [...p.data.messages, ...p.globalMsgs].map((m) => m.id));
assert.strictEqual(new Set(ids).size, 550);
// The newest piece first: its oldest row is newer than every row of the next piece.
const tOf = (m) => Date.parse(m.timestamp.replace(' ', 'T'));
for (let i = 0; i + 1 < pieces.length; i++) {
    const oldestHere = Math.min(...[...pieces[i].data.messages, ...pieces[i].globalMsgs].map(tOf));
    const newestNext = Math.max(...[...pieces[i + 1].data.messages, ...pieces[i + 1].globalMsgs].map(tOf));
    assert.ok(oldestHere > newestNext, `piece ${i} is newer than piece ${i + 1}`);
}
// The newest piece holds the newest rows of both feeds; the payload's other fields ride along.
assert.ok(pieces[0].data.messages.some((m) => m.id === 'c299') && pieces[0].globalMsgs.some((m) => m.id === 'g249'));
assert.deepStrictEqual([pieces[0].kind, pieces[0].data.channel, pieces[0].data.liveSlots], ['channel', 'goosely', [1]]);

// A bigger first piece (what fits on screen), then small ones.
assert.deepStrictEqual(_historyPieces(payload, 10, 50).map(rows), [50, ...Array(50).fill(10)], '550 rows: 50, then 50 × 10');
assert.deepStrictEqual(_historyPieces(payload, 25, 120).map(rows), [120, ...Array(17).fill(25), 5], '550 rows: 120, then 17 × 25, then 5');

// The global room has no second feed; a small payload is one piece; an empty one is itself.
const g = _historyPieces({ kind: 'global', data: { messages: global.slice(0, 50) } }, 120);
assert.strictEqual(g.length, 1);
assert.strictEqual(g[0].data.messages.length, 50);
const empty = { kind: 'channel', data: { messages: [] }, globalMsgs: [] };
assert.deepStrictEqual(_historyPieces(empty, 120), [empty]);
assert.deepStrictEqual(_historyPieces(null, 120), [null]);

// About 200 rows are built at once; older pieces wait for the reader to scroll up to a sentinel above the oldest row
// (proved in a browser against production 2026-10-17: 198 rows after load, +50 per scroll to the top, position kept).
assert.ok(src.includes("more.className = 'chat-history-more'") && src.includes('new IntersectionObserver(') && src.includes('add(5)'), 'older history loads on scroll');
assert.ok(src.includes('if (i < 16) return older();'), 'the newest 50 rows plus 15 pieces of 10 are built eagerly');
assert.ok(src.includes('stick = _chatPinned && h - top - messages.clientHeight < 80'), 'a reader who scrolled up is not thrown to the bottom');

console.log('chat history pieces: all checks passed');
