'use strict';

// T3: the Live end of the retired chat read mirror is gone. OpenVibe.Chat #25 (deployed) removed the
// sender (its LIVE_MIRROR writer and the capture triggers); this change removed Live's receiver —
// POST /internal/chat-effects/mirror and the chat-delivery.js mirror() helper (MIRROR_WRITES) — and
// its call sites. Static guard: nothing under server/ names the receiver, its capability, the mirror
// tables or the helper. Live's own chat tables stay for now (a later change drops them).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const PATTERNS = [
    ['chat-effects/mirror', /chat-effects\/mirror/],
    ['live.chat_mirror.write', /live\.chat_mirror\.write/],
    ['MIRROR_TABLES', /\bMIRROR_TABLES\b/],
    ['applyMirror', /\bapplyMirror\b/],
    ['liveColumns', /\bliveColumns\b/],
    ['MIRROR_WRITES', /\bMIRROR_WRITES\b/],
    ['delivery.mirror', /delivery\.mirror\b/],
];

const offenders = [];
(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.js')) continue;
        const rel = path.relative(ROOT, p);
        const src = fs.readFileSync(p, 'utf8');
        for (const [name, re] of PATTERNS) if (re.test(src)) offenders.push(`${rel}: ${name}`);
    }
})(path.join(ROOT, 'server'));

assert.deepStrictEqual(offenders, [], `server/ still references the retired chat read mirror:\n${offenders.join('\n')}`);

console.log('chat mirror removed: nothing under server/ references chat-effects/mirror, live.chat_mirror.write, MIRROR_TABLES/applyMirror/liveColumns/MIRROR_WRITES or delivery.mirror — all checks passed');
