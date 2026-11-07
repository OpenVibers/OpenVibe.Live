#!/usr/bin/env node
'use strict';
/**
 * Backfill what the Rundown knows about each written-up stream's recording (design RUNDOWN-CONTROLS 2026-11-06, "the
 * VOD decides first"). The gathered pages read rundown_visibility, which events and Live's own VOD pages fill from now
 * on; recordings made private or unlisted before this shipped (127 private and 2 unlisted on 2026-11-06) would
 * otherwise count as public until someone opened their episode page. This asks Media for every one, paced.
 *
 *   sudo -u <live user> node scripts/rundown-vod-backfill.js            (dry run: what it would record)
 *   sudo -u <live user> node scripts/rundown-vod-backfill.js --apply
 */
const db = require('../server/db/database');
const visibility = require('../server/rundown/visibility');
const media = require('../server/media-client');

const APPLY = process.argv.includes('--apply');
const PACE_MS = 120;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const rows = await db.getDb().prepare(`SELECT DISTINCT stream_id, vod_id FROM (
            SELECT stream_id, vod_id FROM rundown_episodes WHERE vod_id IS NOT NULL
            UNION SELECT stream_id, vod_id FROM rundown_segments WHERE vod_id IS NOT NULL) x ORDER BY stream_id`).all();
    const counts = { checked: 0, gone: 0, failed: 0 };
    const seen = new Set();
    for (const row of rows) {
        if (seen.has(row.stream_id)) continue;
        seen.add(row.stream_id);
        counts.checked += 1;
        let vod = null;
        try { vod = await media.getVod(Number(row.vod_id)); } catch (err) {
            if (err && (err.status === 404 || err.status === 410)) { counts.gone += 1; continue; }
            counts.failed += 1; continue;
        }
        if (!vod || !vod.visibility) { counts.gone += 1; continue; }
        const audience = visibility.mediaAudience(vod.visibility);
        if (!audience) { counts.failed += 1; continue; }
        counts[audience] = (counts[audience] || 0) + 1;
        if (APPLY && audience !== 'public') await visibility.noteVodVisibility(Number(row.stream_id), audience);
        await wait(PACE_MS);
    }
    console.log(`${APPLY ? 'applied' : 'dry run'}: ${JSON.stringify(counts)}`);
    process.exit(counts.failed ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(2); });
