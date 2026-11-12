'use strict';
/**
 * A chat message's actions (openvibe.design rule 138). The owner, 11-12, with phone screenshots of a stream's chat:
 * "The edit button needs improvement … so it never happens again", "it also looks stupid as shit after you edit it".
 * Until then every one of your own messages carried a full-size "Edit" pill inline in its words, editing opened the
 * browser's prompt box, and "edited · 06:49 PM" fell onto a line of its own under the message.
 *
 * Now: reply, edit and translate are one cluster at the message's corner (hover or focus on a computer, a tap on a
 * phone); editing happens in the chat box with an "Editing your message" bar; "edited" is one quiet word after the words.
 *   node test/chat-msg-actions.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const chat = fs.readFileSync(path.join(root, 'public/js/chat.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/style.css'), 'utf8');
const i18n = fs.readFileSync(path.join(root, 'public/css/i18n-star.css'), 'utf8');

// No message action is a kit button with a word in it, and none is appended into the message's line.
assert.ok(!/chat-edit-btn'; editBtn\.type = 'button'; editBtn\.textContent = 'Edit'/.test(chat), 'no "Edit" pill');
assert.ok(!/ovk-btn[^'"]*chat-(edit|reply|translate)-btn/.test(chat), 'message actions are not kit buttons');
for (const cls of ['chat-reply-btn', 'chat-edit-btn', 'chat-translate-btn']) {
    assert.ok(new RegExp(`_chatActionBtn\\('${cls}'`).test(chat), `${cls} is made by _chatActionBtn (an icon with a label)`);
}
assert.ok(!/el\.appendChild\((replyBtn|editBtn|trBtn)\)/.test(chat), 'no action button is appended straight into the message');
assert.ok(/function _chatActions\(el\)[\s\S]{0,300}chat-msg-actions/.test(chat), 'the actions go in one .chat-msg-actions cluster');

// Editing is in the chat box, never the browser's prompt or alert.
assert.ok(!/window\.prompt\('Edit message'/.test(chat), 'no prompt box for an edit');
assert.ok(/function setChatEdit\(row\)/.test(chat) && /function clearChatEdit\(/.test(chat) && /function _saveChatEdit\(/.test(chat));
assert.ok(/if \(_chatEditing\) \{ _saveChatEdit\(input, text\); return; \}/.test(chat), 'Enter in the box saves the edit');
assert.ok(/e\.key === 'Escape' && _chatEditing/.test(chat), 'Escape stops editing');
assert.ok(/if \(!ed \|\| ed\.saving\) return;/.test(chat) && /ed\.saving = true;/.test(chat), 'one save at a time (Enter reaches both the shared composer and Live\'s keys)');
assert.ok(/Editing your message/.test(chat), 'the bar says what is happening');
assert.ok(/'\.chat-reply-bar:not\(\.chat-edit-bar\)'/.test(chat), 'replying and editing never reuse each other\'s bar');
assert.ok(/ed\.muted && !text\.startsWith\('\.'\) \? '\.' \+ text : text/.test(chat), 'a message sent without TTS stays without TTS when edited');

// "edited" is one word after the words, with the time as its title.
assert.ok(/function _chatEditedMark\(el, at\)[\s\S]{0,400}text\.after\(mark\)[\s\S]{0,300}mark\.textContent = 'edited'/.test(chat), '"edited" sits right after the words');
assert.ok(!/edited · \$\{/.test(chat), 'no "edited · time" line');

// The cluster: absolute at the corner, shown only on hover, focus or a tap; thumb-sized where there is no hover.
const block = (sel) => { const i = css.indexOf(`${sel} {`); assert.ok(i >= 0, `${sel} is styled`); return css.slice(i, css.indexOf('}', i)); };
assert.match(block('.chat-msg-actions'), /position: absolute/);
assert.match(block('.chat-msg-actions'), /display: none/);
assert.match(css, /\.chat-msg-hoverable:hover > \.chat-msg-actions,\s*\.chat-msg-hoverable:focus-within > \.chat-msg-actions,\s*\.chat-msg-hoverable\.is-acting > \.chat-msg-actions \{ display: inline-flex; \}/);
assert.match(css, /@media \(hover: none\) \{[\s\S]{0,400}width: 44px; height: 40px/, 'a phone gets thumb-sized actions');
assert.match(block('.chat-edited'), /white-space: nowrap/);
assert.ok(!/\.chat-msg-hoverable \.chat-(reply|translate)-btn \{/.test(css + i18n), 'no button keeps a position of its own');

console.log('chat-msg-actions: one cluster at the corner, editing in the box, "edited" after the words');
