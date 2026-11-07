'use strict';
/**
 * The agent's step (design 2026-11-07): an agent stream is one step of the agent's timeline. Live publishes
 * agent.step.started when the desk starts publishing and agent.step.ended when the stream ends, with the owner's
 * subject, so the one timeline behind the Dock shows it. The payload is a title, an outcome and a link: never the
 * task, a frame, a chat line or a voice line.
 */
const AGENT_TOPICS = Object.freeze({
    started: 'agent.step.started',
    updated: 'agent.step.updated',
    ended: 'agent.step.ended',
});
const USER_SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

const iso = (v) => {
    if (v == null || v === '') return null;
    const d = v instanceof Date || typeof v === 'number' ? new Date(v) : new Date(String(v).includes('T') ? v : `${String(v).replace(' ', 'T')}Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** The stream's public page on Live (its own address); the step carries no unlisted link's secret. */
function pageUrl(row, baseUrl = 'https://openvibe.live') {
    const base = String(baseUrl || 'https://openvibe.live').replace(/\/+$/, '');
    return `${base}/@${encodeURIComponent(row.username || '')}/agents/${encodeURIComponent(row.public_id)}`;
}

/** One agent stream → the agent's step: its title, its state and its page. Never the task or a frame. */
function agentStepOf(row, { status = 'running', startedAt = null, endedAt = null, reason = null, baseUrl = null } = {}) {
    const title = String(row.title || '').trim().slice(0, 120) || 'an agent stream';
    return {
        step_id: row.public_id,
        mode: 'stream',
        product: 'live',
        ref: row.public_id,
        title: `Streaming ${title}`,
        status,
        started_at: iso(startedAt) || iso(row.started_at) || new Date().toISOString(),
        ended_at: status === 'running' ? null : (iso(endedAt) || iso(row.ended_at)),
        placement: { where: 'On your desk', why: 'it runs from your own machine, and only you can end it' },
        cost_usd: null,
        link: pageUrl(row, baseUrl),
        reason: status === 'stopped' || status === 'failed' ? (reason == null ? null : String(reason).slice(0, 240)) : null,
    };
}

/** Which step a state change is: the stream going live starts it, the stream ending stops it. A pause is not a step. */
function stepChangeOf(row, set, event = null) {
    if (!row || !set) return null;
    if (set.state === 'live' && row.state !== 'live') return { topic: 'started', status: 'running', startedAt: set.started_at || new Date() };
    if (set.state === 'ended' && row.state !== 'ended') return { topic: 'ended', status: 'stopped', endedAt: set.ended_at || new Date(), reason: (event && event.extra && event.extra.reason) || null };
    return null;
}

/** The agent.step.* envelope for one stream change, or null when the owner has no person subject to show it to. */
function agentStepEnvelope(row, { topic, ...rest } = {}, { source = 'live' } = {}) {
    if (!row || !USER_SUBJECT.test(String(row.owner_subject || ''))) return null;
    const event_type = AGENT_TOPICS[topic];
    if (!event_type) return null;
    return {
        event_type,
        actor: { type: 'user', id: row.owner_subject },
        subject: { type: 'user', id: row.owner_subject },
        visibility: 'internal',
        priority: topic === 'ended' ? 'important' : 'low',
        payload: agentStepOf(row, rest),
        source,
    };
}

module.exports = { AGENT_TOPICS, agentStepOf, agentStepEnvelope, stepChangeOf, pageUrl, USER_SUBJECT };
