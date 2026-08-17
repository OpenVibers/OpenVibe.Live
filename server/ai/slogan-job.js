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
const ai = require('./ai-analysis');
let chatAi = null; try { chatAi = require('./chat-ai'); } catch { /* optional */ }

// Slogans are driven together with the hero background moments (ai-moments-job triggers a
// regen every 6h). This is only a FALLBACK cadence — slightly longer than the moments' 6h so
// the moments job always fires first and the two never double-generate.
const INTERVAL_MS = 7 * 60 * 60 * 1000;
const TARGET = 20;                        // ~20 words + ~20 slogans per batch
let _timer = null, _busy = false;

function _parseJson(text) {
    if (!text) return null;
    let t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try { return JSON.parse(t); } catch { /* */ }
    const m = t.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* */ } }
    return null;
}
function _stripAudiencePrefix(s) {
    return String(s == null ? '' : s).replace(/^\s*(live\s+)?streaming\s+for\s+/i, '').replace(/^\s*for\s+/i, '');
}
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
const SLOGAN_FORMAT = 2; // bump to force a one-time regen after a prompt/format change
function _loadPool() {
    try { const cur = db.getSetting('home_hero_slogans'); const o = typeof cur === 'string' ? JSON.parse(cur) : cur; if (o) return { audiences: o.audiences || [], quips: o.quips || [], updated_at: o.updated_at || 0, v: o.v || 1 }; } catch { /* */ }
    return { audiences: [], quips: [], updated_at: 0, v: 0 };
}

