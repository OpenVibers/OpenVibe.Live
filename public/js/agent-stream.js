/* The agent stream page (Agent Streams S1): /@person/agents/<ags_id>.
 *
 * The owner sees the player, the task, the visibility switch, the Share sheet, the curtain and End; anyone else sees the
 * player and the "AI agent" label. The view ticket the API mints is what the socket joins with, and it is renewed while
 * the page stays open (at most four hours, the server's rule).
 *
 * One status line carries the whole state — Live, N watching, worked 42 min; or Waiting for the desk; or Ended, worked
 * 42 min. The player is only rebuilt when the stream or its live session changes, so the 20-second poll never interrupts
 * playback.
 */
/* global window, document, location, setTimeout, clearTimeout, URLSearchParams, api, AgentPlayer, navigator */
(function () {
    'use strict';
    let player = null;
    let mountedStreamId = null;
    let state = null;
    let ticket = null;
    let liveViewers = null;
    let renewTimer = null;
    let pollTimer = null;
    let generation = 0;   // bumped on every page leave, so a slow request from the last page changes nothing

    function $(id) { return document.getElementById(id); }

    function stop() {
        generation++;
        if (player) { try { player.close(); } catch { /* */ } player = null; }
        mountedStreamId = null;
        liveViewers = null;
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

    /** The one status line: what the stream is doing, and for how long. */
    function renderStatus(stream, viewers = liveViewers) {
        const line = $('agent-status-line');
        if (!line) return;
        if (stream.state === 'live') {
            const count = Number(viewers == null ? stream.viewers : viewers) || 0;
            line.textContent = `Live · ${count} watching · worked ${minutes(stream.worked_seconds)}`;
            line.classList.add('is-live');
        } else if (stream.state === 'ended') {
            line.textContent = stream.worked_seconds ? `Ended · worked ${minutes(stream.worked_seconds)}` : 'Ended';
            line.classList.remove('is-live');
        } else {
            line.textContent = 'Waiting for the desk';
            line.classList.remove('is-live');
        }
    }

    function renderCurtain(up) {
        const curtain = $('agent-curtain');
        if (curtain) curtain.hidden = !up;
        const btn = $('agent-curtain-btn');
        if (btn) btn.textContent = up ? 'Lift the curtain' : 'Curtain now';
    }

    function mountPlays(data) {
        const stream = data.stream;
        const video = $('agent-video');
        const still = $('agent-still');
        const stateEl = $('agent-state');
        const wanted = stream.state === 'live' && data.live_stream_id ? data.live_stream_id : null;

        // Already playing this very session: keep it (a poll must never interrupt the picture).
        if (wanted && mountedStreamId === wanted && player) return;

        if (player) { try { player.close(); } catch { /* */ } player = null; }
        mountedStreamId = null;

        if (wanted) {
            still.hidden = true;
            video.hidden = false;
            stateEl.hidden = false;
            stateEl.textContent = 'Connecting…';
            player = AgentPlayer.create({
                streamId: wanted,
                viewTicket: ticket || '',
                video,
                state: stateEl,
                curtain: $('agent-curtain'),
                onViewers: (count) => {
                    liveViewers = count;
                    if (state && state.stream) renderStatus(state.stream, count);
                },
            });
            mountedStreamId = wanted;
            return;
        }

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

        renderCurtain(!!(stream.curtain && stream.curtain.up));
        renderStatus(stream, liveViewers);
        mountPlays(data);
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
            if (stream.visibility === 'unlisted') {
                hint.textContent = stream.page_url.includes('?k=')
                    ? 'Anyone with this link can watch. Reset the link and the old links stop working.'
                    : 'Anyone with the link can watch. Press "Reset link" to get a link to send — old links stop working.';
            } else {
                hint.textContent = 'Only you and the people you share it with can watch.';
            }
        }
        renderCurtain(!!(stream.curtain && stream.curtain.up));
        const endBtn = $('agent-end');
        if (endBtn) endBtn.hidden = stream.state === 'ended';
        const confirm = $('agent-end-confirm');
        if (confirm && stream.state === 'ended') confirm.hidden = true;
    }

    function scheduleRenew(data) {
        if (renewTimer) { clearTimeout(renewTimer); renewTimer = null; }
        if (!ticket || data.stream.visibility === 'public') return;
        const gen = generation;
        renewTimer = setTimeout(async () => {
            if (gen !== generation) return;
            try {
                const next = await api(`/streams/agent/${encodeURIComponent(data.stream.id)}/view-ticket`, { method: 'POST', body: { renew: ticket } });
                if (gen === generation) ticket = next.ticket;
            } catch { /* the page keeps the ticket it has until it stops working */ }
        }, 8 * 60 * 1000);
    }

    /** Look again for a state the socket cannot tell us (the desk started, the work ended), without remounting a player. */
    function schedulePoll(id) {
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
        const gen = generation;
        pollTimer = setTimeout(async () => {
            try {
                const k = new URLSearchParams(location.search).get('k');
                const next = await api(`/streams/agent/${encodeURIComponent(id)}${k ? `?k=${encodeURIComponent(k)}` : ''}`);
                if (gen !== generation) return;   // the page is gone
                const previous = state && state.stream;
                const structural = !previous
                    || previous.state !== next.stream.state
                    || previous.visibility !== next.stream.visibility
                    || !!previous.curtain.up !== !!next.stream.curtain.up
                    || (state && state.live_stream_id) !== next.live_stream_id;
                if (structural) { render(next); return; }
                state = next;
                ticket = next.view_ticket || ticket;
                renderStatus(next.stream, liveViewers);
                renderOwner(next);
                schedulePoll(id);
            } catch { if (gen === generation) schedulePoll(id); }
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
                if (hint) hint.textContent = (err && err.message) || 'That did not save.';
            }
        });

        $('agent-curtain-btn').addEventListener('click', async () => {
            const id = idOf();
            if (!id) return;
            const up = !(state && state.stream.curtain && state.stream.curtain.up);
            try {
                await api(`/streams/agent/${encodeURIComponent(id)}/curtain`, { method: 'POST', body: { up, reason: 'manual' } });
                if (state) state.stream.curtain = { up };
                renderCurtain(up);
                renderOwner(state);
            } catch { /* the desk still owns the curtain */ }
        });

        $('agent-end').addEventListener('click', () => {
            const confirm = $('agent-end-confirm');
            const end = $('agent-end');
            if (confirm) confirm.hidden = false;
            if (end) end.hidden = true;
        });

        $('agent-end-no').addEventListener('click', () => {
            const confirm = $('agent-end-confirm');
            const end = $('agent-end');
            if (confirm) confirm.hidden = true;
            if (end) end.hidden = !!(state && state.stream && state.stream.state === 'ended');
        });

        $('agent-end-yes').addEventListener('click', async () => {
            const id = idOf();
            if (!id) return;
            try {
                await api(`/streams/agent/${encodeURIComponent(id)}/end`, { method: 'POST', body: {} });
                const k = new URLSearchParams(location.search).get('k');
                const next = await api(`/streams/agent/${encodeURIComponent(id)}${k ? `?k=${encodeURIComponent(k)}` : ''}`);
                render(next);
            } catch {
                const confirm = $('agent-end-confirm');
                if (confirm) confirm.hidden = true;
            }
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
        const line = $('agent-status-line');
        if (line) line.textContent = 'Loading…';
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
            if (line) line.textContent = '';
        }
    }

    window.loadAgentStreamPage = loadAgentStreamPage;
    window.stopAgentStreamPage = stop;
})();
