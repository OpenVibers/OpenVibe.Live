'use strict';
/**
 * The home page's "Lately on OpenVibe" quotes leave out a take with a slur, strong profanity or a hate topic, and show
 * the next best one (server/home/front-page-text.js); the Rundown keeps every take as said.
 *
 *   node test/home-front-page-text.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { frontPageOk } = require('../server/home/front-page-text');

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

const routes = fs.readFileSync(path.join(__dirname, '..', 'server', 'home', 'routes.js'), 'utf8');
assert.ok(routes.includes("const { frontPageOk } = require('./front-page-text');"));
assert.ok(routes.includes('.filter((h) => frontPageOk(h.text) && (!h.topic || frontPageOk(h.topic)))') && routes.includes('.slice(0, 3);'), 'the digest filters, then keeps three');
assert.ok(/ORDER BY s\.score DESC, s\.said_at DESC LIMIT 15/.test(routes), 'from the best fifteen, so a filtered take has a replacement');
console.log('  ✓ the home digest takes the three best takes that pass');
console.log('home front-page text: all passed');
