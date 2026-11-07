'use strict';
// The account hub moved to its own origin, openvibe.my (Network, 2026-11-07). Its go-live widget follows Live's
// /api/live-events and its Today card reads who is live, so Live's CORS allow-list names it: without it the probe's
// signed-in hub logged a 403 from /api/live-events on production. The list is exact (no wildcard for the .my name).
//   node test/origin-openvibe-my.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
const fn = src.slice(src.indexOf('function getAllowedOrigins()'), src.indexOf('return allowed;', src.indexOf('function getAllowedOrigins()')));
assert.ok(fn.length > 100, 'getAllowedOrigins() is where Live lists its origins');
assert.ok(fn.includes("allowed.add('https://openvibe.my');"), 'openvibe.my is allowed');
assert.ok(!/openvibe\.my['"]?\)\s*\|\||endsWith\(['"]\.openvibe\.my/.test(src), 'exact origin, no suffix rule for .my');
console.log('origin-openvibe-my: Live allows the account hub on openvibe.my');
