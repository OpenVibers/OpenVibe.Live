'use strict';
/**
 * The Rundown's episode pictures (docs/rundown.md). One editorial illustration per episode, made from the episode's
 * own words and stored in OpenVibe.Media; the stream's thumbnail stays the fallback.
 *
 *   ensure(stream, user, episode, topics)  called when the desk writes an episode: one pending row per stream.
 *   tick()                                 the due-based job: one picture at a time, retried with back-off, never a loop.
 *   remake(streamId)                       the owner's "remake this episode's picture".
 *
 * What the job asks for: the title, topics, takes and recap become a prompt for a funny, warm magazine illustration,
 * 1200×630 in the feed. The rules are in the prompt (no real person's likeness, no text, no sexual content, no minors)
 * and the words are checked before anything is sent: server/ai/explicit.js's categories, and any mention of a minor,
 * refuse the episode outright. An explicit episode is never pictured, never retried, and no prompt leaves Live.
 *
 * The AI side is OpenVibe.AI's Exchange-compatible image call (POST /v1/images/generations: the model, size and an
 * Idempotency-Key), which routes to the model the owner picked. When that route is not configured (no image model on
 * the network yet) the job falls back once to the ordinary `ai.image` workflow, so a later AI_IMAGE_MODEL turns the
 * feature on without a Live deploy. A refusal is final; a network failure waits (15 min, 30, 60, 120, then failed);
 * the monthly cap is checked before every call and a cap that is reached waits for the next UTC month.
 *
 * Nothing runs under LIVE_DRILL: start() is called from the same boot block as the other jobs, after the drill returns.
 */
const crypto = require('crypto');
const db = require('../db/database');
const explicit = require('../ai/explicit');
const filters = require('./filters');

const DEFAULTS = Object.freeze({
    enabled: true,
    model: 'openai/gpt-image-1-mini',
    size: '1536x1024',
    style: 'a funny, warm editorial illustration: thick ink lines, flat colour, a little surreal, magazine cover energy',
    monthly_cap_usd: 5,
});
const SETTINGS = Object.freeze({
    enabled: 'rundown_picture_enabled',
    model: 'rundown_picture_model',
    size: 'rundown_picture_size',
    style: 'rundown_picture_style',
    monthly_cap_usd: 'rundown_picture_monthly_cap_usd',
});
const MAX_ATTEMPTS = 4;                 // the fifth failure is final: a broken provider must not be hammered
const BASE_BACKOFF_MS = 15 * 60 * 1000;
const MAX_BACKOFF_MS = 6 * 3600 * 1000;
const CLAIM_MS = 5 * 60 * 1000;         // a worker that dies after claiming is retried after this
const OUT_W = 1200, OUT_H = 630;
const MAX_SOURCE = 4000;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SIZE_RE = /^[0-9]{3,4}x[0-9]{3,4}$/;
const RETRYABLE_CODES = new Set(['ai.unreachable', 'ai.no_token', 'provider.unavailable', 'provider.timeout', 'route.unavailable', 'ai.resting', 'ai.slow', 'internal', 'ai.image_failed']);
const CAP_CODES = new Set(['choice.cost_ceiling', 'insufficient_balance', 'image.price_required', 'balance.insufficient', 'quota.exceeded']);
const REFUSAL_RE = /safety|content[\s_-]*polic|moderation|rejected|blocked|not\s+allowed|violat/i;

let _job = null;
let _busy = false;
let _warned = 0;
const warn = (msg) => { if (Date.now() - _warned > 60_000) { _warned = Date.now(); console.warn(`[Rundown pictures] ${msg}`); } };
const clean = (t, n) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, n);
const sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const plus = (ms) => new Date(Date.now() + ms).toISOString().replace('T', ' ').slice(0, 19);
const monthStart = () => `${new Date().toISOString().slice(0, 7)}-01 00:00:00`;
const nextMonthStart = () => { const d = new Date(); return `${new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10)} 00:00:00`; };
const bool = (v, d) => (v === null || v === undefined || v === '' ? d : v === true || v === 'true' || v === 1 || v === '1');
const parseJson = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };

