/**
 * AI auto-clip job.
 *
 *  LIVE  — every ~90s, for each live stream, look at the last chunk of time and detect a
 *          clear "everyone reacted" chat spike; if AI agrees it's genuinely clip-worthy, cut a
 *          clip from the stream's growing recording around that moment. Selective + capped
 *          (max/hour + min spacing) so it only grabs real standouts.
 *  VOD   — clipVodMoment(): cut a clip around a moment the AI-moments pipeline already picked
 *          for a finished VOD (reuses the same detection brain).
 *
 * Clip cutting now happens in OpenVibe.Media (media-client.createClip on the recording's
 * vod id); the caps/dedup bookkeeping lives in a local site_settings log because the
 * legacy clips table is frozen for migration.
 *
 * Fuses chat velocity + AI scene notes + audio transcript, and degrades gracefully when AI is
 * off (a much stronger chat spike is then required).
 */
const db = require('../db/database');
const ai = require('./ai-analysis');
const media = require('../media-client');
const recorder = require('../streaming/recorder');

// ── Tunables ────────────────────────────────────────────────
const CHECK_INTERVAL_MS = 90 * 1000;
const MAX_PER_HOUR = 3;
const MIN_SPACING_MIN = 12;
const WINDOW_SEC = 150;      // chunk of time considered each check
const BUCKET_SEC = 15;
const SPIKE_MIN_MSGS = 6;    // a spike bucket must have at least this many messages
const SPIKE_MULT = 2.5;      // …and be this many× the window average
const SPIKE_MULT_NOAI = 4;   // stricter when we can't get AI agreement
const CLIP_PRE = 16, CLIP_POST = 9;   // seconds cut before/after the moment

const CLIP_LOG_SETTING = 'auto_clip_log';   // rolling log of auto-clips (caps + dedup)

let _timer = null;
let _busy = false;

function _aiOn() { return !!(ai.isEnabled && ai.isEnabled() && ai.withinBudget && ai.withinBudget()); }
function _clean(t, n) { return String(t || '').replace(/\s+/g, ' ').trim().slice(0, n || 300); }

// ── Auto-clip log (replaces the old clips-table queries) ────
function _clipLog() {
    try { const l = JSON.parse(db.getSetting(CLIP_LOG_SETTING) || '[]'); return Array.isArray(l) ? l : []; }
    catch { return []; }
}
function _logClip(entry) {
    try {
        const log = _clipLog();
        log.unshift({ ...entry, ts: Date.now() });
        db.setSetting(CLIP_LOG_SETTING, JSON.stringify(log.slice(0, 300)));
    } catch { /* */ }
}
function _countClipsSince(streamId, minutes) {
    const cutoff = Date.now() - minutes * 60_000;
    return _clipLog().filter(e => e.stream_id === streamId && e.ts >= cutoff).length;
}

// AI confirmation for a live spike: given what was on screen / said / typed, is this a real
// clip-worthy moment? Returns { clip, title, desc } (clip=false → skip).
async function _confirmLiveMoment(stream) {
    const memories = (db.getStreamMemories(stream.id) || []).filter(m => m.description).slice(-5);
    const transcript = (db.getStreamTranscriptSegments(stream.id) || []).slice(-14);
    const chat = db.getRecentChatText(stream.id, WINDOW_SEC, 40) || [];
    const scene = memories.map(m => `- ${_clean(m.description, 160)}`).join('\n');
    // Timestamps are now used, not discarded: recent speech is anchored in time so the
    // model can line up what was said with the sounds and the chat spike.
    const _mmss = (n) => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
    const script = transcript.map(s => `- [${_mmss(s.start || 0)}] ${_clean(s.text, 140)}`).join('\n');
    // Sound events are a strong clip signal on their own — a burst of gunfire, an
    // explosion or laughter is exactly the kind of thing viewers clip, and it is often
    // the reason chat spiked in the first place.
    let sounds = [];
    try {
        const since = Math.max(0, ((Date.now() - new Date(stream.started_at + 'Z').getTime()) / 1000) - WINDOW_SEC);
        sounds = (db.getTimeline(stream.id, { kind: 'sound', from: since, limit: 40 }) || [])
            .filter(e => Number(e.confidence || 0) >= 0.4).slice(-12);
    } catch { /* timeline optional */ }
    const soundBlock = sounds.map(e => `- [${_mmss(e.start_sec || 0)}] ${e.label} (${Number(e.confidence || 0).toFixed(2)})`).join('\n');
    const chatBlock = chat.slice(-30).map(c => `- ${_clean(c, 100)}`).join('\n');
    if (!_aiOn()) return { clip: null }; // caller decides via the stricter no-AI threshold

    const prompt = `A live stream just had a spike in chat activity — viewers reacted to something. Decide if this is a genuinely clip-worthy standout moment (funny, dramatic, surprising, hype) worth auto-clipping, or just routine chatter.

ON SCREEN (recent scene notes):
${scene || '(none)'}

WHAT WAS SAID (recent transcript):
${script || '(none)'}

WHAT WAS HEARD (non-speech sounds detected):
${soundBlock || '(none)'}

CHAT (recent messages):
${chatBlock || '(none)'}

Return STRICT JSON only: {"clip": true|false, "title": "<specific punchy 3-8 word title>", "desc": "<one vivid sentence>"}. Set clip=false if nothing genuinely notable is happening.`;
    try {
        const text = await ai.summarizeText(prompt, 220, 'auto_clip_confirm');
        const m = text && text.match(/\{[\s\S]*\}/);
        if (!m) return { clip: false };
        const j = JSON.parse(m[0]);
        return { clip: j.clip === true, title: _clean(j.title, 80), desc: _clean(j.desc, 400) };
    } catch { return { clip: false }; }
}

