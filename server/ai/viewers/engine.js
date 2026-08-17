/**
 * AI Chat Viewers 2.0 — engine + lifecycle.
 *
 * Persistent per-channel bot roster reacts to the live situation (audio + vision),
 * the room mood, and the specific viewers they reply to. One bot speaks at a time,
 * paced to feel human; every LLM call is metered + budget-capped per streamer.
 *
 * Wired at the same lifecycle hooks the old ai-chatbot-service used (startForStream /
 * stopForStream / onRealChatMessage / applyConfigForUser / hasWorker / stopForUser),
 * so ../integrations/ai-chatbot-service.js re-exports this singleton.
 */
const db = require('../../db/database');
const budget = require('./budget');
const roster = require('./roster');
const context = require('./context');
const brain = require('./brain');

// ── Pacing constants ──────────────────────────────────────────
const GLOBAL_MIN_GAP_MS = 3500;         // hard floor between any two bot lines
const ACTIVE_GAP_MS = [5000, 11000];    // target gap when chat/stream is active
const IDLE_GAP_MS = [14000, 30000];     // target gap when quiet
const TICK_MS = 2500;                    // pacer resolution
const ACTIVE_WINDOW_MS = 25000;          // "active" = real input within this window
const SITUATION_AUDIO_MS = 30000;        // how often to sample mic (free local STT)
const SITUATION_VISION_MS = 75000;       // how often to sample the screen (metered)
const BRAIN_FOLD_MS = 180000;            // how often to fold bots' rolling memory
const RECENT_CHAT_MAX = 30;
const REPLY_PROB = 0.6;                  // chance a real viewer msg gets a bot reply

function rint(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }

class AiViewersEngine {
    constructor() {
        /** @type {Map<number, object>} streamId → worker */
        this.workers = new Map();
    }

    hasWorker(streamId) { return this.workers.has(streamId); }

    // ── Lifecycle ─────────────────────────────────────────────
    async startForStream(stream) {
        try {
            if (!stream || !stream.id || !stream.user_id) return;
            if (this.workers.has(stream.id)) return;
            const cfg = db.getChannelAiConfig(stream.user_id);
            if (!cfg.enabled) return;

            // Full row for capture (needs protocol/managed_stream_key).
            let full = stream;
            try { full = db.getStreamById(stream.id) || stream; } catch { /* */ }

            const target = Math.max(0, Math.min(12, cfg.num_ambient_bots || 0));
            const bots = roster.ensureRoster(stream.user_id, target);
            if (!bots.length) return; // nothing to say with

            const worker = {
                streamId: stream.id,
                userId: stream.user_id,
                stream: full,
                config: cfg,
                bots,
                recentChat: [],
                situationLine: '',
                lastPostAt: 0,
                lastPoster: null,
                nextGapMs: rint(IDLE_GAP_MS[0], IDLE_GAP_MS[1]),
                lastRealInputAt: 0,
                intents: [],           // [{prio, botId, target, addressed}]
                botLines: new Map(),   // botId → recent lines (for brain fold)
                generating: false,
                stopped: false,
                paceTimer: null, audioTimer: null, visionTimer: null, brainTimer: null,
            };
            context.refreshShared(worker);
            this.workers.set(stream.id, worker);

            worker.paceTimer = setTimeout(() => this._tick(worker), TICK_MS);
            if (cfg.transcribe_enabled) worker.audioTimer = setInterval(() => this._captureAudio(worker), SITUATION_AUDIO_MS);
            if (cfg.vision_enabled) worker.visionTimer = setInterval(() => this._captureVision(worker), SITUATION_VISION_MS);
            worker.brainTimer = setInterval(() => this._foldBrains(worker), BRAIN_FOLD_MS);

            console.log(`[AI-Viewers] Started for stream ${stream.id} (streamer ${stream.user_id}, ${bots.length} bots)`);
        } catch (e) {
            console.warn('[AI-Viewers] startForStream failed:', e.message);
        }
    }

    stopForStream(streamId) {
        const worker = this.workers.get(streamId);
        if (!worker) return;
        worker.stopped = true;
        clearTimeout(worker.paceTimer);
        clearInterval(worker.audioTimer);
        clearInterval(worker.visionTimer);
        clearInterval(worker.brainTimer);
        this.workers.delete(streamId);
        console.log(`[AI-Viewers] Stopped for stream ${streamId}`);
    }

    stopForUser(userId) {
        for (const [sid, w] of this.workers) if (w.userId === userId) this.stopForStream(sid);
    }

    // Hot-apply config changes to any live streams for this user.
    applyConfigForUser(userId) {
        for (const [, w] of this.workers) {
            if (w.userId !== userId) continue;
            const cfg = db.getChannelAiConfig(userId);
            w.config = cfg;
            if (!cfg.enabled) { this.stopForStream(w.streamId); continue; }
            const target = Math.max(0, Math.min(12, cfg.num_ambient_bots || 0));
            w.bots = roster.ensureRoster(userId, target);
            // Re-arm situation timers to match toggles.
            clearInterval(w.audioTimer); clearInterval(w.visionTimer);
            w.audioTimer = cfg.transcribe_enabled ? setInterval(() => this._captureAudio(w), SITUATION_AUDIO_MS) : null;
            w.visionTimer = cfg.vision_enabled ? setInterval(() => this._captureVision(w), SITUATION_VISION_MS) : null;
        }
        // If enabled but not yet running for a live stream, the next go-live picks it up.
    }
    reloadForUser(userId) { return this.applyConfigForUser(userId); }

