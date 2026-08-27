/**
 * AI Chat Viewers v3 — engine.
 *
 * Per live stream: a worker holds the roster, settings, a cached stable prompt prefix,
 * a scheduler, and pending intents. A DIRECTOR pass runs on a cadence (or immediately
 * on a priority intent), assembles the unified context (only deltas), makes ONE
 * structured LLM call that plans several lines, and hands them to the scheduler.
 * Streamer mentions get a guaranteed answer via a fast path when the next pass is far.
 * Nothing runs when nothing changed. Spend degrades gracefully toward the streamer's cap.
 */
'use strict';
const db = require('../../db/database');
const settingsMod = require('./settings');
const roster = require('./roster');
const budget = require('./budget');
const context = require('../context');
const director = require('./director');
const poster = require('./poster');
const mention = require('./mention');
const fold = require('./fold');
const { Scheduler } = require('./scheduler');

const ACTIVE_WINDOW_MS = 45000;
const SKIP_LOG_EVERY_MS = 5 * 60 * 1000;
const STREAMER_QUIET_MS = 8000;   // after answering the streamer, hold ambient chatter briefly

function clip(str, n) { return (str || '').toString().replace(/\s+/g, ' ').trim().slice(0, n); }
function norm(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }

class AiViewersEngineV3 {
    constructor() { this.workers = new Map(); this.version = 'v3'; }

    hasWorker(streamId) { return this.workers.has(streamId); }
    workerForUser(userId) { for (const w of this.workers.values()) if (w.userId === userId) return w; return null; }

    _killSwitch() { const v = db.getSetting('ai_viewers_enabled'); return v === false || v === 'false' || v === 0 || v === '0'; }

    // ── Lifecycle ─────────────────────────────────────────────
    async startForStream(stream) {
        try {
            if (!stream || !stream.id || !stream.user_id) return;
            if (this.workers.has(stream.id)) return;
            if (this._killSwitch()) return;
            const cfg = db.getChannelAiConfig(stream.user_id);
            if (!cfg.enabled) return;
            const settings = settingsMod.getSettings(stream.user_id, cfg);
            let full = stream;
            try { full = db.getStreamById(stream.id) || stream; } catch { /* */ }
            if (full.managed_stream_id && settings.slots && settings.slots[String(full.managed_stream_id)] === false) {
                console.log(`[AI-Viewers] slot ${full.managed_stream_id} has AI viewers off — not starting for stream ${stream.id}`);
                return;
            }
            const bots = roster.ensureRoster(stream.user_id, settings.roster_size);
            if (!bots.length) return;

            const worker = {
                streamId: stream.id, userId: stream.user_id, stream: full, cfg, settings, bots,
                stable: null,                       // cached stable prefix {text,hash,at}
                lastChatId: db.getMaxChatMessageIdForChannel(stream.user_id),
                lastTickAt: 0, nextTickAt: 0, tickTimer: null, foldTimer: null, ticking: false,
                lastRealInputAt: 0, lastStreamerReplyAt: 0, lastSkipLogAt: 0, lastVolatileHash: null,
                intents: [],                        // [{ kind:'streamer'|'mention'|'sound'|'scene', text, bots:[], at }]
                botLines: new Map(),                // botId → recent lines (memory fold)
                recentLines: [],                    // normalized last 30 bot lines (dedupe)
                lastSeenMemoryId: null, lastPeriodicVisionAt: 0,
                paused: !!(settings.runtime && settings.runtime.paused),
                mode: 'normal',
                stats: { ticks: 0, lines: 0, skips: 0, cost: 0 },
                startedAt: Date.now(), stopped: false,
            };
            worker.scheduler = new Scheduler(worker, {
                post: (line) => this._post(worker, line),
                dropped: (line, why) => poster.log(worker, { event: 'skip', bot_username: line.bot, text: line.text, reason: why }),
            });
            this.workers.set(stream.id, worker);
            poster.log(worker, { event: 'info', reason: `engine v3 started — ${bots.length} viewer(s), ${settings.activity} activity, director every ${settings.director_interval_sec}s` });
            console.log(`[AI-Viewers v3] started for stream ${stream.id} (user ${stream.user_id}, ${bots.length} bots)`);
            this._scheduleTick(worker, 4000);
            worker.foldTimer = setInterval(() => this._fold(worker).catch(() => {}), Math.max(3, settings.memory_fold_min) * 60000);
        } catch (e) { console.warn('[AI-Viewers v3] start failed:', e.message); }
    }

