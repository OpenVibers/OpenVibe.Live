/**
 * Home page size budgets (scripts/perf/check-budgets.js), run as part of `npm test` so a change that
 * puts route code or markup back on the first load fails before it ships.
 */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'perf', 'check-budgets.js')], { encoding: 'utf8' });
process.stdout.write(r.stdout); process.stderr.write(r.stderr);
process.exit(r.status);
