'use strict';
/**
 * AI titles for untitled clips (owner, 2026-10-25: "The AI should automatically title clips that are untitled";
 * migrations/0019_clip_ai_title.sql). A clip keeps the title its maker gave it. One still named by a placeholder
 * ("Untitled Clip", "Clip from stream", …: what the Clip buttons send when nobody types a title) is titled from its AI
 * overview once that exists: OpenVibe.AI's live.stream.titles template (3-6 words, what happens), then Live's rule for
 * public AI titles (a rough one is replaced by the stream's title and the moment). The new title goes to OpenVibe.Media, and each
 * clip is decided once (clip_ai_state.title_status: titled, kept or failed).
 *
 *   isPlaceholder(title, sourceTitles) → true for a title nobody chose
 *   titleClips({ ids })   → how many clips were titled: the given ids, else the newest waiting (BATCH a run, one AI call)
 *   soon(clipId)          after a clip's overview is stored (ai-media-analyze, ai-analysis): title it within seconds,
 *                         so the clip's chat announcement (clip-notify) can carry the name
 *   start()               the sweep every SWEEP_MS for the rest (started from server/index.js's normal boot, so never
 *                         under LIVE_DRILL)
 */
const db = require('../db/database');
const media = require('../media-client');
const { containsCoreSlur } = require('openvibe-sdk/front-page');

const BATCH = 20;          // clips titled per run: live.stream.titles takes at most 20 summaries
const LOOK = 40;           // waiting clips looked at per run (one with a person's title is only marked kept)
const SWEEP_MS = 3 * 60 * 1000;
const PLACEHOLDERS = new Set(['', 'untitled', 'untitled clip', 'clip', 'clip from stream', 'new clip', 'my clip', 'a clip']);

const norm = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().toLowerCase().replace(/[.!…]+$/, '');
/** True for a title nobody chose: a Clip button's default, or "Clip: <stream title>" (vods.js defaultClipTitle). */
function isPlaceholder(title, sourceTitles = []) {
    const t = norm(title);
    if (PLACEHOLDERS.has(t)) return true;
    return t.startsWith('clip: ') && ['stream recording', ...sourceTitles.map(norm)].includes(t.slice(6));
}

/** What the template reads about one clip: its overview, a line of what was said, and the stream it came from. */
function summaryOf(state, stream) {
    let said = '';
    try {
        const segs = JSON.parse(state.ai_transcript_json || '[]');
        said = (Array.isArray(segs) ? segs : []).map((s) => String((s && s.text) || '').trim()).filter(Boolean).join(' ');
    } catch { said = ''; }
    const parts = [
        String(state.ai_overview || state.ai_overview_short || '').replace(/\s+/g, ' ').trim().slice(0, 600),
        said ? `Said: "${said.replace(/\s+/g, ' ').slice(0, 220)}"` : '',
        stream && stream.title ? `From the stream "${String(stream.title).replace(/\s+/g, ' ').slice(0, 80)}"${stream.category ? ` (${stream.category})` : ''}.` : '',
    ].filter(Boolean);
    return parts.join(' ').slice(0, 1000);
}

/**
 * The titles a placeholder may name: the stream's, and the video the clip was cut from (a clip of an upload, or of a
 * stream's part, is "Clip: <that video's title>").
 */
async function sourceTitles(clip, stream) {
    const out = [stream && stream.title];
    if (clip.vod_id) {
        try { const v = await media.getVod(clip.vod_id); if (v && v.title) out.push(v.title, String(v.title).replace(/\s*\(part \d+\)\s*$/i, '')); } catch { /* gone */ }
    }
    return out.filter(Boolean);
}

/**
 * Whether the AI may name a clip: nobody chose its title (a placeholder), or it is an auto-clip whose title was a first
 * guess written before the clip existed (a frame caption: "A Person Is Standing In A Living Room, Facing"); the clip's own
 * overview names it better. Each clip is decided once (title_status).
 */
function renamable(clip, sources) {
    return isPlaceholder(clip.title, sources) || !!clip.auto_generated;
}

/**
 * What was said inside a clip's window, for a clip with no overview: the transcript of the video it was cut from (its
 * full pass, else the captions heard live), the lines overlapping the window, and the stream it came from. A clip in a
 * recording's time (time_base 'recording') is read from the part its window starts in.
 */
async function windowSummary(clip, stream) {
    let vodId = clip.vod_id;
    let a = Number(clip.start_time) || 0;
    let b = Number(clip.end_time) || a + (Number(clip.duration_seconds) || 30);
    if (clip.time_base === 'recording' && vodId) {
        try {
            const first = await media.getVod(vodId);
            const parts = (first && first.recording && first.recording.parts) || [];
            const p = parts.find((x) => a * 1000 >= Number(x.start_ms) && a * 1000 < Number(x.start_ms) + Number(x.duration_ms));
            if (p) { vodId = p.vod_id; a -= Number(p.start_ms) / 1000; b -= Number(p.start_ms) / 1000; }
        } catch { /* read as the first part */ }
    }
    let lines = [];
    if (vodId) {
        try {
            const st = await db.getVodAiState(vodId);
            lines = st && st.ai_transcript_json ? JSON.parse(st.ai_transcript_json) : [];
        } catch { lines = []; }
        if (!lines.length) {
            try {
                const history = require('../streaming/stream-history');
                const offset = (await history.vodOffsets([vodId])).get(Number(vodId)) || 0;
                lines = (await db.getTimelineByVod(vodId)).filter((r) => r.kind === 'speech')
                    .map((r) => ({ start: history.vodTime(r.start_sec, offset), end: r.end_sec == null ? null : history.vodTime(r.end_sec, offset), text: r.text }));
            } catch { lines = []; }
        }
    }
    const said = (Array.isArray(lines) ? lines : [])
        .filter((l) => l && String(l.text || '').trim() && Number(l.start) < b && (l.end == null ? Number(l.start) + 5 : Number(l.end)) > a)
        .map((l) => String(l.text).trim()).join(' ').replace(/\s+/g, ' ').slice(0, 400);
    return [
        said ? `Said in the clip: "${said}"` : 'A short moment with nothing said.',
        stream && stream.title ? `From the stream "${String(stream.title).replace(/\s+/g, ' ').slice(0, 80)}"${stream.category ? ` (${stream.category})` : ''}.` : '',
    ].filter(Boolean).join(' ').slice(0, 1000);
}

