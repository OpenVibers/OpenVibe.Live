'use strict';
/**
 * Agent stream steps (Agent Streams S2, design 2026-11-06): the lines an agent posts as it works, the overlay the
 * player draws from them and the chapters a recording keeps.
 *
 * A step is `{ at, title, status, detail?, tests?: { passed, failed }, cost_usd? }` (live.agent-stream-step@1). Live
 * stores them with the stream (agent_stream_steps), not with one WHIP session, so they outlive a reconnect and travel
 * with the VOD. The rules are the design's:
 *
 *   - at most one step a second, and at most 2,000 per stream;
 *   - title ≤120 and detail ≤500, plain text, and the house text filters must accept it before it is shown;
 *   - a chapter is each step whose status is 'started' (its title at its time);
 *   - a failed step and the final passed step can be clipped in one tap through Media's clip tools.
 *
 * Everything here is plain text: the overlay builds DOM nodes, never HTML, so a title cannot carry markup.
 */
const db = require('../db/database');
const wordFilter = require('../chat/word-filter');
const moderation = require('../chat/moderation-utils');

const STATUSES = ['started', 'passed', 'failed', 'skipped'];
const MAX_TITLE = 120;
const MAX_DETAIL = 500;
const MAX_STEPS = 2000;
const MIN_INTERVAL_MS = 1000;
const MAX_LIST = 50;

class StepError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

/** Plain text: control characters out, whitespace collapsed, length kept in Unicode code points. */
function plain(value, max) {
    if (typeof value !== 'string') return null;
    const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
    if (!text || Array.from(text).length > max) return null;
    return text;
}

/** Whether the house text filters accept this line. Both are the filter chat runs, so a title cannot say what chat refuses. */
function allowed(text) {
    if (!text) return true;
    try {
        if (!wordFilter.check(text).safe) return false;
    } catch { return false; }
    try {
        if (moderation.containsCoreSlur(text)) return false;
    } catch { return false; }
    return true;
}

function cleanTests(tests) {
    if (tests === undefined || tests === null) return { passed: null, failed: null };
    if (typeof tests !== 'object' || Array.isArray(tests)) throw new StepError(400, 'invalid_tests', 'tests is { passed, failed }');
    const ok = (n) => Number.isInteger(n) && n >= 0 && n <= 1_000_000;
    if (!ok(tests.passed) || !ok(tests.failed)) throw new StepError(400, 'invalid_tests', 'tests.passed and tests.failed are whole numbers, zero or more');
    return { passed: tests.passed, failed: tests.failed };
}

function cleanCost(value) {
    if (value === undefined || value === null) return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw new StepError(400, 'invalid_cost', 'cost_usd is a number, zero or more');
    return Math.round(n * 1e6) / 1e6;
}

/** "now" or the agent's own time, never in the future by more than a minute (a wrong clock must not push a chapter past the VOD). */
function cleanAt(value) {
    if (value === undefined || value === null) return new Date();
    const at = new Date(String(value));
    if (Number.isNaN(at.getTime())) throw new StepError(400, 'invalid_at', 'at is a date-time');
    const now = Date.now();
    if (at.getTime() > now + 60_000) return new Date(now);
    if (at.getTime() < now - 7 * 24 * 60 * 60 * 1000) throw new StepError(400, 'invalid_at', 'at is more than seven days old');
    return at;
}

/** The body of live.agent-stream-step-request@1, cleaned, or a StepError. */
function clean(body) {
    const input = body && typeof body === 'object' ? body : {};
    const title = plain(input.title, MAX_TITLE);
    if (!title) throw new StepError(400, 'invalid_title', 'A title of 1–120 characters is required');
    if (!STATUSES.includes(input.status)) throw new StepError(400, 'invalid_status', 'status is started, passed, failed or skipped');
    const detail = input.detail === undefined || input.detail === null ? null : plain(input.detail, MAX_DETAIL);
    if (input.detail !== undefined && input.detail !== null && !detail) throw new StepError(400, 'invalid_detail', 'The detail is at most 500 characters');
    const tests = cleanTests(input.tests);
    const cost = cleanCost(input.cost_usd);
    if (!allowed(title) || (detail && !allowed(detail))) throw new StepError(422, 'text_rejected', 'That text is not allowed');
    return { at: cleanAt(input.at), title, status: input.status, detail, tests, cost };
}

function stepView(row) {
    const out = {
        id: Number(row.id),
        at: row.at instanceof Date ? row.at.toISOString() : new Date(String(row.at).replace(' ', 'T') + (String(row.at).includes('T') ? '' : 'Z')).toISOString(),
        title: row.title,
        status: row.status,
    };
    if (row.detail) out.detail = row.detail;
    if (row.tests_passed != null || row.tests_failed != null) {
        out.tests = { passed: Number(row.tests_passed) || 0, failed: Number(row.tests_failed) || 0 };
    }
    if (row.cost_usd != null) out.cost_usd = Number(row.cost_usd);
    return out;
}