async function tick() {
    if (_busy || !ai.isEnabled() || !ai.withinBudget()) return;
    _busy = true;
    try {
        // ── Global chat AI: overview + running memory + timeline ──
        let global = '';
        try {
            const g = chatAi && chatAi.getGlobalInsight && chatAi.getGlobalInsight();
            if (g) {
                const tl = g.timeline ? (typeof g.timeline === 'string' ? g.timeline : JSON.stringify(g.timeline)) : '';
                global = [g.overview, g.memory, tl && `Timeline: ${tl}`].filter(Boolean).join('\n').slice(0, 1800);
            }
        } catch { /* */ }

        // ── Active chatters (ids) → per-USER chat analysis (running jokes / personalities) ──
        let activeRows = [];
        try {
            activeRows = db.all(`
                SELECT u.id, u.username FROM chat_messages c JOIN users u ON c.user_id = u.id
                WHERE c.timestamp >= datetime('now','-14 days') AND COALESCE(u.is_banned,0)=0 AND COALESCE(c.is_deleted,0)=0
                GROUP BY u.id ORDER BY COUNT(*) DESC LIMIT 12
            `) || [];
        } catch { /* */ }
        const usernames = activeRows.map(r => r.username).filter(Boolean);
        let userCtx = '';
        try {
            const parts = [];
            for (const r of activeRows.slice(0, 8)) {
                let ins = null;
                try { ins = chatAi && chatAi.getUserInsight && chatAi.getUserInsight(r.id); } catch { /* */ }
                const blurb = ins && (ins.overview || ins.memory);
                if (blurb) parts.push(`- ${r.username}: ${String(blurb).replace(/\s+/g, ' ').slice(0, 180)}`);
            }
            userCtx = parts.join('\n').slice(0, 1600);
        } catch { /* */ }

        // ── Streamer AI overviews + recent VOD AI overviews ──
        let streamerCtx = '';
        try {
            const rows = db.all(`SELECT u.username, COALESCE(so.overview_short, so.overview) AS ov
                FROM streamer_overviews so JOIN users u ON so.user_id = u.id
                WHERE COALESCE(u.is_banned,0)=0 AND so.overview IS NOT NULL
                ORDER BY so.generated_at DESC LIMIT 8`) || [];
            streamerCtx = rows.map(r => `- ${r.username}: ${String(r.ov || '').replace(/\s+/g, ' ').slice(0, 180)}`).join('\n').slice(0, 1400);
        } catch { /* */ }
        let vodCtx = '';
        try {
            // VODs live in OpenVibe.Media; overviews live in Live's vod_ai_state.
            const media = require('../media-client');
            const out = await media.listVods({ limit: 10 }).catch(() => null);
            const rows = (out?.vods || (Array.isArray(out) ? out : []))
                .map(v => ({ title: v.title, ai_overview: (db.getVodAiState && db.getVodAiState(v.id)?.ai_overview_short) || v.ai_overview_short || '' }))
                .filter(v => v.ai_overview && v.ai_overview.trim().length > 1);
            vodCtx = rows.map(r => `- ${String(r.title || '').slice(0, 60)}: ${String(r.ai_overview || '').replace(/\s+/g, ' ').slice(0, 140)}`).join('\n').slice(0, 1400);
        } catch { /* */ }

        const prompt =
`You write the rotating hero copy for OpenVibe.Live — a scrappy, open-source, community-run live-streaming site at the heart of the OpenVibe network ("Free & Open Live Streaming" — good vibes, no suits). Voice: witty, warm, self-aware, anti-corporate, meme-literate, a little unhinged — but ALWAYS kind, never punching down.

Everything below is REAL data about THIS community right now. Lean into it hard: reference the actual people, running jokes, recurring topics, and memes so the copy feels like an inside joke the community is in on. Reference usernames by name in good fun (no @), and NEVER mock or embarrass anyone.

=== GLOBAL CHAT VIBE (overview + memory + timeline) ===
${global || '(quiet)'}

=== PER-USER CHAT ANALYSIS (running jokes / personalities) ===
${userCtx || '(none yet)'}

=== STREAMERS (what they stream) ===
${streamerCtx || '(none yet)'}

=== RECENT VODS (what's been on) ===
${vodCtx || '(none yet)'}

=== ACTIVE USERNAMES you may reference kindly ===
${usernames.join(', ') || '(none yet)'}

=== TASK ===
Produce STRICT JSON, exactly this shape and nothing else:
{
  "audiences": [ ${TARGET} short noun phrases, each finishing "Live streaming for ___". CRITICAL: ONLY the noun phrase (e.g. "van-dwelling coders", "goosely's loyal 3 viewers") — do NOT include "live streaming for" or "for". 1-6 words, lowercase, no trailing punctuation. Mix on-theme audiences with community in-jokes drawn from the data. ],
  "quips": [ ${TARGET} standalone one-liner taglines, punchy, <= 75 chars. Several should be clear references/memes about the real streamers, VODs, running jokes, or usernames above. ]
}
Return ONLY the JSON object.`;

        const text = await ai.summarizeText(prompt, 1700, 'hero_slogans');
        if (!text) return;
        const parsed = _parseJson(text);
        if (!parsed) return;
        let audiences = _cleanList((parsed.audiences || []).map(_stripAudiencePrefix), 60, TARGET);
        let quips = _cleanList(parsed.quips || [], 110, TARGET);
        if (audiences.length < 6 && quips.length < 6) return; // bad batch — keep yesterday's

        // Fresh daily batch; top up from the previous batch only if the model returned few.
        const old = _loadPool();
        audiences = _topUp(audiences, old.audiences.map(_stripAudiencePrefix), TARGET);
        quips = _topUp(quips, old.quips, TARGET);
        db.setSetting('home_hero_slogans', JSON.stringify({ v: SLOGAN_FORMAT, audiences, quips, updated_at: Date.now() }));
        console.log(`[Slogans] Fresh daily batch: ${audiences.length} words, ${quips.length} slogans (from full AI context)`);
    } catch (e) {
        console.warn('[Slogans] generation failed:', e.message);
    } finally {
        _busy = false;
    }
}

// Is a fresh batch due? Based on the stored batch's age (NOT a from-boot timer) so the
// countdown the hero shows (updated_at + 12h) always matches when we actually regenerate.
function _dueForRegen() {
    const pool = _loadPool();
    if (pool.v !== SLOGAN_FORMAT) return true;                 // new prompt/format
    if (pool.audiences.length < 8) return true;                // empty / too small
    if (pool.audiences.some(a => /streaming\s+for/i.test(String(a)))) return true; // old buggy format
    if (!pool.updated_at || (Date.now() - pool.updated_at) >= INTERVAL_MS) return true; // 12h elapsed
    return false;
}

function start() {
    if (_timer) return;
    // Poll every 5 min and regenerate whenever a fresh batch is due — self-correcting across
    // restarts and keeps the hero countdown honest (regenerates within ~5 min of hitting 12h).
    const CHECK_MS = 5 * 60 * 1000;
    _timer = setInterval(() => { if (_dueForRegen()) tick().catch(() => {}); }, CHECK_MS);
    if (_timer.unref) _timer.unref();
    setTimeout(() => { if (_dueForRegen()) tick().catch(() => {}); }, 60 * 1000);
    console.log('[Slogans] hero-slogan job started (12h batch from full AI context)');
}

module.exports = { start, tick };
