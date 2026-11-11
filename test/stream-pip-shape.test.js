'use strict';
// A PIP takes its source's own shape (public/js/stream-pip.js; 2026-11-07, Maticus: "portrait is displayed as
// cropped, not actual portrait dimensions"). What this proves:
//   - a 9:16 camera is drawn 9:16 (aspect-ratio from the video, object-fit contain), never cut to 16:9;
//   - any shape keeps the area of a 16:9 PIP of the saved width, and is never taller than 85% of the player;
//   - the shown place is kept inside the player without changing the saved place;
//   - dropped near an edge it snaps to a 12 px margin; dropped in the middle it stays put;
//   - on a phone-sized player it is never smaller than a 150 px wide 16:9 box.
//   node test/stream-pip-shape.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'stream-pip.js'), 'utf8');
// The move's geometry lives in openvibe-shared/ov-float.js now; these adapters are what the page uses.
const floatSrc = fs.readFileSync(require.resolve('openvibe-shared/ov-float'), 'utf8');
const ctx = { window: {}, document: {}, localStorage: { getItem: () => null, setItem() {} }, console, setInterval, clearInterval };
vm.createContext(ctx);
vm.runInContext(floatSrc, ctx);
vm.runInContext(src, ctx);
const { boxOf, settle, applyGeom } = ctx.window.streamPip._test;

const player = (width, height) => ({ getBoundingClientRect: () => ({ width, height }) });
const el = () => {
    const classes = new Set();
    return { style: {}, classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), has: (c) => classes.has(c) } };
};
const pip = (aspect, geom, w = 1280, h = 720) => ({ aspect, geom: { x: 0.7, y: 0.7, w: 0.25, hidden: false, ...geom }, container: player(w, h), el: el(), pip: {} });
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);

let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

check('a portrait camera keeps its shape and the area of a 16:9 PIP', () => {
    const land = boxOf(pip(16 / 9, {}));
    const port = boxOf(pip(9 / 16, {}));
    near(land.wf, 0.25, 'the 16:9 width is w');
    const area = (b) => (b.wf * 1280) * ((b.wf * 1280) / b.a);
    near(area(port), area(land), 'same area in pixels');
    assert.ok(port.hf > port.wf, 'taller than wide');
    near((port.wf * 1280) / (port.hf * 720), 9 / 16, 'drawn 9:16');
});

check('applyGeom draws the source shape and marks a portrait one', () => {
    const o = pip(9 / 16, {});
    applyGeom(o);
    assert.strictEqual(o.el.style.aspectRatio, String(9 / 16));
    assert.ok(o.el.classList.has('is-portrait'));
    const l = pip(16 / 9, {});
    applyGeom(l);
    assert.ok(!l.el.classList.has('is-portrait'));
});

check('never taller than 85% of the player', () => {
    const b = boxOf(pip(9 / 16, { w: 0.6 }));
    assert.ok(b.hf <= 0.85 + 1e-9, `height ${b.hf}`);
    near(b.hf, 0.85, 'capped at the limit');
});

check('shown inside the player; the saved place is unchanged', () => {
    const o = pip(9 / 16, { x: 0.95, y: 0.95 });
    applyGeom(o);
    const b = boxOf(o);
    near(parseFloat(o.el.style.left) / 100, 1 - b.wf, 'left pulled in');
    near(parseFloat(o.el.style.top) / 100, 1 - b.hf, 'top pulled in');
    assert.strictEqual(o.geom.x, 0.95, 'saved x kept');
});

check('a drop near an edge snaps to a 12 px margin; the middle stays put', () => {
    const o = pip(16 / 9, { x: 0.01, y: 0.02 });
    settle(o);
    near(o.geom.x, 12 / 1280, 'left edge');
    near(o.geom.y, 12 / 720, 'top edge');
    const b = boxOf(o);
    const r = pip(16 / 9, { x: 1 - b.wf - 0.01, y: 1 - b.hf - 0.01 });
    settle(r);
    near(r.geom.x, 1 - b.wf - 12 / 1280, 'right edge');
    near(r.geom.y, 1 - b.hf - 12 / 720, 'bottom edge');
    const m = pip(16 / 9, { x: 0.4, y: 0.3 });
    settle(m);
    assert.strictEqual(m.geom.x, 0.4); assert.strictEqual(m.geom.y, 0.3);
});

check('on a phone-sized player it is never smaller than a 150 px wide 16:9 box', () => {
    const b = boxOf(pip(16 / 9, { w: 0.25 }, 390, 219));
    near(b.wf * 390, 150, '150 px wide');
    const p = boxOf(pip(9 / 16, { w: 0.25 }, 390, 219));
    near((p.wf * 390) * ((p.wf * 390) / p.a), 150 * (150 / (16 / 9)), 'a portrait one keeps that area');
    near(boxOf(pip(16 / 9, { w: 0.25 })).wf, 0.25, 'a desktop player shows the saved size');
});

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'features', 'pip.css'), 'utf8');
check('the video is contained, never cropped', () => {
    assert.match(css, /\.ov-pip-video \{[^}]*object-fit: contain/);
    assert.doesNotMatch(css, /\.ov-pip-video \{[^}]*object-fit: cover/);
});

console.log(`stream-pip shape: ${n} passed`);