let running = false;
async function titleClips({ ids = null } = {}) {
    if (running) return 0;
    const ai = require('./ai-analysis');
    if (!(await ai.isEnabled()) || !(await ai.withinBudget())) return 0;
    running = true;
    try {
        // A clip waits for its overview; one whose analysis gave up (failed, or nothing heard) is named from what was said in
        // its window of the recording instead (2026-10-27: clips 494-498 kept "Clip: Seattle" for good).
        const READY = "(btrim(COALESCE(ai_overview, '')) <> '' OR transcript_status IN ('failed', 'empty'))";
        const rows = ids && ids.length
            ? await db.all(`SELECT * FROM clip_ai_state WHERE clip_id = ANY(?) AND title_status IS NULL AND ${READY}`, [ids.map(Number)])
            : await db.all(`SELECT * FROM clip_ai_state WHERE title_status IS NULL AND ${READY} ORDER BY clip_id DESC LIMIT ?`, [LOOK]);
        const todo = [];
        for (const state of rows) {
            if (todo.length >= BATCH) break;
            let clip = null;
            try { clip = await media.getClip(state.clip_id); } catch (err) {
                // Gone or not Live's to see: decided. Media away: asked again on the next sweep.
                if (err && err.status >= 400 && err.status < 500) await db.run("UPDATE clip_ai_state SET title_status = 'failed' WHERE clip_id = ?", [state.clip_id]);
                continue;
            }
            if (!clip) continue;
            const stream = clip.stream_id ? await db.getStreamById(clip.stream_id).catch(() => null) : null;
            const sources = await sourceTitles(clip, stream);
            if (!renamable(clip, sources)) { await db.run("UPDATE clip_ai_state SET title_status = 'kept' WHERE clip_id = ?", [state.clip_id]); continue; }
            const summary = String(state.ai_overview || state.ai_overview_short || '').trim()
                ? summaryOf(state, stream)
                : await windowSummary(clip, stream);
            todo.push({ state, clip, stream, sources, summary });
        }
        if (!todo.length) return 0;
        // The prompt is OpenVibe.AI's versioned template live.stream.titles; Live sends one summary per clip.
        const out = await require('./ai-service').structured('live.stream.titles', { summaries: todo.map((t) => t.summary || '(no summary)') },
            { meter: { kind: 'clip_titles', role: 'legacy', ownerUserId: todo[0].clip.user_id } }).catch(() => null);
        const given = new Map((out && Array.isArray(out.titles) ? out.titles : []).map((x) => [Number(x.index), x.title]));
        const { publicTitle } = require('./ai-moments-job');
        let titled = 0;
        for (const [i, t] of todo.entries()) {
            const raw = given.get(i);
            // No answer for it: leave it waiting for the next sweep, unless the whole call failed for good.
            if (raw == null) { if (out) await db.run("UPDATE clip_ai_state SET title_status = 'failed' WHERE clip_id = ?", [t.clip.id]); continue; }
            const vod = { title: t.stream && t.stream.title, username: t.clip.username || (t.stream && t.stream.username) };
            const at = Number(t.clip.start_time) || 0;
            // Swearing is fine in a title (owner, 2026-10-31: only the home page keeps clean, and it skips such an item).
            // A slur the AI wrote by itself gives way to "<stream title> at mm:ss" (an overview's first clause makes a poor
            // title: "The video centers on…").
            let title = String(publicTitle(raw, vod, at, null) || '').slice(0, 80).trim();
            if (title && containsCoreSlur(title)) title = String(publicTitle('', vod, at, null) || '').slice(0, 80).trim();
            // The maker may have named it while the AI was writing: their title wins.
            let fresh = null;
            try { fresh = await media.getClip(t.clip.id); } catch { fresh = null; }
            if (!title || !fresh || fresh.title !== t.clip.title || !renamable(fresh, t.sources)) {
                await db.run('UPDATE clip_ai_state SET title_status = ? WHERE clip_id = ?', [title ? 'kept' : 'failed', t.clip.id]);
                continue;
            }
            try {
                await media.updateClip(t.clip.id, { title });
                await db.run("UPDATE clip_ai_state SET title_status = 'titled' WHERE clip_id = ?", [t.clip.id]);
                titled++;
                // A chat announcement waiting for the name (clip-notify) goes out on its next sweep.
                await require('../media-proxy/clip-notify').bumpClipNotifyNow(t.clip.id);
            } catch (err) { console.warn(`[AI clip titles] clip ${t.clip.id}: ${err && err.message}`); }
        }
        if (titled) console.log(`[AI clip titles] titled ${titled} clip(s)`);
        return titled;
    } finally {
        running = false;
    }
}

function soon(clipId) {
    setTimeout(() => { titleClips({ ids: [clipId] }).catch(() => {}); }, 2000).unref?.();
}

function start() {
    require('../utils/jobs').every('ai-clip-titles', SWEEP_MS, () => titleClips(), { initialDelayMs: 90_000, jitterMs: 20_000 });
}

module.exports = { isPlaceholder, renamable, sourceTitles, summaryOf, windowSummary, titleClips, soon, start, BATCH };
