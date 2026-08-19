/**
 * OpenVibe.Live — OpenVibe.Media API v1 client
 *
 * Server-side client for the OpenVibe.Media service (see OpenVibers/CONTRACTS.md,
 * "Media API v1"). All VOD / clip / paste / file / thumbnail storage and processing
 * lives in Media now; Live talks to it via this module.
 *
 * Auth: `Authorization: Bearer <MEDIA_API_KEY>` (per-app server key) by default.
 * When a request is made on behalf of a browser user, pass `userToken` (their
 * Network JWT) instead — Media verifies it offline and applies user-level ACLs.
 *
 * Env:
 *   MEDIA_URL         internal base URL     (default http://127.0.0.1:4100)
 *   MEDIA_PUBLIC_URL  public serving base   (default https://openvibe.media)
 *   MEDIA_APP_ID      tenant/app id         (default live)
 *   MEDIA_API_KEY     per-app server key
 */
'use strict';

const MEDIA_URL = (process.env.MEDIA_URL || 'http://127.0.0.1:4100').replace(/\/+$/, '');
const MEDIA_PUBLIC_URL = (process.env.MEDIA_PUBLIC_URL || 'https://openvibe.media').replace(/\/+$/, '');
const MEDIA_APP_ID = process.env.MEDIA_APP_ID || 'live';
const MEDIA_API_KEY = process.env.MEDIA_API_KEY || '';

const API_BASE = `${MEDIA_URL}/api/v1/${MEDIA_APP_ID}`;

class MediaApiError extends Error {
    constructor(message, status, body) {
        super(message);
        this.name = 'MediaApiError';
        this.status = status || 0;
        this.body = body || null;
    }
}

function _authHeader(opts = {}) {
    const token = opts.userToken || MEDIA_API_KEY;
    return token ? { Authorization: `Bearer ${token}` } : {};
}

function _qs(query) {
    if (!query) return '';
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '') continue;
        params.set(k, String(v));
    }
    const s = params.toString();
    return s ? `?${s}` : '';
}

/**
 * Core request helper. `body` may be a plain object (JSON) or FormData (multipart).
 * Returns parsed JSON (or null for empty responses). Throws MediaApiError on !ok.
 */
