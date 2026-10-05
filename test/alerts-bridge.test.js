'use strict';

// server/monetization/alerts.js after roadmap T3: the alert-sound mapping lives on
// channel_moderation_settings, which OpenVibe.Chat owns, so Live asks Chat to play the sound with an
// `alert` event on its typed ingress (server/chat/chat-delivery.js). This checks the event shape; the
// op itself (resolving the sound, reading the shared file, broadcasting `soundboard-audio`) lives in
// Chat and is tested there.
//
//   node test/alerts-bridge.test.js

const assert = require('assert');
const delivery = require('../server/chat/chat-delivery');
const alerts = require('../server/monetization/alerts');

const calls = [];
const realEvent = delivery.event;
delivery.event = (target, frame) => { calls.push({ target, frame }); return Promise.resolve({ ok: true }); };
try {
    alerts.playAlertSound(7, 3, 'donation');
    alerts.playAlertSound(7, 3, 'goal');
    alerts.playAlertSound(7, 3, 'anything-else');
    // Offline room: a null stream id is passed straight through (Chat reaches the channel room).
    alerts.playAlertSound(7, null, 'goal');
} finally {
    delivery.event = realEvent;
}
assert.deepStrictEqual(calls.map(({ target, frame }) => [target.kind, target.id, frame.streamerId, frame.streamId, frame.kind]), [
    ['channel', 7, 7, 3, 'donation'],
    ['channel', 7, 7, 3, 'goal'],
    ['channel', 7, 7, 3, 'donation'],
    ['channel', 7, 7, null, 'goal'],
], 'unknown kinds fall back to the donation sound, and the alert targets the channel owner');

// Outside chat mode the seam drops the event (logged once), never throws into the caller.
delete process.env.CHAT_AUTHORITY;
assert.doesNotThrow(() => alerts.playAlertSound(7, 3, 'donation'));

console.log('alerts event: all checks passed');
