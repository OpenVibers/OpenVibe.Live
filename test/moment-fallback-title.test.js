'use strict';
/**
 * The title an auto clip or AI moment gets when the AI gives none (server/ai/ai-moments-job.js). A frame caption's
 * first clause titled public clips "A Man With A Beard Is Speaking To" (cut off on a dangling word, and about how
 * someone looks). Now: the caption's clause only when it reads as a title and says nothing about looks; otherwise
 * the stream's own title and the moment's time.
 *
 *   node --import ./test/helpers/pg-preload.mjs test/moment-fallback-title.test.js
 */
const assert = require('assert');
console.warn = () => {};
console.log = () => {};

const { fallbackTitle, captionTitle } = require('../server/ai/ai-moments-job')._internals;
// A clean caption keeps its words, without the dangling end.
assert.strictEqual(captionTitle('A car racing game appears on screen with a speedometer.'), 'A Car Racing Game Appears On Screen');
assert.strictEqual(captionTitle('A person is assembling a small robotic device on a desk.'), 'A Person Is Assembling A Small Robotic Device');
// Looks are never a title.
const looks = ['A man with a beard is speaking to the camera.', 'A person in a bright yellow high-visibility jacket.', 'A man with a puzzled expression sits in a chair.', 'A young boy plays a game.'];
looks.forEach((c) => assert.strictEqual(captionTitle(c), null, c));
const vod = { title: 'Fortnite!' };
assert.strictEqual(fallbackTitle(vod, 2480, 'A man wearing a headset sits in a gaming chair.'), 'Fortnite! at 41:20');
assert.strictEqual(fallbackTitle(vod, 2480, 'The Minecraft main menu is displayed with a panorama.'), 'The Minecraft Main Menu Is Displayed With A Panorama', 'a complete clause is kept whole');
assert.strictEqual(fallbackTitle({ title: '', username: 'goosely' }, 75, ''), "goosely's stream at 1:15");
assert.strictEqual(fallbackTitle({}, 0), 'Stream at 0:00');
assert.ok(fallbackTitle({ title: 'x'.repeat(200) }, 59).length <= 80, 'at most 80 characters');
// An AI title is kept unless it is about looks.
const { publicTitle } = require('../server/ai/ai-moments-job');
assert.strictEqual(publicTitle('Boss Fight Comeback', vod, 60, ''), 'Boss Fight Comeback');
assert.strictEqual(publicTitle('Red Beanie Moment', vod, 2480, 'A man wearing a red beanie looks up.'), 'Fortnite! at 41:20');
// The shared rule too (openvibe-sdk/no-looks via db.hasLooks): clip 483 was titled this on Live's home (2026-10-23).
assert.strictEqual(publicTitle('A Naked Man Lying On Their Back With Legs', vod, 2480, ''), 'Fortnite! at 41:20');
assert.strictEqual(publicTitle('Woman Laughs At Chat', vod, 2480, ''), 'Fortnite! at 41:20', 'a guessed gender is a look');
assert.strictEqual(captionTitle('A naked man lies on a bed near a window.'), null);
assert.strictEqual(publicTitle('Headphones Hit a Revelation', { title: 'A little couch surfing before the store.' }, 61, ''), 'A little couch surfing before the store at 1:01');
assert.strictEqual(publicTitle('', { title: '', username: 'goosely' }, 75, ''), "goosely's stream at 1:15");
process.stdout.write('moment fallback title: all checks passed\n');
process.exit(0);
