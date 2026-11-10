'use strict';
/**
 * A link to a live channel shows the stream, not a section under it (ask 285).
 *
 * The channel page names the section in view while the person scrolls, and a shared link copied from the address bar
 * could carry that #about. This pins the two halves of the fix:
 *
 *   - the page only writes a section into the address when the person chose one (a jump link), or when the address
 *     already named one; scrolling over a clean address leaves it clean;
 *   - opening /@name#about while the channel is live marks About's jump link and loads it, but does not scroll under
 *     the stream and drops the section from the address; offline it opens and scrolls as before;
 *   - the Share button, the cross-site history entry and a go-live card's Watch link all name the channel, no section.
 *
 *   node test/channel-hash-live.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const channelJs = read('public/js/app-channel.js');
const chatJs = read('public/js/chat.js');
const appJs = read('public/js/app.js');

/** One top-level function's source, braces matched (so a test runs the code the page runs). */
function source(src, name) {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} is in the page's script`);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`${name} never closes`);
}
const fn = source(channelJs, '_channelSectionHash');
const applyFn = source(channelJs, '_applyChannelHashTab');
const addressFn = source(channelJs, '_channelAddress');
const shareFn = source(channelJs, 'updateShareButton');
const cardFn = source(chatJs, '_chatEvSafeUrl');

const sectionHash = (hash, scrollY, fromTap, written = '') => new Function('env', `with (env) { ${fn}; return _channelSectionHash('videos', ${fromTap}); }`)({
    location: { hash }, window: { scrollY }, _chHashWritten: written,
    CHANNEL_TAB_HASHES: ['about', 'videos', 'agents', 'clips', 'clips-taken', 'pastes', 'media', 'analytics', 'ai-timeline'],
});

// ── Scrolling never adds a section to a clean address, and never eats an incoming one ──
assert.strictEqual(sectionHash('', 900, false), '', 'scrolling over a clean channel address leaves it clean');
assert.strictEqual(sectionHash('', 0, true), '#videos', 'a jump link the person chose does name its section');
assert.strictEqual(sectionHash('#about', 900, false), '#videos', 'an address already naming a section follows the one in view');
assert.strictEqual(sectionHash('#about', 0, false), '#about', 'a section somebody linked to survives until the load opens it');
assert.strictEqual(sectionHash('#about', 0, false, '#about'), '', 'a section this page wrote is cleared at the top');

// ── A live channel opened with a section shows the stream first; offline it opens the section ──
function openChannel({ live, hash }) {
    const location = { origin: 'https://openvibe.live', pathname: '/@alice', search: '', hash };
    const calls = { switched: [], replaced: [] };
    const btn = { style: { display: '' } };
    new Function('env', `with (env) { ${fn}; ${addressFn}; ${applyFn}; _applyChannelHashTab(${live}); }`)({
        location,
        CHANNEL_TAB_HASHES: ['about', 'videos', 'agents', 'clips', 'clips-taken', 'pastes', 'media', 'analytics', 'ai-timeline'],
        _chHashWritten: '',
        document: { querySelector: () => btn, getElementById: () => ({ classList: { contains: () => true } }) },
        setTimeout: (run) => run(),
        switchChannelTab: (tab, b, jump) => calls.switched.push({ tab, jump }),
        history: { state: null, replaceState: (state, title, url) => { calls.replaced.push(url); location.hash = ''; } },
    });
    return { location, calls };
}
{
    const live = openChannel({ live: true, hash: '#about' });
    assert.deepStrictEqual(live.calls.switched, [{ tab: 'about', jump: false }], 'live: About is marked, not scrolled to');
    assert.deepStrictEqual(live.calls.replaced, ['https://openvibe.live/@alice'], 'live: the section leaves the address');
    assert.strictEqual(live.location.hash, '', 'live: a copy of the address is the channel');
}
{
    const offline = openChannel({ live: false, hash: '#about' });
    assert.deepStrictEqual(offline.calls.switched, [{ tab: 'about', jump: true }], 'offline: About opens and scrolls as before');
    assert.deepStrictEqual(offline.calls.replaced, [], 'offline: the link keeps the section it named');
    assert.strictEqual(offline.location.hash, '#about');
}

// ── The Share button, cross-site history and a go-live card name the channel, no section ──
const shareUrl = (hash) => {
    const b = { dataset: {}, removeAttribute() {} };
    new Function('env', `with (env) { ${addressFn}; ${shareFn}; updateShareButton(null); }`)({
        location: { origin: 'https://openvibe.live', pathname: '/@alice', search: '', hash },
        currentStreamData: null,
        document: { title: 'Alice', getElementById: (id) => (id === 'ch-btn-share' ? b : null), querySelector: () => null },
    });
    return b.dataset.url;
};
assert.strictEqual(shareUrl('#about'), 'https://openvibe.live/@alice', 'Share does not hand over the section');
assert.strictEqual(shareUrl(''), 'https://openvibe.live/@alice');

assert.match(appJs, /const url = type === 'stream' \? `\$\{location\.origin\}\$\{location\.pathname\}` : location\.href;/,
    'a channel is remembered (cross-site history) as the channel, not the section in view');

const cardUrl = (url) => new Function('env', `with (env) { ${cardFn}; return _chatEvSafeUrl(${JSON.stringify(url)}); }`)({ window: { location: { origin: 'https://openvibe.live' } } });
assert.strictEqual(cardUrl('https://openvibe.live/@alice#about'), 'https://openvibe.live/@alice', 'a go-live card opens the channel');
assert.strictEqual(cardUrl('https://openvibe.live/@alice?section=videos'), 'https://openvibe.live/@alice', 'a section query is not part of the card');
assert.strictEqual(cardUrl('https://openvibe.live/vod/5#t=10'), 'https://openvibe.live/vod/5#t=10', 'a moment on a recording keeps its time');

console.log('channel hash, live: the stream first, no section in a shared or announced link');
