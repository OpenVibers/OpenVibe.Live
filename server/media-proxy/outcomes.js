'use strict';
/**
 * OpenVibe.Live — what Live does when OpenVibe.Media reports an outcome.
 *
 * Media reports VOD/clip completions and storage alerts as OpenVibe.Events events: Live subscribes to media.vod.*,
 * media.clip.* and media.storage.* (scripts/subscribe-media-events.js) and Events delivers them to
 * POST /internal/media-events (media-proxy/media-events.js). The direct webhook (/internal/media-webhook) that carried
 * the same outcomes during the Wave 3 transition is gone (2026-10-10): Events had delivered every one of them.
 *
 * Each outcome is applied at most once: every apply claims an inbox receipt (consumer CONSUMER, key
 * "media:<object type>:<object id>:<event id>") in the same transaction as Live's own writes, so an Events redelivery
 * is a no-op. Side effects outside the database (recorder bookkeeping, AI jobs, the ops alert) run after that commit,
 * only for the delivery that applied.
 */
const db = require('../db/database');

const CONSUMER = 'live-media-outcomes';
const EVENT_ID_RE = /^evt_[0-9A-HJKMNP-TV-Z]{26}$/;
const MEDIA_APP_ID = process.env.MEDIA_APP_ID || 'live';

// The outcome name Live acts on → the Events event_type Media publishes for it (media/server/events.js TYPES).
const EVENT_TYPES = {
    'vod.ready': 'media.vod.ready',
    'vod.failed': 'media.vod.failed',
    'clip.ready': 'media.clip.ready',
    'clip.failed': 'media.clip.failed',
    'storage.alert': 'media.storage.alert',
    'storage.recovered': 'media.storage.recovered',
};
const OUTCOME_NAMES = Object.fromEntries(Object.entries(EVENT_TYPES).map(([k, v]) => [v, k]));

const stats = { applied: 0, duplicate: 0 };
let inbox = null;

function ensureInbox() {
    if (inbox) return inbox;
    // The PostgreSQL inbox: the receipt and the apply commit together (its table, idempotency_receipts, is migrated).
    const { createPgInbox } = require('openvibe-sdk/events');
    inbox = createPgInbox(db.getDb());
    return inbox;
}

/** The object an outcome is about, derived exactly as Media derives its event subject. */
function subjectOf(event, data) {
    if (String(event).startsWith('storage.')) return { type: 'storage', id: String((data && data.kind) || 'storage') };
    const type = String(event).startsWith('clip.') ? 'clip' : String(event).startsWith('vod.') ? 'vod' : 'object';
    const id = data && (data.object_id || data.id);
    return { type, id: String(id == null ? 'unknown' : id) };
}

function dedupeKey(eventId, subject) {
    return `media:${subject.type}:${subject.id}:${eventId}`;
}

/**
 * Storage alerts from Media (`storage.alert` / `storage.recovered`). Always logged at
 * error/warn level; additionally posted to an ops webhook when one is configured —
 * OPS_ALERT_WEBHOOK_URL in the environment, or the `ops_alert_webhook_url` admin
 * setting (a Discord-compatible webhook: it receives `{ content }`). This is
 * deliberately separate from the public go-live Discord webhook.
 */
async function relayStorageEvent(event, data = {}) {
    const recovered = event === 'storage.recovered';
    const line = `[MediaOutcome] ${recovered ? 'STORAGE RECOVERED' : 'STORAGE ALERT'} (${data.kind || 'unknown'}): `
        + `disk ${data.disk_pct ?? '?'}%, ${data.free_gb ?? '?'} GB free`
        + (data.hint ? ` — ${data.hint}` : '');
    (recovered ? console.warn : console.error)(line);
    if (!recovered && Array.isArray(data.errors) && data.errors.length) {
        console.error('[MediaOutcome]   first errors:', JSON.stringify(data.errors));
    }

    let url = process.env.OPS_ALERT_WEBHOOK_URL || '';
    if (!url) { try { url = await db.getSetting('ops_alert_webhook_url') || ''; } catch { url = ''; } }
    if (!/^https:\/\/[^\s]+$/i.test(url)) return;

    const content = (recovered ? '✅ **OpenVibe.Media storage recovered**' : '🚨 **OpenVibe.Media storage alert**')
        + `\n${data.kind || 'unknown'} — disk ${data.disk_pct ?? '?'}%, ${data.free_gb ?? '?'} GB free`
        + (data.stalled_passes ? `, ${data.stalled_passes} stalled sweep pass(es)` : '')
        + (data.hint ? `\n${data.hint}` : '')
        + (Array.isArray(data.errors) && data.errors.length ? `\n\`${JSON.stringify(data.errors).slice(0, 300)}\`` : '');
    fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
        signal: AbortSignal.timeout(10000),
    }).catch(err => console.warn('[MediaOutcome] ops alert webhook failed:', err.message));
}

/**
 * Live's database writes for one outcome (synchronous: runs inside the inbox transaction) and the
 * side effects to run after the commit. Returns { outcome, after? }.
 */
