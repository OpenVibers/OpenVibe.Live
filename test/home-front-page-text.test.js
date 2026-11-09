'use strict';
/**
 * The home digest's topic-linked takes leave out a take with a slur, strong profanity or a hate topic, and show
 * the next best distinct topic (server/home/front-page-text.js, the platform rule from openvibe-sdk/front-page).
 * The Rundown keeps every take as said.
 *
 *   node test/home-front-page-text.test.js
 */
const assert = require('assert');
const { frontPageOk } = require('../server/home/front-page-text');
const { selectTopics } = require('../server/home/digest');

// The strip on 2026-10-24, and more of the same kind.
for (const t of [
    'I look up to and frankly I don\'t even see people that I want to fucking follow anymore.',
    'I had Hermes say, oh, that\'s got an anti-semitic trope. I can\'t help.',
    'that was some bullshit', 'what a bitch move', 'he went full nazi on it', 'the Holocaust bit again',
    'n1gger', 'f a g g o t', 'Motherfucker!', '', null,
    'Eita, pô, tô com tô com o rollback do caralho.', 'Que porra é essa', '¡Joder, qué mierda!', 'putain de merde', 'So eine Scheiße',
]) assert.ok(!frontPageOk(t), `left off the front page: ${t}`);
for (const t of [
    'That first time I walked in, I knew that I was not alone.', 'We finally beat the boss on hard mode',
    'Shitake mushrooms are underrated', 'My dad Dick says hi', 'Scunthorpe won again', 'Grape soda forever',
    'The cockpit view in this sim is amazing',
    'Eita, pô, tô com o rollback do servidor.', 'O computador travou de novo', 'Hola a todos, ¿qué tal?', 'Disputa final hoje',
]) assert.ok(frontPageOk(t), `fine for the front page: ${t}`);
console.log('  ✓ slurs, strong profanity and hate topics are left off; ordinary takes (and Shitake, Scunthorpe, grape) stay');

const row = (id, topic, title, quote) => ({ id, stream_id: id, topic, title, username: 'annstreams',
    quotes_json: quote ? JSON.stringify([{ text: quote }]) : '[]' });
const selected = selectTopics([
    row(1, 'League autofill', 'A safe title', 'that was some bullshit'),
    row(2, 'he went full nazi on it', 'A safe title', 'This one sounds fine'),
    row(3, null, 'An unlabelled take', 'This one sounds fine'),
    row(4, 'League autofill', 'Autofill put me on support', 'We finally beat the boss on hard mode'),
    row(5, 'League autofill', 'A duplicate topic', 'This one sounds fine'),
    row(6, 'The tiny studio', 'The sound is right'),
    row(7, 'Starters', 'Grape soda forever'),
    row(8, 'Fourth topic', 'The fourth safe take'),
]);
assert.deepStrictEqual(selected.map((r) => r.id), [4, 6, 7], 'filter unsafe and unlabelled takes, keep the best three distinct topics');
assert.strictEqual(selected[0].text, 'We finally beat the boss on hard mode', 'use the streamer’s quote when safe');
assert.strictEqual(selected[1].text, 'The sound is right', 'fall back to the headline when there is no quote');
console.log('  ✓ the home digest filters before taking three distinct topics');
console.log('home front-page text: all passed');
