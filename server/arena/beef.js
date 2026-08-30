/**
 * OpenVibe.Live — Arena Beefs (speech-driven streamer vs streamer)
 *
 * Nobody clicks "battle". The listener (listener.js) hears a live fighter talking trash
 * about ANOTHER fighter by name; the judge confirms it was aimed at them; a beef opens:
 *
 *   score     → every judged hit aimed at the other side adds its quality (0–10) to
 *               your side of the tug-of-war. Chat adds crowd points with `!hype` in
 *               your chat (one per person per beef, max CROWD_MAX).
 *   clock     → after every hit the OTHER side is on the clock: RESPONSE_LIVE_MIN
 *               minutes if they are live, RESPONSE_OFFLINE_HOURS hours if not (the
 *               clock tightens to the live window the moment they go live). Miss the
 *               clock and you ducked — forfeit.
 *   end       → a beef also hard-ends MAX_BEEF_HOURS after it opened: higher score
 *               wins, equal is a draw. Records (W–L) come from here.
 */
'use strict';

const db = require('../db/database');

const RESPONSE_LIVE_MIN = 15;
const RESPONSE_OFFLINE_HOURS = 24;
const MAX_BEEF_HOURS = 24;
const CROWD_MAX = 10;
const FEED_MAX = 40;
const XP_BEEF_HIT = 1.0;      // × quality
const XP_BEEF_WIN = 40;
const XP_BEEF_OPEN = 5;

