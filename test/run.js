#!/usr/bin/env node
/**
 * Runs every deterministic test in test/ — the files named *.test.js — each in its own process,
 * a few at a time, and fails if any of them fails.
 *
 *   npm test                       # everything
 *   npm test -- powerchat whip     # only files whose name contains one of the words
 *
 * These tests use temp SQLite files and in-process servers only; none of them needs the network,
 * OpenVibe.Network, OpenVibe.Media, a camera or a running site. Tests that do need those live
 * elsewhere (test/browser/ needs a running server and Chrome — see `npm run test:browser`).
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const files = fs.readdirSync(__dirname)
    .filter((f) => f.endsWith('.test.js'))
    .filter((f) => !filters.length || filters.some((w) => f.includes(w)))
    .sort();
const PARALLEL = Math.max(1, Math.min(4, os.cpus().length - 1));
const TIMEOUT_MS = 120000;

function runOne(file) {
    return new Promise((resolve) => {
        const started = Date.now();
        const child = spawn(process.execPath, [path.join(__dirname, file)], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, NODE_ENV: 'test' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (c) => { output += c; });
        child.stderr.on('data', (c) => { output += c; });
        const timer = setTimeout(() => { output += `\n[run] timed out after ${TIMEOUT_MS}ms`; child.kill('SIGKILL'); }, TIMEOUT_MS);
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            resolve({ file, ok: code === 0, code: code ?? signal, ms: Date.now() - started, output });
        });
    });
}

(async () => {
    if (!files.length) { console.error('no test files matched'); process.exit(1); }
    const queue = [...files];
    const results = [];
    await Promise.all(Array.from({ length: PARALLEL }, async () => {
        while (queue.length) {
            const r = await runOne(queue.shift());
            results.push(r);
            console.log(`${r.ok ? '✓' : '✗'} ${r.file.padEnd(44)} ${String(r.ms).padStart(6)}ms`);
        }
    }));
    const failed = results.filter((r) => !r.ok);
    for (const r of failed) {
        console.log(`\n── ${r.file} (exit ${r.code}) ──`);
        console.log(r.output.split('\n').filter((l) => !/^\[DB\] /.test(l)).slice(-40).join('\n'));
    }
    console.log(`\n${results.length - failed.length}/${results.length} test files passed`);
    process.exit(failed.length ? 1 : 0);
})();
