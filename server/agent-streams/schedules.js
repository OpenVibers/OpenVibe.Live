'use strict';
/**
 * Scheduled public agent streams (Agent Streams S7, design 2026-11-06).
 *
 * An owner schedules a public agent stream: a time, a task template (a Codes task or an Actor recipe) and the mode.
 * The record shows on the channel's Agents tab and in Today 24 hours before its time. When the time comes the owner's
 * desk claims it: Live creates the stream and hands the desk a publish ticket (the ticket is issued once and never
 * stored raw). A desk that is not online does not claim, and the sweep records the schedule as missed with
 * `desk_offline` — the design's "didn't start: the desk was offline" — and starts nothing.
 *
 * A chatplays schedule never starts on its own: it keeps its time and `waits_for_go` until the owner presses Go (the
 * S6 rule). Reminders are opt-in only: a follower asks, the row names them, and every public view carries the count.
 *
 * The desk heartbeat (agent_desks) tells the sweep whether the owner's desk was online at the time, so the card can
 * say which of the two happened. A heartbeat is a fact, not a stream.
 */
const db = require('../db/database');
const contracts = require('openvibe-contracts');
const service = require('./service');

const MODES = service.MODES;
const MAX_TITLE = 200;
const MAX_TASK_REF = 200;
const AHEAD_MS = 24 * 60 * 60 * 1000;
const SCHEDULE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DESK_ONLINE_MS = 3 * 60 * 1000;
const MISS_GRACE_MS = 60 * 1000;
const TASK_SOURCES = service.TASK_SOURCES;

class ScheduleError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function text(value, max) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    return s && Array.from(s).length <= max ? s : null;
}

function cleanTask(task) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) return null;
    const source = TASK_SOURCES.includes(task.source) ? task.source : null;
    const ref = text(task.ref, MAX_TASK_REF);
    const title = text(task.title, MAX_TITLE);
    if (!source || !ref || !title) return null;
    const url = task.url == null ? null : (typeof task.url === 'string' && /^https?:\/\//i.test(task.url) && task.url.length <= 2000 ? task.url : undefined);
    if (url === undefined) return null;
    return { source, ref, title, url };
}

function cleanStart(value, now = Date.now()) {
    const at = new Date(String(value || ''));
    if (Number.isNaN(at.getTime())) throw new ScheduleError(400, 'invalid_starts_at', 'starts_at is a date-time');
    if (at.getTime() < now + 60 * 1000) throw new ScheduleError(400, 'starts_at_past', 'A schedule starts at least a minute from now');
    if (at.getTime() > now + SCHEDULE_WINDOW_MS) throw new ScheduleError(400, 'starts_at_far', 'A schedule is at most 30 days away');
    return at;
}

const ID_RE = /^scd_[0-9A-HJKMNP-TV-Z]{26}$/;
const newId = () => 'scd_' + contracts.ids.ulid();

const SELECT = `
    SELECT sc.*, u.username, u.display_name,
           la.subject_id AS owner_subject,
           ms.public_id AS agent_stream_id,
           (SELECT COUNT(*) FROM agent_schedule_reminders r WHERE r.schedule_id = sc.id) AS reminders,
           EXISTS(SELECT 1 FROM agent_schedule_reminders r WHERE r.schedule_id = sc.id AND r.subject_id = ?) AS reminded
    FROM agent_stream_schedules sc
    JOIN users u ON u.id = sc.user_id
    LEFT JOIN linked_accounts la ON la.service = 'network' AND la.user_id = sc.user_id
    LEFT JOIN managed_streams ms ON ms.id = sc.managed_stream_id`;

function pageUrl(row) {
    const base = String(require('../config').baseUrl || 'https://openvibe.live').replace(/\/+$/, '');
    return `${base}/@${encodeURIComponent(row.username || '')}/agents`;
}

