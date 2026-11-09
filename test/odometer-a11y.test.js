'use strict';
/**
 * ov-odometer.js draws each digit as a strip of 0-9 that rolls. Those strips were plain text, so a screen reader read a
 * counter of 1,234 as four runs of "0 1 2 3 4 5 6 7 8 9", and copying it pasted the same (11-09: found by the overlap
 * sweep flagging the hero's counters). Now the number itself sits in a visually hidden span that follows every update,
 * and the strips and cells are aria-hidden.
 *
 *   node test/odometer-a11y.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadLinkedom() {
    try { return require('linkedom'); }
    catch { return require(require.resolve('linkedom', { paths: [path.dirname(require.resolve('openvibe-shared/package.json'))] })); }
}
const { parseHTML } = loadLinkedom();
const { window, document } = parseHTML('<!doctype html><html><head></head><body><b id="n"></b></body></html>');
window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const ctx = vm.createContext({ window, document, setTimeout, requestAnimationFrame: window.requestAnimationFrame, Number, String });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ov-odometer.js'), 'utf8'), ctx);

/** The text a screen reader gets: every text node not inside an aria-hidden element. */
function spoken(el) {
    let out = '';
    const walk = (n) => {
        if (n.nodeType === 3) { out += n.textContent; return; }
        if (n.nodeType === 1 && n.getAttribute('aria-hidden') === 'true') return;
        for (const c of n.childNodes) walk(c);
    };
    walk(el);
    return out;
}

const el = document.getElementById('n');
window.OVNum.mount(el, 1234);
assert.strictEqual(spoken(el), '1,234', 'a screen reader hears the number, not the strips');
assert.strictEqual(el.querySelectorAll('.ovnum-digit[aria-hidden="true"]').length, 4, 'every rolling digit is hidden from it');
assert.strictEqual(el.querySelectorAll('.ovnum-cell[aria-hidden="true"]').length, 1, 'and the comma cell');
assert.strictEqual(el.querySelectorAll('.ovnum-sr').length, 1, 'one hidden copy of the value');

window.OVNum.set(el, 1300);       // same shape: the cells are reused and roll
assert.strictEqual(spoken(el), '1,300', 'the hidden value follows a roll');
window.OVNum.set(el, 98765);      // a new shape: rebuilt
assert.strictEqual(spoken(el), '98,765', 'and a rebuild');
assert.strictEqual(el.querySelectorAll('.ovnum-sr').length, 1, 'still one copy after a rebuild');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ov-odometer.js'), 'utf8');
assert.ok(/\.ovnum-sr\{position:absolute;width:1px;height:1px;[^}]*clip-path:inset\(50%\)/.test(src), 'the copy is visually hidden, not display:none');
console.log('odometer: screen readers and copy get the number; the rolling strips are hidden from them');