    stopForStream(streamId) {
        const w = this.workers.get(streamId);
        if (!w) return;
        w.stopped = true;
        if (w.tickTimer) clearTimeout(w.tickTimer);
        if (w.foldTimer) clearInterval(w.foldTimer);
        w.scheduler.stop();
        this.workers.delete(streamId);
        try { db.closeAllAiViewerThreads(w.userId); } catch { /* */ }
        this._fold(w).catch(() => {});
        poster.log(w, { event: 'info', reason: `stopped — ${w.stats.lines} line(s), ${w.stats.ticks} pass(es), $${w.stats.cost.toFixed(4)}` });
        console.log(`[AI-Viewers v3] stopped for stream ${streamId}`);
    }
    stopForUser(userId) { for (const [sid, w] of this.workers) if (w.userId === userId) this.stopForStream(sid); }

    /** Hot-apply config: reload settings/roster on live workers; start/stop as needed. */
    applyConfigForUser(userId) {
        const cfg = db.getChannelAiConfig(userId);
        const settings = settingsMod.getSettings(userId, cfg);
        const live = (() => { try { return db.getLiveStreamsByUserId(userId) || []; } catch { return []; } })();
        for (const [sid, w] of this.workers) {
            if (w.userId !== userId) continue;
            if (!cfg.enabled || this._killSwitch() || (w.stream.managed_stream_id && settings.slots && settings.slots[String(w.stream.managed_stream_id)] === false)) { this.stopForStream(sid); continue; }
            w.cfg = cfg; w.settings = settings; w.paused = !!(settings.runtime && settings.runtime.paused);
            try { w.bots = roster.ensureRoster(userId, settings.roster_size); } catch { /* */ }
            w.stable = null;  // prefix inputs may have changed
            if (w.foldTimer) { clearInterval(w.foldTimer); w.foldTimer = setInterval(() => this._fold(w).catch(() => {}), Math.max(3, settings.memory_fold_min) * 60000); }
            poster.log(w, { event: 'info', reason: 'settings applied' });
        }
        if (cfg.enabled && !this._killSwitch()) for (const s of live) if (!this.workers.has(s.id)) this.startForStream(s).catch(() => {});
    }
    reloadForUser(userId) { return this.applyConfigForUser(userId); }

