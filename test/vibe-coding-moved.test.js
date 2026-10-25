'use strict';

// Vibe coding feeds are OpenVibe.Chat's since 2026-10-24 (its server/feeds/, openvibe.chat/feeds; the owner: "migrate
// that whole entire feature so it's built into the openvibe.chat system"). Nothing under server/ or scripts/ reads or
// writes Live's vibe_coding_sessions or vibe_coding_events (Chat's scripts/import-live-feeds.js copied them, verified, on
// 2026-10-25; migrations/0018_drop_vibe_coding.sql drops them), the publisher socket and the old routes answer 410 naming Chat, and
// the channel chat shows Chat's own card instead of Live's widget.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAMES = /\b(vibe_coding_sessions|vibe_coding_events)\b/;
const isCommentLine = (line) => /^\s*(\/\/|\*|\/\*|--)/.test(line);

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); } else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}

const offenders = [];
for (const file of [...walk(path.join(ROOT, 'server')), ...walk(path.join(ROOT, 'scripts'))]) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (!isCommentLine(line) && NAMES.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
}
assert.deepStrictEqual(offenders, [], 'vibe coding feeds are OpenVibe.Chat\'s: nothing here reads Live\'s old tables');
assert.ok(!fs.existsSync(path.join(ROOT, 'server/vibe-coding')), 'Live runs no feed server');

const { classify } = require('../server/net/ws-paths');
assert.deepStrictEqual(classify('/ws/vibe-coding/publish?token=x'), { status: '410 Gone', text: 'Vibe coding feeds moved to OpenVibe.Chat: https://openvibe.chat/feeds' });

const index = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
assert.match(index, /app\.use\('\/api\/vibe-coding', \(req, res\) => res\.status\(410\)/, 'the old routes say where feeds went');
assert.match(index, /app\.get\('\/api\/vibe-coding\/channel\/:username\/:slot\/events', \(req, res\) => res\.json\(\{ managed_stream: null, live_stream_id: null, settings: VIBE_CODING_OFF,/, 'an N-1 page gets a feed that is off');
assert.match(index, /const VIBE_CODING_OFF = Object\.freeze\(\{ enabled: 0,/);
assert.match(index, /frameSrc: \[[^\]]*"https:\/\/openvibe\.chat"/, 'the card frames Chat\'s embed');
assert.match(index, /connectSrc: \[[^\]]*"https:\/\/openvibe\.chat"/, 'and asks Chat which feed a slot shows');

const chat = fs.readFileSync(path.join(ROOT, 'public/js/chat.js'), 'utf8');
assert.ok(!/_vibeWidgetState|refreshVibeWidgetFeed|\/vibe-coding\/channel\//.test(chat), 'Live\'s own widget is gone');
assert.match(chat, /\$\{FEED_ORIGIN\}\/api\/chat\/feeds\?slot=/);
assert.match(chat, /\$\{FEED_ORIGIN\}\/embed\/feed\//);
assert.match(chat, /e\.origin !== FEED_ORIGIN/, 'the card\'s height comes only from Chat\'s frame');
// The contract migration drops them, after the N-1 window (it names 0002, so the migrator holds it for 7 days).
const drop = fs.readFileSync(path.join(ROOT, 'migrations', '0018_drop_vibe_coding.sql'), 'utf8');
assert.match(drop, /^-- phase: contract$/m);
assert.match(drop, /^-- after: 0002$/m);
assert.deepStrictEqual([...drop.matchAll(/^DROP TABLE IF EXISTS (\w+);$/gm)].map((m) => m[1]).sort(), ['vibe_coding_events', 'vibe_coding_sessions']);
console.log('vibe coding: Chat\'s; nothing reads Live\'s old tables, the old socket and routes answer 410, the channel shows Chat\'s card');
