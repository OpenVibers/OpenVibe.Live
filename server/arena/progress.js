/**
 * progress.js — the part that BUILDS over time: tiers, achievements, a history feed, weekly ladders.
 *
 *   tiers        → Bronze → Silver → Gold → Platinum → Diamond → Mythic, from all-time XP (fighters:
 *                  arena_trash_levels.xp; chatters: chatter_profiles.xp). Never goes down.
 *   achievements → milestones checked from the data already there (no AI): first blood, streaks,
 *                  upsets, rematch wins, subjects started, HOT subjects, being quoted, hype received,
 *                  bounties, days in a row… Each pays XP; accounts also get OpenCoins (idempotent).
 *   history      → arena_events: everything notable that happened to a key, newest first — beefs,
 *                  level-ups, tier-ups, achievements, subjects, quotes. The profile timeline.
 *   weekly       → XP gained in the last 7 days per key (fighters + chatters) for "this week" crowns.
 *
 * Keys: fighters are `user:<id>` (same as their chatter key) — one history per person; chatters of
 * other kinds are `anon:<n>` / `relay:<platform>:<name>`.
 */
'use strict';

const db = require('../db/database');

const TIERS = [[0, 'Bronze', '#cd7f32'], [150, 'Silver', '#c0c0c0'], [400, 'Gold', '#f5c542'], [900, 'Platinum', '#7fe7e0'], [1800, 'Diamond', '#8ab4ff'], [3500, 'Mythic', '#ff5fd2']];

// { id, name, desc, icon, xp, coins, for: 'fighter'|'chatter'|'both', check(ctx) → bool, hint }
const ACHIEVEMENTS = [
    // fighters (on-mic)
    { id: 'first_blood', for: 'fighter', name: 'First Blood', icon: '🩸', desc: 'Land your first judged hit in a beef.', xp: 20, coins: 20, check: c => c.f.beef_hits >= 1 },
    { id: 'answered', for: 'fighter', name: 'Not Ducking', icon: '🎙️', desc: 'Answer a beef on your own stream before the clock ran out.', xp: 25, coins: 25, check: c => c.f.answered >= 1 },
    { id: 'first_win', for: 'fighter', name: 'W', icon: '🏆', desc: 'Win a beef.', xp: 30, coins: 30, check: c => c.f.wins >= 1 },
    { id: 'five_wins', for: 'fighter', name: 'Problem', icon: '🥊', desc: 'Win five beefs.', xp: 80, coins: 100, check: c => c.f.wins >= 5 },
    { id: 'streak3', for: 'fighter', name: 'Untouchable', icon: '🔥', desc: 'Three beef wins in a row.', xp: 60, coins: 60, check: c => c.f.streak >= 3 },
    { id: 'upset', for: 'fighter', name: 'Giant Killer', icon: '⚡', desc: 'Beat someone ranked 4+ places above you.', xp: 60, coins: 80, check: c => c.f.upsets >= 1 },
    { id: 'rematch_win', for: 'fighter', name: 'Run It Back', icon: '🔁', desc: 'Win a rematch.', xp: 40, coins: 40, check: c => c.f.rematch_wins >= 1 },
    { id: 'on_the_board', for: 'fighter', name: 'On The Board', icon: '📌', desc: 'Get a judged on-mic moment on a subject.', xp: 15, coins: 10, check: c => c.f.topic_moments >= 1 },
    { id: 'loudmouth', for: 'fighter', name: 'Loudmouth', icon: '📢', desc: 'Twenty-five judged on-mic moments.', xp: 60, coins: 60, check: c => c.f.topic_moments >= 25 },
    { id: 'bounty_hunter', for: 'fighter', name: 'Bounty Hunter', icon: '💰', desc: 'Collect a bounty.', xp: 40, coins: 60, check: c => c.f.bounties >= 1 },
    { id: 'main_event', for: 'fighter', name: 'Main Character', icon: '🎯', desc: 'Be heard on a subject that went HOT.', xp: 30, coins: 30, check: c => c.f.hot_subjects >= 1 },
    { id: 'crowd', for: 'fighter', name: 'Crowd Favorite', icon: '👑', desc: 'Get hyped 25 times.', xp: 40, coins: 50, check: c => c.f.hypes_received >= 25 },
    // chatters (from chat)
    { id: 'first_moment', for: 'chatter', name: 'Said Something', icon: '💬', desc: 'Land your first line on a subject.', xp: 5, coins: 5, check: c => c.c.moments >= 1 },
    { id: 'ten_moments', for: 'chatter', name: 'Yapping', icon: '🗣️', desc: 'Ten lines on the board.', xp: 15, coins: 10, check: c => c.c.moments >= 10 },
    { id: 'fifty_moments', for: 'chatter', name: 'Cannot Be Stopped', icon: '🌪️', desc: 'Fifty lines on the board.', xp: 50, coins: 50, check: c => c.c.moments >= 50 },
    { id: 'three_subjects', for: 'chatter', name: 'Everywhere', icon: '🧭', desc: 'Pile onto three different subjects.', xp: 15, coins: 10, check: c => c.c.subjects >= 3 },
    { id: 'starter', for: 'chatter', name: 'Instigator', icon: '🧨', desc: 'Start a subject.', xp: 20, coins: 20, check: c => c.c.subjects_started >= 1 },
    { id: 'quoted', for: 'chatter', name: 'In The Lore', icon: '📜', desc: 'Get quoted in a subject\'s story.', xp: 15, coins: 15, check: c => c.c.quoted >= 1 },
    { id: 'quoted5', for: 'chatter', name: 'Historian\'s Nightmare', icon: '📚', desc: 'Quoted five times.', xp: 40, coins: 40, check: c => c.c.quoted >= 5 },
    { id: 'hot_take', for: 'chatter', name: 'Hot Take', icon: '🌶️', desc: 'Land a line on a subject while it\'s HOT.', xp: 10, coins: 10, check: c => c.c.hot_lines >= 1 },
    { id: 'streak3', for: 'chatter', name: 'Three Days', icon: '📅', desc: 'Show up three days in a row.', xp: 15, coins: 15, check: c => c.c.best_streak >= 3 },
    { id: 'streak7', for: 'chatter', name: 'Regular', icon: '🗓️', desc: 'Seven days in a row.', xp: 50, coins: 60, check: c => c.c.best_streak >= 7 },
    { id: 'level5', for: 'chatter', name: 'Instigator Rank', icon: '⬆️', desc: 'Reach yap level 5.', xp: 25, coins: 25, check: c => c.c.level >= 5 },
    { id: 'level10', for: 'chatter', name: 'Menace Rank', icon: '😈', desc: 'Reach yap level 10.', xp: 80, coins: 100, check: c => c.c.level >= 10 },
];