    // ── Chat events (native, relayed, anon — everything public) ─
    onRealChatMessage(streamId, ev) { return this.onChatEvent(streamId, ev); }
    onChatEvent(streamId, ev = {}) {
        const w = this.workers.get(streamId);
        if (!w || w.stopped) return;
        const uname = String(ev.username || '');
        if (ev.isBot || w.bots.some(b => b.username.toLowerCase() === uname.toLowerCase())) return;   // never react to our own lines
        if (ev.platform && !w.settings.reply_to_relay_chat) return;
        const isStreamer = !!ev.isStreamer || (ev.userId && ev.userId === w.userId);
        const text = String(ev.message || '');
        // Streamer/mod shortcut: "!ai pause" etc. also works from relayed chat for the streamer.
        if (/^!ai\b/i.test(text) && (isStreamer || ev.isMod)) {
            try { this.onModCommand(w.userId, streamId, text.split(/\s+/).slice(1), { by: uname }); } catch { /* */ }
            return;
        }
        w.lastRealInputAt = Date.now();
        const det = mention.detect(text, w.bots, { isStreamer });
        if (isStreamer && (det.addressedChat || det.bots.length)) {
            this._pushIntent(w, { kind: 'streamer', text: `The streamer (${uname}) said: "${clip(text, 220)}"${det.bots.length ? ` — addressed to ${det.bots.join(', ')}` : ' — addressed to chat'}. A reply is REQUIRED.`, bots: det.bots, line: text, at: Date.now(), msgId: ev.msgId || null });
            this._fastPath(w, { line: text, bots: det.bots, replyTo: uname, msgId: ev.msgId || null }).catch(() => {});
            return;
        }
        if (det.bots.length) {
            this._pushIntent(w, { kind: 'mention', text: `${uname} addressed ${det.bots.join(', ')}: "${clip(text, 200)}" — that viewer should be answered.`, bots: det.bots, at: Date.now(), replyTo: uname });
            this._scheduleTick(w, 2500);
            return;
        }
        if (isStreamer) { this._scheduleTick(w, Math.min(6000, w.settings.director_interval_sec * 1000)); return; }
        // Regular viewer message: the director decides; reply probability trims how often
        // we even suggest it, and a burst of new chat pulls the next pass closer.
        if (Math.random() < (w.settings.reply_probability == null ? 0.6 : w.settings.reply_probability)) {
            this._pushIntent(w, { kind: 'viewer', text: `${uname} said: "${clip(text, 200)}" — consider replying to them.`, bots: [], at: Date.now(), replyTo: uname, soft: true });
        }
        if (Date.now() - w.lastTickAt > 8000) this._scheduleTick(w, 6000);
    }
    _pushIntent(w, intent) {
        w.intents.push(intent);
        // Hard intents first; keep the queue short so a burst can't stack ten replies.
        w.intents.sort((a, b) => (a.soft ? 1 : 0) - (b.soft ? 1 : 0) || a.at - b.at);
        if (w.intents.length > 6) w.intents = w.intents.slice(0, 6);
    }

    // ── Mod commands: /ai … or !ai … ─────────────────────────
    onModCommand(channelUserId, streamId, args = [], { by = null } = {}) {
        const [cmd, ...rest] = (args || []).map(a => String(a || '').trim()).filter(Boolean);
        const w = this.workerForUser(channelUserId);
        const settings = settingsMod.getSettings(channelUserId);
        const runtime = { paused: !!(settings.runtime && settings.runtime.paused), muted: (settings.runtime && settings.runtime.muted) || [] };
        const save = () => { settingsMod.updateSettings(channelUserId, { runtime }); if (w) { w.settings = settingsMod.getSettings(channelUserId); w.paused = runtime.paused; w.stable = null; } };
        switch ((cmd || 'status').toLowerCase()) {
            case 'pause': runtime.paused = true; save(); if (w) { w.scheduler.clear(); poster.log(w, { event: 'pause', reason: `paused by ${by || 'mod'}` }); } return 'AI viewers paused.';
            case 'resume': runtime.paused = false; save(); if (w) { poster.log(w, { event: 'pause', reason: `resumed by ${by || 'mod'}` }); this._scheduleTick(w, 3000); } return 'AI viewers resumed.';
            case 'mute': { const n = String(rest[0] || '').replace(/^@/, '').toLowerCase(); if (!n) return 'Usage: /ai mute <viewer>'; if (!runtime.muted.includes(n)) runtime.muted.push(n); save(); return `Muted ${n}.`; }
            case 'unmute': { const n = String(rest[0] || '').replace(/^@/, '').toLowerCase(); runtime.muted = runtime.muted.filter(x => x !== n); save(); return `Unmuted ${n}.`; }
            case 'nudge': if (w) { this._scheduleTick(w, 500); return 'Nudged the director.'; } return 'AI viewers are not running right now.';
            default: {
                if (!w) return `AI viewers: ${runtime.paused ? 'paused' : 'not running for a live stream'}${runtime.muted.length ? `, muted: ${runtime.muted.join(', ')}` : ''}.`;
                return `AI viewers: ${w.paused ? 'paused' : 'running'} · ${w.bots.length} viewers · mode ${w.mode} · ${w.stats.lines} lines this stream${runtime.muted.length ? ` · muted: ${runtime.muted.join(', ')}` : ''}. Commands: pause, resume, mute <name>, unmute <name>, nudge.`;
            }
        }
    }

