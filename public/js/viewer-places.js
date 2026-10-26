/* Where a live stream is watched, on a tap (owner, 2026-10-26: "tapping it should show the different viewer counts across
   all platforms … and includes natural openvibe viewers too"). The server lists the places, OpenVibe first, then
   RobotStreamer and each restream platform (server/streaming/viewer-places.js); this draws them in a small panel by the
   count that was tapped. Used by the channel player's count (app-channel.js) and the phone live studio's
   (broadcast-studio.js). A place with count null is live there without a number (YouTube without an API key).

   OVViewerPlaces.toggle(anchor, getPlaces, { below })  opens or closes the panel by `anchor`
   OVViewerPlaces.update()                              redraws it from getPlaces() (call when counts change)
   OVViewerPlaces.close()
   OVViewerPlaces.total(places), .summary(places)       the sum, and "4 on OpenVibe, 5 on Twitch" */
(function () {
    'use strict';
    const LOOK = {
        openvibe: { mark: true },
        robotstreamer: { icon: 'fa-solid fa-robot', color: '#4fc3f7' },
        twitch: { icon: 'fa-brands fa-twitch', color: '#a970ff' },
        kick: { icon: 'fa-brands fa-kickstarter-k', color: '#53fc18' },
        youtube: { icon: 'fa-brands fa-youtube', color: '#ff4e45' },
        custom: { icon: 'fa-solid fa-globe', color: '#9ca3af' },
    };
    const GAP = 8;
    let open = null;   // { panel, anchor, get, below }

    function el(tag, attrs, ...kids) {
        const n = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (v == null || v === false) continue;
            if (k === 'class') n.className = v;
            else if (k === 'text') n.textContent = v;
            else n.setAttribute(k, v === true ? '' : v);
        }
        for (const kid of kids) if (kid != null && kid !== false) n.append(kid);
        return n;
    }
    const total = (places) => (places || []).reduce((n, p) => n + (Number(p.count) || 0), 0);
    const fmt = (n) => Number(n).toLocaleString();
    function summary(places) {
        return (places || []).map((p) => (p.count == null ? `live on ${p.name}` : `${fmt(p.count)} on ${p.name}`)).join(', ');
    }

    function row(p) {
        const look = LOOK[p.key] || LOOK.custom;
        const badge = look.mark
            ? el('span', { class: 'ov-mark', 'data-size': '16', 'data-static': '1', 'aria-hidden': 'true' })
            : el('i', { class: look.icon, 'aria-hidden': 'true' });
        const name = el('span', { class: 'ovp-name', text: p.name });
        const label = p.url && /^https?:\/\//i.test(p.url)
            ? el('a', { class: 'ovp-link', href: p.url, target: '_blank', rel: 'noopener' }, name, el('i', { class: 'fa-solid fa-arrow-up-right-from-square ovp-out', 'aria-hidden': 'true' }))
            : name;
        const n = p.count == null
            ? el('span', { class: 'ovp-n is-live', title: `Live on ${p.name}; it does not give a viewer count` }, 'live')
            : el('span', { class: 'ovp-n', text: fmt(p.count) });
        const li = el('li', { class: 'ovp-row' }, el('span', { class: 'ovp-ico' }, badge), label, n);
        if (look.color) li.style.setProperty('--ovp-c', look.color);
        return li;
    }

    function draw() {
        if (!open) return;
        const places = open.get() || [];
        const list = open.panel.querySelector('.ovp-list');
        list.replaceChildren(...places.map(row));
        open.panel.querySelector('.ovp-total-n').textContent = fmt(total(places));
        place();
    }

    /** Next to the anchor: over it, or under it (`below`, or when over it is too little room: a phone's player sits
        just under the navbar), its edge lined up with the anchor's, inside the screen. */
    function place() {
        if (!open) return;
        const { panel, anchor } = open;
        const r = anchor.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        // The site's fixed navbar covers the top of the page, except in fullscreen.
        const fs = document.fullscreenElement || document.webkitFullscreenElement;
        const top = fs ? 0 : parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--navbar-h')) || 0;
        const over = r.top - top - GAP * 2, under = vh - r.bottom - GAP * 2;
        panel.style.maxHeight = 'none';
        const h = panel.offsetHeight;
        let below = open.below;
        if (below ? h > under && over > under : h > over && under > over) below = !below;
        const room = below ? under : over;
        panel.style.maxHeight = `${Math.max(120, room)}px`;
        const w = panel.offsetWidth;
        // A count at the top (the studio's) lines up the left edges; one in a bottom bar (the player's) the right ones.
        const left = Math.min(Math.max(GAP, open.below ? r.left : r.right - w), vw - w - GAP);
        panel.style.left = `${Math.max(GAP, left)}px`;
        if (below) { panel.style.top = `${r.bottom + GAP}px`; panel.style.bottom = ''; }
        else { panel.style.bottom = `${vh - r.top + GAP}px`; panel.style.top = ''; }
    }

    function onOutside(e) {
        if (!open) return;
        if (open.panel.contains(e.target) || open.anchor.contains(e.target)) return;
        close();
    }
    function onKey(e) { if (e.key === 'Escape' && open) { const a = open.anchor; close(); if (a.focus) a.focus(); } }

    function show(anchor, get, opts) {
        close();
        const panel = el('div', { class: 'ovp', role: 'dialog', 'aria-label': 'Where people are watching' },
            el('div', { class: 'ovp-head' }, el('span', { text: 'Watching now' }),
                el('span', { class: 'ovp-total' }, el('i', { class: 'fa-solid fa-eye', 'aria-hidden': 'true' }), el('b', { class: 'ovp-total-n', text: '0' }))),
            el('ul', { class: 'ovp-list' }));
        // In fullscreen only the fullscreen element shows: the panel goes inside it.
        const fs = document.fullscreenElement || document.webkitFullscreenElement;
        (fs && fs.contains(anchor) ? fs : document.body).append(panel);
        open = { panel, anchor, get, below: !!(opts && opts.below) };
        anchor.setAttribute('aria-expanded', 'true');
        document.addEventListener('pointerdown', onOutside, true);
        document.addEventListener('keydown', onKey);
        window.addEventListener('resize', place);
        draw();
    }
    function close() {
        if (!open) return;
        open.anchor.setAttribute('aria-expanded', 'false');
        open.panel.remove();
        open = null;
        document.removeEventListener('pointerdown', onOutside, true);
        document.removeEventListener('keydown', onKey);
        window.removeEventListener('resize', place);
    }
    function toggle(anchor, get, opts) {
        if (open && open.anchor === anchor) close();
        else show(anchor, get, opts);
    }
    function update() {
        if (!open) return;
        // The anchor went away (the player was rebuilt, the studio closed): so does the panel.
        if (!open.anchor.isConnected) { close(); return; }
        draw();
    }

    window.OVViewerPlaces = { toggle, update, close, total, summary, isOpen: () => !!open };
})();
