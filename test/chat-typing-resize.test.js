/**
 * Typing in the chat box stays cheap (2026-11-28; RUM: "keydown textarea#chat-input" slow on channel pages, a phone's
 * keystroke 104 ms at p50 in the lab at 4x CPU, 256 ms at worst).
 *
 * - _autoResizeTextarea sets the height to auto (which lays the whole page out again) only when the words may no longer
 *   fit or something was taken away; while they still fit it writes nothing.
 * - Inside the shared composer (form.ovc-v2), whose own input listener grows the box, chat.js does not resize it again
 *   on input; style.css keeps the composer's box at the 120 px chat.js gave it.
 *
 *   node test/chat-typing-resize.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chat.js'), 'utf8');
const start = src.indexOf('function _autoResizeTextarea(el) {');
const end = src.indexOf('\n}\n', start);
assert.ok(start > 0 && end > start, '_autoResizeTextarea is in chat.js');
const ctx = { Math };
vm.createContext(ctx);
vm.runInContext(src.slice(start, end + 2), ctx);
const resize = ctx._autoResizeTextarea;

/** A textarea whose content needs `need` px; writes to style.height are counted. */
function box(need) {
    const writes = [];
    let h = '';
    const el = { tagName: 'TEXTAREA', value: '', need, style: { overflowY: '' } };
    Object.defineProperty(el.style, 'height', { get: () => h, set: (v) => { writes.push(v); h = v; } });
    Object.defineProperty(el, 'scrollHeight', { get: () => el.need });
    Object.defineProperty(el, 'clientHeight', { get: () => (h && h !== 'auto' ? parseInt(h, 10) : 48) });
    el.writes = writes;
    return el;
}

const el = box(40);
el.value = 'h'; resize(el);
assert.deepStrictEqual(el.writes, ['auto', '40px'], 'the first word: measured once');
['he', 'hel', 'hell', 'hello'].forEach((v) => { el.value = v; resize(el); });
assert.strictEqual(el.writes.length, 2, 'more words on the same line: nothing measured again');
el.need = 62; el.value = 'hello, a second line'; resize(el);
assert.deepStrictEqual(el.writes.slice(2), ['auto', '62px'], 'the words outgrow the box: it grows');
el.need = 40; el.value = 'hello'; resize(el);
assert.deepStrictEqual(el.writes.slice(4), ['auto', '40px'], 'words taken away: it is measured and shrinks');
el.need = 300; el.value = 'x'.repeat(400); resize(el);
assert.strictEqual(el.style.height, '120px', 'never past 120 px');
assert.strictEqual(el.style.overflowY, 'auto', 'and then it scrolls inside');

// The composer's own box: not resized again on input; the CSS keeps it at 120 px.
assert.ok(/document\.addEventListener\('input', \(e\) => \{\n    if \(!e\.target\.classList\.contains\('chat-textarea'\)\) return;\n    const el = e\.target;\n[\s\S]{0,400}?if \(el\.closest\('form\.ovc-v2'\)\) return;/.test(src), 'the input listener leaves the composer\'s box to the composer');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
const rule = css.slice(css.indexOf('.fcw-input-area .chat-input-row .ovc-v2 textarea.chat-textarea {'));
assert.ok(/^[^}]*max-height: 120px;/.test(rule), 'the composer\'s chat box stops at 120 px');

console.log('chat-typing-resize: a key that still fits measures nothing; the composer grows its own box, to 120 px');