async function _checkLiveStream(stream) {
    const streamId = stream.id;
    try {
        if (db.isStreamClipRecordingEnabled && !db.isStreamClipRecordingEnabled(stream)) return;
        // Hourly cap + min spacing.
        if (_countClipsSince(streamId, 60) >= MAX_PER_HOUR) return;
        if (_countClipsSince(streamId, MIN_SPACING_MIN) > 0) return;

        // The stream's active Media-side recording is the clip source.
        const rec = recorder.getActiveRecording(streamId);
        if (!rec || !rec.vodId) return;

        // Detect a clear chat spike in the recent chunk.
        const buckets = db.getLiveChatBuckets(streamId, WINDOW_SEC, BUCKET_SEC);
        if (buckets.length < 3) return;
        const counts = buckets.map(b => b.count);
        const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
        const peak = buckets.reduce((mx, b) => (b.count > mx.count ? b : mx), buckets[0]);
        if (peak.count < SPIKE_MIN_MSGS) return;

        // AI agreement (or a much stronger spike when AI is unavailable).
        const verdict = await _confirmLiveMoment(stream);
        if (verdict.clip === true) {
            if (peak.count < Math.max(SPIKE_MIN_MSGS, SPIKE_MULT * avg)) return;
        } else if (verdict.clip === null) { // AI off → stricter chat-only gate
            if (peak.count < Math.max(SPIKE_MIN_MSGS, SPIKE_MULT_NOAI * avg)) return;
        } else {
            return; // AI said not clip-worthy
        }

        // Locate the spike in recording time: how long ago it happened vs the live edge.
        const nowEpoch = Math.floor(Date.now() / 1000);
        const secondsAgo = Math.max(0, nowEpoch - (peak.tsEpoch || nowEpoch));
        const recEdge = Math.max(0, (Date.now() - rec.startedAt) / 1000);
        const momentOffset = Math.max(1, recEdge - secondsAgo);
        const start = Math.max(0, momentOffset - CLIP_PRE);
        const end = Math.min(momentOffset + CLIP_POST, Math.max(0, recEdge - 0.5));
        if (end - start < 5) return; // not enough flushed footage around the moment yet

        const title = verdict.title || 'Chat-Hyped Moment';
        const clip = await media.createClip({
            vod_id: rec.vodId, start_s: start, end_s: end,
            title, user_id: stream.user_id,
            stream_id: streamId, auto_generated: true, description: verdict.desc || '',
        }).catch((e) => { console.warn(`[AutoClip] Media createClip failed for stream ${streamId}:`, e.message); return null; });
        if (clip) {
            _logClip({ stream_id: streamId, vod_id: rec.vodId, start_time: start, title, clip_id: clip.id, sig: _sceneSig(verdict.desc || title) });
            console.log(`[AutoClip] LIVE clip for stream ${streamId} @${Math.round(momentOffset)}s ("${title}") — spike ${peak.count} msgs`);
        }
    } catch (e) {
        console.warn(`[AutoClip] live check failed for stream ${streamId}:`, e.message);
    }
}

async function _tick() {
    if (_busy) return;
    _busy = true;
    try {
        let streams = [];
        try { streams = db.getLiveStreams() || []; } catch { /* */ }
        for (const s of streams) { await _checkLiveStream(s); } // serial → bounded Media load
    } finally { _busy = false; }
}

// ── Historical VOD backfill: a few auto-clips per day (daily-gated, like the moments/paste
// jobs). Processes the most-watched un-clipped VODs first; idempotent (skips VODs that already
// have an auto-clip), so it steadily works through the back catalogue over days. ─────────────
const BACKFILL_SETTING = 'auto_clip_backfill';
const BACKFILL_PER_RUN = 3;                       // a few historical clips…
const BACKFILL_INTERVAL_MS = 6 * 60 * 60 * 1000;  // …every 6h (guarantees ≥1 clip / 6h)

