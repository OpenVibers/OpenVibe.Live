#!/usr/bin/env node
'use strict';
/**
 * Sets every streamer's AI-viewer daily budget as a cap in OpenVibe.AI (roadmap WS-O task 2,
 * server/ai/viewer-quota.js): channels on the site's AI with a budget get PUT
 * /api/v1/attribution-quotas/live:user:<id>, the others have any cap removed. Idempotent; prints one line per
 * channel.
 *
 *   sudo sh -c 'set -a; . /etc/openvibe/live.env; set +a; cd /opt/openvibe.live/current && \
 *     setpriv --reuid=<live user> --regid=<live user> --init-groups node scripts/sync-viewer-quotas.js'
 */
const db = require('../server/db/database');
const quota = require('../server/ai/viewer-quota');

(async () => {
    const rows = await db.getDb().prepare('SELECT user_id FROM channel_ai_config ORDER BY user_id').all();
    let failed = 0;
    for (const { user_id: userId } of rows) {
        const out = await quota.sync(userId);
        if (!['set', 'removed', 'none'].includes(out)) failed++;
        console.log(`channel ${userId}: ${out}`);
    }
    console.log(`${rows.length} channel(s), ${failed} not synced`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(2); });
