'use strict';
/**
 * OpenVibe.Tips → Live: announce a settled tip in the creator's Live chat (Tips' live-chat
 * delivery adapter, roadmap Wave 9). The money already moved in OpenVibe.Billing; this route only
 * does what the tail of POST /api/funds/donate does after the balance changed.
 *
 *   POST /internal/tips/deliveries      capability live.tips_delivery.write (Network service token,
 *                                       audience openvibe.live; loopback-only like every /internal route)
 *   Idempotency-Key: <interaction id>:<effect>   a repeat answers the first result and does nothing,
 *                                       across restarts too: keys and their answers are kept in the
 *                                       tips_deliveries table for 7 days (pruned hourly). A repeat
 *                                       while the first is still running answers 409 (Tips retries).
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
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

// ── Idempotency store (SQLite, so a Live restart does not forget a delivery) ──────────────
const KEEP_DAYS = 7;            // Tips retries within minutes; a week is ample and stays small
const CLAIM_STALE_MS = 120000;  // a claim this old was left by a crash: the next retry takes it over
const PRUNE_EVERY_MS = 60 * 60 * 1000;
let tablesReady = false;
let lastPrune = 0;

function ensureTables() {
    if (tablesReady) return;
    db.getDb().exec(`CREATE TABLE IF NOT EXISTS tips_deliveries (
        idempotency_key TEXT PRIMARY KEY,
        effect TEXT,
        state TEXT NOT NULL DEFAULT 'pending',   -- pending (running) | done (response stored)
        response_json TEXT,
        claimed_at INTEGER NOT NULL,             -- ms epoch
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.getDb().exec('CREATE INDEX IF NOT EXISTS idx_tips_deliveries_created ON tips_deliveries(created_at)');
    tablesReady = true;
}

/** Delete answers older than KEEP_DAYS. Returns how many rows went. */
function prune({ force = false } = {}) {
    ensureTables();
    if (!force && Date.now() - lastPrune < PRUNE_EVERY_MS) return 0;
    lastPrune = Date.now();
    return db.getDb().prepare(`DELETE FROM tips_deliveries WHERE created_at < datetime('now', ?)`).run(`-${KEEP_DAYS} days`).changes;
}

/**
 * Claim a key before running its effect: { done: response } for a key already answered,
 * { busy: true } while another request runs it, { claimed: true } when this request may run it.
 */
function claim(key, effect) {
    ensureTables();
    const d = db.getDb();
    const now = Date.now();
    if (d.prepare("INSERT OR IGNORE INTO tips_deliveries (idempotency_key, effect, state, claimed_at) VALUES (?, ?, 'pending', ?)").run(key, effect || null, now).changes) {
        return { claimed: true };
    }
    const row = d.prepare('SELECT * FROM tips_deliveries WHERE idempotency_key = ?').get(key);
    if (!row) return claim(key, effect);   // pruned or released in between
    if (row.state === 'done') return { done: JSON.parse(row.response_json || '{}') };
    if (now - row.claimed_at < CLAIM_STALE_MS) return { busy: true };
    const took = d.prepare("UPDATE tips_deliveries SET claimed_at = ? WHERE idempotency_key = ? AND state = 'pending' AND claimed_at = ?").run(now, key, row.claimed_at).changes;
    return took ? { claimed: true } : { busy: true };
}

/** A failed attempt gives the key back, so Tips' retry runs it again. */
function release(key) {
    db.getDb().prepare("DELETE FROM tips_deliveries WHERE idempotency_key = ? AND state = 'pending'").run(key);
}

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
    db.getDb().prepare("UPDATE tips_deliveries SET state = 'done', response_json = ? WHERE idempotency_key = ?").run(JSON.stringify(out), key);
    try { prune(); } catch (e) { console.warn('[Tips delivery] prune:', e.message); }
    return out;
}

router.post('/deliveries', guard('live.tips_delivery.write'), express.json({ limit: '32kb' }), async (req, res) => {
    const key = String(req.get('idempotency-key') || '');
    if (!/^[A-Za-z0-9_:.-]{8,200}$/.test(key)) return res.status(400).json({ error: 'Idempotency-Key required' });
    const b = req.body || {};
    const c = claim(key, b.effect);
    if (c.done) return res.json(c.done);
    if (c.busy) return res.status(409).json({ error: 'this delivery is already running; retry shortly' });
    // Every answer but a stored 200 gives the claim back (Tips retries 409 and 5xx).
    res.on('finish', () => { if (res.statusCode !== 200) { try { release(key); } catch { /* */ } } });
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
module.exports.prune = prune;
