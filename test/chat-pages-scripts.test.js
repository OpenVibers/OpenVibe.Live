'use strict';
// Every page that loads public/js/chat.js loads public/js/chat-shared.js before it: chat.js builds its user menus,
// links and TTS text with OpenVibeChat. The popout chat page did not (2026-10-17): every name clicked there stayed on
// "Loading..." with "OpenVibeChat is not defined".
//
//   node test/chat-pages-scripts.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const pub = path.join(__dirname, '..', 'public');
const pages = fs.readdirSync(pub).filter((f) => f.endsWith('.html')).map((f) => [f, fs.readFileSync(path.join(pub, f), 'utf8')])
    .filter(([, html]) => /<script[^>]+src="\/js\/chat\.js[?"]/.test(html));
assert.ok(pages.some(([f]) => f === 'popout-chat.html') && pages.some(([f]) => f === 'index.html'), 'the main page and the popout load chat.js');
for (const [file, html] of pages) {
    const shared = html.search(/<script[^>]+src="\/js\/chat-shared\.js[?"]/);
    const chat = html.search(/<script[^>]+src="\/js\/chat\.js[?"]/);
    assert.ok(shared >= 0 && shared < chat, `${file} loads chat-shared.js before chat.js`);
}
console.log(`chat pages scripts: ${pages.length} pages load chat-shared.js before chat.js`);
