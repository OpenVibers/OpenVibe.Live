/**
 * OpenVibe.Live — Arena backfill: judge what was ALREADY said on mic.
 *
 * The listener only hears streams that are live right now. Everything a fighter said before
 * (the transcripts already in stream_timeline_events) is judged here, so the Arena reflects
 * the shit talk on record the moment it ships, not weeks later:
 *
 *   1. every roster fighter's speech from the last DAYS days is read in stream order and cut
 *      into ~60 s chunks (JUDGE_MIN_WORDS … CHUNK_MAX_WORDS, a gap > CHUNK_GAP_SEC starts a
 *      new chunk);
 *   2. a chunk is only sent to a model if it looks like it could be shit talk (the SPICY
 *      keyword pre-filter) or names another fighter — gameplay narration never costs a call;
 *   3. a name-drop chunk goes to the beef judge (no clocks / no beefs are opened for old
 *      speech — it lands as a `callout` moment with the target attached); everything else
 *      goes to the mic judge → `trash` moment. Both pay Trash Level XP.
 *
 * A per-fighter cursor (site setting `arena_backfill_cursor_<userId>` = last timeline row id
 * judged) makes every run incremental, so this also catches up anything the live listener
 * missed. Bounded per run (MAX_CALLS_PER_RUN model calls) so a big backlog drains over a few
 * runs instead of burning the budget at once.
 */
'use strict';

const db = require('../db/database');

const DAYS = 7;
const CHUNK_GAP_SEC = 25;
const CHUNK_MAX_WORDS = 110;
const MAX_CALLS_PER_RUN = 160;
const MAX_CHUNKS_PER_FIGHTER = 80;

function arena() { return require('./arena-service'); }
function listener() { return require('./listener'); }
function mic() { return require('./mic'); }
function words(t) { return String(t || '').split(/\s+/).filter(Boolean).length; }
function cursorKey(uid) { return `arena_backfill_cursor_${uid}`; }
function getCursor(uid) { const v = parseInt(db.getSetting(cursorKey(uid)), 10); return Number.isFinite(v) ? v : 0; }
function setCursor(uid, id) { try { db.setSetting(cursorKey(uid), String(id)); } catch { /* */ } }
function sqlToIso(ts) { return ts ? String(ts).replace(' ', 'T') + (String(ts).endsWith('Z') ? '' : 'Z') : null; }

/** Cut a fighter's speech rows into judge-sized chunks. */
function chunk(rows) {
    const out = [];
    let cur = null;
    for (const r of rows) {
        const w = words(r.text);
        if (!w) continue;
        const gap = cur && (r.stream_id !== cur.stream_id || r.start_sec - cur.end > CHUNK_GAP_SEC);
        if (!cur || gap || cur.words + w > CHUNK_MAX_WORDS) {
            if (cur && cur.words >= listener().JUDGE_MIN_WORDS) out.push(cur);
            cur = { stream_id: r.stream_id, vod_id: r.vod_id, started_at: r.started_at, start: r.start_sec, end: r.end_sec || r.start_sec + 3, lines: [], words: 0, lastId: r.id };
        }
        cur.lines.push({ t: String(r.text), s: Math.floor(r.start_sec), v: r.vod_id || null, id: r.id });
        cur.words += w; cur.end = r.end_sec || r.start_sec + 3; cur.lastId = r.id;
    }
    if (cur && cur.words >= listener().JUDGE_MIN_WORDS) out.push(cur);
    return out;
}

