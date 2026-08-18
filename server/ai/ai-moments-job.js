/**
 * AI "crazy moments" job — a two-stage pipeline that finds genuinely standout stream moments
 * for the home-page hero background + auto-created discoverability pastes:
 *
 *   Stage 1 — rank whole VODs by their AI overview (+ objective priors: views, clips taken,
 *             peak viewers) to decide which VODs are the most interesting.
 *   Stage 2 — for each chosen VOD, mine its full AI timeline (scene notes) + audio transcript,
 *             boosted by the timestamps viewers actually CLIPPED and chat-activity spikes, to
 *             pick the single best moment; extract that exact frame, vision-verify it, and post
 *             an image paste (description + tags + deep link to the VOD timestamp).
 *
 * Runs daily, rotates across streamers, dedupes against recently-used VODs, and degrades to
 * objective-signal picks when AI is off / over budget.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const db = require('../db/database');
const ai = require('./ai-analysis');
const media = require('../media-client');
let cfg = null; try { cfg = require('../config'); } catch { /* */ }
let thumb = null; try { thumb = require('../media-proxy/live-thumbs'); } catch { /* optional */ }
const FRAMES_TMP_DIR = path.join(os.tmpdir(), 'openvibe-live-moments');
const BASE_URL = (cfg && (cfg.baseUrl || cfg.publicUrl)) || 'https://openvibe.live';

const INTERVAL_MS = 6 * 60 * 60 * 1000;   // refresh a handful of hero moments every 6h
const TARGET = 4;
const SETTING = 'home_hero_moments';
let _busy = false;

function _load() { try { return JSON.parse(db.getSetting(SETTING) || '{}') || {}; } catch { return {}; } }
function _due() { const p = _load(); return !p.updated_at || (Date.now() - p.updated_at) >= INTERVAL_MS; }

const _ADJ = ['wild', 'epic', 'cursed', 'feral', 'unhinged', 'chaotic', 'legendary', 'peak', 'rogue', 'hazy', 'unreal', 'prime'];
const _NOUN = ['moment', 'clip', 'frame', 'scene', 'vibe', 'snippet', 'flash', 'glimpse', 'beat', 'take'];
function _slug() {
    const r = a => a[Math.floor(Math.random() * a.length)];
    return `${r(_ADJ)}-${r(_NOUN)}-${Math.floor(1000 + Math.random() * 9000)}`;
}
function _aiOn() { return !!(ai.isEnabled && ai.isEnabled() && ai.withinBudget && ai.withinBudget()); }
function _mmss(sec) { sec = Math.max(0, Math.floor(sec || 0)); const m = Math.floor(sec / 60), s = sec % 60; return `${m}:${String(s).padStart(2, '0')}`; }
function _cleanText(t, max) { return String(t || '').replace(/\s+/g, ' ').trim().slice(0, max || 400); }
function _cleanTitle(t) { return String(t || '').replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s+/g, ' ').slice(0, 80); }