    // ── Director loop ────────────────────────────────────────
    _scheduleTick(w, delayMs) {
        if (w.stopped) return;
        const at = Date.now() + Math.max(250, delayMs);
        if (w.tickTimer && w.nextTickAt <= at) return;         // an earlier tick is already armed
        if (w.tickTimer) clearTimeout(w.tickTimer);
        w.nextTickAt = at;
        w.tickTimer = setTimeout(() => { w.tickTimer = null; this._tick(w).catch(e => console.warn('[AI-Viewers v3] tick error:', e.message)); }, at - Date.now());
    }
    _cadenceMs(w) {
        const s = w.settings;
        const active = (Date.now() - w.lastRealInputAt) < ACTIVE_WINDOW_MS;
        let ms = (active ? s.director_interval_sec : s.idle_interval_sec) * 1000;
        if (w.mode === 'economy') ms *= 1.5;
        if (w.mode === 'replies_only') ms *= 2;
        return ms;
    }
    _providerFor(w) { return w.cfg.use_shared_key ? null : budget.byoProvider(w.cfg); }

    async _tick(w) {
        if (w.stopped || w.ticking) return;
        w.ticking = true;
        const s = w.settings;
        try {
            if (this._killSwitch()) { this.stopForStream(w.streamId); return; }
            try { w.stream = db.getStreamById(w.streamId) || w.stream; } catch { /* */ }
            if (!w.stream || !w.stream.is_live) { this.stopForStream(w.streamId); return; }
            const hardIntents = w.intents.filter(i => !i.soft);
            const st = budget.status(w.userId);
            w.mode = st.mode;
            const quiet = settingsMod.isQuietNow(s);
            if (w.paused || (quiet && !(s.quiet_allow_replies && hardIntents.length)) || st.mode === 'silent' || !st.active) {
                w.intents = [];
                this._logSkip(w, w.paused ? 'paused' : quiet ? 'quiet hours' : (st.reason || st.mode));
                return;
            }
            if (st.mode === 'streamer_only' && !hardIntents.some(i => i.kind === 'streamer')) { w.intents = []; this._logSkip(w, 'budget: streamer replies only'); return; }
            if (st.mode === 'replies_only') w.intents = w.intents.filter(i => !i.soft ? true : i.kind === 'viewer');

            // Vision: look at the screen through the shared memory pipeline when it is stale.
            await this._maybeVision(w, hardIntents.length > 0);

            const bots = w.bots.filter(b => !((s.runtime && s.runtime.muted) || []).includes(b.username.toLowerCase()));
            if (!bots.length) { this._logSkip(w, 'all viewers muted'); return; }
            const stable = context.stablePrefix({ userId: w.userId, stream: w.stream, bots, settings: s, cacheHolder: w });
            const linesAllowed = Math.max(1, Math.min(s.lines_per_tick, st.mode === 'economy' ? s.lines_per_tick - 1 : s.lines_per_tick));
            const tail = context.volatileTail({
                userId: w.userId, stream: w.stream, settings: s, sinceChatId: w.lastChatId,
                botNames: new Set(w.bots.map(b => b.username.toLowerCase())),
                intents: w.intents.slice(0, 5), mode: st.mode, linesAllowed, botShare: w.scheduler.botShare(),
            });
            const awaiting = tail.threads.some(t => t.awaiting);
            const sceneChanged = tail.delta.memoryId && tail.delta.memoryId !== w.lastSeenMemoryId && s.react_to_scene_changes;
            const sound = s.react_to_sounds && tail.delta.latestSound && (Date.now() - w.lastTickAt) < 120000 ? tail.delta.latestSound : null;
            const changed = tail.hash !== w.lastVolatileHash;
            if (!changed && !w.intents.length && !awaiting && !sceneChanged) { this._logSkip(w, 'nothing new'); return; }
            if (!tail.delta.newChat && !tail.delta.speechLines && !w.intents.length && !awaiting && !sceneChanged && w.scheduler.pending()) { this._logSkip(w, 'lines still queued'); return; }
            w.lastVolatileHash = tail.hash;
            if (sceneChanged) w.lastSeenMemoryId = tail.delta.memoryId;
            let volatileText = tail.text;
            if (sceneChanged && !w.intents.length) volatileText += '\n\nNote: what is on screen just changed — an ambient reaction is welcome.';
            if (sound) volatileText += `\n\nNote: a "${sound.label}" sound was just detected on stream.`;

            const consumed = w.intents.splice(0, w.intents.length);
            const res = await director.plan({
                stableText: stable.text, volatileText, maxLines: linesAllowed,
                provider: this._providerFor(w), ownerUserId: w.userId, cacheKey: `aiv:${w.userId}`,
            });
            w.lastTickAt = Date.now();
            w.lastChatId = Math.max(w.lastChatId, tail.chatMaxId || 0);
            w.stats.ticks++;
            if (!res) { poster.log(w, { event: 'error', reason: 'director call failed or provider quiet' }); w.intents.unshift(...consumed.filter(i => !i.soft)); return; }
            w.stats.cost += res.cost || 0;
            const accepted = this._acceptPlan(w, res.plan, bots, consumed);
            poster.log(w, {
                event: 'tick', reason: res.plan.notes || (res.plan.skip ? 'director: skip' : `planned ${accepted} line(s)`),
                text: accepted ? res.plan.lines.slice(0, accepted).map(l => `${l.bot}→${l.target}${l.reply_to ? '@' + l.reply_to : ''}`).join(', ') : null,
                tokens_in: res.usage.input, tokens_cached: res.usage.cached, tokens_out: res.usage.output, cost_usd: res.cost, model: res.model,
            });
            for (const id of res.plan.threads_close || []) { const n = parseInt(id, 10); if (n) { try { db.closeAiViewerThread(n); } catch { /* */ } } }
            try { db.closeStaleAiViewerThreads(w.userId, s.thread_idle_close_sec, s.max_thread_turns); } catch { /* */ }
        } finally {
            w.ticking = false;
            if (!w.stopped) this._scheduleTick(w, this._cadenceMs(w));
        }
    }

