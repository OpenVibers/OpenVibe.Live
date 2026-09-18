#!/usr/bin/env node
'use strict';
// Render a site's icon set from openvibe-shared/app-icon.
//   node build-app-icons.js <site> <outDir> [--sharp <path-to-sharp-module>]
// Writes logo.svg (favicon), logo-72/192/512.png (rounded tile) and logo-maskable-192/512.png.
const fs = require('fs'); const path = require('path');
const icon = require('../app-icon');
const [site, outDir] = process.argv.slice(2);
if (!site || !outDir) { console.error('usage: build-app-icons.js <site> <outDir> [--sharp <module path>]'); process.exit(1); }
const i = process.argv.indexOf('--sharp');
const sharp = require(i > 0 ? path.resolve(process.argv[i + 1]) : 'sharp');
(async () => {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'logo.svg'), icon.favicon({ site }));
    for (const s of [72, 192, 512]) await sharp(Buffer.from(icon.svg({ site, maskable: false })), { density: 300 }).resize(s, s).png({ compressionLevel: 9 }).toFile(path.join(outDir, `logo-${s}.png`));
    for (const s of [192, 512]) await sharp(Buffer.from(icon.svg({ site, maskable: true })), { density: 300 }).resize(s, s).png({ compressionLevel: 9 }).toFile(path.join(outDir, `logo-maskable-${s}.png`));
    console.log(`icons for ${site} → ${outDir}`);
})().catch(e => { console.error(e); process.exit(1); });
