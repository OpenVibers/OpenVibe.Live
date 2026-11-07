'use strict';
/**
 * "My Rundown": the streamer's own settings (design 2026-11-06).
 *
 * Two things live here: the default audience for the write-ups made from now on (Everyone until the streamer changes it)
 * and the whole-Rundown opt-out that already existed ("Keep me out", status `out`), which means Only me for everything
 * and no new write-ups at all while it is on.
 *
 * The default applies to the episodes written up from now on. An episode that already has its own setting keeps it: the
 * Share sheet is the streamer's decision about that episode, and a default never overrules it.
 */
const db = require('../db/database');
const visibility = require('./visibility');

/** The streamer's default audience: Everyone until they change it. */
async function defaultAudience(userId) {
    const row = await db.get('SELECT default_audience FROM rundown_prefs WHERE user_id = ?', [Number(userId)]);
    return row && visibility.AUDIENCES.includes(row.default_audience) ? row.default_audience : visibility.DEFAULT_AUDIENCE;
}

/** Change the streamer's default audience. */
async function setDefaultAudience(userId, audience) {
    if (!visibility.AUDIENCES.includes(audience)) {
        throw Object.assign(new Error('Unknown audience'), { status: 400 });
    }
    await db.run(`INSERT INTO rundown_prefs (user_id, default_audience, updated_at) VALUES (?, ?, ov_now())
        ON CONFLICT (user_id) DO UPDATE SET default_audience = excluded.default_audience, updated_at = excluded.updated_at`,
    [Number(userId), audience]);
    return audience;
}

/** Whether the streamer keeps themselves out of The Rundown. */
async function optedOut(userId) {
    return !!await db.get('SELECT 1 FROM arena_opt_outs WHERE user_id = ?', [Number(userId)]);
}

/** Everything the "My Rundown" sheet shows. */
async function settingsFor(userId) {
    return {
        default_audience: await defaultAudience(userId),
        opted_out: await optedOut(userId),
    };
}

module.exports = { defaultAudience, setDefaultAudience, optedOut, settingsFor };
