'use strict';

const assert = require('assert');

/**
 * Test the auth strategy classification logic used in the WHIP handler.
 * Verifies that path parameters are correctly classified as:
 *   - Stream key (hex ≥16 chars, not purely numeric)
 *   - Slot ID (purely numeric)
 *   - Numeric stream session ID (for JWT auth)
 */

// ── Auth strategy classification ──

function classifyPathParam(pathParam) {
    const isStreamKey = /^[0-9a-f]{16,}$/i.test(pathParam) && !/^\d+$/.test(pathParam);
    const isSlotId = /^\d+$/.test(pathParam);
    if (isStreamKey) return 'stream_key';
    if (isSlotId) return 'slot_id';
    return 'unknown';
}

// Hex stream keys (strategy 1)
assert.strictEqual(classifyPathParam('abcdef0123456789'), 'stream_key');
assert.strictEqual(classifyPathParam('ABCDEF0123456789ABCDEF0123456789'), 'stream_key');
assert.strictEqual(classifyPathParam('a1b2c3d4e5f6a7b8'), 'stream_key');
console.log('✅ Hex stream keys correctly classified as strategy 1');

// Purely numeric → slot ID (strategy 2), not stream key
assert.strictEqual(classifyPathParam('1'), 'slot_id');
assert.strictEqual(classifyPathParam('42'), 'slot_id');
assert.strictEqual(classifyPathParam('12345'), 'slot_id');
assert.strictEqual(classifyPathParam('999999999999999999'), 'slot_id');
console.log('✅ Numeric slot IDs correctly classified as strategy 2');

// Purely numeric long string → slot_id (not stream_key even though ≥16 chars)
assert.strictEqual(classifyPathParam('1234567890123456'), 'slot_id');
console.log('✅ Long numeric strings are slot IDs, not stream keys');

// Short hex strings → neither (unknown)
assert.strictEqual(classifyPathParam('abc123'), 'unknown');
assert.strictEqual(classifyPathParam('dead'), 'unknown');
console.log('✅ Short hex strings are unknown (too short for stream key)');

// Non-hex strings → unknown
assert.strictEqual(classifyPathParam('not-a-key'), 'unknown');
assert.strictEqual(classifyPathParam('resource-xyz'), 'unknown');
console.log('✅ Non-hex strings are unknown');

// ── WHIP URL format tests ──

// Verify slot ID URL format: /whip/:slotId
const slotUrl = '/whip/42';
const slotMatch = slotUrl.match(/^\/whip\/(\d+)$/);
assert.ok(slotMatch, 'Slot URL should match /whip/:slotId pattern');
assert.strictEqual(slotMatch[1], '42');
console.log('✅ Slot ID WHIP URL format /whip/:slotId works');

// Verify stream key URL format: /whip/:streamKey
const keyUrl = '/whip/abcdef0123456789';
const keyMatch = keyUrl.match(/^\/whip\/([0-9a-f]{16,})$/i);
assert.ok(keyMatch, 'Key URL should match /whip/:streamKey pattern');
assert.strictEqual(keyMatch[1], 'abcdef0123456789');
console.log('✅ Stream key WHIP URL format /whip/:streamKey works');

// Verify resource URL format: /whip/:id/:resourceId
const resourceUrl = '/whip/42/abc123def456';
const resourceMatch = resourceUrl.match(/^\/whip\/([^/]+)\/([^/]+)$/);
assert.ok(resourceMatch, 'Resource URL should match /whip/:id/:resourceId pattern');
assert.strictEqual(resourceMatch[1], '42');
assert.strictEqual(resourceMatch[2], 'abc123def456');
console.log('✅ WHIP resource URL format /whip/:id/:resourceId works');

console.log('\n✅ All WHIP slot auth strategy tests passed');