/** The owner's settings, with the defaults. A stored '' for the cap means no cap. */
async function settings() {
    const rows = new Map((await db.all('SELECT key, value FROM site_settings WHERE key = ANY(?)', [Object.values(SETTINGS)]))
        .map((r) => [r.key, r.value]));
    const raw = (k) => (rows.has(SETTINGS[k]) ? rows.get(SETTINGS[k]) : undefined);
    const capRaw = raw('monthly_cap_usd');
    const cap = capRaw === undefined || capRaw === null || capRaw === '' ? (capRaw === '' ? null : DEFAULTS.monthly_cap_usd) : Number(capRaw);
    return {
        enabled: bool(raw('enabled'), DEFAULTS.enabled),
        model: clean(raw('model') || DEFAULTS.model, 200) || DEFAULTS.model,
        size: SIZE_RE.test(String(raw('size') || '')) ? String(raw('size')) : DEFAULTS.size,
        style: clean(raw('style') || DEFAULTS.style, 400) || DEFAULTS.style,
        monthly_cap_usd: Number.isFinite(cap) && cap >= 0 ? cap : (cap === null ? null : DEFAULTS.monthly_cap_usd),
    };
}

/** What the month has spent so far (finished pictures only), in USD. */
async function spend(month = new Date().toISOString().slice(0, 7)) {
    const row = await db.get("SELECT COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS n FROM rundown_pictures WHERE status = 'done' AND done_at >= ?", [`${month}-01 00:00:00`]);
    return { month, usd: Number(row && row.usd) || 0, pictures: Number(row && row.n) || 0 };
}

/** The episode's own words, one text: title, logline, recap, topics, then the best takes. Never the streamer's name. */
function sourceOf(episode, topics, segments) {
    const lines = [];
    if (episode && episode.title) lines.push(`Episode: ${episode.title}`);
    if (episode && episode.logline) lines.push(`Logline: ${episode.logline}`);
    if (topics && topics.length) lines.push(`Topics: ${topics.map((t) => (typeof t === 'string' ? t : t && t.title)).filter(Boolean).join('; ')}`);
    if (episode && episode.recap) lines.push(`Recap: ${String(episode.recap).replace(/\s*\n\s*\n\s*/g, ' ')}`);
    for (const s of (segments || []).slice(0, 6)) {
        const what = clean(s.take || s.what || '', 280);
        if (what) lines.push(`Take: ${clean(s.title, 140)}${s.title && what ? ' — ' : ''}${what}`);
    }
    return lines.join('\n').slice(0, MAX_SOURCE);
}

/** May these words become a picture? explicit.js's categories, and the hard line: nothing involving a minor. */
function verdict(text) {
    const v = explicit.classifyText(text);
    if (v.category !== 'fine') return { ok: false, category: v.category, reason: v.reason };
    if (explicit.MINOR.test(String(text || ''))) return { ok: false, category: 'minor', reason: 'the words involve a minor' };
    return { ok: true };
}

/** The prompt: the episode as a scene, not the people in it. */
function promptFor(source, style) {
    return [
        'A funny editorial illustration for a livestream episode, a wide 1200x630 magazine picture.',
        'What the episode was about:',
        String(source || '').slice(0, MAX_SOURCE),
        `Style: ${style}`,
        'Draw the situation and its objects, not the people: symbolic, cartoonish, exaggerated, clever.',
        'Rules: no real person and no recognizable likeness of anyone (faces turned away or stylized); no text, letters,',
        'numbers, logos or watermarks; no sexual content or nudity; no minors; no gore; no drugs; no firearms.',
        'Warm and publishable, in the spirit of a late-night talk show.',
    ].join('\n');
}

/** One row per episode. A new episode starts pending; an existing row is never reset by a rewrite. */
async function ensure(stream, user, episode, topics) {
    const id = Number(stream && stream.id);
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const source = sourceOf(episode, topics, await db.all("SELECT title, what, take FROM rundown_segments WHERE stream_id = ? AND status = 'live' ORDER BY score DESC, start_sec ASC LIMIT 6", [id]));
    const v = verdict(source);
    const status = v.ok ? 'pending' : 'refused';
    const st = await settings();
    await db.run(`INSERT INTO rundown_pictures (stream_id, user_id, status, source_text, model, size, next_attempt_at, error)
        VALUES (?, ?, ?, ?, ?, ?, ov_now(), ?) ON CONFLICT (stream_id) DO NOTHING`,
    [id, Number(stream.user_id || (user && user.id) || 0), status, source, st.model, st.size, v.ok ? null : `${v.category}: ${v.reason}`]);
    return await db.get('SELECT * FROM rundown_pictures WHERE stream_id = ?', [id]);
}

