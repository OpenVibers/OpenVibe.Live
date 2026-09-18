#!/usr/bin/env node
'use strict';
// Measure every glyph's drawn bounds in a real browser and write centring offsets into ov-icons.js.
//   node scripts/measure-icons.js <path-to-cdp-harness>
// A glyph drawn by hand in a 24-unit box is rarely centred on 12,12; the eye notices half a unit
// inside a ring. getBBox() gives the truth, the offsets table corrects it, and SSR uses the same table.
const fs = require('fs'); const path = require('path');
const { launch, sleep } = require(path.resolve(process.argv[2]));
const FILE = path.join(__dirname, '..', 'ov-icons.js');
(async () => {
    const src = fs.readFileSync(FILE, 'utf8').replace(/const OFFSETS = \{[^}]*\};/, 'const OFFSETS = {/*OFFSETS*/};');
    const cdp = await launch({ width: 400, height: 300 });
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: 'data:text/html,<body></body>' }); await sleep(800);
    await cdp.evaluate(src);
    const out = await cdp.evaluate(`(() => { const r = {}; for (const n of OpenVibeIcons.names()) { const d = document.createElement('div'); d.innerHTML = OpenVibeIcons.svg(n, 48); document.body.appendChild(d); const b = d.querySelector('.ovi-glyph').getBBox(); r[n] = [+(12 - (b.x + b.width / 2)).toFixed(2), +(12 - (b.y + b.height / 2)).toFixed(2)]; d.remove(); } return r; })()`);
    cdp.close();
    const table = Object.entries(out).filter(([, [x, y]]) => Math.abs(x) >= 0.05 || Math.abs(y) >= 0.05).map(([n, [x, y]]) => `${JSON.stringify(n)}:[${x},${y}]`).join(',');
    fs.writeFileSync(FILE, src.replace('const OFFSETS = {/*OFFSETS*/};', `const OFFSETS = {${table}};`));
    console.log(`${Object.keys(out).length} glyphs measured, ${table.split('],').length} corrected`);
    const worst = Object.entries(out).sort((a, b) => Math.hypot(...b[1]) - Math.hypot(...a[1])).slice(0, 8).map(([n, o]) => `${n}${JSON.stringify(o)}`).join(' ');
    console.log('largest corrections:', worst);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
