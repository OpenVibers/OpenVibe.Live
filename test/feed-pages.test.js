'use strict';
/** /content and /moments render crawlable ?page=N pages (roadmap D44): self-canonical, prev/next links, items in the HTML. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'live-feedpages-')), 'test.db');
process.env.NODE_ENV = 'test';
const log = console.log; console.log = () => {}; console.warn = () => {};
require('../server/db/database').initDb();
const feed = require('../server/content/feed');
const calls = [];
feed.page = async (name, q) => {
    calls.push({ name, cursor: q.cursor || null });
    const n = q.cursor ? Number(q.cursor.slice(1)) : 1;
    const items = n <= 3 ? Array.from({ length: 24 }, (_, i) => ({ kind: 'clip', id: n * 100 + i, href: `/clip/${n * 100 + i}`, title: `Clip ${n}-${i}`, channel: { display_name: 'Goosely' }, excerpt: 'x' })) : [];
    return { items, next: n < 3 ? `c${n + 1}` : null };
};
const seo = require('../server/seo/seo');

(async () => {
    const p1 = await seo._pageMeta('/content', { page: 1 });
    assert.strictEqual(p1.canonicalPath, '/content');
    assert.ok(p1.snapshot.includes('rel="next"') && p1.snapshot.includes('/content?page=2'), 'page 1 links to page 2');
    assert.ok(!p1.snapshot.includes('rel="prev"'));

    const p2 = await seo._pageMeta('/content', { page: 2 });
    assert.strictEqual(p2.canonicalPath, '/content?page=2', 'self-canonical');
    assert.ok(p2.title.includes('page 2'));
    assert.ok(p2.snapshot.includes('Clip 2-0') && p2.snapshot.includes('/clip/200'), 'page 2 items are in the HTML');
    assert.ok(p2.snapshot.includes('rel="prev"') && p2.snapshot.includes('/content?page=3'));
    assert.strictEqual(p2.jsonLd[0].mainEntity.itemListElement[0].position, 25, 'positions continue across pages');

    const p3 = await seo._pageMeta('/content', { page: 3 });
    assert.ok(p3.snapshot.includes('rel="prev"') && !p3.snapshot.includes('rel="next"'), 'the last page has no next link');
    assert.strictEqual(await seo._pageMeta('/content', { page: 4 }), null, 'past the end is not rendered');

    const m2 = await seo._pageMeta('/moments', { page: 2 });
    assert.strictEqual(m2.canonicalPath, '/moments?page=2');
    assert.ok(calls.some((c) => c.name === 'moments' && c.cursor === 'c2'), 'page 2 follows the first page\'s cursor');
    log('feed pages: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
