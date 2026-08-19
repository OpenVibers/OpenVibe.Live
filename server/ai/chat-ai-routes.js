/**
 * chat-ai-routes.js — read API for chat AI insight.
 *   GET /api/chat-ai/global        → global chat overview + timeline + memory
 *   GET /api/chat-ai/user/:id       → a user's "today vs all-time" insight + timeline
 * Read-only; the summaries are produced by the chat-ai poller.
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const chatAi = require('./chat-ai');

router.get('/global', (req, res) => {
    try {
        const insight = chatAi.getGlobalInsight();
        res.json({ insight: insight || null });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load global chat insight' });
    }
});

// Browsable/searchable global timeline. Query: before=<ms>, since=<ms>, q=<search>, limit=<n>.
router.get('/timeline', (req, res) => {
    try {
        const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
        const limit = Math.min(60, Math.max(1, num(req.query.limit) || 25));
        const events = db.getChatTimelineEvents({
            scope: 'global', subjectId: 0,
            before: num(req.query.before), since: num(req.query.since),
            q: req.query.q || null, limit,
        });
        res.json({ events, hasMore: events.length >= limit });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load timeline' });
    }
});

router.get('/user/:id', (req, res) => {
    try {
        const uid = parseInt(req.params.id, 10);
        if (!Number.isFinite(uid)) return res.status(400).json({ error: 'Invalid user id' });
        const user = db.getUserById ? db.getUserById(uid) : null;
        const insight = chatAi.getUserInsight(uid);

        // If this user is a streamer with an AI overview, lead the popover with who they
        // are as a streamer (their overview + recent stream "memories" as context/timeline)
        // before the chat-behavior insight.
        let streamer = null;
        try {
            const ov = db.getStreamerOverview(uid);
            if (ov && (ov.overview || ov.overview_short)) {
                // 8 was hardcoded, and duplicates meant a viewer saw ~4 distinct moments —
                // the "memories don't include everything" complaint. Allow a caller to ask
                // for more, and default high enough to read as a real timeline.
                const memLimit = Math.min(200, Math.max(1, parseInt(req.query.memories, 10) || 40));
                const mems = (db.getStreamMemoriesByUser(uid, memLimit) || []).map(m => ({
                    description: m.description || '',
                    created_at: m.created_at,
                    stream_id: m.stream_id,
                    offset_seconds: m.offset_seconds,
                }));
                streamer = {
                    overview: ov.overview || null,
                    overview_short: ov.overview_short || null,
                    generated_at: ov.generated_at || null,
                    memories: mems,
                };
            }
        } catch { /* streamer context is best-effort */ }

        res.json({
            insight: insight || null,
            streamer,
            user: user ? { id: user.id, username: user.username, display_name: user.display_name } : null,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load user chat insight' });
    }
});

// An anonymous chatter's insight, keyed by their stable anon_id ("anon<N>").
router.get('/anon/:anonId', (req, res) => {
    try {
        const anonId = String(req.params.anonId || '');
        if (!/^anon\d+$/i.test(anonId)) return res.status(400).json({ error: 'Invalid anon id' });
        const insight = chatAi.getAnonInsight(anonId);
        res.json({ insight: insight || null, user: { anon_id: anonId, username: anonId } });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load anon chat insight' });
    }
});