    // ── Reactive: real chat / streamer input ──────────────────
    onRealChatMessage(streamId, { username, message, userId }) {
        const worker = this.workers.get(streamId);
        if (!worker || worker.stopped) return;
        // Ignore our own bots (defensive; bots don't route through here).
        if (worker.bots.some(b => (b.username || '').toLowerCase() === (username || '').toLowerCase())) return;

        worker.recentChat.push({ username, message, userId, ts: Date.now() });
        if (worker.recentChat.length > RECENT_CHAT_MAX) worker.recentChat.shift();
        worker.lastRealInputAt = Date.now();

        const isStreamer = userId && userId === worker.userId;
        const addressedChat = isStreamer || /\b(chat|guys|everyone|yall|y'all)\b/i.test(message || '');

        // Decide whether a bot replies to this specific viewer.
        if (!isStreamer && Math.random() < REPLY_PROB) {
            const bot = this._pickBot(worker);
            if (bot) {
                worker.intents.push({
                    prio: 2, botId: bot.id,
                    target: { kind: userId ? 'user' : 'relay', userId: userId || null, relayId: null, username, message },
                    addressed: false,
                });
            }
        } else if (addressedChat) {
            const bot = this._pickBot(worker);
            if (bot) worker.intents.push({ prio: isStreamer ? 3 : 1, botId: bot.id, target: null, addressed: true });
        }
        // Keep the intent queue small.
        if (worker.intents.length > 6) worker.intents = worker.intents.slice(-6);
    }

    // ── Pacer ─────────────────────────────────────────────────
    _tick(worker) {
        if (worker.stopped) return;
        worker.paceTimer = setTimeout(() => this._tick(worker), TICK_MS);
        if (worker.generating) return;

        const now = Date.now();
        const gap = now - worker.lastPostAt;
        if (gap < GLOBAL_MIN_GAP_MS) return;

        const active = (now - worker.lastRealInputAt) < ACTIVE_WINDOW_MS;
        if (gap < worker.nextGapMs) {
            // Not yet due for ambient — but a queued reactive intent can jump the gap.
            if (!worker.intents.length) return;
        }

        // Pick the work: highest-priority queued intent, else maybe ambient filler.
        let intent = null;
        if (worker.intents.length) {
            worker.intents.sort((a, b) => b.prio - a.prio);
            intent = worker.intents.shift();
        } else {
            // Ambient filler only when due and (probabilistically) when active/idle.
            if (gap < worker.nextGapMs) return;
            const prob = active ? 0.7 : 0.4;
            if (Math.random() > prob) { worker.nextGapMs = this._nextGap(active); worker.lastPostAt = now; return; }
            const bot = this._pickBot(worker);
            if (!bot) return;
            intent = { botId: bot.id, target: null, addressed: false };
        }

        this._emit(worker, intent).catch(e => console.warn('[AI-Viewers] emit failed:', e.message));
    }

    _nextGap(active) {
        const r = active ? ACTIVE_GAP_MS : IDLE_GAP_MS;
        return rint(r[0], r[1]);
    }

    // Pick a bot, avoiding the last one that posted (anti-domination).
    _pickBot(worker) {
        const pool = worker.bots.filter(b => b.id !== worker.lastPoster);
        const list = pool.length ? pool : worker.bots;
        if (!list.length) return null;
        return list[rint(0, list.length - 1)];
    }

    async _emit(worker, intent) {
        const bot = worker.bots.find(b => b.id === intent.botId) || this._pickBot(worker);
        if (!bot) return;
        worker.generating = true;
        try {
            const { system, user } = context.buildBotContext(worker, bot, {
                targetUser: intent.target || null,
                addressed: !!intent.addressed,
            });
            const text = await budget.generate(worker.userId, {
                system, user,
                maxTokens: 60,
                temperature: intent.target ? 0.9 : 1.05,
            });
            if (!text) return; // quiet: over budget / disabled / error
            const clean = this._clean(text);
            if (!clean) return;
            this._inject(worker, bot, clean);
        } finally {
            worker.generating = false;
        }
    }

    _clean(text) {
        let t = (text || '').trim();
        t = t.replace(/^["'`]+|["'`]+$/g, '');        // strip wrapping quotes
        t = t.replace(/\s+/g, ' ');
        if (t.length > 240) t = t.slice(0, 240);
        // Drop obvious AI disclaimers if the model slipped.
        if (/\b(as an ai|language model|i am a bot|i'm a bot)\b/i.test(t)) return '';
        return t.trim();
    }

    // ── Posting ───────────────────────────────────────────────
    _inject(worker, bot, message) {
        const streamId = worker.streamId;
        let color = '#8a8aff';
        try { color = (JSON.parse(bot.persona_json || '{}').color) || bot.avatar_color || color; } catch { color = bot.avatar_color || color; }

        let id = null;
        try {
            const res = db.saveChatMessage({
                stream_id: streamId,
                channel_user_id: worker.userId,
                user_id: null,
                username: bot.username,
                message,
                message_type: 'chat',
                is_global: false,
                source_platform: 'ai',                 // marker → excluded from chat-AI feeds
                metadata: { bot: 1, bot_id: bot.id, source: bot.source },
            });
            id = res && res.lastInsertRowid;
        } catch (e) { console.warn('[AI-Viewers] saveChatMessage failed:', e.message); }

        const chatMsg = {
            type: 'chat', id: id || undefined,
            username: bot.username, core_username: null,
            user_id: null, anon_id: null, role: 'user',
            message, stream_id: streamId, is_global: false,
            avatar_url: null, profile_color: color,
            is_ai: true, source_platform: 'ai',
            filtered: false, timestamp: new Date().toISOString(),
        };
        try {
            const chatServer = require('../../chat/chat-server');
            chatServer.broadcastToStream(streamId, chatMsg);
            chatServer.forwardToGlobal(streamId, chatMsg);
            chatServer.synthesizeAndBroadcastTTS(streamId, bot.username, message, null, null, `aibot:${bot.username.toLowerCase()}`);
        } catch (e) { console.warn('[AI-Viewers] broadcast failed:', e.message); }

        worker.lastPostAt = Date.now();
        worker.lastPoster = bot.id;
        worker.nextGapMs = this._nextGap((Date.now() - worker.lastRealInputAt) < ACTIVE_WINDOW_MS);
        try { db.touchChannelAiBot(bot.id); } catch { /* */ }
        // Buffer this line for the bot's periodic brain fold.
        const buf = worker.botLines.get(bot.id) || [];
        buf.push(message);
        if (buf.length > 24) buf.shift();
        worker.botLines.set(bot.id, buf);
        // Also let bots see each other in chat.
        worker.recentChat.push({ username: bot.username, message, ts: Date.now() });
        if (worker.recentChat.length > RECENT_CHAT_MAX) worker.recentChat.shift();
    }

    // ── Situation: what's happening on stream ─────────────────
    async _captureAudio(worker) {
        if (worker.stopped) return;
        let ai, transcribe;
        try { ai = require('../ai-analysis'); transcribe = require('../transcribe'); } catch { return; }
        if (!ai.transcriptionEnabled || !ai.transcriptionEnabled()) return;
        let wav = null;
        try {
            const streamAudio = require('../stream-audio');
            wav = await streamAudio.captureAudioChunk(worker.stream, 12);
            if (!wav) return;
            const res = await transcribe.transcribeWavDetailed(wav);
            const text = res && res.ok ? (res.text || '').trim() : '';
            if (text) this._mergeSituation(worker, `heard: "${text.slice(0, 240)}"`);
        } catch (e) { /* capture is best-effort */ }
        finally { if (wav) { try { require('fs').unlink(wav, () => {}); } catch { /* */ } } }
    }

    async _captureVision(worker) {
        if (worker.stopped) return;
        try {
            const streamVision = require('../stream-vision');
            const frame = await streamVision.captureFrame(worker.stream);
            if (!frame) return;
            const desc = await budget.generate(worker.userId, {
                system: 'You describe a single video frame from a live stream in one short vivid sentence.',
                user: 'What is on screen right now?',
                image: frame, maxTokens: 60, temperature: 0.4,
            });
            if (desc && desc.trim()) this._mergeSituation(worker, `seen: ${desc.trim().slice(0, 200)}`);
        } catch (e) { /* best-effort */ }
    }

    _mergeSituation(worker, line) {
        // Keep the most recent heard/seen fragments as the current situation.
        const parts = (worker.situationLine || '').split(' | ').filter(Boolean);
        const kind = line.split(':')[0];
        const kept = parts.filter(p => !p.startsWith(kind));
        kept.push(line);
        worker.situationLine = kept.slice(-2).join(' | ');
        context.refreshShared(worker); // refresh streamer/global insight alongside
    }

    async _foldBrains(worker) {
        if (worker.stopped) return;
        for (const bot of worker.bots) {
            const lines = worker.botLines.get(bot.id);
            if (!lines || lines.length < 3) continue;
            try {
                const fresh = db.getChannelAiBot(bot.id) || bot;
                const ok = await brain.foldBrain(worker.userId, fresh, lines);
                if (ok) { worker.botLines.set(bot.id, []); /* refresh cached row */
                    const updated = db.getChannelAiBot(bot.id);
                    const idx = worker.bots.findIndex(b => b.id === bot.id);
                    if (updated && idx >= 0) worker.bots[idx] = updated;
                }
            } catch { /* */ }
            if (worker.stopped) return;
        }
    }
}

module.exports = new AiViewersEngine();
