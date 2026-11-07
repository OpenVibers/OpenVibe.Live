'use strict';
// The menu's network card (frame.menu-card@1): GET /.well-known/openvibe-menu.json serves Live's "Live now"
// rail — the public channels live right now, most watched first — with no items when nobody is live, CORS * and
// a 30 s cache. The card never carries a row's ingest key or owner-only fields, and 18+ channels stay off it.
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { createMenuCard, cardFrom, imageOf, plain, CARD_TTL_S } = require('../server/menu-card');

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

assert.ok(contracts.validate('frame.menu-cards@1', [card]).valid, 'the file validates against frame.menu-cards@1');

// Pictures: each stream's own live thumbnail, made absolute for a local /api/thumbnails path; real pictures only.
const pictured = cardFrom([
    row({ id: 1, username: 'nova', viewer_count: 30, thumbnail_url: '/api/thumbnails/stream-1-123.jpg' }),
    row({ id: 2, username: 'kitchen', viewer_count: 20, thumbnail_url: 'https://openvibe.media/t/vod-2.jpg' }),
    row({ id: 3, username: 'elsewhere', viewer_count: 10, thumbnail_url: 'https://example.com/x.jpg' }),
    row({ id: 4, username: 'plainhttp', viewer_count: 5, thumbnail_url: 'http://openvibe.live/api/thumbnails/x.jpg' }),
    row({ id: 5, username: 'quiet', viewer_count: 1 }),
]);
assert.deepStrictEqual(pictured.items[0].image, { src: 'https://openvibe.live/api/thumbnails/stream-1-123.jpg' }, 'a local live thumb becomes an absolute own-origin URL');
assert.deepStrictEqual(pictured.items[1].image, { src: 'https://openvibe.media/t/vod-2.jpg' }, 'a Media picture is kept as it is');
assert.ok(!pictured.items[2].image && !pictured.items[3].image && !pictured.items[4].image, 'a third-party, plain-http or missing picture sends no image');
assert.ok(contracts.validate('frame.menu-cards@1', [pictured]).valid, 'a pictured file validates against frame.menu-cards@1');
assert.strictEqual(imageOf({ thumbnail_url: 'javascript:alert(1)' }), null);
assert.strictEqual(imageOf({ thumbnail_url: 'https://openvibe.live/x.jpg'.padEnd(401, 'x') }), null, 'a src over 400 characters is dropped');

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