// A bridged external (relay) chatter's insight, keyed by platform + username.
router.get('/relay/:platform/:username', (req, res) => {
    try {
        const ru = db.getRelayUser(req.params.platform, req.params.username);
        if (!ru) return res.json({ insight: null, user: null });
        const insight = chatAi.getRelayUserInsight(ru.id);
        res.json({
            insight: insight || null,
            user: { platform: ru.platform, username: ru.display_name || ru.username, message_count: ru.message_count || 0, first_seen: ru.first_seen || null },
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load relay chat insight' });
    }
});

// A single "whole person" overview fusing who they are as a streamer + as a chatter.
// Non-blocking: returns the cached synthesis if fresh, otherwise returns a quick fallback
// NOW and regenerates the AI synthesis in the background for next time (≤1 cheap LLM call
// per user per day, only when the tab is viewed). Falls back to concatenation with no AI.
const _combinedBusy = new Set();
function _combinedOverview(userId, streamerOv, chatIns) {
    const sOv = (streamerOv && (streamerOv.overview || streamerOv.overview_short)) || '';
    const cOv = (chatIns && (chatIns.overview_alltime || chatIns.overview_24h)) || '';
    if (!sOv && !cOv) return null;
    // Only one side → that's the whole story; no synthesis (and no AI cost) needed.
    if (!sOv || !cOv) return sOv || cOv;

    const key = `ai_whole_overview_${userId}`;
    const srcLen = sOv.length + '|' + cOv.length; // cheap change-detector
    let cachedText = null, fresh = false;
    try {
        const raw = db.getSetting(key);
        if (raw) { const j = JSON.parse(raw); cachedText = j.text ? String(j.text).replace(/^\s*(combined\s+overview|overview)\s*[:\-–]\s*/i, '').trim() : null; fresh = j.src === srcLen && (Date.now() - (j.generated_at || 0) < 24 * 60 * 60 * 1000); }
    } catch { /* rebuild */ }
    if (cachedText && fresh) return cachedText;

    // Regenerate in the background (best-effort) so the request never blocks on the LLM.
    const ai = require('./ai-analysis');
    if (!_combinedBusy.has(userId) && ai.isEnabled && ai.isEnabled() && ai.withinBudget && ai.withinBudget()) {
        _combinedBusy.add(userId);
        const prompt = `You are describing a person on a streaming site by fusing two AI summaries about them into ONE cohesive 2-4 sentence overview of who they are overall — both as a STREAMER and as a CHATTER. Be natural, specific, and not repetitive. Output ONLY the overview prose with no label or prefix.\n\nAS A STREAMER:\n${sOv}\n\nAS A CHATTER:\n${cOv}`;
        Promise.resolve(ai.summarizeText(prompt, 320, 'combined_overview'))
            .then(text => { if (text) { const clean = String(text).replace(/^\s*(combined\s+overview|overview)\s*[:\-–]\s*/i, '').trim(); try { db.setSetting(key, JSON.stringify({ text: clean, generated_at: Date.now(), src: srcLen })); } catch { /* */ } } })
            .catch(() => { })
            .finally(() => _combinedBusy.delete(userId));
    }
    // Return whatever we have now: last synthesis (even if stale) or a simple stitch.
    return cachedText || `${sOv}\n\n${cOv}`;
}

// Background: give sessions SHORT, catchy AI titles (streamers reuse literal stream titles,
// and the raw overview is far too long for a title). Batches untitled sessions into one cheap
// LLM call, stores streams.ai_title, and busts the timeline cache so they appear next load.
const _titlingBusy = new Set();
function _ensureSessionTitles(userId) {
    const ai = require('./ai-analysis');
    if (_titlingBusy.has(userId) || !(ai.isEnabled && ai.isEnabled() && ai.withinBudget && ai.withinBudget())) return;
    const pending = db.getUntitledAiSessions(userId, 20);
    if (!pending.length) return;
    _titlingBusy.add(userId);
    const list = pending.map((p, i) => `${i}. ${String(p.ai_overview_short || p.ai_overview || '').replace(/\s+/g, ' ').slice(0, 200)}`).join('\n');
    const prompt = `Write a SHORT, catchy stream title for each livestream summary below — the way a real streamer titles a VOD: 3 to 6 words, punchy, no surrounding quotes, no trailing period. Match each stream's vibe.\n\n${list}\n\nReturn STRICT JSON only: [{"index": <number>, "title": "<3-6 word title>"}] for every item.`;
    Promise.resolve(ai.summarizeText(prompt, 700, 'session_titles'))
        .then(text => {
            const m = text && text.match(/\[[\s\S]*\]/);
            if (!m) return;
            let touched = 0;
            for (const x of JSON.parse(m[0])) {
                const p = pending[x.index];
                if (p && x.title) { db.setStreamAiTitle(p.id, String(x.title).replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 80)); touched++; }
            }
            if (touched) db.clearAiTimelineCache(userId);
        })
        .catch(() => { })
        .finally(() => _titlingBusy.delete(userId));
}

// Full AI timeline for a streamer's channel page (streamer overview + every session's AI
// overview + memory moments with VOD timestamps). Lazily assembled + cached (15 min TTL),
// so it only rebuilds when the tab is actually opened and the cache is stale — no LLM cost.
router.get('/timeline/:username', (req, res) => {
    try {
        const uname = String(req.params.username || '').trim();
        const user = db.getUserByUsername ? db.getUserByUsername(uname) : null;
        if (!user) return res.status(404).json({ error: 'Channel not found' });

        const timeline = db.getStreamerAiTimeline(user.id); // full, cached
        const allSessions = timeline.sessions || [];
        const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
        const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 12));
        const page = allSessions.slice(offset, offset + limit);

        // On the first page, also ship overview + a lightweight index of EVERY session
        // (no moment bodies) so the client can render a month-jump bar without the payload.
        const first = offset === 0;
        const index = first ? allSessions.map(s => ({
            id: s.id, title: s.title, vod_id: s.vod_id, memory_count: s.memory_count,
            when: s.started_at || s.created_at,
        })) : undefined;

        // First page also carries the CHATTER side (how they behave in chat) + a combined
        // "whole person" overview fusing streamer + chatter. Both are best-effort.
        let chatInsight, combinedOverview;
        if (first) {
            try { chatInsight = chatAi.getUserInsight(user.id) || null; } catch { chatInsight = null; }
            try { combinedOverview = _combinedOverview(user.id, timeline.overview, chatInsight); } catch { combinedOverview = null; }
            try { _ensureSessionTitles(user.id); } catch { /* background titling is best-effort */ }
        }

        res.json({
            username: user.username,
            display_name: user.display_name || user.username,
            overview: first ? timeline.overview : undefined,
            chatInsight,
            combinedOverview,
            sessionCount: timeline.sessionCount,
            momentCount: timeline.momentCount,
            generatedAt: timeline.generatedAt,
            index,
            sessions: page,
            offset, limit,
            hasMore: offset + limit < allSessions.length,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load AI timeline' });
    }
});

// Full audio transcript for a stream (AI Timeline transcript viewer), with a VOD id for links.
/**
 * Batch VOD transcripts, by Media vod id: /api/chat-ai/vod-transcripts?ids=1,2,3
 *
 * Live owns transcripts — they were moved here at the cutover into
 * vod_ai_state.ai_transcript_json (and now stream_timeline_events). Media still has its
 * own vods.ai_transcript column, but nothing writes it any more, which is why
 * openvibe.media/live/:sel/transcript.json served null for every post-cutover VOD.
 * This is the endpoint Media reads instead of its own dead column.
 */
router.get('/vod-transcripts', (req, res) => {
    try {
        const ids = String(req.query.ids || '')
            .split(',').map(x => parseInt(x, 10)).filter(Number.isFinite).slice(0, 50);
        if (!ids.length) return res.json({ transcripts: {} });

        const out = {};
        for (const vodId of ids) {
            let segments = [];
            let events = [];
            // Prefer the timeline: it covers the whole stream and carries sound events.
            try {
                const rows = db.getTimelineByVod(vodId);
                for (const r of rows) {
                    if (r.kind === 'speech') segments.push({ start: r.start_sec, end: r.end_sec, text: r.text });
                    else events.push({ start: r.start_sec, end: r.end_sec, label: r.label, confidence: r.confidence });
                }
            } catch { /* */ }
            // The timeline and the batch-transcribed blob are two views of the same audio
            // and either can be the more complete one, so take whichever actually carries
            // more speech instead of only falling back when the timeline is empty. A
            // partially-linked timeline used to win by default and truncate the result:
            // vod 2163 served 426 characters from 7 linked rows while its blob held the
            // full 3548. Sound events only exist on the timeline, so they are kept either way.
            let blob = [];
            try {
                const st = db.getVodAiState(vodId);
                if (st && st.ai_transcript_json) {
                    const parsed = JSON.parse(st.ai_transcript_json);
                    if (Array.isArray(parsed)) blob = parsed;
                }
            } catch { /* */ }
            const spoken = (arr) => arr.reduce((n, x) => n + String(x.text || '').trim().length, 0);
            if (spoken(blob) > spoken(segments)) segments = blob;
            segments.sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0));
            let overviewShort = null;
            try { overviewShort = (db.getVodAiState(vodId) || {}).ai_overview_short || null; } catch { /* */ }
            // `segments` may be [] for a VOD whose audio had no speech; that is a real
            // answer, not a missing one, so transcript stays null and segments stays [].

            const text = segments.map(s => String(s.text || '').trim()).filter(Boolean).join(' ');
            out[vodId] = {
                transcript: text || null,
                segments,
                events,
                ai_overview_short: overviewShort,
            };
        }
        res.set('Cache-Control', 'public, max-age=15');
        res.json({ transcripts: out });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load transcripts' });
    }
});

