'use strict';
// The Rundown's Today card (server/rundown/today.js): the job is due-based — the first three takes make a card,
// then at most one write per 30 minutes and only when a take newer than the stored card exists; today's takes are
// sampled across the day; the stored words pass the public-text filter and the explicit guard; a highlight can only
// point at a take it was given; the server-rendered card links every highlight to its take's anchor.
const assert = require('assert');
const db = require('../server/db/database');
const today = require('../server/rundown/today');

(async () => {
    const now = Date.parse('2026-11-11T12:00:00Z');
    assert.strictEqual(today.utcDay(now), '2026-11-11');
    assert.strictEqual(today.utcDay(Date.parse('2026-11-11T23:59:59Z')), '2026-11-11');

    // ── Cadence: never before three takes, then 30 minutes apart with a new take ──
    assert.strictEqual(today.isDue(null, { now, total: 0, latest_take_id: null }), false, 'a day with no takes has no card');
    assert.strictEqual(today.isDue(null, { now, total: 1, latest_take_id: 9 }), true, 'the first take makes a card');
    assert.strictEqual(today.isDue({ version: today.CARD_VERSION, generated_at: now - 29 * 60000, latest_take_id: 9 }, { now, total: 10, latest_take_id: 10 }), false, 'not before 30 minutes');
    assert.strictEqual(today.isDue({ version: today.CARD_VERSION, generated_at: now - 31 * 60000, latest_take_id: 9 }, { now, total: 10, latest_take_id: 9 }), false, 'no new takes, no write');
    assert.strictEqual(today.isDue({ version: today.CARD_VERSION, generated_at: now - 31 * 60000, latest_take_id: 9 }, { now, total: 10, latest_take_id: 10 }), true, 'a new take after 30 minutes');
    assert.strictEqual(today.isDue({ version: today.CARD_VERSION, generated_at: now - 31 * 60000, latest_take_id: 9 }, { now, total: 10, latest_take_id: 8 }), false, 'an older cursor never rewrites');
    assert.strictEqual(today.isDue({ generated_at: now - 1000, latest_take_id: 9 }, { now, total: 10, latest_take_id: 9 }), true, 'a card from before this version is not a card');

    // ── Sampling: first and last of the day, no duplicates, up to 30 ──
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, title: `take ${i + 1}` }));
    const sample = today.sampleTakes(items, 30);
    assert.strictEqual(sample.length, 30);
    assert.strictEqual(sample[0].id, 1);
    assert.strictEqual(sample[29].id, 100);
    assert.strictEqual(new Set(sample.map((x) => x.id)).size, 30);
    assert.deepStrictEqual(today.sampleTakes(items.slice(0, 4), 30).map((x) => x.id), [1, 2, 3, 4], 'a small day is kept whole');

    // ── The words are public text: clean, and a card that says something sexual is never stored ──
    const out = today.cardText({
        headline: '<b>Fridges  and builds</b>',
        summary: '## The day\n- goosely read about fridges.\nann fixed a build.',
        highlights: [{ take_id: 1, line: 'The fridge line' }, { take_id: 1, line: 'The same take again' }, { take_id: 2, line: ' **It compiles!** ' }],
    });
    assert.deepStrictEqual(out, { headline: 'Fridges and builds', summary: 'goosely read about fridges. ann fixed a build.', highlights: [{ take_id: 1, line: 'The fridge line' }, { take_id: 2, line: 'It compiles!' }] });
    assert.strictEqual(today.cardText({ headline: 'A night', summary: 'They watched porn.', highlights: [] }), null, 'the explicit guard');
    assert.strictEqual(today.cardText({ headline: 'No summary', highlights: [] }), null);

    // ── The server-rendered card: kit markup, every highlight a link to its take ──
    const html = today.ssrHtml({ status: 'ready', headline: 'Fridges & builds', summary: 'A day about fridges and one stubborn compiler.', highlights: [
        { take_id: 41, line: 'The fridge line', url: '/rundown/e/12#rd-take-41', username: 'goosely', topic: 'Fridges' },
        { take_id: 42, line: 'It compiles at last', stream_id: 13, username: 'ann', topic: 'Rust builds' },
    ] });
    assert.match(html, /class="ovk-section"/);
    assert.match(html, /Fridges &amp; builds/);
    assert.match(html, /A day about fridges and one stubborn compiler\./);
    assert.match(html, /href="\/rundown\/e\/12#rd-take-41"/);
    assert.match(html, /href="\/rundown\/e\/13#rd-take-42"/);
    assert.match(html, /The fridge line/);
    assert.match(html, /goosely/);
    assert.strictEqual(today.ssrHtml(null), '', 'no card, no markup');

    // ── Stored per day, and read back through the day's API shape ──
    await db.initDb();
    const mk = async (username, display) => {
        await db.createUser({ username, email: `${username}@x`, password_hash: 'x', display_name: display || username, stream_key: username.padEnd(32, '0') });
        const u = await db.get('SELECT id FROM users WHERE username = ?', [username]);
        await db.ensureChannel(u.id);
        return u.id;
    };
    const goose = await mk('goosely', 'goosely');
    const streamId = Number((await db.createStream({ user_id: goose, title: 'Tech news', category: 'Science & Technology', protocol: 'rtmp' })).lastInsertRowid);
    const date = '2026-11-11';
    for (let i = 0; i < 3; i++) {
        await db.run(`INSERT INTO rundown_segments (stream_id, user_id, topic_id, start_sec, end_sec, title, what, take, score, quotes_json, vod_id, said_at, status)
            VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 4, '[]', NULL, ?, 'live')`, [streamId, goose, 60 * i, 60 * i + 40, `Take ${i}`, `goosely talked about fridges (${i}).`, i === 1 ? 'Internet fridges are a bad idea.' : null, `${date} 1${i}:00:00`]);
    }
    const ids = (await db.all('SELECT id FROM rundown_segments ORDER BY id')).map((r) => Number(r.id));
    const card = await today.refresh(date, { now, ai: async () => ({
        headline: 'Fridges and the build',
        summary: 'goosely spent the morning on hacked fridges. The take was that the internet does not belong in a fridge.',
        highlights: [{ take_id: ids[1], line: 'The fridge take that started it all.' }, { take_id: 999999, line: 'Not a take of today.' }],
    }) });
    assert.ok(card, 'the first card is written');
    assert.strictEqual(card.status, 'ready');
    assert.strictEqual(card.version, today.CARD_VERSION);
    assert.strictEqual(card.take_count, 3);
    assert.strictEqual(card.highlights.length, 1, 'only a real take becomes a highlight');
    assert.deepStrictEqual(card.highlights[0], {
        take_id: ids[1], line: 'The fridge take that started it all.', stream_id: streamId, username: 'goosely', topic: null, url: `/rundown/e/${streamId}#rd-take-${ids[1]}`,
    });
    assert.deepStrictEqual(await today.get(date), card, 'the card is stored and read back');
    assert.strictEqual(await today.get('2026-11-10'), null, 'another day has no card');

    // Not due: the next looks return the same card and never call AI.
    let calls = 0;
    const noAi = async () => { calls++; return { headline: 'x', summary: 'y', highlights: [] }; };
    assert.deepStrictEqual(await today.refresh(date, { now: now + 5 * 60000, ai: noAi }), card);
    await db.run(`INSERT INTO rundown_segments (stream_id, user_id, topic_id, start_sec, end_sec, title, what, take, score, quotes_json, vod_id, said_at, status)
        VALUES (?, ?, NULL, 200, 240, 'Take 3', 'goosely kept talking about fridges.', NULL, 4, '[]', NULL, ?, 'live')`, [streamId, goose, `${date} 16:00:00`]);
    assert.deepStrictEqual(await today.refresh(date, { now: now + 10 * 60000, ai: noAi }), card);
    assert.strictEqual(calls, 0, 'a new take inside the half hour waits');
    const rewritten = await today.refresh(date, { now: now + 31 * 60000, ai: async () => ({ headline: 'Fridges, again', summary: 'goosely kept going on the fridges.', highlights: [] }) });
    assert.strictEqual(calls, 0);
    assert.strictEqual(rewritten.headline, 'Fridges, again');
    assert.strictEqual(rewritten.take_count, 4);
    const again = await today.refresh(date, { now: now + 40 * 60000, ai: noAi });
    assert.strictEqual(again.headline, 'Fridges, again');
    assert.strictEqual(calls, 0, 'no new take after the rewrite: no call');

    console.log('rundown today card: cadence, storage, filter and render OK');
})().catch((e) => { console.error(e); process.exit(1); });
