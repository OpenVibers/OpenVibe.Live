'use strict';

/**
 * ✨ Suggest (server/streaming/title-ideas.js): three clean titles from the slot's last streams and the streamer's own
 * hour, never the current one again, never a filtered word; a short AI call attributed to the streamer; a few a minute.
 */
const assert = require('assert');
const ti = require('../server/streaming/title-ideas');

(async () => {
    const slot = { id: 11, title: 'Phone Home Stream', description: 'Walking around town', user_id: 1 };
    const sessions = [
        { title: 'Night walk downtown', category: 'IRL', started_at: '2026-10-31T23:00:00Z' },
        { title: 'Market day', category: 'IRL', started_at: '2026-10-30T15:00:00Z' },
    ];
    const db = { async getStreamHistoryByManagedStream(id, userId, limit) { assert.deepStrictEqual([id, userId, limit], [11, 1, 8]); return sessions; } };
    let call = null;
    const llm = { async complete(o) { call = o; return { json: { titles: ['"Night walk by the river"', 'Phone Home Stream', '1. Sunday market loop #irl', 'badword here', 'Coffee and a long walk', 'One more'] } }; } };
    const wordFilter = { check: (t) => ({ safe: !/badword/.test(t) }) };

    const titles = await ti.ideas({ slot, userId: 1, weekday: 'Sunday', hour: 21 }, { db, llm, wordFilter });
    assert.deepStrictEqual(titles, ['Night walk by the river', 'Sunday market loop', 'Coffee and a long walk'], 'cleaned, the current title and a filtered one left out, three at most');
    assert.strictEqual(call.ownerUserId, 1, 'the spend is the streamer\'s');
    assert.strictEqual(call.kind, 'golive_title_ideas');
    assert.ok(call.maxTokens <= 200, 'a short call');
    assert.ok(call.user.includes('- Night walk downtown (IRL)'), 'the last streams are in the prompt');
    assert.ok(call.user.includes('It is Sunday at night for the streamer.'), 'the streamer\'s own day and hour');
    assert.ok(call.json && call.json.schema.properties.titles, 'a JSON answer');

    // A plain-text answer still works; nothing usable is [].
    const textLlm = { async complete() { return { text: 'Walk one\nWalk two' }; } };
    assert.deepStrictEqual(await ti.ideas({ slot, userId: 1 }, { db, llm: textLlm, wordFilter }), ['Walk one', 'Walk two']);
    assert.deepStrictEqual(await ti.ideas({ slot, userId: 1 }, { db, llm: { async complete() { return null; } }, wordFilter }), []);

    assert.strictEqual(ti.clean('  "A very  long title" #tag '), 'A very long title');
    assert.strictEqual(ti.partOfDay(8), 'in the morning');
    assert.strictEqual(ti.partOfDay(99), null);

    // A few a minute: the 13th ask in ten minutes waits, and the window frees.
    ti._uses.clear();
    const asks = Array.from({ length: 12 }, (_, i) => ti.allow(7, 1000 + i));
    assert.ok(asks.every(Boolean), 'twelve asks pass');
    assert.ok(!ti.allow(7, 2000), 'the limit holds');
    assert.ok(ti.allow(7, 1000 + 11 * 60 * 1000), 'and frees after the window');
    console.log('golive-title-ideas: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
