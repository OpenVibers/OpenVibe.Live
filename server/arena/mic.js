/**
 * OpenVibe.Live — Arena mic ledger (Battle Cam mode)
 *
 * The Arena runs on ONE input: what fighters say on mic (stream_timeline_events speech,
 * judged by listener.js). This module is the ledger for that:
 *
 *   moments   → every judged piece of shit talk lands here: a callout that opened/fed a
 *               beef (`beef_hit`), or free-standing trash talk aimed at chat / a group / a
 *               name that is not on the roster (`trash`). VOD-linked so every line can be
 *               replayed at the second it was said.
 *   XP        → moment quality → Trash Level (arena_trash_levels / arena_xp_log). No other
 *               source of XP exists: not chat, not votes, not check-ins.
 *   mic stats → per-fighter aggregates the roster ratings are built from (HEAT, AIM,
 *               CLAPBACK, KILLS…) — see arena-service.js.
 *   feed      → the live "shit talk feed": newest judged lines across every live cam.
 *
 * The behaviour filter (threats / minors / doxxing — never vocabulary) is applied before any
 * line is stored; see arena-service.isBannedText.
 */
'use strict';

const db = require('../db/database');

const XP_PER_LEVEL = 50;
const XP_MOMENT = 0.8;   // × quality
const XP_HYPE = 1;


function parseJson(t, f = null) { try { return t ? JSON.parse(t) : f; } catch { return f; } }
function arena() { return require('./arena-service'); }
function levelFor(xp) { return 1 + Math.floor((Number(xp) || 0) / XP_PER_LEVEL); }
async function levelRow(userId) {
    return await db.get('SELECT * FROM arena_trash_levels WHERE user_id = ?', [userId]) || { user_id: userId, xp: 0, level: 1, beef_hits: 0, mic_moments: 0, best_line: null, best_line_score: 0 };
}

// ── XP / Trash Level ─────────────────────────────────────────

async function addXp(userId, amount, reason, refId = null, extra = {}) {
    amount = Math.round(Number(amount) || 0);
    if (amount <= 0) return await levelRow(userId);
    const before = await levelRow(userId);
    await db.run(`INSERT INTO arena_trash_levels (user_id, xp, level) VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET xp = arena_trash_levels.xp + excluded.xp, level = ?, updated_at = ov_now()`,
        [userId, amount, levelFor(amount), levelFor((before.xp || 0) + amount)]);
    await db.run('INSERT INTO arena_xp_log (user_id, amount, reason, ref_id) VALUES (?, ?, ?, ?)', [userId, amount, reason, refId]);
    const sets = [];
    if (extra.moment) sets.push('mic_moments = mic_moments + 1');
    if (extra.beefHit) sets.push('beef_hits = beef_hits + 1');
    if (sets.length) await db.run(`UPDATE arena_trash_levels SET ${sets.join(', ')} WHERE user_id = ?`, [userId]);
    if (extra.line && (extra.lineScore || 0) > (before.best_line_score || 0)) {
        await db.run('UPDATE arena_trash_levels SET best_line = ?, best_line_vod_id = ?, best_line_sec = ?, best_line_score = ? WHERE user_id = ?', [String(extra.line).slice(0, 220), extra.lineVodId || null, extra.lineSec ?? null, extra.lineScore, userId]);
    }
    const after = await levelRow(userId);
    if (after.level > before.level) {
        console.log(`[Arena] user ${userId} → Trash Level ${after.level}`);
        try { require('./notify').arenaNotify(userId, { type: 'level', title: `Trash Level ${after.level}`, message: `${after.xp} XP from pure mic. Keep talking.`, icon: '🎙️', url: '/arena', key: `level:${after.level}` }); } catch { /* */ }
    }
    try { await arena().loadRoster(true); } catch { /* */ }
    return { ...after, leveled_up: after.level > before.level, gained: amount };
}

async function recentXp(userId, days = 7) {
    return (await db.get(`SELECT COALESCE(SUM(amount), 0)::bigint AS xp FROM arena_xp_log WHERE user_id = ? AND created_at >= datetime('now', ?)`, [userId, `-${days} days`]))?.xp || 0;
}

async function levelView(userId) {
    const r = await levelRow(userId);
    const xp = r.xp || 0;
    return {
        level: levelFor(xp), xp, xp_into_level: xp - (levelFor(xp) - 1) * XP_PER_LEVEL, xp_per_level: XP_PER_LEVEL, next_level_xp: levelFor(xp) * XP_PER_LEVEL,
        mic_moments: r.mic_moments || 0, beef_hits: r.beef_hits || 0,
        recent_xp: await recentXp(userId),
        best_line: r.best_line ? { text: r.best_line, vod_id: r.best_line_vod_id, sec: r.best_line_sec, score: r.best_line_score } : null,
    };
}

