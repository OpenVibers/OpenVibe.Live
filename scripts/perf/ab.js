#!/usr/bin/env node
'use strict';
// Interleaved A/B page-load comparison: alternates single cold runs of two URLs so drift in machine
// load affects both sides equally, then prints medians side by side.
//
//   node scripts/perf/ab.js <urlA> <urlB> [--runs 6] [--phone] [--settle 8000]
const { execFileSync } = require('child_process');
const path = require('path');
const args = process.argv.slice(2);
const [A, B] = args.filter((a) => /^https?:/.test(a));
const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const runs = Number(flag('--runs', 6));
const extra = [];
if (args.includes('--phone')) extra.push('--phone');
if (args.includes('--phone-cpu')) extra.push('--phone-cpu');
extra.push('--settle', String(flag('--settle', 8000)));
const one = (url) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'measure-page.js'), url, '--runs', '1', '--json', ...extra], { encoding: 'utf8', maxBuffer: 1 << 24 }));
const a = [], b = [];
for (let i = 0; i < runs; i++) { a.push(one(A)); b.push(one(B)); process.stderr.write('.'); }
process.stderr.write('\n');
const med = (xs) => { const s = [...xs].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const keys = ['htmlWireKB', 'htmlRawKB', 'jsCount', 'jsWireKB', 'jsRawKB', 'cssCount', 'cssWireKB', 'cssRawKB', 'requests', 'totalWireKB', 'domNodes', 'runningAnimations', 'fcp', 'lcp', 'cls', 'longTaskMs', 'tbt', 'scriptMs', 'styleMs', 'layoutMs', 'taskMs', 'heapMB'];
console.log(`metric             A (median of ${runs})   B (median of ${runs})   delta`);
for (const k of keys) {
    const ma = med(a.map((r) => r[k])), mb = med(b.map((r) => r[k]));
    const d = ma ? `${(((mb - ma) / ma) * 100).toFixed(1)}%` : '';
    console.log(`${k.padEnd(18)} ${String(ma).padStart(12)}   ${String(mb).padStart(12)}   ${d.padStart(8)}`);
}
console.log('A errors:', [...new Set(a.flatMap((r) => r.errors))].slice(0, 3), '| B errors:', [...new Set(b.flatMap((r) => r.errors))].slice(0, 3));
