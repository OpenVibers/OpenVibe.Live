#!/usr/bin/env node
'use strict';
/**
 * One-time backfill (WS-D task 1): Live's moderation actions logged before live.moderation.action
 * existed go to OpenVibe.Network's moderation audit log, each with its original time. Same rule as
 * logModerationAction (server/db/database.js): tidying one's own messages, configuring one's own channel
 * and acting on oneself are not sent. Idempotent: moderation_events_backfill remembers every row sent,
 * and --before (required) keeps it off rows the live code already announced.
 *
 * Run on the host AS LIVE, with Live's environment (EVENTS_URL, the OAuth client secret), e.g.:
 *   node scripts/backfill-moderation-events.js --before '2026-09-25 20:31:27' [--dry-run]
 * It queues into Live's outbox and relays until the queue is empty. Nothing secret is printed.
 */
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const before = flag('--before');
const dryRun = args.includes('--dry-run');
if (!before || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(before)) {
    console.error("--before 'YYYY-MM-DD HH:MM:SS' (UTC, the deploy time of logModerationAction's event) is required");
    process.exit(2);
}

(async () => {
    const db = require('../server/db/database');
    db.initDb();
    const d = db.getDb();
    d.exec('CREATE TABLE IF NOT EXISTS moderation_events_backfill (action_id INTEGER PRIMARY KEY, sent_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    const rows = d.prepare(`SELECT m.* FROM moderation_actions m LEFT JOIN moderation_events_backfill b ON b.action_id = m.id
        WHERE b.action_id IS NULL AND m.created_at < ? ORDER BY m.id`).all(before);
    console.log(`${rows.length} action(s) logged before ${before} not yet backfilled`);
    if (dryRun) { process.exit(0); }
    const streamEvents = require('../server/events/stream-events');
    const outbox = streamEvents.init({ intervalMs: 500 });
    if (!outbox) { console.error('the outbox is off (EVENTS_URL or the client secret is missing)'); process.exit(1); }
    let sent = 0, skipped = 0;
    for (const r of rows) {
        let details = {};
        try { details = JSON.parse(r.details || '{}'); } catch { /* keep {} */ }
        const at = new Date(`${String(r.created_at).replace(' ', 'T')}Z`);
        d.transaction(() => {
            const ok = db.announceModerationAction(r.id, { ...r, details }, { at: Number.isNaN(at.getTime()) ? null : at.toISOString() });
            d.prepare('INSERT INTO moderation_events_backfill (action_id) VALUES (?)').run(r.id);
            if (ok) sent++; else skipped++;
        })();
    }
    console.log(`queued ${sent}, not moderation ${skipped}; relaying…`);
    for (let i = 0; i < 60 && streamEvents.status().pending > 0; i++) { await outbox.flush(); await new Promise((res) => setTimeout(res, 500)); }
    const st = streamEvents.status();
    console.log(`pending ${st.pending}, rejected ${st.rejected}${st.last_error ? ` (last error: ${st.last_error})` : ''}`);
    outbox.stop && outbox.stop();
    process.exit(st.rejected ? 1 : 0);
})().catch((err) => { console.error(err.message); process.exit(1); });