let _ready = false;
function ensureTables() {
    if (_ready) return;
    db.run(`CREATE TABLE IF NOT EXISTS arena_beefs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        a_user_id INTEGER NOT NULL,
        b_user_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        score_a REAL DEFAULT 0,
        score_b REAL DEFAULT 0,
        hits_a INTEGER DEFAULT 0,
        hits_b INTEGER DEFAULT 0,
        crowd_a INTEGER DEFAULT 0,
        crowd_b INTEGER DEFAULT 0,
        on_clock TEXT,
        clock_until DATETIME,
        responded INTEGER DEFAULT 0,
        last_a_at DATETIME,
        last_b_at DATETIME,
        feed_json TEXT,
        opener_line TEXT,
        winner_user_id INTEGER,
        resolution TEXT,
        opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        ends_at DATETIME,
        resolved_at DATETIME
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS arena_beef_hype (
        beef_id INTEGER NOT NULL,
        side TEXT NOT NULL,
        voter_key TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (beef_id, voter_key)
    )`);
    for (const col of ['headline TEXT', 'result_headline TEXT', 'upset INTEGER DEFAULT 0', 'rematch INTEGER DEFAULT 0', 'bounty_topic_id INTEGER']) {
        try { db.run(`ALTER TABLE arena_beefs ADD COLUMN ${col}`); } catch { /* exists */ }
    }
    db.run(`CREATE TABLE IF NOT EXISTS arena_beef_sides (
        beef_id INTEGER NOT NULL,
        voter_key TEXT NOT NULL,
        side TEXT NOT NULL,
        user_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (beef_id, voter_key)
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_arena_beefs_status ON arena_beefs (status, a_user_id, b_user_id)');
    _ready = true;
}

function parseJson(t, f = null) { try { return t ? JSON.parse(t) : f; } catch { return f; } }
function arena() { return require('./arena-service'); }
function board() { return require('./board'); }
function isLive(userId) { return !!db.get('SELECT 1 FROM streams WHERE user_id = ? AND is_live = 1 LIMIT 1', [userId]); }
function nowIso() { return new Date().toISOString(); }
function nameOf(userId) {
    const p = parseJson(db.get('SELECT persona_json FROM arena_profiles WHERE user_id = ?', [userId])?.persona_json);
    const u = db.getUserById(userId);
    return p?.fighter_name || u?.display_name || u?.username || `user${userId}`;
}
const HEADLINE_SCHEMA = { name: 'arena_headline', schema: { type: 'object', additionalProperties: false, required: ['headline'], properties: { headline: { type: 'string', description: '≤ 100 chars, tabloid, inflammatory but funny, names both fighters' } } } };
async function headlineFor(kind, ctx) {
    try {
        const llm = require('../ai/llm');
        if (!(llm.isEnabled() && llm.withinBudget())) return null;
        const r = await llm.complete({ role: 'chat', kind: 'arena_headline', source: 'arena', system: 'You write tabloid headlines for a streaming site\'s trash-talk arena: inflammatory, funny, screenshot-able, names both fighters, ≤ 100 chars. Profanity and disrespect welcome; this platform does not censor language. Hard line: no direct threats of violence, no doxxing. Output only the JSON.', user: JSON.stringify({ kind, ...ctx }), json: HEADLINE_SCHEMA, maxTokens: 80, temperature: 1.0, timeoutMs: 15000 });
        return r && r.json && r.json.headline ? String(r.json.headline).slice(0, 120) : null;
    } catch { return null; }
}
function templateHeadline(kind, ctx) {
    if (kind === 'open') return `${ctx.a} has words for ${ctx.b}${ctx.rematch ? ' — REMATCH' : ''}${ctx.line ? `: “${String(ctx.line).slice(0, 60)}”` : ''}`;
    if (kind === 'forfeit') return `${ctx.loser} DUCKED. ${ctx.winner} wins by silence.`;
    if (kind === 'score') return ctx.winner ? `${ctx.winner} out-talks ${ctx.loser} ${ctx.score_a}–${ctx.score_b}${ctx.upset ? ' — UPSET' : ''}` : `${ctx.a} and ${ctx.b} talk themselves into a draw`;
    return null;
}
function sqlDate(ms) { return new Date(ms).toISOString().replace('T', ' ').slice(0, 19); }

function openBeefBetween(u1, u2) {
    ensureTables();
    return db.get(`SELECT * FROM arena_beefs WHERE status = 'open' AND ((a_user_id = ? AND b_user_id = ?) OR (a_user_id = ? AND b_user_id = ?))`, [u1, u2, u2, u1]) || null;
}
function openBeefsFor(userId) {
    ensureTables();
    return db.all(`SELECT * FROM arena_beefs WHERE status = 'open' AND (a_user_id = ? OR b_user_id = ?) ORDER BY opened_at DESC`, [userId, userId]);
}

function clockFor(targetId, fromMs = Date.now()) {
    return sqlDate(fromMs + (isLive(targetId) ? RESPONSE_LIVE_MIN * 60 * 1000 : RESPONSE_OFFLINE_HOURS * 3600 * 1000));
}

function pushFeed(beef, event) {
    const feed = parseJson(beef.feed_json, []);
    feed.push({ at: nowIso(), ...event });
    return JSON.stringify(feed.slice(-FEED_MAX));
}

/**
 * A judged hit: `speakerId` talked trash aimed at `targetId` (both on the roster).
 * Opens the beef if needed, scores it, and puts the other side on the clock.
 */
function recordHit(speakerId, targetId, hit) {
    ensureTables();
    if (speakerId === targetId) return null;
    let beef = openBeefBetween(speakerId, targetId);
    let opened = false;
    if (!beef) {
        const endsAt = sqlDate(Date.now() + MAX_BEEF_HOURS * 3600 * 1000);
        const history = rivalry(speakerId, targetId);
        const bounty = board().openBountyOn(targetId);
        db.run(`INSERT INTO arena_beefs (a_user_id, b_user_id, on_clock, clock_until, ends_at, feed_json, opener_line, rematch, bounty_topic_id, headline) VALUES (?, ?, 'b', ?, ?, '[]', ?, ?, ?, ?)`,
            [speakerId, targetId, clockFor(targetId), endsAt, String(hit.best_line || '').slice(0, 220), history.fights > 0 ? 1 : 0, bounty?.id || null, templateHeadline('open', { a: nameOf(speakerId), b: nameOf(targetId), line: hit.best_line, rematch: history.fights > 0 })]);
        beef = openBeefBetween(speakerId, targetId);
        opened = true;
        board().addXp(speakerId, XP_BEEF_OPEN, 'beef_open', beef.id);
        console.log(`[Arena] beef #${beef.id} opened: user ${speakerId} → user ${targetId}${history.fights ? ' (rematch)' : ''}${bounty ? ' (bounty!)' : ''}`);
        const id = beef.id;
        headlineFor('open', { a: nameOf(speakerId), b: nameOf(targetId), opening_line: hit.best_line, about: hit.about, rematch: history.fights > 0, record_between: history, bounty: !!bounty }).then(h => { if (h) db.run('UPDATE arena_beefs SET headline = ? WHERE id = ?', [h, id]); }).catch(() => {});
    }
    const side = beef.a_user_id === speakerId ? 'a' : 'b';
    const other = side === 'a' ? 'b' : 'a';
    const otherId = side === 'a' ? beef.b_user_id : beef.a_user_id;
    const quality = Math.max(0, Math.min(10, Number(hit.quality) || 0));
    const firstResponse = side === 'b' && !beef.responded;
    const feed = pushFeed(beef, { kind: opened ? 'open' : (firstResponse ? 'respond' : 'hit'), side, text: String(hit.best_line || '').slice(0, 220), quality, about: hit.about || null, announcer: hit.announcer || null, vod_id: hit.vod_id || null, sec: hit.sec ?? null });
    db.run(`UPDATE arena_beefs SET score_${side} = score_${side} + ?, hits_${side} = hits_${side} + 1, last_${side}_at = CURRENT_TIMESTAMP, responded = CASE WHEN ? THEN 1 ELSE responded END,
            on_clock = ?, clock_until = ?, feed_json = ? WHERE id = ?`,
        [quality, side === 'b' ? 1 : 0, other, clockFor(otherId), feed, beef.id]);
    // Bounty: anyone with a bounty on their head pays double to whoever collects.
    const bounty = board().openBountyOn(targetId);
    board().addXp(speakerId, quality * XP_BEEF_HIT * (bounty ? 2 : 1), 'beef_hit', beef.id, { beefHit: true, line: hit.best_line, lineScore: quality, lineVodId: hit.vod_id, lineSec: hit.sec });
    if (bounty) board().recordBountyHit(speakerId, bounty, quality);
    return { beef: db.get('SELECT * FROM arena_beefs WHERE id = ?', [beef.id]), opened, side, first_response: firstResponse, bounty: !!bounty };
}

