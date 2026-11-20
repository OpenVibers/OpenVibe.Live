'use strict';
/**
 * The home's "cards per row" grids share one ResizeObserver (public/js/ov-density.js, 2026-11-19). Each grid had its own,
 * and each callback undid its clamp, read the grid's columns and wrote: the next grid's read forced the layout the last
 * one had just invalidated, once a grid. What this proves, with a small fake page:
 *   - attaching several grids makes one observer;
 *   - in one callback every grid is unclamped, then every grid is read, then every grid renders;
 *   - a callback with no width change does nothing.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const log = [];
let observers = 0, callback = null;
function grid(name, cols) {
    const g = {
        name, dataset: { ovdAuto: '1', ovdCols: '1' }, clientWidth: 900, previousElementSibling: null, isConnected: true,
        style: {
            setProperty(k, v) { log.push(`write ${name} ${k}=${v}`); },
            removeProperty(k) { log.push(`unclamp ${name} ${k}`); },
        },
        _cols: cols,
        getBoundingClientRect() { return { width: 900 }; },
        dispatchEvent() { return true; },
    };
    return g;
}
const sandbox = {
    window: {}, console,
    localStorage: { getItem: () => null, setItem() {} },
    CustomEvent: function CustomEvent(type, o) { this.type = type; this.detail = o && o.detail; },
    requestAnimationFrame: (f) => setTimeout(f, 0),
    getComputedStyle: (el) => { log.push(`read ${el.name}`); return { gridTemplateColumns: Array(el._cols).fill('140px').join(' ') }; },
    ResizeObserver: class { constructor(cb) { observers += 1; callback = cb; } observe() {} },
    document: { getElementById: () => ({}), createElement: () => ({ setAttribute() {}, appendChild() {} }), head: { appendChild() {} } },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public/js/ov-density.js'), 'utf8'), sandbox);

const a = grid('vods', 5), b = grid('clips', 4);
sandbox.OVDensity.attach(a, { key: 'vods' });
sandbox.OVDensity.attach(b, { key: 'clips' });
assert.strictEqual(observers, 1, 'one observer for every grid');

log.length = 0;
callback([{ target: a, contentRect: { width: 900 } }, { target: b, contentRect: { width: 900 } }]);
// The log's phases: the two unclamps, the two reads, then each render's writes (a render that keeps the stylesheet's own
// count removes the property again, which the fake logs as removeProperty too).
const kinds = log.map((l) => l.split(' ')[0]);
assert.deepStrictEqual(kinds.slice(0, 4), ['unclamp', 'unclamp', 'read', 'read'], `every grid is unclamped, then every grid is read: ${log.join(' | ')}`);
assert.ok(!kinds.slice(4).includes('read'), `nothing is read after the renders begin: ${log.join(' | ')}`);

log.length = 0;
callback([{ target: a, contentRect: { width: 900 } }, { target: b, contentRect: { width: 900 } }]);
assert.deepStrictEqual(log, [], 'no width change, nothing done');

// OVDensity.known (11-20): the columns without a layout read, 0 before the first measurement; the rails wait for it.
const c = grid('trending', 3);
c.dataset = {};
sandbox.OVDensity.attach(c, { key: 'trending' });
log.length = 0;
assert.strictEqual(sandbox.OVDensity.known(c), 0, 'not measured yet: 0');
assert.deepStrictEqual(log, [], 'known() reads nothing');
callback([{ target: c, contentRect: { width: 900 } }]);
assert.strictEqual(sandbox.OVDensity.known(c), 3, 'after the observer: the measured count');
c.dataset.ovdCols = '2';
assert.strictEqual(sandbox.OVDensity.known(c), 2, 'the reader\'s choice first');
const home = fs.readFileSync(path.join(__dirname, '..', 'public/js/app-home.js'), 'utf8');
const autofill = home.slice(home.indexOf('function homeRailAutofill('), home.indexOf('function homeRailSideways('));
assert.match(home, /OVDensity\.known\(rail\.grid\)/, 'the rail asks without forcing a layout');
assert.match(autofill, /const cols = homeRailKnownCols\(rail\);\s*if \(!cols\) return;/, 'and waits for ovd:columns until it is known');
const pager = home.slice(home.indexOf('function renderHomePagination('), home.indexOf('async function loadHomeChangelog('));
assert.match(pager, /homeRailKnownCols\(rail\) \|\| 4/, 'the pager counts without a layout read');
assert.ok(!/_homeRailCols\(/.test(pager), 'and never reads the grid itself');
assert.match(home, /addEventListener\('ovd:columns', \(\) => \{ homeRailAutofill\(rail\); if \(rail\.pager\) renderHomePagination\(rail\.pager, rail\); \}\)/, 'the measurement redraws the pager');

console.log('density: one observer, every grid unclamped, then read, then rendered; known() reads no layout');
