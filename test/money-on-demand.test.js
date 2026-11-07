'use strict';
/**
 * Vibes, tips, subscriptions and channel points (vibes.js, opencoins.js) and the DM panel (messenger.js) are not on
 * every page (11-07, the owner: "make things faster and more optimized"; 31 KB that most visits never ran):
 *   - features.json → money comes with the pages that sell, tip or reward (channel, broadcast, dashboard), its
 *     inline handlers are stubs, and showModal() fetches it for a money modal on any other page;
 *   - features.json → messenger loads once someone is signed in, and the navbar's Messages waits for it.
 *   node test/money-on-demand.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const pub = (p) => fs.readFileSync(path.join(__dirname, '..', 'public', p), 'utf8');
const html = pub('index.html');
const reg = JSON.parse(pub('features.json')).features;
const app = pub('js/app.js');
const nav = pub('js/ov-navbar-live.js');

// Not on every page.
for (const f of ['vibes.js', 'opencoins.js', 'messenger.js', 'messenger.css']) {
    assert.ok(!new RegExp(`<(script|link)[^>]+/(js|css)/${f.replace('.', '\\.')}`).test(html), `${f} is not on every page`);
}

// The two features, and who depends on money.
assert.deepStrictEqual(reg.money.js, ['/js/vibes.js', '/js/opencoins.js']);
assert.deepStrictEqual(reg.messenger.js, ['/js/messenger.js']);
assert.deepStrictEqual(reg.messenger.css, ['/css/messenger.css']);
for (const name of ['channel', 'broadcast', 'dashboard']) assert.ok((reg[name].deps || []).includes('money'), `${name} brings money`);
// Every money function a fragment calls from an inline handler is a stub (or its page brings money).
for (const fn of ['openSubscribeForCurrentStream', 'toggleRewardsPanel', 'saveDashPointsConfig']) {
    assert.ok(reg.money.stubs.includes(fn), `${fn} is a stub`);
}

// showModal() builds money templates lazily and fetches money first; the sign-in modal never needs it.
assert.ok(/donate: \(\) => openvibeBucksDonateModal\(\),/.test(app) && /'buy-funds': \(\) => openvibeBucksBuyModal\(\),/.test(app)
    && /cashout: \(\) => openvibeBucksCashoutModal\(\),/.test(app) && /'add-reward': \(\) => addRewardModal\(\),/.test(app), 'money templates are built only when asked for');
assert.ok(/if \(MONEY_MODALS\.has\(id\) && typeof openvibeBucksDonateModal !== 'function' && window\.ov && ov\.load\) \{\n\s*ov\.load\('money'\)\.then\(\(\) => showModal\(id\)\)/.test(app), 'a money modal fetches money first');
assert.ok(/function openChannelRewards\(\) \{[\s\S]{0,200}ov\.load\('money'\)/.test(app), 'the rewards button fetches money');

// The DM panel: on sign-in, and from the navbar's Messages.
assert.ok(/if \(currentUser && window\.ov && ov\.load\) ov\.load\('messenger'\)/.test(app), 'messenger loads on sign-in');
assert.ok(/messages: \{ onOpen: \(\) => \{[^\n]*ov\.load\('messenger'\)/.test(nav), 'the navbar\'s Messages loads it if needed');

console.log('money on demand: vibes, opencoins and messenger load only where they are used');