function scheduleView(row, { subject = null } = {}) {
    if (!row) return null;
    return {
        id: row.id,
        owner: row.owner_subject || null,
        channel: row.username,
        title: row.title,
        task: typeof row.task === 'string' ? JSON.parse(row.task) : (row.task || {}),
        mode: row.mode,
        visibility: row.visibility,
        starts_at: service.iso(row.starts_at),
        state: row.state,
        agent_stream_id: row.agent_stream_id || null,
        missed_reason: row.missed_reason || null,
        waits_for_go: !!row.waits_for_go,
        started_at: service.iso(row.started_at),
        ended_at: service.iso(row.ended_at),
        reminders: Number(row.reminders) || 0,
        ...(subject ? { reminded: !!Number(row.reminded) } : {}),
        page_url: pageUrl(row),
        created_at: service.iso(row.created_at),
    };
}

async function get(id, { subject = null } = {}) {
    if (!ID_RE.test(String(id || ''))) return null;
    const row = await db.get(`${SELECT} WHERE sc.id = ?`, [subject || null, id]);
    return row ? scheduleView(row, { subject }) : null;
}

async function rowOf(id) {
    if (!ID_RE.test(String(id || ''))) return null;
    return await db.get('SELECT * FROM agent_stream_schedules WHERE id = ?', [id]) || null;
}

/** A new schedule. The route has already checked the owner's permission; this checks the record's own rules. */
async function create({ user, title, task, mode = 'watch', startsAt }) {
    const cleanTitle = text(title, MAX_TITLE);
    if (!cleanTitle) throw new ScheduleError(400, 'invalid_title', 'A title of 1–200 characters is required');
    const clean = cleanTask(task);
    if (!clean) throw new ScheduleError(400, 'invalid_task', 'task needs source (codes, actor, desk, node), ref and title');
    if (!MODES.includes(mode)) throw new ScheduleError(400, 'invalid_mode', 'mode is watch, narrated, copilot or chatplays');
    const at = cleanStart(startsAt);
    const id = newId();
    await db.run(
        `INSERT INTO agent_stream_schedules (id, user_id, title, task, mode, visibility, starts_at)
         VALUES (?, ?, ?, ?::jsonb, ?, 'public', ?)`,
        [id, user.id, cleanTitle, JSON.stringify(clean), mode, at]
    );
    return await get(id, { subject: await service.ownerSubject(user.id) });
}

/** The owner's own schedules, the next one first. */
async function listMine(userId, { subject = null } = {}) {
    const rows = await db.all(`${SELECT} WHERE sc.user_id = ? ORDER BY (sc.state = 'scheduled') DESC, sc.starts_at ASC LIMIT 100`, [subject || null, userId]);
    return rows.map((row) => scheduleView(row, { subject }));
}

/**
 * The public schedules a page may show: public, still waiting, and inside the next 24 hours (the design's window).
 * The owner's own page also sees their whole list (the channel's Agents tab).
 */
async function listPublic({ channel = null, now = Date.now(), subject = null, limit = 100 } = {}) {
    const params = [subject || null, new Date(now), new Date(now + AHEAD_MS)];
    let where = "sc.visibility = 'public' AND sc.state = 'scheduled' AND sc.starts_at >= ? AND sc.starts_at <= ?";
    if (channel) { where += ' AND LOWER(u.username) = LOWER(?)'; params.push(String(channel)); }
    params.push(Math.min(200, Math.max(1, Number(limit) || 100)));
    const rows = await db.all(`${SELECT} WHERE ${where} ORDER BY sc.starts_at ASC, sc.id ASC LIMIT ?`, params);
    return rows.map((row) => scheduleView(row, { subject }));
}

/** The owner's whole list plus the public window, for the channel Agents tab. */
async function listForChannel(username, viewerId, { subject = null } = {}) {
    const rows = await db.all(`${SELECT} WHERE LOWER(u.username) = LOWER(?) ORDER BY sc.starts_at ASC LIMIT 200`, [subject || null, String(username)]);
    return rows.filter((row) => Number(row.user_id) === Number(viewerId || 0)
        || (row.visibility === 'public' && row.state === 'scheduled' && Date.parse(service.iso(row.starts_at)) <= Date.now() + AHEAD_MS));
}