/**
 * Store one step for a stream. Refuses a second within a second, the 2,001st, and a stream that has ended.
 * Returns the step as the contract has it.
 */
async function add(row, body) {
    if (row.state === 'ended') throw new StepError(409, 'agent_stream_ended', 'This agent stream has ended');
    const step = clean(body);
    const last = await db.get('SELECT created_at, COUNT(*) OVER () AS total FROM agent_stream_steps WHERE managed_stream_id = ? ORDER BY id DESC LIMIT 1', [row.managed_stream_id]);
    if (last) {
        // COUNT(*) OVER () in the same read keeps the cap check off a second query on the hot path.
        if (Number(last.total) >= MAX_STEPS) throw new StepError(429, 'too_many_steps', 'A stream keeps at most 2,000 steps');
        const at = last.created_at instanceof Date ? last.created_at.getTime() : Date.parse(String(last.created_at).includes('T') ? last.created_at : `${String(last.created_at).replace(' ', 'T')}Z`);
        if (Number.isFinite(at) && Date.now() - at < MIN_INTERVAL_MS) throw new StepError(429, 'steps_too_fast', 'One step a second');
    }
    const inserted = await db.get(
        `INSERT INTO agent_stream_steps (managed_stream_id, at, title, status, detail, tests_passed, tests_failed, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [row.managed_stream_id, step.at, step.title, step.status, step.detail, step.tests.passed, step.tests.failed, step.cost]
    );
    return stepView(await db.get('SELECT * FROM agent_stream_steps WHERE id = ?', [inserted.id]));
}

/** The newest `limit` steps, oldest first. */
async function recent(managedStreamId, limit = 20) {
    const n = Math.min(MAX_LIST, Math.max(1, Number(limit) || 20));
    const rows = await db.all('SELECT * FROM agent_stream_steps WHERE managed_stream_id = ? ORDER BY id DESC LIMIT ?', [managedStreamId, n]);
    return rows.reverse().map(stepView);
}

/** Steps stored after `after`, oldest first (the page's live poll). */
async function after(managedStreamId, afterId, limit = MAX_LIST) {
    const n = Math.min(MAX_LIST, Math.max(1, Number(limit) || MAX_LIST));
    const rows = await db.all('SELECT * FROM agent_stream_steps WHERE managed_stream_id = ? AND id > ? ORDER BY id ASC LIMIT ?', [managedStreamId, Number(afterId) || 0, n]);
    return rows.map(stepView);
}

/**
 * The chapters of the recording: every step that started, at its offset from the stream's start.
 * `{ vod_id, chapters: [{ at, title, step_id }] }`; empty before a stream starts.
 */
async function chapters(row) {
    const started = row.started_at ? new Date(String(row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at).replace(' ', 'T') + (String(row.started_at).includes('T') ? '' : 'Z'))).getTime() : null;
    const rows = await db.all("SELECT * FROM agent_stream_steps WHERE managed_stream_id = ? AND status = 'started' ORDER BY at ASC, id ASC", [row.managed_stream_id]);
    const out = [];
    for (const r of rows) {
        const at = new Date(String(r.at instanceof Date ? r.at.toISOString() : String(r.at).replace(' ', 'T') + (String(r.at).includes('T') ? '' : 'Z'))).getTime();
        if (!Number.isFinite(at)) continue;
        const offset = started && Number.isFinite(started) ? Math.max(0, Math.round((at - started) / 1000)) : 0;
        out.push({ at: offset, title: r.title, step_id: Number(r.id) });
    }
    return { vod_id: row.vod_id || null, chapters: out };
}

/**
 * The window around a step for a one-tap clip: five seconds before it began and fifteen after, or the whole gap to the
 * next step when that is shorter. Clamped to zero, never negative.
 */
async function clipWindow(row, stepId) {
    const step = await db.get('SELECT * FROM agent_stream_steps WHERE id = ? AND managed_stream_id = ?', [Number(stepId) || 0, row.managed_stream_id]);
    if (!step) throw new StepError(404, 'step_not_found', 'No such step');
    const started = row.started_at ? new Date(String(row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at).replace(' ', 'T') + (String(row.started_at).includes('T') ? '' : 'Z'))).getTime() : null;
    const at = new Date(String(step.at instanceof Date ? step.at.toISOString() : String(step.at).replace(' ', 'T') + (String(step.at).includes('T') ? '' : 'Z'))).getTime();
    const offset = started && Number.isFinite(started) && Number.isFinite(at) ? Math.max(0, Math.round((at - started) / 1000)) : 0;
    return { step: stepView(step), start_s: Math.max(0, offset - 5), end_s: Math.max(1, offset + 15) };
}

module.exports = {
    STATUSES, MAX_TITLE, MAX_DETAIL, MAX_STEPS, MIN_INTERVAL_MS, StepError,
    plain, allowed, clean, stepView, add, recent, after, chapters, clipWindow,
};
