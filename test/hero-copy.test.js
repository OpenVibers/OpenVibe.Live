'use strict';
/**
 * The home hero's AI copy rules (server/ai/hero-copy.js): the 2026-10-17 batch put "testicle banter crew" and
 * "qeqweqwe watchers" on the front page. Keyboard mashes, "free" copy, profanity and a child beside bare skin are
 * refused (describing people and bodies is fine, owner 2026-10-31); ordinary audiences and
 * quips pass, and so does "goosely’s loyal 3 viewers" (the prompt's own example of a joke the channel makes about
 * itself).
 *
 *   node test/hero-copy.test.js
 */
const assert = require('assert');
const { publicOk } = require('../server/ai/hero-copy');

const refused = ['qeqweqwe watchers', 'free streaming fans', 'shitpost central', 'asdfgh chill crew', 'horny chat crew',
    'shirtless kids crew', 'naked kids crew', 'nude teen fans',
    // Test accounts (2026-11-07: "Live streaming for testing_testers crew testing" was the home's first line).
    'testing_testers crew testing', 'test_user fans', 'alex_test hype squad', 'tester2 chat crew'];
for (const s of refused) assert.strictEqual(publicOk(s), false, `refused: ${s}`);
const kept = ['2fat’s hype squad', 'JustTwoCuteBesties fans', 'Maticus and crew', 'JessePlays rhythm lovers', 'meme spike mob', 'van-dwelling coders',
    'multi-GPU benchmark junkies', 'goosely’s loyal 3 viewers', 'class clowns', 'ara007 shirtless thoughts', 'figure-drawing nude art fans', 'button mashers', 'from Tesla GPUs to spicy memes', 'throttle the hype, not the vibes', 'Goosely chaos chat',
    'contest_king fans', 'speed-testing crew', 'testing new overlays together'];
for (const s of kept) assert.strictEqual(publicOk(s), true, `kept: ${s}`);
console.log('hero copy: all checks passed');
