/**
 * slogan-job.js — generate the home hero's rotating words + slogans PURELY from the site's AI
 * understanding of its own community, refreshed daily.
 *
 * Each run fuses every AI data source we have — the global chat-AI overview + running memory +
 * timeline, per-USER chat analysis for the most active chatters (running jokes, personalities),
 * recent streamer AI overviews, and recent VOD AI overviews — plus active usernames, and asks
 * the shared LLM for ~20 rotating audience words and ~20 slogans that reference the real vibe,
 * people, and memes of the site. Stored as a fresh daily batch in site_settings, with a static
 * fallback only for the cold-start / AI-off case.
 */
'use strict';
const db = require('../db/database');
const chatReads = require('../chat/chat-reads');
const aiService = require('./ai-service');
const ai = require('./ai-analysis');

// Slogans are driven together with the hero background moments (ai-moments-job triggers a
// regen every 6h). This is only a FALLBACK cadence — slightly longer than the moments' 6h so
// the moments job always fires first and the two never double-generate.
const INTERVAL_MS = 7 * 60 * 60 * 1000;
const TARGET = 20;                        // ~20 words + ~20 slogans per batch
let _timer = null, _busy = false;

// The model has produced every wrong shape at least once: "live streaming for X", "for X",
// "X live streaming", "X for live streaming". The hero prints "Live streaming for {X}", so X must
// be the bare noun phrase. Strip the framing at both ends; anything still containing
// "streaming"/"livestream" is dropped by the caller.
function _stripAudiencePrefix(s) {
    return String(s == null ? '' : s)
        .replace(/^\s*(live\s*-?\s*)?streaming\s+for\s+/i, '')
        .replace(/^\s*for\s+/i, '')
        .replace(/[\s,.\-–—:]*(for\s+)?(live\s*-?\s*)?stream(ing|ers|s)?\s*$/i, '')
        .replace(/[\s,.\-–—:]*(live\s*-?\s*)?streaming\s+for\s*$/i, '')
        .trim();
}
const _BAD_AUDIENCE = /\b(live\s*-?\s*)?stream(ing|s)?\b|\blivestream/i;
const _NO_FREE = /\b(free|no[- ]cost)\b|\$\s?0\b/i;
function _cleanList(arr, maxLen, max) {
    if (!Array.isArray(arr)) return [];
    const seen = new Set(); const out = [];
    for (const raw of arr) {
        let s = String(raw == null ? '' : raw).trim().replace(/^["'‘’“”\-•\s]+|["'‘’“”\s]+$/g, '').replace(/[.,;:]+$/, '');
        if (!s || s.length > maxLen) continue;
        const k = s.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k); out.push(s);
        if (out.length >= max) break;
    }
    return out;
}
function _topUp(fresh, old, cap) {
    const seen = new Set(fresh.map(s => s.toLowerCase())); const out = fresh.slice();
    for (const s of (old || [])) { const v = String(s || '').trim(); if (!v) continue; const k = v.toLowerCase(); if (seen.has(k)) continue; seen.add(k); out.push(v); if (out.length >= cap) break; }
    return out.slice(0, cap);
}
const SLOGAN_FORMAT = 3; // bump to force a one-time regen after a prompt/format change
async function _loadPool() {
    try { const cur = await db.getState('home_hero_slogans'); const o = typeof cur === 'string' ? JSON.parse(cur) : cur; if (o) return { audiences: o.audiences || [], quips: o.quips || [], updated_at: o.updated_at || 0, v: o.v || 1 }; } catch { /* */ }
    return { audiences: [], quips: [], updated_at: 0, v: 0 };
}

async function tick() {
    if (_busy || !await ai.isEnabled() || !await ai.withinBudget()) return;
    _busy = true;
    try {
        // ── Global chat AI: overview + running memory + timeline ──
        // The global chat-AI summary is OpenVibe.Chat's (roadmap T3), read through its public API.
        const insights = require('../chat/insight-client');
        let global = '';
        try {
            const g = await insights.getGlobal();
            if (g) {
                const tl = g.timeline ? (typeof g.timeline === 'string' ? g.timeline : JSON.stringify(g.timeline)) : '';
                global = [g.overview, g.memory, tl && `Timeline: ${tl}`].filter(Boolean).join('\n').slice(0, 1800);
            }
        } catch { /* */ }

        // ── Active chatters (ids) → per-USER chat analysis (running jokes / personalities) ──
        // Chat's top-chatters stat (site-wide, the same 14-day window), then Live drops banned
        // accounts from its own user table before asking Chat for each one's insight.
        let activeRows = [];
        try {
            const top = await chatReads.topChatters({ since: Date.now() - 14 * 86400e3, limit: 12 });
            activeRows = (top || [])
                .map((r) => ({ id: Number(r.user_id) || 0, username: r.username }))
                .filter((r) => {
                    if (!r.id) return false;
                    try { const u = db.getUserById(r.id); return !!(u && !u.is_banned); } catch { return false; }
                });
        } catch { /* */ }
        const usernames = activeRows.map(r => r.username).filter(Boolean);
        // The prompt is OpenVibe.AI's versioned template live.hero.slogans (WS-O task 2); Live sends the
        // real data. Per-chatter chat-AI blurbs come from OpenVibe.Chat (roadmap T3).
        const users = [];
        for (const r of activeRows.slice(0, 8)) {
            const ins = await insights.getUser(r.id).catch(() => null);
            const blurb = ins && (ins.overview || ins.memory);
            if (blurb) users.push({ name: String(r.username).slice(0, 120), text: String(blurb).replace(/\s+/g, ' ').slice(0, 180) });
        }

        // ── Streamer AI overviews + recent VOD AI overviews ──
        let streamers = [];
        try {
            const rows = await db.all(`SELECT u.username, COALESCE(so.overview_short, so.overview) AS ov
                FROM streamer_overviews so JOIN users u ON so.user_id = u.id
                WHERE COALESCE(u.is_banned,0)=0 AND so.overview IS NOT NULL
                ORDER BY so.generated_at DESC LIMIT 8`) || [];
            streamers = rows.map(r => ({ name: String(r.username).slice(0, 120), text: String(r.ov || '').replace(/\s+/g, ' ').slice(0, 180) }));
        } catch { /* */ }
        let vods = [];
        try {
            // VODs live in OpenVibe.Media; overviews live in Live's vod_ai_state.
            const media = require('../media-client');
            const out = await media.listVods({ limit: 10 }).catch(() => null);
            vods = (await Promise.all((out?.vods || (Array.isArray(out) ? out : []))
                .map(async v => ({ name: String(v.title || '').slice(0, 60), text: String((db.getVodAiState && (await db.getVodAiState(v.id))?.ai_overview_short) || v.ai_overview_short || '').replace(/\s+/g, ' ').slice(0, 140) }))))
                .filter(v => v.text.trim().length > 1);
        } catch { /* */ }

        const parsed = await aiService.structured('live.hero.slogans', {
            global: String(global || '').slice(0, 4000), users, streamers, vods,
            usernames: usernames.map(u => String(u).slice(0, 64)).slice(0, 40), count: TARGET,
        }, { meter: { kind: 'hero_slogans', role: 'legacy' } });
        if (!parsed) return;
        let audiences = _cleanList((parsed.audiences || []).map(_stripAudiencePrefix).filter(a => a && !_BAD_AUDIENCE.test(a) && !/^for\b/i.test(a)), 60, TARGET);
        // The owner's rule: no "free"/"$0" copy anywhere, whatever the model writes.
        audiences = audiences.filter(a => !_NO_FREE.test(a));
        let quips = _cleanList((parsed.quips || []).filter(q => !_NO_FREE.test(String(q))), 110, TARGET);
        if (audiences.length < 6 && quips.length < 6) return; // bad batch — keep yesterday's

        // Fresh daily batch; top up from the previous batch only if the model returned few.
        const old = await _loadPool();
        audiences = _topUp(audiences, old.audiences.map(_stripAudiencePrefix).filter(a => a && !_BAD_AUDIENCE.test(a)), TARGET);
        quips = _topUp(quips, old.quips.filter(q => !_NO_FREE.test(String(q))), TARGET);
        await db.setState('home_hero_slogans', JSON.stringify({ v: SLOGAN_FORMAT, audiences, quips, updated_at: Date.now() }));
        console.log(`[Slogans] Fresh daily batch: ${audiences.length} words, ${quips.length} slogans (from full AI context)`);
    } catch (e) {
        console.warn('[Slogans] generation failed:', e.message);
    } finally {
        _busy = false;
    }
}

// Is a fresh batch due? Based on the stored batch's age (NOT a from-boot timer) so the
// countdown the hero shows (updated_at + 12h) always matches when we actually regenerate.
async function _dueForRegen() {
    const pool = await _loadPool();
    if (pool.v !== SLOGAN_FORMAT) return true;                 // new prompt/format
    if (pool.audiences.length < 8) return true;                // empty / too small
    if (pool.audiences.some(a => _BAD_AUDIENCE.test(String(a)))) return true; // old buggy shapes ("… live streaming")
    if (!pool.updated_at || (Date.now() - pool.updated_at) >= INTERVAL_MS) return true; // 12h elapsed
    return false;
}

function start() {
    if (_timer) return;
    // Poll every 5 min and regenerate whenever a fresh batch is due — self-correcting across
    // restarts and keeps the hero countdown honest (regenerates within ~5 min of hitting 12h).
    const CHECK_MS = 5 * 60 * 1000;
    _timer = setInterval(async () => { if (await _dueForRegen()) tick().catch(() => {}); }, CHECK_MS);
    if (_timer.unref) _timer.unref();
    setTimeout(async () => { if (await _dueForRegen()) tick().catch(() => {}); }, 60 * 1000);
    console.log('[Slogans] hero-slogan job started (12h batch from full AI context)');
}

module.exports = { start, tick };
