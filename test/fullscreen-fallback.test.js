'use strict';
// Fullscreen on every browser (2026-11-20; RUM: "container.requestFullscreen is not a function" 18 times, an iPhone's
// Safari): the live player (stream-player.js) and the media player (media-player.js) toggle through the same order as
// openvibe-shared/player.js. Checked on the functions as written in each file:
//   - a browser with element fullscreen uses it; older Safari the prefixed call; an iPhone the video's own;
//   - nothing to call is not an error; in fullscreen, the button leaves it (the prefixed exit too);
//   - both buttons go through it (no bare requestFullscreen() left).
//   node test/fullscreen-fallback.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const files = { _spToggleFullscreen: 'stream-player.js', _mpToggleFullscreen: 'media-player.js' };
for (const [name, file] of Object.entries(files)) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', file), 'utf8');
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${file} has ${name}`);
    const end = src.indexOf('\n}\n', start) + 2;
    const doc = {};
    const toggle = new Function('document', `${src.slice(start, end)}; return ${name};`)(doc);
    const calls = [];
    const promise = () => ({ catch() {} });

    toggle({ requestFullscreen() { calls.push('element'); return promise(); }, webkitRequestFullscreen() { calls.push('prefixed'); } }, { webkitEnterFullscreen() { calls.push('video'); } });
    toggle({ webkitRequestFullscreen() { calls.push('prefixed'); } }, { webkitEnterFullscreen() { calls.push('video'); } });
    toggle({}, { webkitEnterFullscreen() { calls.push('video'); } });
    toggle({}, {});
    toggle(null, null);
    assert.deepStrictEqual(calls, ['element', 'prefixed', 'video'], `${file}: element, then prefixed, then the video's own; nothing to call is no error`);

    doc.fullscreenElement = {}; doc.exitFullscreen = () => { calls.push('exit'); return promise(); };
    toggle({ requestFullscreen() { calls.push('again'); return promise(); } }, null);
    delete doc.fullscreenElement; delete doc.exitFullscreen;
    doc.webkitFullscreenElement = {}; doc.webkitExitFullscreen = () => { calls.push('webkit exit'); };
    toggle({ requestFullscreen() { calls.push('again'); return promise(); } }, null);
    assert.deepStrictEqual(calls.slice(3), ['exit', 'webkit exit'], `${file}: in fullscreen, the button leaves it`);

    const bare = src.split('\n').filter((l) => /\.requestFullscreen\(\)/.test(l) && !/box\.requestFullscreen\(\)/.test(l));
    assert.deepStrictEqual(bare, [], `${file}: every fullscreen goes through ${name}`);
}
console.log('fullscreen fallback: element, prefixed, then the video\'s own; both players');
