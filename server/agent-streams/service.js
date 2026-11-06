'use strict';
/**
 * Agent streams (the Agent Streams plan S1, design 2026-11-06).
 *
 * An agent stream is one `managed_streams` row of kind 'agent' (public id ags_<ULID>) plus one `agent_streams` row for
 * the agent-only facts, and an ordinary `streams` row while it is live — the same one the WHIP ingest and the player
 * use. Everything here is about that pair and its two tickets:
 *
 *   - a publish ticket (`wpt_`, four hours) lets a desk publish by WHIP. Only its sha256 is stored. Renewing replaces
 *     it; revoking it ends the WHIP session, which is the kill switch.
 *   - a view ticket (`wvt_`, ten minutes, renewed while the page is open) lets a player join a private or unlisted
 *     stream. It is minted for the owner, for somebody the sharing system allows (service live, kind agent-stream), or
 *     for the holder of the unlisted link's secret.
 *
 * Visibility is enforced at the routes (this file's `mayView`) and again at the watch socket
 * (server/streaming/broadcast-server.js), so a page that forgets its ticket still shows nothing.
 */
const crypto = require('crypto');
const config = require('../config');
const db = require('../db/database');
const contracts = require('openvibe-contracts');
const identity = require('../auth/identity-sync');
const sharing = require('./sharing');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const AGENT_ID_RE = /^ags_[0-9A-HJKMNP-TV-Z]{26}$/;
const VISIBILITIES = ['private', 'unlisted', 'public'];
const MODES = ['watch', 'narrated', 'copilot', 'chatplays'];
const TASK_SOURCES = ['codes', 'actor', 'desk', 'node'];
const CURTAIN_REASONS = ['password_field', 'secret_file', 'env_print', 'manual', 'site', 'detector'];
const PUBLISH_TICKET_TTL_MS = 4 * 60 * 60 * 1000;
const VIEW_TICKET_TTL_MS = 10 * 60 * 1000;
const MAX_FRAME_BYTES = 200 * 1024;
const SHARE_KIND = 'agent-stream';

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const token = (prefix, bytes = 32) => prefix + crypto.randomBytes(bytes).toString('base64url');
const agentId = () => 'ags_' + contracts.ids.ulid();
const linkSecret = () => crypto.randomBytes(16).toString('base64url').slice(0, 22);