/** The owner's remake: the same episode's words, a fresh attempt (a refusal is re-judged too). */
async function remake(streamId, { model = null, size = null } = {}) {
    const id = Number(streamId);
    const ep = await db.get('SELECT stream_id, user_id, title, logline, recap FROM rundown_episodes WHERE stream_id = ?', [id]);
    if (!ep) throw Object.assign(new Error('No such episode'), { status: 404 });
    const topics = await db.all('SELECT t.title FROM rundown_segments s JOIN rundown_topics t ON t.id = s.topic_id WHERE s.stream_id = ? AND s.status = \'live\' AND t.status = \'live\' GROUP BY t.title', [id]);
    const source = sourceOf(ep, topics, await db.all("SELECT title, what, take FROM rundown_segments WHERE stream_id = ? AND status = 'live' ORDER BY score DESC, start_sec ASC LIMIT 6", [id]));
    const v = verdict(source);
    const st = await settings();
    await db.run(`INSERT INTO rundown_pictures (stream_id, user_id, status, source_text, model, size, attempts, idem_key, next_attempt_at, error, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ov_now(), ?, ov_now())
        ON CONFLICT (stream_id) DO UPDATE SET status = excluded.status, source_text = excluded.source_text, model = excluded.model, size = excluded.size,
            attempts = 0, idem_key = NULL, next_attempt_at = ov_now(), error = excluded.error, updated_at = ov_now()`,
    [id, Number(ep.user_id), v.ok ? 'pending' : 'refused', source, model || st.model, size || st.size, v.ok ? null : `${v.category}: ${v.reason}`]);
    return await db.get('SELECT * FROM rundown_pictures WHERE stream_id = ?', [id]);
}

/** Ask for a picture, then store it in Media at 1200×630. The fallback is the AI's own ai.image workflow. */
async function make(prompt, settingsNow, capLeft, idemKey) {
    const ai = require('../ai/ai-service');
    const first = await ai.image({
        prompt, model: settingsNow.model, size: settingsNow.size, n: 1, maxCostUsd: capLeft,
        idempotencyKey: idemKey, timeoutMs: 150000,
    });
    if (first && first.ok) return { ...first, fallback: false };
    const transient = first && (first.status === 404 || first.status === 503 || first.status === 0)
        && /model|provider|route|choice|unavailable|not found/i.test(String(first.code || '') + ' ' + String(first.detail || ''));
    if (!transient) return first || { ok: false, status: 0, code: 'ai.image_failed', detail: 'AI did not answer' };
    // The network has the default image route but not the named model (or no free capacity for it): ask the workflow.
    const r = await ai.run('ai.image', { prompt, size: settingsNow.size, n: 1 }, { idempotencyKey: `${idemKey}-default`, waitMs: 120000 });
    const out = ai.usable(r);
    const img = out && Array.isArray(out.images) && out.images.find((i) => i && (i.b64 || i.url));
    if (!img) return first;
    return {
        ok: true, b64: img.b64 || null, url: img.url || null, fallback: true,
        model: (r.provenance && r.provenance.model) || settingsNow.model,
        cost_usd: Number(r.usage && r.usage.cost_usd) || 0, run_id: r.id || null,
    };
}

/** The bytes of the provider's answer, resized and cropped to the feed's 1200×630. */
async function pictureBytes(result) {
    let buf = null;
    if (result.b64) buf = Buffer.from(String(result.b64), 'base64');
    else if (result.url) {
        // The provider's own URL, never a person-chosen one: the egress guard still applies at connect time.
        const got = await require('../net/egress').fetchBuffer(String(result.url), { timeoutMs: 30000, maxBytes: 20 * 1024 * 1024 });
        if (got.status !== 200) throw new Error(`the image URL answered ${got.status}`);
        buf = got.body;
    }
    if (!buf || !buf.length) throw new Error('the provider returned no image bytes');
    const sharp = require('sharp');
    return await sharp(buf, { failOn: 'none' }).rotate().resize(OUT_W, OUT_H, { fit: 'cover', position: 'attention' })
        .jpeg({ quality: 86, mozjpeg: true }).toBuffer();
}

function backoffMs(attempts) { return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attempts - 1))); }