router.get('/transcript/:streamId', async (req, res) => {
    try {
        const sid = parseInt(req.params.streamId, 10);
        if (!Number.isFinite(sid)) return res.status(400).json({ error: 'Invalid stream id' });
        const segments = db.getStreamTranscriptSegments(sid) || [];
        let vodId = null;
        try {
            // VODs live in OpenVibe.Media now — resolve the stream's VOD from there.
            const media = require('../media-client');
            const out = await media.listVods({ stream_id: sid, limit: 1 });
            const rows = out?.vods || (Array.isArray(out) ? out : []);
            vodId = rows[0] ? rows[0].id : null;
        } catch { /* */ }
        if (!vodId) {
            try {
                const v = db.get('SELECT id FROM vods WHERE stream_id = ? AND COALESCE(is_recording, 0) = 0 ORDER BY COALESCE(is_public,1) DESC, id DESC LIMIT 1', [sid]);
                vodId = v ? v.id : null; // legacy pre-migration rows
            } catch { /* */ }
        }
        // Sound events ride alongside the speech segments so the transcript view can show
        // "what was heard" as well as "what was said". Empty for streams captured before
        // the timeline existed, which the frontend treats as speech-only.
        let events = [];
        try { events = db.getTimeline(sid, { kind: 'sound', limit: 2000 }) || []; } catch { /* */ }
        let coverageSec = 0;
        try { coverageSec = db.getTimelineCoverage(sid) || 0; } catch { /* */ }
        res.json({ streamId: sid, vodId, segments, events, coverageSec });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load transcript' });
    }
});

module.exports = router;
