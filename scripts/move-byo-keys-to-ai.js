#!/usr/bin/env node
'use strict';
/**
 * Moves every streamer's own provider key still stored in Live's database to OpenVibe.AI (roadmap WS-O task 2,
 * server/ai/byo-credentials.js). Each key is sent once (PUT /api/v1/credentials/:subject with Live's service token,
 * grant live ai.credential.manage on openvibe.ai); on success Live's copy is erased and byo_in_ai set. Idempotent:
 * a moved channel has no key left to move. Prints one line per channel, never a key.
 *
 *   sudo -u <live service user> sh -c 'set -a; . /etc/openvibe/live.env; set +a; \
 *     cd /opt/openvibe.live/current && node scripts/move-byo-keys-to-ai.js'
 */
const db = require('../server/db/database');
const byo = require('../server/ai/byo-credentials');

(async () => {
    const rows = await db.getDb().prepare("SELECT user_id FROM channel_ai_config WHERE byo_key IS NOT NULL AND TRIM(byo_key) != '' ORDER BY user_id").all();
    let moved = 0; let failed = 0;
    for (const { user_id: userId } of rows) {
        const out = await byo.moveLocal(userId);
        if (out === 'moved') moved++; else if (out !== 'none') failed++;
        console.log(`channel ${userId}: ${out}`);
    }
    console.log(`${rows.length} key(s) in Live: ${moved} moved to OpenVibe.AI, ${failed} not moved`);
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(2); });
