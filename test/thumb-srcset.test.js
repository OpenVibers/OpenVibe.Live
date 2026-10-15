'use strict';
// Card thumbnails (public/js/app.js thumbImg): an openvibe.media thumbnail loads a WebP near the card's width through
// Media's /t/:id?w=&fmt= variants (a 480 px src and a 320/480/640 srcset); any other URL is used as it is; and a
// regenerated thumbnail drops the srcset, so the browser shows the new picture rather than the failed variants.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const between = (startMark, endMark) => { const a = js.indexOf(startMark); const b = js.indexOf(endMark, a); assert.ok(a >= 0 && b > a, startMark); return js.slice(a, b); };
const ctx = vm.createContext({});
vm.runInContext(`${between('function esc(str) {', '\n}\n')}\n}\n${between('function thumbImg(', '\nfunction formatDuration(')}\nthis.thumbImg = thumbImg;`, ctx);

const media = ctx.thumbImg('https://openvibe.media/t/vod-1-2.jpg', 'fa-video', 'A stream', '/api/thumbnails/generate/vod/1');
assert.ok(media.includes('src="https://openvibe.media/t/vod-1-2.jpg?w=480&amp;fmt=webp"'), media);
assert.ok(media.includes('srcset="https://openvibe.media/t/vod-1-2.jpg?w=320&amp;fmt=webp 320w, https://openvibe.media/t/vod-1-2.jpg?w=480&amp;fmt=webp 480w, https://openvibe.media/t/vod-1-2.jpg?w=640&amp;fmt=webp 640w"'), media);
assert.ok(media.includes('sizes="(max-width: 600px) 100vw, 320px"'));
assert.ok(media.includes('data-regenerate-url="/api/thumbnails/generate/vod/1"'), 'the regenerate path stays');

const other = ctx.thumbImg('https://example.org/x.jpg', 'fa-video', 'x');
assert.ok(other.includes('src="https://example.org/x.jpg"') && !other.includes('srcset'), 'another host is used as it is');
const queried = ctx.thumbImg('https://openvibe.media/t/vod-1-2.jpg?t=5', 'fa-video', 'x');
assert.ok(!queried.includes('srcset'), 'a URL that already has a query is used as it is');

assert.match(js, /img\.removeAttribute\('srcset'\);[^\n]*\n\s*img\.src = `\$\{data\.thumbnail_url\}/, 'a regenerated thumbnail drops the srcset before its new src');
console.log('thumb-srcset: all passed');
