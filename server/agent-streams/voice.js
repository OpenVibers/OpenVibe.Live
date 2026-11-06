'use strict';
/**
 * The agent's voice (Agent Streams S4, design 2026-11-06).
 *
 * In narrated mode the agent says something now and then: a step starts, a step fails, a result lands, and every
 * few minutes a short line when nothing else was said. This module writes those lines; the desk (OpenVibe.Node) makes
 * the sound, so Live never mixes audio.
 *
 * The rules that hold for every personality:
 *
 *   - one or two sentences, at most 220 characters, taken from the step (title, status, tests) and the task;
 *   - the house text filters have the last word: a line that trips them is not spoken, and the next step gets a
 *     new line (the filter never rewrites a line, it refuses it);
 *   - at most one line every 20 s; if lines pile up the newest one wins (a queue of two, the older one is
 *     dropped); a failure line may interrupt the 20 s gap once;
 *   - the lines run on the person's own AI allowance, under their daily ceiling. When the allowance is spent the
 *     stream pauses its voice and says so.
 *
 * The writer is deliberately small and injectable (now, generate) so the pacing and the filters can be tested
 * without a model and without a clock.
 */
const db = require('../db/database');
const llm = require('../ai/llm');
const wordFilter = require('../chat/word-filter');
const moderation = require('../chat/moderation-utils');

const MAX_CHARS = 220;
const GAP_MS = 20000;
const QUEUE_MAX = 2;
// How long the work may be quiet before the agent says something small on its own.
const IDLE_MS = 5 * 60 * 1000;
const PERSONALITIES = ['calm', 'hype', 'dry', 'roast'];
const SOURCE = 'agent_voice';
const PAUSED_ALLOWANCE = 'allowance_spent';
const PAUSED_MESSAGE = 'voice paused: allowance spent';

/** How each personality says a thing. The rules below are added to every one of them. */
const STYLE = {
    calm: 'Calm and plain. You are the person\u2019s agent, working next to them. One or two sentences, no excitement, no jokes.',
    hype: 'Hype. You are all in: every result is a win worth shouting about, short sentences, an exclamation at the end.',
    dry: 'Dry. Deadpan and brief, as if the work is mildly interesting and you would rather be doing something else.',
    roast: 'Roast. Savage and crude: you swear, you are dark about the chat\u2019s takes, the code and your own mistakes. You are still on the person\u2019s side.',
};

/** The rules that hold in every personality: no slurs, no hate speech against a protected group, no doxxing. */
const RULES = [
    'You speak for the person whose agent you are.',
    'One or two sentences. At most 220 characters. No emoji, no markdown, no stage directions, no quotation marks around the whole line.',
    'Never use a slur, never make a joke about a protected group, and never doxx anybody: no real names, no handles, no addresses, no phone numbers, no emails.',
    'Say what happened: the step, its status, the tests, the task. Do not invent results.',
].join(' ');

function personalityOf(row) {
    const p = row && row.personality;
    return PERSONALITIES.includes(p) ? p : 'calm';
}

function narrated(row) { return !!row && row.mode === 'narrated'; }
function muted(row) { return !!row && !!Number(row.voice_muted); }

/** Doxxing: an email address, a phone number, a street address or a handle. */
function doxxes(text) {
    if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text)) return true;
    if (/\+?\d[\d\s().-]{7,}\d/.test(text)) return true;
    if (/\b\d{1,5}\s+[A-Z][a-z]+\s+(street|st|avenue|ave|road|rd|lane|drive|dr|boulevard|blvd)\b/i.test(text)) return true;
    if (/@\w{3,}/.test(text)) return true;
    return false;
}

/** The house text filters, the same ones chat runs, plus the no-doxxing rule. They refuse a line; they never rewrite one. */
function allowed(text) {
    if (!text) return false;
    try { if (!wordFilter.check(text).safe) return false; } catch { return false; }
    try { if (moderation.containsCoreSlur(text)) return false; } catch { return false; }
    try { if (moderation.friendlyFilterCategory(text)) return false; } catch { return false; }
    return !doxxes(text);
}

/** At most 220 characters, cut at a sentence end when there is one, otherwise at a word. */
function clamp(text) {
    const clean = String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    if (Array.from(clean).length <= MAX_CHARS) return clean;
    const cut = Array.from(clean).slice(0, MAX_CHARS).join('');
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    if (stop > 40) return cut.slice(0, stop + 1).trim();
    const space = cut.lastIndexOf(' ');
    return (space > 40 ? cut.slice(0, space) : cut).trim();
}

