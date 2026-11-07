/* The agent stream embed (Agent Streams S1): /embed/agent/<ags_id>?vt=wvt_….
 *
 * Codes, Actor or the desk mints the view ticket server-side with the person's token (a third-party iframe has no Live
 * cookies), and this page joins the stream with it. It shows the player, the "AI agent" label, the curtain state and the
 * viewer count; no chat in S1. It renews its own ticket while it stays open, up to the server's four-hour ceiling.
 */
/* global window, document, location, URLSearchParams, setTimeout, clearTimeout, AgentPlayer, AgentOverlay */
(function () {
    'use strict';
    const body = document.body;
    const id = body && body.dataset ? body.dataset.agentId : '';
    if (!id) return;
    const $ = (name) => document.getElementById(name);
    let ticket = new URLSearchParams(location.search).get('vt') || '';
    let player = null;
    let renewTimer = null;
    let stepsTimer = null;
    let steps = [];
    let overlay = null;
    let streamState = null;
    let streamView = null;

    async function json(path, options) {
        const res = await fetch(path, { credentials: 'omit', headers: { 'Content-Type': 'application/json' }, ...options });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { const err = new Error(data.error || 'request failed'); err.status = res.status; throw err; }
        return data;
    }

    function renewSoon() {
        if (renewTimer) clearTimeout(renewTimer);
        if (!ticket) return;
        renewTimer = setTimeout(async () => {
            try {
                const next = await json(`/api/streams/agent/${encodeURIComponent(id)}/view-ticket`, { method: 'POST', body: JSON.stringify({ renew: ticket }) });
                ticket = next.ticket || ticket;
                renewSoon();
            } catch { /* the existing ticket lasts until it stops working */ }
        }, 8 * 60 * 1000);
    }

    let queueView = null;

    /** The overlay (S2): the same band the page draws, from the same steps feed, never burned into the video. */
    function drawOverlay(stream) {
        const host = $('agent-embed-overlay');
        if (!host || !window.AgentOverlay) return;
        if (!overlay) overlay = window.AgentOverlay.create({ host, title: stream.title, initial: steps });
        overlay.update({ steps, task: stream.task, workedSeconds: stream.worked_seconds, state: stream.state, pausedBy: streamView && streamView.__pausedBy, queue: queueView });
    }

    /** S6: the chat plays queue the desk reported: the current request and the next three. */
    async function pollQueue() {
        try {
            const out = await json(`/api/streams/agent/${encodeURIComponent(id)}/plays/queue`);
            queueView = out && out.queue ? out.queue : null;
        } catch { queueView = null; }
        drawOverlay(streamView || {});
    }

    function pollSteps() {
        if (stepsTimer) { clearTimeout(stepsTimer); stepsTimer = null; }
        if (streamState !== 'live') return;
        stepsTimer = setTimeout(async () => {
            try {
                const after = steps.length ? steps[steps.length - 1].id : null;
                const q = after ? `?after=${after}` : '';
                const out = await json(`/api/streams/agent/${encodeURIComponent(id)}/steps${q}`);
                const known = new Set(steps.map((step) => step.id));
                for (const step of (out.steps || [])) if (!known.has(step.id)) steps.push(step);
                if (steps.length > 200) steps = steps.slice(-200);
                if (streamView) drawOverlay(streamView);
            } catch { /* the next turn tries again */ }
            await pollQueue();
            pollSteps();
        }, 2500);
    }

    async function load() {
        const query = ticket ? `?vt=${encodeURIComponent(ticket)}` : '';
        const data = await json(`/api/streams/agent/${encodeURIComponent(id)}${query}`);
        const stream = data.stream;
        ticket = data.view_ticket || ticket;
        streamState = stream.state;
        streamView = stream;
        streamView.__pausedBy = data.paused_by || null;

        const title = $('agent-embed-title');
        if (title) title.textContent = stream.title || '';
        document.title = `${stream.title || 'AI agent'} — OpenVibe.Live`;

        const video = $('agent-embed-video');
        const still = $('agent-embed-still');
        const stateEl = $('agent-embed-state');
        const curtain = $('agent-embed-curtain');
        const viewers = $('agent-embed-viewers');

        curtain.hidden = !(stream.curtain && stream.curtain.up);

        if (stream.state === 'live' && data.live_stream_id && video) {
            still.hidden = true;
            stateEl.hidden = false;
            player = AgentPlayer.create({ streamId: data.live_stream_id, viewTicket: ticket, video, state: stateEl, curtain, viewers });
        } else {
            if (video) video.hidden = true;
            if (stream.last_frame_url) {
                still.src = `${stream.last_frame_url}${ticket ? `?vt=${encodeURIComponent(ticket)}` : ''}`;
                still.hidden = false;
                stateEl.hidden = true;
            } else {
                still.hidden = true;
                stateEl.hidden = false;
                stateEl.textContent = stream.state === 'ended' ? 'This agent’s work has ended.' : "This agent isn't streaming right now.";
            }
        }
        drawOverlay(stream);
        await pollQueue();
        if (!steps.length) {
            try { const out = await json(`/api/streams/agent/${encodeURIComponent(id)}/steps`); steps = out.steps || []; } catch { /* */ }
            drawOverlay(stream);
        }
        pollSteps();
        renewSoon();
        // The state changes on the server (the desk starts publishing, or the work ends); look again in a minute.
        setTimeout(() => { if (!player && document.visibilityState !== 'hidden') load().catch(() => {}); }, 60000);
    }

    if (!$('agent-embed-stage')) return;
    load().catch((err) => {
        const stateEl = $('agent-embed-state');
        if (stateEl) {
            stateEl.hidden = false;
            stateEl.textContent = err && err.status === 404 ? 'This agent stream is private or gone.' : 'The stream could not be loaded.';
        }
    });
})();