    _logSkip(w, reason) {
        w.stats.skips++;
        if (Date.now() - w.lastSkipLogAt > SKIP_LOG_EVERY_MS) { w.lastSkipLogAt = Date.now(); poster.log(w, { event: 'skip', reason }); }
    }

    /** Validate + enqueue a plan. Returns the number of accepted lines. */
    _acceptPlan(w, plan, bots, consumed) {
        if (!plan || plan.skip || !plan.lines.length) return 0;
        const s = w.settings;
        const byName = new Map(bots.map(b => [b.username.toLowerCase(), b]));
        const streamerIntent = consumed.find(i => i.kind === 'streamer');
        const out = [];
        let botTargets = 0;
        let lastBot = null;
        for (const raw of plan.lines) {
            const bot = byName.get(String(raw.bot || '').toLowerCase());
            if (!bot) continue;
            if (lastBot === bot.username) continue;
            let text = poster.clean(raw.text, s.max_words);
            if (!text) continue;
            const n = norm(text);
            if (w.recentLines.includes(n)) continue;
            const mod = poster.moderate(text);
            if (!mod.ok) { poster.log(w, { event: 'skip', bot_username: bot.username, text, reason: mod.reason }); continue; }
            const target = ['viewer', 'bot', 'streamer', 'ambient'].includes(raw.target) ? raw.target : 'ambient';
            if (target === 'bot') {
                const maxBot = Math.floor((s.bot_to_bot_ratio || 0) * Math.max(1, plan.lines.length) + 0.5);
                if (botTargets >= Math.max(0, maxBot) && (s.bot_to_bot_ratio || 0) < 0.79) { poster.log(w, { event: 'skip', bot_username: bot.username, text, reason: 'bot-to-bot ratio' }); continue; }
                botTargets++;
            }
            // Threads
            let threadId = null;
            try {
                if (raw.thread === 'new') {
                    const kind = target === 'bot' ? 'bot_bot' : target === 'streamer' ? 'bot_streamer' : 'bot_viewer';
                    const open = db.getOpenAiViewerThreads(w.userId, 10);
                    if (open.length < (s.max_open_threads || 3)) {
                        const t = db.createAiViewerThread({ channel_user_id: w.userId, stream_id: w.streamId, kind, participants: [bot.username, raw.reply_to].filter(Boolean), topic: raw.topic ? clip(raw.topic, 80) : null, awaiting: target === 'bot' ? raw.reply_to : null });
                        threadId = t && t.id;
                    }
                } else if (raw.thread && /^\d+$/.test(String(raw.thread))) threadId = parseInt(raw.thread, 10);
            } catch { threadId = null; }
            lastBot = bot.username;
            w.recentLines.push(n); if (w.recentLines.length > 30) w.recentLines.shift();
            out.push({ bot: bot.username, botRow: bot, text, target, replyTo: raw.reply_to || null, threadId, delay_ms: Math.max(0, Math.min(45000, parseInt(raw.delay_ms, 10) || 0)), reason: clip(raw.reason, 120), replyToId: (target === 'streamer' && streamerIntent) ? streamerIntent.msgId : null });
        }
        if (out.length) w.scheduler.enqueue(out);
        return out.length;
    }

