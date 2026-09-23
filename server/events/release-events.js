'use strict';
/**
 * live.release.deployed — Live announces a deploy that shipped new commits as a durable
 * OpenVibe.Events event (roadmap Wave 3 exit: "the Live chat deploy notice goes through Events").
 *
 * Emitted by server/chat/deploy-notice.js on the boot that first runs new commits, in the SAME
 * transaction that records them as announced (site setting deploy_last_announced), through Live's
 * outbox (server/events/stream-events.js). A restart without new code emits nothing; a crash before
 * that commit re-announces on the next boot, with the same subject (the head commit), so a consumer
 * keys on subject.id to fold repeats.
 *
 *   subject   { type: 'release', id: <head commit, 40 hex> }
 *   payload   { service: 'live', release: <short sha>, commit: <head>, previous: <last announced
 *               head or null>, commit_count, commits: [{ hash, short, subject, date }] (newest
 *               first, at most 40), deployed_at, notes_url }
 *
 * Visibility is `internal`: the commit subjects are public in chat and on /updates already, but
 * the consumer (the chat notice) decides what is shown. No contract in openvibe-contracts v0.30.1
 * defines this type yet; it is listed as a contract addition for the `live.*` namespace Live owns.
 */
const EVENT_TYPE = 'live.release.deployed';
const NOTES_URL = 'https://openvibe.live/updates';

function envelopeFor({ head, previous = null, commits = [], deployedAt = new Date().toISOString() }) {
    if (!/^[0-9a-f]{40}$/.test(String(head || ''))) throw new TypeError('head must be a full commit sha');
    const list = commits.slice(0, 40).map((c) => ({ hash: c.hash, short: c.short, subject: String(c.subject || '').slice(0, 200), date: c.date || null }));
    const headShort = (list.find((c) => c.hash === head) || {}).short;
    return {
        event_type: EVENT_TYPE,
        actor: { type: 'service', id: 'live' },
        subject: { type: 'release', id: head },
        visibility: 'internal',
        priority: 'low',
        payload: {
            service: 'live',
            release: /^[0-9a-f]{7,40}$/.test(String(headShort || '')) ? headShort : head.slice(0, 12),
            commit: head,
            previous: /^[0-9a-f]{40}$/.test(String(previous || '')) ? previous : null,
            commit_count: commits.length,
            commits: list,
            deployed_at: deployedAt,
            notes_url: NOTES_URL,
        },
    };
}

/**
 * Queue the event INSIDE the caller's transaction. Returns the envelope, or null when Live's
 * outbox is off (no EVENTS_URL). Throws if the outbox insert fails (the caller's change rolls back).
 */
function record(args) {
    return require('./stream-events').enqueue(envelopeFor(args));
}

module.exports = { EVENT_TYPE, envelopeFor, record };
