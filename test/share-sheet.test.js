'use strict';
/**
 * The one Share button (openvibe-shared 4.114.0): Live's own share links are gone, and every page that shares
 * something carries one [data-ov-share-sheet] button, built like the shared kit's (kit.share): the same quiet
 * button with the same share icon on every OpenVibe site.
 *
 * Live's pages are drawn by the browser (the channel page, the recap), so what this checks is what the server
 * sends and what the page's own scripts put on the button.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const channel = read('public/fragments/channel.html');
const app = read('public/js/app.js');
const appChannel = read('public/js/app-channel.js');
const recap = read('public/js/recap.js');
const guides = read('public/js/guides-live.js');

// The button is the kit's: a quiet kit button with the share icon.
assert.ok(app.includes('class="ovk-btn ovk-btn--quiet"'), "the kit's quiet button");
assert.ok(app.includes("<svg class=\"ovk-i\" viewBox=\"0 0 24 24\""), 'the kit\'s share icon');
assert.ok(app.includes('data-ov-share-sheet'), 'the share attribute');

// The channel page: one Share button, in the stream's own action row.
const buttons = channel.match(/data-ov-share-sheet/g) || [];
assert.strictEqual(buttons.length, 1, 'the channel page has one Share button');
assert.ok(channel.includes('id="ch-btn-share"'), "it is the channel's Share button");
assert.ok(channel.includes('id="ch-share-slot"'), "and it sits in the stream's own action row");
assert.ok(channel.includes('class="ovk-btn ovk-btn--quiet"'), 'the kit\'s button');
assert.ok(!appChannel.includes('shareStreamUrl'), 'the old copy-the-link button is gone');
assert.ok(!read('public/css/features/channel.css').includes('ch-share-stream'), 'and so is its CSS');

// What it shares: the channel's own public address (never an internal or an API URL).
assert.ok(
    appChannel.includes('b.dataset.url = recording || `${location.origin}${location.pathname}`;'),
    "the button shares the channel page's own address",
);
assert.ok(appChannel.includes("b.dataset.timeFrom = '#video-element'"), 'a recording that plays can be shared from the moment it plays');
assert.ok(appChannel.includes("videoHref('vod', dvr.vodId)"), 'a recording that plays is shared as that recording');

// The recap page: one Share button, with the recap's own address.
assert.strictEqual((recap.match(/shareButtonHtml\(/g) || []).length, 1, 'the recap page has one Share button');
assert.ok(recap.includes('const shareUrl = `${location.origin}/recap/${id}`;'), "the recap's own address");
assert.ok(!recap.includes('twitter.com/intent'), 'the old X link is gone');

// The guide task that posted on X now offers the sheet.
assert.strictEqual((guides.match(/shareButtonHtml\(/g) || []).length, 1, 'the guide offers the sheet');
assert.ok(!guides.includes('twitter.com/intent'), 'the old X link is gone');

// No page of the site keeps a link that shares the page by hand any more.
for (const rel of ['public/js/recap.js', 'public/js/guides-live.js', 'public/js/app-channel.js', 'public/fragments/channel.html']) {
    const src = read(rel);
    for (const old of ['twitter.com/intent', 'x.com/intent', 'bsky.app/intent', 'reddit.com/submit', 'wa.me/?text', 't.me/share/url']) {
        assert.ok(!src.includes(old), rel + ' still has ' + old);
    }
}

console.log('share sheet: all checks passed');
