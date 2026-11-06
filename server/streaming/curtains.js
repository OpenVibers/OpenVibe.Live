'use strict';
/**
 * The curtain, at Live (Agent Streams S1, design 2026-11-06).
 *
 * The desk blanks its own picture before this runs; this is the second, independent enforcement. While the curtain is
 * up, every viewer's consumer of that stream's SFU room is paused — a desk that failed to blank still shows nothing —
 * and every player is told `{ type: 'curtain', up: true }` so it can show "Private screen". The reason never crosses
 * this boundary; only the owner reads it from the stream resource.
 *
 * A viewer who joins while the curtain is up gets a consumer that is paused the moment it exists. Pausing is kept in
 * memory per session (mediasoup consumers are in memory too); after a restart the row's curtain_up is the truth, and
 * `isUp` reads it for a viewer that connects then.
 */
const db = require('../db/database');

/** sessionId -> Set of consumer ids this module paused (only those are resumed; restream consumers never are). */
const paused = new Map();

function consumersOf(sessionId) {
    if (!sessionId) return [];
    try {
        const room = require('./webrtc-sfu').rooms.get(`stream-${Number(sessionId)}`);
        if (!room) return [];
        const out = [];
        for (const [id, entry] of room.consumers) {
            if (entry && entry.peerId && String(entry.peerId).startsWith('__')) continue;   // restream/plain transports
            out.push({ id, consumer: entry.consumer });
        }
        return out;
    } catch { return []; }
}

function tell(sessionId, up) {
    try {
        const room = require('./broadcast-server').rooms.get(Number(sessionId));
        if (!room) return;
        const server = require('./broadcast-server');
        for (const [, ws] of room.viewers) server.safeSend(ws, { type: 'curtain', up: !!up });
    } catch { /* a viewer socket going away is not an error */ }
}

/** Raise the curtain for a session: pause what is playing, and everything that starts playing. */
function raise(sessionId) {
    if (!sessionId) return 0;
    const id = Number(sessionId);
    const set = paused.get(id) || new Set();
    let count = 0;
    for (const { id: consumerId, consumer } of consumersOf(id)) {
        try { consumer.pause(); set.add(consumerId); count++; } catch { /* already closed */ }
    }
    paused.set(id, set);
    tell(id, true);
    return count;
}

/** Lower it: resume exactly the consumers this module paused, and tell the players. */
function lower(sessionId, { notify = true } = {}) {
    if (!sessionId) return 0;
    const id = Number(sessionId);
    const set = paused.get(id);
    if (!set) { if (notify) tell(id, false); return 0; }
    let count = 0;
    for (const consumerId of set) {
        for (const entry of consumersOf(id)) {
            if (entry.id !== consumerId) continue;
            try { entry.consumer.resume(); count++; } catch { /* already closed */ }
        }
    }
    paused.delete(id);
    if (notify) tell(id, false);
    return count;
}

/** Follow the row: up → raise, down → lower. Used by the curtain route and by a viewer that connects late. */
function apply(sessionId, up) {
    return up ? raise(sessionId) : lower(sessionId);
}

/** Pause one consumer that was just created, while the curtain is up. */
function applyToConsumer(sessionId, consumerId) {
    if (!sessionId || !consumerId) return false;
    const id = Number(sessionId);
    const set = paused.get(id);
    if (!set) return false;
    for (const entry of consumersOf(id)) {
        if (entry.id !== consumerId) continue;
        try { entry.consumer.pause(); set.add(consumerId); return true; } catch { return false; }
    }
    return false;
}

/**
 * Whether this live session's agent stream has its curtain up. A non-agent session answers false without a shrug —
 * the query matches the slot's kind.
 */
async function isUp(sessionId) {
    if (!sessionId) return false;
    try {
        const row = await db.get(`SELECT a.curtain_up FROM streams s
            JOIN managed_streams ms ON ms.id = s.managed_stream_id
            JOIN agent_streams a ON a.managed_stream_id = ms.id
            WHERE s.id = ? AND ms.kind = 'agent'`, [sessionId]);
        return !!(row && Number(row.curtain_up));
    } catch { return false; }
}

function _reset() { paused.clear(); }

module.exports = { raise, lower, apply, applyToConsumer, isUp, consumersOf, _reset };
