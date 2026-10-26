/**
 * The volume stays adjustable on a phone (owner, 2026-10-26: "can't easily adjust volume" on mobile). Under 480px the
 * channel player's bar has no room for the slider (2026-10-25), so a tap on the speaker also pops the slider up above
 * it for a few seconds (stream-player.js popVolume, channel.css .is-popped). Not where a page cannot set the volume
 * (an iPhone's Safari): there the speaker mutes and the phone's own buttons set the level.
 *
 *   node test/phone-volume.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const player = fs.readFileSync(path.join(root, 'public/js/stream-player.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/features/channel.css'), 'utf8');

// _volumeSettable: true where an audio element takes a volume, false where it stays 1 (iOS Safari), asked once.
const fn = /\/\*\* Whether this browser lets a page set[\s\S]*?\nfunction _volumeSettable\(\) \{[\s\S]*?\n\}\n/.exec(player);
assert.ok(fn, '_volumeSettable() is in stream-player.js');
for (const [fixed, want] of [[false, true], [true, false]]) {
    let made = 0;
    const ctx = { Math, document: { createElement: () => { made++; let v = 1; return { get volume() { return v; }, set volume(x) { if (!fixed) v = x; } }; } } };
    vm.createContext(ctx);
    vm.runInContext(`${fn[0]}; this.f = _volumeSettable;`, ctx);
    assert.strictEqual(ctx.f(), want, fixed ? 'an iPhone: no slider' : 'Android, desktop: the slider');
    ctx.f();
    assert.strictEqual(made, 1, 'asked once');
}

// The speaker and the slider pop it up; it only pops on a narrow screen that can set the volume.
assert.match(player, /btnVol\.onclick = \(\) => \{\n\s+popVolume\(\);/);
assert.match(player, /volSlider\.oninput = \(\) => \{\n\s+popVolume\(\);/);
assert.match(player, /matchMedia\('\(max-width: 480px\)'\)\.matches \|\| !_volumeSettable\(\)\) return;/);
assert.match(player, /setTimeout\(\(\) => volGroup\.classList\.remove\('is-popped'\), 3500\)/);
// The bar still hides the slider under 480px; the popped one shows above the speaker.
const narrow = /@media \(max-width: 480px\) \{([\s\S]*?)\n\}\n/.exec(css.slice(css.indexOf("The player's controls on a narrow phone")));
assert.ok(narrow && /\.vc-volume-group \.volume-slider \{ display: none !important; \}/.test(narrow[1]));
assert.match(narrow[1], /\.vc-volume-group\.is-popped \.volume-slider \{\s*display: block !important; position: absolute;[^}]*bottom: calc\(100% \+ 10px\)/);
console.log('✅ phone volume: the slider pops above the speaker on a narrow phone that can set the volume');
