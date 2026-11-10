'use strict';

/**
 * The plain words for a money row. The list and the formatter live in openvibe-contracts
 * (`billing.money-reason@1`, `lib/money-reasons.js`); Live re-exports them when the installed
 * package has them and otherwise answers from the same list copied at 0.392.0.
 */
let canonical = null;
try { canonical = require('openvibe-sdk').moneyReasons || null; } catch { /* an older SDK */ }
if (!canonical) { try { canonical = require('openvibe-contracts').moneyReasons || null; } catch { /* an older contract package */ } }
const reasons = canonical || require('./reasons-list');

const unknown = new Set();
function describe(key, options) {
    const d = reasons.describe(key, options);
    if (!d.known && d.key && !unknown.has(d.key)) {
        unknown.add(d.key);
        console.warn(`[Money] undeclared reason key ${JSON.stringify(d.key.slice(0, 120))} — reads "${d.text}"`);
    }
    return d;
}

module.exports = { ...reasons, describe };
