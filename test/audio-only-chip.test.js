'use strict';
// Card chips for an audio-only recording or clip (Media#240/R4): the picture is Media's avatar card, and the card says
// "Audio". The chip is drawn only when the item says audio_only, so every other card is unchanged.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const between = (startMark, endMark) => { const a = js.indexOf(startMark); const b = js.indexOf(endMark, a); assert.ok(a >= 0 && b > a, startMark); return js.slice(a, b); };
const ctx = vm.createContext({});
vm.runInContext(`${between('function audioChip(item) {', '\nfunction formatDuration(')}\nthis.audioChip = audioChip;`, ctx);

const chip = ctx.audioChip({ audio_only: true });
assert.ok(chip.includes('class="stream-card-audio"') && chip.includes('Audio'), chip);
assert.ok(chip.includes('fa-microphone'), 'a microphone says why there is no picture');
assert.strictEqual(ctx.audioChip({ audio_only: 1 }), chip, 'Media may hand the boolean back as 1');
assert.strictEqual(ctx.audioChip({ audio_only: false }), '');
assert.strictEqual(ctx.audioChip({}), '');
assert.strictEqual(ctx.audioChip(null), '');

// The channel's VOD list and the home rails use it; the stylesheet places it on the picture.
const channel = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-channel.js'), 'utf8');
const home = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-home.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
assert.match(channel, /audioChip\(v\)/, 'the channel VOD list');
assert.match(home, /audioChip\(v\)/, 'the home recordings rail');
assert.match(home, /audioChip\(c\)/, 'the home clips rail');
assert.match(css, /\.stream-card-audio \{[^}]*position: absolute;[^}]*top: 8px; left: 8px;/);
console.log('audio-only chip: all passed');