/** Settle one claimed row. Never throws: the row's own status is the receipt. */
async function process(row) {
    const st = await settings();
    if (!st.enabled) return { stream_id: row.stream_id, status: 'off' };
    const ep = await db.get('SELECT stream_id, user_id, title, logline, recap FROM rundown_episodes WHERE stream_id = ? AND status = \'live\'', [row.stream_id]);
    if (!ep) {
        await db.run("UPDATE rundown_pictures SET status = 'failed', error = 'the episode is gone', updated_at = ov_now() WHERE stream_id = ?", [row.stream_id]);
        return { stream_id: row.stream_id, status: 'gone' };
    }
    const source = row.source_text || sourceOf(ep, [], []);
    const v = verdict(source);
    if (!v.ok) {
        await db.run("UPDATE rundown_pictures SET status = 'refused', error = ?, updated_at = ov_now() WHERE stream_id = ?", [`${v.category}: ${v.reason}`, row.stream_id]);
        return { stream_id: row.stream_id, status: 'refused' };
    }
    const monthSpend = await spend();
    const cap = st.monthly_cap_usd;
    if (cap != null && monthSpend.usd >= cap) {
        await db.run("UPDATE rundown_pictures SET status = 'pending', next_attempt_at = ?, updated_at = ov_now() WHERE stream_id = ?", [nextMonthStart(), row.stream_id]);
        return { stream_id: row.stream_id, status: 'cap', next_attempt_at: nextMonthStart() };
    }
    const capLeft = cap == null ? null : Math.max(0, cap - monthSpend.usd);
    const attempt = Number(row.attempts || 0) + 1;
    const idemKey = row.idem_key || `rundown-picture:${row.stream_id}:${attempt}`;
    const prompt = promptFor(source, st.style);
    const promptHash = crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 32);
    await db.run('UPDATE rundown_pictures SET status = ?, idem_key = ?, prompt_hash = ?, model = ?, size = ?, updated_at = ov_now() WHERE stream_id = ?',
        ['working', idemKey, promptHash, st.model, st.size, row.stream_id]);
    let result, bytes;
    try {
        result = await make(prompt, st, capLeft, idemKey);
        if (!result || !result.ok) throw Object.assign(new Error((result && result.detail) || 'the image request failed'), { result });
        bytes = await pictureBytes(result);
    } catch (e) {
        const r = (e && e.result) || null;
        const code = String((r && r.code) || (e && e.code) || '');
        const detail = String((r && r.detail) || (e && e.message) || 'the image request failed').slice(0, 300);
        const status = Number(r && r.status) || 0;
        if (r && CAP_CODES.has(code)) {
            await db.run("UPDATE rundown_pictures SET status = 'pending', next_attempt_at = ?, error = ?, updated_at = ov_now() WHERE stream_id = ?", [nextMonthStart(), `cap: ${detail}`, row.stream_id]);
            return { stream_id: row.stream_id, status: 'cap' };
        }
        const refused = (status === 400 || status === 422) && REFUSAL_RE.test(detail);
        const attempts = attempt;
        if (refused) {
            await db.run("UPDATE rundown_pictures SET status = 'refused', attempts = ?, error = ?, updated_at = ov_now() WHERE stream_id = ?", [attempts, `refused: ${detail}`, row.stream_id]);
            return { stream_id: row.stream_id, status: 'refused' };
        }
        if (attempts >= MAX_ATTEMPTS) {
            await db.run("UPDATE rundown_pictures SET status = 'failed', attempts = ?, error = ?, updated_at = ov_now() WHERE stream_id = ?", [attempts, detail, row.stream_id]);
            return { stream_id: row.stream_id, status: 'failed' };
        }
        const next = plus(backoffMs(attempts));
        await db.run("UPDATE rundown_pictures SET status = 'pending', attempts = ?, next_attempt_at = ?, error = ?, updated_at = ov_now() WHERE stream_id = ?", [attempts, next, detail, row.stream_id]);
        return { stream_id: row.stream_id, status: 'retry', next_attempt_at: next };
    }
    try {
        const media = require('../media-client');
        const file = await media.uploadFile({ buffer: bytes, filename: `rundown-${row.stream_id}.jpg`, contentType: 'image/jpeg' }, { user_id: Number(ep.user_id) });
        const url = media.publicUrl(file && file.url) || (file && file.url) || null;
        if (!url) throw new Error('Media returned no URL');
        const cost = Number(result.cost_usd) || 0;
        await db.run(`UPDATE rundown_pictures SET status = 'done', attempts = ?, media_key = ?, media_url = ?, cost_usd = ?, model = ?, error = NULL,
            done_at = ov_now(), updated_at = ov_now(), next_attempt_at = ov_now() WHERE stream_id = ?`,
        [attempt, (file && file.key) || null, url, cost, result.model || st.model, row.stream_id]);
        return { stream_id: row.stream_id, status: 'done', url, cost_usd: cost };
    } catch (e) {
        const detail = `stored picture: ${String(e && e.message || e).slice(0, 240)}`;
        const next = plus(backoffMs(attempt));
        await db.run("UPDATE rundown_pictures SET status = 'pending', attempts = ?, next_attempt_at = ?, error = ?, updated_at = ov_now() WHERE stream_id = ?",
            [attempt, next, detail, row.stream_id]);
        return { stream_id: row.stream_id, status: 'retry' };
    }
}

