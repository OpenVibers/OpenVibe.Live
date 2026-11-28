'use strict';
// A browser stream is listed once its picture or sound has reached us (11-28: streams 3080, 3096 and 3097 never sent
// any, yet sat in Live now and on the home for minutes). One that has had media keeps its card through a reconnect;
// RTMP, WHIP and JSMpeg streams are listed as before; without an SFU nothing is hidden.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const seenPath = require.resolve('../server/streaming/media-seen');

const fresh = () => { delete require.cache[seenPath]; return require(seenPath); };
const sfuWith = (rooms) => ({ findProducerByKind: (room, kind) => ((rooms[room] || []).includes(kind) ? { id: `${room}-${kind}` } : null) });

{
    const m = fresh();
    const rooms = {};
    const sfu = sfuWith(rooms);
    const list = [
        { id: 1, protocol: 'webrtc' },           // pressed Go live, nothing arrived yet
        { id: 2, protocol: 'rtmp' },             // RTMP: media is its start
        { id: 3, protocol: 'webrtc' },           // camera up
        { id: 4, protocol: 'webrtc' },           // sound only
        { id: 5, protocol: 'whip' },
    ];
    rooms['stream-3'] = ['video', 'audio'];
    rooms['stream-4'] = ['audio'];
    assert.deepStrictEqual(m.withMedia(list, sfu).map((s) => s.id), [2, 3, 4, 5], 'a browser stream with no picture and no sound is not listed');

    rooms['stream-1'] = ['video'];
    assert.deepStrictEqual(m.withMedia(list, sfu).map((s) => s.id), [1, 2, 3, 4, 5], 'it is listed once its camera arrives');

    delete rooms['stream-1']; delete rooms['stream-3'];
    assert.deepStrictEqual(m.withMedia(list, sfu).map((s) => s.id), [1, 2, 3, 4, 5], 'a stream that had media keeps its card while it reconnects');
}
{
    const m = fresh();
    assert.deepStrictEqual(m.withMedia([{ id: 9, protocol: 'webrtc' }], null).map((s) => s.id), [9], 'no SFU here: nothing is hidden');
    assert.deepStrictEqual(m.withMedia([{ id: 9, protocol: 'webrtc' }], { findProducerByKind() { throw new Error('room gone'); } }).map((s) => s.id), [9], 'an SFU that throws hides nothing');
    assert.deepStrictEqual(m.withMedia(null), [], 'no list is an empty list');
    assert.deepStrictEqual(m.withMedia([{ id: 9, protocol: 'webrtc' }], { ready: false, findProducerByKind: () => null }).map((s) => s.id), [9], 'an SFU that is not running (tests, a restore drill) hides nothing');
}
{
    // The set forgets streams no longer live once it is large.
    const m = fresh();
    const sfu = { findProducerByKind: () => ({ id: 'p' }) };
    m.withMedia(Array.from({ length: 501 }, (_, i) => ({ id: i + 1, protocol: 'webrtc' })), sfu);
    assert.strictEqual(m._seen.size, 501);
    m.withMedia([{ id: 7, protocol: 'webrtc' }], sfu);
    assert.deepStrictEqual([...m._seen], [7], 'only the live ones are kept');
}
{
    // Every public list reads it: Live now, the home's rails and hero, the menu card, the crawler home.
    const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(read('server/streaming/routes.js').includes("let streams = require('./media-seen').withMedia((await db.getLiveStreams())"), 'Live now');
    assert.strictEqual((read('server/home/routes.js').match(/require\('\.\.\/streaming\/media-seen'\)\.withMedia\(await db\.getLiveStreams\(\)/g) || []).length, 3, 'the home: hero, live rail, the signed-in rail');
    assert.ok(read('server/menu-card.js').includes("require('./streaming/media-seen').withMedia(await db.getLiveStreams())"), 'the menu card');
    assert.ok(read('server/seo/pages.js').includes("require('../streaming/media-seen').withMedia(await db.getLiveStreams()"), 'the crawler home');
    assert.ok(!/\.on\(|setInterval|setTimeout/.test(read('server/streaming/media-seen.js').replace(/\/\*[\s\S]*?\*\//g, '')), 'no listener and no timer (drill mode)');
}
console.log('stream-media-seen: a browser stream is listed once its picture or sound arrives, and keeps its card through a reconnect');
