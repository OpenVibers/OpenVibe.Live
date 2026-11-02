/**
 * The home's Economy row (public/js/app-home.js): the money four (Vibes tipped, Supporters, Vibes bought, Subs) count
 * from the Vibes relaunch. While all four are zero they are one chip, "None yet · Tips and subs · since 17 Oct", not
 * four bare zeros that read as a dead site; any one of them above zero brings all four back. Nothing is hidden: the
 * chip's tip names each of the four.
 *
 *   node test/home-economy-fresh.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-home.js'), 'utf8');

/** Render the stat board for `stats` with a stand-in page; returns the board's markup. */
function board(stats) {
    const el = () => ({
        innerHTML: '', hidden: true, style: {}, dataset: {}, textContent: '', offsetHeight: 0,
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        querySelector: () => el(), querySelectorAll: () => [], addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    });
    const wrap = el();
    const document = { getElementById: (id) => (id === 'hero-stats' ? wrap : null), querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, documentElement: el(), body: el(), readyState: 'complete' };
    const window = { matchMedia: () => ({ matches: true, addEventListener() {} }), addEventListener() {}, location: { pathname: '/' } };
    const ctx = vm.createContext({ document, window, console, requestAnimationFrame: () => {}, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, localStorage: { getItem: () => null, setItem() {} }, navigator: {},
        // app.js's globals the board uses.
        esc: (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
        _fmtCount: (n) => String(Number(n) || 0) });
    vm.runInContext(src, ctx, { filename: 'app-home.js' });
    vm.runInContext('_renderHeroStats', ctx)(stats);
    return wrap.innerHTML;
}

const FOUR = ['Vibes tipped', 'Supporters', 'Vibes bought', 'Subs'];
const base = { recent: {}, concurrency: {}, liveNow: 0, viewersNow: 0, coinsEarned: null, pointsEarned: 5, pointsSpent: 1, goalsActive: 0, economySince: '2026-10-17' };

const zero = board({ ...base, vibesTipped: 0, supporters: 0, vibesBought: 0, activeSubs: 0 });
assert.ok(zero.includes('hero-stat--fresh'), 'all four at zero: one chip');
assert.ok(zero.includes('<span class="hero-stat-word">None yet</span>'));
assert.ok(zero.includes('Tips and subs · since 17 Oct'), 'it says since when');
FOUR.forEach((word) => assert.ok(!zero.includes(`<span class="hero-stat-label">${word}`), `${word}: not a bare zero of its own`));
assert.match(zero, /No tips, supporters, Vibes bought or subscriptions yet since the Vibes relaunch on 17 Oct/, 'the tip names all four');

const one = board({ ...base, vibesTipped: 500, supporters: 1, vibesBought: 0, activeSubs: 0 });
assert.ok(!one.includes('hero-stat--fresh'), 'a first tip brings the four back');
FOUR.forEach((word) => assert.ok(one.includes(`<span class="hero-stat-label">${word}`), word));

// Billing not answering (null) is not "none yet": the chips stay as they were.
const unknown = board({ ...base, vibesTipped: 0, supporters: 0, vibesBought: null, activeSubs: null });
assert.ok(!unknown.includes('hero-stat--fresh'));

// No reset date: the chip leaves the date out.
const noDate = board({ ...base, economySince: null, vibesTipped: 0, supporters: 0, vibesBought: 0, activeSubs: 0 });
assert.ok(noDate.includes('<span class="hero-stat-label">Tips and subs</span>'));

console.log('home economy fresh: all checks passed');
