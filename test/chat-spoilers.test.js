/**
 * Spoilers in chat (a viewer, 2026-10-20: "add /spoiler command — discord has it"). ||hidden text|| anywhere in a
 * message, or /spoiler <text> (OpenVibe.Chat sends that as ||text||), shows as a bar until clicked.
 *
 * Runs the real public/js/chat-spoilers.js, chat-shared.js and emotes.js in a sandbox: the split happens on the raw text
 * before any HTML (a marker can never land inside a link's or an emote's attribute), emotes and links inside a spoiler
 * stay inside its span, a click or Enter shows it without opening a link inside, reply snippets and TTS mask it, and
 * the OBS overlay draws a bar nobody can click.
 *
 *   node test/chat-spoilers.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const listeners = {};
const ctx = {
    console, URL, Map, Set, Promise, setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem() {} },
    document: {
        addEventListener: (type, fn, capture) => { (listeners[type] = listeners[type] || []).push({ fn, capture }); },
        createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, classList: { add() {} } }),
        body: { appendChild() {} },
        getElementById: () => null,
        querySelector: () => null,
    },
};
ctx.window = ctx;
ctx.addEventListener = () => {};
vm.createContext(ctx);
vm.runInContext(read('public/js/chat-shared.js'), ctx);
vm.runInContext(read('public/js/chat-spoilers.js'), ctx);
vm.runInContext(`${read('public/js/emotes.js')}\nthis.__setEmotes = (map) => { emoteMap = map; emotesLoaded = true; };`, ctx);
const chat = ctx.OpenVibeChat;
const sp = ctx.OpenVibeSpoilers;

// The split: only non-empty ||…|| pairs; an unmatched or empty pair stays text.
assert.deepStrictEqual(JSON.parse(JSON.stringify(sp.split('the ending ||he was the ghost|| lol'))), [
    { spoiler: false, text: 'the ending ' }, { spoiler: true, text: 'he was the ghost' }, { spoiler: false, text: ' lol' },
]);
assert.deepStrictEqual(JSON.parse(JSON.stringify(sp.split('a || b'))), [{ spoiler: false, text: 'a || b' }]);
assert.deepStrictEqual(JSON.parse(JSON.stringify(sp.split('|| ||'))), [{ spoiler: false, text: '|| ||' }]);

// The kiosk (its linkify through withSpoilers): a link inside a spoiler stays inside the span, and the text is escaped.
const kioskLinkify = (t) => sp.withSpoilers(t, chat.linkify);
const html = kioskLinkify('see ||https://example.com/end <b>x</b>|| now');
assert.match(html, /^see <span class="chat-spoiler" role="button" tabindex="0" aria-label="Spoiler, select to show"><a class="chat-link" href="https:\/\/example\.com\/end"/);
assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;</span> now'), 'escaped, and the span closes after the hidden part');

// A marker inside what looks like a URL is split first: no span in any attribute, no || left in an href.
const tricky = kioskLinkify('https://x.com/a||b" onmouseover="alert(1)||');
assert.ok(!/href="[^"]*(<|\|\|)/.test(tricky), 'nothing from a spoiler reaches an attribute');
assert.ok(!/onmouseover="alert/.test(tricky), 'the would-be handler stays escaped text');

// The site's renderer: emotes and links inside a spoiler render inside its span.
ctx.__setEmotes(new Map([['Kappa', { url: '/e/kappa.png' }]]));
const site = ctx.parseEmotes('lol ||Kappa he dies https://spoil.er|| Kappa');
assert.match(site, /^lol <span class="chat-spoiler"[^>]*><img class="chat-emote" src="\/e\/kappa\.png"[^>]*> he dies <a class="chat-link" href="https:\/\/spoil\.er"[^>]*>https:\/\/spoil\.er<\/a><\/span> <img class="chat-emote"/);
assert.strictEqual(ctx.parseEmotes('no spoiler here'), 'no spoiler here');

// Showing one: a capture-phase listener, so a link inside a hidden spoiler only reveals it.
const reveal = (listeners.click || []).find((l) => l.capture);
assert.ok(reveal && (listeners.keydown || []).some((l) => l.capture), 'click and keydown listeners in the capture phase');
const attrs = new Set(['role', 'tabindex', 'aria-label']);
const span = { classList: { list: new Set(), add(c) { this.list.add(c); } }, removeAttribute: (a) => attrs.delete(a) };
const ev = (extra) => ({ target: { closest: (sel) => (sel === '.chat-spoiler:not(.revealed)' && !span.classList.list.has('revealed') ? span : null) }, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra });
const keyTab = ev({ type: 'keydown', key: 'Tab' });
listeners.keydown.find((l) => l.capture).fn(keyTab);
assert.ok(!span.classList.list.has('revealed') && !keyTab.prevented, 'Tab moves on; only Enter or Space shows it');
const click = ev({ type: 'click' });
reveal.fn(click);
assert.ok(span.classList.list.has('revealed') && click.prevented && click.stopped, 'shown; the click goes no further (a link inside does not open)');
assert.strictEqual(attrs.size, 0, 'no longer a button once shown');
const again = ev({ type: 'click' });
reveal.fn(again);
assert.ok(!again.prevented, 'a shown spoiler is ordinary text: its links work');

// Nothing hidden shows in a reply snippet or is read aloud.
assert.strictEqual(sp.mask('lol ||he dies|| ok'), 'lol [spoiler] ok');
const chatJs = read('public/js/chat.js');
assert.ok(chatJs.includes('const _spoilFree = (t) => (window.OpenVibeSpoilers ? OpenVibeSpoilers.mask(t) : t);'));
assert.ok(chatJs.includes("esc(_spoilFree(msg.reply_to.message || ''))"), 'reply headers mask spoilers');
assert.ok(chatJs.includes('esc(_spoilFree(replyData.message))'), 'the reply bar masks spoilers');
assert.ok(chatJs.includes('OpenVibeChat.ttsReplaceLinks(_spoilFree(text), username)'), 'TTS does not read a spoiler aloud');

// Loaded with the chat, the popout and the kiosk, before what renders with it; not on the home page's first load.
const features = JSON.parse(read('public/features.json'));
const extras = (features.features || features).chatExtras.js;
assert.ok(extras.indexOf('/js/chat-spoilers.js') === 0 && extras.includes('/js/emotes.js'));
const popout = read('public/popout-chat.html');
assert.ok(popout.indexOf('/js/chat-spoilers.js') < popout.indexOf('/js/emotes.js'));
const kiosk = read('public/kiosk.html');
assert.ok(kiosk.includes('<script src="/js/chat-spoilers.js"></script>'));
assert.ok(kiosk.includes('OpenVibeSpoilers.withSpoilers(m.message||"", OpenVibeChat.linkify)'));
assert.ok(!read('public/index.html').includes('chat-spoilers.js'), 'not on the home page');

// The OBS overlay: a bar, never clickable, and its reply snippets masked.
const obs = read('public/obs/chat.html');
assert.match(obs, /`<span class="spoiler">\$\{parseEmotesPart\(m\[1\]\)\}<\/span>`/);
assert.match(obs, /\.spoiler \{ background: rgba\(255, 255, 255, 0\.35\); color: transparent;/);
assert.match(obs, /msg\.reply_to\.message \|\| ''\)\.replace\(SPOILER_RE/);

// Styles, and the command in the autocomplete list.
const css = read('public/css/chat-shared.css');
assert.match(css, /\.chat-spoiler \{[^}]*color: transparent;/);
assert.match(css, /\.chat-spoiler:not\(\.revealed\) \* \{ visibility: hidden; \}/);
assert.match(read('public/js/chat-autocomplete.js'), /name: 'spoiler'/);

console.log('chat spoilers: all checks passed');
