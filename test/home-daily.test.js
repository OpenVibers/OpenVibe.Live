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
    const guided = await readDailyQuest({ token: 'person-token', fetchImpl: async (url) => ({
        ok: url.endsWith('/api/v1/quests/today'),
        json: async () => ({ title: 'Made for you', steps: [{ guide_id: 'opaque-1' }, {}, {}], progress: 0 }),
    }) });
    assert.equal(guided.quest.title, 'Made for you');
    assert.equal(guided.quest.steps[0].guide_id, 'opaque-1');
    assert.equal(await readDailyQuest({ fetchImpl: async () => { throw Error('down'); } }), null);

    // The card's door to Quest: the catalog's size for everyone (kept ten minutes), a person's badges and started quests.
    let catalogReads = 0;
    const moreFetch = async (url) => {
        if (url.endsWith('/api/v1/quests')) { catalogReads++; return { ok: true, json: async () => ({ sites: [{}, {}], quests: [{}, {}, {}] }) }; }
        if (url.endsWith('/api/v1/me/quests')) return { ok: true, json: async () => ({
            quests: [{ state: 'in_progress' }, { state: 'completed' }, { state: 'not_started' }, { state: 'in_progress' }], badges: [{}, {}],
        }) };
        if (url.endsWith('/api/v1/me/daily')) return { ok: true, json: async () => ({ title: 'Across OpenVibe', steps: [{}, {}, {}], streak: 4 }) };
        if (url.endsWith('/api/v1/daily')) return { ok: true, json: async () => ({ title: 'Across OpenVibe', steps: [{}, {}, {}] }) };
        return { ok: true, json: async () => ({}) };
    };
    const out = await readDailyQuest({ more: true, fetchImpl: moreFetch, baseUrl: 'https://quest.more' });
    assert.deepEqual(out.more, { quests: 3, sites: 2 });
    const me = await readDailyQuest({ token: 't', more: true, fetchImpl: moreFetch, baseUrl: 'https://quest.more' });
    assert.deepEqual(me.more, { quests: 3, sites: 2, mine: { badges: 2, in_progress: 2, completed: 1 } });
    assert.equal(catalogReads, 1, 'the catalog is read once and kept');
    // A Quest that cannot answer the door's figures still gives the card.
    const bare = await readDailyQuest({ more: true, baseUrl: 'https://quest.bare', fetchImpl: async (url) => (url.endsWith('/api/v1/daily')
        ? { ok: true, json: async () => ({ title: 'Across OpenVibe', steps: [{}, {}, {}] }) } : { ok: false }) });
    assert.equal(bare.quest.title, 'Across OpenVibe');
    assert.deepEqual(bare.more, {});

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