function hype(beefId, side, voterKey) {
    ensureTables();
    const beef = db.get('SELECT * FROM arena_beefs WHERE id = ? AND status = ?', [beefId, 'open']);
    if (!beef) throw new Error('No open beef with that id');
    if (!['a', 'b'].includes(side)) throw new Error('side must be a or b');
    const sideUser = side === 'a' ? beef.a_user_id : beef.b_user_id;
    if (voterKey === `user:${sideUser}`) throw new Error("You can't hype yourself");
    const ins = db.run('INSERT OR IGNORE INTO arena_beef_hype (beef_id, side, voter_key) VALUES (?, ?, ?)', [beefId, side, voterKey]);
    const n = db.get('SELECT COUNT(*) AS n FROM arena_beef_hype WHERE beef_id = ? AND side = ?', [beefId, side])?.n || 0;
    db.run(`UPDATE arena_beefs SET crowd_${side} = ? WHERE id = ?`, [Math.min(CROWD_MAX, n), beefId]);
    if (ins.changes) board().addXp(sideUser, board().XP_HYPE, 'hype', beefId);
    return { added: !!ins.changes, hypers: n, crowd: Math.min(CROWD_MAX, n) };
}

function totals(beef) {
    return { a: Number(((beef.score_a || 0) + (beef.crowd_a || 0)).toFixed(1)), b: Number(((beef.score_b || 0) + (beef.crowd_b || 0)).toFixed(1)) };
}

