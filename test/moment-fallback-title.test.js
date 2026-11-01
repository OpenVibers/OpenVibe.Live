'use strict';
/**
 * The title an auto clip or AI moment gets when the AI gives none (server/ai/ai-moments-job.js). A frame caption's
 * first clause titled public clips "A Man With A Beard Is Speaking To" (cut off on a dangling word, and about how
 * someone looks). Now: the caption's clause when it reads as a title; otherwise the stream's own title and the
 * moment's time. Describing people and nudity are fine (owner, 2026-10-31).
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
// Describing people is fine: a caption about someone is a title like any other.
assert.strictEqual(captionTitle('A man with a beard is speaking to the camera.'), 'A Man With A Beard Is Speaking');
assert.strictEqual(captionTitle('A young boy plays a game.'), 'A Young Boy Plays A Game');
const vod = { title: 'Fortnite!' };
assert.strictEqual(fallbackTitle(vod, 2480, 'A man wearing a headset sits in a gaming chair.'), 'A Man Wearing A Headset Sits In A Gaming', 'nine words at most');
assert.strictEqual(fallbackTitle(vod, 2480, 'The Minecraft main menu is displayed with a panorama.'), 'The Minecraft Main Menu Is Displayed With A Panorama', 'a complete clause is kept whole');
assert.strictEqual(fallbackTitle({ title: '', username: 'goosely' }, 75, ''), "goosely's stream at 1:15");
assert.strictEqual(fallbackTitle({}, 0), 'Stream at 0:00');
assert.ok(fallbackTitle({ title: 'x'.repeat(200) }, 59).length <= 80, 'at most 80 characters');
// An AI title is kept as the AI wrote it.
const { publicTitle } = require('../server/ai/ai-moments-job');
assert.strictEqual(publicTitle('Boss Fight Comeback', vod, 60, ''), 'Boss Fight Comeback');
assert.strictEqual(publicTitle('Red Beanie Moment', vod, 2480, 'A man wearing a red beanie looks up.'), 'Red Beanie Moment', 'describing someone is fine');
assert.strictEqual(publicTitle('A Naked Man Lying On A Bed', vod, 2480, ''), 'A Naked Man Lying On A Bed', 'nudity is fine');
assert.strictEqual(publicTitle('Woman Laughs At Chat', vod, 2480, ''), 'Woman Laughs At Chat');
assert.strictEqual(publicTitle('Boobs by Bobs Chalk Talk', vod, 2480, ''), 'Boobs by Bobs Chalk Talk', 'body words are fine');
assert.strictEqual(publicTitle('', vod, 2480, ''), 'Fortnite! at 41:20', 'no title: the stream and the moment');
assert.strictEqual(publicTitle('Kick-Ass Combo Finish', vod, 60, ''), 'Kick-Ass Combo Finish', 'not every rough word is a body word');
assert.strictEqual(publicTitle('Headphones Hit a Revelation', { title: 'A little couch surfing before the store.' }, 61, ''), 'Headphones Hit a Revelation');
assert.strictEqual(publicTitle('', { title: 'A little couch surfing before the store.' }, 61, ''), 'A little couch surfing before the store at 1:01');
assert.strictEqual(publicTitle('', { title: '', username: 'goosely' }, 75, ''), "goosely's stream at 1:15");
process.stdout.write('moment fallback title: all checks passed\n');
process.exit(0);