/** What the writer knows about the stream: the task and the step that just happened. */
function factsFor(row, step) {
    const task = taskOf(row);
    const title = typeof task.title === 'string' ? task.title : '';
    const lines = [];
    if (title) lines.push('The task: ' + title);
    if (step) {
        lines.push('The step: ' + (step.title || '') + (step.status ? ' (' + step.status + ')' : ''));
        if (step.detail) lines.push('What happened: ' + step.detail);
        if (step.tests && (step.tests.passed != null || step.tests.failed != null)) {
            lines.push('The tests: ' + (step.tests.passed || 0) + ' passing, ' + (step.tests.failed || 0) + ' failing');
        }
    }
    return lines.join('\n');
}

/** The task of a stream, whether the database gave it as an object or as JSON text. */
function taskOf(row) {
    const raw = row && row.task;
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try { const parsed = JSON.parse(String(raw)); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; }
}

/** The facts an idle line needs: the task, and the fact that nothing new happened. */
function idleFacts(row) {
    const task = taskOf(row);
    const title = typeof task.title === 'string' ? task.title : '';
    const lines = [];
    if (title) lines.push('The task: ' + title);
    lines.push('Nothing new to report right now.');
    return lines.join('\n');
}

function kindOf(step) {
    if (!step) return 'step';
    if (step.status === 'failed') return 'failure';
    if (step.status === 'passed') return 'result';
    return 'step';
}

/** The person's own allowance: their daily ceiling in cents against what the voice has spent today. */
async function allowanceSpent(userId) {
    if (!userId) return false;
    let cap = 0;
    try {
        const cfg = await db.getChannelAiConfig(userId);
        cap = Number(cfg && cfg.daily_budget_cents) || 0;
    } catch { return false; }
    if (cap <= 0) return false;
    let spent = 0;
    try { spent = Number(await db.getAiCostTodayForUser(userId, SOURCE)) || 0; } catch { return false; }
    return spent * 100 >= cap;
}

/** The voice as the owner page, the desk and the overlay see it. */
function voiceState(row) {
    const paused = row && row.voice_paused ? String(row.voice_paused) : null;
    return {
        mode: (row && row.mode) || 'watch',
        personality: personalityOf(row),
        voice: (row && row.voice) || null,
        muted: muted(row),
        own: !!(row && Number(row.voice_own)),
        own_consent_at: row && row.voice_own_consent_at ? new Date(row.voice_own_consent_at).toISOString() : null,
        paused,
        ...(paused === PAUSED_ALLOWANCE ? { message: PAUSED_MESSAGE } : {}),
    };
}

class Writer {
    /**
     * @param {object} opts
     *   now      the clock (ms), so the pacing can be tested
     *   generate the line writer: (row, step) -> Promise<string|null>
     */
    constructor(opts = {}) {
        this.now = opts.now || (() => Date.now());
        this.generate = opts.generate || defaultGenerate;
        this.queues = new Map();
    }

    queue(key) {
        let q = this.queues.get(key);
        if (!q) { q = { pending: [], lastEmitAt: 0, interruptUsed: false }; this.queues.set(key, q); }
        return q;
    }

    /** The lines waiting to be said for a stream (its own queue, for the tests and the desk's view). */
    pending(managedStreamId) {
        const q = this.queues.get(managedStreamId);
        return q ? q.pending.slice() : [];
    }

    /**
     * Write a line for a step. Returns the line that was written, or null when nothing was written (not narrated,
     * muted, the allowance is spent, or the house filters refused it).
     */
    async onStep(row, step) {
        if (!narrated(row) || muted(row)) return null;
        if (await allowanceSpent(row.user_id)) {
            await pause(row, PAUSED_ALLOWANCE);
            return null;
        }
        const kind = kindOf(step);
        let text = null;
        try { text = await this.generate(row, step, kind); } catch { return null; }
        const line = clamp(text);
        if (!line || !allowed(line)) return null;
        const q = this.queue(row.managed_stream_id);
        q.pending.push({ text: line, kind, at: new Date(this.now()).toISOString() });
        // A queue of two: the oldest line is dropped, so the newest one is the one that gets said.
        while (q.pending.length > QUEUE_MAX) q.pending.shift();
        return await this.tick(row);
    }

    /**
     * The occasional idle line: when the work has gone quiet for a while, say something small. The queue's own gap
     * still rules, so an idle line never jumps ahead of a real one.
     */
    async maybeIdle(row) {
        if (!narrated(row) || muted(row)) return null;
        const q = this.queue(row.managed_stream_id);
        if (this.now() - q.lastEmitAt < IDLE_MS) return null;
        if (await allowanceSpent(row.user_id)) { await pause(row, PAUSED_ALLOWANCE); return null; }
        let text = null;
        try { text = await this.generate(row, null, 'idle'); } catch { return null; }
        const line = clamp(text);
        if (!line || !allowed(line)) return null;
        q.pending.push({ text: line, kind: 'idle', at: new Date(this.now()).toISOString() });
        return await this.tick(row);
    }

