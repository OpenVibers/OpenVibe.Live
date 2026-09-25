'use strict';
/**
 * OpenVibe.Live — what Live does when OpenVibe.Media reports an outcome, whichever way it arrives.
 *
 * Media reports VOD/clip completions and storage alerts two ways during the Wave 3 transition:
 *   webhook  POST /internal/media-webhook (media-proxy/webhook.js), HMAC with MEDIA_WEBHOOK_SECRET
 *   events   POST /internal/media-events  (media-proxy/media-events.js), an OpenVibe.Events
 *            subscription to media.vod.* / media.clip.* / media.storage.* (scripts/subscribe-media-events.js)
 *
 * MEDIA_EVENTS_AUTHORITY picks which one Live acts on:
 *   webhook (default)  the webhook acts; Events deliveries are acknowledged and dropped
 *   both               either acts; the second copy of an outcome is a no-op
 *   events             Events acts; a webhook carrying an event_id is acknowledged and dropped (a
 *                      webhook WITHOUT one has no durable twin, so it still acts)
 *
 * Each outcome is applied at most once: Media writes the event in the state change's transaction
 * and puts the same event_id in the webhook body, and every apply claims an inbox receipt (consumer
 * CONSUMER, key "media:<object type>:<object id>:<event id>") in the same SQLite transaction as
 * Live's own writes. Side effects outside the database (recorder bookkeeping, AI jobs, the ops
 * alert) run after that commit, only for the copy that won.
 */
const db = require('../db/database');

const CONSUMER = 'live-media-outcomes';
const MODES = new Set(['webhook', 'both', 'events']);
const EVENT_ID_RE = /^evt_[0-9A-HJKMNP-TV-Z]{26}$/;
const MEDIA_APP_ID = process.env.MEDIA_APP_ID || 'live';

// Webhook event name → the Events event_type Media publishes for it (media/server/events.js TYPES).
const EVENT_TYPES = {
    'vod.ready': 'media.vod.ready',
    'vod.failed': 'media.vod.failed',
    'clip.ready': 'media.clip.ready',
    'clip.failed': 'media.clip.failed',
    'storage.alert': 'media.storage.alert',
    'storage.recovered': 'media.storage.recovered',
};
const WEBHOOK_NAMES = Object.fromEntries(Object.entries(EVENT_TYPES).map(([k, v]) => [v, k]));

const stats = { applied: { webhook: 0, events: 0 }, duplicate: { webhook: 0, events: 0 }, dropped: { webhook: 0, events: 0 } };
let inbox = null;
let warnedNoEventId = false;

function authority() {
    const v = String(process.env.MEDIA_EVENTS_AUTHORITY || 'webhook').trim().toLowerCase();
    return MODES.has(v) ? v : 'webhook';
}

/** Does this path act on outcomes under the current authority? */
function accepts(via) {
    const mode = authority();
    return mode === 'both' || mode === via;
}

