'use strict';

// T3 J2: Live delivers to OpenVibe.Chat through its typed ingress only (server/chat/chat-delivery.js).
// The old ordered-calls bridge (chat-remote.js, POST /internal/live/calls) is gone and nothing under server/ names its
// outbox. On PostgreSQL (plan T4) the outbox table does not exist: migrations/0002_live.sql leaves it out (production's
// SQLite copy held no queued write when it was generated).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// 1. Static guard: no reader or writer of the outbox, no bridge, no flag.
const offenders = [];
(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.js')) continue;
        const rel = path.relative(ROOT, p);
        const src = fs.readFileSync(p, 'utf8');
        if (/chat_bridge_outbox/i.test(src)) offenders.push(`${rel}: chat_bridge_outbox`);
        if (/chat-remote/.test(src)) offenders.push(`${rel}: chat-remote`);
        if (/\/internal\/live\/(calls|presence)/.test(src)) offenders.push(`${rel}: the old bridge endpoints`);
        if (/LIVE_CHAT_INGRESS/.test(src)) offenders.push(`${rel}: LIVE_CHAT_INGRESS (retired: CHAT_AUTHORITY=chat is the ingress)`);
    }
})(path.join(ROOT, 'server'));
assert.deepStrictEqual(offenders, [], `server/ still uses the old chat bridge:\n${offenders.join('\n')}`);
assert.ok(!fs.existsSync(path.join(ROOT, 'server', 'chat', 'chat-remote.js')), 'chat-remote.js is deleted');

// 2. No migration creates the outbox, and the migrated database has none.
const MIGRATION_SQL = fs.readdirSync(path.join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql'))
    .map((f) => fs.readFileSync(path.join(ROOT, 'migrations', f), 'utf8')).join('\n');
assert.ok(!/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?chat_bridge_outbox\b/i.test(MIGRATION_SQL), 'no migration creates chat_bridge_outbox');
(async () => {
    const db = require('../server/db/database');
    await db.initDb();
    assert.ok(!await db.getDb().prepare("SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'chat_bridge_outbox'").get(), 'chat_bridge_outbox is not in the migrated database');
    console.log('chat bridge removed: no outbox, bridge or flag under server/; no migration or table for the outbox — all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