function _backfillDue() {
    try { const p = JSON.parse(db.getSetting(BACKFILL_SETTING) || '{}'); return !p.updated_at || (Date.now() - p.updated_at) >= BACKFILL_INTERVAL_MS; }
    catch { return true; }
}
// Historical-backfill candidate pool: most-viewed public VODs from OpenVibe.Media
// that have stream memories and no auto-clip in the local log yet (shaped like the
// old getVodsWithoutAutoClip rows). Falls back to legacy local rows if Media is down.
async function _backfillPool(limit) {
    try {
        const r = await media.listVods({ limit: limit * 2, order: 'views' });
        const rows = r?.vods || (Array.isArray(r) ? r : []);
        if (rows.length) {
            const clipped = new Set();
            for (const c of _clipLog()) { if (c.vod_id) clipped.add(c.vod_id); if (c.stream_id) clipped.add(`s${c.stream_id}`); }
            return rows
                .filter(v => v.stream_id && !clipped.has(v.id) && !clipped.has(`s${v.stream_id}`))
                .filter(v => {
                    try { return (db.get('SELECT COUNT(*) AS c FROM stream_memories WHERE stream_id = ?', [v.stream_id])?.c || 0) > 0; }
                    catch { return false; }
                })
                .slice(0, limit)
                .map(v => ({
                    vod_id: v.id, stream_id: v.stream_id, user_id: v.user_id, username: v.username,
                    title: v.title || '',
                    ai_overview: (db.getVodAiState && db.getVodAiState(v.id)?.ai_overview_short) || '',
                    ai_overview_short: (db.getVodAiState && db.getVodAiState(v.id)?.ai_overview_short) || '',
                    duration: Number(v.duration_seconds ?? v.duration) || 0,
                    view_count: Number(v.view_count) || 0,
                }));
        }
    } catch { /* fall through */ }
    try { return db.getVodsWithoutAutoClip ? (db.getVodsWithoutAutoClip(limit) || []) : []; } catch { return []; }
}

// ffmpeg-consumable source for a VOD: legacy local file if still present, else the
// Media playback URL (ffmpeg range-reads it — no full download).
async function _resolveVodSource(vodId) {
    try {
        const vod = db.getVodById ? db.getVodById(vodId) : null;
        if (vod && vod.file_path && require('node:fs').existsSync(vod.file_path)) return vod.file_path;
    } catch { /* */ }
    try {
        const meta = await media.getVod(vodId);
        if (meta && meta.playback_url) return media.publicUrl(meta.playback_url);
    } catch { /* */ }
    return media.vodPlaybackUrl(vodId);
}

// Cut auto-clips for up to `limit` historical VODs that don't have one yet. Keeps a `skip`
// list of VODs we couldn't clip (media pruned / cut failed) so dead VODs don't block progress
// or waste an AI call on every run.
async function backfillVodClips({ limit = BACKFILL_PER_RUN, force = false } = {}) {
    if (!force && !_backfillDue()) return 0;
    let prev = {};
    try { prev = JSON.parse(db.getSetting(BACKFILL_SETTING) || '{}') || {}; } catch { /* */ }
    const skip = new Set(prev.skip || []);
    const moments = require('./ai-moments-job');
    // Over-fetch so skipped/dead VODs don't starve a batch.
    const pool = (await _backfillPool(Math.max(1, limit) * 6)).filter(v => !skip.has(v.vod_id));
    let made = 0;
    const newSkip = [];
    for (const v of pool) {
        if (made >= limit) break;
        try {
            const source = await _resolveVodSource(v.vod_id);
            if (!source) { newSkip.push(v.vod_id); continue; } // media gone / unreadable
            const moment = await moments.findBestMoment(v);
            if (!moment) { newSkip.push(v.vod_id); continue; }
            // Pixel backstop: don't clip a black/empty frame.
            try {
                const thumbs = require('../media-proxy/live-thumbs');
                const probe = require('node:path').join(require('node:os').tmpdir(), `autoclip-probe-${v.vod_id}-${Math.floor(moment.offset)}.jpg`);
                if (await thumbs.extractFrameToFile(source, moment.offset, probe)) {
                    const dark = moments.frameTooDark ? await moments.frameTooDark(probe) : false;
                    try { require('node:fs').unlinkSync(probe); } catch { /* */ }
                    if (dark) { console.log(`[AutoClip] backfill skip VOD ${v.vod_id} — dark/empty frame`); newSkip.push(v.vod_id); continue; }
                }
            } catch { /* probe optional */ }
            const clip = await clipVodMoment({ vod: v, offset: moment.offset, title: moment.title, desc: moment.desc, source });
            if (clip) { made++; console.log(`[AutoClip] Backfilled VOD ${v.vod_id} ("${String(moment.title || '').slice(0, 60)}")`); }
            else newSkip.push(v.vod_id); // cut failed (e.g. unseekable/short) — don't retry forever
        } catch (e) { newSkip.push(v.vod_id); console.warn(`[AutoClip] backfill VOD ${v.vod_id} failed:`, e.message); }
    }
    const mergedSkip = [...new Set([...(prev.skip || []), ...newSkip])].slice(-2000);
    try { db.setSetting(BACKFILL_SETTING, JSON.stringify({ updated_at: Date.now(), lastMade: made, skip: mergedSkip })); } catch { /* */ }
    if (made || newSkip.length) console.log(`[AutoClip] Historical backfill: ${made} clip(s) added, ${newSkip.length} VOD(s) skipped (unclippable)`);
    return made;
}

