/**
 * Legacy parity (roadmap D20): broadcasting from a phone.
 *
 * The broadcast page (public/fragments/broadcast.html, public/js/broadcast*.js) on a phone: an
 * inline, muted preview (iOS plays nothing else inline), the layout stacked for narrow and portrait
 * screens with safe-area insets, chat as a bottom sheet behind a floating button, a portrait camera
 * detected as such, camera capture that falls back to whatever the phone offers, a bottom-sheet
 * camera switcher that knows front from rear, the screen kept awake, and no screen-share control
 * where the browser cannot share its screen. The hosted WHIP publisher (public/whip-publisher.html)
 * is the other way to publish from a phone browser.
 *
 * The fix it came with: phone browsers have no getDisplayMedia, so a slot set to screen mode could
 * not go live from a phone at all (capture threw "getDisplayMedia is not a function"). It now
 * broadcasts the camera there and says so; the WHIP publisher greys out its Screen option.
 *
 * A real-browser pass at phone widths is `npm run test:browser` (test/browser/smoke.js); this file
 * is what `npm test` can check without a browser.
 *
 *   node test/mobile-broadcast.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const bc = read('public/js/broadcast.js');
const state = read('public/js/broadcast-state.js');
const devices = read('public/js/broadcast-devices.js');
const fragment = read('public/fragments/broadcast.html');
const css = read('public/css/broadcast.css') + read('public/css/features/broadcast.css');

/** The source of a top-level function declaration, braces matched (after its parameter list). */
function extract(src, name) {
    const m = new RegExp(`(?:async )?function ${name}\\(`).exec(src);
    assert.ok(m, `${name}() must exist`);
    let i = m.index + m[0].length;
    for (let parens = 1; parens; i++) { if (src[i] === '(') parens++; else if (src[i] === ')') parens--; }
    i = src.indexOf('{', i);
    let depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(m.index, i + 1);
    }
    throw new Error(`unbalanced ${name}`);
}
function run(src, names, fixtures) {
    const scope = new Proxy(fixtures, {
        has: (t, k) => typeof k === 'string',
        get: (t, k) => (k === Symbol.unscopables ? undefined : (k in t ? t[k] : globalThis[k])),
        set: (t, k, v) => { t[k] = v; return true; },
    });
    // eslint-disable-next-line no-new-func
    return new Function('scope', `with (scope) { ${src}\n return { ${names.join(', ')} }; }`)(scope);
}
const classList = () => { const s = new Set(); return { toggle: (c, on) => (on ? s.add(c) : s.delete(c)), contains: (c) => s.has(c) }; };
/** @media blocks whose query matches `query`, concatenated. */
function mediaBlocks(src, query) {
    let out = '';
    let at = 0;
    while ((at = src.indexOf(`@media ${query}`, at)) !== -1) {
        let i = src.indexOf('{', at);
        let depth = 0;
        const start = i;
        for (; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}' && --depth === 0) break;
        }
        out += src.slice(start, i + 1);
        at = i;
    }
    return out;
}

// ── the page on a phone ──
assert.match(read('public/index.html'), /<meta name="viewport" content="width=device-width, initial-scale=1\.0">/);
const preview = /<video id="bc-video-preview"[^>]*>/.exec(fragment)[0];
for (const attr of ['autoplay', 'playsinline', 'muted']) assert.ok(new RegExp(`\\b${attr}\\b`).test(preview), `the preview is ${attr}`);
console.log('OK phone viewport; the preview plays inline and muted');

