'use strict';
/**
 * The home hero's AI copy rules (server/ai/hero-copy.js): the 2026-10-17 batch put "testicle banter crew" and
 * "qeqweqwe watchers" on the front page. Those, "free" copy and copy about looks are refused; ordinary audiences and
 * quips pass, and so does "goosely’s loyal 3 viewers" (the prompt's own example of a joke the channel makes about
 * itself).
 *
 *   node test/hero-copy.test.js
 */
const assert = require('assert');
const { publicOk } = require('../server/ai/hero-copy');

const refused = ['testicle banter crew', 'qeqweqwe watchers', 'free streaming fans', 'ara007 shirtless thoughts',
    'sexy stream squad', 'shitpost central', 'asdfgh chill crew'];
for (const s of refused) assert.strictEqual(publicOk(s), false, `refused: ${s}`);
const kept = ['2fat’s hype squad', 'JustTwoCuteBesties fans', 'Maticus and crew', 'JessePlays rhythm lovers', 'meme spike mob', 'van-dwelling coders',
    'multi-GPU benchmark junkies', 'goosely’s loyal 3 viewers', 'class clowns', 'button mashers', 'from Tesla GPUs to spicy memes', 'throttle the hype, not the vibes', 'Goosely chaos chat'];
for (const s of kept) assert.strictEqual(publicOk(s), true, `kept: ${s}`);
console.log('hero copy: all checks passed');