/** The duel: one due row at most, claimed atomically. `force` (tests) ignores the due time. */
async function tick({ force = false, streamId = null } = {}) {
    if (_busy) return { skipped: 'busy' };
    const st = await settings();
    if (!st.enabled) return { skipped: 'off' };
    // AI's own master switch and daily budget still apply: when AI is off, a picture waits, it does not fail.
    try { const llm = require('../ai/llm'); if (!await llm.isEnabled() || !await llm.withinBudget()) return { skipped: 'ai' }; } catch { return { skipped: 'ai' }; }
    _busy = true;
    try {
        let row;
        if (streamId) row = await db.get("SELECT * FROM rundown_pictures WHERE stream_id = ? AND status IN ('pending','working')", [Number(streamId)]);
        else if (force) row = await db.get("SELECT * FROM rundown_pictures WHERE status IN ('pending','working') ORDER BY next_attempt_at ASC, stream_id ASC LIMIT 1");
        else row = await db.get("SELECT * FROM rundown_pictures WHERE status IN ('pending','working') AND next_attempt_at <= ov_now() ORDER BY next_attempt_at ASC, stream_id ASC LIMIT 1");
        if (!row) return { processed: 0 };
        const claimed = await db.run("UPDATE rundown_pictures SET status = 'working', next_attempt_at = ?, updated_at = ov_now() WHERE stream_id = ? AND status = ?",
            [plus(CLAIM_MS), row.stream_id, row.status]);
        if (!Number(claimed && claimed.changes)) return { processed: 0 };
        const out = await process(row);
        return { processed: 1, ...out };
    } finally { _busy = false; }
}

/** The admin view: settings, this month's spend and the recent rows. */
async function status({ limit = 20 } = {}) {
    const st = await settings();
    const spent = await spend();
    const counts = await db.get(`SELECT
        COUNT(*) FILTER (WHERE status = 'done') AS done,
        COUNT(*) FILTER (WHERE status = 'pending' OR status = 'working') AS pending,
        COUNT(*) FILTER (WHERE status = 'refused') AS refused,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed
        FROM rundown_pictures`);
    const rows = await db.all(`SELECT p.stream_id, p.status, p.model, p.size, p.media_url, p.cost_usd, p.attempts, p.next_attempt_at, p.error, p.done_at,
            e.title, u.username, u.display_name
        FROM rundown_pictures p LEFT JOIN rundown_episodes e ON e.stream_id = p.stream_id LEFT JOIN users u ON u.id = p.user_id
        ORDER BY p.updated_at DESC, p.stream_id DESC LIMIT ?`, [Math.max(1, Math.min(100, Number(limit) || 20))]);
    return {
        settings: st,
        spend: { month: spent.month, usd: spent.usd, cap_usd: st.monthly_cap_usd, remaining_usd: st.monthly_cap_usd == null ? null : Math.max(0, st.monthly_cap_usd - spent.usd), pictures: spent.pictures },
        counts: {
            done: Number(counts && counts.done) || 0, pending: Number(counts && counts.pending) || 0,
            refused: Number(counts && counts.refused) || 0, failed: Number(counts && counts.failed) || 0,
        },
        pictures: rows.map((r) => ({
            stream_id: Number(r.stream_id), status: r.status, title: r.title || null, username: r.username || null,
            display_name: r.display_name || null, model: r.model || null, size: r.size || null, image: r.media_url || null,
            cost_usd: Number(r.cost_usd) || 0, attempts: Number(r.attempts) || 0, next_attempt_at: r.next_attempt_at || null,
            error: r.error || null, done_at: r.done_at || null,
        })),
    };
}

function start() {
    if (_job) return;
    _job = require('../utils/jobs').every('rundown-pictures', 60_000, () => tick().catch((e) => warn(`job: ${e.message}`)), { initialDelayMs: 90_000, jitterMs: 15_000 });
    console.log('[Rundown pictures] job started (one picture at a time, retried with back-off, monthly cap)');
}
function stop() { if (typeof _job === 'function') _job(); _job = null; }

module.exports = {
    settings, SETTINGS, ensure, remake, tick, status, spend, sourceOf, promptFor, verdict,
    start, stop, MODEL_RE, SIZE_RE, OUT_W, OUT_H,
    _test: { reset() { _busy = false; _warned = 0; }, process, make, pictureBytes },
};
