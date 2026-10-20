/**
 * The phone studio's pinch zooms the camera itself (Live#277), and Chrome lists a camera's zoom only for a track whose
 * getUserMedia request asked for it. Every camera request goes through _getUserMediaWithTimeout
 * (public/js/broadcast-devices.js), which adds `zoom: true` on a touch screen in a browser that knows the constraint.
 *
 *   node test/broadcast-camera-zoom.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public/js/broadcast-devices.js'), 'utf8');

/** The source of a top-level function declaration, braces matched (after its parameter list). */
function extract(name) {
    const m = new RegExp(`(?:async )?function ${name}\\(`).exec(src);
    assert.ok(m, `${name}() must exist`);
    let i = m.index + m[0].length;
    for (let parens = 1; parens; i++) { if (src[i] === '(') parens++; else if (src[i] === ')') parens--; }
    i = src.indexOf('{', i);
    for (let depth = 0; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(m.index, i + 1);
    }
    throw new Error(`unbalanced ${name}`);
}

/** A browser: touch screen or not, knows `zoom` or not, and getUserMedia answers from `answer(constraints)`. */
function browser({ coarse = true, knowsZoom = true, answer = () => ({ id: 'stream' }) } = {}) {
    const asked = [];
    const ctx = {
        console: { warn() {} },
        setTimeout, clearTimeout,
        window: { matchMedia: (q) => ({ matches: q === '(pointer: coarse)' && coarse }) },
        navigator: {
            mediaDevices: {
                getSupportedConstraints: () => (knowsZoom ? { deviceId: true, zoom: true } : { deviceId: true }),
                getUserMedia: async (c) => { asked.push(c); return answer(c, asked.length); },
            },
        },
    };
    vm.createContext(ctx);
    vm.runInContext(`${extract('_withCameraZoom')}\n${extract('_getUserMediaWithTimeout')}\nthis.gum = _getUserMediaWithTimeout;`, ctx);
    return { gum: ctx.gum, asked };
}

(async () => {
    // A phone opening the back camera for going live: the zoom wish rides along, everything else as asked.
    const phone = browser();
    const live = { video: { deviceId: { exact: 'back' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: { echoCancellation: true } };
    await phone.gum(live);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(phone.asked[0])), {
        video: { deviceId: { exact: 'back' }, width: { ideal: 1280 }, height: { ideal: 720 }, zoom: true },
        audio: { echoCancellation: true },
    });
    assert.ok(!('zoom' in live.video), "the caller's constraints are not changed");

    // The bare fallbacks ask too, so a recovered track can still zoom.
    await phone.gum({ video: true, audio: true });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(phone.asked[1])), { video: { zoom: true }, audio: true });

    // A microphone-only request is left alone.
    const mic = { audio: true, video: false };
    await phone.gum(mic);
    assert.strictEqual(phone.asked[2], mic);

    // A desktop (no pinch there) and a browser that doesn't know the constraint ask as before.
    const desktop = browser({ coarse: false });
    await desktop.gum(live);
    assert.strictEqual(desktop.asked[0], live, 'no zoom (and no pan-tilt-zoom prompt) on a desktop');
    const older = browser({ knowsZoom: false });
    await older.gum(live);
    assert.strictEqual(older.asked[0], live);

    // A browser that throws on the wish is asked again as the caller asked.
    const picky = browser({ answer: (c, n) => { if (n === 1) { const e = new TypeError('bad constraint'); throw e; } return { id: 'second' }; } });
    assert.deepStrictEqual(await picky.gum(live), { id: 'second' });
    assert.strictEqual(picky.asked.length, 2);
    assert.strictEqual(picky.asked[1], live);

    // A refusal is final: no second permission prompt.
    const refused = browser({ answer: () => { const e = new Error('denied'); e.name = 'NotAllowedError'; throw e; } });
    await assert.rejects(refused.gum(live), /denied/);
    assert.strictEqual(refused.asked.length, 1);

    // The studio's pinch reads the zoom this request unlocks.
    const studio = fs.readFileSync(path.join(__dirname, '..', 'public/js/broadcast-studio.js'), 'utf8');
    assert.match(studio, /getCapabilities\(\)\.zoom/);

    console.log('broadcast camera zoom: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
