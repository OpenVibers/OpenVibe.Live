'use strict';
// A direct visit paints the right page and nothing on it jumps when the data lands (CLS): the server marks the route's
// own section active (server/web/assets.js activePage) and the router takes it as the current page; the channel, VOD
// and clip pages hold back the parts that arrive on their own until they are all in; the player keeps a 16:9 box; the
// home hero reserves its countdown line, its "shipped" line and its stats board; and the widgets built before their
// stylesheets stay out of the page. Without JavaScript none of that waiting applies.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const assets = require('../server/web/assets');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0;
const ok = (m) => { pass++; console.log(`  ✓ ${m}`); };

// ── The route's own page is active from the first paint ──
const doc = assets.document('index.html').html;
const active = (html) => [...html.matchAll(/<section id="(page-[a-z-]+)" class="page active"/g)].map((m) => m[1]);
assert.deepStrictEqual(active(doc), ['page-home'], 'the shell itself shows home');
for (const [url, page] of [
    ['/', 'page-home'], ['/@someone', 'page-channel'], ['/vod/12', 'page-vod-player'], ['/clip/7', 'page-clip-player'],
    ['/chat', 'page-chat'], ['/content', 'page-content'], ['/dashboard', 'page-dashboard'],
]) {
    assert.deepStrictEqual(active(assets.renderRoute(doc, url)), [page], `${url}: only ${page} is active`);
}
// A route without a section of its own keeps home (the router shows its page as before).
assert.deepStrictEqual(active(assets.renderRoute(doc, '/settings')), ['page-home'], '/settings: unchanged');
const app = read('public/js/app.js');
assert.match(app, /let currentPage = \(\(document\.querySelector\('section\.page\.active'\) \|\| \{\}\)\.id \|\| 'page-home'\)\.replace\(\/\^page-\/, ''\);/,
    'the router starts from the page the server shows, so its first showPage() is not a change');
ok('a direct visit shows the route\'s own section, and the router starts from it');

// ── Channel: placeholder outlines, tabs held back, page height kept ──
const chJs = read('public/js/app-channel.js');
const chCss = read('public/css/features/channel.css');
assert.ok(/function _channelReady\(ready = true\)/.test(chJs) && chJs.includes("page.classList.add('ch-data')") && chJs.includes('setTimeout(_channelReady, 2500)'), 'the channel marks its data and readiness, with a cap');
assert.ok(chJs.includes('offlineBlocks = _renderOfflineScreen(ch);') && chJs.includes('Promise.resolve(offlineBlocks).catch(() => {}).then(() => _channelReady());'), 'ready waits for the offline blocks above the tabs');
assert.ok(chJs.includes('return _fillOfflineExplore(ch && ch.username);') && chJs.includes('return renderOfflineDiscover(username, d);') && chJs.includes('return discovered;'), 'the offline screen resolves after "Most watched" and the discover board');
assert.ok(chCss.includes('#page-channel:not(.ch-ready) .channel-below-fold { display: none; }'), 'tabs out of the layout until ready');
assert.ok(chCss.includes('#page-channel.page:not(.ch-ready) { min-height: 100vh; }'), 'the page keeps a full viewport until ready (beats "#page-channel.page { min-height: 0 }")');
assert.ok(chCss.indexOf('#page-channel.page:not(.ch-ready)') > chCss.indexOf('#page-channel.page { min-height: 0; }'), '…after the rule it overrides');
assert.ok(/#page-channel:not\(\.ch-data\) :is\(#ch-display-name-offline/.test(chCss), 'placeholder words are outlines until the data');
ok('the channel holds its tabs and height until its data and offline blocks are in');

// ── VOD and clip pages ──
const mJs = read('public/js/app-media.js');
const mCss = read('public/css/features/media.css');
assert.ok(/function _mediaReady\(pageId, ready = true\)/.test(mJs) && /function _mediaHasData\(pageId\)/.test(mJs), 'one helper for both pages');
for (const [id, block] of [['page-vod-player', 'blocks.push(loadVodAiTimeline(v.id));'], ['page-clip-player', 'blocks.push(renderClipSourceCard(cl));']]) {
    assert.ok(mJs.includes(`_mediaReady('${id}', false);`) && mJs.includes(`_mediaHasData('${id}');`) && mJs.includes(`Promise.allSettled(blocks).then(() => _mediaReady('${id}'));`), `${id}: pending → data → ready`);
    assert.ok(mJs.includes(block), `${id}: waits for its own blocks`);
}
assert.ok(mJs.includes('blocks.push(renderVodContextStrip(v.id));'), 'the VOD also waits for the activity strip');
assert.ok(mCss.includes('#page-vod-player:not(.mp-ready) :is(#vp-ai-timeline, #vp-context, .vod-player-layout > .section-header, #vp-clips-grid, #vp-comments) { display: none; }'), 'VOD parts held back');
assert.ok(mCss.includes('#page-clip-player:not(.mp-ready) #clp-comments { display: none; }'), 'clip comments held back');
const style = read('public/css/style.css');
const player = /\.vod-player-container \{([^}]*)\}/.exec(style);
assert.ok(player && /aspect-ratio: 16 \/ 9;/.test(player[1]) && /max-height: 70vh;/.test(player[1]), 'the player keeps a 16:9 box (capped like the video) before the video knows its size');
ok('VOD and clip pages keep the player box and hold back the late parts');

