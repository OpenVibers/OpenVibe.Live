'use strict';
/**
 * auto-clip-sweep.js — the AI's stale clips leave the lists (open item 151: "prune stale auto-clips, hide first").
 *
 * An automatic clip that is public, was cut more than 30 days ago, and that no person ever opened is made unlisted:
 * its page and link keep working, and it leaves the lists, search and the home. Nothing is deleted.
 *
 *   "No person ever opened it" is Media's content_visits (a visitor row; GET /clips?unvisited=1, Media#292), the
 *   measure of Live's clip audit (Live#443). The play counter is not used: crawlers move it, so by plays only 2 of the
 *   190 old public auto-clips looked unwatched, while 29 had never been opened by a person.
 *   Only clips Media marks auto_generated: a person's clip is never touched.
 *   At most 25 a run, once a day. Each hidden clip is remembered (state auto_clip_swept: id and when), newest first,
 *   so it can be shown and put back (restore()).
 *   A Media that does not know unvisited=1 answers every old clip. When the "unvisited" total is not below the plain
 *   total, the sweep does nothing that run.
 *
 *   sweep({ now, max, dryRun })  → { hidden: [ids], skipped, why }
 *   restore(id)                  → puts one back to public and forgets it
 *   start() / stop()
 */
const db = require('../db/database');
const media = require('../media-client');
const { parseTs } = require('./clip-policy');

const STALE_DAYS = 30;
const MAX_PER_RUN = 25;
const SETTING = 'auto_clip_swept';
const KEEP = 2000;
const DAY_MS = 24 * 3600 * 1000;

async function _swept() {
    try { const d = JSON.parse(await db.getState(SETTING) || '[]'); return Array.isArray(d) ? d : []; } catch { return []; }
}

async function sweep({ now = Date.now(), max = MAX_PER_RUN, dryRun = false } = {}) {
    const before = new Date(now - STALE_DAYS * DAY_MS).toISOString();
    const query = { auto_generated: 1, before, order: 'oldest', status: 'ready' };
    const stale = await media.listClips({ ...query, unvisited: 1, limit: max }, { timeoutMs: 15_000 });
    const all = await media.listClips({ ...query, limit: 1 }, { timeoutMs: 15_000 });
    if (!stale || !Array.isArray(stale.clips) || !all || all.total == null) return { hidden: [], skipped: 0, why: 'Media did not answer' };
    if (Number(stale.total) >= Number(all.total) && Number(all.total) > 0) {
        return { hidden: [], skipped: 0, why: `Media did not apply unvisited=1 (${stale.total} of ${all.total} old auto-clips)` };
    }
    const hidden = [];
    let skipped = 0;
    for (const clip of stale.clips) {
        // The list is public and AI-made by its query; each one is checked again before it changes.
        const cut = clip && parseTs(clip.created_at);
        if (!clip || clip.auto_generated !== true || clip.visibility !== 'public' || !(cut && cut < now - STALE_DAYS * DAY_MS)) { skipped++; continue; }
        if (dryRun) { hidden.push(clip.id); continue; }
        try {
            const out = await media.updateClip(clip.id, { visibility: 'unlisted' }, { timeoutMs: 10_000 });
            const after = (out && out.clip) || out;
            if (after && after.visibility && after.visibility !== 'unlisted') { skipped++; continue; }
            hidden.push(clip.id);
        } catch (e) {
            if (e && (e.status === 404 || e.status === 410)) { skipped++; continue; }
            break;   // Media down or refusing: the rest wait for tomorrow
        }
    }
    if (!dryRun && hidden.length) {
        const at = new Date(now).toISOString();
        const log = [...hidden.map((id) => ({ id, at })), ...await _swept()].slice(0, KEEP);
        await db.setState(SETTING, JSON.stringify(log));
        console.log(`[AutoClip] Unlisted ${hidden.length} AI clip(s) no person opened in their first ${STALE_DAYS} days or since: ${hidden.join(', ')}`);
    }
    return { hidden, skipped, why: null };
}

/** Put one swept clip back in the lists, and forget it. */
async function restore(id) {
    const out = await media.updateClip(id, { visibility: 'public' }, { timeoutMs: 10_000 });
    await db.setState(SETTING, JSON.stringify((await _swept()).filter((e) => String(e.id) !== String(id))));
    return (out && out.clip) || out;
}

let _stop = null;
function start() {
    if (_stop) return;
    _stop = require('../utils/jobs').every('auto-clip-sweep', DAY_MS, () => sweep(), { initialDelayMs: 20 * 60 * 1000, jitterMs: 10 * 60 * 1000 });
}
function stop() { if (_stop) { _stop(); _stop = null; } }

module.exports = { sweep, restore, start, stop, STALE_DAYS, MAX_PER_RUN, SETTING };
