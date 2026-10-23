'use strict';
// A worn item Live's catalog does not list renders from its Inventory definition (server/monetization/cosmetics.js
// fromDefinition, 2026-10-23): a one-of-a-kind set made for one person shows in chat as soon as Inventory has it and
// the stylesheets draw its class, without a Live release. The definition is checked as strictly as Inventory's kinds,
// and an item worn in the wrong slot, or one Inventory does not define, still shows nothing.
const assert = require('assert');

console.warn = () => {};
const { profileOf, COSMETICS } = require('../server/monetization/cosmetics');

const def = (kind, attributes) => ({ kind, attributes });
const defs = new Map([
    ['fx_newbie', def('live.name_effect', { tier: 6, css_class: 'name-fx-newbie' })],
    ['px_newbie', def('live.particle', { tier: 6, css_class: 'px-newbie', chars: '★☆' })],
    ['hat_newbie', def('live.hat', { tier: 6, hat_char: '👑', animated: 'warp' })],
    ['voice_newbie', def('live.voice', { tier: 6, pitch: 1.4, rate: 1.1 })],
    // Each one fails one rule.
    ['fx_bad', def('live.name_effect', { css_class: 'name-fx-2fat" onmouseover="x' })],
    ['px_long', def('live.particle', { css_class: 'px-long', chars: '★'.repeat(17) })],
    ['hat_spin', def('live.hat', { hat_char: '👑', animated: 'spin' })],
    ['voice_loud', def('live.voice', { pitch: 5, rate: 1 })],
]);

assert.ok(!COSMETICS.fx_newbie, 'the fixture items are not in the catalog');

// Not in the catalog, defined by Inventory: rendered from the definition.
assert.deepStrictEqual(profileOf({ name_effect: 'fx_newbie', particle: 'px_newbie', hat: 'hat_newbie', voice: 'voice_newbie' }, defs), {
    nameFX: { itemId: 'fx_newbie', cssClass: 'name-fx-newbie' },
    particleFX: { itemId: 'px_newbie', cssClass: 'px-newbie', chars: '★☆' },
    hatFX: { itemId: 'hat_newbie', hatChar: '👑', cssClass: '👑', animated: 'warp' },
    voiceFX: { itemId: 'voice_newbie', pitch: 1.4, rate: 1.1 },
});

// A definition that breaks a rule renders nothing for that slot.
assert.deepStrictEqual(profileOf({ name_effect: 'fx_bad', particle: 'px_long', hat: 'hat_spin', voice: 'voice_loud' }, defs), {});

// Worn in the wrong slot, unknown to Inventory, or Inventory unreadable (null): nothing.
assert.deepStrictEqual(profileOf({ name_effect: 'px_newbie', hat: 'fx_newbie' }, defs), {});
assert.deepStrictEqual(profileOf({ name_effect: 'fx_nobody' }, defs), {});
assert.deepStrictEqual(profileOf({ name_effect: 'fx_newbie' }, null), {});

// The catalog's own entries are unchanged, with or without definitions.
assert.deepStrictEqual(profileOf({ name_effect: 'fx_vegas' }, null), { nameFX: { itemId: 'fx_vegas', cssClass: 'name-fx-vegas' } });
assert.deepStrictEqual(profileOf({ name_effect: 'fx_twofat', hat: 'hat_twofat' }, defs).hatFX, { itemId: 'hat_twofat', hatChar: '📻', cssClass: '📻', animated: 'pulse' });

console.log('cosmetics fallback: all checks passed');