async function levelsLeaderboard(limit = 10) {
    const roster = await arena().loadRoster();
    return (await Promise.all((await db.all('SELECT * FROM arena_trash_levels WHERE xp > 0 ORDER BY xp DESC LIMIT ?', [limit]))
        .map(async r => ({ ...await fighterBrief(r.user_id, roster), xp: r.xp, level: levelFor(r.xp), beef_hits: r.beef_hits || 0, mic_moments: r.mic_moments || 0, best_line: r.best_line ? { text: r.best_line, vod_id: r.best_line_vod_id, sec: r.best_line_sec, score: r.best_line_score } : null }))));
}

// ── Names + briefs ───────────────────────────────────────────

// Real names only — no AI ring names. The fighter IS the streamer.
async function nameOf(userId) {
    const u = await db.getUserById(userId);
    return u?.display_name || u?.username || `user${userId}`;
}

async function fighterBrief(userId, roster) {
    const f = roster && roster.byId ? roster.byId[userId] : null;
    return {
        user: f ? f.user : (await db.getUserById(userId) ? arena().publicUser(await db.getUserById(userId)) : { id: userId, username: `user${userId}`, display_name: `user${userId}` }),
        fighter_name: await nameOf(userId),
        rank: f ? roster.order.indexOf(userId) + 1 : null,
        image_url: await (async () => { try { return await arena().getFighterImageUrl(userId); } catch { return null; } })(),
        live: !!await db.get('SELECT 1 FROM streams WHERE user_id = ? AND is_live = 1 LIMIT 1', [userId]),
        level: levelFor((await levelRow(userId)).xp || 0),
    };
}

// ── Moments ──────────────────────────────────────────────────

/**
 * Store a judged mic line. kind: 'trash' (aimed at chat / a group / a non-roster name),
 * 'beef_hit' (fed a beef; target_user_id + beef_id set). Pays XP for 'trash' here; beef hits
 * are paid by beef.recordHit. Returns the row or null when the line is behaviour-filtered.
 */
async function addMoment({ userId, streamId = null, vodId = null, sec = null, kind = 'trash', targetUserId = null, beefId = null, aimedAt = null, text, about = null, quality = 0, announcer = null, saidAt = null }) {
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!t) return null;
    try { if (arena()._isBannedText(t)) return null; } catch { /* */ }
    const q = Math.max(0, Math.min(10, Number(quality) || 0));
    const r = await db.run(`INSERT INTO arena_mic_moments (user_id, stream_id, vod_id, sec, kind, target_user_id, beef_id, aimed_at, text, about, quality, announcer, said_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?::text, ov_now())) RETURNING id`,
        [userId, streamId, vodId, sec == null ? null : Math.max(0, Math.floor(sec)), kind, targetUserId, beefId, aimedAt ? String(aimedAt).slice(0, 80) : null, t, about ? String(about).slice(0, 80) : null, q, announcer ? String(announcer).slice(0, 140) : null, saidAt]);
    const id = Number(r.lastInsertRowid);
    if (kind === 'trash' || kind === 'callout') await addXp(userId, q * XP_MOMENT, kind === 'callout' ? 'mic_callout' : 'mic_trash', id, { moment: true, line: t, lineScore: q, lineVodId: vodId, lineSec: sec });
    return await db.get('SELECT * FROM arena_mic_moments WHERE id = ?', [id]);
}

