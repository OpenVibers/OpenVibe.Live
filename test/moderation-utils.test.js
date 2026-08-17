'use strict';
/**
 * tests/moderation-utils.test.js
 *
 * Regression tests for the shared chat moderation utilities.
 * Run with: node tests/moderation-utils.test.js
 *
 * Tests cover:
 *  - Exact base-form detection
 *  - Pluralized / suffixed variants (the reported bypass class)
 *  - Common leet-speak substitutions
 *  - Punctuation / spacing obfuscation
 *  - Repeated-character normalization
 *  - Near-miss safe words that should NOT match
 *  - Disabled-category behavior
 *  - Custom term / custom regex behavior
 */

const {
    CORE_SLUR_CATEGORIES,
    normalizeSlurText,
    normalizeSlurPatternText,
    containsCoreSlur,
    containsRegexSlur,
    containsConfiguredSlur,
} = require('../server/chat/moderation-utils');

let pass = 0;
let fail = 0;

function assert(label, condition) {
    if (condition) {
        console.log(`  ✓  ${label}`);
        pass++;
    } else {
        console.error(`  ✗  ${label}`);
        fail++;
    }
}

function shouldMatch(label, text, disabledCategories = []) {
    assert(label, containsCoreSlur(text, disabledCategories));
}

function shouldNotMatch(label, text, disabledCategories = []) {
    assert(label, !containsCoreSlur(text, disabledCategories));
}

// ── 1. N-word base forms ────────────────────────────────────────────────────
console.log('\n[N-word] Base forms');
shouldMatch('nigga (base)', 'nigga');
shouldMatch('nigger (base)', 'nigger');
shouldMatch('NIGGA (uppercase)', 'NIGGA');
shouldMatch('NIGGER (uppercase)', 'NIGGER');

// ── 2. Pluralized / suffixed variants (the reported bypass) ─────────────────
console.log('\n[N-word] Pluralized / suffixed variants');
shouldMatch('niggas (plural -s)', 'niggas');
shouldMatch('niggers (plural -s)', 'niggers');
shouldMatch('niggaz (plural -z)', 'niggaz');
shouldMatch('Niggas in a sentence', 'Those niggas were loud');
shouldMatch('niggers inline', 'I hate niggers and that is final');

// ── 3. Leet-speak substitutions ──────────────────────────────────────────────
console.log('\n[N-word] Leet-speak');
shouldMatch('n1gga (1→i)', 'n1gga');
shouldMatch('n!gger (! → i)', 'n!gger');
shouldMatch('nigg4 (4→a)', 'nigg4');
shouldMatch('nigg@s (@ → a, plural)', 'nigg@s');

// ── 4. Punctuation / spacing obfuscation ────────────────────────────────────
console.log('\n[N-word] Punctuation / spacing');
// normalizeSlurPatternText collapses non-alnum to spaces, so "n.i.g.g.a" → "n i g g a"
// These are matched against \b anchored patterns on the space-separated tokens.
shouldMatch('n.i.g.g.a (dots)', 'n.i.g.g.a');
shouldMatch('n-i-g-g-e-r (dashes)', 'n-i-g-g-e-r');

// ── 5. Repeated-character normalization ─────────────────────────────────────
console.log('\n[N-word] Repeated characters');
// The pattern itself uses n+ i+ g+ g+ so repeated chars are intrinsically matched.
shouldMatch('niiigga (repeated i)', 'niiigga');
shouldMatch('nigggggas (repeated g, plural)', 'nigggggas');

// ── 6. Near-miss safe words (MUST NOT match) ────────────────────────────────
console.log('\n[Safe words — must NOT match]');
shouldNotMatch('trigger', 'trigger');
shouldNotMatch('bigger', 'bigger');
shouldNotMatch('figure', 'figure');
shouldNotMatch('snigger (UK laugh)', 'snigger');
shouldNotMatch('jigger (measure)', 'jigger');
shouldNotMatch('digger', 'digger');
shouldNotMatch('rigger (stage crew)', 'rigger');
shouldNotMatch('swagger', 'swagger');
shouldNotMatch('bagger', 'bagger');

// ── 7. Disabled category behavior ───────────────────────────────────────────
console.log('\n[Category disabling]');
shouldNotMatch('nigga with n_word disabled', 'nigga', ['n_word']);
shouldNotMatch('niggers with n_word disabled', 'niggers', ['n_word']);
shouldMatch('nigga with homophobic disabled (n_word still on)', 'nigga', ['homophobic']);

// ── 8. Homophobic category ───────────────────────────────────────────────────
console.log('\n[Homophobic slurs]');
shouldMatch('fag (base)', 'fag');
shouldMatch('faggot (base)', 'faggot');
shouldMatch('faggots (plural)', 'faggots');
shouldMatch('f.a.g (dots)', 'f.a.g');
shouldNotMatch('faggot with homophobic disabled', 'faggot', ['homophobic']);

// ── 9. Racial slurs category ────────────────────────────────────────────────
console.log('\n[Racial slurs]');
shouldMatch('spic (base)', 'spic');
shouldMatch('spics (plural)', 'spics');
shouldMatch('chink (base)', 'chink');
shouldMatch('chinks (plural)', 'chinks');
shouldNotMatch('spic with racial disabled', 'spic', ['racial']);

// ── 10. Custom term matching (containsConfiguredSlur) ───────────────────────
console.log('\n[Custom term matching]');
assert('custom term exact', containsConfiguredSlur('I hate testslur', ['testslur']));
assert('custom term leet 5l4p → slap', containsConfiguredSlur('5l4p h1m', ['slap']));
// substring match is by design — configured terms should be long enough to avoid false positives
// (the platform warns streamers to use specific enough terms)
assert('custom term: "safe" not in "uncomfortable" after normalization', !containsConfiguredSlur('uncomfortable', ['safe']));
// normalizeSlurText deduplicates, so "sllur" → "slur" should match "slur"
assert('custom term repeated chars normalized', containsConfiguredSlur('sluuur', ['slur']));

// ── 11. Custom regex matching (containsRegexSlur) ───────────────────────────
console.log('\n[Custom regex matching]');
assert('custom regex basic', containsRegexSlur('buy this pill now', ['pill\\s+now']));
assert('custom regex /pattern/flags syntax', containsRegexSlur('HELLO WORLD', ['/hello/i']));
assert('custom regex no match', !containsRegexSlur('safe text', ['dangerous\\s+word']));
assert('invalid regex is silently skipped', !containsRegexSlur('text', ['[invalid']));

// ── 12. Normalization helpers ────────────────────────────────────────────────
console.log('\n[Normalization]');
assert('normalizeSlurText: leet', normalizeSlurText('n1gg4') === 'niga');
assert('normalizeSlurText: dedup consecutive', normalizeSlurText('niggga') === 'niga');
assert('normalizeSlurPatternText: spaces preserved', normalizeSlurPatternText('hello world') === 'hello world');
assert('normalizeSlurPatternText: leet mapped', normalizeSlurPatternText('n1gga') === 'nigga');
assert('normalizeSlurPatternText: punctuation → space', normalizeSlurPatternText('n.i.g.g.a') === 'n i g g a');

// ── Results ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${pass} passed, ${fail} failed out of ${pass + fail} total`);
if (fail > 0) {
    console.error('\nSome tests FAILED.');
    process.exit(1);
} else {
    console.log('\nAll tests passed.');
}
