/**
 * OpenVibe.Live — OpenVibe.Media API v1 client
 *
 * Server-side client for the OpenVibe.Media service (see OpenVibers/CONTRACTS.md,
 * "Media API v1"). All VOD / clip / paste / file / thumbnail storage and processing
 * lives in Media now; Live talks to it via this module.
 *
 * Auth: `Authorization: Bearer <service token>`. Live authenticates to Media with its own
 * Network service principal (client credentials for audience openvibe.media; grants
 * media.object.read/list/upload/delete on namespace live), the same construction
 * server/openre/openre-client.js uses for OpenRestream. For a request made on behalf of a browser
 * user, add `actingUser` (their LIVE-LOCAL user id) — Media then applies that user's ACLs and
 * stores their id. See _authHeader for why the id is sent explicitly rather than left for
 * Media to read out of the caller's Network JWT.
 *
 * Env:
 *   MEDIA_URL               internal base URL     (default http://127.0.0.1:4100)
 *   MEDIA_PUBLIC_URL        public serving base   (default https://openvibe.media)
 *   MEDIA_APP_ID            tenant/app id         (default live)
 *   OV_NETWORK_INTERNAL_URL token endpoint base   (default http://127.0.0.1:4000)
 *   OV_OAUTH_CLIENT_ID      OAuth client id       (default live)
 *   OV_OAUTH_CLIENT_SECRET  OAuth client secret   (unset = no Authorization header)
 */
'use strict';

const { createServiceTokenClient } = require('openvibe-sdk/auth');

const MEDIA_URL = (process.env.MEDIA_URL || 'http://127.0.0.1:4100').replace(/\/+$/, '');
const MEDIA_PUBLIC_URL = (process.env.MEDIA_PUBLIC_URL || 'https://openvibe.media').replace(/\/+$/, '');
const MEDIA_APP_ID = process.env.MEDIA_APP_ID || 'live';
const MEDIA_AUDIENCE = 'openvibe.media';

const API_BASE = `${MEDIA_URL}/api/v1/${MEDIA_APP_ID}`;
const API_V2_BASE = `${MEDIA_URL}/api/v2/${MEDIA_APP_ID}`;   // media jobs (GET /jobs/:id)

class MediaApiError extends Error {
    constructor(message, status, body) {
        super(message);
        this.name = 'MediaApiError';
        this.status = status || 0;
        this.body = body || null;
    }
}

/**
 * Authenticate to Media as this app, optionally acting as one of our users.
 *
 * We used to forward the caller's Network JWT instead, and let Media read the identity
 * out of it. That was wrong: the JWT's `sub` is the NETWORK's id for the account, while
 * every user_id Media stores for us is a LIVE-LOCAL id. The two spaces overlap by
 * coincidence, so a comment posted by Maticus (local 80, network 57) was filed under
 * user 57 and rendered as fakefitz — and the same mismatch decided who could open a
 * private paste or VOD. Sending the local id explicitly keeps one id space end to end.
 *
 * The credential is Live's own Network service token (audience openvibe.media), fetched lazily
 * and cached; when no client secret is configured there is none, and no Authorization is sent.
 */
async function _authHeader(opts = {}) {
    const h = {};
    const client = serviceTokens();
    if (client) h.Authorization = `Bearer ${await client.getToken()}`;
    if (opts.actingUser != null) h['X-OV-User-Id'] = String(opts.actingUser);
    return h;
}

/**
 * The Network service principal for audience openvibe.media, built once and shared (the SDK caches
 * one token per audience, refreshed 60 s before expiry). Null when unconfigured, and under
 * LIVE_DRILL — a restore drill fetches nothing. Nothing is fetched at module load: this is lazy.
 */