function resolve(beef, resolution, winnerId) {
    const loserId = winnerId == null ? null : (winnerId === beef.a_user_id ? beef.b_user_id : beef.a_user_id);
    let upset = 0;
    try { const roster = arena().loadRoster(); if (winnerId && loserId) { const rw = roster.order.indexOf(winnerId), rl = roster.order.indexOf(loserId); upset = rw >= 0 && rl >= 0 && rw - rl >= 4 ? 1 : 0; } } catch { /* */ }
    const t = totals(beef);
    const ctx = { a: nameOf(beef.a_user_id), b: nameOf(beef.b_user_id), winner: winnerId ? nameOf(winnerId) : null, loser: loserId ? nameOf(loserId) : null, score_a: t.a, score_b: t.b, upset: !!upset, streak: winnerId ? streakFor(winnerId) + 1 : 0 };
    const feed = pushFeed(beef, { kind: resolution === 'forfeit' ? 'forfeit' : 'end', side: winnerId == null ? null : (winnerId === beef.a_user_id ? 'a' : 'b'), text: null, upset: !!upset });
    db.run(`UPDATE arena_beefs SET status = 'resolved', resolution = ?, winner_user_id = ?, resolved_at = CURRENT_TIMESTAMP, on_clock = NULL, clock_until = NULL, feed_json = ?, upset = ?, result_headline = ? WHERE id = ? AND status = 'open'`, [resolution, winnerId, feed, upset, templateHeadline(resolution === 'forfeit' ? 'forfeit' : 'score', ctx), beef.id]);
    if (winnerId) board().addXp(winnerId, XP_BEEF_WIN + (upset ? 20 : 0), upset ? 'beef_upset_win' : 'beef_win', beef.id);
    // Viewers who picked a side: settle their clout.
    const voters = db.all('SELECT voter_key, side FROM arena_beef_sides WHERE beef_id = ?', [beef.id]);
    const winSide = winnerId == null ? null : (winnerId === beef.a_user_id ? 'a' : 'b');
    try { board().settleClout && board().settleClout(voters.map(v => v.voter_key), new Set(voters.filter(v => v.side === winSide).map(v => v.voter_key))); } catch { /* */ }
    console.log(`[Arena] beef #${beef.id} resolved: ${resolution}${winnerId ? ` winner user ${winnerId}` : ' draw'}${upset ? ' UPSET' : ''}`);
    const id = beef.id;
    headlineFor(resolution, ctx).then(h => { if (h) db.run('UPDATE arena_beefs SET result_headline = ? WHERE id = ?', [h, id]); }).catch(() => {});
    try { arena().loadRoster(true); } catch { /* */ }
}

/** Sides: viewers back a fighter in an open beef (`!side <name>` in chat or the button). */
function pickSide(beefId, voterKey, side, userId = null) {
    ensureTables();
    const beef = db.get('SELECT * FROM arena_beefs WHERE id = ? AND status = ?', [beefId, 'open']);
    if (!beef) throw new Error('No open beef with that id');
    if (!['a', 'b'].includes(side)) throw new Error('side must be a or b');
    db.run('INSERT INTO arena_beef_sides (beef_id, voter_key, side, user_id) VALUES (?, ?, ?, ?) ON CONFLICT(beef_id, voter_key) DO UPDATE SET side = excluded.side, created_at = CURRENT_TIMESTAMP', [beefId, voterKey, side, userId]);
    return sidesTally(beefId);
}
function sidesTally(beefId) {
    const r = db.get(`SELECT SUM(side = 'a') AS a, SUM(side = 'b') AS b FROM arena_beef_sides WHERE beef_id = ?`, [beefId]) || {};
    const a = r.a || 0, b = r.b || 0;
    return { a, b, share_a: a + b ? Math.round((a / (a + b)) * 100) : 50 };
}

/** Current win streak (consecutive resolved beefs won). */
function streakFor(userId) {
    ensureTables();
    let n = 0;
    for (const b of db.all(`SELECT winner_user_id FROM arena_beefs WHERE status = 'resolved' AND (a_user_id = ? OR b_user_id = ?) ORDER BY resolved_at DESC LIMIT 20`, [userId, userId])) { if (b.winner_user_id === userId) n++; else break; }
    return n;
}