async function apply(event, data) {
    data = data || {};
    switch (event) {
        case 'vod.ready': {
            const vodId = data.id;
            if (!vodId) return { outcome: 'ignored' };
            // Seed the Live-owned AI state row (queues transcript/overview work).
            try { await db.setVodTranscriptStatus(vodId, 'pending'); } catch { /* */ }
            // Point the live timeline rows at the VOD so the recording inherits the transcript that
            // was already built while the stream was running — no second transcription.
            try {
                const sid = data.stream_id || data.streamId;
                if (sid) await db.linkTimelineToVod(sid, vodId);
            } catch { /* */ }
            return {
                outcome: 'vod_ready',
                after: async () => {
                    try { require('../streaming/recorder').onVodSettled(vodId); } catch { /* */ }
                    // Kick the on-finalize AI pass right away (both budget-gated).
                    try {
                        const ai = require('../ai/ai-analysis');
                        const vodMeta = { id: vodId, ...data };
                        if (ai.transcriptionEnabled && await ai.transcriptionEnabled()) ai.generateVodTranscript(vodMeta).catch(() => {});
                        if (ai.isEnabled && await ai.isEnabled() && ai.withinBudget && await ai.withinBudget()) ai.generateVodOverview(vodMeta).catch(() => {});
                    } catch { /* backfill poller will pick it up */ }
                    console.log(`[MediaOutcome] VOD ${vodId} ready (${data.duration || data.duration_seconds || '?'}s)`);
                },
            };
        }
        case 'vod.failed': {
            const vodId = data.id;
            if (vodId) { try { await db.setVodTranscriptStatus(vodId, 'failed', data.error || 'media reported failure'); } catch { /* */ } }
            return {
                outcome: 'vod_failed',
                after: () => {
                    if (vodId) { try { require('../streaming/recorder').onVodSettled(vodId); } catch { /* */ } }
                    console.warn(`[MediaOutcome] VOD ${vodId} failed:`, data.error || '(no detail)');
                },
            };
        }
        case 'clip.ready': {
            if (!data.id) return { outcome: 'ignored' };
            // Schedule the chat announce with a grace period (creator titles the clip first); the
            // clip-notify sweeper fires it (survives restarts).
            try { await require('./clip-notify').scheduleClipNotify(data.id); } catch { /* */ }
            try { await db.setClipTranscriptStatus(data.id, 'pending'); } catch { /* */ }
            return {
                outcome: 'clip_ready',
                after: async () => {
                    try {
                        const ai = require('../ai/ai-analysis');
                        if (ai.isEnabled && await ai.isEnabled() && ai.withinBudget && await ai.withinBudget()) {
                            ai.generateClipOverview({ id: data.id, ...data }).catch(() => {});
                        }
                    } catch { /* */ }
                },
            };
        }
        case 'clip.failed':
            if (data.id) { try { await db.setClipTranscriptStatus(data.id, 'failed', data.error || 'media reported failure'); } catch { /* */ } }
            return { outcome: 'clip_failed', after: () => console.warn(`[MediaOutcome] Clip ${data.id} failed:`, data.error || '(no detail)') };
        case 'storage.alert':
        case 'storage.recovered':
            // Media's VOD volume needs a human (drain stalled / disk critical) or is fine again.
            // Recordings are silently refused while this is unresolved, which is why it is loud
            // here and forwarded to the ops channel.
            return { outcome: 'storage', after: async () => await relayStorageEvent(event, data) };
        default:
            return { outcome: 'ignored' };
    }
}

/**
 * Apply one Events delivery's outcome at most once (`eventId` is the Events event id, `subject` the object it is
 * about). Returns { applied, duplicate, outcome }. Throws when Live's writes fail (nothing committed; Events retries).
 */
async function handle({ event, data, eventId, subject = null }) {
    let after = null;
    const run = async () => { const r = await apply(event, data); after = r.after || null; return r.outcome; };
    const out = await ensureInbox().once(CONSUMER, dedupeKey(eventId, subject || subjectOf(event, data)), run);
    if (out.duplicate) {
        stats.duplicate++;
        return { applied: false, duplicate: true };
    }
    stats.applied++;
    if (after) { try { await after(); } catch (e) { console.warn('[MediaOutcome] post-commit step failed:', e.message); } }
    // A VOD or clip that became ready (or failed) changes what OpenVibe.Search should hold for its page.
    const kind = /^(vod|clip)\.(ready|failed)$/.exec(String(event));
    if (kind && data && data.id != null) { try { require('../events/search-media-documents').touchLater(kind[1], data.id); } catch { /* search is optional */ } }
    return { applied: true, duplicate: false, outcome: out.result };
}

function status() {
    return { consumer: CONSUMER, ...stats };
}

function _reset() {
    inbox = null;
    stats.applied = 0;
    stats.duplicate = 0;
}

module.exports = {
    CONSUMER, EVENT_TYPES, OUTCOME_NAMES, EVENT_ID_RE, MEDIA_APP_ID,
    subjectOf, dedupeKey, apply, handle, relayStorageEvent, status, stats, _reset,
};
