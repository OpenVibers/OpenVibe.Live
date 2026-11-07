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
    let stepsTimer = null;
    let steps = [];            // the overlay's feed, oldest first (at most the last 200)
    let lines = [];            // S4: the lines the agent said, oldest first (the overlay's caption)
    let voice = null;          // S4: the voice settings (mode, personality, voice, muted, paused)
    let voicesLoaded = false;
    let linesTimer = null;
    let overlay = null;
    let chaptersFor = null;    // the stream id whose chapters are rendered (they never change while the page lives)
    let controlsLogFor = null;  // the stream id whose control log is rendered
    let generation = 0;   // bumped on every page leave, so a slow request from the last page changes nothing

    function $(id) { return document.getElementById(id); }

    function stop() {
        generation++;
        if (player) { try { player.close(); } catch { /* */ } player = null; }
        mountedStreamId = null;
        liveViewers = null;
        if (renewTimer) { clearTimeout(renewTimer); renewTimer = null; }
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
        if (stepsTimer) { clearTimeout(stepsTimer); stepsTimer = null; }
        if (linesTimer) { clearTimeout(linesTimer); linesTimer = null; }
        if (overlay) { try { overlay.destroy(); } catch { /* */ } overlay = null; }
        steps = [];
        lines = [];
        voice = null;
        voicesLoaded = false;
        chaptersFor = null;
        controlsLogFor = null;
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

    /** The overlay exists once per page; each render only hands it the newest steps and the clock. */
    function ensureOverlay(data) {
        const host = $('agent-overlay');
        if (!host || !window.AgentOverlay) return;
        if (!overlay) {
            overlay = window.AgentOverlay.create({ host, title: data.stream.title, initial: steps });
        }
        overlay.update({
            steps,
            task: data.stream.task,
            workedSeconds: data.stream.worked_seconds,
            state: data.stream.state,
            caption: captionText(),
            voice,
            pausedBy: data.paused_by || null,
        });
    }

    /** S4: the newest line the agent said, for the overlay's caption. */
    function captionText() {
        if (!lines.length) return '';
        const line = lines[lines.length - 1];
        return line && line.text ? line.text : '';
    }

    /**
     * S4: the lines the agent said. The page polls the same feed the desk reads, so the caption follows the voice.
     */
    function scheduleLines(data) {
        if (linesTimer) { clearTimeout(linesTimer); linesTimer = null; }
        if (data.stream.state === 'ended') return;
        const gen = generation;
        const id = data.stream.id;
        linesTimer = setTimeout(async () => {
            if (gen !== generation) return;
            try {
                const after = lines.length ? lines[lines.length - 1].id : null;
                const next = await api(`/streams/agent/${encodeURIComponent(id)}/lines${after ? `?after=${after}` : ''}`);
                if (gen !== generation) return;
                if (next && next.voice) { voice = next.voice; renderVoice(); }
                if (next && Array.isArray(next.lines) && next.lines.length) {
                    const known = new Set(lines.map((line) => line.id));
                    for (const line of next.lines) if (!known.has(line.id)) lines.push(line);
                    if (lines.length > 100) lines = lines.slice(-100);
                    if (state && state.stream) ensureOverlay(state);
                }
            } catch { /* the next turn tries again */ }
            if (gen === generation && state) scheduleLines(state);
        }, 2500);
    }

    /** Keep the overlay's feed current while the work is live: only the steps after the newest one are fetched. */
    function scheduleSteps(data) {
        if (stepsTimer) { clearTimeout(stepsTimer); stepsTimer = null; }
        if (data.stream.state !== 'live') return;
        const gen = generation;
        const id = data.stream.id;
        stepsTimer = setTimeout(async () => {
            if (gen !== generation) return;
            try {
                const after = steps.length ? steps[steps.length - 1].id : null;
                const next = await api(`/streams/agent/${encodeURIComponent(id)}/steps${after ? `?after=${after}` : ''}`);
                if (gen !== generation) return;
                if (next && Array.isArray(next.steps) && next.steps.length) {
                    const known = new Set(steps.map((step) => step.id));
                    for (const step of next.steps) if (!known.has(step.id)) steps.push(step);
                    if (steps.length > 200) steps = steps.slice(-200);
                    if (state && state.stream) ensureOverlay(state);
                }
            } catch { /* the next turn tries again */ }
            if (gen === generation) scheduleSteps(state);
        }, 2500);
    }

    /** Chapters come from the steps that started; a failed step and the final passed one can be clipped in one tap. */
    async function renderRecording(data) {
        const section = $('agent-chapters');
        if (!section) return;
        const stream = data.stream;
        if (stream.state !== 'ended') { section.hidden = true; return; }
        if (chaptersFor === stream.id) return;
        try {
            const out = await api(`/streams/agent/${encodeURIComponent(stream.id)}/chapters`);
            if (!out || !out.chapters || !out.chapters.length) { section.hidden = true; chaptersFor = stream.id; return; }
            section.hidden = false;
            const list = $('agent-chapter-list');
            list.replaceChildren();
            const vodBase = out.vod_id ? `https://openvibe.video/v/${encodeURIComponent(out.vod_id)}` : null;
            for (const chapter of out.chapters) {
                const li = document.createElement('li');
                li.className = 'agent-chapter';
                const time = document.createElement('a');
                time.className = 'agent-chapter-time';
                time.textContent = clock(chapter.at);
                time.href = vodBase ? `${vodBase}?t=${chapter.at}` : '#';
                if (!vodBase) time.removeAttribute('href');
                const title = document.createElement('span');
                title.className = 'agent-chapter-title';
                title.textContent = chapter.title;
                li.append(time, title);
                list.appendChild(li);
            }
            const hint = $('agent-chapters-hint');
            if (hint) hint.textContent = 'Each step that started became a chapter of the recording.';
            const recording = $('agent-recording');
            if (recording) {
                recording.replaceChildren();
                if (vodBase) {
                    const a = document.createElement('a');
                    a.href = vodBase;
                    a.textContent = 'Watch the recording on OpenVibe.Video';
                    recording.appendChild(a);
                    recording.hidden = false;
                } else recording.hidden = true;
            }
            renderHighlights(stream);
            chaptersFor = stream.id;
        } catch { section.hidden = true; }
    }

    function clock(seconds) {
        const s = Math.max(0, Math.round(Number(seconds) || 0));
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
        return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(sec).padStart(2, '0')}`;
    }

    function renderHighlights(stream) {
        const wrap = $('agent-highlights');
        const list = $('agent-highlight-list');
        if (!wrap || !list) return;
        const failed = steps.filter((step) => step.status === 'failed');
        const passed = steps.filter((step) => step.status === 'passed');
        const finalPassed = passed.length && (!steps.length || steps[steps.length - 1].status === 'passed') ? passed[passed.length - 1] : null;
        const wanted = [...failed, ...(finalPassed ? [finalPassed] : [])];
        list.replaceChildren();
        if (!wanted.length || !stream.vod_id) { wrap.hidden = true; return; }
        wrap.hidden = false;
        wanted.forEach((step) => {
            const row = document.createElement('div');
            row.className = 'agent-highlight';
            const badge = document.createElement('span');
            badge.className = `agent-highlight-status is-${step.status}`;
            badge.textContent = step.status;
            const title = document.createElement('span');
            title.className = 'agent-highlight-title';
            title.textContent = step.title;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn btn-small btn-outline agent-clip-btn';
            button.textContent = 'Clip it';
            button.addEventListener('click', async () => {
                button.disabled = true;
                try {
                    const made = await api(`/streams/agent/${encodeURIComponent(stream.id)}/clips`, { method: 'POST', body: { step_id: step.id } });
                    const clipId = made && made.clip ? (made.clip.clip_id || made.clip.id) : null;
                    button.textContent = clipId ? 'Clip made' : 'Clip queued';
                    if (clipId) {
                        const a = document.createElement('a');
                        a.href = `https://openvibe.video/c/${encodeURIComponent(clipId)}`;
                        a.textContent = 'Open the clip';
                        a.style.marginLeft = '8px';
                        row.appendChild(a);
                    }
                } catch (err) {
                    button.disabled = false;
                    button.textContent = (err && err.message) || 'Try again';
                }
            });
            row.append(badge, title, button);
            list.appendChild(row);
        });
    }

    // S7: a channel bound to a Bot robot may show the robot's camera as a second scene beside the desk. The panel is
    // Bot's own embed; Live only switches which scene is on, and the overlay stays the same on both.
    function renderScenes(stream) {
        const bar = document.getElementById('agent-scenes');
        const robot = document.getElementById('agent-robot');
        const frame = document.getElementById('agent-robot-frame');
        const stage = document.getElementById('agent-stage');
        if (!bar || !robot || !stage) return;
        const scene = stream && stream.robot_scene;
        if (!scene || !scene.embed_url) { bar.hidden = true; robot.hidden = true; stage.hidden = false; return; }
        if (frame && frame.getAttribute('src') !== scene.embed_url) frame.setAttribute('src', scene.embed_url);
        bar.hidden = false;
        const show = (name) => {
            const isRobot = name === 'robot';
            stage.hidden = isRobot;
            robot.hidden = !isRobot;
            for (const btn of bar.querySelectorAll('[data-agent-scene]')) {
                const on = btn.getAttribute('data-agent-scene') === name;
                btn.classList.toggle('is-on', on);
                btn.setAttribute('aria-pressed', on ? 'true' : 'false');
            }
        };
        for (const btn of bar.querySelectorAll('[data-agent-scene]')) {
            btn.onclick = () => show(btn.getAttribute('data-agent-scene'));
        }
        show('desk');
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
        renderScenes(stream);
        renderStatus(stream, liveViewers);
        mountPlays(data);
        ensureOverlay(data);
        renderOwner(data);
        renderControls(data);
        renderVoice();
        loadVoices();
        scheduleRenew(data);
        scheduleLines(data);
        schedulePoll(stream.id);
        if (!steps.length) loadInitialSteps(stream.id).then(() => { if (state && state.stream) { ensureOverlay(state); if (state.stream.state === 'ended') renderRecording(state); } });
        scheduleSteps(data);
        if (stream.state === 'ended') renderRecording(data);
    }

    /** S5: the moderators' bar. The owner and the channel's moderators see it; the owner also sees the log. */
    function renderControls(data) {
        const bar = $('agent-controls');
        if (!bar) return;
        const allowed = !!(data && (data.can_manage || data.can_moderate));
        bar.hidden = !allowed;
        if (!allowed) return;
        const paused = !!(data && data.paused);
        const pauseBtn = $('agent-ctl-pause');
        if (pauseBtn) {
            pauseBtn.textContent = paused ? 'Resume the agent' : 'Pause the agent';
            // A moderator cannot resume a pause the owner set (the server refuses it too).
            pauseBtn.disabled = paused && data.paused_by_role === 'owner' && !data.can_manage;
        }
        const curtain = data && data.stream ? data.stream.curtain : null;
        const curtainBtn = $('agent-ctl-curtain');
        if (curtainBtn) curtainBtn.textContent = curtain && curtain.up ? 'Lift the curtain' : 'Curtain';
        const muteBtn = $('agent-ctl-mute');
        if (muteBtn) muteBtn.textContent = voice && voice.muted ? 'Unmute voice' : 'Mute voice';
        const stateEl = $('agent-controls-state');
        if (stateEl) {
            if (paused && data.paused_by) stateEl.textContent = `Paused by @${data.paused_by}`;
            else if (curtain && curtain.up) stateEl.textContent = 'The curtain is up: viewers see a private screen.';
            else if (voice && voice.muted) stateEl.textContent = 'The voice is muted.';
            else stateEl.textContent = '';
        }
        const log = $('agent-controls-log');
        if (log && data.can_manage && data.stream && controlsLogFor !== data.stream.id) {
            controlsLogFor = data.stream.id;
            log.hidden = false;
            const list = $('agent-controls-log-list');
            if (list) list.replaceChildren();
            api(`/streams/agent/${encodeURIComponent(data.stream.id)}/controls`).then((out) => {
                if (!out || !Array.isArray(out.controls) || !list) return;
                if (!out.controls.length) { list.appendChild(Object.assign(document.createElement('li'), { textContent: 'No control has been pressed.' })); return; }
                for (const entry of out.controls) {
                    const li = document.createElement('li');
                    const when = new Date(entry.at);
                    li.textContent = `${entry.control} by @${entry.by.handle} (${entry.by.role}) · ${when.toLocaleString()}`;
                    list.appendChild(li);
                }
            }).catch(() => { controlsLogFor = null; });
        } else if (log && !data.can_manage) log.hidden = true;
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
        renderScenes(stream);
        renderVoice();
        const endBtn = $('agent-end');
        if (endBtn) endBtn.hidden = stream.state === 'ended';
        const confirm = $('agent-end-confirm');
        if (confirm && stream.state === 'ended') confirm.hidden = true;
    }

    /** S4: the voice panel. The mode, the personality, the voice and the mute, and the allowance message. */
    function renderVoice() {
        const panel = $('agent-owner');
        if (!panel || panel.hidden || !voice) return;
        const mode = $('agent-voice-mode');
        if (mode) mode.value = ['narrated', 'copilot'].includes(voice.mode) ? voice.mode : 'watch';
        const personality = $('agent-voice-personality');
        if (personality) personality.value = voice.personality || 'calm';
        const own = $('agent-voice-own');
        if (own) own.value = voice.own ? 'yes' : 'no';
        const pick = $('agent-voice-pick');
        if (pick && voice.voice && !pick.value) pick.value = voice.voice;
        const mute = $('agent-voice-mute');
        if (mute) {
            mute.textContent = voice.muted ? 'Unmute voice' : 'Mute voice';
            mute.classList.toggle('btn-outline', !voice.muted);
            mute.classList.toggle('btn-danger', !!voice.muted);
        }
        const state = $('agent-voice-state');
        if (state) {
            if (voice.paused === 'allowance_spent') {
                state.textContent = 'voice paused: allowance spent';
            } else if (voice.muted) {
                state.textContent = 'The voice is muted.';
            } else if (voice.mode === 'copilot') {
                state.textContent = `Co-pilot, in a ${voice.personality || 'calm'} voice: it reads the chat between steps.`;
            } else if (voice.mode === 'narrated') {
                state.textContent = `Narrated, in a ${voice.personality || 'calm'} voice.`;
            } else {
                state.textContent = 'The agent is silent (Watch mode).';
            }
        }
    }

    /** S4: the voice list, from Chat's public catalogue. A site without Chat keeps the current voice. */
    async function loadVoices() {
        if (voicesLoaded) return;
        voicesLoaded = true;
        const pick = $('agent-voice-pick');
        if (!pick) return;
        try {
            const res = await fetch('/api/tts/voices', { headers: { Accept: 'application/json' } });
            if (!res.ok) throw new Error('no voices');
            const data = await res.json();
            const list = Array.isArray(data && data.voices) ? data.voices : [];
            pick.replaceChildren();
            for (const entry of list) {
                const id = typeof entry === 'string' ? entry : entry && entry.id;
                if (!id) continue;
                const name = (typeof entry === 'object' && entry.name) || id;
                const option = document.createElement('option');
                option.value = String(id);
                option.textContent = String(name);
                pick.appendChild(option);
            }
            if (voice && voice.voice) pick.value = voice.voice;
        } catch {
            const note = $('agent-voice-note');
            if (note) note.textContent = 'The voice list is unavailable right now.';
        }
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
                ensureOverlay(next);
                renderStatus(next.stream, liveViewers);
                renderOwner(next);
                renderControls(next);
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

        // S4: the voice controls. Every change is one PUT; the mute is one POST (a moderator may do it too).
        const saveVoice = async (body) => {
            const id = idOf();
            if (!id) return;
            try {
                const next = await api(`/streams/agent/${encodeURIComponent(id)}/voice`, { method: 'PUT', body });
                if (next && next.voice) { voice = next.voice; renderVoice(); }
            } catch (err) {
                const hint = $('agent-voice-state');
                if (hint) hint.textContent = (err && err.message) || 'That did not save.';
            }
        };

        $('agent-voice-mode').addEventListener('change', (event) => {
            saveVoice({ mode: event.currentTarget.value });
        });
        $('agent-voice-personality').addEventListener('change', (event) => {
            saveVoice({ personality: event.currentTarget.value });
        });
        $('agent-voice-pick').addEventListener('change', (event) => {
            saveVoice({ voice: event.currentTarget.value || null });
        });
        $('agent-voice-own').addEventListener('change', (event) => {
            // The person's own cloned voice: the consent flag travels with it, so it can never be switched on quietly.
            saveVoice({ own: event.currentTarget.value === 'yes', own_consent: event.currentTarget.value === 'yes' });
        });
        $('agent-voice-mute').addEventListener('click', async () => {
            const id = idOf();
            if (!id) return;
            const muted = !(voice && voice.muted);
            try {
                const next = await api(`/streams/agent/${encodeURIComponent(id)}/voice/mute`, { method: 'POST', body: { muted } });
                if (next && next.voice) { voice = next.voice; renderVoice(); }
            } catch (err) {
                const hint = $('agent-voice-state');
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

        // S5: the moderators' bar, four controls, every press logged by the server.
        const pressControl = async (body) => {
            const id = idOf();
            if (!id) return;
            const view = state || {};
            try {
                const out = await api(`/streams/agent/${encodeURIComponent(id)}/control`, { method: 'POST', body });
                if (state) {
                    state.paused = !!out.paused;
                    state.paused_by = out.paused_by || null;
                    if (state.stream && out.curtain) state.stream.curtain = out.curtain;
                    if (state.stream && out.state) state.stream.state = out.state;
                }
                if (typeof out.muted === 'boolean' && voice) voice = { ...voice, muted: out.muted };
                renderControls(state || view);
                renderCurtain(!!(out.curtain && out.curtain.up));
                renderVoice();
                ensureOverlay(state || view);
                controlsLogFor = null;
                renderControls(state || view);
            } catch (err) {
                const hint = $('agent-controls-state');
                if (hint) hint.textContent = (err && err.message) || 'That control did not work.';
            }
        };
        $('agent-ctl-pause').addEventListener('click', () => pressControl({ control: 'pause', paused: !(state && state.paused) }));
        $('agent-ctl-curtain').addEventListener('click', () => {
            const up = !(state && state.stream && state.stream.curtain && state.stream.curtain.up);
            return pressControl({ control: 'curtain', up });
        });
        $('agent-ctl-mute').addEventListener('click', () => pressControl({ control: 'mute', muted: !(voice && voice.muted) }));
        // End is not a one-tap accident: the first press arms it, the second within five seconds ends it.
        let endArmed = false;
        let endTimer = null;
        $('agent-ctl-end').addEventListener('click', () => {
            const btn = $('agent-ctl-end');
            if (!endArmed) {
                endArmed = true;
                if (btn) btn.textContent = 'Press again to end';
                endTimer = setTimeout(() => { endArmed = false; if (btn) btn.textContent = 'End'; }, 5000);
                return undefined;
            }
            if (endTimer) clearTimeout(endTimer);
            endArmed = false;
            if (btn) btn.textContent = 'End';
            return pressControl({ control: 'end' });
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

    /** The newest 20 steps, once per page (and after the state poll finds the desk went live). */
    async function loadInitialSteps(id) {
        if (steps.length) return;
        try {
            const out = await api(`/streams/agent/${encodeURIComponent(id)}/steps`);
            if (out && Array.isArray(out.steps)) steps = out.steps;
        } catch { /* the overlay shows "waiting for the first step" */ }
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

    /** S6: the chat plays controls on the owner page: the time box, the cap, Go and Wipe now. */
    function bindPlays() {
        const go = $('agent-plays-go');
        const wipe = $('agent-plays-wipe');
        const note = $('agent-plays-note');
        const box = $('agent-plays-timebox');
        const cap = $('agent-plays-cap');
        if (!go && !wipe) return;
        const tell = (text) => { const line = $('agent-plays-state'); if (line) line.textContent = text; };
        // The mode waits for a sandbox worker: until one is registered and healthy the controls stay grey and
        // the note says so.
        const setReady = (ready) => {
            if (go) go.disabled = !ready;
            if (box) box.disabled = !ready;
            if (cap) cap.disabled = !ready;
            if (note) note.hidden = !!ready;
        };
        setReady(false);
        (async () => {
            try {
                const res = await fetch(`/api/streams/agent/${encodeURIComponent(publicId)}/plays/worker`, { credentials: 'same-origin' });
                if (!res.ok) return;
                const data = await res.json();
                setReady(!!(data && data.worker && data.worker.ready));
            } catch { /* the controls stay grey: the worker is not here */ }
        })();
        if (go) go.addEventListener('click', async () => {
            const box = $('agent-plays-timebox');
            const cap = $('agent-plays-cap');
            try {
                const res = await fetch(`/api/streams/agent/${encodeURIComponent(publicId)}/plays`, {
                    method: 'PUT', credentials: 'same-origin',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        time_box_minutes: Number(box && box.value) || 10,
                        cap_cents: Math.round((Number(cap && cap.value) || 0) * 100),
                        go: true,
                    }),
                });
                if (!res.ok) throw new Error('The chat plays settings could not be saved');
                tell('Go: the desk may work the queue. The first request waits for it.');
            } catch (err) {
                tell((err && err.message) || 'That did not work');
            }
        });
        if (wipe) wipe.addEventListener('click', async () => {
            try {
                const res = await fetch(`/api/streams/agent/${encodeURIComponent(publicId)}/control`, {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ control: 'wipe' }),
                });
                if (!res.ok) throw new Error('The desk could not be wiped');
                tell('Wiped: the run stopped and the sandbox is empty.');
            } catch (err) {
                tell((err && err.message) || 'That did not work');
            }
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindPlays);
    else bindPlays();

    window.loadAgentStreamPage = loadAgentStreamPage;
    window.stopAgentStreamPage = stop;
})();
