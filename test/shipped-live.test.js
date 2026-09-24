'use strict';
/**
 * Live shows what shipped through the network's shared system (openvibe-shared shipped.js, fed by
 * the network changelog), not its own git log: the hero one-liner, the home "Recent Changes" and
 * /updates. And the owner's copy rule: nothing Live writes calls itself "free" or "$0".
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// The shared views
const index = read('public/index.html');
assert.ok(/id="hero-latest" data-ov-shipped="latest" data-service="live" href="\/updates"/.test(index), 'the hero one-liner is the shared view');
const app = read('public/js/app.js');
assert.ok(app.includes("sc.src = '/shared/shipped.js'") && app.includes("sc.setAttribute('data-ov-shipped-src', '')"), 'shipped.js from this site\'s own /shared/ pin, with the footer\'s marker');
assert.ok(/shipped\.log\(container, \{ service: 'live'/.test(app), '/updates is the shared log');
const home = read('public/js/app-home.js');
assert.ok(home.includes('shipped.appendDays(container, entries, false)') && !home.includes("api('/updates"), 'home Recent Changes uses the shared renderer, not the git log');
assert.ok(!/latest\.innerHTML/.test(home), 'the old hero renderer is gone');
assert.ok(read('public/js/footer-live.js').includes("updates: '/updates'"), 'the footer links this site\'s log');
assert.ok(require('openvibe-shared/files').isBrowserFile('shipped.js'), 'Live serves /shared/shipped.js');

// No "free"/"$0" copy
const NO_FREE = /\b(free|no[- ]cost)\b|\$\s?0\b/i;
const routes = read('server/home/routes.js');
for (const list of ['FALLBACK_QUIPS', 'FALLBACK_AUDIENCES']) {
    const m = new RegExp(`const ${list} = \\[([\\s\\S]*?)\\];`).exec(routes);
    assert.ok(m, `${list} found`);
    for (const line of m[1].split('\n')) assert.ok(!NO_FREE.test(line), `${list}: ${line.trim()}`);
}
assert.ok(!NO_FREE.test(/tagline: '([^']*)'/.exec(read('public/js/footer-live.js'))[1]), 'footer tagline');
const slogan = read('server/ai/slogan-job.js');
assert.ok(!slogan.includes('Free & Open'), 'the slogan prompt does not ask for "free"');
assert.ok(/filter\(q => !_NO_FREE\.test/.test(slogan) && routes.includes('!NO_FREE.test(String(q))'), 'generated and stored slogans are filtered');
console.log('shipped-live: all checks passed');
