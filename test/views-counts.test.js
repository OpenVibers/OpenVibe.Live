'use strict';
// The one view store on Live's pages: media-client.viewCounts reads Media's public GET /api/v1/views/counts for the
// recordings, clips and live streams Live renders. It is batched, needs no token, and an unreachable Media is an
// absent count ({}) rather than a page that fails.
const assert = require('assert');
const http = require('http');

(async () => {
    let calls = 0;
    let status = 200;
    const seen = [];
    const media = http.createServer((req, res) => {
        calls += 1;
        const refs = JSON.parse(new URL(req.url, 'http://x').searchParams.get('refs'));
        seen.push(...refs);
        if (status !== 200) { res.statusCode = status; return res.end('down'); }
        const counts = {};
        for (const r of refs) counts[`${r.service}:${r.kind}:${r.id}`] = { views: 4, engaged: 1, previews: 2, preview_share: 0.5, peak_concurrent: null };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ counts }));
    });
    await new Promise((r) => media.listen(0, '127.0.0.1', r));
    process.env.MEDIA_URL = `http://127.0.0.1:${media.address().port}`;
    const mediaClient = require('../server/media-client');

    let out = await mediaClient.viewCounts([
        { service: 'media', kind: 'vod', id: '12' },
        { service: 'live', kind: 'stream', id: '7' },
    ]);
    assert.strictEqual(calls, 1, 'one batched read');
    assert.deepStrictEqual(out['media:vod:12'], { views: 4, engaged: 1, previews: 2, preview_share: 0.5, peak_concurrent: null });
    assert.deepStrictEqual(out['live:stream:7'], out['media:vod:12']);
    assert.deepStrictEqual(seen, [{ service: 'media', kind: 'vod', id: '12' }, { service: 'live', kind: 'stream', id: '7' }]);

    out = await mediaClient.viewCounts([]);
    assert.deepStrictEqual(out, {});
    assert.strictEqual(calls, 1, 'nothing to ask for makes no call');

    status = 503;
    out = await mediaClient.viewCounts([{ service: 'media', kind: 'clip', id: '3' }]);
    assert.deepStrictEqual(out, {}, 'a Media outage is an absent count');

    await new Promise((r) => media.close(r));
    console.log('views-counts: ok');
})().catch((error) => { console.error(error); process.exit(1); });