async function request(method, apiPath, { body, query, userToken, headers = {}, timeoutMs = 30000 } = {}) {
    const url = `${API_BASE}${apiPath}${_qs(query)}`;
    const opts = {
        method,
        headers: { Accept: 'application/json', ..._authHeader({ userToken }), ...headers },
    };
    if (body !== undefined && body !== null) {
        if (typeof FormData !== 'undefined' && body instanceof FormData) {
            opts.body = body; // fetch sets the multipart boundary header
        } else {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    opts.signal = ctrl.signal;
    let res;
    try {
        res = await fetch(url, opts);
    } catch (err) {
        throw new MediaApiError(`Media unreachable (${method} ${apiPath}): ${err.message}`, 0, null);
    } finally {
        clearTimeout(timer);
    }
    let json = null;
    const text = await res.text().catch(() => '');
    if (text) { try { json = JSON.parse(text); } catch { json = null; } }
    if (!res.ok) {
        const msg = (json && (json.error || json.message)) || `Media API ${res.status} on ${method} ${apiPath}`;
        throw new MediaApiError(msg, res.status, json);
    }
    return json;
}

/** Build a FormData with a file part + extra fields. `file` = Buffer | {buffer, filename, contentType}. */
function _formData(fields = {}, file = null, fileField = 'file') {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) {
        if (v === undefined || v === null) continue;
        fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    if (file) {
        const buf = Buffer.isBuffer(file) ? file : file.buffer;
        const filename = (!Buffer.isBuffer(file) && file.filename) || 'upload.bin';
        const type = (!Buffer.isBuffer(file) && file.contentType) || 'application/octet-stream';
        fd.append(fileField, new Blob([buf], { type }), filename);
    }
    return fd;
}

// ── VODs ─────────────────────────────────────────────────────────────────────

/** POST /vods → { id } */
function createVod({ title, stream_id, stream_key, managed_stream_id, user_id, meta, visibility, clips_only } = {}, opts = {}) {
    return request('POST', '/vods', { body: { title, stream_id, stream_key, managed_stream_id, user_id, meta, visibility, clips_only }, ...opts });
}

/** POST /vods/:id/ingest/rtmp { rtmp_url } → 202 (Media pulls the RTMP URL with ffmpeg) */
function ingestRtmp(vodId, rtmpUrl, opts = {}) {
    return request('POST', `/vods/${vodId}/ingest/rtmp`, { body: { rtmp_url: rtmpUrl }, ...opts });
}

/**
 * POST /vods/:id/ingest/rtp/start { video:{payloadType,codec,clockRate}, audio:{...} }
 * → { videoPort, audioPort } (UDP 12000-12199 on 127.0.0.1 — point PlainRtpTransports there)
 */
function ingestRtpStart(vodId, { video, audio } = {}, opts = {}) {
    return request('POST', `/vods/${vodId}/ingest/rtp/start`, { body: { video, audio }, ...opts });
}

/** POST /vods/:id/ingest/rtp/stop → finalizes the recording */
function ingestRtpStop(vodId, opts = {}) {
    return request('POST', `/vods/${vodId}/ingest/rtp/stop`, opts);
}

/** POST /vods/:id/chunks (multipart) — browser MediaRecorder chunk upload path */
function uploadVodChunk(vodId, chunk, fields = {}, opts = {}) {
    const fd = _formData(fields, chunk, 'chunk');
    return request('POST', `/vods/${vodId}/chunks`, { body: fd, timeoutMs: 120000, ...opts });
}

/** POST /vods/:id/chunks/complete */
function completeVodChunks(vodId, opts = {}) {
    return request('POST', `/vods/${vodId}/chunks/complete`, opts);
}

/** POST /vods/:id/finalize → close recording, kick off thumbnail + probe */
function finalizeVod(vodId, opts = {}) {
    return request('POST', `/vods/${vodId}/finalize`, opts);
}

/** GET /vods/:id → { id, title, status, duration, playback_url, thumbnail_url, storage_provider, ... } */
function getVod(vodId, opts = {}) {
    return request('GET', `/vods/${vodId}`, opts);
}

/** GET /vods?limit&offset (+ pass-through filters like username/user_id/stream_id) */
function listVods(query = {}, opts = {}) {
    return request('GET', '/vods', { query, ...opts });
}

/** PUT /vods/:id { title?, is_public?, visibility?, ... } — metadata update (inherited shape). */
// TODO(contract): the contract only spells out create/get/list/delete for VODs; the
// metadata update verb is assumed to be PUT /vods/:id like the inherited routes.
function updateVod(vodId, fields, opts = {}) {
    return request('PUT', `/vods/${vodId}`, { body: fields, ...opts });
}

/** DELETE /vods/:id */
function deleteVod(vodId, opts = {}) {
    return request('DELETE', `/vods/${vodId}`, opts);
}

// ── Clips ────────────────────────────────────────────────────────────────────

/** POST /clips { vod_id, start_s, end_s, title?, user_id? } → { id, status } */
function createClip({ vod_id, start_s, end_s, title, user_id, ...extra } = {}, opts = {}) {
    return request('POST', '/clips', { body: { vod_id, start_s, end_s, title, user_id, ...extra }, ...opts });
}

function getClip(clipId, opts = {}) {
    return request('GET', `/clips/${clipId}`, opts);
}

function listClips(query = {}, opts = {}) {
    return request('GET', '/clips', { query, ...opts });
}

// TODO(contract): clip metadata updates (title/visibility) assumed at PUT /clips/:id.
function updateClip(clipId, fields, opts = {}) {
    return request('PUT', `/clips/${clipId}`, { body: fields, ...opts });
}

function deleteClip(clipId, opts = {}) {
    return request('DELETE', `/clips/${clipId}`, opts);
}

/** Ask Media to re-cut a clip whose cut failed. */
function recutClip(clipId, opts = {}) {
    return request('POST', `/clips/${clipId}/recut`, opts);
}

// ── Pastes ───────────────────────────────────────────────────────────────────

/**
 * POST /pastes { title?, content?, language?, user_id?, visibility?, screenshot (multipart)? }
 * → { id, slug, url }. Pass `screenshot` as Buffer or {buffer, filename, contentType}.
 */
function createPaste({ screenshot, ...fields } = {}, opts = {}) {
    if (screenshot) {
        const fd = _formData(fields, screenshot, 'screenshot');
        return request('POST', '/pastes', { body: fd, timeoutMs: 60000, ...opts });
    }
    return request('POST', '/pastes', { body: fields, ...opts });
}

async function getPaste(slug, opts = {}) {
    const out = await request('GET', `/pastes/${encodeURIComponent(slug)}`, opts);
    return (out && out.paste) || out;   // Media wraps single pastes as { paste }
}

function listPastes(query = {}, opts = {}) {
    return request('GET', '/pastes', { query, ...opts });
}

/** Pastes awaiting AI analysis (app-key only on Media). */
function listPastesNeedingAi(limit = 5, opts = {}) {
    return request('GET', '/pastes', { query: { needs_ai: 1, limit }, ...opts });
}

/** Write AI results back to a paste. */
function setPasteAi(slug, { ai_summary, ai_tags } = {}, opts = {}) {
    return request('POST', `/pastes/${encodeURIComponent(slug)}/ai`, { body: { ai_summary, ai_tags }, ...opts });
}

function deletePaste(slug, opts = {}) {
    return request('DELETE', `/pastes/${encodeURIComponent(slug)}`, opts);
}

// ── Files ────────────────────────────────────────────────────────────────────

/** POST /files (multipart) → { key, url, size, mime } */
function uploadFile(file, fields = {}, opts = {}) {
    const fd = _formData(fields, file, 'file');
    return request('POST', '/files', { body: fd, timeoutMs: 120000, ...opts });
}

function getFileMeta(key, opts = {}) {
    return request('GET', `/files/${encodeURIComponent(key)}`, opts);
}

function deleteFile(key, opts = {}) {
    return request('DELETE', `/files/${encodeURIComponent(key)}`, opts);
}

// ── Thumbnails ───────────────────────────────────────────────────────────────

/** POST /thumbnails/:kind/:id with an image buffer (upload) → { url } */
function uploadThumbnail(kind, id, image, opts = {}) {
    const fd = _formData({}, image, 'thumbnail');
    return request('POST', `/thumbnails/${kind}/${id}`, { body: fd, timeoutMs: 60000, ...opts });
}

/** POST /thumbnails/:kind/:id with no body (generate server-side) → { url } */
function generateThumbnail(kind, id, opts = {}) {
    return request('POST', `/thumbnails/${kind}/${id}`, opts);
}

// ── Public URL builders (MEDIA_PUBLIC_URL) ───────────────────────────────────

function vodPlaybackUrl(id) { return `${MEDIA_PUBLIC_URL}/v/${id}`; }
function clipUrl(id) { return `${MEDIA_PUBLIC_URL}/c/${id}`; }
function pasteUrl(slug) { return `${MEDIA_PUBLIC_URL}/p/${encodeURIComponent(slug)}`; }
function pasteRawUrl(slug) { return `${MEDIA_PUBLIC_URL}/p/${encodeURIComponent(slug)}/raw`; }
function thumbUrl(id) { return `${MEDIA_PUBLIC_URL}/t/${id}`; }
function fileUrl(key) { return `${MEDIA_PUBLIC_URL}/f/${key}`; }
// TODO(contract): paste screenshots have no explicit public route in the contract;
// legacy /data/pastes/screenshots/<name> URLs are mapped onto the files route.
function screenshotUrl(filename) { return `${MEDIA_PUBLIC_URL}/f/screenshots/${encodeURIComponent(filename)}`; }

/** Absolute-ize a Media-relative URL (e.g. thumbnail_url from an API response). */
function publicUrl(u) {
    if (!u) return null;
    if (/^https?:\/\//i.test(u)) return u;
    return `${MEDIA_PUBLIC_URL}${u.startsWith('/') ? '' : '/'}${u}`;
}

// ── Express proxy helper ─────────────────────────────────────────────────────

/**
 * Stream a request through to Media and pipe the response back. Preserves method,
 * query string, JSON body and content-type. Used by the thin /api/* proxy routers.
 * `userToken` (Network JWT) is forwarded when present so Media applies user ACLs;
 * otherwise the app key is used.
 */
async function proxy(req, res, apiPath, { userToken, method, query, body } = {}) {
    const m = method || req.method;
    const url = `${API_BASE}${apiPath}${_qs({ ...(req.query || {}), ...(query || {}) })}`;
    const headers = { Accept: 'application/json', ..._authHeader({ userToken }) };
    const opts = { method: m, headers };
    if (!['GET', 'HEAD'].includes(m)) {
        const ct = req.headers['content-type'] || '';
        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        } else if (ct.includes('application/json')) {
            headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(req.body || {});
        } else if (req.rawBody) {
            headers['Content-Type'] = ct || 'application/octet-stream';
            opts.body = req.rawBody;
        }
    }
    let upstream;
    try {
        upstream = await fetch(url, opts);
    } catch (err) {
        console.warn(`[MediaClient] proxy failed (${m} ${apiPath}):`, err.message);
        return res.status(502).json({ error: 'Media service unavailable' });
    }
    res.status(upstream.status);
    const passHeaders = ['content-type', 'cache-control', 'content-disposition', 'etag', 'x-robots-tag'];
    for (const h of passHeaders) {
        const v = upstream.headers.get(h);
        if (v) res.set(h, v);
    }
    if (!upstream.body) return res.end();
    const { Readable } = require('stream');
    Readable.fromWeb(upstream.body).pipe(res);
}

/** Extract the caller's Network JWT (for user-context forwarding to Media). */
function userTokenFrom(req) {
    try {
        const { extractToken } = require('./auth/auth');
        const tok = extractToken(req);
        // Only forward real JWTs — hbt_ API tokens are Live-local.
        if (tok && !tok.startsWith('hbt_')) return tok;
    } catch { /* */ }
    return null;
}

module.exports = {
    MEDIA_URL, MEDIA_PUBLIC_URL, MEDIA_APP_ID,
    MediaApiError,
    request, proxy, userTokenFrom, _formData,
    // vods
    createVod, ingestRtmp, ingestRtpStart, ingestRtpStop,
    uploadVodChunk, completeVodChunks, finalizeVod,
    getVod, listVods, updateVod, deleteVod,
    // clips
    createClip, getClip, listClips, updateClip, deleteClip, recutClip,
    // pastes
    createPaste, getPaste, listPastes, listPastesNeedingAi, setPasteAi, deletePaste,
    // files + thumbnails
    uploadFile, getFileMeta, deleteFile,
    uploadThumbnail, generateThumbnail,
    // URL builders
    vodPlaybackUrl, clipUrl, pasteUrl, pasteRawUrl, thumbUrl, fileUrl, screenshotUrl, publicUrl,
};