const narrow = mediaBlocks(css, '(max-width: 768px)');
const portrait = mediaBlocks(css, '(max-width: 768px) and (orientation: portrait)');
assert.match(mediaBlocks(css, '(max-width: 1180px)'), /\.broadcast-layout \{[^}]*flex-direction: column;/, 'the workspace stacks below tablet width');
assert.match(narrow, /\.broadcast-main \{[^}]*overflow-y: auto;[^}]*padding-bottom: calc\(18px \+ env\(safe-area-inset-bottom, 0px\)\);/, 'the page scrolls clear of the home indicator');
assert.match(narrow, /\.bc-ctrl-buttons \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/, 'live controls in two thumb-sized columns');
assert.match(narrow, /\.bc-video-container video \{[^}]*max-height: clamp\([^)]*dvh[^)]*\);/, 'the preview never pushes the controls off screen');
assert.match(narrow, /#bc-chat-sidebar \{[^}]*position: fixed;[^}]*bottom: 0;/, 'chat becomes a bottom sheet');
assert.match(narrow, /#bc-chat-sidebar\.mobile-chat-open \{[^}]*transform: translateY\(0\);/);
assert.match(portrait, /\.bc-video-container\.bc-vertical-preview \{/, 'a portrait camera gets a taller preview');
console.log('OK the layout at phone widths: stacked, scrollable, safe-area aware, chat as a sheet');

// ── chat button, only while live on a phone ──
{
    const els = {
        'bc-mobile-chat-toggle': { style: { display: 'none' }, querySelector: () => ({ className: '' }) },
        'bc-chat-sidebar': { classList: classList() },
        'bc-chat-messages': { scrollTop: 0, scrollHeight: 900 },
        'bc-mobile-chat-badge': { style: {}, textContent: '3' },
    };
    const fx = {
        document: { getElementById: (id) => els[id] || null, body: { classList: classList() } },
        window: { innerWidth: 390 },
        broadcastState: { streams: new Map() },
        _bcMobileChatOpen: false,
    };
    const f = run([extract(bc, 'updateBroadcastMobileChatFab'), extract(bc, 'toggleBroadcastMobileChat')].join('\n'), ['updateBroadcastMobileChatFab', 'toggleBroadcastMobileChat'], fx);
    f.updateBroadcastMobileChatFab();
    assert.strictEqual(els['bc-mobile-chat-toggle'].style.display, 'none', 'not live: no button');
    fx.broadcastState.streams.set(1, {});
    f.updateBroadcastMobileChatFab();
    assert.strictEqual(els['bc-mobile-chat-toggle'].style.display, 'flex', 'live on a phone: the chat button');
    fx.window.innerWidth = 1280;
    f.updateBroadcastMobileChatFab();
    assert.strictEqual(els['bc-mobile-chat-toggle'].style.display, 'none', 'a desktop has the sidebar');
    f.toggleBroadcastMobileChat();
    assert.ok(els['bc-chat-sidebar'].classList.contains('mobile-chat-open') && fx.document.body.classList.contains('mobile-chat-visible'));
    assert.deepStrictEqual([els['bc-chat-messages'].scrollTop, els['bc-mobile-chat-badge'].textContent], [900, '0'], 'opens at the newest line, unread cleared');
    assert.match(fragment, /id="bc-mobile-chat-toggle" onclick="toggleBroadcastMobileChat\(\)"/);
    assert.match(bc, /window\.addEventListener\('resize'[\s\S]{0,200}updateBroadcastMobileChatFab\(\);/, 'rotation and resizing re-decide');
    console.log('OK chat button: only live on a phone, opens the sheet');
}

// ── capture and controls ──
{
    const capture = extract(bc, 'startMediaCapture');
    assert.match(capture, /facingMode: 'user'[\s\S]*_getUserMediaWithTimeout\(\{ video: true, audio: true \}\)[\s\S]*_getUserMediaWithTimeout\(\{ video: true \}\)/,
        'a phone that rejects the exact camera falls back to its front camera, then to anything it has');
    const hint = run(extract(devices, '_getCameraFacingHint'), ['_getCameraFacingHint'], {})._getCameraFacingHint;
    assert.deepStrictEqual(['Back Camera', 'camera2 0, facing back', 'Front Camera', 'FaceTime HD Camera', 'USB Cam'].map((label) => hint({ label })),
        ['environment', 'environment', 'user', 'user', null], 'the switcher knows front from rear');
    assert.match(fragment, /id="bc-btn-switch-cam" onclick="openCameraSwitcher\(\)"/);
    assert.match(fragment, /id="bc-camera-sheet"/, 'cameras are picked from a bottom sheet');
    assert.match(extract(state, 'acquireWakeLock'), /navigator\.wakeLock\.request\('screen'\)/, 'the phone does not sleep mid-stream');
    assert.match(bc, /permBtn\.addEventListener\('touchend'/, 'the permission button answers a tap');

    const els = { 'bc-btn-screenshare': { style: {}, title: '' }, 'bc-btn-switch-cam': { style: {} } };
    const fx = {
        document: { getElementById: (id) => els[id] || null },
        navigator: { mediaDevices: { getUserMedia() {} } },
        getActiveStreamState: () => ({ localStream: {} }),
    };
    run(extract(bc, 'syncBroadcastLiveButtonVisibility'), ['syncBroadcastLiveButtonVisibility'], fx).syncBroadcastLiveButtonVisibility();
    assert.deepStrictEqual([els['bc-btn-screenshare'].style.display, els['bc-btn-switch-cam'].style.display], ['none', ''], 'no screen-share button where it cannot work; Switch Cam stays');
    console.log('OK capture falls back, front/rear switcher, wake lock, no screen share on phones');

    // A screen-mode slot opened on a phone broadcasts the camera.
    const guard = capture.indexOf("if (s.screenShare && !navigator.mediaDevices?.getDisplayMedia) {");
    assert.ok(guard !== -1 && guard < capture.indexOf('getDisplayMedia(displayConstraints)'), 'checked before screen capture is attempted');
    assert.match(capture.slice(guard, guard + 400), /s\.screenShare = false;[\s\S]*toast\(/, 'it switches this capture to the camera, and says so');
    assert.ok(!/saveBroadcastSettings\(\)/.test(capture.slice(guard, guard + 400)), 'without saving over the slot\'s own mode');
    const ws = read('public/js/broadcast-workspace.js');
    assert.match(ws, /if \(browserMode === 'screen'\) \{\s*broadcastState\.selectedBrowserSource = 'screen';\s*broadcastState\.settings\.screenShare = true;/, 'the slot\'s screen mode comes back from browser_mode on a computer');
    console.log('OK a screen-mode slot goes live from a phone with the camera');
}

// ── the hosted WHIP publisher ──
{
    const whip = read('public/whip-publisher.html');
    assert.match(whip, /<meta name="viewport" content="width=device-width, initial-scale=1\.0">/);
    assert.match(whip, /<video id="whip-preview" autoplay muted playsinline><\/video>/);
    assert.match(whip, /@media \(max-width: 600px\) \{ \.row \{ grid-template-columns: 1fr; \} \}/, 'one column on a phone');
    assert.match(whip, /if \(!window\.isSecureContext\)/, 'explains the https requirement');
    assert.match(whip, /if \(!navigator\.mediaDevices\?\.getDisplayMedia\) \{\s*const screen = els\.source\.querySelector\('option\[value="screen"\]'\);\s*if \(screen\) \{ screen\.disabled = true;/, 'Screen is greyed out where the browser cannot share it');
    console.log('OK the WHIP publisher works from a phone browser');
}

console.log('\n✅ mobile broadcasting checks passed');
process.exit(0);
