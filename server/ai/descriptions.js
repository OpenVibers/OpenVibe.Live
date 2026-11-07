/**
 * descriptions.js — audio-description cues for a VOD or clip (X1, consent plan 2026-10-31, "AI and data").
 *
 * Live already writes what a stream shows (stream_memories: the AI's scene notes at an offset) and what it
 * says (stream_timeline_events: speech rows). A blind or low-vision viewer needs the first told in the
 * silences of the second, so this module turns the two into WebVTT `kind="descriptions"` cues: each scene
 * note becomes a short line placed in a real gap between speech, near the moment it describes.
 *
 * The words are the AI's own, so people are described as written (server/ai/test ai-text-describes-people).
 * The platform line stays: sex acts and pornography are never described (server/ai/explicit.js), and a VOD
 * with any explicit scene note gets no track at all rather than a track that talks around it.
 *
 * Times are the video's own. A stream can be recorded in parts, so the callers move rows with
 * media-proxy/vod-time.js before asking for cues.
 */
'use strict';

const db = require('../db/database');
const { isExplicit } = require('./explicit');

// A description cue is read aloud at roughly this many characters a second; 2 s is the shortest cue that can
// be heard, 8 s the longest that still feels like a description rather than a monologue.
const CHARS_PER_SEC = 13;
const MIN_CUE_SEC = 2;
const MAX_CUE_SEC = 8;
const GAP_PAD_SEC = 0.35;      // air either side of speech, so a cue never starts on the last syllable
const MAX_SHIFT_SEC = 20;      // a note waits for the next real silence, but not across the whole video

/** JSON-wrapped model text and stray markup become one plain line of cue text. */
function plainText(value) {
    let text = String(value == null ? '' : value).trim();
    if (text.startsWith('{')) {
        try {
            const o = JSON.parse(text);
            text = String((o && (o.description || o.text || o.caption)) || text);
        } catch { /* not JSON, keep it */ }
    }
    text = db.publicMemoryText(text)
        .replace(/<[^>]*>/g, ' ')
        .replace(/-->/g, '→')
        .replace(/\s+/g, ' ')
        .trim();
    return text;
}

/** The speech spans, merged where they touch so a breath between two phrases is not treated as a gap. */
function speechSpans(rows) {
    const out = [];
    for (const r of (Array.isArray(rows) ? rows : [])) {
        const start = Math.max(0, Number(r.start) || 0);
        const end = Math.max(start + 0.2, Number(r.end == null ? r.end_sec : r.end) || start + 2);
        const last = out[out.length - 1];
        if (last && start <= last.end + 0.5) last.end = Math.max(last.end, end);
        else out.push({ start, end });
    }
    return out.sort((a, b) => a.start - b.start);
}

/**
 * The gap where a cue of `length` seconds fits without touching speech, closest to `at`.
 * Gaps are between speech spans (with GAP_PAD either side); a note that falls inside speech waits
 * for the next gap, and if there is none near it the caller drops the cue rather than speak over
 * the person.
 */
function gapStart(at, length, spans, duration, minStart = 0) {
    const gaps = [];
    let cursor = Math.max(0, Number(minStart) || 0);
    for (const s of (spans || [])) {
        const end = Math.max(cursor, s.start - GAP_PAD_SEC);
        if (end - cursor >= length) gaps.push({ start: cursor, end });
        cursor = Math.max(cursor, s.end + GAP_PAD_SEC);
    }
    if (duration - cursor >= length) gaps.push({ start: cursor, end: duration });
    const note = Math.max(0, Number(at) || 0);
    const place = (g) => Math.min(g.end - length, Math.max(g.start, note));
    // Prefer a gap at or after the note (a scene is described as it appears, or just after), and only
    // fall back to the last silence before it when nothing later can hold the line.
    let best = null, bestD = Infinity;
    for (const g of gaps) {
        if (g.end <= note + 0.01) continue;
        const start = place(g);
        const d = Math.abs(start - note);
        if (d < bestD) { bestD = d; best = start; }
    }
    if (best == null) {
        for (const g of gaps) {
            if (g.start >= note) continue;
            const start = place(g);
            const d = Math.abs(start - note);
            if (d < bestD) { bestD = d; best = start; }
        }
    }
    return best == null ? null : Math.round(best * 1000) / 1000;
}

/**
 * Cues from scene notes and speech rows (both already in the video's time).
 * notes: [{ at, text }] ; speech: [{ start, end }] ; duration: seconds.
 * Returns [{ start, end, text }] in time order, never overlapping and never on top of speech.
 */
function cueList(notes, speech, duration) {
    const total = Number(duration) || 0;
    if (!(total > 0)) return [];
    const spans = speechSpans(speech);
    const seen = new Set();
    const picked = [];
    const ordered = (Array.isArray(notes) ? notes : [])
        .map((n) => ({ at: Math.max(0, Number(n && n.at) || 0), text: plainText(n && n.text) }))
        .filter((n) => n.text && !isExplicit(n.text))
        .sort((a, b) => a.at - b.at);
    // Any explicit scene note: no track for this video. A sex act is never described or talked around.
    if ((Array.isArray(notes) ? notes : []).some((n) => isExplicit(plainText(n && n.text)))) return [];

    let lastEnd = 0;
    for (const note of ordered) {
        if (picked.length >= 120) break;
        const key = note.text.toLowerCase();
        if (seen.has(key)) continue;
        const length = Math.min(MAX_CUE_SEC, Math.max(MIN_CUE_SEC, note.text.length / CHARS_PER_SEC));
        const near = Math.min(total - 0.05, note.at);
        // Search at the note, then keep moving to the next silence inside the window around it.
        for (let attempt = 0; attempt < 3; attempt++) {
            const candidate = attempt === 0 ? near : near + attempt * MAX_SHIFT_SEC / 3;
            const start = gapStart(candidate, length, spans, total, lastEnd + (picked.length ? 0.2 : 0));
            if (start == null || Math.abs(start - near) > MAX_SHIFT_SEC) break;
            const end = Math.min(total - 0.05, start + length);
            if (end - start < MIN_CUE_SEC - 0.05) break;
            picked.push({ start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000, text: note.text });
            seen.add(key);
            lastEnd = end;
            break;
        }
    }
    return picked;
}

