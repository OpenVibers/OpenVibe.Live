/* Agent stream cards (Agent Streams S2): one card for the Agents tab on a channel, one row on Live's home.
 *
 * The same card in both places: the last frame, the "AI agent" label, the task, the current (or last) step, the viewer
 * count while live and "worked 42 min" offline. Every value is a text node, so a title cannot become markup; the card's
 * link is the stream's own page (a private or unlisted stream never reaches this code — the API filters it).
 */
/* global window, document */
(function () {
    'use strict';

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

    function where(task) {
        if (!task) return '';
        const source = { codes: 'Codes', actor: 'Actor', desk: 'Desk', node: 'Node' }[task.source] || task.source || '';
        return task.title ? (source ? `${source} · ${task.title}` : task.title) : source;
    }

    /** One card as a DOM node. The whole card is the link; the media keeps its own alt text. */
    function card(entry) {
        const a = el('a', 'agent-card');
        a.href = entry.page_url || '#';
        const media = el('div', 'agent-card-media');
        const frame = entry.last_frame_url
            ? el('img')
            : el('div', 'agent-card-noimg', 'No frame yet');
        if (entry.last_frame_url) {
            frame.src = entry.last_frame_url;
            frame.alt = '';
            frame.loading = 'lazy';
        }
        media.appendChild(frame);
        media.appendChild(el('span', 'agent-label', 'AI agent'));
        if (entry.state === 'live') {
            const live = el('span', 'agent-card-live', 'live');
            if (entry.viewers) live.textContent = `live · ${entry.viewers}`;
            media.appendChild(live);
        }
        const body = el('div', 'agent-card-body');
        body.appendChild(el('h3', 'agent-card-title', entry.title || 'An AI agent'));
        const task = where(entry.task);
        if (task) body.appendChild(el('p', 'agent-card-task', task));
        const meta = el('p', 'agent-card-meta');
        if (entry.current_step && entry.current_step.title) {
            meta.appendChild(el('span', `is-${entry.current_step.status || 'started'}`, entry.current_step.title));
        }
        if (entry.state === 'ended') meta.appendChild(el('span', '', `${meta.childNodes.length ? '· ' : ''}worked ${minutes(entry.worked_seconds)}`));
        if (meta.childNodes.length) body.appendChild(meta);
        a.appendChild(media);
        a.appendChild(body);
        return a;
    }

    /**
     * Fill a grid with the first `perPage` cards and keep the rest behind the design's counted fold.
     * Returns { total, shown, more() } so a page can wire its own "More (N)" button.
     */
    function fill(grid, entries, { perPage = 12, moreButton = null } = {}) {
        const all = Array.isArray(entries) ? entries : [];
        let shown = 0;
        const render = () => {
            const next = all.slice(shown, shown + perPage);
            for (const entry of next) grid.appendChild(card(entry));
            shown += next.length;
            if (moreButton) {
                const left = all.length - shown;
                moreButton.hidden = left <= 0;
                moreButton.textContent = `More (${left})`;
            }
        };
        render();
        return {
            total: all.length,
            get shown() { return shown; },
            more() { render(); return shown; },
        };
    }

    window.AgentCards = { card, fill, minutes };
})();
