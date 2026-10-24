'use strict';
/**
 * Every page's shell carries one <h1>: its own. The home page (hero and lists), the Updates page and the Rundown
 * are fragments like the other pages, inlined only on their own route (server/web/assets.js renderRoute). Before
 * 2026-10-24 every page shipped the home hero's <h1> and the Updates page's, so a channel page had three, and
 * every page that was not the home page carried the home page's 37 KB of markup.
 *
 *   node test/shell-one-h1.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const assets = require('../server/web/assets');
try { assets.setSharedDir(require('openvibe-shared/files').dir); } catch { /* */ }

const doc = assets.document('index.html').html;
const h1s = (html) => (html.replace(/<template[\s\S]*?<\/template>/gi, '').match(/<h1\b/gi) || []).length;
assert.strictEqual(h1s(doc), 0, 'the bare shell has no page markup with an <h1>');

for (const url of ['/', '/@someone', '/updates', '/content', '/clips', '/moments', '/search', '/rundown', '/documentation', '/chat', '/dashboard', '/broadcast']) {
    const html = assets.renderRoute(doc, url);
    assert.ok(h1s(html) <= 1, `${url}: at most one <h1> (${h1s(html)})`);
    assert.strictEqual(html.includes('class="hero-tagline"'), url === '/', `${url}: the home hero ${url === '/' ? 'is' : 'is not'} in the page`);
}
for (const url of ['/', '/updates', '/content', '/moments', '/search', '/@someone']) {
    assert.strictEqual(h1s(assets.renderRoute(doc, url)), 1, `${url}: its page's <h1> is there from the first paint`);
}

// The home, Updates and Rundown pages are features with fragments, and the router waits for them.
const reg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'features.json'), 'utf8'));
for (const [feature, frag] of [['home', 'home'], ['updates', 'updates'], ['rundown', 'rundown']]) {
    assert.strictEqual(reg.features[feature].fragment, frag, `${feature} has its fragment`);
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'fragments', `${frag}.html`)), `${frag}.html exists`);
    assert.ok(doc.includes(`data-fragment="${frag}"><!--ov:fragment:${frag}-->`), `the shell holds ${frag}'s placeholder`);
}
assert.ok(reg.routes.some((r) => new RegExp(r.path).test('/updates') && r.features.includes('updates')), '/updates loads its feature');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
assert.ok(app.includes("whenRouteReady('updates', () => loadUpdatesPage())"), 'the Updates page fills once its markup is in');

// A route of another page keeps the home placeholder inactive; "/" keeps it active.
const active = (html) => [...html.matchAll(/<section id="(page-[a-z-]+)" class="page active"/g)].map((m) => m[1]);
assert.deepStrictEqual(active(assets.renderRoute(doc, '/')), ['page-home']);
assert.deepStrictEqual(active(assets.renderRoute(doc, '/rundown')), ['page-rundown']);
assert.deepStrictEqual(active(assets.renderRoute(doc, '/updates')), ['page-updates']);

console.log('shell one h1: all passed');
