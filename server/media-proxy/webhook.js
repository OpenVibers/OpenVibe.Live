/**
 * OpenVibe.Live — OpenVibe.Media webhook receiver
 *
 * POST /internal/media-webhook
 * Media POSTs { event: 'vod.ready'|'vod.failed'|'clip.ready'|'clip.failed', app_id, data }
 * with header `X-OVMedia-Signature: sha256=<hmac-sha256(raw body, MEDIA_WEBHOOK_SECRET)>`.
 *
 * This replaces the old in-process recorder completion callbacks:
 *   vod.ready/failed  → clear any lingering recording session state
 *   clip.ready        → announce the clip in the source channel's live chat
 *                       (grace period + per-slot opt-out, like the old clip-notify)
 */
'use strict';
const crypto = require('crypto');
const db = require('../db/database');

const WEBHOOK_SECRET = process.env.MEDIA_WEBHOOK_SECRET || '';

function verifySignature(req) {
    if (!WEBHOOK_SECRET) {
        console.warn('[MediaWebhook] MEDIA_WEBHOOK_SECRET not set — rejecting webhook');
        return false;
    }
    const header = String(req.headers['x-ovmedia-signature'] || '');
    const m = header.match(/^sha256=([0-9a-f]+)$/i);
    if (!m || !req.rawBody) return false;
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(req.rawBody).digest('hex');
    try {
        return crypto.timingSafeEqual(Buffer.from(m[1].toLowerCase(), 'hex'), Buffer.from(expected, 'hex'));
    } catch {
        return false;
    }
}

function handler(req, res) {
    if (!verifySignature(req)) return res.status(401).json({ error: 'Invalid signature' });
    const { event, data } = req.body || {};
    if (!event) return res.status(400).json({ error: 'Missing event' });

    try {
        switch (event) {
            case 'vod.ready': {
                const vodId = data?.id;
                if (vodId) {
                    try { require('../streaming/recorder').onVodSettled(vodId); } catch { /* */ }
                    // Seed the Live-owned AI state row (queues transcript/overview work)
                    // and kick the on-finalize AI pass right away (both budget-gated).
                    try { db.setVodTranscriptStatus(vodId, 'pending'); } catch { /* */ }
                    // Point the live timeline rows at the VOD so the recording inherits the
                    // transcript that was already built while the stream was running — no
                    // need to transcribe the same audio a second time.
                    try {
                        const sid = data?.stream_id || data?.streamId;
                        if (sid) db.linkTimelineToVod(sid, vodId);
                    } catch { /* */ }
                    try {
                        const ai = require('../ai/ai-analysis');
                        const vodMeta = { id: vodId, ...data };
                        if (ai.transcriptionEnabled && ai.transcriptionEnabled()) ai.generateVodTranscript(vodMeta).catch(() => {});
                        if (ai.isEnabled && ai.isEnabled() && ai.withinBudget && ai.withinBudget()) ai.generateVodOverview(vodMeta).catch(() => {});
                    } catch { /* backfill poller will pick it up */ }
                }
                console.log(`[MediaWebhook] VOD ${vodId} ready (${data?.duration || data?.duration_seconds || '?'}s)`);
                break;
            }
            case 'vod.failed': {
                const vodId = data?.id;
                if (vodId) {
                    try { require('../streaming/recorder').onVodSettled(vodId); } catch { /* */ }
                    try { db.setVodTranscriptStatus(vodId, 'failed', data?.error || 'media reported failure'); } catch { /* */ }
                }
                console.warn(`[MediaWebhook] VOD ${vodId} failed:`, data?.error || '(no detail)');
                break;
            }
            case 'clip.ready': {
                if (data && data.id) {
                    // Schedule the chat announce with a grace period (creator titles the
                    // clip first); the clip-notify sweeper fires it (survives restarts).
                    try { require('./clip-notify').scheduleClipNotify(data.id); } catch { /* */ }
                    try { db.setClipTranscriptStatus(data.id, 'pending'); } catch { /* */ }
                    try {
                        const ai = require('../ai/ai-analysis');
                        if (ai.isEnabled && ai.isEnabled() && ai.withinBudget && ai.withinBudget()) {
                            ai.generateClipOverview({ id: data.id, ...data }).catch(() => {});
                        }
                    } catch { /* */ }
                }
                break;
            }
            case 'clip.failed':
                if (data?.id) { try { db.setClipTranscriptStatus(data.id, 'failed', data?.error || 'media reported failure'); } catch { /* */ } }
                console.warn(`[MediaWebhook] Clip ${data?.id} failed:`, data?.error || '(no detail)');
                break;
            default:
                console.log(`[MediaWebhook] Ignoring event: ${event}`);
        }
    } catch (e) {
        console.warn('[MediaWebhook] handler error:', e.message);
    }
    res.json({ ok: true });
}

module.exports = handler;