    /**
     * Say the next line if it is time: at most one line every 20 s, the newest queued line wins, and a failure
     * line may interrupt the gap once.
     */
    async tick(row) {
        if (!narrated(row) || muted(row)) return null;
        const q = this.queue(row.managed_stream_id);
        if (!q.pending.length) return null;
        const now = this.now();
        const newest = q.pending[q.pending.length - 1];
        // Nothing said yet means the first line is due at once; after that the 20 s gap rules.
        const due = !q.lastEmitAt || now - q.lastEmitAt >= GAP_MS;
        const interrupting = newest.kind === 'failure' && !q.interruptUsed;
        if (!due && !interrupting) return null;
        if (interrupting) q.interruptUsed = true;
        q.pending = [];
        q.lastEmitAt = now;
        return await save(row, newest);
    }
}

async function pause(row, reason) {
    try {
        await db.run('UPDATE agent_streams SET voice_paused = ?, updated_at = now() WHERE managed_stream_id = ?', [reason, row.managed_stream_id]);
        row.voice_paused = reason;
    } catch { /* the pause is best-effort; the next step tries again */ }
}

/** Keep a line for the overlay's caption, the recording's WebVTT and the desk. */
async function save(row, line) {
    const out = {
        id: null,
        at: line.at,
        text: line.text,
        kind: line.kind,
        personality: personalityOf(row),
        voice: (row && row.voice) || null,
    };
    try {
        const saved = await db.get(
            'INSERT INTO agent_stream_lines (managed_stream_id, at, text, personality, voice, kind) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
            [row.managed_stream_id, out.at, out.text, out.personality, out.voice, out.kind]);
        out.id = saved ? Number(saved.id) : null;
    } catch { /* the line is still said; the caption is lost */ }
    return out;
}

/** The lines the desk has not read yet: the newest ones after an id. */
async function linesAfter(managedStreamId, afterId, limit = 20) {
    const rows = await db.all(
        'SELECT id, at, text, kind, personality, voice FROM agent_stream_lines WHERE managed_stream_id = ? AND id > ? ORDER BY id LIMIT ?',
        [managedStreamId, Number(afterId) || 0, Math.min(50, Math.max(1, Number(limit) || 20))]);
    return rows.map((r) => ({
        id: Number(r.id),
        at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
        text: r.text,
        kind: r.kind,
        personality: r.personality,
        voice: r.voice || null,
    }));
}

/** The lines of a recording, as WebVTT: the captions the VOD carries. */
async function captions(managedStreamId, startedAt) {
    const rows = await db.all(
        'SELECT at, text FROM agent_stream_lines WHERE managed_stream_id = ? ORDER BY id',
        [managedStreamId]);
    const base = startedAt ? new Date(startedAt).getTime() : 0;
    const cues = [];
    for (const r of rows) {
        const at = r.at instanceof Date ? r.at.getTime() : Date.parse(String(r.at));
        const start = Math.max(0, (at - base) / 1000);
        cues.push({ start, text: r.text });
    }
    return cues;
}

/** A WebVTT file for the recording: the lines, timed from the start of the stream. */
function webvtt(cues) {
    const stamp = (seconds) => {
        const s = Math.max(0, seconds);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        const pad = (n, width) => String(n).padStart(width, '0');
        return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(sec.toFixed(3), 6);
    };
    const out = ['WEBVTT', ''];
    cues.forEach((cue, index) => {
        const end = cue.end != null ? cue.end : cue.start + 4;
        out.push(String(index + 1));
        out.push(stamp(cue.start) + ' --> ' + stamp(end));
        out.push(cue.text);
        out.push('');
    });
    return out.join('\n');
}

/** The line itself: one call to OpenVibe.AI, metered on the person's own allowance. */
async function defaultGenerate(row, step, kind = 'step') {
    const facts = kind === 'idle' ? idleFacts(row) : factsFor(row, step);
    if (!facts) return null;
    // The economy preset: the router's prose route with a small ceiling, metered on the person's allowance.
    const result = await llm.complete({
        role: 'summary',
        kind: 'agent_voice',
        source: SOURCE,
        ownerUserId: row.user_id,
        system: STYLE[personalityOf(row)] + ' ' + RULES,
        user: facts,
        maxTokens: 120,
        temperature: 0.8,
        timeoutMs: 20000,
    });
    if (!result || !result.text) return null;
    return result.text;
}

const writer = new Writer();

module.exports = {
    MAX_CHARS, GAP_MS, QUEUE_MAX, IDLE_MS, PERSONALITIES, SOURCE, PAUSED_ALLOWANCE, PAUSED_MESSAGE,
    Writer, writer,
    allowed, clamp, doxxes, factsFor, idleFacts, kindOf, personalityOf, voiceState, allowanceSpent, pause, taskOf,
    linesAfter, captions, webvtt,
};