/** WebVTT timestamp: HH:MM:SS.mmm. */
function timestamp(sec) {
    const s = Math.max(0, Number(sec) || 0);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), whole = Math.floor(s % 60);
    const ms = Math.round((s - Math.floor(s)) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/** The WebVTT file, or '' when there is nothing to describe. */
function buildVtt(cues) {
    const list = Array.isArray(cues) ? cues : [];
    if (!list.length) return '';
    const lines = [
        'WEBVTT',
        '',
        'NOTE AI scene descriptions (audio description). People are described; sex acts never are.',
        '',
    ];
    for (const cue of list) {
        if (!cue || !cue.text) continue;
        lines.push(`${timestamp(cue.start)} --> ${timestamp(cue.end)}`, cue.text, '');
    }
    return lines.join('\n');
}

/** The VOD's rows in its own time: speech from its linked timeline (or the stream's), scene notes from the stream. */
async function vodVtt(vod) {
    if (!vod || vod.stream_id == null) return '';
    const streamId = Number(vod.stream_id);
    // The linked timeline and the stream's own are two views of the same audio and either can be the more
    // complete (late-transcribed spool rows land after the vod.ready link). Take the one with more speech,
    // exactly as the transcript endpoint does, so a description never talks over a line only one view knows.
    let linked = [], streamRows = [];
    try { linked = await db.getTimelineByVod(vod.id) || []; } catch { linked = []; }
    try { streamRows = await db.getTimeline(streamId, { limit: 20000 }) || []; } catch { streamRows = []; }
    const spoken = (list) => list.reduce((n, r) => n + (r.kind === 'speech' ? String(r.text || '').trim().length : 0), 0);
    const rows = spoken(linked) >= spoken(streamRows) && linked.length ? linked : streamRows;
    let memories = [];
    try { memories = await db.getStreamMemories(streamId) || []; } catch { memories = []; }
    const duration = Number(vod.duration_seconds || vod.duration) || (rows.concat(memories.map((m) => ({ start_sec: m.offset_seconds }))).reduce((max, r) => Math.max(max, Number(r.start_sec || r.offset_seconds) || 0), 0) + 10);
    if (!memories.length || !(duration > 0)) return '';
    const { inVodTime } = require('../media-proxy/vod-time');
    let shiftedRows = rows;
    let shiftedNotes = memories;
    try {
        shiftedRows = await inVodTime(vod, rows, 'start_sec', { round: false });
        shiftedNotes = await inVodTime(vod, memories.map((m) => ({ ...m, at: Number(m.offset_seconds) || 0 })), 'at', { round: false });
    } catch { /* a broken part lookup: keep stream time rather than lose the track */ }
    const speech = shiftedRows.filter((r) => r.kind === 'speech').map((r) => ({ start: r.start_sec, end: r.end_sec }));
    const notes = shiftedNotes.filter((m) => Number(m.offset_seconds) >= 0).map((m) => ({ at: m.at != null ? m.at : m.offset_seconds, text: m.description }));
    return buildVtt(cueList(notes, speech, duration));
}

/** A clip's window of its source stream, in the clip's own time. */
async function clipVtt(clip) {
    if (!clip || clip.stream_id == null) return '';
    const start = Math.max(0, Number(clip.start_time) || 0);
    const end = Number(clip.end_time) || (start + (Number(clip.duration_seconds) || 0));
    const duration = Number(clip.duration_seconds) || Math.max(0, end - start);
    if (!(duration > 0)) return '';
    let rows = [];
    let memories = [];
    try { rows = await db.getTimeline(Number(clip.stream_id), { limit: 20000 }) || []; } catch { rows = []; }
    try { memories = await db.getStreamMemories(Number(clip.stream_id)) || []; } catch { memories = []; }
    if (!memories.length) return '';
    const speech = rows
        .filter((r) => r.kind === 'speech' && Number(r.start_sec) <= end + 1 && Number(r.end_sec == null ? r.start_sec : r.end_sec) >= start - 1)
        .map((r) => ({ start: Math.max(0, Number(r.start_sec) - start), end: Math.max(0, Number(r.end_sec == null ? r.start_sec + 2 : r.end_sec) - start) }));
    const notes = memories
        .filter((m) => Number(m.offset_seconds) >= start - 1 && Number(m.offset_seconds) <= end + 1)
        .map((m) => ({ at: Math.max(0, Number(m.offset_seconds) - start), text: m.description }));
    return buildVtt(cueList(notes, speech, duration));
}

module.exports = { cueList, buildVtt, vodVtt, clipVtt, plainText, gapStart, timestamp };