/** Rivalry between two fighters: fights, record, receipts (best lines from earlier beefs). */
function rivalry(u1, u2) {
    ensureTables();
    const rows = db.all(`SELECT * FROM arena_beefs WHERE status = 'resolved' AND ((a_user_id = ? AND b_user_id = ?) OR (a_user_id = ? AND b_user_id = ?)) ORDER BY resolved_at DESC LIMIT 10`, [u1, u2, u2, u1]);
    const wins1 = rows.filter(r => r.winner_user_id === u1).length, wins2 = rows.filter(r => r.winner_user_id === u2).length;
    const receipts = [];
    for (const r of rows.slice(0, 3)) for (const e of parseJson(r.feed_json, [])) if (e.text && e.quality >= 6) receipts.push({ beef_id: r.id, side_user_id: e.side === 'a' ? r.a_user_id : r.b_user_id, text: e.text, quality: e.quality, vod_id: e.vod_id, sec: e.sec, at: e.at });
    receipts.sort((x, y) => y.quality - x.quality);
    return { fights: rows.length, wins_1: wins1, wins_2: wins2, last: rows[0] ? { id: rows[0].id, winner_user_id: rows[0].winner_user_id, resolution: rows[0].resolution, at: rows[0].resolved_at } : null, receipts: receipts.slice(0, 4) };
}

function rivalriesFor(userId, limit = 5) {
    ensureTables();
    const opps = db.all(`SELECT CASE WHEN a_user_id = ? THEN b_user_id ELSE a_user_id END AS opp, COUNT(*) AS n FROM arena_beefs WHERE (a_user_id = ? OR b_user_id = ?) GROUP BY opp HAVING n >= 2 ORDER BY n DESC LIMIT ?`, [userId, userId, userId, limit]);
    const b = board();
    const roster = arena().loadRoster();
    return opps.map(o => { const r = rivalry(userId, o.opp); return { opponent: b.fighterBrief(o.opp, roster), fights: r.fights + (openBeefBetween(userId, o.opp) ? 1 : 0), wins: r.wins_1, losses: r.wins_2, open: !!openBeefBetween(userId, o.opp), receipts: r.receipts.slice(0, 2) }; });
}

/** Ticker: enforce clocks and hard ends; tighten an offline clock when the target goes live. */
function tick() {
    ensureTables();
    const now = Date.now();
    for (const beef of db.all(`SELECT * FROM arena_beefs WHERE status = 'open'`)) {
        const t = totals(beef);
        if (beef.ends_at && Date.parse(beef.ends_at + 'Z') <= now) {
            resolve(beef, 'score', t.a === t.b ? null : (t.a > t.b ? beef.a_user_id : beef.b_user_id));
            continue;
        }
        if (beef.on_clock && beef.clock_until) {
            const onId = beef.on_clock === 'a' ? beef.a_user_id : beef.b_user_id;
            const until = Date.parse(beef.clock_until + 'Z');
            // Tighten: if the side on the clock is live now, they get the live window at most.
            const liveCap = now + RESPONSE_LIVE_MIN * 60 * 1000;
            if (isLive(onId) && until > liveCap) db.run('UPDATE arena_beefs SET clock_until = ? WHERE id = ?', [sqlDate(liveCap), beef.id]);
            else if (until <= now) {
                const winner = beef.on_clock === 'a' ? beef.b_user_id : beef.a_user_id;
                resolve(beef, 'forfeit', winner);
            }
        }
    }
}

// ── Records + views ──────────────────────────────────────────

function recordFor(userId) {
    ensureTables();
    const r = db.get(`SELECT SUM(CASE WHEN winner_user_id = ? THEN 1 ELSE 0 END) AS wins,
                             SUM(CASE WHEN status = 'resolved' AND winner_user_id IS NOT NULL AND winner_user_id != ? THEN 1 ELSE 0 END) AS losses,
                             SUM(CASE WHEN status = 'resolved' AND winner_user_id IS NULL THEN 1 ELSE 0 END) AS draws
                      FROM arena_beefs WHERE a_user_id = ? OR b_user_id = ?`, [userId, userId, userId, userId]) || {};
    return { wins: r.wins || 0, losses: r.losses || 0, draws: r.draws || 0 };
}

