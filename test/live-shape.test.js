/**
 * The live picture's shape, read on the server (server/streaming/live-shape.js, 2026-11-28): a portrait stream's channel
 * page moved its chat 238 px on phones once the picture's shape arrived (RUM channel|phone CLS p75 0.49). The page now
 * carries the shape of the stream's live thumbnail on the player box, so the first layout is the final one.
 *
 * - Width and height come from a JPEG's frame header (after its tables) or a PNG's IHDR; anything else is unknown.
 * - Only /api/thumbnails/stream-<id>-<time>.(jpg|png) names are read, from the live thumbnail directory, once each.
 * - The ratio keeps to player-shape.js's bounds; the channel page writes it as data-shape-hint with the channel's name.
 *
 *   node test/live-shape.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { liveShape, imageSize } = require('../server/streaming/live-shape');

function png(w, h) {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).copy(b, 0);
    b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
    return b;
}
function jpeg(w, h) {
    const app0 = Buffer.from([0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
    const dqt = Buffer.concat([Buffer.from([0xFF, 0xDB, 0x00, 0x43, 0x00]), Buffer.alloc(64, 1)]);
    const dht = Buffer.concat([Buffer.from([0xFF, 0xC4, 0x00, 0x14, 0x00]), Buffer.alloc(17, 0)]);
    const sof = Buffer.from([0xFF, 0xC0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    const sos = Buffer.from([0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00]);
    return Buffer.concat([Buffer.from([0xFF, 0xD8]), app0, dqt, dht, sof, sos, Buffer.alloc(32, 7), Buffer.from([0xFF, 0xD9])]);
}

assert.deepStrictEqual(imageSize(png(640, 360)), { w: 640, h: 360 }, 'PNG IHDR');
assert.deepStrictEqual(imageSize(jpeg(360, 640)), { w: 360, h: 640 }, 'JPEG: the frame header after APP0, DQT and DHT (C4 is not a frame)');
assert.deepStrictEqual(imageSize(jpeg(1920, 1080)), { w: 1920, h: 1080 });
assert.strictEqual(imageSize(Buffer.from('GIF89a................................')), null, 'not a JPEG or PNG');
assert.strictEqual(imageSize(jpeg(640, 360).subarray(0, 60)), null, 'cut before the frame header');
const scanOnly = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x08]), Buffer.alloc(40)]);
assert.strictEqual(imageSize(scanOnly), null, 'image data before any frame header');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-shape-'));
fs.writeFileSync(path.join(dir, 'stream-7-1000.jpg'), jpeg(720, 1280));
fs.writeFileSync(path.join(dir, 'stream-8-1000.png'), png(1280, 720));
fs.writeFileSync(path.join(dir, 'stream-9-1000.jpg'), jpeg(5000, 100));
assert.ok(Math.abs(liveShape('/api/thumbnails/stream-7-1000.jpg', dir) - 0.5625) < 1e-9, 'a portrait live picture');
assert.ok(Math.abs(liveShape('/api/thumbnails/stream-8-1000.png', dir) - 16 / 9) < 1e-9, 'a landscape one');
assert.strictEqual(liveShape('/api/thumbnails/stream-9-1000.jpg', dir), 3.2, 'held to the player\'s bounds');
assert.strictEqual(liveShape('/api/thumbnails/stream-10-1000.jpg', dir), null, 'no such file');
for (const bad of [null, '', 'https://cdn.example/stream-7-1000.jpg', '/api/thumbnails/../secret.jpg', '/api/thumbnails/stream-7-1000.jpg?x', '/data/offline/a.webp']) {
    assert.strictEqual(liveShape(bad, dir), null, `not a live thumbnail name: ${bad}`);
}
// Read once per file: a later change to the same name is not re-read (each new picture has a new name).
fs.writeFileSync(path.join(dir, 'stream-7-1000.jpg'), jpeg(1280, 720));
assert.ok(Math.abs(liveShape('/api/thumbnails/stream-7-1000.jpg', dir) - 0.5625) < 1e-9, 'cached by name');
fs.rmSync(dir, { recursive: true, force: true });

// The channel page carries it: pages.js reads it for a live channel's first page and writes it on the player box.
const pages = fs.readFileSync(path.join(__dirname, '..', 'server', 'seo', 'pages.js'), 'utf8');
assert.ok(/playerShape: page === 1 && liveNow && !acct\.banned \? require\('\.\.\/streaming\/live-shape'\)\.liveShape\(liveNow\.thumbnail_url\)/.test(pages), 'the channel meta reads the live picture\'s shape');
assert.ok(pages.includes('data-shape-hint="${Number(meta.playerShape).toFixed(4)}" data-shape-key="${esc(meta.channelUsername)}"'), 'the player box carries it with the channel\'s name');
const frag = fs.readFileSync(path.join(__dirname, '..', 'public', 'fragments', 'channel.html'), 'utf8');
assert.ok(frag.includes('<div class="video-container" id="video-container" tabindex="-1">'), 'the fragment\'s player box is the one the page fills');

console.log('live-shape: the live picture\'s shape is read from its header and the channel page starts the player in it');
