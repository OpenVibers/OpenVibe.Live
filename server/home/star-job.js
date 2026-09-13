/**
 * star-job.js — "Star of OpenVibe" picked by the site's AI, rotating daily.
 *
 * Candidates are streamers who went live in the last CANDIDATE_DAYS days (not banned). Each one
 * gets real stats — sessions, hours, peak/avg viewers, chat lines in their streams, new followers,
 * Arena mic moments, language, what they stream (AI overview) — and the shared LLM picks who gets
 * the red carpet today and writes a one-line reason. Recent stars are excluded so it rotates
 * instead of parking on one person. With AI off (or a bad answer) a plain score picks instead.
 *
 * State:  site_state `star_pick` = { username, reason, headline, picked_at, next_at, by, history[] }
 *         site_setting `star_streamer` = the current username (what /api/home/star reads)
 *         site_setting `star_streamer_pinned` = a manual override: set → the job leaves it alone.
 */
'use strict';
const db = require('../db/database');

const ROTATE_MS = 24 * 60 * 60 * 1000;      // a new star every day
const CHECK_MS = 30 * 60 * 1000;            // how often the job looks at the clock
const CANDIDATE_DAYS = 14;
const HISTORY_KEEP = 4;                     // last N stars are ineligible
const STATE_KEY = 'star_pick';

let _timer = null, _busy = false;

function loadPick() {
    try { const s = db.getState(STATE_KEY); const o = typeof s === 'string' ? JSON.parse(s) : s; if (o && typeof o === 'object') return o; } catch { /* */ }
    return null;
}
function pinned() { try { return String(db.getSetting('star_streamer_pinned') || '').trim(); } catch { return ''; } }

/** Everyone who streamed recently, with the numbers the picker looks at. */
function candidates() {
    const rows = db.all(`
        SELECT u.id, u.username, u.display_name, u.bio,
               COUNT(s.id) AS sessions,
               ROUND(SUM(COALESCE(s.duration_seconds, CASE WHEN s.ended_at IS NOT NULL THEN (julianday(s.ended_at) - julianday(s.started_at)) * 86400 ELSE 0 END)) / 3600.0, 1) AS hours,
               MAX(COALESCE(s.peak_viewers, 0)) AS peak_viewers,
               ROUND(AVG(COALESCE(s.peak_viewers, 0)), 1) AS avg_peak,
               MAX(s.started_at) AS last_live_at,
               (SELECT COUNT(*) FROM chat_messages c WHERE c.stream_id IN (SELECT id FROM streams x WHERE x.user_id = u.id AND x.started_at >= datetime('now', ?)) AND COALESCE(c.is_deleted, 0) = 0) AS chat_lines,
               (SELECT COUNT(*) FROM follows f WHERE f.streamer_id = u.id AND f.created_at >= datetime('now', ?)) AS new_followers,
               (SELECT COUNT(*) FROM follows f WHERE f.streamer_id = u.id) AS followers,
               (SELECT COUNT(*) FROM arena_mic_moments m WHERE m.user_id = u.id AND m.said_at >= datetime('now', ?)) AS mic_moments,
               (SELECT COALESCE(so.overview_short, so.overview) FROM streamer_overviews so WHERE so.user_id = u.id) AS overview,
               (SELECT ch.ai_category FROM channels ch WHERE ch.user_id = u.id) AS category
        FROM users u JOIN streams s ON s.user_id = u.id
        WHERE s.started_at >= datetime('now', ?) AND COALESCE(u.is_banned, 0) = 0
        GROUP BY u.id
        ORDER BY hours DESC LIMIT 40`, [`-${CANDIDATE_DAYS} days`, `-${CANDIDATE_DAYS} days`, `-${CANDIDATE_DAYS} days`, `-${CANDIDATE_DAYS} days`]) || [];
    let i18n = null; try { i18n = require('../i18n/translate'); } catch { i18n = null; }
    for (const r of rows) {
        r.language = i18n ? (() => { try { return i18n.channelLanguage(r.id); } catch { return 'en'; } })() : 'en';
        r.score = Number(r.hours || 0) * 1.0 + Number(r.peak_viewers || 0) * 2 + Number(r.chat_lines || 0) / 40 + Number(r.new_followers || 0) * 3 + Number(r.mic_moments || 0) * 1.5 + Math.min(Number(r.sessions || 0), 10) * 0.5;
    }
    return rows;
}

function scorePick(cands, exclude) {
    const ok = cands.filter(c => !exclude.has(c.username.toLowerCase()));
    const pool = ok.length ? ok : cands;
    return pool.slice().sort((a, b) => b.score - a.score)[0] || null;
}