function recentWins(userId, days = 7) {
    ensureTables();
    return db.get(`SELECT COUNT(*) AS n FROM arena_beefs WHERE winner_user_id = ? AND resolved_at >= datetime('now', ?)`, [userId, `-${days} days`])?.n || 0;
}

function beefView(beef, roster) {
    const t = totals(beef);
    const b = board();
    const clockMs = beef.clock_until ? Date.parse(beef.clock_until + 'Z') - Date.now() : null;
    return {
        id: beef.id, status: beef.status, resolution: beef.resolution,
        a: { ...b.fighterBrief(beef.a_user_id, roster), score: Number((beef.score_a || 0).toFixed(1)), hits: beef.hits_a || 0, crowd: beef.crowd_a || 0, total: t.a, last_at: beef.last_a_at },
        b: { ...b.fighterBrief(beef.b_user_id, roster), score: Number((beef.score_b || 0).toFixed(1)), hits: beef.hits_b || 0, crowd: beef.crowd_b || 0, total: t.b, last_at: beef.last_b_at },
        share_a: t.a + t.b > 0 ? Math.round((t.a / (t.a + t.b)) * 100) : 50,
        on_clock: beef.on_clock, clock_until: beef.clock_until ? new Date(beef.clock_until + 'Z').toISOString() : null, clock_seconds_left: clockMs == null ? null : Math.max(0, Math.round(clockMs / 1000)),
        clock_is_live_window: beef.on_clock ? isLive(beef.on_clock === 'a' ? beef.a_user_id : beef.b_user_id) : false,
        responded: !!beef.responded,
        opener_line: beef.opener_line, headline: beef.headline, result_headline: beef.result_headline,
        rematch: !!beef.rematch, upset: !!beef.upset, bounty: !!beef.bounty_topic_id,
        sides: sidesTally(beef.id),
        history: rivalry(beef.a_user_id, beef.b_user_id),
        streaks: { a: streakFor(beef.a_user_id), b: streakFor(beef.b_user_id) },
        feed: parseJson(beef.feed_json, []).slice(-14),
        winner_user_id: beef.winner_user_id,
        opened_at: beef.opened_at, ends_at: beef.ends_at ? new Date(beef.ends_at + 'Z').toISOString() : null, resolved_at: beef.resolved_at,
        rules: { response_live_min: RESPONSE_LIVE_MIN, response_offline_hours: RESPONSE_OFFLINE_HOURS, max_hours: MAX_BEEF_HOURS, crowd_max: CROWD_MAX },
    };
}

function list({ limitResolved = 12 } = {}) {
    ensureTables();
    const roster = arena().loadRoster();
    const open = db.all(`SELECT * FROM arena_beefs WHERE status = 'open' ORDER BY COALESCE(last_b_at, last_a_at, opened_at) DESC`).map(b => beefView(b, roster));
    const resolved = db.all(`SELECT * FROM arena_beefs WHERE status = 'resolved' ORDER BY resolved_at DESC LIMIT ?`, [limitResolved]).map(b => beefView(b, roster));
    return { open, resolved };
}

function get(id) {
    ensureTables();
    const b = db.get('SELECT * FROM arena_beefs WHERE id = ?', [id]);
    return b ? beefView(b, arena().loadRoster()) : null;
}

function forUser(userId, limit = 8) {
    ensureTables();
    const roster = arena().loadRoster();
    return db.all(`SELECT * FROM arena_beefs WHERE a_user_id = ? OR b_user_id = ? ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, COALESCE(resolved_at, opened_at) DESC LIMIT ?`, [userId, userId, limit]).map(b => beefView(b, roster));
}

module.exports = {
    ensureTables, recordHit, hype, tick, recordFor, recentWins, list, get, forUser, openBeefBetween, openBeefsFor, beefView, totals,
    pickSide, sidesTally, streakFor, rivalry, rivalriesFor, nameOf,
    RESPONSE_LIVE_MIN, RESPONSE_OFFLINE_HOURS, MAX_BEEF_HOURS, CROWD_MAX, XP_BEEF_WIN, XP_BEEF_OPEN, XP_BEEF_HIT,
};