    _post(w, line) {
        if (w.stopped) return;
        const bot = line.botRow || w.bots.find(b => b.username === line.bot);
        if (!bot) return;
        const id = poster.post(w, bot, line.text, { threadId: line.threadId, replyToId: line.replyToId });
        w.stats.lines++;
        if (line.target === 'streamer') w.lastStreamerReplyAt = Date.now();
        poster.log(w, { event: 'line', bot_username: bot.username, target: line.target + (line.replyTo ? `:${line.replyTo}` : ''), thread_id: line.threadId || null, chat_message_id: id, text: line.text, reason: line.reason });
        const buf = w.botLines.get(bot.id) || []; buf.push(line.text); if (buf.length > 24) buf.shift(); w.botLines.set(bot.id, buf);
        if (line.threadId) {
            try { db.touchAiViewerThread(line.threadId, { line: line.text, by: bot.username, awaiting: line.target === 'bot' ? (line.replyTo || null) : null }); } catch { /* */ }
            // A bot↔bot thread waiting on the other bot pulls the next pass closer.
            if (line.target === 'bot') this._scheduleTick(w, Math.min(this._cadenceMs(w), 12000));
        }
    }

    // ── Streamer fast path ───────────────────────────────────
    async _fastPath(w, { line, bots: named, replyTo, msgId }) {
        const s = w.settings;
        const waitMs = Math.max(0, (s.mention_fast_path_sec || 0) * 1000);
        const nextIn = w.nextTickAt ? w.nextTickAt - Date.now() : Infinity;
        if (nextIn <= waitMs + 1500) { this._scheduleTick(w, Math.min(nextIn, 1500)); return; }   // the director will handle it in time
        const st = budget.status(w.userId);
        if (!st.active || st.mode === 'silent' || w.paused) return;
        const muted = new Set(((s.runtime && s.runtime.muted) || []).map(x => String(x).toLowerCase()));
        const pool = w.bots.filter(b => !muted.has(b.username.toLowerCase()));
        if (!pool.length) return;
        const bot = (named.length && pool.find(b => b.username === named[0])) || pool[Math.floor(Math.random() * pool.length)];
        await this._maybeVision(w, true);
        const stable = context.stablePrefix({ userId: w.userId, stream: w.stream, bots: pool, settings: s, cacheHolder: w });
        const heard = context.heardBlock(w.stream, s);
        const seen = context.seenBlock(w.stream);
        const situation = [
            heard.text ? `Heard on stream recently:\n${heard.text.split('\n').slice(-6).join('\n')}` : '',
            seen.text ? `On screen (${context.ago(seen.ageMs)}): ${seen.text}` : '',
        ].filter(Boolean).join('\n\n');
        const r = await director.quickReply({ stableText: stable.text, situationText: situation, bot, streamerLine: clip(line, 220), maxWords: s.max_words, provider: this._providerFor(w), ownerUserId: w.userId, cacheKey: `aiv:${w.userId}` });
        if (!r || !r.text) return;
        const text = poster.clean(r.text, s.max_words);
        const mod = text ? poster.moderate(text) : { ok: false, reason: 'empty' };
        if (!mod.ok) { poster.log(w, { event: 'skip', bot_username: bot.username, text, reason: mod.reason }); return; }
        w.stats.cost += r.cost || 0;
        w.intents = w.intents.filter(i => i.kind !== 'streamer');   // handled — the next pass must not double-reply
        w.recentLines.push(norm(text)); if (w.recentLines.length > 30) w.recentLines.shift();
        poster.log(w, { event: 'mention', bot_username: bot.username, target: `streamer:${replyTo}`, text, reason: 'fast path — streamer addressed chat', tokens_in: r.usage.input, tokens_cached: r.usage.cached, tokens_out: r.usage.output, cost_usd: r.cost, model: r.model });
        w.scheduler.enqueue([{ bot: bot.username, botRow: bot, text, target: 'streamer', replyTo, threadId: null, delay_ms: 0, reason: 'answering the streamer', replyToId: msgId || null }], { basePrio: 3 });
    }