async function aiPick(cands, exclude, previous) {
    let llm = null; try { llm = require('../ai/llm'); } catch { return null; }
    if (!llm || !llm.isEnabled() || !llm.withinBudget()) return null;
    const list = cands.filter(c => !exclude.has(c.username.toLowerCase())).slice(0, 25).map(c => ({
        username: c.username, name: c.display_name || c.username, language: c.language, category: c.category || null,
        last_14d: { sessions: c.sessions, hours: c.hours, peak_viewers: c.peak_viewers, avg_peak_viewers: c.avg_peak, chat_lines: c.chat_lines, new_followers: c.new_followers, arena_mic_moments: c.mic_moments },
        followers: c.followers, last_live: c.last_live_at,
        about: String(c.overview || c.bio || '').replace(/\s+/g, ' ').slice(0, 220) || null,
    }));
    if (!list.length) return null;
    const schema = { name: 'home_star', schema: { type: 'object', additionalProperties: false, required: ['username', 'headline', 'reason'], properties: { username: { type: 'string', description: 'exact username from the candidates' }, headline: { type: 'string', description: '≤ 60 chars' }, reason: { type: 'string', description: '≤ 170 chars, one sentence' } } } };
    const system = `You pick today's "Star of OpenVibe" — the one streamer OpenVibe.Live (a scrappy, open-source, community-run live-streaming site) rolls out the red carpet for on its home page for the next 24 hours.
Pick from the candidates ONLY (use the exact username). Spread the love: favour people who showed up and put in real hours, grew, got chat talking, or bring something different (a language, a niche, a robot, a vibe) — not just the biggest number. Small streamers who are consistent deserve their day. Never pick anyone in the "recent stars" list.
Write a "headline" (≤ 60 chars, punchy, warm, no quotes) and a "reason" (≤ 170 chars, one sentence, second person is fine, reference their real numbers or what they do — no emojis, no hashtags, no sarcasm, never mock). Output only JSON.`;
    const user = JSON.stringify({ recent_stars: Array.from(exclude), previous_star: previous || null, candidates: list });
    let r = null;
    try { r = await llm.complete({ role: 'summary', kind: 'home_star', source: 'home', system, user, json: schema, maxTokens: 300, temperature: 0.9, timeoutMs: 30000 }); } catch (e) { console.warn('[Star] model call failed:', e.message); return null; }
    if (!r) { console.warn('[Star] model returned nothing — falling back to the score pick'); return null; }
    let out = null;
    if (r && typeof r === 'object') out = r.json || r.parsed || (r.text ? llm.parseJsonLoose(r.text) : null) || (r.content ? llm.parseJsonLoose(r.content) : null);
    else if (typeof r === 'string') out = llm.parseJsonLoose(r);
    if (!out || !out.username) return null;
    const c = cands.find(x => x.username.toLowerCase() === String(out.username).toLowerCase());
    if (!c || exclude.has(c.username.toLowerCase())) return null;
    return { cand: c, headline: String(out.headline || '').trim().slice(0, 60), reason: String(out.reason || '').trim().slice(0, 170) };
}

/** Pick a new star now (force) or when the current one has had its day. */
async function rotate({ force = false } = {}) {
    if (_busy) return { busy: true };
    if (pinned()) return { pinned: pinned() };
    const cur = loadPick();
    const now = Date.now();
    if (!force && cur && cur.next_at && now < Number(cur.next_at)) return { current: cur.username, next_at: cur.next_at };
    _busy = true;
    try {
        const cands = candidates();
        if (!cands.length) return { none: true };
        // Recent stars (and whatever the setting / env currently holds) are ineligible.
        const history = Array.isArray(cur && cur.history) ? cur.history.slice() : [];
        let currentName = ''; try { currentName = String(db.getSetting('star_streamer') || require('../config').starStreamer || '').trim(); } catch { /* */ }
        if (currentName && !history.includes(currentName)) history.push(currentName);
        const exclude = new Set(history.slice(-HISTORY_KEEP).map(s => String(s).toLowerCase()));
        let by = 'ai';
        let pick = await aiPick(cands, exclude, currentName || null);
        if (!pick) {
            const c = scorePick(cands, exclude);
            if (!c) return { none: true };
            by = 'score';
            pick = { cand: c, headline: `${c.display_name || c.username} is today's star`, reason: `${c.hours || 0}h live across ${c.sessions} stream${c.sessions === 1 ? '' : 's'} in the last two weeks${c.peak_viewers ? `, peaking at ${c.peak_viewers} viewers` : ''}.` };
        }
        const nextHistory = history.filter(h => h.toLowerCase() !== pick.cand.username.toLowerCase()).concat(pick.cand.username).slice(-12);
        const state = { username: pick.cand.username, headline: pick.headline, reason: pick.reason, picked_at: now, next_at: now + ROTATE_MS, by, history: nextHistory };
        db.setState(STATE_KEY, JSON.stringify(state));
        db.setSetting('star_streamer', pick.cand.username);
        console.log(`[Star] ${pick.cand.username} is the Star of OpenVibe for the next 24h (${by})${pick.headline ? ` — ${pick.headline}` : ''}`);
        return { picked: pick.cand.username, by };
    } catch (e) {
        console.warn('[Star] rotate failed:', e.message);
        return { error: e.message };
    } finally { _busy = false; }
}

function start() {
    if (_timer) return;
    setTimeout(() => { rotate().catch(() => {}); }, 60 * 1000);
    _timer = setInterval(() => { rotate().catch(() => {}); }, CHECK_MS);
    if (_timer.unref) _timer.unref();
    console.log('[Star] star-of-OpenVibe picker started (rotates daily, AI-picked)');
}

module.exports = { start, rotate, loadPick, candidates, ROTATE_MS, STATE_KEY };