// Lift a plain description out of a value that might still be a raw JSON blob (old rows).
function _deJson(desc) {
    let s = _cleanText(desc, 2000);
    if (/^\{.*"description"\s*:/.test(s)) {
        const dm = s.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
        if (dm) { try { return JSON.parse(`"${dm[1]}"`); } catch { return dm[1]; } }
    }
    return s;
}
// A specific title from a description (fallback when AI titling is unavailable) — the first
// meaningful clause, Title-Cased, so we never fall back to a generic/duplicate stream title.
function _titleFromDesc(desc) {
    let s = _cleanText(desc);
    if (!s) return 'A wild moment';
    s = s.split(/[.!?;:]|,\s(?=(?:with|and|as|while|near|showing)\b)/i)[0].trim();
    const out = s.split(' ').filter(Boolean).slice(0, 8).join(' ').replace(/[,\s]+$/, '').replace(/\b\w/g, ch => ch.toUpperCase());
    return out.slice(0, 70) || 'A wild moment';
}

// ── Stage 1: rank VODs by their AI overview ─────────────────────────────────────────────
// Scores one chunk of VODs via a single LLM call; returns [{vod, score, why}] best-first.
async function _scoreVodChunk(chunk, want) {
    const list = chunk.map((v, i) => {
        const ov = _cleanText(v.ai_overview || v.ai_overview_short, 260) || '(no summary)';
        return `${i}. [${v.view_count || 0} views · ${v.clip_count || 0} clips · peak ${v.peak_viewers || 0}] "${_cleanText(v.title, 70)}" — ${ov}`;
    }).join('\n');
    const prompt = `These are livestream VODs with their AI summaries and popularity stats. Rank the MOST interesting/entertaining/memorable ones for a highlights showcase — favor funny, dramatic, surprising, high-energy, or unusual content over routine "just chatting / sitting at a desk" streams. Clips taken and peak viewers are strong signals that something notable happened.

${list}

Return STRICT JSON only, nothing else: [{"index": <n>, "score": <1-100>, "why": "<3-8 words>"}] for the top ${Math.min(chunk.length, Math.max(want, 6))}, best first.`;
    try {
        const text = await ai.summarizeText(prompt, 700, 'moment_vod_rank');
        const m = text && text.match(/\[[\s\S]*\]/);
        if (!m) return [];
        const arr = JSON.parse(m[0]);
        const seen = new Set();
        return arr.filter(x => chunk[x.index] != null && !seen.has(x.index) && seen.add(x.index))
            .map(x => ({ vod: chunk[x.index], score: Number(x.score) || 0, why: _cleanText(x.why, 60) }))
            .sort((a, b) => b.score - a.score);
    } catch { return []; }
}
// Rank the whole VOD set (batched tournament so "every VOD ever" scales). Falls back to the
// objective prior order (already applied by the DB) when AI is unavailable.
async function _rankVods(vods, want) {
    if (!_aiOn() || vods.length <= 1) return vods.map(v => ({ vod: v }));
    const CH = 25;
    if (vods.length <= CH) {
        const r = await _scoreVodChunk(vods, want);
        return r.length ? r : vods.map(v => ({ vod: v }));
    }
    const chunks = [];
    for (let i = 0; i < vods.length; i += CH) chunks.push(vods.slice(i, i + CH));
    let winners = [];
    for (const ch of chunks) winners.push(...(await _scoreVodChunk(ch, Math.max(want, 6))));
    winners.sort((a, b) => b.score - a.score);
    // Final round over the top finalists to get a coherent overall ranking.
    if (winners.length > want) {
        const finalists = winners.slice(0, CH).map(w => w.vod);
        const fr = await _scoreVodChunk(finalists, want);
        if (fr.length) winners = fr;
    }
    return winners.length ? winners : vods.map(v => ({ vod: v }));
}

// ── Stage 2: find the best moment inside one VOD ────────────────────────────────────────
// Sample an array down to at most `max` items, evenly spread.
function _sample(arr, max) {
    if (arr.length <= max) return arr;
    const out = []; const step = arr.length / max;
    for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
    return out;
}
function _momentContext(streamId, vodId) {
    const memories = _sample((db.getStreamMemories(streamId) || []).filter(m => m.description), 45);
    const transcript = _sample(db.getStreamTranscriptSegments(streamId) || [], 60);
    const clipTimes = db.getClipStartTimesForStream(streamId, vodId) || [];
    const spikes = db.getChatSpikeOffsets(streamId, 30, 8) || [];
    return { memories, transcript, clipTimes, spikes };
}
function _nearestMemory(memories, offset) {
    let best = null, bestD = Infinity;
    for (const m of memories) { const d = Math.abs((m.offset_seconds || 0) - offset); if (d < bestD) { bestD = d; best = m; } }
    return best;
}
async function _findBestMoment(vod) {
    const dur = Math.floor(vod.duration || 0);
    const ctx = _momentContext(vod.stream_id, vod.vod_id);
    if (!ctx.memories.length && !ctx.transcript.length) return null;
    const clamp = (t) => Math.max(1, Math.min(Math.floor(t || 0), dur > 3 ? dur - 2 : (t || 0)));

    if (_aiOn()) {
        const timeline = ctx.memories.map(m => `[${_mmss(m.offset_seconds)}] ${_cleanText(_deJson(m.description), 180)}`).join('\n');
        const script = ctx.transcript.map(s => `[${_mmss(s.start)}] ${_cleanText(s.text, 160)}`).join('\n');
        const clipHint = ctx.clipTimes.length ? ctx.clipTimes.slice(0, 12).map(_mmss).join(', ') : 'none';
        const spikeHint = ctx.spikes.length ? ctx.spikes.slice(0, 6).map(s => _mmss(s.offset)).join(', ') : 'none';
        const prompt = `Below is a single livestream VOD titled "${_cleanText(vod.title, 80)}", described by its on-screen TIMELINE (visual scene notes) and its AUDIO TRANSCRIPT, each line timestamped [m:ss].

TIMELINE:
${timeline || '(none)'}

TRANSCRIPT:
${script || '(none)'}

Viewers CLIPPED these timestamps (very strong "this was a highlight" signal): ${clipHint}
Chat activity SPIKED around: ${spikeHint}

Find the SINGLE most interesting/funny/dramatic/surprising/striking moment in this VOD with something clearly VISIBLE happening. Prefer moments backed by the clip/chat signals when they line up with something notable. NEVER pick a black/dark/loading/blank screen, an intro/BRB card, or a moment with no visible content or activity. Return STRICT JSON only, nothing else: {"t": <seconds into the vod>, "title": "<specific punchy 3-8 word title, not the stream name>", "desc": "<one vivid sentence describing the moment>"}`;
        try {
            const text = await ai.summarizeText(prompt, 300, 'moment_pick');
            const m = text && text.match(/\{[\s\S]*\}/);
            if (m) {
                const j = JSON.parse(m[0]);
                let t = Number(j.t);
                if (!isNaN(t)) {
                    t = clamp(t);
                    const near = _nearestMemory(ctx.memories, t);
                    const result = { offset: t, title: _cleanTitle(j.title) || _titleFromDesc(j.desc), desc: _cleanText(_deJson(j.desc), 400) || (near && _deJson(near.description)) || '', tags: _memTags(near) };
                    return _isEmptyScene(result.desc) ? null : result;
                }
            }
        } catch { /* fall through to signal-based pick */ }
    }

    // No-AI fallback: pick from the strongest objective signal.
    let offset = null;
    if (ctx.clipTimes.length) offset = ctx.clipTimes[Math.floor(ctx.clipTimes.length / 2)]; // where viewers clipped
    else if (ctx.spikes.length) offset = ctx.spikes[0].offset;                              // busiest chat moment
    else { // richest scene note
        const rich = ctx.memories.slice().sort((a, b) => String(b.description).length - String(a.description).length)[0];
        offset = rich ? (rich.offset_seconds || 0) : 0;
    }
    offset = clamp(offset);
    const near = _nearestMemory(ctx.memories, offset);
    const desc = near ? _deJson(near.description) : '';
    return _isEmptyScene(desc) ? null : { offset, title: _titleFromDesc(desc), desc, tags: _memTags(near) };
}
// True when a description says the frame is essentially empty — black/dark/loading/blank — so we
// never turn "nothing" into a clip or paste.
function _isEmptyScene(text) {
    const t = String(text || '').toLowerCase();
    if (!t) return true;
    return /(black screen|dark screen|extremely dark|mostly (black|dark)|entirely (dark|black)|screen is (black|dark|blank)|blank (screen|frame)|no visible (content|activity)|almost no (visible|content|activity)|nothing (is )?(visible|happening)|no (content|activity)|loading screen|(brb|be right back|starting soon|intro) (screen|card|slate)|offline)/.test(t);
}
function _memTags(m) {
    if (!m) return [];
    try { const t = typeof m.tags === 'string' ? JSON.parse(m.tags) : m.tags; if (Array.isArray(t)) return t.map(String).slice(0, 8); } catch { /* */ }
    return String(m.tags || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 8);
}

// True when the extracted frame is essentially a black/empty image (pixel-level backstop for
// the description filter). Near-black, or very dark with almost no detail.
async function _frameTooDark(imgPath) {
    try {
        const sharp = require('sharp');
        const stats = await sharp(imgPath).stats();
        const chans = (stats.channels || []).slice(0, 3);
        if (!chans.length) return false;
        const meanAvg = chans.reduce((a, c) => a + (c.mean || 0), 0) / chans.length;
        const stdevAvg = chans.reduce((a, c) => a + (c.stdev || 0), 0) / chans.length;
        return meanAvg < 14 || (meanAvg < 28 && stdevAvg < 12);
    } catch { return false; }
}

// Coarse content signature for dedup — the first few significant words of a scene description.
// Near-identical scenes ("A split-image close-up of an older man…") collapse to one signature.
function _sig(desc) {
    return String(desc || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 5).join(' ');
}

// TODO(contract): the old duplicate-paste sweep pruned the local pastes table, which is
// frozen for the OpenVibe.Media migration; Media has no metadata-filtered paste listing
// yet, so scene-dedup is handled purely via the usedSigs log below.
function _dedupePastes() { /* moved to Media — sig-dedup happens pre-post */ }

// Build the moment-ranking VOD pool: Media list (most-viewed public VODs) joined with
// local AI state + stream memories. Shapes rows like the old getVodsForMomentRanking.
async function _momentPool(limit) {
    try {
        const r = await media.listVods({ limit, order: 'views' });
        const rows = r?.vods || (Array.isArray(r) ? r : []);
        if (rows.length) {
            return rows.map((v) => {
                const state = (db.getVodAiState && db.getVodAiState(v.id)) || {};
                let memory_count = 0, peak_viewers = 0;
                if (v.stream_id) {
                    try { memory_count = db.get('SELECT COUNT(*) AS c FROM stream_memories WHERE stream_id = ?', [v.stream_id])?.c || 0; } catch { /* */ }
                    try { peak_viewers = db.getStreamById(v.stream_id)?.peak_viewers || 0; } catch { /* */ }
                }
                return {
                    vod_id: v.id, stream_id: v.stream_id || null, user_id: v.user_id || null,
                    username: v.username || null, title: v.title || '',
                    ai_overview: state.ai_overview_short || v.ai_overview_short || '',
                    ai_overview_short: state.ai_overview_short || v.ai_overview_short || '',
                    view_count: Number(v.view_count) || 0,
                    duration: Number(v.duration_seconds ?? v.duration) || 0,
                    peak_viewers, created_at: v.created_at || null,
                    clip_count: Number(v.clip_count) || 0,
                    memory_count,
                };
            });
        }
    } catch { /* fall through to legacy local rows */ }
    try { return db.getVodsForMomentRanking ? (db.getVodsForMomentRanking(limit) || []) : []; } catch { return []; }
}

async function tick(opts = {}) {
    // opts: { force } bypass the daily gate, { fresh } ignore the recently-used log,
    // { target } how many moments, { vodPool } how many VODs to consider, { perUser } cap.
    if (_busy || (!opts.force && !_due())) return;
    const TARGET_N = Math.max(1, opts.target || TARGET);
    const VOD_POOL = Math.max(TARGET_N, opts.vodPool || 120);
    const perUser = Math.max(1, opts.perUser || 1);
    const ignoreUsed = !!opts.fresh;
    _busy = true;
    try {
        const prev = _load();
        const usedVods = new Set(ignoreUsed ? [] : (prev.usedVods || []));
        // Content-signature dedup: even different VODs from the same streamer (same setup) yield
        // near-identical scenes → we skip a moment whose description signature was used recently,
        // so the hero/pastes never show visual duplicates. Respected even on --fresh.
        const usedSigs = new Set(prev.usedSigs || []);
        const thisSigs = new Set();

        // Stage 1: consider every eligible VOD, ranked by its AI overview + popularity prior.
        // The VOD pool comes from OpenVibe.Media (most-viewed public VODs), overlaid with
        // Live-owned AI state (vod_ai_state) + stream-memory counts; legacy local rows
        // fill in if Media is unreachable.
        let vods = (await _momentPool(VOD_POOL))
            .filter(v => v.vod_id && (v.memory_count > 0 || (v.ai_overview && v.ai_overview.length > 20)));
        const totalEligible = vods.length;
        const freshVods = vods.filter(v => !usedVods.has(v.vod_id));
        if (freshVods.length >= TARGET_N) vods = freshVods;
        if (!vods.length) { _busy = false; return; }

        const ranked = await _rankVods(vods, TARGET_N * 3 + 2);

        // Diversify: at most `perUser` VODs per streamer, in ranked order, up to TARGET_N.
        const userCount = new Map();
        const chosen = [];
        // Over-select (3× target) so the sig-dedup below still leaves enough distinct moments.
        const SELECT_N = TARGET_N * 3;
        for (const r of ranked) {
            const uid = r.vod.user_id;
            if ((userCount.get(uid) || 0) >= perUser) continue;
            userCount.set(uid, (userCount.get(uid) || 0) + 1);
            chosen.push(r);
            if (chosen.length >= SELECT_N) break;
        }
        if (chosen.length < SELECT_N) {
            const have = new Set(chosen.map(r => r.vod.vod_id));
            for (const r of ranked) { if (!have.has(r.vod.vod_id)) { chosen.push(r); have.add(r.vod.vod_id); } if (chosen.length >= SELECT_N) break; }
        }

        const moments = [];
        const newUsedVods = [];
        for (const r of chosen) {
            if (moments.length >= TARGET_N) break;
            const v = r.vod;
            newUsedVods.push(v.vod_id);
            // Stage 2: find the best moment within this VOD.
            const moment = await _findBestMoment(v);
            if (!moment) continue;
            // Skip near-duplicate scenes (same signature as a recent or already-picked moment).
            const sig = _sig(moment.desc || v.ai_overview_short || v.title);
            if (sig && (usedSigs.has(sig) || thisSigs.has(sig))) {
                console.log(`[AI-Moments] Skipped VOD ${v.vod_id} — duplicate scene ("${sig}")`);
                continue;
            }
            if (sig) thisSigs.add(sig);
            const offset = Math.floor(moment.offset || 0);
            let desc = moment.desc || '';
            let title = moment.title || _titleFromDesc(desc) || v.title;
            let tags = moment.tags || [];

            const vodPath = `/vod/${v.vod_id}?t=${offset}`;
            const vodLink = `${BASE_URL}${vodPath}`;
            const slug = _slug();

            // Extract the real frame at this moment so the paste is a true IMAGE paste.
            // The source is the still-present legacy local file, or the OpenVibe.Media
            // playback URL — ffmpeg range-seeks the remote file, so cold VODs still work.
            let screenshotPath = null;
            let momentSource = null; // resolved media (local path or Media URL) for clipping
            let img = `/api/thumbnails/generate/vod/${v.vod_id}`;
            try {
                let source = null;
                try {
                    const vod = db.getVodById ? db.getVodById(v.vod_id) : null;
                    if (vod && vod.file_path && fs.existsSync(vod.file_path)) source = vod.file_path;
                } catch { /* */ }
                if (!source) {
                    try {
                        const meta = await media.getVod(v.vod_id);
                        source = media.publicUrl(meta && meta.playback_url) || media.vodPlaybackUrl(v.vod_id);
                    } catch { source = media.vodPlaybackUrl(v.vod_id); }
                }
                momentSource = source || null;
                if (thumb && source && thumb.extractFrameToFile) {
                    const fname = `ai-moment-vod${v.vod_id}-${offset}.jpg`;
                    const outPath = path.join(FRAMES_TMP_DIR, fname);
                    if (await thumb.extractFrameToFile(source, offset, outPath)) {
                        screenshotPath = outPath;
                        // Vision-verify the ACTUAL extracted frame → most accurate description +
                        // tags, and it confirms we didn't grab a black/loading screen.
                        if (_aiOn() && ai.analyzeImagePaste) {
                            try {
                                const vis = await ai.analyzeImagePaste(outPath, title);
                                if (vis && vis.description && vis.description.length > 25) {
                                    desc = _cleanText(vis.description, 500);
                                    if (Array.isArray(vis.tags) && vis.tags.length) tags = vis.tags.slice(0, 8);
                                    if (!moment.title) title = _titleFromDesc(desc);
                                }
                            } catch { /* keep the moment desc */ }
                        }
                    }
                }
            } catch { /* keep fallback */ }

            // These are meant to be IMAGE pastes of the actual moment. If we couldn't extract
            // the frame (e.g. the VOD file was pruned), skip it entirely — never post a text
            // paste, which just clutters the pastes tab.
            if (!screenshotPath) {
                console.log(`[AI-Moments] Skipped VOD ${v.vod_id} — could not extract moment frame (no local file).`);
                continue;
            }
            // Pixel backstop: never post/clip a black or empty frame.
            if (await _frameTooDark(screenshotPath)) {
                console.log(`[AI-Moments] Skipped VOD ${v.vod_id} — extracted frame is too dark/empty.`);
                try { require('node:fs').unlinkSync(screenshotPath); } catch { /* */ }
                continue;
            }

            if (!desc) desc = _cleanText(v.ai_overview_short || v.ai_overview, 400) || 'A standout moment from this stream.';
            // Re-check the signature against the FINAL (vision-verified) description — this is
            // what actually catches same-scene duplicates (e.g. a split-image close-up re-picked).
            const finalSig = _sig(desc);
            if (finalSig && finalSig !== sig && (usedSigs.has(finalSig) || thisSigs.has(finalSig))) {
                console.log(`[AI-Moments] Skipped VOD ${v.vod_id} — duplicate scene after vision ("${finalSig}")`);
                continue;
            }
            if (finalSig) thisSigs.add(finalSig);
            const content = `${desc}\n\n▶ Watch this moment on @${v.username}'s stream: ${vodLink}`;
            const metadata = JSON.stringify({ ai_moment: true, vod_id: v.vod_id, offset, vod_link: vodPath, username: v.username, why: r.why || null });
            let pasteSlug = slug;
            try {
                // Post the image paste to OpenVibe.Media. Extra fields (slug/metadata/
                // ai_summary/ai_tags/stream_id) are inherited-shape extensions the
                // contract leaves open — Media ignores what it doesn't know.
                const paste = await media.createPaste({
                    slug, user_id: v.user_id,
                    title: title.slice(0, 80), content, language: 'text', visibility: 'public',
                    stream_id: v.stream_id, metadata,
                    ai_summary: desc, ai_tags: JSON.stringify(tags.length ? tags : []),
                    screenshot: {
                        buffer: fs.readFileSync(screenshotPath),
                        filename: path.basename(screenshotPath),
                        contentType: 'image/jpeg',
                    },
                });
                if (paste) {
                    pasteSlug = paste.slug || slug;
                    // Screenshot pastes must use the image endpoint — /raw serves the
                    // (empty) text content and broke the hero background rotation.
                    img = media.publicUrl(paste.screenshot_url) || `${media.pasteUrl(pasteSlug)}/screenshot`;
                }
            } catch (e) { console.warn(`[AI-Moments] paste post failed for VOD ${v.vod_id}:`, e.message); }
            try { fs.unlinkSync(screenshotPath); } catch { /* tmp frame */ }

            moments.push({ vodId: v.vod_id, offset, title: title.slice(0, 80), thumbnail: img, username: v.username, pasteSlug });

            // Also cut a real VOD clip around this same moment (AI auto-clip), unless disabled.
            if (opts.clip !== false && momentSource) {
                try {
                    const clip = await require('./auto-clip-job').clipVodMoment({ vod: v, offset, title, desc, source: momentSource });
                    if (clip) console.log(`[AI-Moments] Auto-clip cut for VOD ${v.vod_id} ("${title.slice(0, 60)}")`);
                } catch { /* clipping is best-effort */ }
            }
        }

        const usedLog = [...newUsedVods, ...(prev.usedVods || [])].slice(0, 300);
        const sigLog = [...thisSigs, ...(prev.usedSigs || [])].slice(0, 120);
        db.setSetting(SETTING, JSON.stringify({ moments, usedVods: usedLog, usedSigs: sigLog, updated_at: Date.now() }));
        console.log(`[AI-Moments] ${moments.length} moment(s) from ${chosen.length}/${totalEligible} ranked VODs + pastes created`);
    } catch (e) {
        console.warn('[AI-Moments] tick error:', e.message);
    } finally {
        _busy = false;
        // Regenerate the hero slogans/labels at the SAME time as the hero background moments,
        // so both halves of the home hero always refresh together. Awaited so it completes even
        // in a one-off CLI run (which would otherwise exit before the async slogan call).
        try { await require('./slogan-job').tick(); } catch { /* */ }
    }
}

function start() {
    // Schedule is persistent: due-ness is computed from the DB-stored last-run (home_hero_moments
    // .updated_at), so restarts/deploys never reset the clock. Re-check every 5m + shortly after
    // boot so a due run resumes promptly after any restart.
    setTimeout(() => { tick().catch(() => {}); }, 20 * 1000);
    setInterval(() => { tick().catch(() => {}); }, 5 * 60 * 1000);
}

module.exports = { start, tick, findBestMoment: _findBestMoment, frameTooDark: _frameTooDark };

// CLI: force a one-off regeneration, e.g. a whole-dataset "best of all-time" test run:
//   node server/ai/ai-moments-job.js --fresh --target=6 --perUser=2
if (require.main === module) {
    const argv = process.argv.slice(2);
    const has = (f) => argv.includes(f);
    const num = (name, def) => { const a = argv.find(x => x.startsWith(`--${name}=`)); return a ? parseInt(a.split('=')[1], 10) : def; };
    const opts = {
        force: true,
        fresh: has('--fresh'),
        target: num('target', 6),
        vodPool: has('--all') ? 500 : num('vodPool', 120),
        perUser: num('perUser', 1),
    };
    console.log('[AI-Moments] Manual run:', JSON.stringify(opts));
    tick(opts)
        .then(() => { const p = _load(); console.log(`[AI-Moments] Done — ${(p.moments || []).length} moment(s) in the hero set.`); process.exit(0); })
        .catch((e) => { console.error('[AI-Moments] Manual run failed:', e); process.exit(1); });
}
