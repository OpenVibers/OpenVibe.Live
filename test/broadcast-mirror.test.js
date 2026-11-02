'use strict';
/**
 * The preview shows what viewers get (the owner, 2026-11-01: "when the streamer is live… it shows everything flipped,
 * like mirrored. However, when you watch the VOD, it's correct… it looks proper, both on the viewer's end, in the
 * preview and the actual final thing"). The phone studio used to mirror a front camera's preview by itself; now the
 * preview is the camera's true picture unless the person asks for a mirrored self-view, which stays theirs: viewers,
 * the recording, calls and every other page never mirror a video.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const studio = read('public/js/broadcast-studio.js');
const css = read('public/css/features/broadcast.css');

// The class that flips the preview is set from mirrored() only, and mirrored() needs the person's own choice.
assert.ok(/v\.classList\.toggle\('bcs-mirror', mirrored\(\)\)/.test(studio), 'the preview flips only when mirrored() says so');
assert.ok(!/classList\.toggle\('bcs-mirror', facing\(\)/.test(studio), 'a front camera alone no longer mirrors the preview');
assert.ok(/function mirrored\(\) \{ return mirrorWanted\(\) && facing\(\) === 'user' && !screenSharing\(\); \}/.test(studio), 'asked for, a front camera, not a shared screen');
assert.ok(/function mirrorWanted\(\) \{ try \{ return localStorage\.getItem\(MIRROR_KEY\) === '1'; \}/.test(studio), 'off unless the person turned it on');
assert.ok(/tile\('fa-left-right', mirrorWanted\(\) \? 'Show it as viewers see it' : 'Mirror my preview'/.test(studio), 'the switch is in the More sheet, in plain words');
assert.ok(/'Preview mirrored: viewers see it the right way'/.test(studio), 'while mirrored, the picture says viewers see it right');

// Nothing else mirrors a video anywhere in Live's pages: the one rule is the studio preview's, behind its class.
const flips = [];
const walk = (dir) => fs.readdirSync(path.join(__dirname, '..', dir), { withFileTypes: true }).forEach((d) => {
    const rel = path.join(dir, d.name);
    if (d.isDirectory()) return walk(rel);
    if (!/\.(css|js|html)$/.test(d.name) || /\.min\./.test(d.name)) return;
    const text = read(rel);
    const re = /scaleX\(\s*-1\s*\)|scale\(\s*-1\s*,\s*1\s*\)|rotateY\(\s*180deg\s*\)|setTransform\(\s*-1/g;
    let m;
    while ((m = re.exec(text))) flips.push(`${rel}:${text.slice(0, m.index).split('\n').length}`);
});
walk('public');
// The studio's preview, and the go-live card's preview (which mirrors only when the same choice is on and the camera
// faces the person: broadcast-workspace.js _glPreviewStart). Nothing else flips a video.
const lineOf = (needle) => 'public/css/features/broadcast.css:' + css.slice(0, css.indexOf(needle)).split('\n').length;
assert.deepStrictEqual(flips, [lineOf('#bc-video-preview.bcs-mirror'), lineOf('.gl-preview video.is-mirror')],
    `only the previews' own rules may mirror a video: ${flips.join(', ')}`);

console.log('broadcast-mirror: the preview is the true picture unless the person mirrors it; nothing else flips a video');
