'use strict';
// Found by the browser check (OpenVibe.Host scripts/browser-check.js, WS-Q task 3) on /vod/… and /clip/…:
//   - the players' volume sliders had no accessible name (axe "label", critical); the channel player's too;
//   - a guest's page asked /api/coins/channel-balance, which answers 401 to a guest: a console error on every
//     channel, VOD and clip page. Only a signed-in viewer asks now.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
for (const f of ['fragments/vod-player.html', 'fragments/clip-player.html', 'fragments/channel.html']) {
    const html = pub(f);
    const ranges = html.match(/<input[^>]*type="range"[^>]*>/g) || [];
    assert.ok(ranges.length, `${f} has a volume slider`);
    for (const r of ranges) {
        const id = (r.match(/id="([^"]+)"/) || [])[1];
        const labelled = /aria-label="[^"]+"/.test(r) || /aria-labelledby="[^"]+"/.test(r) || (id && new RegExp(`<label[^>]*for="${id}"`).test(html));
        assert.ok(labelled, `${f}: ${r} has an accessible name`);
    }
}
assert.match(pub('js/app.js'), /if \(!_navPointsStreamerId \|\| !currentUser\) return;/, 'the navbar points chip asks only when signed in');
assert.match(pub('js/opencoins.js'), /if \(typeof currentUser !== 'undefined' && currentUser\) try \{\n\s*const coinData = await api\(`\/coins\/channel-balance/, 'the rewards panel asks only when signed in');
console.log('player a11y: sliders named; guests never ask for a channel balance');
