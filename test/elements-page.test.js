'use strict';
/**
 * The Viewer Deck's page wiring, without a browser: the channel fragment carries the two `live.deck`
 * containers (live and offline), the channel feature loads the deck script, the script speaks to the
 * deck API and the channel's element-state frames, the stylesheet places the deck beside the player on
 * a computer and under it below 1180 px, and the OBS alerts page knows the element moment. The API and
 * the presses themselves are test/elements.test.js; this is the part a server test cannot see.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const fragment = read('public/fragments/channel.html');
assert.strictEqual((fragment.match(/<aside class="ch-deck"/g) || []).length, 2, 'a live deck and an offline deck');
assert.strictEqual((fragment.match(/data-surface="live\.deck"/g) || []).length, 1, 'the live deck names the live.deck surface');
assert.match(fragment, /id="ch-deck"/);
assert.match(fragment, /id="ch-deck-offline"/);

const features = JSON.parse(read('public/features.json'));
assert.ok(features.features.channel.js.includes('/js/viewer-deck.js'), 'the channel feature loads the deck script');

const deck = read('public/js/viewer-deck.js');
assert.match(deck, /\/channels\/' \+ encodeURIComponent\(/);
assert.match(deck, /element-state/);
assert.match(deck, /ovk-btn/);
assert.match(deck, /cannot|Not available|Sign in|While /);

const css = read('public/css/features/channel.css');
assert.match(css, /\.ch-deck \{/);
assert.match(css, /@media \(max-width: 1180px\)/);

const alerts = read('public/obs/alerts.html');
assert.match(alerts, /element: \{ icon:/, 'the OBS alerts page draws an element moment');

console.log('elements page: the deck markup, script and styles are wired');
process.exit(0);
