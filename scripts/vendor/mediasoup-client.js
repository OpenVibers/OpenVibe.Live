#!/usr/bin/env node
'use strict';
/**
 * mediasoup-client for the browser, from Live itself (2026-11-19).
 *
 * The WebRTC viewer, the agent player and the RobotStreamer broadcast imported it from https://esm.sh at run time: a new
 * origin to look up and connect to, then a waterfall of a dozen modules and their dependencies, on every cold start of a
 * stream (619 ms on a desktop line in Chrome, against 28 ms from Live; a phone's round trips make it longer). This
 * builds the same version as one ES module with the package's own named exports:
 *
 *   node scripts/vendor/mediasoup-client.js [version]     (default 3.18.7, what the pages imported)
 *
 * It installs npm mediasoup-client@<version> in a temporary folder, bundles it with this repository's esbuild, and
 * writes public/js/vendor/mediasoup-client-<version>.min.js and the bundled packages' licenses
 * (public/js/vendor/mediasoup-client.LICENSE). The bytes are reproducible; test/vendor-players.test.js pins them.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const esbuild = require('esbuild');

const VERSION = process.argv[2] || '3.18.7';
const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'public', 'js', 'vendor');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-msc-'));
try {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'ov-msc', private: true }));
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', `mediasoup-client@${VERSION}`], { cwd: tmp, stdio: 'ignore' });
    const ms = require(path.join(tmp, 'node_modules', 'mediasoup-client'));
    const names = Object.keys(ms).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== 'default');
    fs.writeFileSync(path.join(tmp, 'entry.mjs'), `// mediasoup-client ${VERSION} as one ES module with its named exports (Live vendors it: /js/vendor/).\nimport ms from 'mediasoup-client';\n${names.map((n) => `export const ${n} = ms.${n};`).join('\n')}\nexport default ms;\n`);
    const file = `mediasoup-client-${VERSION}.min.js`;
    const result = esbuild.buildSync({
        entryPoints: [path.join(tmp, 'entry.mjs')], absWorkingDir: tmp, bundle: true, format: 'esm', platform: 'browser', target: 'es2020',
        minify: true, legalComments: 'none', metafile: true, outfile: path.join(OUT, file),
        define: { 'process.env.NODE_ENV': '"production"', 'process.env.DEBUG': 'undefined', global: 'globalThis' },
    });
    // Every bundled package's own license, in one file beside the bundle.
    const packages = new Set();
    for (const f of Object.keys(result.metafile.inputs)) { const m = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(f); if (m) packages.add(m[1]); }
    const parts = [`${file}: an esbuild bundle of npm mediasoup-client@${VERSION} and the packages below (scripts/vendor/mediasoup-client.js).`];
    for (const p of [...packages].sort()) {
        const dir = path.join(tmp, 'node_modules', p);
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        const lic = fs.readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
        parts.push(`\n── ${p} ${pkg.version} (${pkg.license}) ──\n\n${lic ? fs.readFileSync(path.join(dir, lic), 'utf8').trim() : `${pkg.license}: no license file in the package.`}`);
    }
    fs.writeFileSync(path.join(OUT, 'mediasoup-client.LICENSE'), `${parts.join('\n')}\n`);
    console.log(`wrote public/js/vendor/${file} (${packages.size} packages) and mediasoup-client.LICENSE`);
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}
