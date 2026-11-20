'use strict';
/**
 * A recording still named by Live's default takes its Rundown episode's title (2026-11-20; the owner's register #908:
 * "title auto-generated rather than numbers/random text, unless the user sets a title").
 *
 * The default is what Live fills in when nobody typed a title: "Untitled Stream", "<name>'s Stream" (the RTMP ingest,
 * a slot), "<name>'s stream", "<name>'s Channel" (the channel row). On production most recordings of 11-15..11-19 were
 * "iZoR_One's Stream" while their episodes were "Loud Mic, Bait Boxes & Helcoin Rants". A recording someone named keeps
 * its name; an episode that is hidden or not public by its own setting lends nothing; a title the slur or explicit
 * rules refuse is not used. The new title goes to OpenVibe.Media (as clip-title.js does for clips), so the video page,
 * every card and search read it. Each stream is decided once a process; a streamer can rename it afterwards and is
 * never overruled (their title is no longer a default).
 *
 *   isDefaultTitle(title, user) → true for a title nobody chose
 *   titleRecordings({ streamIds }) → { named, kept, skipped }: the given streams' episodes, else the last 14 days' not
 *                                    decided yet (at most BATCH Media reads a run)
 *   start()                          the sweep every SWEEP_MS (server/index.js's normal boot, never under LIVE_DRILL)
 */
const db = require('../db/database');
const media = require('../media-client');
const { containsCoreSlur } = require('openvibe-sdk/front-page');

const BATCH = 20;
const SWEEP_MS = 10 * 60 * 1000;
const WITHIN_DAYS = 14;
const decided = new Set();   // stream ids named, kept or not public (this process)

const norm = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().toLowerCase().replace(/[‘’]/g, "'");
const DEFAULTS = new Set(['', 'untitled', 'untitled stream', 'stream', 'a stream', 'stream recording', 'my stream', 'live stream']);

/** True for a title nobody chose: one of Live's defaults, or "<the streamer's name>'s stream/channel". */
function isDefaultTitle(title, user = {}) {
    const t = norm(title);
    if (DEFAULTS.has(t)) return true;
    const m = /^(.+)'s (stream|channel|broadcast)$/.exec(t);
    if (!m) return false;
    return [user.username, user.display_name].map(norm).filter(Boolean).includes(m[1]);
}

function usable(title) {
    const t = String(title || '').replace(/\s+/g, ' ').trim();
    if (t.length < 4 || t.length > 120) return null;
    if (containsCoreSlur(t)) return null;
    try { if (require('../ai/explicit').isExplicit(t)) return null; } catch { /* the rule is not there: the title is used */ }
    return t;
}

async function titleRecordings({ streamIds = null } = {}) {
    const out = { named: 0, kept: 0, skipped: 0 };
    const since = new Date(Date.now() - WITHIN_DAYS * 86400000).toISOString().replace('T', ' ').slice(0, 19);
    const ids = Array.isArray(streamIds) ? streamIds.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0) : null;
    const rows = ids
        ? (ids.length ? await db.all(`SELECT e.stream_id, e.vod_id, e.title, e.status, u.username, u.display_name FROM rundown_episodes e JOIN users u ON u.id = e.user_id
            WHERE e.stream_id = ANY(?)`, [ids]) : [])
        : await db.all(`SELECT e.stream_id, e.vod_id, e.title, e.status, u.username, u.display_name FROM rundown_episodes e JOIN users u ON u.id = e.user_id
            WHERE e.vod_id IS NOT NULL AND e.aired_at > ? ORDER BY e.aired_at DESC LIMIT 200`, [since]);
    const visibility = require('./visibility');
    let reads = 0;
    for (const e of rows) {
        const sid = Number(e.stream_id);
        if (decided.has(sid) || !e.vod_id) { out.skipped++; continue; }
        if (reads >= BATCH) break;
        const title = usable(e.title);
        if (!title || e.status === 'hidden' || await visibility.ownAudience(sid) !== 'public') { decided.add(sid); out.kept++; continue; }
        reads++;
        let v = null;
        try { v = await media.getVod(e.vod_id, { timeoutMs: 10_000 }); } catch { out.skipped++; continue; }   // Media away: the next run
        if (!v || !isDefaultTitle(v.title, e)) { decided.add(sid); out.kept++; continue; }
        try {
            await media.updateVod(e.vod_id, { title });
            decided.add(sid);
            out.named++;
            console.log(`[Rundown] recording ${e.vod_id} (stream ${sid}) was "${String(v.title).slice(0, 60)}"; named after its episode`);
        } catch (err) { out.skipped++; console.warn(`[Rundown] recording ${e.vod_id} not named:`, err.message); }
    }
    return out;
}

function start() {
    require('../utils/jobs').every('rundown-recording-titles', SWEEP_MS, () => titleRecordings(), { initialDelayMs: 120_000, jitterMs: 30_000 });
}

function _reset() { decided.clear(); }

module.exports = { isDefaultTitle, titleRecordings, start, BATCH, _reset };
