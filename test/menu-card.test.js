'use strict';
// The menu's network card (frame.menu-card@1): GET /.well-known/openvibe-menu.json serves Live's "Live now"
// rail — the public channels live right now, most watched first — with no items when nobody is live, CORS * and
// a 30 s cache. The card never carries a row's ingest key or owner-only fields, and 18+ channels stay off it.
const assert = require('assert');
const { createMenuCard, cardFrom, plain, CARD_TTL_S } = require('../server/menu-card');

const row = (over = {}) => ({
    id: 1, user_id: 2, username: 'nova', display_name: 'Nova', viewer_count: 12, is_live: 1,
    content_labels: null, ...over,
});

// ── The card's shape and words ───────────────────────────────────────────
const card = cardFrom([row(), row({ username: 'kitchen', display_name: 'Kitchen radio', viewer_count: 3 })], Date.parse('2026-11-07T08:00:00Z'));
assert.deepStrictEqual(Object.keys(card).sort(), ['id', 'items', 'kind', 'more', 'site', 'title', 'ttl_s', 'updated_at']);
assert.strictEqual(card.id, 'live-now');
assert.strictEqual(card.site, 'live');
assert.strictEqual(card.title, 'Live now');
assert.strictEqual(card.kind, 'rail');
assert.strictEqual(card.ttl_s, 30);
assert.strictEqual(card.updated_at, '2026-11-07T08:00:00.000Z');
assert.deepStrictEqual(card.items, [
    { title: 'Nova', meta: '12 watching', url: 'https://openvibe.live/@nova' },
    { title: 'Kitchen radio', meta: '3 watching', url: 'https://openvibe.live/@kitchen' },
]);
assert.deepStrictEqual(card.more, { label: 'See all', url: 'https://openvibe.live/' });
assert.ok(card.items.length <= 6 && card.title.length <= 60);
for (const item of card.items) assert.ok(item.title.length <= 80 && item.meta.length <= 120 && item.url.startsWith('https://openvibe.live/'));

// Nobody live: the card is still published, with no items, and Network skips it.
assert.deepStrictEqual(cardFrom([]).items, []);
assert.deepStrictEqual(cardFrom(null).items, []);

// Only public channels: the 18+ labels the home page hides are left off, and at most six items are sent.
const many = Array.from({ length: 8 }, (_, i) => row({ id: i, username: `user${i}`, display_name: `User ${i}`, viewer_count: 8 - i }));
assert.strictEqual(cardFrom(many).items.length, 6);
assert.deepStrictEqual(cardFrom([row({ content_labels: JSON.stringify({ labels: ['18+'], suggested: [] }) })]).items, []);

// Text is plain words: markup and control characters are stripped, whitespace collapsed and the title cut to 80.
assert.strictEqual(plain('<b>Nova</b>\n\t live ', 80), 'Nova live');
assert.strictEqual(plain('x'.repeat(200), 80).length, 80);
assert.strictEqual(cardFrom([row({ display_name: '<img src=x onerror=alert(1)>Nova' })]).items[0].title, 'Nova');
assert.strictEqual(cardFrom([row({ display_name: '   ', username: 'quiet' })]).items[0].title, 'quiet');

// ── The 30 s cache and the route's headers ──────────────────────────────
(async () => {
    let t = 1000;
    let loads = 0;
    const menu = createMenuCard({ load: async () => { loads++; return [row()]; }, now: () => t });
    const first = await menu.card();
    assert.strictEqual(loads, 1);
    assert.strictEqual(await menu.card(), first);
    assert.strictEqual(loads, 1, 'a second request inside the ttl is served from the cache');
    t += CARD_TTL_S * 1000 + 1;
    await menu.card();
    assert.strictEqual(loads, 2, 'after the ttl the card is rebuilt');

    const headers = {};
    let body = null;
    const res = {
        set(k, v) { headers[k] = v; return this; },
        json(v) { body = v; return this; },
    };
    await menu.handler({}, res);
    assert.strictEqual(headers['Access-Control-Allow-Origin'], '*');
    assert.strictEqual(headers['Cache-Control'], 'public, max-age=30');
    assert.ok(Array.isArray(body) && body.length === 1, 'the file is an array of cards');
    assert.strictEqual(body[0].site, 'live');

    // A failing database keeps the last good card instead of publishing an empty rail.
    let fail = false;
    const flaky = createMenuCard({ load: async () => { if (fail) throw new Error('db down'); return [row()]; }, now: () => t });
    const good = await flaky.card();
    fail = true;
    t += CARD_TTL_S * 1000 + 1;
    assert.strictEqual(await flaky.card(), good);

    console.log('menu card: shape, empty rail, 18+ filter, plain text, 30 s cache, CORS and last-good card');
})().catch((err) => { console.error(err); process.exit(1); });
