'use strict';
// The home's hero is drawn from last visit's copy, then again when the fresh one lands; the collage places its cards at
// random, so the same pictures drawn twice jumped and cost a tablet ~30 ms (11-28). It is drawn again only when its
// pictures change, or when the collage is empty.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-home.js'), 'utf8');
const start = src.indexOf("let _heroMediaKey = '';");
const end = src.indexOf('\n}\n', src.indexOf('function _renderHeroData(data) {')) + 3;
assert.ok(start > 0 && end > start, 'the guard and _renderHeroData are in app-home.js');
const vm = require('vm');
let drawn = 0;
let collageHasCards = false;
const ctx = {
    startHeroRotation() {}, startHeroQuips() {}, startSloganCountdown() {}, renderHeroStats() {}, _cleanAudiences: (a) => a,
    renderHeroBackground() {}, renderHeroCollage() { drawn++; collageHasCards = true; },
    document: { querySelector: () => (collageHasCards ? {} : null) },
};
vm.createContext(ctx);
vm.runInContext(src.slice(start, end), ctx);
const render = (d) => vm.runInContext('_renderHeroData', ctx)(d);
const media = [{ kind: 'live', thumbnail: 'https://a.example/1.jpg', href: '/@a' }];
render({ media, moments: [] });
assert.strictEqual(drawn, 1, 'the cached copy draws the collage');
render({ media: media.map((m) => ({ ...m })), moments: [] });
assert.strictEqual(drawn, 1, 'the fresh copy with the same pictures does not redraw it');
render({ media: [...media, { kind: 'clip', thumbnail: 'https://a.example/2.jpg', href: '/c/2' }], moments: [] });
assert.strictEqual(drawn, 2, 'new pictures redraw it');
collageHasCards = false;
render({ media: [...media, { kind: 'clip', thumbnail: 'https://a.example/2.jpg', href: '/c/2' }], moments: [] });
assert.strictEqual(drawn, 3, 'an empty collage (a rebuilt page) is drawn again');
render(null);
assert.strictEqual(drawn, 3, 'no data: nothing drawn');
console.log('hero-collage-same-media: the collage is drawn again only when its pictures change or it is empty');
