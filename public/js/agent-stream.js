/* The agent stream page (Agent Streams S1): /@person/agents/<ags_id>.
 *
 * The owner sees the player, the task, the visibility switch, the Share sheet, Curtain now and End; anyone else sees the
 * player and the "AI agent" label. The view ticket the API mints is what the socket joins with, and it is renewed while
 * the page stays open (at most four hours, the server's rule).
 */
/* global window, document, location, setTimeout, clearTimeout, URLSearchParams, api, currentUser, AgentPlayer */
(function () {
    'use strict';
    let player = null;
    let state = null;
    let ticket = null;
    let renewTimer = null;
    let pollTimer = null;

    function $(id) { return document.getElementById(id); }

    function stop() {
        if (player) { try { player.close(); } catch { /* */ } player = null; }
        if (renewTimer) { clearTimeout(renewTimer); renewTimer = null; }
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
        state = null;
        ticket = null;
    }

    function minutes(seconds) {
        const m = Math.max(0, Math.round(Number(seconds) || 0) / 60);
        return m < 1 ? 'under a minute' : `${Math.round(m)} min`;
    }

    function taskText(task) {
        if (!task) return '';
        const where = { codes: 'Codes', actor: 'Actor', desk: 'Desk', node: 'Node' }[task.source] || task.source;
        return `${where} task: ${task.title}`;
    }

    function render(data) {
        state = data;
        ticket = data.view_ticket || ticket;
        bindControls();
        const stream = data.stream;
        if (document.getElementById('agent-title')) document.title = `${stream.title} — AI agent on OpenVibe.Live`;
        $('agent-title').textContent = stream.title;

        const task = $('agent-task');
        task.replaceChildren();
        const label = document.createElement('span');
        label.textContent = taskText(stream.task);
        task.appendChild(label);
        if (stream.task && stream.task.url) {
            const a = document.createElement('a');
            a.href = stream.task.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = 'Open the task';
            a.style.marginLeft = '8px';
            task.appendChild(a);
        }

        const status = $('agent-status');
        status.textContent = stream.state === 'live' ? 'Live' : stream.state === 'ended' ? 'Ended' : 'Ready';
        status.classList.toggle('is-live', stream.state === 'live');

        const worked = $('agent-worked');
        worked.textContent = `Worked ${minutes(stream.worked_seconds)}`;
        worked.hidden = !(stream.state === 'ended' && stream.worked_seconds);

        const video = $('agent-video');
        const still = $('agent-still');
        const stateEl = $('agent-state');
        const curtain = $('agent-curtain');
        const viewers = $('agent-viewers');

        if (player) { try { player.close(); } catch { /* */ } player = null; }
        curtain.hidden = !(stream.curtain && stream.curtain.up);

        if (stream.state === 'live' && data.live_stream_id) {
            still.hidden = true;
            video.hidden = false;
            stateEl.hidden = false;
            stateEl.textContent = 'Connecting…';
            player = AgentPlayer.create({
                streamId: data.live_stream_id,
                viewTicket: ticket || '',
                video,
                state: stateEl,
                curtain,
                viewers,
            });
        } else {
            video.hidden = true;
            stateEl.hidden = false;
            stateEl.textContent = stream.state === 'ended'
                ? `This agent's work ended after ${minutes(stream.worked_seconds)}.`
                : "This agent isn't streaming right now.";
            if (stream.last_frame_url) {
                still.src = `${stream.last_frame_url}${ticket ? `?vt=${encodeURIComponent(ticket)}` : ''}`;
                still.hidden = false;
                stateEl.hidden = true;
            } else {
                still.hidden = true;
            }
        }

        renderOwner(data);
        scheduleRenew(data);
        schedulePoll(stream.id);
    }

    function renderOwner(data) {
        const panel = $('agent-owner');
        if (!panel) return;
        panel.hidden = !data.can_manage;
        if (!data.can_manage) return;
        const stream = data.stream;
        const select = $('agent-visibility');
        select.value = stream.visibility;
        select.disabled = stream.state === 'ended';

        const share = $('agent-share');
        if (share) {
            share.dataset.kind = 'agent-stream';
            share.dataset.id = stream.id;
            share.dataset.url = stream.page_url;
            share.dataset.title = stream.title;
            share.dataset.base = location.origin;
            share.dataset.path = `/api/v1/agent-stream/${encodeURIComponent(stream.id)}/share`;
        }
        const rotate = $('agent-rotate');
        if (rotate) rotate.hidden = stream.visibility !== 'unlisted';
        const hint = $('agent-hint');
        if (hint) {
            hint.textContent = stream.visibility === 'unlisted'
                ? (stream.page_url.includes('?k=') ? 'Anyone with this link can watch. "New link" closes the old one.' : 'Anyone with the link can watch. Press "New link" to get the link to send.')
                : 'Only you and the people you share it with can watch.';
        }
        const curtainBtn = $('agent-curtain-btn');
        if (curtainBtn) curtainBtn.textContent = stream.curtain && stream.curtain.up ? 'Curtain down' : 'Curtain now';
        const endBtn = $('agent-end');
        if (endBtn) endBtn.hidden = stream.state === 'ended';
    }

    function scheduleRenew(data) {
        if (renewTimer) { clearTimeout(renewTimer); renewTimer = null; }
        if (!ticket || data.stream.visibility === 'public') return;
        renewTimer = setTimeout(async () => {
            try {
                const next = await api(`/streams/agent/${encodeURIComponent(data.stream.id)}/view-ticket`, { method: 'POST', body: { renew: ticket } });
                ticket = next.ticket;
            } catch { /* the page keeps the ticket it has until it stops working */ }
        }, 8 * 60 * 1000);
    }

    function schedulePoll(id) {
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
        pollTimer = setTimeout(async () => {
            try {
                const params = new URLSearchParams(location.search);
                const k = params.get('k');
                const next = await api(`/streams/agent/${encodeURIComponent(id)}${k ? `?k=${encodeURIComponent(k)}` : ''}`);
                if (!document.getElementById('agent-title')) return;   // the page is gone
                const wasLive = state && state.stream.state === 'live';
                render(next);
                if (!wasLive && next.stream.state === 'live') return;   // the player has been mounted
            } catch { /* try again next time */ }
        }, 20000);
    }

    /** The owner's controls: bound once, acting on the stream the page currently shows. */
    let controlsBound = false;
    function bindControls() {
        if (controlsBound) return;
        controlsBound = true;
        const idOf = () => (state && state.stream ? state.stream.id : null);

        $('agent-visibility').addEventListener('change', async (event) => {
            const id = idOf();
            if (!id) return;
            const select = event.currentTarget;
            try {
                const next = await api(`/streams/agent/${encodeURIComponent(id)}/visibility`, { method: 'PUT', body: { visibility: select.value } });
                if (next && next.stream && state) {
                    state.stream = next.stream;
                    renderOwner(state);
                }
            } catch (err) {
                select.value = state ? state.stream.visibility : 'private';
                const hint = $('agent-hint');
                if (hint) hint.textContent = (err && (err.data && err.data.code === 'not_unlisted')) || (err && err.message) || 'That did not save.';
            }
        });

        $('agent-curtain-btn').addEventListener('click', async () => {
            const id = idOf();
            if (!id) return;
            const up = !(state && state.stream.curtain && state.stream.curtain.up);
            try {
                await api(`/streams/agent/${encodeURIComponent(id)}/curtain`, { method: 'POST', body: { up, reason: 'manual' } });
                if (state) state.stream.curtain = { up };
                renderOwner(state);
                const curtain = $('agent-curtain');
                if (curtain) curtain.hidden = !up;
            } catch { /* the desk still owns the curtain */ }
        });

        $('agent-end').addEventListener('click', async () => {
            const id = idOf();
            if (!id) return;
            if (!window.confirm('End this agent stream? The card stays with its last frame.')) return;
            try {
                await api(`/streams/agent/${encodeURIComponent(id)}/end`, { method: 'POST', body: {} });
                const k = new URLSearchParams(location.search).get('k');
                const next = await api(`/streams/agent/${encodeURIComponent(id)}${k ? `?k=${encodeURIComponent(k)}` : ''}`);
                render(next);
            } catch { /* the stream may have ended already */ }
        });

        $('agent-rotate').addEventListener('click', async () => {
            const id = idOf();
            if (!id) return;
            try {
                const next = await api(`/streams/agent/${encodeURIComponent(id)}/rotate-link`, { method: 'POST', body: {} });
                if (state && next && next.stream) {
                    state.stream = next.stream;
                    renderOwner(state);
                }
                if (next && next.stream && next.stream.page_url && navigator.clipboard) {
                    await navigator.clipboard.writeText(next.stream.page_url).catch(() => {});
                }
            } catch { /* shown by the hint below */ }
        });
    }

    async function loadAgentStreamPage(username, publicId) {
        stop();
        const owner = $('agent-owner');
        if (owner) owner.hidden = true;
        const title = $('agent-title');
        if (title) title.textContent = 'Agent stream';
        const stateEl = $('agent-state');
        if (stateEl) { stateEl.hidden = false; stateEl.textContent = 'Loading…'; }
        const k = new URLSearchParams(location.search).get('k');
        try {
            const data = await api(`/streams/agent/${encodeURIComponent(publicId)}${k ? `?k=${encodeURIComponent(k)}` : ''}`);
            if (username && data.stream.channel && data.stream.channel.toLowerCase() !== String(username).toLowerCase()) {
                // The link named another channel: the stream's own address is the right page.
                window.location.replace(`/@${encodeURIComponent(data.stream.channel)}/agents/${encodeURIComponent(data.stream.id)}${k ? `?k=${encodeURIComponent(k)}` : ''}`);
                return;
            }
            render(data);
        } catch (err) {
            if (stateEl) stateEl.textContent = err && err.status === 404 ? 'This agent stream is private or gone.' : 'The stream could not be loaded.';
            if (title) title.textContent = 'Agent stream';
        }
    }

    window.loadAgentStreamPage = loadAgentStreamPage;
    window.stopAgentStreamPage = stop;
})();
