'use strict';
/**
 * /css/broadcast.css (the broadcast desk's styles, 11 KB) is not on every page (11-07, the owner: "make things faster
 * and more optimized"): the broadcast desk and the dashboard (its settings rows) bring it through features.json.
 *   node test/broadcast-css-on-demand.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const pub = (p) => fs.readFileSync(path.join(__dirname, '..', 'public', p), 'utf8');
const html = pub('index.html');
const reg = JSON.parse(pub('features.json')).features;

assert.ok(!/<link[^>]+href="\/css\/broadcast\.css"/.test(html), 'broadcast.css is not on every page');
assert.ok(reg.broadcast.css.includes('/css/broadcast.css'), 'the broadcast desk brings it');
assert.ok(reg.dashboard.css.includes('/css/broadcast.css'), 'the dashboard brings it (its settings rows)');
// What it styles outside the desk: the dashboard's settings rows, and nothing else in the shared shell.
assert.ok(pub('fragments/dashboard.html').includes('settings-row-content'), 'the dashboard still uses its settings rows');
for (const cls of ['bc-camera-sheet', 'settings-row-content']) {
    assert.ok(!html.includes(cls), `${cls} is not in the shared shell`);
}

console.log('broadcast css on demand: only the broadcast desk and the dashboard load broadcast.css');
