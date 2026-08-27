/**
 * AI viewers v3 — pacing. Planned lines go into a per-stream queue and are released
 * humanly: a minimum gap between any two bot lines, a per-minute ceiling, slow-mode
 * awareness, no bot twice in a row, and a rolling bot-to-bot share cap.
 */
'use strict';

function rint(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }

class Scheduler {
    constructor(worker, deps) {
        this.worker = worker;           // { streamId, settings, ... }
        this.deps = deps;               // { post(line), now() }
        this.queue = [];                // [{ bot, text, target, replyTo, threadId, postAt, prio, reason }]
        this.recent = [];               // [{ at, target, bot }] last 40 posted
        this.lastPostAt = 0;
        this.lastBot = null;
        this.timer = null;
        this.stopped = false;
    }

    settings() { return this.worker.settings || {}; }

    /** Queue planned lines (from a director pass). */
    enqueue(lines, { basePrio = 1 } = {}) {
        const now = Date.now();
        for (const l of lines) {
            const jitter = rint(0, 2500);
            const prio = l.target === 'streamer' ? 3 : basePrio;
            this.queue.push({ ...l, prio, postAt: now + (prio === 3 ? Math.min(l.delay_ms || 0, 4000) : (l.delay_ms || 0)) + jitter });
        }
        // Keep the queue bounded: newest plans win over stale unposted ambient chatter.
        if (this.queue.length > 12) this.queue = this.queue.sort((a, b) => b.prio - a.prio || a.postAt - b.postAt).slice(0, 12);
        this._arm();
    }

    /** Drop everything not yet posted (config change / pause / stop). */
    clear() { this.queue = []; if (this.timer) { clearTimeout(this.timer); this.timer = null; } }

    stop() { this.stopped = true; this.clear(); }

    pending() { return this.queue.length; }

    /** Share of bot→bot lines over the last 20 posts (0..1). */
    botShare() {
        const last = this.recent.slice(-20);
        if (!last.length) return 0;
        return last.filter(r => r.target === 'bot').length / last.length;
    }
    linesLastMinute() { const cut = Date.now() - 60000; return this.recent.filter(r => r.at > cut).length; }

    _slowModeMs() {
        try { const cs = require('../../chat/chat-server'); return cs.slowModeByStream ? (cs.slowModeByStream.get(this.worker.streamId) || 0) : 0; } catch { return 0; }
    }

    _arm(delay = null) {
        if (this.stopped || this.timer || !this.queue.length) return;
        const next = Math.min(...this.queue.map(q => q.postAt));
        const wait = delay != null ? delay : Math.max(250, next - Date.now());
        this.timer = setTimeout(() => { this.timer = null; this._drain(); }, wait);
    }

    _drain() {
        if (this.stopped || !this.queue.length) return;
        const s = this.settings();
        const now = Date.now();
        const minGap = Math.max((s.min_gap_sec || 4) * 1000, this._slowModeMs());
        if (now - this.lastPostAt < minGap) return this._arm(minGap - (now - this.lastPostAt));
        const perMin = Math.max(0.5, s.lines_per_min || 3);
        if (this.linesLastMinute() >= perMin) return this._arm(5000);

        // Pick the highest-priority due line that doesn't violate the alternation/ratio rules.
        const due = this.queue.filter(q => q.postAt <= now).sort((a, b) => b.prio - a.prio || a.postAt - b.postAt);
        if (!due.length) return this._arm();
        let pick = null;
        for (const q of due) {
            if (q.bot === this.lastBot && due.length > 1) continue;
            if (q.target === 'bot' && this.botShare() >= (s.bot_to_bot_ratio || 0) + 0.05 && q.prio < 3) continue;
            pick = q; break;
        }
        if (!pick) {
            // Everything due is blocked by the ratio/alternation rules — drop stale bot↔bot chatter.
            const stale = due.find(q => q.target === 'bot' && q.prio < 3);
            if (stale) { this.queue = this.queue.filter(q => q !== stale); this.deps.dropped && this.deps.dropped(stale, 'bot-to-bot share cap'); }
            return this._arm(3000);
        }
        this.queue = this.queue.filter(q => q !== pick);
        try { this.deps.post(pick); } catch (e) { console.warn('[AI-Viewers] post failed:', e.message); }
        this.lastPostAt = Date.now();
        this.lastBot = pick.bot;
        this.recent.push({ at: this.lastPostAt, target: pick.target, bot: pick.bot });
        if (this.recent.length > 40) this.recent.shift();
        this._arm();
    }
}

module.exports = { Scheduler };
