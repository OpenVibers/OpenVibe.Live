/* Agent stream overlay (Agent Streams S2): the work an agent is doing, drawn by the page — never burned into video.
 *
 * The page, the embed and the VOD all draw the same band from the same steps feed (live.agent-stream-step@1). It stays
 * sharp at any size, screen readers and translation can read it, and it is the one place a step's title is shown.
 *
 *   top:    the current step, with a status dot (blue running, green passed, red failed) and the task;
 *   ticks:  the last twelve steps, tappable (their titles);
 *   foot:   "1 of 2 passing", the cost and "worked 42 min";
 *   fold:   one line, remembered per browser; on a phone the band is one line and tapping opens the timeline sheet.
 *
 * Every value is text: the overlay builds nodes with textContent, so a title can never become markup.
 */
/* global window, document, localStorage */
(function () {
    'use strict';
    const FOLD_KEY = 'ov:agent-overlay:folded';
    const PHONE = 640;

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }

    function minutes(seconds) {
        const s = Math.max(0, Number(seconds) || 0);
        if (s < 60) return 'under a minute';
        const m = Math.round(s / 60);
        if (m < 90) return `${m} min`;
        const h = Math.floor(m / 60);
        return `${h} h ${m % 60} min`;
    }

    /** The step the band shows: the newest one (the API answers oldest first). */
    function current(steps) {
        return steps && steps.length ? steps[steps.length - 1] : null;
    }

    /** The latest step that reported tests, so "1 of 2 passing" survives a later step without a report. */
    function lastTests(steps) {
        for (let i = (steps || []).length - 1; i >= 0; i--) {
            if (steps[i] && steps[i].tests) return steps[i].tests;
        }
        return null;
    }

    function lastCost(steps) {
        for (let i = (steps || []).length - 1; i >= 0; i--) {
            if (steps[i] && typeof steps[i].cost_usd === 'number') return steps[i].cost_usd;
        }
        return null;
    }

    function statusWord(status) {
        return { started: 'running', passed: 'passed', failed: 'failed', skipped: 'skipped' }[status] || 'running';
    }

    /**
     * create({ host, title, initial }) → { update({ steps, workedSeconds, state }), destroy() }
     * `host` is an element inside the player's stage. The band is appended there and stays above a curtain.
     */
    function create(options) {
        const host = options && options.host;
        if (!host) return { update() {}, destroy() {} };
        const root = el('div', 'agent-overlay');
        root.setAttribute('role', 'status');
        root.setAttribute('aria-live', 'polite');

        const foldBtn = el('button', 'agent-overlay-fold');
        foldBtn.type = 'button';
        foldBtn.setAttribute('aria-label', 'Fold the agent overlay');
        const foldIcon = el('i', 'fa-solid fa-chevron-down');
        foldBtn.appendChild(foldIcon);

        const body = el('div', 'agent-overlay-body');
        const taskLine = el('p', 'agent-overlay-task');
        // S4: the line the agent is saying right now, drawn as a caption under the step.
        const captionLine = el('p', 'agent-overlay-caption');
        captionLine.hidden = true;
        const stepLine = el('p', 'agent-overlay-step');
        const dot = el('span', 'agent-overlay-dot');
        const stepTitle = el('span', 'agent-overlay-step-title');
        stepLine.append(dot, stepTitle);
        // S5: whose pause is in force ("Paused by @mod"), so a viewer knows why the work stopped.
        const pausedLine = el('p', 'agent-overlay-paused');
        pausedLine.hidden = true;

        // S6: the chat plays queue — the request the desk is on, and the next three with their votes.
        const queueLine = el('p', 'agent-overlay-queue');
        queueLine.hidden = true;

        const ticks = el('div', 'agent-overlay-ticks');
        ticks.setAttribute('role', 'list');
        ticks.setAttribute('aria-label', 'The last steps');

        const foot = el('p', 'agent-overlay-foot');
        const testsLine = el('span', 'agent-overlay-tests');
        const costLine = el('span', 'agent-overlay-cost');
        const workedLine = el('span', 'agent-overlay-worked');
        // S4: the voice label: which voice is speaking, and in which personality.
        const voiceLine = el('span', 'agent-overlay-voice');
        foot.append(testsLine, costLine, workedLine, voiceLine);

        const sheet = el('div', 'agent-overlay-sheet');
        sheet.hidden = true;
        const sheetList = el('ol', 'agent-overlay-sheet-list');
        sheet.appendChild(sheetList);
        // S6: the queue's next three, with their votes.
        const queueList = el('ol', 'agent-overlay-queue-list');
        queueList.hidden = true;
        sheet.appendChild(queueList);

        body.append(taskLine, stepLine, pausedLine, captionLine, queueLine, ticks, foot);
        root.append(foldBtn, body, sheet);
        host.appendChild(root);

        let folded = false;
        try { folded = localStorage.getItem(FOLD_KEY) === '1'; } catch { /* private mode */ }
        const applyFold = () => {
            root.classList.toggle('is-folded', folded);
            foldIcon.className = `fa-solid fa-chevron-${folded ? 'up' : 'down'}`;
            foldBtn.setAttribute('aria-label', folded ? 'Unfold the agent overlay' : 'Fold the agent overlay');
            body.hidden = false;   // CSS shows the current step only when folded
        };
        applyFold();

        foldBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            folded = !folded;
            try { localStorage.setItem(FOLD_KEY, folded ? '1' : '0'); } catch { /* */ }
            applyFold();
        });

        // Tapping the band on a phone opens the timeline sheet (the CSS hides the inline details there).
        root.addEventListener('click', () => {
            if (window.innerWidth > PHONE) return;
            sheet.hidden = !sheet.hidden;
        });

        let lastSteps = [];

        function renderTicks(steps) {
            const shown = (steps || []).slice(-12);
            ticks.replaceChildren();
            shown.forEach((step) => {
                const tick = el('button', `agent-overlay-tick is-${step.status}`);
                tick.type = 'button';
                tick.setAttribute('role', 'listitem');
                tick.title = `${step.title} — ${statusWord(step.status)}`;
                tick.setAttribute('aria-label', tick.title);
                tick.addEventListener('click', (event) => {
                    event.stopPropagation();
                    tick.classList.toggle('is-open');
                    tick.title = `${step.title} — ${statusWord(step.status)}`;
                });
                ticks.appendChild(tick);
            });
            if (!shown.length) ticks.hidden = true;
            else ticks.hidden = false;
        }

        function renderSheet(steps) {
            sheetList.replaceChildren();
            (steps || []).slice().reverse().forEach((step) => {
                const li = el('li', `agent-overlay-sheet-row is-${step.status}`);
                li.append(el('span', 'agent-overlay-sheet-title', step.title), el('span', 'agent-overlay-sheet-status', statusWord(step.status)));
                if (step.detail) li.appendChild(el('span', 'agent-overlay-sheet-detail', step.detail));
                sheetList.appendChild(li);
            });
        }

        /** S6: the queue the desk reported — the current request, and the next three with their votes. */
        function renderQueue(queue) {
            const q = queue || {};
            const current = q.current || null;
            const top = Array.isArray(q.top) ? q.top : [];
            if (current) {
                const who = current.author ? ` — ${current.author}` : '';
                queueLine.textContent = `Working on: ${current.text}${who}`;
                queueLine.hidden = false;
            } else {
                queueLine.textContent = '';
                queueLine.hidden = true;
            }
            queueList.replaceChildren();
            top.forEach((r, i) => {
                const li = el('li', 'agent-overlay-queue-row');
                li.append(el('span', 'agent-overlay-queue-place', `#${i + 1}`), el('span', 'agent-overlay-queue-text', r.text),
                    el('span', 'agent-overlay-queue-votes', `${r.votes} vote${r.votes === 1 ? '' : 's'}`));
                queueList.appendChild(li);
            });
            queueList.hidden = !top.length;
        }

        function update(next) {
            const data = next || {};
            const steps = Array.isArray(data.steps) ? data.steps : lastSteps;
            lastSteps = steps;
            // S4: the caption is the newest spoken line; it fades with the fold like the rest of the band.
            const caption = data.caption && String(data.caption).trim() ? String(data.caption).trim() : '';
            captionLine.textContent = caption;
            captionLine.hidden = !caption;
            const voice = data.voice || null;
            if (voice && voice.personality) {
                const label = voice.muted ? 'Voice muted' : (voice.paused ? 'Voice paused' : voice.personality);
                root.setAttribute('data-voice', label);
                voiceLine.textContent = voice.voice ? `${voice.personality} voice · ${voice.voice}` : `${voice.personality} voice`;
                voiceLine.hidden = false;
            } else {
                root.removeAttribute('data-voice');
                voiceLine.textContent = '';
                voiceLine.hidden = true;
            }
            const pausedBy = data.pausedBy ? String(data.pausedBy).replace(/^@/, '') : '';
            pausedLine.textContent = pausedBy ? `Paused by @${pausedBy}` : '';
            pausedLine.hidden = !pausedBy;
            const cur = current(steps);
            const task = data.task && data.task.title ? data.task.title : (options.title || 'An AI agent is working');
            taskLine.textContent = task;
            if (cur) {
                dot.className = `agent-overlay-dot is-${cur.status}`;
                stepTitle.textContent = cur.title;
                stepLine.title = cur.detail || cur.title;
            } else {
                dot.className = 'agent-overlay-dot is-idle';
                stepTitle.textContent = data.state === 'live' ? 'Waiting for the first step' : '';
            }
            renderTicks(steps);
            renderSheet(steps);
            // S6: the queue, when the desk reported one.
            renderQueue(data.queue || null);
            const tests = lastTests(steps);
            testsLine.textContent = tests ? `${tests.passed} of ${tests.passed + tests.failed} passing` : '';
            testsLine.hidden = !tests;
            const cost = lastCost(steps);
            costLine.textContent = typeof cost === 'number' ? `${cost.toFixed(2)} USD` : '';
            costLine.hidden = typeof cost !== 'number';
            workedLine.textContent = data.workedSeconds != null ? `worked ${minutes(data.workedSeconds)}` : '';
            root.hidden = !(steps.length || (data.state === 'live' && task));
        }

        update(options.initial || {});

        return {
            update,
            destroy() { try { root.remove(); } catch { /* */ } },
        };
    }

    window.AgentOverlay = { create, minutes, current };
})();
