'use strict';

/**
 * Where an automatic clip starts and ends. The cutter used a fixed 16 s before and 9 s after the moment, so clips began
 * and ended mid-sentence and often lost the setup that made the payoff land. Speech rows on the timeline are already
 * sentences (server/ai/transcribe.js ends a row at . ? !, a 1.5 s pause or 20 s), so a clip that starts where a row
 * starts and ends where a row ends starts and ends on a sentence.
 *
 *   trim({ moment, segments: [{ start, end, text }], pre, post, min, max, maxLead, maxTail, limit })
 *     → { start, end, snapped }
 *
 * - start: the start of the row being spoken at (moment - pre), or, if that second is silent, of the first row after it
 *   and before the moment; a row that began more than maxLead before the moment
 *   (a long monologue) is not followed back — the fixed start is kept.
 * - end: the end of the row being spoken at (moment + post), within maxTail after the moment and before `limit` (the
 *   flushed edge of a live recording).
 * - Without speech near the moment, or with rows that would make the clip shorter than `min` or longer than `max`,
 *   the fixed window stands (clamped), so trimming never makes a clip worse than before.
 * All times are in one clock (the caller converts between stream and recording time). Pure.
 */

const DEFAULTS = Object.freeze({ pre: 16, post: 9, min: 12, max: 45, maxLead: 25, maxTail: 20 });

function rowEnd(rows, i) {
    const r = rows[i];
    if (r.end != null && Number.isFinite(Number(r.end))) return Number(r.end);
    const next = rows[i + 1];
    return next ? Number(next.start) : Number(r.start) + 6;   // no end recorded: until the next row, or a short sentence
}

function trim({ moment, segments = [], limit = Infinity, ...o } = {}) {
    const k = { ...DEFAULTS, ...o };
    const m = Number(moment);
    const fixedStart = Math.max(0, m - k.pre);
    const fixedEnd = Math.min(m + k.post, limit);
    const fixed = { start: fixedStart, end: fixedEnd, snapped: false };
    if (!Number.isFinite(m)) return fixed;
    const rows = (segments || [])
        .filter((r) => r && Number.isFinite(Number(r.start)) && String(r.text || '').trim())
        .map((r) => ({ start: Number(r.start), end: r.end, text: r.text }))
        .sort((a, b) => a.start - b.start);
    if (!rows.length) return fixed;
    const at = (t) => { let idx = -1; for (let i = 0; i < rows.length; i++) { if (rows[i].start <= t && rowEnd(rows, i) > t) idx = i; } return idx; };

    let start = fixedStart, end = fixedEnd, snapped = false;
    const si = at(fixedStart);
    if (si >= 0 && rows[si].start >= m - k.maxLead) { start = Math.max(0, rows[si].start); snapped = true; }
    else if (si < 0) {
        // The fixed start is in silence: begin at the first sentence that starts between it and the moment.
        const next = rows.find((r) => r.start > fixedStart && r.start < m);
        if (next) { start = next.start; snapped = true; }
    }
    const ei = at(Math.min(m + k.post, limit - 0.01));
    if (ei >= 0) {
        const e = Math.min(rowEnd(rows, ei), limit);
        if (e <= m + k.maxTail && e > start) { end = e; snapped = true; }
    }
    const len = end - start;
    if (len < k.min || len > k.max) return fixed;
    return { start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100, snapped };
}

module.exports = { trim, DEFAULTS };
