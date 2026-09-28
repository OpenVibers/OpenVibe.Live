#!/usr/bin/env node
/**
 * Runs every deterministic test in test/ — the files named *.test.js — each in its own process,
 * a few at a time, and fails if any of them fails (openvibe-shared/test-runner).
 *
 *   npm test                       # everything
 *   npm test -- powerchat whip     # only files whose name contains one of the words
 *   npm test -- --strict           # a skipped test fails the run too
 *
 * These tests use temp SQLite files and in-process servers only; none of them needs the network,
 * OpenVibe.Network, OpenVibe.Media, a camera or a running site. Tests that do need those live
 * elsewhere (test/browser/ needs a running server and Chrome — see `npm run test:browser`).
 * A test that cannot run part of itself here (no ffmpeg, no local model, no git history) prints
 * `<label>: skipped (<why>)`: that file is listed with ○ and not counted as passed.
 */
'use strict';
require('openvibe-shared/test-runner').main({ dir: __dirname, timeoutMs: 120000, pad: 44, hide: /^\[DB\] / });
