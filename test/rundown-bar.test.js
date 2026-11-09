'use strict';
/**
 * The Rundown's bar: the state of a view is its URL (public/js/rundown.js), and a filtered view is never indexed
 * (server/seo/pages.js).
 *
 *   the URL    every filter is in it, and a view can be shared and the back button restores it
 *   the sheet  the phone's sheet has the same sections, 44 px controls and no width past 390 px
 *   indexing  a combination is noindex, with a canonical to the nearest page a crawler may keep
 *
 *   node test/rundown-bar.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const js = fs.readFileSync(path.join(__dirname, '../public/js/rundown.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/css/features/rundown.css'), 'utf8');
const pick = (name) => {
    const start = js.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} is in rundown.js`);
    const next = js.indexOf('\nfunction ', start + 1);
    return js.slice(start, next < 0 ? undefined : next);
};
const ctx = { URLSearchParams, console };
vm.createContext(ctx);
vm.runInContext([pick('_rdState'), pick('_rdQuery')].join('\n'), ctx);

// ── The state of a view is its URL ──
const state = ctx._rdState(new URLSearchParams('streamer=goosely&topic=drake-and-objectives&when=week&q=baron'));
assert.deepStrictEqual(state.q, 'baron');
assert.deepStrictEqual([...state.streamer], ['goosely']);
assert.strictEqual(state.topic, 'drake-and-objectives');
assert.strictEqual(state.when, 'week');
assert.strictEqual(ctx._rdQuery(state), '?q=baron&streamer=goosely&topic=drake-and-objectives&when=week',
    'every filter is in the URL, in one order');

const all = ctx._rdState(new URLSearchParams('streamer=a,b&topic=t&when=day&show=episodes&sort=reacted&video=1&following=1&mentions=1&q=x'));
assert.deepStrictEqual([...all.streamer], ['a', 'b'], 'several streamers may be picked');
assert.strictEqual(ctx._rdQuery(all), '?q=x&streamer=a%2Cb&topic=t&when=day&show=episodes&sort=reacted&video=1&following=1&mentions=1',
    'and they all live in the URL together');

const empty = ctx._rdState(new URLSearchParams(''));
assert.strictEqual(ctx._rdQuery(empty), '', 'an empty bar is the plain page');
assert.strictEqual(ctx._rdState(new URLSearchParams('show=everything&when=century')).show, '', 'an unknown filter is dropped');
assert.strictEqual(ctx._rdState(new URLSearchParams('q=baron')).q, 'baron', 'the words survive the round trip');

// The back button: the old URL is the old view, because nothing else keeps the state.
const before = ctx._rdState(new URLSearchParams('streamer=goosely'));
const after = ctx._rdState(new URLSearchParams('streamer=baron'));
assert.notStrictEqual(ctx._rdQuery(before), ctx._rdQuery(after), 'two views are two URLs');
assert.strictEqual(ctx._rdQuery(ctx._rdState(new URLSearchParams(ctx._rdQuery(before)))), ctx._rdQuery(before),
    'and the old URL restores the old view');

// ── The bar: the search, the chips, the keyboard ──
assert.match(js, /placeholder="Search topics, streamers, episodes"/, 'the search says what it searches without truncating a long phrase');
assert.strictEqual(ctx._rdQuery(ctx._rdState(new URLSearchParams('page=2'))), '?page=2', 'crawler pages have stable links');
assert.match(js, /rel="next"/, 'the feed exposes its next page');
assert.match(js, /setTimeout\(\(\) => _rdSearch\(value\), 250\)/, 'the results follow the typing, 250 ms later');
assert.match(js, /e\.key !== '\/'/, '"/" focuses the search');
assert.match(js, /data-rd-sheet="open"/, 'the phone has one Filters button');
assert.match(js, /class="rd-sheet" role="dialog" aria-modal="true"/, 'the sheet is a dialog');
for (const section of ['Streamer', 'Topic', 'When', 'Show', 'Sort']) {
    assert.ok(js.includes(`section('${section}'`), `the sheet has the ${section} section`);
}
assert.match(js, /data-rd-clear="all">Clear all/, 'the way out of all the filters');
assert.match(js, /More takes \(/, 'the folded takes are counted');

// ── The phone: 44 px controls, and nothing past 390 px ──
assert.match(css, /\.rd-sheet-btn-row \{[^}]*min-height: 44px/, 'the sheet\'s controls are 44 px');
assert.match(css, /\.rd-search \{[^}]*height: 44px/, 'the search box is 44 px');
assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*?\.rd-chipbar \{ display: none; \}[\s\S]*?\.rd-sheet-btn \{ display: inline-flex/, 'the phone shows the search box and the Filters button');
assert.match(css, /\.rd-sheet \{[^}]*left: 0; right: 0;/, 'the sheet is as wide as the phone');
assert.match(css, /\.rd-rails \{ display: none; \}[\s\S]*?@media \(max-width: 960px\) \{[\s\S]*?\.rd-rails \{ display: flex/, 'the rails are under the bar on the phone');

// ── Indexing: a combination is noindex, with a canonical ──
process.env.NODE_ENV = 'test';
const pages = require('../server/seo/pages');
(async () => {
const plain = await pages._pageMeta('/rundown', {});
assert.strictEqual(plain.robots, 'index,follow', 'the plain page is indexable');

const searched = await pages._pageMeta('/rundown', { query: { q: 'baron' } });
assert.strictEqual(searched.robots, 'noindex,follow', 'a search is never indexed');
assert.strictEqual(searched.canonicalPath, '/rundown', 'and points at the plain page');

const oneStreamer = await pages._pageMeta('/rundown', { query: { streamer: 'goosely' } });
assert.strictEqual(oneStreamer.robots, 'noindex,follow', 'a combination is never indexed');
assert.strictEqual(oneStreamer.canonicalPath, '/rundown/goosely', 'a single streamer points at that streamer\'s page');

const oneTopic = await pages._pageMeta('/rundown', { query: { topic: 'drake-and-objectives' } });
assert.strictEqual(oneTopic.canonicalPath, '/rundown/t/drake-and-objectives', 'a single topic points at that topic\'s page');

const many = await pages._pageMeta('/rundown', { query: { streamer: 'goosely', topic: 'drake', when: 'week' } });
assert.strictEqual(many.robots, 'noindex,follow', 'three filters are still one page to a crawler');
assert.strictEqual(many.canonicalPath, '/rundown', 'and point at the plain page');

// A topic page that exists keeps its own canonical; one that does not is a 404, as before.
const missing = await pages._pageMeta('/rundown/t/no-such-topic-here', { query: { when: 'week' } });
assert.strictEqual(missing, null, 'a topic that is not there is still a 404');

console.log('rundown bar: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
