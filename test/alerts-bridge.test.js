'use strict';

// server/monetization/alerts.js after roadmap T3: Live no longer reads the alert sound from disk or
// broadcasts base64 — the sound mapping lives on channel_moderation_settings, which OpenVibe.Chat
// owns — it asks Chat through the bridge op `playAlertSound [streamerId, streamId, kind]`. This
// checks the dispatcher; the op itself (resolving the sound, reading the shared file, broadcasting
// `soundboard-audio`) lives in Chat and is tested there.
//
//   node test/alerts-bridge.test.js

const assert = require('assert');
const alerts = require('../server/monetization/alerts');

const calls = [];
const fake = { playAlertSound: (...args) => calls.push(args) };

alerts.playAlertSound(fake, 7, 3, 'donation');
alerts.playAlertSound(fake, 7, 3, 'goal');
alerts.playAlertSound(fake, 7, 3, 'anything-else');
assert.deepStrictEqual(calls, [[7, 3, 'donation'], [7, 3, 'goal'], [7, 3, 'donation']], 'unknown kinds fall back to the donation sound');

// Offline room: a null stream id is passed straight through (Chat reaches the channel room).
alerts.playAlertSound(fake, 7, null, 'goal');
assert.deepStrictEqual(calls[3], [7, null, 'goal']);

// Live runs chat itself (rollback / dev): no Chat to ask — silent no-op, never throws.
alerts.playAlertSound({}, 7, 3, 'donation');
alerts.playAlertSound(null, 7, 3, 'donation');
assert.strictEqual(calls.length, 4, 'a chat server without the op is not called');

console.log('alerts bridge: all checks passed');