/** Same line (or near enough) from the same fighter in the last 6 h → don't file it twice. */
async function isDuplicate(userId, text) {
    const norm = String(text || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    if (!norm) return false;
    const rows = await db.all(`SELECT text FROM arena_mic_moments WHERE user_id = ? AND created_at >= datetime('now', '-6 hours') ORDER BY id DESC LIMIT 40`, [userId]);
    return rows.some(r => { const t = String(r.text || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim(); return t === norm || (t.length > 30 && (t.includes(norm) || norm.includes(t))); });
}

async function momentView(m, roster) {
    const brief = await fighterBrief(m.user_id, roster);
    return {
        id: m.id, kind: m.kind, user: brief.user, fighter_name: brief.fighter_name, rank: brief.rank, image_url: brief.image_url, level: brief.level, live: brief.live,
        target: m.target_user_id ? await (async () => { const b = await fighterBrief(m.target_user_id, roster); return { user: b.user, fighter_name: b.fighter_name, rank: b.rank }; })() : null,
        beef_id: m.beef_id || null, aimed_at: m.aimed_at || null, text: m.text, about: m.about, quality: Number(m.quality) || 0, announcer: m.announcer || null,
        stream_id: m.stream_id, vod_id: m.vod_id, sec: m.sec, at: m.said_at || m.created_at,
    };
}

/** The shit-talk feed: newest judged lines across the roster. */
async function feed({ limit = 40, since = null, userId = null } = {}) {
    const roster = await arena().loadRoster();
    const params = [];
    // The feed shows bangers only; weak lines still count for stats/XP but never headline the page.
    let where = 'quality >= 5';
    if (userId) { where += ' AND user_id = ?'; params.push(userId); }
    if (since) { where += ' AND id > ?'; params.push(Number(since) || 0); }
    params.push(Math.min(200, Math.max(1, limit)));
    return (await Promise.all((await db.all(`SELECT * FROM arena_mic_moments WHERE ${where} ORDER BY COALESCE(said_at, created_at) DESC, id DESC LIMIT ?`, params)).map(async m => await momentView(m, roster))));
}
async function momentsFor(userId, limit = 12) { return await feed({ limit, userId }); }
async function bestLines(userId, limit = 5) {
    const roster = await arena().loadRoster();
    return (await Promise.all((await db.all('SELECT * FROM arena_mic_moments WHERE user_id = ? AND quality >= 5 ORDER BY quality DESC, id DESC LIMIT ?', [userId, limit])).map(async m => await momentView(m, roster))));
}
async function latestFor(userId) {
    const m = await db.get('SELECT * FROM arena_mic_moments WHERE user_id = ? ORDER BY COALESCE(said_at, created_at) DESC, id DESC LIMIT 1', [userId]);
    return m ? await momentView(m, await arena().loadRoster()) : null;
}

/** Aggregates the ratings are built from. All from the mic ledger + beefs — nothing else. */
async function micStats(userId, days = 30) {
    const win = `-${days} days`;
    const m = await db.get(`SELECT COUNT(*) AS n, COALESCE(AVG(quality), 0)::float8 AS avg_q, COALESCE(MAX(quality), 0) AS best_q,
                             COUNT(*) FILTER (WHERE kind IN ('beef_hit', 'callout')) AS beef_hits, COUNT(*) FILTER (WHERE kind = 'trash') AS trash,
                             COUNT(*) FILTER (WHERE quality >= 7) AS bangers
                      FROM arena_mic_moments WHERE user_id = ? AND created_at >= datetime('now', ?)`, [userId, win]) || {};
    let b = {};
    try { b = await db.get(`SELECT COUNT(*) FILTER (WHERE b_user_id = ?) AS targeted, COUNT(*) FILTER (WHERE b_user_id = ? AND responded = 1) AS answered, COUNT(*) FILTER (WHERE winner_user_id = ?) AS wins, COUNT(*) FILTER (WHERE status = 'resolved' AND winner_user_id IS NOT NULL AND winner_user_id != ?) AS losses, COUNT(*) FILTER (WHERE status = 'resolved' AND resolution = 'forfeit' AND winner_user_id != ? AND winner_user_id IS NOT NULL) AS ducked FROM arena_beefs WHERE a_user_id = ? OR b_user_id = ?`, [userId, userId, userId, userId, userId, userId, userId]) || {}; } catch { b = {}; }
    const speechMin = await (async () => { try { return ((await db.get(`SELECT COALESCE(SUM(COALESCE(end_sec, start_sec + 3) - start_sec), 0)::bigint AS s FROM stream_timeline_events WHERE user_id = ? AND kind = 'speech' AND created_at >= datetime('now', ?)`, [userId, win]))?.s || 0) / 60; } catch { return 0; } })();
    const hours = Math.max(speechMin / 60, 0.05);
    const targeted = b.targeted || 0;
    return {
        window_days: days, moments: m.n || 0, trash: m.trash || 0, beef_hits: m.beef_hits || 0, bangers: m.bangers || 0,
        avg_quality: Number((m.avg_q || 0).toFixed(2)), best_quality: Number(m.best_q || 0),
        hits_per_mic_hour: Number((((m.beef_hits || 0) + (m.trash || 0)) / hours).toFixed(2)),
        targeted, answered: b.answered || 0, clapback_rate: targeted ? Number(((b.answered || 0) / targeted).toFixed(2)) : 0,
        wins: b.wins || 0, losses: b.losses || 0, ducked: b.ducked || 0, speech_minutes: Number(speechMin.toFixed(1)),
    };
}

module.exports = {
    addXp, recentXp, levelView, levelFor, levelRow, levelsLeaderboard, nameOf, fighterBrief,
    addMoment, momentView, feed, momentsFor, bestLines, latestFor, micStats, isDuplicate,
    XP_PER_LEVEL, XP_MOMENT, XP_HYPE,
};
