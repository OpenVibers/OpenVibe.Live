'use strict';
/**
 * The agent-stream housekeeping loop, started at boot beside Live's other jobs (never under LIVE_DRILL).
 *
 *   - A live agent stream whose publish ticket expired with no renewal ends: the desk lost the right to publish, so the
 *     session and the card end rather than lingering as a stream nobody can stop. (A WHIP session that drops ends the
 *     stream at once through the WHIP cleanup, not here; the two-minute rule is the outer bound for a desk that went
 *     silent without closing its transport.)
 *   - Expired tickets are pruned after a day.
 *   - The sharing system's queued deliveries (events to Network) are flushed.
 *
 * One minute is enough: the desk renews at three hours, and a dead stream staying up for at most a minute costs nothing.
 */
const db = require('../db/database');

const EVERY_MS = 60 * 1000;
let timer = null;

async function sweep() {
    const service = require('./service');
    const tickets = require('./tickets');

    const rows = await db.all(`SELECT ms.id AS managed_stream_id, ms.public_id
        FROM agent_streams a JOIN managed_streams ms ON ms.id = a.managed_stream_id
        WHERE a.state = 'live' LIMIT 200`);
    for (const row of rows) {
        try {
            const expiry = await tickets.currentExpiry(row.managed_stream_id);
            const session = await service.liveSession(row.managed_stream_id);
            if (expiry) continue;
            const full = await service.getByManagedStreamId(row.managed_stream_id);
            if (full) await service.end(full, { reason: session ? 'ticket_expired' : 'session_ended' });
        } catch (err) {
            console.warn(`[AgentStream] sweep of ${row.public_id} failed: ${err.message}`);
        }
    }

    try { await tickets.prune(); } catch (err) { console.warn('[AgentStream] ticket prune failed:', err.message); }
    try {
        const sharing = require('./sharing');
        if (sharing.available()) await sharing.flushDeliveries();
    } catch (err) { console.warn('[AgentStream] sharing deliveries:', err.message); }
}

function start() {
    if (timer) return timer;
    timer = setInterval(() => { sweep().catch((err) => console.warn('[AgentStream] sweep failed:', err.message)); }, EVERY_MS);
    if (timer.unref) timer.unref();
    return timer;
}

function stop() {
    if (timer) clearInterval(timer);
    timer = null;
}

module.exports = { sweep, start, stop, EVERY_MS };
