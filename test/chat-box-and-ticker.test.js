'use strict';
// The owner's phone, 2026-11-13 (ask 371): the chat box holds what goes into a message (Live's emote picker in its
// row; a GIF and adding an emote or sound in its + sheet) and the row under it only the channel's own actions, so
// nothing is there twice; a reply is said inside the box; the global chat's AI line is a ticker that steps aside when
// it is old; a section's glyph is drawn inside its tile, not to its edges; AI wears the sparkles.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const composer = read('public/js/composer.js');
assert.ok(/C\.tool\('emote', \{ label: 'Emotes and emoji'/.test(composer) && /tools: \['emote'\]/.test(composer), 'the box\'s row has Live\'s emote picker');
assert.ok(/C\.tool\('gif', \{ label: 'GIF', path: GIF, extra: true/.test(composer) && /C\.tool\('emote-add', \{ label: 'Add an emote or sound', path: ADD, extra: true/.test(composer),
    'its + sheet has a GIF and adding an emote or sound');
for (const f of ['public/fragments/channel.html', 'public/fragments/chat.html', 'public/fragments/broadcast.html', 'public/popout-chat.html']) {
    const html = read(f);
    assert.ok(!/onclick="toggleEmotePicker\(|onclick="toggleGifPicker\(|title="Add channel emote/.test(html), `${f}: no emote, GIF or add button under the box (they are in it)`);
}
assert.ok(/t\.closest\('\.ovc-t-emote'\)/.test(read('public/js/emotes.js')), 'a press on the box\'s emote button is left to it');
assert.ok(/t\.closest\('\.ovc-t-gif'\) \|\| t\.closest\('\.ovc-tray-i'\)/.test(read('public/js/gif-picker.js')), 'and on the sheet\'s GIF');

const chat = read('public/js/chat.js');
assert.ok(/const ovc = area\.querySelector\('form\.ovc-v2'\)\?\.__ovc;\n\s*if \(ovc && typeof ovc\.reply === 'function'\) \{\n\s*ovc\.reply\(\{ name: replyData\.username/.test(chat), 'a reply is said inside the shared box');
assert.ok(/f\.__ovc\.clearBar\(\)/.test(chat), 'and cleared there');

const page = read('public/js/app-chatpage.js');
assert.ok(/_gaiAgeMs\(insight\.updated_at\) > 12 \* 3600e3/.test(page), 'a read older than 12 hours steps aside');
assert.ok(/function _gaiTicker\(el, text\)/.test(page) && /el\.matches\(':hover'\) \|\| el\.closest\('\.global-ai-strip\.open'\)/.test(page), 'a ticker that waits under a pointer and while open');
const css = read('public/css/features/chatpage.css');
assert.ok(css.includes('@keyframes gaiRoll') && css.includes('@keyframes gaiPan') && css.includes('html[data-ov-motion="off"] .global-ai-strip .gai-t { animation: none !important; }'), 'it rolls and pans, and not with motion off');

assert.ok(read('public/css/features/channel.css').includes('#page-channel .ch-sec-ic > svg { width: 62%; height: 62%; }'), 'a section\'s glyph inside its tile');
const wand = ['public/js/app-channel.js', 'public/js/chat.js', 'public/fragments/chat.html', 'public/fragments/channel.html'].filter((f) => read(f).includes('fa-wand-magic-sparkles'));
assert.deepStrictEqual(wand, [], 'AI wears the sparkles, not a wand');
console.log('chat-box-and-ticker: one emote button, the extras in the +, a reply in the box, a ticker that steps aside, glyphs in their tiles');