function saidAtFor(c, sec) {
    const base = c.started_at ? Date.parse(sqlToIso(c.started_at)) : NaN;
    if (!Number.isFinite(base)) return null;
    return new Date(base + Math.max(0, sec || 0) * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

async function backfillFighter(uid, roster, budget) {
    const L = listener();
    const since = `-${DAYS} days`;
    const rows = db.all(`SELECT e.id, e.stream_id, e.vod_id, e.start_sec, e.end_sec, e.text, s.started_at
                         FROM stream_timeline_events e LEFT JOIN streams s ON s.id = e.stream_id
                         WHERE e.user_id = ? AND e.kind = 'speech' AND e.id > ? AND e.created_at >= datetime('now', ?)
                           AND NOT EXISTS (SELECT 1 FROM streams l WHERE l.id = e.stream_id AND l.is_live = 1)
                         ORDER BY e.stream_id, e.start_sec LIMIT 4000`, [uid, getCursor(uid), since]);
    if (!rows.length) return { judged: 0, moments: 0, skipped: 0 };
    const chunks = chunk(rows).slice(0, MAX_CHUNKS_PER_FIGHTER);
    let judged = 0, moments = 0, skipped = 0, lastId = getCursor(uid);
    for (const c of chunks) {
        if (budget.calls >= MAX_CALLS_PER_RUN) break;
        const text = c.lines.map(l => l.t).join(' ').replace(/\s+/g, ' ').slice(-1400);
        const mentions = L._mentionsDetailed(text, uid, roster);
        const spicy = L.SPICY.test(text.toLowerCase());
        lastId = Math.max(lastId, c.lastId);
        if (!mentions.length && !spicy) { skipped++; continue; }
        budget.calls++; judged++;
        const ref = (bestLine) => { const needle = String(bestLine || '').toLowerCase().slice(0, 30); const hit = (needle && c.lines.find(l => l.t.toLowerCase().includes(needle))) || c.lines[0]; return { vod_id: hit ? hit.v : null, sec: hit ? Math.max(0, hit.s - 2) : null }; };
        try {
            if (mentions.length) {
                const m = mentions[0];
                const j = await L._judgeBeef(uid, m.userId, text, roster, { context: null, named: true, how: m.how });
                if (j.aimed_at_target && j.quality >= (m.how === 'exact' ? 3 : 5)) {
                    const r = ref(j.best_line);
                    if (mic().addMoment({ userId: uid, streamId: c.stream_id, vodId: r.vod_id, sec: r.sec, kind: 'callout', targetUserId: m.userId, aimedAt: mic().nameOf(m.userId), text: j.best_line || text.slice(0, 220), about: j.about, quality: j.quality, announcer: j.announcer, saidAt: saidAtFor(c, r.sec) })) moments++;
                    continue;
                }
                if (j.about_target) continue;   // neutral mention — not shit talk, and not free talk either
            }
            const j = await L._judgeMic(uid, text);
            if (j.is_trash_talk && j.quality >= L.MIC_MIN_QUALITY) {
                const r = ref(j.best_line);
                const target = j.aimed_at ? L._mentionsDetailed(j.aimed_at, uid, roster)[0] : null;
                if (mic().addMoment({ userId: uid, streamId: c.stream_id, vodId: r.vod_id, sec: r.sec, kind: target ? 'callout' : 'trash', targetUserId: target ? target.userId : null, aimedAt: target ? mic().nameOf(target.userId) : (j.aimed_at || null), text: j.best_line || text.slice(0, 220), about: j.about, quality: j.quality, announcer: j.announcer, saidAt: saidAtFor(c, r.sec) })) moments++;
            }
        } catch (e) { console.warn(`[Arena] backfill judge (user ${uid}):`, e.message); }
    }
    setCursor(uid, lastId);
    return { judged, moments, skipped, chunks: chunks.length };
}

let _busy = false;
/** Judge un-judged past speech for every roster fighter. Bounded; safe to call often. */
async function run({ force = false } = {}) {
    if (_busy) return { busy: true };
    if (!arena().arenaEnabled()) return { disabled: true };
    _busy = true;
    const started = Date.now();
    const budget = { calls: 0 };
    const out = { fighters: 0, judged: 0, moments: 0, skipped: 0, calls: 0 };
    try {
        const roster = arena().loadRoster(force);
        for (const uid of roster.order) {
            if (budget.calls >= MAX_CALLS_PER_RUN) break;
            const r = await backfillFighter(uid, roster, budget);
            out.fighters++; out.judged += r.judged; out.moments += r.moments; out.skipped += r.skipped;
        }
        out.calls = budget.calls;
        if (out.judged || out.moments) console.log(`[Arena] backfill: ${out.moments} moment(s) from ${out.judged} judged chunk(s) across ${out.fighters} fighter(s) (${out.skipped} skipped as not spicy, ${Math.round((Date.now() - started) / 1000)} s)`);
        if (out.moments) { try { arena().loadRoster(true); } catch { /* */ } }
        return out;
    } finally { _busy = false; }
}

module.exports = { run, chunk, DAYS, MAX_CALLS_PER_RUN, _backfillFighter: backfillFighter };
