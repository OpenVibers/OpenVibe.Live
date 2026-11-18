'use strict';
// Link cards in Live's stream chat (plan §Y.1 A8; public/js/chat.js _chatDrawEmbeds / _applyChatEmbeds): OpenVibe.Chat
// sends `chat_embeds` { id, embeds } a moment after a line that carries an address, and a history row carries its
// `embeds`; Shared's OVLinkCard (openvibe-shared 4.320.0) draws them. What this proves, on the real chat.js code:
//   - every row with that id gets the cards, in one .chat-embeds box after the words, two at most;
//   - a second frame for the same line replaces the cards (one box, never two); an empty list takes them away;
//   - a reader pinned to the bottom stays at the bottom when the cards arrive; one who scrolled up is not moved;
//   - the chat cache keeps them, so a reload draws them at once;
//   - a frame with a bad id or no list changes nothing.
//   node test/chat-link-cards.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseHTML } = require('linkedom');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chat.js'), 'utf8');
const start = src.indexOf('const _CHAT_EMBEDS_MAX');
const end = src.indexOf('function handleChatMessage(');
assert.ok(start > 0 && end > start, 'the link card code is in chat.js');
assert.ok(/case 'chat_embeds':\s*_applyChatEmbeds\(msg\);/.test(src), 'the frame switch hands chat_embeds over');
assert.ok(/msg\.embeds\.length\) _chatDrawEmbeds\(el, msg\.embeds\)/.test(src), 'a history row draws its own cards');

const { document } = parseHTML('<html><head></head><body><div id="msgs">'
    + '<div class="chat-msg" data-msg-id="7"><span class="chat-text">look https://a.example</span></div>'
    + '<div class="chat-msg" data-msg-id="7"><span class="chat-text">same line, second view</span></div>'
    + '<div class="chat-msg" data-msg-id="8"><span class="chat-text">other</span></div></div></body></html>');
const drawn = [];
const window = {
    OVLinkCard: {
        render(host, list, o) {
            drawn.push({ n: list.length, max: o.max });
            host.textContent = '';
            list.slice(0, o.max).forEach((e) => { const c = document.createElement('div'); c.className = 'ovlc'; c.textContent = e.title; host.appendChild(c); });
            return Math.min(list.length, o.max);
        },
    },
};
const container = document.getElementById('msgs');
let scrollHeight = 500;
Object.defineProperty(container, 'scrollHeight', { get: () => scrollHeight });
container.scrollTop = 0;
const state = { pinned: true, up: false };
const cached = [];
const CSS = { escape: (v) => String(v) };
const run = new Function('window', 'document', 'CSS', 'getChatEl', '_chatCacheEmbeds', 'state',
    `let _chatPinned, _chatUserScrolledUp; const sync = () => { _chatPinned = state.pinned; _chatUserScrolledUp = state.up; };
     ${src.slice(start, end)}
     return { draw: (el, e) => { sync(); return _chatDrawEmbeds(el, e); }, apply: (evt) => { sync(); return _applyChatEmbeds(evt); } };`);
const api = run(window, document, CSS, () => ({ messages: container }), (id, e) => cached.push([id, e.length]), state);
const tick = () => new Promise((r) => setImmediate(r));
const embeds = (n) => Array.from({ length: n }, (_, i) => ({ url: `https://a.example/${i}`, title: `Card ${i}` }));
const boxes = (id) => [...document.querySelectorAll(`.chat-msg[data-msg-id="${id}"]`)]
    .map((el) => [...el.children].filter((c) => c.classList.contains('chat-embeds')).length);

(async () => {
    api.apply({ type: 'chat_embeds', id: 7, embeds: embeds(4) });
    await tick();
    assert.deepStrictEqual(boxes(7), [1, 1], 'every row of line 7 has one card box');
    assert.deepStrictEqual(boxes(8), [0], 'another line is untouched');
    assert.ok(drawn.length === 2 && drawn.every((d) => d.n === 2 && d.max === 2), `two cards at most: ${JSON.stringify(drawn)}`);
    assert.strictEqual(container.scrollTop, 500, 'a reader at the bottom stays at the bottom');
    assert.deepStrictEqual(cached.map((c) => c[0]), [7], 'the cache keeps them (_chatCacheEmbeds trims to two)');
    assert.ok(/row\.embeds = embeds\.slice\(0, _CHAT_EMBEDS_MAX\)/.test(src), 'and the cache keeps two at most');

    state.pinned = false; state.up = true; container.scrollTop = 120; scrollHeight = 640;
    api.apply({ type: 'chat_embeds', id: 7, embeds: embeds(1) });
    await tick();
    assert.deepStrictEqual(boxes(7), [1, 1], 'drawn again: still one box per row');
    assert.strictEqual(document.querySelector('.chat-msg[data-msg-id="7"] .chat-embeds').children.length, 1, 'the new list replaced the old');
    assert.strictEqual(container.scrollTop, 120, 'a reader who scrolled up is not moved');

    api.apply({ type: 'chat_embeds', id: 7, embeds: [] });
    await tick();
    assert.deepStrictEqual(boxes(7), [0, 0], 'an empty list takes the cards away');

    const before = drawn.length;
    api.apply({ type: 'chat_embeds', id: 'x', embeds: embeds(1) });
    api.apply({ type: 'chat_embeds', id: 8 });
    await tick();
    assert.strictEqual(drawn.length, before, 'a bad id or no list draws nothing');

    // A history row: built before it is in the list, it draws its cards all the same.
    const row = document.createElement('div'); row.className = 'chat-msg'; row.dataset.msgId = '9';
    api.draw(row, embeds(3));
    await tick();
    assert.strictEqual(row.querySelector('.chat-embeds').children.length, 2);
    console.log('chat-link-cards: chat_embeds draws two cards per row, redraws in place, keeps a pinned reader at the bottom, caches them');
})().catch((e) => { console.error(e); process.exit(1); });