let tokens = null;
function serviceTokens() {
    if (tokens) return tokens;
    const clientSecret = process.env.OV_OAUTH_CLIENT_SECRET || '';
    if (!clientSecret || require('./drill').enabled) return null;
    const networkInternalUrl = String(process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
    tokens = createServiceTokenClient({
        tokenUrl: `${networkInternalUrl}/oauth/token`,
        clientId: process.env.OV_OAUTH_CLIENT_ID || 'live',
        clientSecret,
        audience: MEDIA_AUDIENCE,
    });
    return tokens;
}

/** Drop the cached service-token client (tests flip the OAuth env): the next call rebuilds it. */
function _reset() { tokens = null; }

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
async function request(method, apiPath, { body, query, actingUser, headers = {}, timeoutMs = 30000, base = API_BASE } = {}) {
    const auth = await _authHeader({ actingUser });
    const url = `${base}${apiPath}${_qs(query)}`;
    const opts = {
        method,
        headers: { Accept: 'application/json', ...auth, ...headers },
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
    let text = '';
    try {
        res = await fetch(url, opts);
        // The deadline has to cover reading the body, not just receiving the headers.
        //
        // clearTimeout used to sit in a `finally` attached to the fetch() await, so the timer was
        // cancelled and the abort signal disarmed the moment headers arrived. Reading the body
        // then had no deadline at all: an upstream that responds and then stalls mid-body pinned
        // this handler — and whatever request was waiting on it — indefinitely. Consuming the body
        // inside the same guarded region means one deadline covers the whole exchange.
        text = await res.text().catch(() => '');
    } catch (err) {
        const aborted = err && (err.name === 'AbortError' || ctrl.signal.aborted);
        throw new MediaApiError(
            aborted
                ? `Media timed out after ${timeoutMs}ms (${method} ${apiPath})`
                : `Media unreachable (${method} ${apiPath}): ${err.message}`,
            0, null);
    } finally {
        clearTimeout(timer);
    }
    let json = null;
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
async function createVod({ title, stream_id, stream_key, managed_stream_id, user_id, meta, visibility, clips_only } = {}, opts = {}) {
    return await request('POST', '/vods', { body: { title, stream_id, stream_key, managed_stream_id, user_id, meta, visibility, clips_only }, ...opts });
}

/** POST /vods/:id/ingest/rtmp { rtmp_url } → 202 (Media pulls the RTMP URL with ffmpeg) */
async function ingestRtmp(vodId, rtmpUrl, opts = {}) {
    return await request('POST', `/vods/${vodId}/ingest/rtmp`, { body: { rtmp_url: rtmpUrl }, ...opts });
}

/**
 * POST /vods/:id/ingest/rtp/start { video:{payloadType,codec,clockRate}, audio:{...} }
 * → { videoPort, audioPort } (UDP 12000-12199 on 127.0.0.1 — point PlainRtpTransports there)
 */
async function ingestRtpStart(vodId, { video, audio } = {}, opts = {}) {
    return await request('POST', `/vods/${vodId}/ingest/rtp/start`, { body: { video, audio }, ...opts });
}

/** POST /vods/:id/ingest/rtp/stop → finalizes the recording */
async function ingestRtpStop(vodId, opts = {}) {
    return await request('POST', `/vods/${vodId}/ingest/rtp/stop`, opts);
}

/** POST /vods/:id/chunks (multipart) — browser MediaRecorder chunk upload path */
async function uploadVodChunk(vodId, chunk, fields = {}, opts = {}) {
    const fd = _formData(fields, chunk, 'chunk');
    return await request('POST', `/vods/${vodId}/chunks`, { body: fd, timeoutMs: 120000, ...opts });
}

/** POST /vods/:id/chunks/complete */
async function completeVodChunks(vodId, opts = {}) {
    return await request('POST', `/vods/${vodId}/chunks/complete`, opts);
}

/** POST /vods/:id/finalize → close recording, kick off thumbnail + probe */
async function finalizeVod(vodId, opts = {}) {
    return await request('POST', `/vods/${vodId}/finalize`, opts);
}

/** GET /vods/:id → { id, title, status, duration, playback_url, thumbnail_url, storage_provider, ... } */
async function getVod(vodId, opts = {}) {
    return await request('GET', `/vods/${vodId}`, opts);
}

/**
 * GET /vods/:id/signed-url or /clips/:id/signed-url → { url, expires_at }: a short-lived URL of the recording's bytes
 * that works whatever its visibility, for a reader with no key (OpenVibe.AI transcribing it). ttl in seconds (≤ 6 h).
 */
async function signedMediaUrl(kind, id, ttlS = 3600, opts = {}) {
    return await request('GET', `/${kind === 'clip' ? 'clips' : 'vods'}/${id}/signed-url`, { query: { ttl: ttlS }, ...opts });
}

/** GET /vods?limit&offset (+ pass-through filters like username/user_id/stream_id) */
async function listVods(query = {}, opts = {}) {
    return await request('GET', '/vods', { query, ...opts });
}

/** PUT /vods/:id { title?, is_public?, visibility?, ... } — metadata update (inherited shape). */
// TODO(contract): the contract only spells out create/get/list/delete for VODs; the
// metadata update verb is assumed to be PUT /vods/:id like the inherited routes.
async function updateVod(vodId, fields, opts = {}) {
    return await request('PUT', `/vods/${vodId}`, { body: fields, ...opts });
}

/** DELETE /vods/:id */
async function deleteVod(vodId, opts = {}) {
    return await request('DELETE', `/vods/${vodId}`, opts);
}

// ── Clips ────────────────────────────────────────────────────────────────────

/** POST /clips { vod_id, start_s, end_s, title?, user_id? } → { id, status } */
/** A media job of this app (e.g. a clip's clip.cut, whose id createClip/recutClip answer) → { job } */
async function getJob(jobId, opts = {}) {
    return await request('GET', `/jobs/${encodeURIComponent(jobId)}`, { ...opts, base: API_V2_BASE });
}

async function createClip({ vod_id, start_s, end_s, title, user_id, ...extra } = {}, opts = {}) {
    return await request('POST', '/clips', { body: { vod_id, start_s, end_s, title, user_id, ...extra }, ...opts });
}

async function getClip(clipId, opts = {}) {
    return await request('GET', `/clips/${clipId}`, opts);
}

async function listClips(query = {}, opts = {}) {
    return await request('GET', '/clips', { query, ...opts });
}

// TODO(contract): clip metadata updates (title/visibility) assumed at PUT /clips/:id.
async function updateClip(clipId, fields, opts = {}) {
    return await request('PUT', `/clips/${clipId}`, { body: fields, ...opts });
}

async function deleteClip(clipId, opts = {}) {
    return await request('DELETE', `/clips/${clipId}`, opts);
}

/** Ask Media to re-cut a clip whose cut failed. */
async function recutClip(clipId, opts = {}) {
    return await request('POST', `/clips/${clipId}/recut`, opts);
}

// ── Files ────────────────────────────────────────────────────────────────────

/** POST /files (multipart) → { key, url, size, mime } */
async function uploadFile(file, fields = {}, opts = {}) {
    const fd = _formData(fields, file, 'file');
    return await request('POST', '/files', { body: fd, timeoutMs: 120000, ...opts });
}

async function getFileMeta(key, opts = {}) {
    return await request('GET', `/files/${encodeURIComponent(key)}`, opts);
}

async function deleteFile(key, opts = {}) {
    return await request('DELETE', `/files/${encodeURIComponent(key)}`, opts);
}

// ── Thumbnails ───────────────────────────────────────────────────────────────

/** POST /thumbnails/:kind/:id with an image buffer (upload) → { url } */
async function uploadThumbnail(kind, id, image, opts = {}) {
    const fd = _formData({}, image, 'thumbnail');
    return await request('POST', `/thumbnails/${kind}/${id}`, { body: fd, timeoutMs: 60000, ...opts });
}

/** POST /thumbnails/:kind/:id with no body (generate server-side) → { url } */
async function generateThumbnail(kind, id, opts = {}) {
    return await request('POST', `/thumbnails/${kind}/${id}`, opts);
}

// ── Public URL builders (MEDIA_PUBLIC_URL) ───────────────────────────────────

function vodPlaybackUrl(id) { return `${MEDIA_PUBLIC_URL}/v/${id}`; }
function clipUrl(id) { return `${MEDIA_PUBLIC_URL}/c/${id}`; }
function pasteScreenshotUrl(slug) { return `${MEDIA_PUBLIC_URL}/p/${encodeURIComponent(slug)}/screenshot`; }
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
 * Pass `actingUser` (a Live-local user id) to have Media apply that user's ACLs;
 * omit it for an anonymous call.
 */
async function proxy(req, res, apiPath, { actingUser, method, query, body } = {}) {
    const m = method || req.method;
    const url = `${API_BASE}${apiPath}${_qs({ ...(req.query || {}), ...(query || {}) })}`;
    const headers = { Accept: 'application/json', ...(await _authHeader({ actingUser })) };
    // Media applies per-IP comment cooldowns and stores the address for moderation, and
    // it trusts X-Forwarded-For. Without this every browser request arrived as 127.0.0.1
    // — one shared cooldown bucket for the whole site, and an address column that
    // recorded this proxy instead of the commenter.
    if (req.ip) headers['X-Forwarded-For'] = req.ip;
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
    // proxy() had no deadline at all — an unresponsive upstream held the connection, the handler
    // and its socket open indefinitely. This backs pastes, likes, comments and the admin storage
    // routes, so a stalled Media could accumulate stuck handlers until the process ran out.
    // Uploads legitimately take longer than reads, hence the two budgets.
    const isUpload = !['GET', 'HEAD'].includes(m);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), isUpload ? 120000 : 20000);
    opts.signal = ctrl.signal;
    // If the client goes away mid-proxy, stop waiting on the upstream too.
    const onClientGone = () => { try { ctrl.abort(); } catch { /* */ } };
    req.on('aborted', onClientGone);
    res.on('close', onClientGone);
    const cleanup = () => {
        clearTimeout(timer);
        req.off?.('aborted', onClientGone);
        res.off?.('close', onClientGone);
    };

    let upstream;
    try {
        upstream = await fetch(url, opts);
    } catch (err) {
        cleanup();
        const aborted = err && (err.name === 'AbortError' || ctrl.signal.aborted);
        console.warn(`[MediaClient] proxy ${aborted ? 'timed out' : 'failed'} (${m} ${apiPath}):`, err.message);
        if (res.headersSent) return;
        return res.status(504).json({ error: aborted ? 'Media service timed out' : 'Media service unavailable' });
    }
    cleanup();
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

/**
 * The Live-local user id to act as for this request, or null for an anonymous call.
 *
 * Requires the route to have run requireAuth/optionalAuth first — that is what turns a
 * Network JWT or an hbt_ API token into a local account. Both kinds of caller land in
 * the same id space here, which the raw-token forwarding this replaced could not do.
 */
function actingUserFrom(req) {
    const id = req?.user?.id;
    return Number.isInteger(id) && id > 0 ? id : null;
}

module.exports = {
    signedMediaUrl,
    MEDIA_URL, MEDIA_PUBLIC_URL, MEDIA_APP_ID,
    MediaApiError,
    request, proxy, actingUserFrom, _formData, _authHeader, _reset, MEDIA_AUDIENCE,
    // vods
    createVod, ingestRtmp, ingestRtpStart, ingestRtpStop,
    uploadVodChunk, completeVodChunks, finalizeVod,
    getVod, listVods, updateVod, deleteVod,
    // clips
    createClip, getClip, listClips, updateClip, deleteClip, recutClip, getJob,
    // files + thumbnails
    uploadFile, getFileMeta, deleteFile,
    uploadThumbnail, generateThumbnail,
    // URL builders
    vodPlaybackUrl, clipUrl, pasteScreenshotUrl, thumbUrl, fileUrl, screenshotUrl, publicUrl,
};