function ensureInbox() {
    if (inbox) return inbox;
    const { createInbox } = require('openvibe-sdk/events');
    inbox = createInbox(db.getDb());
    inbox.ensureSchema();
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
function relayStorageEvent(event, data = {}) {
    const recovered = event === 'storage.recovered';
    const line = `[MediaOutcome] ${recovered ? 'STORAGE RECOVERED' : 'STORAGE ALERT'} (${data.kind || 'unknown'}): `
        + `disk ${data.disk_pct ?? '?'}%, ${data.free_gb ?? '?'} GB free`
        + (data.hint ? ` — ${data.hint}` : '');
    (recovered ? console.warn : console.error)(line);
    if (!recovered && Array.isArray(data.errors) && data.errors.length) {
        console.error('[MediaOutcome]   first errors:', JSON.stringify(data.errors));
    }

    let url = process.env.OPS_ALERT_WEBHOOK_URL || '';
    if (!url) { try { url = db.getSetting('ops_alert_webhook_url') || ''; } catch { url = ''; } }
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
function apply(event, data) {
    data = data || {};
    switch (event) {
        case 'vod.ready': {
            const vodId = data.id;
            if (!vodId) return { outcome: 'ignored' };
            // Seed the Live-owned AI state row (queues transcript/overview work).
            try { db.setVodTranscriptStatus(vodId, 'pending'); } catch { /* */ }
            // Point the live timeline rows at the VOD so the recording inherits the transcript that
            // was already built while the stream was running — no second transcription.
            try {
                const sid = data.stream_id || data.streamId;
                if (sid) db.linkTimelineToVod(sid, vodId);
            } catch { /* */ }
            return {
                outcome: 'vod_ready',
                after: () => {
                    try { require('../streaming/recorder').onVodSettled(vodId); } catch { /* */ }
                    // Kick the on-finalize AI pass right away (both budget-gated).
                    try {
                        const ai = require('../ai/ai-analysis');
                        const vodMeta = { id: vodId, ...data };
                        if (ai.transcriptionEnabled && ai.transcriptionEnabled()) ai.generateVodTranscript(vodMeta).catch(() => {});
                        if (ai.isEnabled && ai.isEnabled() && ai.withinBudget && ai.withinBudget()) ai.generateVodOverview(vodMeta).catch(() => {});
                    } catch { /* backfill poller will pick it up */ }
                    console.log(`[MediaOutcome] VOD ${vodId} ready (${data.duration || data.duration_seconds || '?'}s)`);
                },
            };
        }
        case 'vod.failed': {
            const vodId = data.id;
            if (vodId) { try { db.setVodTranscriptStatus(vodId, 'failed', data.error || 'media reported failure'); } catch { /* */ } }
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
            try { require('./clip-notify').scheduleClipNotify(data.id); } catch { /* */ }
            try { db.setClipTranscriptStatus(data.id, 'pending'); } catch { /* */ }
            return {
                outcome: 'clip_ready',
                after: () => {
                    try {
                        const ai = require('../ai/ai-analysis');
                        if (ai.isEnabled && ai.isEnabled() && ai.withinBudget && ai.withinBudget()) {
                            ai.generateClipOverview({ id: data.id, ...data }).catch(() => {});
                        }
                    } catch { /* */ }
                },
            };
        }
        case 'clip.failed':
            if (data.id) { try { db.setClipTranscriptStatus(data.id, 'failed', data.error || 'media reported failure'); } catch { /* */ } }
            return { outcome: 'clip_failed', after: () => console.warn(`[MediaOutcome] Clip ${data.id} failed:`, data.error || '(no detail)') };
        case 'storage.alert':
        case 'storage.recovered':
            // Media's VOD volume needs a human (drain stalled / disk critical) or is fine again.
            // Recordings are silently refused while this is unresolved, which is why it is loud
            // here and forwarded to the ops channel.
            return { outcome: 'storage', after: () => relayStorageEvent(event, data) };
        default:
            return { outcome: 'ignored' };
    }
}

/**
 * Apply one outcome at most once. `via` is 'webhook' or 'events'; `eventId` is Media's event id
 * (webhooks from a Media without an outbox have none: those apply without a receipt).
 * Returns { applied, duplicate, outcome }. Throws when Live's writes fail (nothing committed).
 */
function handle({ via, event, data, eventId = null, subject = null }) {
    let after = null;
    const run = () => { const r = apply(event, data); after = r.after || null; return r.outcome; };
    let out;
    if (eventId) {
        out = ensureInbox().once(CONSUMER, dedupeKey(eventId, subject || subjectOf(event, data)), run);
    } else {
        if (via === 'webhook' && !warnedNoEventId) {
            warnedNoEventId = true;
            console.warn('[MediaOutcome] a Media webhook carried no event_id (Media without its Events outbox?): applied without dedupe');
        }
        out = { duplicate: false, result: db.getDb().transaction(run)() };
    }
    if (out.duplicate) {
        stats.duplicate[via]++;
        return { applied: false, duplicate: true };
    }
    stats.applied[via]++;
    if (after) { try { after(); } catch (e) { console.warn('[MediaOutcome] post-commit step failed:', e.message); } }
    // A VOD or clip that became ready (or failed) changes what OpenVibe.Search should hold for its page.
    const kind = /^(vod|clip)\.(ready|failed)$/.exec(String(event));
    if (kind && data && data.id != null) { try { require('../events/search-media-documents').touchLater(kind[1], data.id); } catch { /* search is optional */ } }
    return { applied: true, duplicate: false, outcome: out.result };
}

function status() {
    return { authority: authority(), consumer: CONSUMER, ...JSON.parse(JSON.stringify(stats)) };
}

function _reset() {
    inbox = null;
    warnedNoEventId = false;
    for (const k of Object.keys(stats)) stats[k] = { webhook: 0, events: 0 };
}

module.exports = {
    CONSUMER, EVENT_TYPES, WEBHOOK_NAMES, EVENT_ID_RE, MEDIA_APP_ID,
    authority, accepts, subjectOf, dedupeKey, apply, handle, relayStorageEvent, status, stats, _reset,
};
