'use strict';
/**
 * Agent Streams S6 — the chat plays mode (server/agent-streams/plays.js).
 *
 * The owner page: the time box (5 to 30 minutes), the cap (money) and Go. The desk reports the queue and the
 * overlay shows its top three with their votes, and the current request with who asked it.
 */
const assert = require('assert');
const plays = require('../server/agent-streams/plays');

const row = {
    plays_time_box_minutes: 10,
    plays_cap_cents: 500,
    plays_spent_cents: 42,
    plays_armed_at: '2026-11-06T20:00:00.000Z',
    plays_queue: {
        requests: [
            { request_id: 'req_1', text: 'build a snake game', votes: 12, author: { handle: 'mira' }, pinned: true },
            { request_id: 'req_2', text: 'draw a house with a cat', votes: 7, author: { handle: 'bob' } },
            { request_id: 'req_3', text: 'make a quiz', votes: 3, author: { handle: 'ann' } },
            { request_id: 'req_4', text: 'make a meme', votes: 1, author: { handle: 'jo' } },
        ],
        current: { request_id: 'req_1', text: 'build a snake game', author: { handle: 'mira' } },
        reported_at: '2026-11-06T20:01:00.000Z',
    },
};

// The time box: 5 to 30 minutes, the default 10.
assert.strictEqual(plays.cleanTimeBox(10), 10);
assert.strictEqual(plays.cleanTimeBox(1), 5, 'never under five minutes');
assert.strictEqual(plays.cleanTimeBox(90), 30, 'never over thirty minutes');
assert.strictEqual(plays.cleanTimeBox('nonsense'), null);

// The cap: money, in cents.
assert.strictEqual(plays.cleanCap(500), 500);
assert.strictEqual(plays.cleanCap(0), 0);
assert.strictEqual(plays.cleanCap(-5), null);
assert.strictEqual(plays.cleanCap('nonsense'), null);

// The state the owner page and the desk read.
const state = plays.playsState(row);
assert.strictEqual(state.time_box_minutes, 10);
assert.strictEqual(state.cap_cents, 500);
assert.strictEqual(state.spent_cents, 42);
assert.strictEqual(state.armed, true);
assert.strictEqual(state.armed_at, '2026-11-06T20:00:00.000Z');

// The overlay: the queue's top three, and the current request with who asked it.
const top = plays.queueTop(row, 3);
assert.strictEqual(top.top.length, 3, 'the overlay shows three');
assert.strictEqual(top.top[0].request_id, 'req_1');
assert.strictEqual(top.top[0].votes, 12);
assert.strictEqual(top.top[0].author, 'mira');
assert.strictEqual(top.current.request_id, 'req_1');
assert.strictEqual(top.current.author, 'mira', 'the current request says who asked for it');

// A queue the desk reports is bounded and never grows without limit.
const reported = plays.cleanQueue({ requests: Array.from({ length: 50 }, (_, i) => ({ request_id: 'req_' + i })) });
assert.strictEqual(reported.requests.length, 20, 'at most twenty requests are kept');
assert.ok(reported.reported_at, 'the report says when it was made');

console.log('agent streams S6: the chat plays controls, the cap, Go and the queue\'s top three');
