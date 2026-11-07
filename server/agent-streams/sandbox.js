'use strict';
/**
 * The sandbox worker registry (Agent Streams S6, design 2026-11-06, §1).
 *
 * A chat plays request runs in a network-isolated worker: a container or namespace with no host network, no
 * credentials and no access to the owner's files, whose egress goes through a proxy that applies the guard.
 * That worker is not built yet. Until one is registered and healthy, Live refuses the chat plays mode: the
 * mode may not be switched on, Go may not be pressed, and the owner page says so in as many words.
 *
 * A worker checks in for the person it works for (the publish ticket or the service token names the stream,
 * so the worker is registered for the stream's owner and nobody else) and is healthy while it keeps checking
 * in: a worker that stopped checking in is not there, and the mode is refused again.
 *
 * The registry is a table, not a process: Live may run in more than one process, and the worker checks in
 * from another machine.
 */
const crypto = require('crypto');
const db = require('../db/database');

const WORKER_STALE_MS = 2 * 60 * 1000;
const REASON = 'Needs the sandbox worker; coming soon';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid(now = Date.now()) {
    let time = '';
    for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = ALPHABET[t % 32] + time;
    const bytes = crypto.randomBytes(16);
    let rand = '';
    for (let i = 0; i < 16; i++) rand += ALPHABET[bytes[i] % 32];
    return time + rand;
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
    return { ok: true, worker: row };
}

/** The worker checks in: it is there, now. */
async function checkIn({ subject, service = 'unknown', endpoint = null, now = Date.now() }) {
    if (!subject) return { ok: false, code: 'sandbox_worker_no_subject' };
    const at = Number(now);
    const existing = await db.getDb().prepare('SELECT id FROM agent_sandbox_workers WHERE subject = ? LIMIT 1').get(String(subject));
    const id = (existing && existing.id) || ('sbw_' + ulid(at));
    await db.getDb().prepare(
        `INSERT INTO agent_sandbox_workers (id, subject, service, endpoint, status, last_seen_at, created_at)
         VALUES (?, ?, ?, ?, 'ready', ?, ?)
         ON CONFLICT (subject) DO UPDATE SET status = 'ready', service = excluded.service,
             endpoint = excluded.endpoint, last_seen_at = excluded.last_seen_at`)
        .run(id, String(subject), String(service || 'unknown'), endpoint ? String(endpoint) : null, at, at);
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

module.exports = { WORKER_STALE_MS, REASON, workerFor, checkIn, state, ulid };
