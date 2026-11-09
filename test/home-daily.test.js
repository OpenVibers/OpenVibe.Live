'use strict';
const assert = require('node:assert/strict');
const { readDailyQuest } = require('../server/home/daily-quest');
const { summarizeHistory } = require('../server/home/recent-facts');

(async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith('/api/v1/me/daily/time-zone')) return { ok: true, json: async () => ({ time_zone: 'America/Los_Angeles' }) };
        if (url.endsWith('/api/v1/me/daily')) return { ok: true, json: async () => ({
            title: 'Across OpenVibe', steps: [{ done: false }, { done: true }, { done: false }],
            progress: 1, streak: 3, time_zone: calls.some(c => c.url.endsWith('/time-zone')) ? 'America/Los_Angeles' : 'UTC',
        }) };
        if (url.endsWith('/api/v1/daily')) return { ok: true, json: async () => ({ title: 'Across OpenVibe', steps: [{}, {}, {}] }) };
        return { ok: false };
    };
    const signedOut = await readDailyQuest({ fetchImpl, baseUrl: 'https://quest.test' });
    assert.equal(signedOut.signed_in, false);
    assert.equal(calls[0].options.headers.Authorization, undefined);
    const signedIn = await readDailyQuest({ token: 'person-token', timeZone: 'America/Los_Angeles', fetchImpl, baseUrl: 'https://quest.test' });
    assert.equal(signedIn.signed_in, true);
    assert.equal(signedIn.quest.time_zone, 'America/Los_Angeles');
    assert.equal(signedIn.quest.progress, 1);
    assert.ok(calls.slice(1).every(c => c.options.headers.Authorization === 'Bearer person-token' && !('Cookie' in c.options.headers)));
    assert.equal(await readDailyQuest({ fetchImpl: async () => { throw Error('down'); } }), null);

    const now = Date.parse('2026-11-08T22:00:00Z');
    const rows = [
        { id: 1, started_at: '2026-11-08T18:00:00Z', ended_at: '2026-11-08T20:00:00Z', duration_seconds: 7200, title: 'Today' },
        { id: 2, started_at: '2026-11-07T18:00:00Z', ended_at: '2026-11-07T19:00:00Z', duration_seconds: 3600, title: 'Yesterday' },
        { id: 3, started_at: '2026-11-06T18:00:00Z', ended_at: '2026-11-06T19:00:00Z', duration_seconds: 3600, title: 'Earlier' },
    ];
    const facts = summarizeHistory(rows, now);
    assert.equal(facts.streams_this_week, 3);
    assert.equal(facts.hours_this_week, 4);
    assert.equal(facts.usual_time, 'Usually live evenings');
    assert.equal(facts.days_in_a_row, 3);
    assert.equal(facts.last_stream_seconds, 7200);
    assert.deepEqual(facts.streams.map(s => s.title), ['Today', 'Yesterday']);
    process.stdout.write('home daily and stream history: all checks passed\n');
})().catch(e => { process.stderr.write(String(e.stack || e) + '\n'); process.exit(1); });