    // ── Vision policy ────────────────────────────────────────
    async _maybeVision(w, addressed) {
        const s = w.settings;
        if (s.vision_policy === 'off') return;
        const seen = context.seenBlock(w.stream);
        const stale = seen.ageMs == null || seen.ageMs > (s.vision_max_age_sec || 180) * 1000;
        const periodicDue = s.vision_policy === 'periodic' && (Date.now() - w.lastPeriodicVisionAt) > (s.vision_periodic_sec || 300) * 1000 && (Date.now() - w.lastRealInputAt) < 5 * 60000;
        if (!stale && !periodicDue) return;
        const allowFfmpeg = s.vision_policy !== 'thumbnail';
        if (addressed || periodicDue) {
            if (periodicDue) w.lastPeriodicVisionAt = Date.now();
            const p = context.wantFreshFrame(w.stream, { maxAgeSec: s.vision_max_age_sec, allowFfmpeg });
            // Addressed: wait up to 12s so the answer can reference the screen; otherwise fire and forget.
            if (addressed) { const t = new Promise(res => setTimeout(() => res(false), 12000)); const started = await Promise.race([p, t]); if (started) poster.log(w, { event: 'vision', reason: 'fresh frame analyzed (shared memory pipeline)' }); }
            else p.then(ok => { if (ok) poster.log(w, { event: 'vision', reason: 'periodic frame analyzed' }); }).catch(() => {});
        }
    }

    // ── Memory fold ──────────────────────────────────────────
    async _fold(w) {
        try {
            const r = await fold.foldAll(w, { provider: this._providerFor(w) });
            if (r) { w.stats.cost += r.cost || 0; poster.log(w, { event: 'fold', reason: `memory updated for ${r.updated} viewer(s)`, tokens_in: r.usage && r.usage.input, tokens_cached: r.usage && r.usage.cached, tokens_out: r.usage && r.usage.output, cost_usd: r.cost, model: r.model });
                for (let i = 0; i < w.bots.length; i++) { const fresh = db.getChannelAiBot(w.bots[i].id); if (fresh) w.bots[i] = fresh; }
                w.stable = null;
            }
        } catch (e) { poster.log(w, { event: 'error', reason: `fold: ${e.message}` }); }
    }

