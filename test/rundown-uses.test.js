/**
 * The Rundown's front page says what a visitor can do there (public/js/rundown.js _rdUses): catch up on a stream (the
 * stream-by-stream list), follow a topic (/rundown/topics), jump to the moment (the top take's second on OpenVibe.Video)
 * and get written up (/broadcast). A viewer said of the page "still don't rly know wtf to do with this feature"
 * (2026-10-20): it said what it is, never what it is for.
 *
 *   node test/rundown-uses.test.js
 */
'use strict';
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

const ctx = { videoHref: (kind, id, t) => `https://openvibe.video/${kind === 'clip' ? 'c' : 'v'}/${id}${t ? `?t=${t}` : ''}` };
vm.createContext(ctx);
vm.runInContext([pick('_rdEsc'), pick('_rdA'), pick('_rdUses')].join('\n'), ctx);

const links = (html) => [...html.matchAll(/<a class="rd-use" href="([^"]+)"/g)].map((m) => m[1]);
const titles = (html) => [...html.matchAll(/<b>([^<]+)<\/b>/g)].map((m) => m[1]);

const withLead = ctx._rdUses({ id: 7, vod_id: 5855, sec: 40, quotes: [{ text: 'x', sec: 95.6 }] });
assert.deepStrictEqual(titles(withLead), ['Catch up on a stream', 'Follow a topic', 'Jump to the moment', 'Get written up']);
assert.deepStrictEqual(links(withLead), ['#rd-latest-h', '/rundown/topics', 'https://openvibe.video/v/5855?t=95', '/broadcast'],
    'each entry goes somewhere: the list, the topics, the top take\'s moment (its quote\'s second), going live');
assert.ok(withLead.includes('aria-label="What you can do here"'));

const noLead = ctx._rdUses(null);
assert.deepStrictEqual(links(noLead), ['#rd-latest-h', '/rundown/topics', '/broadcast'], 'no recording to jump into: that entry is text, not a dead link');
assert.ok(noLead.includes('<div class="rd-use"><i class="fa-solid fa-play"'));

assert.match(js, /root\.innerHTML = `\$\{_rdMast\(d\.counts, 'latest'\)\}\$\{_rdUses\(d\.lead\)\}/, 'the front page shows it under the masthead');
assert.match(css, /@media \(max-width: 560px\) \{[^}]*\.rd-uses \{[^}]*\}[\s\S]*?\.rd-use small \{ display: none; \}/, 'phones show titles only, two by two');

console.log('rundown uses: all checks passed');