/**
 * Cut a clip around a moment the AI-moments pipeline already chose for a finished VOD.
 * @param {object} o { vod (row w/ user_id, stream_id, vod_id/id), offset, title, desc }
 */
function _sceneSig(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 5).join(' ');
}
// True if a recent auto-clip is basically the same as (vod, offset, scene) we're about to cut —
// same VOD spot, or a near-identical scene signature (same streamer's repeated intro/setup).
function _isDuplicateAutoClip(vod, offset, desc, title) {
    try {
        const vId = vod.vod_id || vod.id;
        const sig = _sceneSig(desc || title);
        const start = Math.max(0, Math.floor(offset) - CLIP_PRE);
        const cutoff = Date.now() - 48 * 3600_000;
        for (const c of _clipLog()) {
            if (c.ts < cutoff) continue;
            if ((c.vod_id === vId || c.stream_id === vod.stream_id) && Math.abs((c.start_time || 0) - start) < 45) return true;
            if (sig && c.sig === sig) return true;
        }
    } catch { /* */ }
    return false;
}

async function clipVodMoment(o) {
    try {
        const { vod, offset, title, desc } = o || {};
        if (!vod || !(offset >= 0)) return null;
        if (_isDuplicateAutoClip(vod, offset, desc, title)) {
            console.log(`[AutoClip] skip VOD ${vod.vod_id || vod.id} — duplicate/near-identical auto-clip already exists`);
            return null;
        }
        const vodId = vod.vod_id || vod.id;
        const start = Math.max(0, Math.floor(offset) - CLIP_PRE);
        const clip = await media.createClip({
            vod_id: vodId, start_s: start, end_s: start + CLIP_PRE + CLIP_POST,
            title: title || 'Standout Moment', user_id: vod.user_id,
            stream_id: vod.stream_id || undefined, auto_generated: true, description: desc || '',
        });
        if (clip) _logClip({ stream_id: vod.stream_id || null, vod_id: vodId, start_time: start, title: title || 'Standout Moment', clip_id: clip.id, sig: _sceneSig(desc || title) });
        return clip || null;
    } catch { return null; }
}

let _backfillTimer = null;
function start() {
    if (_timer) return;
    _timer = setInterval(() => { _tick().catch(() => {}); }, CHECK_INTERVAL_MS);
    // Historical VOD backfill: schedule is persistent (due-ness from the DB-stored
    // auto_clip_backfill.updated_at), so deploys/restarts never reset it. Re-check every 5m +
    // shortly after boot so a due run resumes promptly.
    setTimeout(() => { backfillVodClips().catch(() => {}); }, 30 * 1000);
    _backfillTimer = setInterval(() => { backfillVodClips().catch(() => {}); }, 5 * 60 * 1000);
    console.log('[AutoClip] Live auto-clip job started (selective chat-spike + AI agreement, cuts via OpenVibe.Media) + persistent VOD backfill');
}
function stop() { if (_timer) { clearInterval(_timer); _timer = null; } if (_backfillTimer) { clearInterval(_backfillTimer); _backfillTimer = null; } }

module.exports = { start, stop, clipVodMoment, backfillVodClips, _tick };

// CLI: force a historical backfill batch, e.g. `node server/ai/auto-clip-job.js --backfill --limit=4`
if (require.main === module) {
    const argv = process.argv.slice(2);
    const num = (name, def) => { const a = argv.find(x => x.startsWith(`--${name}=`)); return a ? parseInt(a.split('=')[1], 10) : def; };
    if (argv.includes('--backfill')) {
        const limit = num('limit', 4);
        console.log(`[AutoClip] Manual backfill (limit ${limit})…`);
        backfillVodClips({ limit, force: true })
            .then((n) => { console.log(`[AutoClip] Manual backfill done — ${n} clip(s) created.`); process.exit(0); })
            .catch((e) => { console.error('[AutoClip] Manual backfill failed:', e); process.exit(1); });
    } else {
        console.log('Usage: node server/ai/auto-clip-job.js --backfill [--limit=N]');
        process.exit(0);
    }
}