// ── Home hero and early widgets ──
const index = read('public/index.html');
assert.ok(/<div class="hero-slogan-timer" id="hero-slogan-timer">&nbsp;<\/div>/.test(index), 'the countdown line is held from the first paint');
assert.ok(/<a class="hero-latest" id="hero-latest"[^>]*><\/a>/.test(index) && !/id="hero-latest"[^>]*\shidden>/.test(index), 'the shipped line is not hidden (shipped.js would collapse it, then refill it)');
const home = read('public/css/features/home.css');
assert.ok(home.includes('.hero-latest:empty { visibility: hidden; min-height: 33px; }'), 'the empty shipped line keeps its height, invisibly');
assert.ok(/\.hero-stats \{ margin: 16px 0 10px; gap: 10px; min-height: 120px; \}/.test(home) && home.includes('.hero-stats { min-height: 204px; }') && home.includes('.hero-stats { min-height: 256px; margin-top: 14px; }'),
    'the stats board reserves its loaded height, "Show all" button included');
const inline = /<style id="ovsk-css">([\s\S]*?)<\/style>/.exec(index)[1];
assert.ok(inline.includes('.cosmetics-modal-overlay:not(.active),.messenger-panel:not(.open){display:none}') && /\.messenger-toggle\{position:fixed;/.test(inline), 'closed widgets stay out of the page until their stylesheets land');
ok('the home hero reserves its late lines and the early widgets stay out of the flow');

// ── Without JavaScript ──
// The data never comes, so the pending-state rules apply only with scripting; and a route whose section is only filled
// by script says so, with links (the browser check needs 200 characters of text: /chat and /search had 89 and 107
// once a direct visit showed their own section instead of the home page, 2026-10-12).
const scriptingBlock = (css, rule) => {
    const at = css.indexOf(rule);
    const open = css.lastIndexOf('@media (scripting: enabled) {', at);
    return at > 0 && open !== -1 && css.slice(open, at).split('}').length - 1 < css.slice(open, at).split('{').length - 1;
};
for (const rule of ['#page-channel:not(.ch-ready) .channel-below-fold { display: none; }', '#page-channel:not(.ch-data) #ch-avatar-offline', '#page-channel.page:not(.ch-ready) { min-height: 100vh; }']) {
    assert.ok(scriptingBlock(chCss, rule), `channel.css: "${rule}" only with scripting`);
}
for (const rule of ['#page-vod-player:not(.mp-ready)', '#page-clip-player:not(.mp-ready) #clp-comments', ':is(#page-vod-player, #page-clip-player):not(.mp-data) :is(#vp-avatar']) {
    assert.ok(scriptingBlock(mCss, rule), `media.css: "${rule}" only with scripting`);
}
const noscriptText = (html) => ((/<noscript>([\s\S]*?)<\/noscript>/.exec(html) || [])[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
for (const frag of ['chat', 'search']) {
    const text = noscriptText(read(`public/fragments/${frag}.html`));
    assert.ok(text.length >= 200, `${frag}: ${text.length} characters without JavaScript`);
}
ok('without JavaScript nothing waits for data, and the script-only routes say what needs it');

console.log(`first-paint-stability: ${pass} checks passed`);
