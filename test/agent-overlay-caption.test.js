/**
 * Agent Streams S4: the captions in the overlay (2026-11-06).
 *
 * The design names this test: 'the captions in the overlay and as WebVTT'. The WebVTT half is in
 * test/agent-streams-s4.test.js (the captions.vtt route). This file runs the real overlay script in a DOM
 * (linkedom, as the home-page tests do) and checks that the line the agent said is drawn as a caption, that
 * the caption is text and never markup, and that the voice and the personality are labelled.
 *
 *   node test/agent-overlay-caption.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// linkedom is a declared dependency of openvibe-shared; resolve it the way the home-page tests do.
function loadLinkedom() {
    try { return require('linkedom'); }
    catch { return require(require.resolve('linkedom', { paths: [path.dirname(require.resolve('openvibe-shared/package.json'))] })); }
}
const { parseHTML } = loadLinkedom();

const overlayScript = fs.readFileSync(path.join(__dirname, '../public/js/agent-overlay.js'), 'utf8');
const pageScript = fs.readFileSync(path.join(__dirname, '../public/js/agent-stream.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/css/features/agent-stream.css'), 'utf8');

let failures = 0;
function check(name, fn) {
    try { fn(); console.log('  ok', name); }
    catch (e) { failures++; console.log('  x', name, '\n     ', e.message); }
}

/** The overlay script in a DOM: the file the page loads, in a window with a stage to draw on. */
function openOverlay() {
    const { window } = parseHTML('<!doctype html><html><body><div id="stage"></div></body></html>');
    const store = new Map();
    const localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: (k) => { store.delete(k); },
        clear: () => store.clear(),
        key: (i) => [...store.keys()][i] || null,
        get length() { return store.size; },
    };
    const context = vm.createContext({ window, document: window.document, localStorage, console });
    vm.runInContext(overlayScript, context);
    const host = window.document.getElementById('stage');
    const overlay = window.AgentOverlay.create({ host, title: 'An AI agent is working' });
    return { window, overlay, host };
}

const STEPS = [{ title: 'Run the test suite', status: 'passed', detail: '5 of 5' }];

check('the line the agent said is drawn as a caption under the step', () => {
    const { overlay, window } = openOverlay();
    overlay.update({ steps: STEPS, caption: 'Tests passed. Nothing on fire.', voice: { personality: 'dry', voice: 'gary' } });
    const caption = window.document.querySelector('.agent-overlay-caption');
    assert.ok(caption, 'the overlay has a caption element');
    assert.strictEqual(caption.textContent, 'Tests passed. Nothing on fire.');
    assert.strictEqual(caption.hidden, false, 'the caption is shown while there is a line');
});

check('no line, no caption', () => {
    const { overlay, window } = openOverlay();
    overlay.update({ steps: STEPS, caption: '' });
    const caption = window.document.querySelector('.agent-overlay-caption');
    assert.ok(caption, 'the overlay has a caption element');
    assert.strictEqual(caption.hidden, true, 'the caption is hidden when nothing was said');
    assert.strictEqual(caption.textContent, '', 'and it holds no text');
});

check('the caption is text, never markup', () => {
    const { overlay, window } = openOverlay();
    const nasty = 'im <img src=x onerror=alert(1)> fine';
    overlay.update({ steps: STEPS, caption: nasty });
    const caption = window.document.querySelector('.agent-overlay-caption');
    assert.strictEqual(caption.textContent, nasty, 'the line is shown as written');
    assert.strictEqual(caption.children.length, 0, 'nothing was turned into an element');
});

check('the caption sits with the steps, not in the timeline sheet', () => {
    const { overlay, window } = openOverlay();
    overlay.update({ steps: STEPS, caption: 'A line.' });
    const body = window.document.querySelector('.agent-overlay-body');
    const kids = Array.from(body.children).map((c) => c.className);
    assert.ok(kids.indexOf('agent-overlay-caption') > kids.indexOf('agent-overlay-step'), 'the caption is under the step');
});

check('the overlay labels the voice and the personality', () => {
    const { overlay, window } = openOverlay();
    overlay.update({ steps: STEPS, caption: 'Still going.', voice: { personality: 'roast', voice: 'onyx' } });
    const label = window.document.querySelector('.agent-overlay-voice');
    assert.ok(label, 'the overlay has a voice label');
    assert.strictEqual(label.textContent, 'roast voice · onyx');
    assert.strictEqual(window.document.querySelector('.agent-overlay').getAttribute('data-voice'), 'roast');
});

check('a muted voice says so, and a paused one says so too', () => {
    const { overlay, window } = openOverlay();
    overlay.update({ steps: STEPS, caption: 'Quiet now.', voice: { personality: 'calm', voice: 'aria', muted: true } });
    assert.strictEqual(window.document.querySelector('.agent-overlay').getAttribute('data-voice'), 'Voice muted');
    overlay.update({ steps: STEPS, caption: 'Quiet now.', voice: { personality: 'calm', voice: 'aria', paused: true } });
    assert.strictEqual(window.document.querySelector('.agent-overlay').getAttribute('data-voice'), 'Voice paused');
});

check('no voice, no label', () => {
    const { overlay, window } = openOverlay();
    overlay.update({ steps: STEPS, caption: 'No voice here.' });
    const label = window.document.querySelector('.agent-overlay-voice');
    assert.strictEqual(label.hidden, true, 'the label is hidden when there is no voice');
    assert.strictEqual(window.document.querySelector('.agent-overlay').getAttribute('data-voice'), null);
});

check('the page hands the overlay the newest line as the caption', () => {
    assert.match(pageScript, /caption: captionText\(\)/, 'the overlay is given the caption');
    assert.match(pageScript, /const line = lines\[lines\.length - 1\];/, 'the newest line');
    assert.match(pageScript, /return line && line\.text \? line\.text : '';/, 'and its text');
    assert.ok(pageScript.includes('?after='), 'the page asks only for the lines it has not seen');
});

check('the caption is drawn, and hidden again when there is nothing to say', () => {
    assert.match(css, /\.agent-overlay-caption \{/, 'the caption has a style');
    assert.match(css, /\.agent-overlay-caption\[hidden\] \{ display: none; \}/, 'and disappears when empty');
    assert.match(css, /\.agent-overlay-voice \{/, 'the voice label has a style');
});

console.log(failures ? failures + ' failed' : 'all passed');
process.exit(failures ? 1 : 0);
