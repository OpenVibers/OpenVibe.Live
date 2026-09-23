'use strict';
/**
 * OpenVibe.Tips → Live: announce a settled tip in the creator's Live chat (Tips' live-chat
 * delivery adapter, roadmap Wave 9). The money already moved in OpenVibe.Billing; this route only
 * does what the tail of POST /api/funds/donate does after the balance changed.
 *
 *   POST /internal/tips/deliveries      capability live.tips_delivery.write (Network service token,
 *                                       audience openvibe.live; loopback-only like every /internal route)
 *   Idempotency-Key: <interaction id>:<effect>   a repeat answers the first result and does nothing
 *   body { delivery_id, effect, test, creator: { type, id: usr_… }, supporter: { name, subject? },
 *          interaction: { id, kind, amount, currency, message }, text, tts?: { text, voice },
 *          media?: { url }, highlight_seconds?, target?: { service: 'live', type: 'stream', id } }
 *   → 200 { ok: true, ref }   404 creator has no Live channel (permanent)   409 not live (retried)
 *
 *   chat_line | paid_message  donation event to the channel room + global, saved as a 'donation'
 *                             chat message (metadata.source 'tips'), the donation alert sound
 *   tts                       synthesizeAndBroadcastTTS on the live stream (or the offline channel room)
 *   media_request             into the media queue at cost 0 — Billing charged it, Tips holds the record
 */
const express = require('express');
const db = require('../db/database');
const { guard } = require('../net/service-guard');

const router = express.Router();
const done = new Map();   // Idempotency-Key → response (Tips retries within minutes; bounded)
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

function channelUserId(subject) {
    if (!SUBJECT_RE.test(String(subject || ''))) return null;
    const row = db.getDb().prepare("SELECT user_id FROM linked_accounts WHERE service = 'network' AND subject_id = ? ORDER BY id DESC LIMIT 1").get(subject);
    return row ? row.user_id : null;
}

function streamIdFor(target, userId) {
    if (target && target.service === 'live' && target.type === 'stream') {
        const s = db.getStreamById(Number(target.id));
        if (s && s.user_id === userId && s.is_live) return s.id;
    }
    const live = db.getStreamByUserId(userId);
    return live ? live.id : null;
}

function remember(key, out) {
    done.set(key, out);
    if (done.size > 5000) done.delete(done.keys().next().value);
    return out;
}

router.post('/deliveries', guard('live.tips_delivery.write'), express.json({ limit: '32kb' }), async (req, res) => {
    const key = String(req.get('idempotency-key') || '');
    if (!/^[A-Za-z0-9_:.-]{8,200}$/.test(key)) return res.status(400).json({ error: 'Idempotency-Key required' });
    if (done.has(key)) return res.json(done.get(key));
    const b = req.body || {};
    const i = b.interaction || {};
    const userId = channelUserId(b.creator && b.creator.id);
    if (!userId) return res.status(404).json({ error: 'this creator has no Live channel' });
    const chatServer = require('../chat/chat-server');
    const streamId = streamIdFor(b.target, userId);
    const name = String((b.supporter && b.supporter.name) || 'Someone').slice(0, 80);
    const amount = Math.max(0, Math.round(Number(i.amount) || 0));
    const message = String(i.message || '').slice(0, 500);
    try {
        if (b.effect === 'chat_line' || b.effect === 'paid_message') {
            const event = {
                type: 'donation', username: name, user_id: null, avatar_url: null, amount, message, timestamp: new Date().toISOString(),
                source: 'tips', paid_message: b.effect === 'paid_message', highlight_seconds: Number(b.highlight_seconds) || 0,
            };
            chatServer.broadcastToChannelRoom(userId, streamId, event);
            try { chatServer.broadcastGlobal({ ...event, global: true, channel_user_id: userId }); } catch { /* non-critical */ }
            const saved = db.saveChatMessage({
                stream_id: streamId, channel_user_id: userId, user_id: null, username: name,
                message: String(b.text || `${name} tipped ${amount.toLocaleString()} Vibes${message ? ': ' + message : ''}`).slice(0, 1000),
                message_type: 'donation',
                metadata: { kind: 'donation', amount, message, username: name, source: 'tips', interaction_id: i.id || null, paid_message: event.paid_message, highlight_seconds: event.highlight_seconds, test: !!b.test },
            });
            require('../monetization/alerts').playAlertSound(chatServer, userId, streamId, 'donation');
            return res.json(remember(key, { ok: true, ref: { chat_message_id: saved && saved.lastInsertRowid != null ? Number(saved.lastInsertRowid) : null } }));
        }
        if (b.effect === 'tts') {
            const text = String((b.tts && b.tts.text) || '').slice(0, 1200);
            if (!text) return res.status(422).json({ error: 'no text' });
            await chatServer.synthesizeAndBroadcastTTS(streamId, name, text, null, 'tips', `tips:${i.id}`, userId, `tips-${i.id}`);
            return res.json(remember(key, { ok: true, ref: { stream_id: streamId } }));
        }
        if (b.effect === 'media_request') {
            const mq = require('../media/media-queue');
            const settings = mq.getSettings(userId);
            const normalized = await mq.normalizeInput(String((b.media && b.media.url) || ''), settings);
            const max = Number(settings.max_duration_seconds) || 600;
            if (Number.isFinite(normalized.duration_seconds) && normalized.duration_seconds > max) return res.status(422).json({ error: `longer than ${max} seconds` });
            const r = db.createMediaRequest({
                streamer_id: userId, stream_id: streamId, user_id: null, username: name, input: String(b.media.url),
                canonical_url: normalized.canonical_url, embed_url: normalized.embed_url, provider: normalized.provider, title: normalized.title,
                thumbnail_url: normalized.thumbnail_url, duration_seconds: normalized.duration_seconds,
                // Paid through OpenVibe.Billing and recorded by OpenVibe.Tips: Live charges nothing here.
                cost: 0, currency: 'free', queue_position: db.getMediaRequestMaxQueuePosition(userId) + 1,
            });
            mq.broadcastQueueUpdate(userId);
            return res.json(remember(key, { ok: true, ref: { media_request_id: Number(r.lastInsertRowid) } }));
        }
        return res.status(422).json({ error: `unknown effect ${b.effect}` });
    } catch (err) {
        console.warn('[Tips delivery]', b.effect, err.message);
        return res.status(422).json({ error: err.message });
    }
});

module.exports = router;