/** Cancel one of the owner's schedules. A started or finished one is not cancellable here. */
async function cancel(id, user) {
    const row = await rowOf(id);
    if (!row) throw new ScheduleError(404, 'schedule_not_found', 'No such schedule');
    if (Number(row.user_id) !== Number(user.id)) throw new ScheduleError(403, 'not_your_schedule', 'This schedule belongs to another account');
    if (row.state !== 'scheduled') throw new ScheduleError(409, 'schedule_not_cancellable', 'This schedule already started or ended');
    await db.run("UPDATE agent_stream_schedules SET state = 'cancelled', updated_at = now() WHERE id = ?", [id]);
    return await get(id);
}

/** Opt in to a reminder (idempotent). The answer is the count, never the names. */
async function remind(id, subject) {
    if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(subject || ''))) throw new ScheduleError(409, 'no_subject', 'This account has no OpenVibe subject yet; sign in again');
    const row = await rowOf(id);
    if (!row) throw new ScheduleError(404, 'schedule_not_found', 'No such schedule');
    // Only a schedule this person may see: a public one inside its 24-hour window (a private one's id is not an
    // invitation; the answer is the same 404 as a missing one).
    if (row.visibility !== 'public' || Date.parse(service.iso(row.starts_at)) > Date.now() + AHEAD_MS) throw new ScheduleError(404, 'schedule_not_found', 'No such schedule');
    if (row.state !== 'scheduled' || Date.parse(service.iso(row.starts_at)) < Date.now()) throw new ScheduleError(409, 'schedule_over', 'This schedule has already started or ended');
    await db.run('INSERT INTO agent_schedule_reminders (schedule_id, subject_id) VALUES (?, ?) ON CONFLICT (schedule_id, subject_id) DO NOTHING', [id, subject]);
    const n = Number((await db.get('SELECT COUNT(*) AS n FROM agent_schedule_reminders WHERE schedule_id = ?', [id]))?.n || 0);
    return { reminders: n, reminded: true };
}

/** The desk says it is online. A heartbeat is a fact, not a stream: it carries no ticket. */
async function heartbeat(user, version = null) {
    await db.run(
        `INSERT INTO agent_desks (user_id, last_seen_at, version) VALUES (?, now(), ?)
         ON CONFLICT (user_id) DO UPDATE SET last_seen_at = now(), version = COALESCE(excluded.version, agent_desks.version)`,
        [user.id, typeof version === 'string' ? version.slice(0, 80) : null]
    );
    return { online: true, at: new Date().toISOString() };
}

async function deskSeen(userId) {
    const row = await db.get('SELECT last_seen_at FROM agent_desks WHERE user_id = ?', [userId]);
    const at = row ? Date.parse(service.iso(row.last_seen_at)) : NaN;
    return Number.isFinite(at) ? at : null;
}

/**
 * The sweep's part: a schedule whose time passed and that nobody claimed becomes missed. A chatplays one keeps its
 * time and says it waits for Go; nothing is started in either case.
 */
async function startDue({ now = Date.now() } = {}) {
    const rows = await db.all(
        "SELECT * FROM agent_stream_schedules WHERE state = 'scheduled' AND starts_at <= ? ORDER BY starts_at ASC LIMIT 200",
        [new Date(now - MISS_GRACE_MS)]
    );
    const out = { missed: 0, waiting: 0 };
    for (const row of rows) {
        if (row.mode === 'chatplays') {
            if (!row.waits_for_go || row.missed_reason !== 'waits_for_go') {
                await db.run("UPDATE agent_stream_schedules SET waits_for_go = true, missed_reason = 'waits_for_go', updated_at = now() WHERE id = ?", [row.id]);
            }
            out.waiting++;
            continue;
        }
        const seen = await deskSeen(row.user_id);
        const online = seen != null && now - seen <= DESK_ONLINE_MS;
        await db.run(
            "UPDATE agent_stream_schedules SET state = 'missed', missed_reason = ?, updated_at = now() WHERE id = ?",
            [online ? 'task_not_ready' : 'desk_offline', row.id]
        );
        out.missed++;
    }
    return out;
}

