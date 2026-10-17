/**
 * The chat's emote picker closes (owner 2026-10-17, from a phone: "this ui sucks i cant close it stuck open"). The studio
 * hides the chat's emote button (the picker's only toggle), and a phone sends no click for a tap on plain text, so the
 * outside-click close never ran. Now: a × in the picker, any tap outside it (pointerdown), Escape, and the studio closes
 * a picker when it takes over. A page that never loaded the emotes loads them when the picker opens ("Loading emotes…",
 * not "No emotes found").
 *
 *   node test/emote-picker-close.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'emotes.js'), 'utf8');

function el(id, cls = '') {
    const node = {
        id, className: cls, style: { display: 'none' }, dataset: {}, innerHTML: '', value: '', placeholder: '', children: [],
        classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
        querySelector: (sel) => (sel === '.emote-picker-tabs' ? node.tabs : sel === '.emote-search' ? node.search : null),
        querySelectorAll: () => [],
        closest: (sel) => (node.within || []).find((x) => x.sel === sel)?.node || null,
    };
    return node;
}

const listeners = {};
const picker = el('bc-emote-picker', 'emote-picker');
picker.tabs = el('tabs');
picker.search = el('search');
const grid = el('bc-emote-picker-grid');
const els = { 'bc-emote-picker': picker, 'bc-emote-picker-grid': grid };
let loads = 0;
const ctx = {
    document: {
        addEventListener: (type, fn) => { listeners[type] = fn; },
        getElementById: (id) => els[id] || null,
        querySelector: (sel) => (sel === '#bc-emote-picker .emote-search' ? picker.search : null),
    },
    window: { addEventListener: (type, fn) => { listeners[`window:${type}`] = fn; } }, console, setTimeout, Promise, Map, Set,
    innerHeight: 800, getComputedStyle: (node) => ({ position: node.fixedSheet ? 'fixed' : 'absolute' }),
    api: async () => { loads++; return { defaults: [{ id: 'd1', code: 'LUL', url: 'https://x/1.png' }] }; },
};
vm.createContext(ctx);
vm.runInContext(`${src}\nthis.toggleEmotePicker = toggleEmotePicker; this.closeEmotePicker = closeEmotePicker; this.state = () => ({ open: _emotePickerOpen, loaded: emotesLoaded });`, ctx);

(async () => {
    // Opening on a page that never loaded the emotes: it says so while they load, then shows them.
    ctx.toggleEmotePicker('bc-chat-input');
    assert.strictEqual(picker.style.display, 'flex');
    assert.match(picker.tabs.innerHTML, /class="emote-picker-close"[^>]*onclick="closeEmotePicker\(\)"[^>]*aria-label="Close emotes"/, 'a × to close it');
    assert.match(grid.innerHTML, /Loading emotes…/);
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(loads, 1, 'the emotes load when the picker opens');
    assert.ok(ctx.state().loaded);

    // A tap inside the picker (or on its button) keeps it open; a tap anywhere else closes it.
    const inside = { closest: (sel) => (sel === '.emote-picker' ? picker : null) };
    listeners.pointerdown({ target: inside });
    assert.strictEqual(picker.style.display, 'flex');
    const onButton = { closest: (sel) => (sel === '.emote-picker-btn' ? {} : null) };
    listeners.pointerdown({ target: onButton });
    assert.strictEqual(picker.style.display, 'flex');
    listeners.pointerdown({ target: { closest: () => null } });   // a chat line
    assert.strictEqual(picker.style.display, 'none', 'a tap on a chat line closes it');
    assert.strictEqual(ctx.state().open, false);

    // Escape closes it; so does its × (closeEmotePicker, also what the phone studio calls when it takes over).
    ctx.toggleEmotePicker('bc-chat-input');
    assert.strictEqual(picker.style.display, 'flex');
    listeners.keydown({ key: 'Escape' });
    assert.strictEqual(picker.style.display, 'none');
    ctx.toggleEmotePicker('bc-chat-input');
    ctx.closeEmotePicker();
    assert.strictEqual(picker.style.display, 'none');
    assert.strictEqual(ctx.state().open, false);

    // On a phone the picker is a fixed sheet: it opens just above the message box instead of over it.
    const row = { getBoundingClientRect: () => ({ top: 600 }) };
    picker.fixedSheet = true;
    picker.closest = (sel) => (sel === '.chat-input-area' ? { querySelector: (q) => (q === '.chat-input-row' ? row : null) } : null);
    ctx.toggleEmotePicker('bc-chat-input');
    assert.strictEqual(picker.style.bottom, '204px', 'its bottom edge sits 4 px above the message box');
    assert.strictEqual(picker.style.maxHeight, '400px', 'at most half the screen');
    row.getBoundingClientRect = () => ({ top: 500 });
    listeners['window:resize']();
    assert.strictEqual(picker.style.bottom, '304px', 'and follows the box when the screen changes (the keyboard)');
    ctx.closeEmotePicker();
    picker.fixedSheet = false;
    ctx.toggleEmotePicker('bc-chat-input');
    assert.strictEqual(picker.style.bottom, '', 'desktop keeps the stylesheet placement');
    ctx.closeEmotePicker();

    const studio = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'broadcast-studio.js'), 'utf8');
    assert.match(studio.slice(studio.indexOf('function mount()'), studio.indexOf('function unmount()')), /closeEmotePicker\(\)/, 'the studio closes a picker when it mounts');
    // The GIF picker the chat's GIF button opens: the same rules (a ×, any tap outside, its own button left to toggle it).
    const gif = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'gif-picker.js'), 'utf8');
    assert.match(gif, /class="emote-picker-close gif-picker-close"[^>]*onclick="closeGifPicker\(\)"/);
    assert.match(gif, /document\.addEventListener\('pointerdown'[\s\S]{0,260}closest\('\.gif-btn'\)/);
    assert.ok(!/document\.addEventListener\('click'/.test(gif), 'no click-only close left');
    console.log('emote picker close: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