/** A timestamp for the contract: Date, ISO text or the database's text form → ISO, or null. */
function iso(value) {
    if (value == null || value === '') return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    const d = new Date(String(value).includes('T') ? value : `${String(value).replace(' ', 'T')}Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The public page address, with the unlisted link's secret for its owner. */
function pageUrl(stream) {
    const base = String(config.baseUrl || 'https://openvibe.live').replace(/\/+$/, '');
    const user = encodeURIComponent(stream.username || '');
    return `${base}/@${user}/agents/${stream.public_id}`;
}

/** The WHIP ingest address the desk publishes to. */
function whipUrl(publicId) {
    const base = String(config.whip?.publicUrl || 'https://whip.openvibe.live').replace(/\/+$/, '');
    return `${base}/whip/agent/${publicId}`;
}

function frameUrl(publicId) {
    const base = String(config.baseUrl || 'https://openvibe.live').replace(/\/+$/, '');
    return `${base}/api/streams/agent/${publicId}/frame`;
}

/** The share ref the sharing system knows this stream by (openvibe-sdk/share, service live). */
function shareRef(publicId) { return { service: 'live', kind: SHARE_KIND, id: publicId }; }

// ── Reading one stream ─────────────────────────────────────────

const SELECT = `
    SELECT ms.id AS managed_stream_id, ms.public_id, ms.user_id, ms.title, ms.channel_id, ms.kind,
           ms.created_at AS slot_created_at,
           a.task, a.visibility, a.mode, a.state, a.curtain_up, a.curtain_since, a.curtain_reason,
           a.started_at, a.ended_at, a.worked_seconds, a.last_frame_path, a.last_frame_at, a.vod_id, a.allow_sites,
           a.unlisted_secret_hash,
           (SELECT s.id FROM streams s WHERE s.managed_stream_id = ms.id AND s.is_live = 1 ORDER BY s.started_at DESC LIMIT 1) AS live_session_id,
           (SELECT la.subject_id FROM linked_accounts la WHERE la.service = 'network' AND la.user_id = ms.user_id) AS owner_subject,
           u.username, u.display_name, u.avatar_url, u.profile_color, u.is_banned, u.is_owner
    FROM managed_streams ms
    JOIN agent_streams a ON a.managed_stream_id = ms.id
    JOIN users u ON u.id = ms.user_id`;

async function getByPublicId(publicId) {
    if (!AGENT_ID_RE.test(String(publicId || ''))) return null;
    return await db.get(`${SELECT} WHERE ms.public_id = ?`, [publicId]) || null;
}

async function getByManagedStreamId(managedStreamId) {
    return await db.get(`${SELECT} WHERE ms.id = ?`, [managedStreamId]) || null;
}

/** The live `streams` row of this agent stream, if one is up. */
async function liveSession(managedStreamId) {
    return await db.get('SELECT id, started_at FROM streams WHERE managed_stream_id = ? AND is_live = 1 ORDER BY started_at DESC LIMIT 1', [managedStreamId]) || null;
}

async function listByUser(userId) {
    return await db.all(`${SELECT} WHERE ms.user_id = ? ORDER BY a.created_at DESC`, [userId]);
}

/** Live agent streams of an account (the slot rule counts these, not the normal ones). */
async function countLiveByUser(userId) {
    return Number((await db.get("SELECT COUNT(*) AS n FROM agent_streams a JOIN managed_streams ms ON ms.id = a.managed_stream_id WHERE ms.user_id = ? AND a.state = 'live'", [userId]))?.n || 0);
}

/** How many agent streams a person may have live at once: one, or five for Live's owner. */
function liveLimit(user) { return user && user.is_owner ? 5 : 1; }

/** The owner's Network subject, or null for an account Network has never named. */
async function ownerSubject(userId) { return await identity.subjectOf(userId); }

/** Viewers watching now: the sockets attached to the stream's live session, plus any WHEP player. */
function viewersNow(sessionId) {
    if (!sessionId) return 0;
    let sockets = 0;
    try {
        const room = require('../streaming/broadcast-server').rooms.get(Number(sessionId));
        sockets = room ? room.viewers.size : 0;
    } catch { /* no socket server in a test */ }
    let whep = 0;
    try { whep = require('../streaming/whep-handler').countForStream(sessionId); } catch { /* WHEP optional */ }
    return sockets + whep;
}

/** How long the agent has worked: up to now while live, the stored total once ended. */
function workedSeconds(row) {
    if (row.state === 'live' && row.started_at) {
        const started = Date.parse(iso(row.started_at));
        if (Number.isFinite(started)) return Math.max(0, Math.round((Date.now() - started) / 1000));
    }
    return Math.max(0, Number(row.worked_seconds) || 0);
}

/**
 * The resource (live.agent-stream@1) as its owner or a viewer may see it. A viewer never learns the curtain's reason
 * or the unlisted link's secret.
 */
function publicView(row) {
    return {
        id: row.public_id,
        owner: row.owner_subject || null,
        channel: row.username,
        title: row.title,
        task: typeof row.task === 'string' ? JSON.parse(row.task) : (row.task || {}),
        visibility: row.visibility,
        mode: row.mode,
        state: row.state,
        curtain: {
            up: !!Number(row.curtain_up),
            ...(Number(row.curtain_up) && row.curtain_since ? { since: iso(row.curtain_since) } : {}),
        },
        viewers: viewersNow(row.live_session_id),
        started_at: iso(row.started_at),
        ended_at: iso(row.ended_at),
        worked_seconds: workedSeconds(row),
        last_frame_url: row.last_frame_path ? frameUrl(row.public_id) : null,
        vod_id: row.vod_id || null,
        page_url: pageUrl(row),
        label: 'AI agent',
    };
}

// ── Creating ───────────────────────────────────────────────────

/**
 * Create the slot and its agent row. The caller has already validated the body and checked the live limit and the
 * owner's subject. Returns the joined row.
 *
 * `visibility` 'unlisted' gets a link secret here; only its sha256 is stored, and the raw secret is returned once.
 */
async function create({ user, title, task, visibility = 'private', allowSites = [], mode = 'watch' }) {
    const subject = await ownerSubject(user.id);
    if (!SUBJECT_RE.test(String(subject || ''))) {
        const err = new Error('this account has no OpenVibe subject yet; sign in again');
        err.status = 409; err.code = 'identity.no_subject';
        throw err;
    }
    const channel = await db.ensureChannel(user.id);
    const publicId = agentId();
    const secret = visibility === 'unlisted' ? linkSecret() : null;
    const labels = JSON.stringify({ labels: [], suggested: [] });
    const result = await db.getDb().tx(async () => {
        const slot = await db.run(
            `INSERT INTO managed_streams (user_id, channel_id, slug, title, description, category, protocol, streaming_method, stream_key, is_nsfw, content_labels, kind, public_id)
             VALUES (?, ?, NULL, ?, '', NULL, 'webrtc', 'whip', NULL, 0, ?, 'agent', ?) RETURNING id`,
            [user.id, channel.id, String(title).slice(0, 200), labels, publicId]
        );
        await db.run(
            `INSERT INTO agent_streams (managed_stream_id, task, visibility, mode, state, allow_sites, unlisted_secret_hash)
             VALUES (?, ?::jsonb, ?, ?, 'idle', ?::jsonb, ?)`,
            [slot.lastInsertRowid, JSON.stringify(task), visibility, mode, JSON.stringify(allowSites || []), secret ? sha256(secret) : null]
        );
        return slot.lastInsertRowid;
    });
    const row = await getByManagedStreamId(result);
    if (secret) row.unlisted_secret = secret;   // the one time the raw link secret exists outside the page
    await sharing.register(row);
    return row;
}

// ── State changes ──────────────────────────────────────────────

/**
 * One change to an agent stream, and its event. Runs in one transaction so the outbox row exists if and only if the
 * change committed. `field` is the `agent_streams` column list to write.
 */
async function update(row, { set = {}, event = null }) {
    const names = Object.keys(set);
    if (!names.length) return;
    const env = event ? {
        event_type: 'live.agent_stream.changed',
        actor: row.owner_subject ? { type: 'user', id: row.owner_subject } : { type: 'service', id: 'live' },
        subject: { type: 'agent_stream', id: row.public_id },
        visibility: row.visibility === 'public' ? 'public' : 'internal',
        priority: event.kind === 'started' || event.kind === 'ended' ? 'important' : 'normal',
        payload: { stream_id: row.public_id, kind: event.kind, at: new Date().toISOString(), ...(event.extra || {}) },
    } : null;
    let outbox;
    await db.getDb().tx(async () => {
        await db.run(
            `UPDATE agent_streams SET ${names.map((n) => `${n} = ?`).join(', ')}, updated_at = now() WHERE managed_stream_id = ?`,
            [...names.map((n) => set[n]), row.managed_stream_id]
        );
        if (env) outbox = await require('../events/stream-events').enqueue(env);
    });
    if (outbox) require('../events/stream-events').kick();
    return await getByManagedStreamId(row.managed_stream_id);
}

/** The publish session attached (the WHIP POST asked for a stream): state live, start the work clock. */
async function markPublishing(row) {
    if (row.state === 'live') return row;
    return await update(row, {
        set: { state: 'live', started_at: row.started_at || new Date(), ended_at: null },
        event: { kind: 'started' },
    });
}

/** The stream ended. Worked seconds are frozen, the session (if any) and every publish ticket go. */
let reportClient = null;
/** Live's client for OpenVibe.Report (the session report of an agent stream). */
function reportClientFor() {
    if (!reportClient) reportClient = require('../report').createReportClient({ config, log: console });
    return reportClient;
}

async function end(row, { reason = 'ended' } = {}) {
    if (row.state === 'ended') return row;
    const session = await liveSession(row.managed_stream_id);
    const now = new Date();
    const started = iso(row.started_at);
    const worked = started ? Math.max(0, Math.round((now.getTime() - Date.parse(started)) / 1000)) : workedSeconds(row);
    const current = await getByManagedStreamId(row.managed_stream_id);
    const next = await update(current, {
        set: { state: 'ended', ended_at: now, worked_seconds: worked, curtain_up: 0, curtain_since: null, curtain_reason: null },
        event: { kind: 'ended', extra: { reason } },
    });
    await require('./tickets').revokeAll(row.managed_stream_id);
    if (session) {
        try {
            const whip = require('../streaming/whip-handler');
            await whip.endSessionsForStream(session.id, 'agent_ended');
            await whip.endActiveWhipStream(session.id, reason);
        } catch (err) { console.warn(`[AgentStream] ending session ${session.id} failed: ${err.message}`); }
    }
    try { require('../streaming/curtains').lower(session ? session.id : null, { notify: false }); } catch { /* */ }
    // Agent Streams S3: the stream part of the session report. The report the tool wrote for this task gets the
    // stream added to it; when no tool finished the session, a stream-only report is written instead. A report that
    // cannot be written never changes the stream: it ended either way.
    try {
        await reportClientFor().sendStream({
            source: (row.task && row.task.source) || 'desk',
            task_ref: (row.task && row.task.ref) || null,
            ags_id: row.public_id,
            vod_id: row.vod_id || null,
            owner: row.owner_subject || null,
            task: {
                title: (row.task && row.task.title) || row.title || 'An agent session',
                ref: (row.task && row.task.ref) || row.public_id,
                url: (row.task && row.task.url) || null,
            },
            started_at: row.started_at || null,
            ended_at: next.ended_at || null,
            worked_seconds: worked,
            visibility: row.visibility || 'private',
        });
    } catch (err) {
        console.warn('[AgentStream] the session report of ' + row.public_id + ' failed: ' + String((err && err.message) || err).slice(0, 200));
    }
    return next;
}

async function setVisibility(row, visibility) {
    if (!VISIBILITIES.includes(visibility)) return null;
    const secret = visibility === 'unlisted' && !row.unlisted_secret_hash ? linkSecret() : null;
    const next = await update(row, {
        set: { visibility, ...(secret ? { unlisted_secret_hash: sha256(secret) } : {}) },
        event: { kind: 'visibility', extra: { visibility } },
    });
    await sharing.setAudience(row, visibility);
    if (secret) next.unlisted_secret = secret;
    return next;
}

/** A fresh unlisted link secret: the old links stop working at once. */
async function rotateLink(row) {
    const secret = linkSecret();
    await update(row, { set: { unlisted_secret_hash: sha256(secret) } });
    return secret;
}

/** The desk's curtain. Returns the updated row; `event` is the public change (the reason stays here). */
async function setCurtain(row, up, reason) {
    if (up) {
        if (Number(row.curtain_up)) return await getByManagedStreamId(row.managed_stream_id);
        return await update(row, {
            set: { curtain_up: 1, curtain_since: new Date(), curtain_reason: CURTAIN_REASONS.includes(reason) ? reason : 'detector' },
            event: { kind: 'curtain', extra: { curtain: { up: true } } },
        });
    }
    if (!Number(row.curtain_up)) return await getByManagedStreamId(row.managed_stream_id);
    return await update(row, {
        set: { curtain_up: 0, curtain_since: null, curtain_reason: null },
        event: { kind: 'curtain', extra: { curtain: { up: false } } },
    });
}

/**
 * Store the desk's last frame (JPEG or WebP, at most 200 KB). The file is replaced atomically, so a reader never sees a
 * half-written picture. Returns false for a body that is neither.
 */
async function setFrame(row, bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_FRAME_BYTES) return false;
    const jpeg = bytes.length > 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
    const webp = bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!jpeg && !webp) return false;
    const frames = require('./frames');
    const name = `${row.public_id}.${webp ? 'webp' : 'jpg'}`;
    await frames.write(name, bytes);
    await db.run('UPDATE agent_streams SET last_frame_path = ?, last_frame_at = now(), updated_at = now() WHERE managed_stream_id = ?', [name, row.managed_stream_id]);
    return true;
}

async function setVod(row, vodId) {
    if (!vodId || row.vod_id === String(vodId)) return;
    await db.run('UPDATE agent_streams SET vod_id = ?, updated_at = now() WHERE managed_stream_id = ?', [String(vodId), row.managed_stream_id]);
}

// ── Who may watch ──────────────────────────────────────────────

/**
 * Whether this viewer may watch this stream. `secret` is the page's ?k= value (unlisted links). The owner always may;
 * a public stream is open; an unlisted one needs the link's secret; a private one the sharing system's answer.
 */
async function mayView(row, { viewer = null, secret = null } = {}) {
    if (viewer && Number(viewer.id) === Number(row.user_id)) return true;
    if (row.visibility === 'public') return true;
    if (row.visibility === 'unlisted') {
        if (!secret || !row.unlisted_secret_hash) return false;
        return secureEqual(sha256(secret), row.unlisted_secret_hash);
    }
    if (!viewer) return false;
    const subject = await ownerSubject(viewer.id);
    if (!SUBJECT_RE.test(String(subject || ''))) return false;
    return await sharing.canView(shareRef(row.public_id), { subject: { type: 'user', id: subject } });
}

/** The unlisted link's secret matches (constant time). */
function secureEqual(a, b) {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

module.exports = {
    AGENT_ID_RE, VISIBILITIES, MODES, TASK_SOURCES, CURTAIN_REASONS, SHARE_KIND,
    PUBLISH_TICKET_TTL_MS, VIEW_TICKET_TTL_MS, MAX_FRAME_BYTES,
    sha256, token, agentId, iso, pageUrl, whipUrl, shareRef,
    getByPublicId, getByManagedStreamId, liveSession, listByUser, countLiveByUser, liveLimit, ownerSubject,
    viewersNow, workedSeconds, publicView,
    create, update, markPublishing, end, setVisibility, rotateLink, setCurtain, setFrame, setVod,
    mayView,
};
