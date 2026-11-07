'use strict';
/**
 * The sandbox worker registry (Agent Streams S6, design 2026-11-06, §1).
 *
 * A chat plays request runs in a network-isolated worker: a container or namespace with no host network, no
 * credentials and no access to the owner's files, whose egress goes through a proxy that applies the guard.
 * That worker is not built yet. Until one is registered and healthy, Live refuses the chat plays mode: the
 * mode may not be switched on, Go may not be pressed, and the owner page says so in as many words.
 *
 * Who may register a worker: only OpenVibe's sandbox worker itself. It checks in with a Network service
 * token whose principal holds the capability live.agent_sandbox.register, and it names the person it works
 * for. The owner cannot register one, a desk ticket cannot, and nobody else can: an owner who could would
 * declare their own unisolated machine a sandbox, and the gate would mean nothing.
 *
 * Health comes only from the worker's own check-ins: a check-in within the last WORKER_STALE_MS (a minute)
 * that reports the isolation Live requires. The owner can read that state and cannot change it.
 *
 * Live never stores an endpoint and never calls the worker: the worker reports, it is not called.
 */
const crypto = require('crypto');
const db = require('../db/database');

const WORKER_STALE_MS = 60 * 1000;
const REASON = 'Needs the sandbox worker; coming soon';

// The isolation a worker must report: no host network, no credentials, no profile, and every egress
// request through the proxy that applies the guard.
const REQUIRED_ISOLATION = {
    host_network: false,
    credentials: false,
    profile: false,
    egress_proxy: true,
    workspace: 'ephemeral',
};

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid(now = Date.now()) {
    let time = '';
    for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = ALPHABET[t % 32] + time;
    const bytes = crypto.randomBytes(16);
    let rand = '';
    for (let i = 0; i < 16; i++) rand += ALPHABET[bytes[i] % 32];
    return time + rand;
}

/** Does the report say the worker is isolated the way Live requires? */
function isolationOk(report) {
    if (!report || typeof report !== 'object') return false;
    for (const [key, want] of Object.entries(REQUIRED_ISOLATION)) {
        if (report[key] !== want) return false;
    }
    return true;
}

/**
 * The worker of a person. It answers { ok: true, worker } when one is there and healthy, and
 * { ok: false, code, reason } when it is not: the mode is refused either way.
 */
async function workerFor(subject, { now = Date.now() } = {}) {
    if (!subject) return { ok: false, code: 'sandbox_worker_missing', reason: REASON };
    let row = null;
    try {
        row = await db.getDb().prepare(
            "SELECT * FROM agent_sandbox_workers WHERE subject = ? AND status = 'ready' LIMIT 1").get(String(subject));
    } catch (err) {
        // No table yet (an older release): there is no worker.
        return { ok: false, code: 'sandbox_worker_missing', reason: REASON };
    }
    if (!row) return { ok: false, code: 'sandbox_worker_missing', reason: REASON };
    const seen = Number(row.last_seen_at) || 0;
    if (!seen || now - seen > WORKER_STALE_MS) {
        return { ok: false, code: 'sandbox_worker_stale', reason: REASON, worker: row };
    }
    // The worker must still report the isolation Live requires.
    let isolation = null;
    try { isolation = typeof row.isolation === 'string' ? JSON.parse(row.isolation) : row.isolation; } catch { isolation = null; }
    if (!isolationOk(isolation)) {
        return { ok: false, code: 'sandbox_worker_not_isolated', reason: REASON, worker: row };
    }
    return { ok: true, worker: row };
}

/** The worker checks in: it is there, now, and it says how it is isolated. */
async function checkIn({ subject, service = 'unknown', isolation = null, now = Date.now() }) {
    if (!subject) return { ok: false, code: 'sandbox_worker_no_subject' };
    if (!isolationOk(isolation)) {
        // A worker that cannot say it is isolated is not one: it is not registered at all.
        return { ok: false, code: 'sandbox_worker_not_isolated' };
    }
    const at = Number(now);
    const existing = await db.getDb().prepare('SELECT id FROM agent_sandbox_workers WHERE subject = ? LIMIT 1').get(String(subject));
    const id = (existing && existing.id) || ('sbw_' + ulid(at));
    await db.getDb().prepare(
        `INSERT INTO agent_sandbox_workers (id, subject, service, isolation, status, last_seen_at, created_at)
         VALUES (?, ?, ?, ?, 'ready', ?, ?)
         ON CONFLICT (subject) DO UPDATE SET status = 'ready', service = excluded.service,
             isolation = excluded.isolation, last_seen_at = excluded.last_seen_at`)
        .run(id, String(subject), String(service || 'unknown'), JSON.stringify(isolation), at, at);
    return { ok: true, id, subject: String(subject), last_seen_at: at };
}

/** What the owner page shows: is there a worker, and is it healthy? */
async function state(subject, { now = Date.now() } = {}) {
    const found = await workerFor(subject, { now });
    return {
        ready: found.ok === true,
        code: found.ok ? null : found.code,
        reason: found.ok ? null : REASON,
        last_seen_at: found.ok ? Number(found.worker.last_seen_at) : (found.worker ? Number(found.worker.last_seen_at) : null),
        stale_after_ms: WORKER_STALE_MS,
    };
}

module.exports = { WORKER_STALE_MS, REASON, REQUIRED_ISOLATION, isolationOk, workerFor, checkIn, state, ulid };
