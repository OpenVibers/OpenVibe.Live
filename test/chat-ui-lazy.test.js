'use strict';
/**
 * The chat UI is a lazy feature (public/features.json → chatUI): a page without chat does not
 * download public/js/chat.js (340 KB) or public/js/chat-shared.js. This checks the three ways it
 * could creep back:
 *
 *   1. the home page's own HTML must not name chat.js, chat-shared.js or chat-shared.css;
 *   2. the home page's idle prefetch (features.json → home.idle) must not reach the chat UI
 *      either — the prefetch downloads the files, so the chat UI in the channel feature's
 *      dependencies would put it back on every home page;
 *   3. every inline handler (onclick="…") in the shell or in a fragment that calls a function of
 *      the chat UI must be listed in the chatUI feature's stubs, or the click does nothing on a
 *      page where the chat has not loaded.
 *
 *   node test/chat-ui-lazy.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const reg = JSON.parse(fs.readFileSync(path.join(PUB, 'features.json'), 'utf8'));
const index = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const chatJs = fs.readFileSync(path.join(PUB, 'js', 'chat.js'), 'utf8');
let pass = 0;
const ok = (m) => { pass++; console.log('  ok -', m); };

const CHAT_UI = reg.features.chatUI;
assert.ok(CHAT_UI, 'features.json needs a chatUI feature');
assert.ok(CHAT_UI.js.includes('/js/chat.js') && CHAT_UI.js.includes('/js/chat-shared.js'), 'chatUI carries the chat scripts');
assert.ok(CHAT_UI.css.includes('/css/chat-shared.css'), 'chatUI carries the chat stylesheet');
assert.ok(CHAT_UI.js.indexOf('/js/chat-shared.js') < CHAT_UI.js.indexOf('/js/chat.js'), 'chat-shared.js loads before chat.js (it builds the menus chat.js shows)');

// 1. The home page names none of it.
// (The asset manifest lists every file with its hash; only a tag counts as a request. The
// <noscript> fallbacks are not fetched by a browser with JavaScript on.)
const assets = require('../server/web/assets');
const doc = assets.document('index.html').html;
const home = assets.renderRoute(doc, '/');
const noNoscript = (html) => html.replace(/<noscript>[\s\S]*?<\/noscript>/gi, '');
for (const gone of ['<script src="/js/chat.js', '<script src="/js/chat-shared.js', '<link rel="stylesheet" href="/css/chat-shared.css']) {
    assert.ok(!noNoscript(home).includes(gone), `the home page must not ship ${gone}`);
    assert.ok(!noNoscript(index).includes(gone), `index.html must not load ${gone} eagerly`);
}
ok('the home page ships neither the chat scripts nor the chat stylesheet');

// The pages that have chat ask for it.
for (const [url, want] of [['/@someone', '/js/app-channel.js'], ['/chat', '/js/app-chatpage.js'], ['/broadcast', '/js/broadcast.js']]) {
    const html = assets.renderRoute(doc, url);
    assert.ok(html.includes('<script src="/js/chat.js?v='), `${url} should load the chat UI`);
    assert.ok(html.includes('<script src="/js/chat-shared.js?v='), `${url} should load chat-shared.js`);
    assert.ok(html.includes(`<script src="${want}?v=`), `${url} should load ${want}`);
    assert.ok(html.indexOf('/js/chat.js?') < html.indexOf(`${want}?`), `${url}: the chat UI comes before ${want}`);
}
ok('the channel, chat and broadcast pages load the chat UI, and it comes first');

// 2. The home page's idle prefetch must not reach the chat UI either.
const featureDeps = (name, seen = new Set()) => {
    if (seen.has(name)) return seen;
    seen.add(name);
    for (const d of reg.features[name].deps || []) featureDeps(d, seen);
    return seen;
};
for (const route of reg.routes) {
    if (route.path !== '^/$') continue;
    for (const f of route.features) {
        const closure = featureDeps(f);
        assert.ok(!closure.has('chatUI'), `the home route's ${f} would pull the chat UI`);
        for (const idle of reg.features[f].idle || []) {
            const idleClosure = featureDeps(idle);
            assert.ok(!idleClosure.has('chatUI'), `the home page's idle prefetch of ${idle} would pull the chat UI`);
        }
    }
}
ok('the home page neither loads nor prefetches the chat UI');

// 3. Every inline handler that calls the chat UI is stubbed.
const chatFns = new Set();
for (const m of chatJs.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) chatFns.add(m[1]);
for (const m of chatJs.matchAll(/^window\.([A-Za-z_$][\w$]*)\s*=/gm)) chatFns.add(m[1]);
const stubs = new Set(CHAT_UI.stubs || []);
const markup = [index, ...fs.readdirSync(path.join(PUB, 'fragments')).map((f) => fs.readFileSync(path.join(PUB, 'fragments', f), 'utf8'))].join('\n');
const handlers = new Set();
for (const m of markup.matchAll(/\bon(?:click|mousedown|mouseup|contextmenu|change|input|keydown|submit|focus|focusin|blur|load|error)\s*=\s*"([^"]*)"/gi)) {
    for (const h of m[1].matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) handlers.add(h[1]);
}
const missing = [...handlers].filter((h) => chatFns.has(h) && !stubs.has(h));
assert.deepStrictEqual(missing, [], `these inline handlers call the chat UI but are not stubbed: ${missing.join(', ')}`);
ok(`${handlers.size} inline handlers checked; every one that calls the chat UI is stubbed`);

// The stubs are functions the chat UI really defines (features-registry.test.js checks this too).
for (const s of stubs) assert.ok(chatFns.has(s), `the stub ${s} is not defined by the chat UI`);

// The chat UI is not a dependency of anything: it is named by the routes that have chat, so the
// home page's prefetch of the channel page does not carry it.
for (const [name, f] of Object.entries(reg.features)) {
    if (name === 'chatUI') continue;
    assert.ok(!(f.deps || []).includes('chatUI'), `${name} depends on the chat UI`);
}
ok('the chat UI belongs to the routes, not to another feature');

console.log(`${pass} checks passed`);
