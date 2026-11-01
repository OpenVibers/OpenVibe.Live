'use strict';
// Topics live now (Live market outcome 2): the live streams' categories and tags, the AI's included, as one row of
// filters over the Live Now grid. The functions are public/js/app-home.js's own, run here against a small fake DOM.
//   node test/home-topics.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-home.js'), 'utf8');
const start = src.indexOf('const _TOPIC_STOP');
const end = src.indexOf('function streamCardHTML(');
assert.ok(start > 0 && end > start, 'app-home.js has the topics block before the card');
const block = src.slice(start, end);

// A fake document: the row and the grid's cards, enough for _homeTopicsSync and _homeTopicsApply.
function fakeDom(cardTopics) {
    const mk = (extra) => Object.assign({ hidden: false, dataset: {}, attrs: {}, children: [],
        setAttribute(k, v) { this.attrs[k] = v; }, append(...n) { this.children.push(...n); } }, extra);
    const chips = [];
    const row = mk({ hidden: true, replaceChildren(...n) { chips.length = 0; chips.push(...n); }, addEventListener(t, fn) { this.onclick = fn; },
        querySelectorAll: () => chips });
    const cards = cardTopics.map((t) => mk({ dataset: { topics: t } }));
    const grid = { querySelectorAll: () => cards };
    const document = {
        getElementById: (id) => (id === 'home-topics' ? row : id === 'stream-grid-live' ? grid : null),
        createElement: () => mk({ textContent: '' }),
    };
    return { document, row, chips, cards };
}
function load(dom) {
    const _capTag = (s) => String(s).split(' ').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
    return new Function('document', '_capTag', `${block}; return { _streamTopics, _homeTopicsSync, _homeTopicsApply, get topic() { return _homeTopic; } };`)(dom.document, _capTag);
}

// A stream's topics: category first, then its own tags and the AI's, normalized, meta words dropped.
{
    const t = load(fakeDom([]))._streamTopics({ category: 'gaming', tags: '["Speedrun"]', ai_tags: '["multiframe","open-world","Gaming","overlay","live"]' });
    assert.deepStrictEqual(t, ['gaming', 'speedrun', 'open world'], 'meta words out, dashes read as spaces, no repeats');
    assert.deepStrictEqual(load(fakeDom([]))._streamTopics({ ai_tags: 'not json', tags: null }), [], 'a malformed list is no topics');
    assert.deepStrictEqual(load(fakeDom([]))._streamTopics({ ai_tags: ['cozy'] }), ['cozy'], 'an array is read as it is');
}

const streams = [
    { category: 'gaming', ai_tags: '["fortnite"]' },
    { category: 'gaming', ai_tags: '["league"]' },
    { category: 'outdoors', ai_tags: '["hiking","stream"]' },
];

// One stream live: no row, whatever it is tagged.
{
    const dom = fakeDom(['gaming|fortnite']);
    load(dom)._homeTopicsSync(streams.slice(0, 1));
    assert.strictEqual(dom.row.hidden, true, 'one stream is not something to filter');
}

// Three live: All, then topics by how many streams have them, then A to Z.
{
    const dom = fakeDom(['gaming|fortnite', 'gaming|league', 'outdoors|hiking']);
    const m = load(dom);
    m._homeTopicsSync(streams);
    assert.strictEqual(dom.row.hidden, false);
    assert.deepStrictEqual(dom.chips.map((c) => c.dataset.topic), ['', 'gaming', 'fortnite', 'hiking', 'league', 'outdoors']);
    assert.strictEqual(dom.chips[0].attrs['aria-pressed'], 'true', 'All is pressed to begin with');
    assert.strictEqual(dom.chips[1].children[2].textContent, '2', 'Gaming counts two streams');

    // Picking a topic keeps the cards that have it; picking it again shows them all.
    dom.row.onclick({ target: { closest: () => dom.chips[1] } });
    assert.strictEqual(m.topic, 'gaming');
    assert.deepStrictEqual(dom.cards.map((c) => c.hidden), [false, false, true]);
    assert.strictEqual(dom.chips[1].attrs['aria-pressed'], 'true');
    dom.row.onclick({ target: { closest: () => dom.chips[1] } });
    assert.deepStrictEqual(dom.cards.map((c) => c.hidden), [false, false, false], 'the same chip again clears it');

    // The picked topic leaves the air: the filter lets go instead of showing an empty grid.
    dom.row.onclick({ target: { closest: () => dom.chips[4] } });
    assert.strictEqual(m.topic, 'league');
    m._homeTopicsSync([streams[0], streams[2]]);
    assert.strictEqual(m.topic, '', 'no stream has it any more');
}

// The card carries its topics for the filter, and the row sits over the grid, hidden until filled.
assert.match(src, /data-topics="\$\{esc\(topics\.join\('\|'\)\)\}"/, 'the card names its topics');
const frag = fs.readFileSync(path.join(__dirname, '..', 'public', 'fragments', 'home.html'), 'utf8');
assert.match(frag, /<div class="home-topics" id="home-topics" role="group" aria-label="[^"]+" hidden><\/div>\s*<div class="stream-grid" id="stream-grid-live">/);
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'features', 'home.css'), 'utf8');
assert.match(css, /\.stream-grid > \.stream-card\[hidden\] \{ display: none; \}/, 'a filtered card really goes');
assert.match(css, /\.home-topics \{[^}]*overflow-x: auto/, 'one sideways row, never a fold');
// The live dot stays a dot: the shared SVG glyph fills its box, so the box has the glyph's own size.
const style = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
assert.match(style, /\.section-header h2 > i\.live-dot \{\s*width: 1\.15em; height: 1\.15em;/, 'never width:auto');
console.log('home topics: all checks passed');