let _ready = false;
function ensureTables() {
    if (_ready) return;
    db.run(`CREATE TABLE IF NOT EXISTS arena_achievements (
        key TEXT NOT NULL,
        achievement_id TEXT NOT NULL,
        earned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (key, achievement_id)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS arena_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT,
        url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_arena_events_key ON arena_events (key, id)');
    db.run(`CREATE TABLE IF NOT EXISTS arena_tier_paid (key TEXT NOT NULL, tier INTEGER NOT NULL, PRIMARY KEY (key, tier))`);
    try { db.run('ALTER TABLE arena_topics ADD COLUMN peak_heat REAL DEFAULT 0'); } catch { /* exists */ }
    _ready = true;
}

function tierFor(xp) { let t = 0; for (let i = 0; i < TIERS.length; i++) if ((xp || 0) >= TIERS[i][0]) t = i; const [min, name, color] = TIERS[t]; const next = TIERS[t + 1] || null; return { index: t, name, color, min, next: next ? { name: next[1], xp: next[0], color: next[2] } : null, progress: next ? Math.round(((xp - min) / (next[0] - min)) * 100) : 100 }; }

/** History feed entry (also mirrored to the notification bell by callers when it matters). */
function event(key, kind, title, { detail = null, url = null } = {}) {
    ensureTables();
    if (!key) return;
    db.run('INSERT INTO arena_events (key, kind, title, detail, url) VALUES (?, ?, ?, ?, ?)', [key, kind, String(title).slice(0, 160), detail ? String(detail).slice(0, 240) : null, url]);
}
function events(key, limit = 30) { ensureTables(); return db.all('SELECT * FROM arena_events WHERE key = ? ORDER BY id DESC LIMIT ?', [key, limit]); }

// ── Context for achievement checks (cheap aggregate queries) ──
function fighterCtx(userId) {
    const lv = db.get('SELECT * FROM arena_trash_levels WHERE user_id = ?', [userId]) || {};
    const beefs = db.get(`SELECT SUM(winner_user_id = ?) AS wins, SUM(status = 'resolved' AND winner_user_id = ? AND upset = 1) AS upsets, SUM(status = 'resolved' AND winner_user_id = ? AND rematch = 1) AS rematch_wins, SUM(b_user_id = ? AND responded = 1) AS answered FROM arena_beefs WHERE a_user_id = ? OR b_user_id = ?`, [userId, userId, userId, userId, userId, userId]) || {};
    let streak = 0; try { streak = require('./beef').streakFor(userId); } catch { /* */ }
    const bounties = db.get(`SELECT COUNT(*) AS n FROM arena_xp_log WHERE user_id = ? AND reason = 'bounty_claimed'`, [userId])?.n || 0;
    const hot = db.get(`SELECT COUNT(*) AS n FROM arena_topic_members m JOIN arena_topics t ON t.id = m.topic_id WHERE m.user_id = ? AND t.peak_heat >= 12`, [userId])?.n || 0;
    const hypes = (db.get('SELECT COUNT(*) AS n FROM arena_topic_hype WHERE user_id = ?', [userId])?.n || 0) + (db.get(`SELECT COUNT(*) AS n FROM arena_beef_hype h JOIN arena_beefs b ON b.id = h.beef_id WHERE (h.side = 'a' AND b.a_user_id = ?) OR (h.side = 'b' AND b.b_user_id = ?)`, [userId, userId])?.n || 0);
    return { xp: lv.xp || 0, beef_hits: lv.beef_hits || 0, topic_moments: lv.topic_moments || 0, wins: beefs.wins || 0, upsets: beefs.upsets || 0, rematch_wins: beefs.rematch_wins || 0, answered: beefs.answered || 0, streak, bounties, hot_subjects: hot, hypes_received: hypes };
}
function chatterCtx(key) {
    const r = db.get('SELECT * FROM chatter_profiles WHERE key = ?', [key]) || {};
    const hot = db.get(`SELECT COUNT(*) AS n FROM chatter_xp_log WHERE key = ? AND reason = 'moment_hot'`, [key])?.n || 0;
    return { xp: r.xp || 0, level: r.level || 1, moments: r.moments || 0, subjects: r.subjects || 0, subjects_started: r.subjects_started || 0, quoted: r.quoted || 0, best_streak: r.best_streak || 0, hot_lines: hot };
}

/** Run every applicable achievement for a key; awards XP/coins/events/notifications for new ones. Returns the new ids. */
function check(key, { streamId = null } = {}) {
    ensureTables();
    const p = String(key || '').split(':');
    const isUser = p[0] === 'user';
    const userId = isUser ? Number(p[1]) : null;
    const onRoster = isUser && (() => { try { return !!require('./arena-service').loadRoster().byId[userId]; } catch { return false; } })();
    const ctx = { f: onRoster ? fighterCtx(userId) : null, c: chatterCtx(key) };
    const earned = new Set(db.all('SELECT achievement_id FROM arena_achievements WHERE key = ?', [key]).map(r => r.achievement_id));
    const fresh = [];
    for (const a of ACHIEVEMENTS) {
        if (earned.has(a.id)) continue;
        if (a.for === 'fighter' && !ctx.f) continue;
        let ok = false; try { ok = !!a.check(ctx); } catch { ok = false; }
        if (!ok) continue;
        db.run('INSERT OR IGNORE INTO arena_achievements (key, achievement_id) VALUES (?, ?)', [key, a.id]);
        fresh.push(a);
        event(key, 'achievement', `${a.icon} ${a.name}`, { detail: a.desc, url: isUser && onRoster ? `/arena/${encodeURIComponent(db.getUserById(userId)?.username || '')}` : `/arena/chatter/${encodeURIComponent(key)}` });
        // XP: fighters into Trash Level, everyone into their chatter profile (same key for accounts → one bar builds).
        try { if (a.for === 'fighter') require('./board').addXp(userId, a.xp, `ach_${a.id}`); else require('./chatters').addXp(key, a.xp, `ach_${a.id}`, null, { streamId }); } catch { /* */ }
        if (isUser && a.coins) { try { require('../monetization/opencoins').credit(userId, a.coins, `arena_ach_${a.id}`, `live:arena_ach:${userId}:${a.id}`, { achievement: a.id }); } catch { /* */ } }
        if (isUser) { try { require('./notify').arenaNotify(userId, { type: 'achievement', title: `${a.icon} ${a.name}`, message: `${a.desc} +${a.xp} XP${a.coins ? ` · +${a.coins} OpenCoins` : ''}`, icon: a.icon, url: onRoster ? `/arena/${encodeURIComponent(db.getUserById(userId)?.username || '')}` : `/arena/chatter/${encodeURIComponent(key)}`, key: `ach:${a.id}` }); } catch { /* */ } }
        console.log(`[Arena] ${key} unlocked ${a.name}`);
    }
    checkTier(key, ctx);
    return fresh.map(a => a.id);
}

/** Tier-ups: pay once per tier (accounts: coins = tier index × 50), log + notify. */
function checkTier(key, ctx) {
    const xp = Math.max(ctx.f ? ctx.f.xp : 0, ctx.c ? ctx.c.xp : 0);
    const t = tierFor(xp);
    if (t.index === 0) return;
    const paid = db.all('SELECT tier FROM arena_tier_paid WHERE key = ?', [key]).map(r => r.tier);
    for (let i = 1; i <= t.index; i++) {
        if (paid.includes(i)) continue;
        db.run('INSERT OR IGNORE INTO arena_tier_paid (key, tier) VALUES (?, ?)', [key, i]);
        const name = TIERS[i][1];
        event(key, 'tier', `Reached ${name}`, { detail: `${TIERS[i][0]}+ XP all-time` });
        const p = String(key).split(':');
        if (p[0] === 'user') {
            const userId = Number(p[1]);
            try { require('../monetization/opencoins').credit(userId, i * 50, `arena_tier_${name.toLowerCase()}`, `live:arena_tier:${userId}:${i}`, { tier: name }); } catch { /* */ }
            try { require('./notify').arenaNotify(userId, { type: 'tier', title: `${name} tier`, message: `Your arena rep passed ${TIERS[i][0]} XP. +${i * 50} OpenCoins.`, icon: '🏅', url: '/arena', key: `tier:${i}` }); } catch { /* */ }
        }
    }
}

/** Everything the profile needs: tier, achievements (earned + locked with hints), history, weekly XP. */
function view(key) {
    ensureTables();
    const p = String(key || '').split(':');
    const isUser = p[0] === 'user';
    const userId = isUser ? Number(p[1]) : null;
    const onRoster = isUser && (() => { try { return !!require('./arena-service').loadRoster().byId[userId]; } catch { return false; } })();
    const fx = onRoster ? (db.get('SELECT xp FROM arena_trash_levels WHERE user_id = ?', [userId])?.xp || 0) : 0;
    const cx = db.get('SELECT xp FROM chatter_profiles WHERE key = ?', [key])?.xp || 0;
    const xp = Math.max(fx, cx);
    const earned = new Map(db.all('SELECT achievement_id, earned_at FROM arena_achievements WHERE key = ?', [key]).map(r => [r.achievement_id, r.earned_at]));
    const list = ACHIEVEMENTS.filter(a => a.for === 'chatter' || onRoster).map(a => ({ id: a.id, for: a.for, name: a.name, icon: a.icon, desc: a.desc, xp: a.xp, coins: isUser ? a.coins : 0, earned_at: earned.get(a.id) || null }));
    const weekF = onRoster ? (db.get(`SELECT COALESCE(SUM(amount), 0) AS n FROM arena_xp_log WHERE user_id = ? AND created_at >= datetime('now', '-7 days')`, [userId])?.n || 0) : 0;
    const weekC = db.get(`SELECT COALESCE(SUM(amount), 0) AS n FROM chatter_xp_log WHERE key = ? AND created_at >= datetime('now', '-7 days')`, [key])?.n || 0;
    return { key, xp, tier: tierFor(xp), tiers: TIERS.map(([min, name, color]) => ({ min, name, color })), achievements: list, earned: list.filter(a => a.earned_at).length, total: list.length, week_xp: weekF + weekC, history: events(key, 30) };
}

/** Weekly fighters ladder (XP gained in 7 days). */
function weeklyFighters(limit = 5) {
    ensureTables();
    const roster = require('./arena-service').loadRoster();
    const board = require('./board');
    return db.all(`SELECT user_id, SUM(amount) AS gained FROM arena_xp_log WHERE created_at >= datetime('now', '-7 days') GROUP BY user_id ORDER BY gained DESC LIMIT ?`, [limit]).filter(r => roster.byId[r.user_id]).map(r => ({ ...board.fighterBrief(r.user_id, roster), gained: r.gained, tier: tierFor(db.get('SELECT xp FROM arena_trash_levels WHERE user_id = ?', [r.user_id])?.xp || 0) }));
}

module.exports = { ensureTables, TIERS, ACHIEVEMENTS, tierFor, event, events, check, view, weeklyFighters, fighterCtx, chatterCtx };