/**
 * The owner's desk claims a due schedule: Live creates the stream and answers the one publish ticket. A chatplays
 * schedule is refused until the owner's Go; a schedule that is not due, or not the caller's, is refused too.
 */
async function claim(id, user, { go = false, now = Date.now() } = {}) {
    const row = await db.get(
        `SELECT sc.*, u.username, la.subject_id AS owner_subject FROM agent_stream_schedules sc
         JOIN users u ON u.id = sc.user_id
         LEFT JOIN linked_accounts la ON la.service = 'network' AND la.user_id = sc.user_id
         WHERE sc.id = ?`, [id]
    );
    if (!row) throw new ScheduleError(404, 'schedule_not_found', 'No such schedule');
    if (Number(row.user_id) !== Number(user.id)) throw new ScheduleError(403, 'not_your_schedule', 'This schedule belongs to another account');
    if (row.state !== 'scheduled') throw new ScheduleError(409, 'schedule_not_scheduled', 'This schedule already started or ended');
    if (Date.parse(service.iso(row.starts_at)) > now + 60 * 1000) throw new ScheduleError(409, 'schedule_not_due', 'This schedule is not due yet');
    if (row.mode === 'chatplays' && !go) {
        await db.run("UPDATE agent_stream_schedules SET waits_for_go = true, missed_reason = 'waits_for_go', updated_at = now() WHERE id = ?", [id]);
        throw new ScheduleError(409, 'waits_for_go', 'A chat plays schedule waits for the owner\'s Go');
    }
    // The stream is the schedule's, and only one stream may come from it: the row flips first, in one statement.
    const claimed = await db.run(
        `UPDATE agent_stream_schedules SET state = 'live', started_at = now(), waits_for_go = false, missed_reason = NULL, updated_at = now()
         WHERE id = ? AND state = 'scheduled' RETURNING id`, [id]
    );
    if (!claimed.changes) throw new ScheduleError(409, 'schedule_not_scheduled', 'This schedule already started or ended');
    let stream;
    let publish;
    try {
        stream = await service.create({
            user, title: row.title, task: typeof row.task === 'string' ? JSON.parse(row.task) : row.task,
            visibility: 'public', mode: row.mode,
        });
        publish = await require('./tickets').issuePublish(stream.managed_stream_id);
        await db.run('UPDATE agent_stream_schedules SET managed_stream_id = ?, updated_at = now() WHERE id = ?', [stream.managed_stream_id, id]);
    } catch (err) {
        await db.run("UPDATE agent_stream_schedules SET state = 'scheduled', started_at = NULL, updated_at = now() WHERE id = ? AND state = 'live' AND managed_stream_id IS NULL", [id]);
        throw err;
    }
    return {
        schedule: await get(id, { subject: row.owner_subject }),
        stream: service.publicView(stream),
        publish: { whip_url: service.whipUrl(stream.public_id), ...publish },
    };
}

/** The stream a schedule started ended with it. Called from service.end, in the same request. */
async function markEnded(managedStreamId) {
    if (!managedStreamId) return;
    await db.run("UPDATE agent_stream_schedules SET state = 'ended', ended_at = now(), updated_at = now() WHERE managed_stream_id = ? AND state = 'live'", [managedStreamId]);
}

module.exports = {
    AHEAD_MS, DESK_ONLINE_MS, MISS_GRACE_MS, SCHEDULE_WINDOW_MS, ScheduleError,
    cleanTask, newId, get, create, listMine, listPublic, listForChannel, cancel, remind, heartbeat, deskSeen, startDue, claim, markEnded,
    scheduleView,
};
