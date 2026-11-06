/* The agent stream embed (Agent Streams S1): /embed/agent/<ags_id>?vt=wvt_….
 *
 * Codes, Actor or the desk mints the view ticket server-side with the person's token (a third-party iframe has no Live
 * cookies), and this page joins the stream with it. It shows the player, the "AI agent" label, the curtain state and the
 * viewer count; no chat in S1. It renews its own ticket while it stays open, up to the server's four-hour ceiling.
 */
/* global window, document, location, URLSearchParams, setTimeout, AgentPlayer */
(function () {
    'use strict';
    const body = document.body;
    const id = body && body.dataset ? body.dataset.agentId : '';
    if (!id) return;
    const $ = (name) => document.getElementById(name);
    let ticket = new URLSearchParams(location.search).get('vt') || '';
    let player = null;
    let renewTimer = null;

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

    async function load() {
        const query = ticket ? `?vt=${encodeURIComponent(ticket)}` : '';
        const data = await json(`/api/streams/agent/${encodeURIComponent(id)}${query}`);
        const stream = data.stream;
        ticket = data.view_ticket || ticket;

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