    // ── Status / preview (control panel) ─────────────────────
    status(userId) {
        const w = this.workerForUser(userId);
        const st = budget.status(userId);
        const timelineOn = (() => { try { return require('../timeline-job').timelineEnabled(); } catch { return false; } })();
        const base = { engine: 'v3', running: !!w, mode: st.mode, budget_active: st.active, budget_reason: st.reason, spent_today_usd: st.spentToday, cap_usd: st.capUsd, timeline_enabled: timelineOn, kill_switch: this._killSwitch() };
        if (!w) return base;
        const seen = context.seenBlock(w.stream);
        const heard = context.heardBlock(w.stream, w.settings);
        return { ...base, stream_id: w.streamId, paused: w.paused, bots: w.bots.length, stats: w.stats, last_tick_at: w.lastTickAt || null, next_tick_in_ms: w.nextTickAt ? Math.max(0, w.nextTickAt - Date.now()) : null,
            queued: w.scheduler.pending(), bot_share: w.scheduler.botShare(), lines_last_minute: w.scheduler.linesLastMinute(),
            senses: { heard_age_ms: heard.ageMs, heard_lines: heard.count, seen_age_ms: seen.ageMs, seen_text: seen.text, stable_prefix_chars: w.stable ? w.stable.text.length : null, stable_cached_since: w.stable ? w.stable.at : null } };
    }

    /** Dry run: assemble the real context and ask the director what it would do (nothing posted). */
    async preview(userId) {
        let w = this.workerForUser(userId);
        let temp = false;
        if (!w) {
            const live = (() => { try { return db.getLiveStreamsByUserId(userId) || []; } catch { return []; } })();
            if (!live.length) return { error: 'Go live first — the preview runs on your real stream context.' };
            const cfg = db.getChannelAiConfig(userId); const settings = settingsMod.getSettings(userId, cfg);
            const bots = roster.ensureRoster(userId, settings.roster_size || 3);
            w = { streamId: live[0].id, userId, stream: db.getStreamById(live[0].id) || live[0], cfg, settings, bots, lastChatId: Math.max(0, db.getMaxChatMessageIdForChannel(userId) - 40), intents: [], scheduler: { botShare: () => 0 } };
            temp = true;
        }
        const s = w.settings;
        const stable = context.stablePrefix({ userId: w.userId, stream: w.stream, bots: w.bots, settings: s, cacheHolder: temp ? null : w });
        const tail = context.volatileTail({ userId: w.userId, stream: w.stream, settings: s, sinceChatId: Math.max(0, (w.lastChatId || 0) - 25), botNames: new Set(w.bots.map(b => b.username.toLowerCase())), intents: w.intents, mode: 'normal', linesAllowed: s.lines_per_tick, botShare: w.scheduler.botShare() });
        const res = await director.plan({ stableText: stable.text, volatileText: tail.text, maxLines: s.lines_per_tick, provider: this._providerFor(w), ownerUserId: w.userId, cacheKey: `aiv:${w.userId}`, temperature: 0.9 });
        return { plan: res ? res.plan : null, usage: res ? res.usage : null, cost: res ? res.cost : null, model: res ? res.model : null, context: { stable_chars: stable.text.length, volatile_chars: tail.text.length, sources: tail.sources }, stable_preview: stable.text.slice(0, 1200), volatile_preview: tail.text.slice(0, 1500) };
    }

    nudge(userId) { const w = this.workerForUser(userId); if (!w) return false; this._scheduleTick(w, 500); return true; }
}

module.exports = new AiViewersEngineV3();
