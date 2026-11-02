'use strict';
// Live's guides in OpenVibe.Search (server/events/search-guides.js; Contracts 0.278.0 type `doc`): each guide in ./docs
// goes through the outbox as live.index_document.upserted, a valid Search document whose id is the guide's name, again
// only when it changed; operator notes and retired pages stay off; the headline guide reads as itself.
const assert = require('assert');
const http = require('http');
const quiet = console.log;
console.log = (...a) => { if (!/^\[/.test(String(a[0]))) quiet(...a); };
console.warn = () => {};

const published = [];
const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 300 }));
        if (req.url === '/api/v1/events' && req.method === 'POST') {
            const parsed = JSON.parse(body);
            const list = parsed.events || [parsed];
            const { validate } = require('openvibe-contracts');
            const bad = list.find((e) => !validate('events.event-envelope@1', e).valid);
            if (bad) { res.statusCode = 422; return res.end(JSON.stringify({ code: 'events.invalid_envelope' })); }
            const results = list.map((e) => { published.push(e); return { event_id: e.event_id, seq: published.length, duplicate: false }; });
            return res.end(JSON.stringify(parsed.events ? { results } : results[0]));
        }
        res.statusCode = 404; res.end('{}');
    });
});

(async () => {
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${stub.address().port}`;
    process.env.OV_NETWORK_INTERNAL_URL = base;
    const { validate } = require('openvibe-contracts');
    const db = require('../server/db/database');
    await db.initDb();
    const streamEvents = require('../server/events/stream-events');
    const outbox = streamEvents.init({ eventsUrl: base, clientSecret: 's3cret', intervalMs: 50 });
    const guides = require('../server/events/search-guides');

    const names = guides.guides().map((g) => g.name);
    assert.ok(names.includes('go-live-in-your-browser') && names.includes('whip') && names.includes('streams-api'), names.join(','));
    for (const off of ['deploy', 'performance-audit', 'arena', 'restream-branding', 'vods-and-clips', 'README']) assert.ok(!names.includes(off), `${off} stays off search`);

    const now = Date.parse('2026-11-02T18:00:00Z');
    const n = await guides.publishAll({ now });
    assert.strictEqual(n, names.length, 'every guide once');
    await outbox.flush();
    const sentDocs = published.filter((e) => e.event_type === 'live.index_document.upserted');
    assert.strictEqual(sentDocs.length, names.length);
    const head = sentDocs.find((e) => e.payload.id === 'go-live-in-your-browser');
    assert.deepStrictEqual([head.subject.type, head.subject.id], ['doc', 'go-live-in-your-browser']);
    // What Search validates (server/api/webhook.js: search.index-document@1), with the owner it takes from the event.
    const v = validate('search.index-document@1', head.payload);
    assert.ok(v.valid, JSON.stringify(v.errors));
    assert.strictEqual(head.payload.canonical_url, 'https://openvibe.live/docs/go-live-in-your-browser');
    assert.match(head.payload.title, /^Go live from your browser/);
    assert.match(head.payload.summary, /nothing to install/);
    assert.ok(!head.payload.body.includes(head.payload.summary.slice(0, 60)), 'the body does not repeat the summary');
    assert.ok(!/[#`*|]{2}|\]\(/.test(head.payload.body), 'no Markdown left in the text');
    const revs = sentDocs.map((e) => e.payload.revision);
    assert.strictEqual(new Set(revs).size, revs.length, 'each its own revision');
    assert.ok(Math.min(...revs) > Math.floor(now / 1000), 'revisions from the send time, so a restart only goes up');
    assert.strictEqual(await guides.publishAll({ now: now + 60_000 }), 0, 'nothing changed: nothing sent');

    // A guide's own shape: title from its heading, summary from its first prose paragraph.
    const doc = guides.documentFor('sample-guide', '# Sample guide\n\n> A note.\n\nFirst **real** paragraph with a [link](https://x.y). More.\n\n## Part\n\n- a point\n\n```js\ncode();\n```\n');
    assert.deepStrictEqual([doc.title, doc.summary], ['Sample guide', 'First real paragraph with a link. More.']);
    assert.ok(!doc.body.includes('code()'), 'no code blocks in the text');
    assert.strictEqual(guides.documentFor('Bad Name', '# x'), null);
    assert.strictEqual(guides.documentFor('no-title', 'no heading here'), null);

    await outbox.stop();
    stub.close();
    console.log('search guides: every guide once, valid for Search, the headline guide as itself, nothing again until it changes');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
