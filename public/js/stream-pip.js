/* ───────────────────────────────────────────────────────────────
   stream-pip.js — the streams drawn over a live stream (picture-in-picture).

   A slot lists up to three other slots (stream_pips, migration 0021): the streamer's own (their camera while the main
   stream is a screen share) or anyone's on the site. Each is an ordinary stream in its own right, with its own VOD,
   clips, transcript and restreams, so each PIP here is a second, self-contained viewer session: its own websocket,
   mediasoup recv transport and consumers (an RTMP source plays its FLV through the same proxy as the main player). It
   deliberately does not reuse stream-player.js's machinery, which is written around module-level singletons.

   The server sends every PIP with the stream (`pip_overlays`: source slot, its live stream or null, the streamer's
   default place and sound). Only live ones are drawn; every 30 s the list is asked for again
   (GET /api/streams/:id/pips), so one that goes live appears and one that ends goes.

   Anywhere (owner, 2026-11-11: "move it anywhere … on top of shit … more solid feeling and more responsive"):
   - a PIP lives in the player (docked) or over the page (floating, position: fixed, it stays on screen while the page
     scrolls); it follows the finger or the mouse with a transform each frame and lands with a spring (FLIP), dropped
     over the player it docks, anywhere else it floats; a flick carries on the way it was thrown;
   - thrown past the side of the screen (or of the player) it tucks into that side, a tab with its picture still going
     at the edge, and a tap brings it out ("get out of the way" without hiding it);
   - it is never smaller than a 150 px wide 16:9 box on a phone; two fingers pinch it, the corner sizes it, a double
     tap (or click) toggles small and large; with focus the arrows move it, + and − size it, M mutes, T tucks, F pops it
     out of the player or back in, Home puts it back where the streamer put it.
   Waiting (owner: "this black thing that's just stuck there … use the OV animations"): until its first frame, and
   whenever its frames stop for 4 s, it shows the mark at work over its last picture, and tries again by itself after
   15 s and on a backoff when its connection drops (2, 4, 8, 15, 30 s); a source that ended leaves with an animation.

   Its place (the source's own shape: a portrait camera is shown whole, `w` is the width a 16:9 PIP would have and any
   other shape gets the same area, never more than 85% of its frame's height) is kept as FRACTIONS of its frame (the
   player, or the window when floating), per slot (not per session, so it is there next time the streamer is live) and
   per PIP: in this browser at once, and in the person's account when they are signed in (GET/PUT /api/me/layout,
   newest wins), so another device opens with it where they left it.
   ─────────────────────────────────────────────────────────────── */

(function () {
    'use strict';

    const LS_KEY = (slot, sourceMsid) => `ov-pip-${slot}-${sourceMsid}`;
    const LS_V1 = (streamId, sourceMsid) => `ov-pip-geom-${streamId}-${sourceMsid}`;   // per session, before 2026-11-11
    const MIN_W = 0.08, MAX_W = 0.60;
    const POLL_MS = 30000;
    const BASE = 16 / 9;          // the shape `w` is measured for
    const MAX_H = 0.85;           // of the frame's height, whatever the shape
    const SNAP = 0.04;            // within this fraction of an edge, a dropped PIP snaps to it
    const EDGE_PX = 12;           // the margin it snaps to
    const BIG_W = 0.5;            // a double tap's large size
    const MIN_PX = 150;           // the smallest 16:9 width on a phone-sized frame
    const TAB_PX = 30;            // what stays on screen of a tucked PIP
    const DRAG_PX = 4;            // a press that moves less is a tap
    const STALL_MS = 4000;        // no new frame for this long: show the wait
    const RETRY_MS = 15000;       // still nothing: connect again
    const BACKOFF = [2000, 4000, 8000, 15000, 30000];
    const LAND_MS = 300;

    let host = null;   // { streamId, slot, container, overlays: Map(source_msid → overlay), timer, gen, ro }
    let gen = 0;

    const reduced = () => {
        const m = document.documentElement && document.documentElement.getAttribute('data-ov-motion');
        if (m === 'off') return true;
        try { return m !== 'on' && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
    };

    /* ── the account copy (GET/PUT /api/me/layout; a site without it keeps the browser's copy only) ───────────── */

    const account = {
        data: null, loading: null, pending: {}, timer: 0, off: false,
        signedIn() { return typeof currentUser !== 'undefined' && !!currentUser; },
        load() {
            if (this.off || !this.signedIn() || typeof api !== 'function') return Promise.resolve(null);
            if (!this.loading) this.loading = api('/me/layout').then((d) => { this.data = d && typeof d === 'object' ? d : {}; return this.data; })
                .catch((e) => { if (e && (e.status === 404 || e.status === 401)) this.off = true; return null; });
            return this.loading;
        },
        get(key) { return (this.data && this.data.pip && this.data.pip[key]) || null; },
        put(key, value) {
            if (this.off || !this.signedIn() || typeof api !== 'function') return;
            this.pending[key] = value;
            if (this.data) { this.data.pip = this.data.pip || {}; this.data.pip[key] = value; }
            clearTimeout(this.timer);
            this.timer = setTimeout(() => {
                const pip = this.pending; this.pending = {};
                api('/me/layout', { method: 'PATCH', body: { pip } }).catch((e) => { if (e && e.status === 404) this.off = true; });
            }, 1500);
        },
    };

    /* ── geometry ─────────────────────────────────────────────── */

    function clamp(v, lo, hi, dflt) {
        const n = Number(v);
        if (!Number.isFinite(n)) return dflt;
        return Math.min(hi, Math.max(lo, n));
    }

    function defaultsOf(pip) {
        const d = pip.defaults || {};
        // The streamer's choice; by default muted: the stream underneath already carries the voice, and two live audio
        // tracks would double every word.
        return { x: clamp(d.x, 0, 1, 0.72), y: clamp(d.y, 0, 1, 0.70), w: clamp(d.w, MIN_W, MAX_W, 0.25), mode: 'dock', tuck: null, muted: pip.muted !== false, at: 0 };
    }

    function shapeGeom(raw, fallback) {
        if (!raw || typeof raw !== 'object') return null;
        return {
            x: clamp(raw.x, 0, 1, fallback.x), y: clamp(raw.y, 0, 1, fallback.y), w: clamp(raw.w, MIN_W, MAX_W, fallback.w),
            mode: raw.mode === 'float' ? 'float' : 'dock',
            tuck: raw.tuck === 'left' || raw.tuck === 'right' ? raw.tuck : (raw.hidden ? 'right' : null),
            muted: typeof raw.muted === 'boolean' ? raw.muted : fallback.muted,
            at: Number(raw.at) || 0,
        };
    }

    /** This browser's copy, else the per-session one it had before, else the streamer's place; the account's if newer. */
    function loadGeom(slot, streamId, pip) {
        const fallback = defaultsOf(pip);
        let local = null;
        try {
            local = shapeGeom(JSON.parse(localStorage.getItem(LS_KEY(slot, pip.source_msid)) || 'null'), fallback)
                || shapeGeom(JSON.parse(localStorage.getItem(LS_V1(streamId, pip.source_msid)) || 'null'), fallback);
        } catch { local = null; }
        const remote = shapeGeom(account.get(`${slot}:${pip.source_msid}`), fallback);
        if (remote && (!local || remote.at > local.at)) return remote;
        return local || fallback;
    }

    function saveGeom(o) {
        o.geom.at = Date.now();
        try { localStorage.setItem(LS_KEY(o.slot, o.pip.source_msid), JSON.stringify(o.geom)); } catch { /* */ }
        account.put(`${o.slot}:${o.pip.source_msid}`, o.geom);
        try { window.dispatchEvent(new CustomEvent('ov:pip', { detail: { slot: o.slot, source: o.pip.source_msid, geom: { ...o.geom } } })); } catch { /* */ }
    }

    /** The PIP's frame: the player when docked, the window when floating (fullscreen: always the player). */
    function frameRect(o) {
        if (o.geom && o.geom.mode === 'float' && !inFullscreen(o)) {
            const w = window.innerWidth || 0, h = window.innerHeight || 0;
            return { left: 0, top: 0, width: w, height: h };
        }
        return o.container ? o.container.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    }

    function inFullscreen(o) {
        const fs = typeof document !== 'undefined' && document.fullscreenElement;
        return !!(fs && o && o.container && (fs === o.container || fs.contains(o.container)));
    }

    /** The box as fractions of its frame: width, height and the place it may go, for the source's own shape. */
    function boxOf(o) {
        const a = o.aspect || BASE;
        const r = frameRect(o);
        // On a phone-sized frame a quarter of the width is a postage stamp: never smaller than a 150 px wide 16:9 box
        // (the saved size is unchanged, so a desktop shows it as saved).
        const w = r.width && r.width < 640 ? Math.max(o.geom.w, Math.min(MAX_W, MIN_PX / r.width)) : o.geom.w;
        let wf = w * Math.sqrt(a / BASE);                        // the same area as a 16:9 PIP of width w
        if (r.width && r.height && (wf * r.width) / a > MAX_H * r.height) wf = (MAX_H * r.height * a) / r.width;
        wf = Math.min(wf, 1);
        const hf = r.width && r.height ? (wf * r.width) / a / r.height : wf / a;
        return { a, wf, hf, rw: r.width, rh: r.height, rl: r.left || 0, rt: r.top || 0 };
    }

    function applyGeom(o) {
        const { x, y, tuck } = o.geom;
        const b = boxOf(o);
        const floating = o.geom.mode === 'float' && !inFullscreen(o);
        if (o.el.classList.toggle) {
            o.el.classList.toggle('is-floating', floating);
            o.el.classList.toggle('is-tucked', !!tuck);
            o.el.classList.toggle('is-tucked-left', tuck === 'left');
            o.el.classList.toggle('is-tucked-right', tuck === 'right');
            o.el.classList.toggle('is-portrait', b.a < 1);
        }
        // Shown inside its frame even when a turn of the phone or a smaller window would push it out; the saved place
        // is not changed, so it comes back when there is room again. A tucked one sits at its side (CSS `translate`
        // leaves only its tab on screen; `transform` stays free for the landing).
        const left = tuck === 'left' ? 0 : tuck === 'right' ? Math.max(0, 1 - b.wf) : Math.min(Math.max(0, x), Math.max(0, 1 - b.wf));
        o.el.style.left = `${left * 100}%`;
        o.el.style.top = `${Math.min(Math.max(0, y), Math.max(0, 1 - b.hf)) * 100}%`;
        o.el.style.width = `${b.wf * 100}%`;
        o.el.style.aspectRatio = String(b.a);
    }

    /** After a drop: keep it inside, and snap it to an edge it was dropped close to. */
    function settle(o) {
        const b = boxOf(o);
        const mx = b.rw ? EDGE_PX / b.rw : 0, my = b.rh ? EDGE_PX / b.rh : 0;
        const maxX = Math.max(0, 1 - b.wf), maxY = Math.max(0, 1 - b.hf);
        let { x, y } = o.geom;
        x = Math.min(Math.max(0, x), maxX); y = Math.min(Math.max(0, y), maxY);
        if (x < SNAP) x = Math.min(mx, maxX); else if (x > maxX - SNAP) x = Math.max(0, maxX - mx);
        if (y < SNAP) y = Math.min(my, maxY); else if (y > maxY - SNAP) y = Math.max(0, maxY - my);
        o.geom.x = x; o.geom.y = y;
    }

    /** The source's shape, from the video itself: on its first frame and whenever it changes (a phone turned). */
    function watchShape(o, videoEl) {
        const read = () => {
            const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
            if (!vw || !vh) return;
            const a = vw / vh;
            if (o.aspect && Math.abs(o.aspect - a) < 0.01) return;
            o.aspect = a;
            if (o.el) applyGeom(o);
        };
        videoEl.addEventListener('loadedmetadata', read);
        videoEl.addEventListener('resize', read);
    }

    function resetGeom(o) {
        const d = defaultsOf(o.pip);
        Object.assign(o.geom, { x: d.x, y: d.y, w: d.w, mode: 'dock', tuck: null });
    }

    /* ── where it lives: the player, or over the page ─────────── */

    /** The element the PIP is a child of for its mode: the player, or the page (the fullscreen element in fullscreen). */
    function placeIn(o) {
        const fs = document.fullscreenElement;
        const want = o.geom.mode === 'float' && !inFullscreen(o) ? document.body : (fs && !fs.contains(o.container) ? fs : o.container);
        if (want && o.el.parentNode !== want) {
            const v = o.el.querySelector('.ov-pip-video');
            want.appendChild(o.el);
            // A media element moved in one task keeps playing; play() covers a browser that paused it.
            if (v && v.paused) v.play().catch(() => {});
        }
    }

    /** Move it to its place with a spring from where it was (`from`: its rect on screen before). */
    function land(o, from) {
        placeIn(o);
        o.el.style.transition = 'none';
        o.el.style.transform = '';
        applyGeom(o);
        if (!from || reduced()) { o.el.style.transition = ''; return; }
        const to = o.el.getBoundingClientRect();
        if (!to.width) { o.el.style.transition = ''; return; }
        const dx = from.left - to.left, dy = from.top - to.top, s = from.width / to.width;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(s - 1) < 0.01) { o.el.style.transition = ''; return; }
        o.el.style.transformOrigin = '0 0';
        o.el.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(${s})`;
        void o.el.offsetWidth;
        o.el.style.transition = `transform ${LAND_MS}ms var(--ov-ease-spring, cubic-bezier(.2, 1.25, .3, 1))`;
        o.el.style.transform = '';
        clearTimeout(o.landTimer);
        o.landTimer = setTimeout(() => { if (o.el) { o.el.style.transition = ''; o.el.style.transformOrigin = ''; } }, LAND_MS + 40);
    }

    /* ── DOM ──────────────────────────────────────────────────── */

    function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function muteButton(btn, muted, label) {
        btn.title = muted ? `Turn on ${label}'s sound` : `Mute ${label}`;
        btn.setAttribute('aria-label', btn.title);
        btn.setAttribute('aria-pressed', String(!muted));
        btn.innerHTML = `<i class="fa-solid ${muted ? 'fa-volume-xmark' : 'fa-volume-high'}"></i>`;
    }

    const STATE_TEXT = {
        connecting: (l) => `Connecting to ${l}`,
        waiting: (l) => `Waiting for ${l}'s picture`,
        offline: (l) => `${l} dropped · trying again`,
    };

    function setState(o, state) {
        if (!o.el || o.state === state) return;
        o.state = state;
        o.el.dataset.state = state;
        o.el.classList.toggle('is-offline', state === 'offline');
        const s = o.el.querySelector('.ov-pip-state');
        if (!s) return;
        const label = o.pip.title || 'the camera';
        const mark = s.querySelector('.ov-mark');
        if (mark) mark.setAttribute('data-state', state === 'offline' ? 'sleep' : 'busy');
        const t = s.querySelector('.ov-pip-state-t');
        if (t && STATE_TEXT[state]) t.textContent = STATE_TEXT[state](label);
    }

    function build(o, container) {
        const label = o.pip.title || 'Picture-in-picture';
        const href = o.pip.username ? `/@${encodeURIComponent(o.pip.username)}${o.pip.slug ? `/${encodeURIComponent(o.pip.slug)}` : ''}` : null;
        const el = document.createElement('div');
        el.className = 'ov-pip is-entering';
        el.dataset.pipSource = String(o.pip.source_msid);
        el.innerHTML = `
            <video class="ov-pip-video" autoplay playsinline muted></video>
            <div class="ov-pip-state" aria-live="polite"><span class="ov-mark" data-size="34" data-state="busy" aria-hidden="true"></span><span class="ov-pip-state-t"></span></div>
            <div class="ov-pip-bar">
                <span class="ov-pip-title" title="${escapeHtml(label)}"><i class="fa-solid fa-video" aria-hidden="true"></i> ${href
                    ? `<a href="${escapeHtml(href)}" onclick="return handleLinkClick(event, '${escapeHtml(href)}')">${escapeHtml(label)}</a>` : escapeHtml(label)}</span>
                <span class="ov-pip-actions">
                    <button type="button" data-act="mute"></button>
                    <button type="button" data-act="reset" title="Back to where the streamer put it" aria-label="Back to where the streamer put it"><i class="fa-solid fa-rotate-left"></i></button>
                    <button type="button" data-act="tuck" title="Tuck ${escapeHtml(label)} to the side" aria-label="Tuck ${escapeHtml(label)} to the side"><i class="fa-solid fa-angles-right"></i></button>
                </span>
            </div>
            <button type="button" class="ov-pip-tab" data-act="untuck" title="Bring ${escapeHtml(label)} back" aria-label="Bring ${escapeHtml(label)} back"><span class="ov-pip-tab-l"><i class="fa-solid fa-chevron-left"></i></span><span class="ov-pip-tab-r"><i class="fa-solid fa-chevron-right"></i></span></button>
            <div class="ov-pip-resize" title="Drag to resize" aria-hidden="true"></div>`;
        o.el = el;
        o.container = container;
        el.tabIndex = 0;
        el.setAttribute('role', 'group');
        el.setAttribute('aria-label', `${label}, picture-in-picture. Drag it anywhere; arrow keys move it, plus and minus size it, M mutes it, T tucks it aside, F pops it out of the player.`);
        muteButton(el.querySelector('[data-act="mute"]'), o.geom.muted, label);
        watchShape(o, el.querySelector('.ov-pip-video'));
        setState(o, 'connecting');

        el.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-act]');
            if (!btn || !el.contains(btn)) return;
            e.stopPropagation();
            act(o, btn.dataset.act);
        });
        wireMove(o);
        wireResize(o);
        wireKeys(o);
        placeIn(o);
        applyGeom(o);
        setTimeout(() => el.classList.remove('is-entering'), 420);
    }

    function act(o, what) {
        const el = o.el;
        const from = el.getBoundingClientRect();
        if (what === 'tuck') {
            const b = boxOf(o);
            o.geom.tuck = o.geom.x + b.wf / 2 < 0.5 ? 'left' : 'right';
            saveGeom(o); land(o, from);
        } else if (what === 'untuck') {
            o.geom.tuck = null;
            const b = boxOf(o);
            o.geom.x = from.left + from.width / 2 < (b.rl + b.rw / 2) ? (b.rw ? EDGE_PX / b.rw : 0) : Math.max(0, 1 - b.wf - (b.rw ? EDGE_PX / b.rw : 0));
            saveGeom(o); land(o, from);
        } else if (what === 'reset') { resetGeom(o); settle(o); saveGeom(o); land(o, from); }
        else if (what === 'float') { toMode(o, o.geom.mode === 'float' ? 'dock' : 'float', from); saveGeom(o); land(o, from); }
        else if (what === 'mute') {
            o.geom.muted = !o.geom.muted;
            const v = el.querySelector('.ov-pip-video');
            v.muted = o.geom.muted;
            if (!o.geom.muted) v.play().catch(() => {});
            muteButton(el.querySelector('[data-act="mute"]'), o.geom.muted, o.pip.title || 'Picture-in-picture');
            saveGeom(o);
        }
    }

    /** Switch frames keeping its size and place on screen (`rect`: where it is now). */
    function toMode(o, mode, rect) {
        o.geom.mode = mode;
        const b0 = boxOf(o);
        if (!b0.rw || !b0.rh) return;
        const k = Math.sqrt((o.aspect || BASE) / BASE) || 1;
        o.geom.w = clamp(rect.width / b0.rw / k, MIN_W, MAX_W, o.geom.w);
        const b = boxOf(o);
        o.geom.x = (rect.left - b.rl) / b.rw;
        o.geom.y = (rect.top - b.rt) / b.rh;
        settle(o);
    }

    /** With focus: arrows move it (Shift: further), + and − size it, M mutes, T tucks, F floats, Home puts it back. */
    function wireKeys(o) {
        o.el.addEventListener('keydown', (e) => {
            if (e.target !== o.el || e.altKey || e.ctrlKey || e.metaKey) return;
            const step = e.shiftKey ? 0.1 : 0.02;
            const k = e.key;
            let moved = true;
            if (k === 'ArrowLeft') o.geom.x -= step;
            else if (k === 'ArrowRight') o.geom.x += step;
            else if (k === 'ArrowUp') o.geom.y -= step;
            else if (k === 'ArrowDown') o.geom.y += step;
            else if (k === '+' || k === '=') o.geom.w = clamp(o.geom.w + 0.03, MIN_W, MAX_W, o.geom.w);
            else if (k === '-' || k === '_') o.geom.w = clamp(o.geom.w - 0.03, MIN_W, MAX_W, o.geom.w);
            else if (k === 'Home') { act(o, 'reset'); e.preventDefault(); return; }
            else if (k === 'm' || k === 'M') { act(o, 'mute'); moved = false; }
            else if (k === 't' || k === 'T' || k === 'h' || k === 'H') { act(o, o.geom.tuck ? 'untuck' : 'tuck'); moved = false; }
            else if (k === 'f' || k === 'F') { act(o, 'float'); moved = false; }
            else return;
            e.preventDefault();
            if (!moved) return;
            const b = boxOf(o);
            o.geom.tuck = null;
            o.geom.x = Math.min(Math.max(0, o.geom.x), Math.max(0, 1 - b.wf));
            o.geom.y = Math.min(Math.max(0, o.geom.y), Math.max(0, 1 - b.hf));
            saveGeom(o); applyGeom(o);
        });
    }

    /**
     * The move: the PIP rises over the page as soon as the press moves, follows the pointer with a transform each frame
     * (nothing is laid out while it moves), and lands with a spring where it is dropped: over the player it docks,
     * anywhere else it floats, past a side it tucks. A flick carries on. Two fingers pinch it; a tap shows its bar for a
     * moment on a touch screen; a double tap toggles small and large.
     */
    function wireMove(o) {
        const el = o.el;
        const pts = new Map();   // pointerId → { x, y }
        let drag = null, pinch = null, raf = 0, lastTap = 0, barTimer = 0;
        const gap = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
        const paint = () => {
            raf = 0;
            if (!drag || !drag.lifted) return;
            el.style.transform = `translate3d(${drag.dx}px, ${drag.dy}px, 0)`;
            const c = drag.r;
            const cx = c.left + drag.dx + c.width / 2, cy = c.top + drag.dy + c.height / 2;
            const p = o.container.getBoundingClientRect();
            o.container.classList.toggle('ov-pip-dock-hint', cx >= p.left && cx <= p.right && cy >= p.top && cy <= p.bottom);
        };
        const lift = () => {
            drag.lifted = true;
            // Over the page from the first move, at the same place on screen, so it can go anywhere.
            const r = drag.r;
            const layer = document.fullscreenElement || document.body;
            if (el.parentNode !== layer) layer.appendChild(el);
            el.classList.add('is-dragging', 'is-lifted');
            el.style.transition = 'none';
            el.style.left = `${r.left}px`; el.style.top = `${r.top}px`; el.style.width = `${r.width}px`;
            const v = el.querySelector('.ov-pip-video');
            if (v && v.paused) v.play().catch(() => {});
        };
        const showBar = () => {
            el.classList.add('is-active');
            clearTimeout(barTimer);
            barTimer = setTimeout(() => el.classList.remove('is-active'), 3200);
        };
        const onDown = (e) => {
            if (e.button > 0) return;
            if (e.target.closest('[data-act]') || e.target.closest('.ov-pip-resize') || e.target.closest('a')) return;
            pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
            try { el.setPointerCapture(e.pointerId); } catch { /* */ }
            e.preventDefault();
            if (pts.size === 2) {
                if (drag && drag.lifted) { el.style.transform = ''; }
                drag = null;
                pinch = { d: gap(), w: o.geom.w };
                el.classList.add('is-resizing');
                return;
            }
            if (pts.size > 2) return;
            drag = { sx: e.clientX, sy: e.clientY, dx: 0, dy: 0, r: el.getBoundingClientRect(), lifted: false, hist: [{ x: e.clientX, y: e.clientY, t: performance.now() }] };
        };
        const onMove = (e) => {
            if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pinch && pts.size === 2) {
                o.geom.w = clamp(pinch.w * (gap() / pinch.d), MIN_W, MAX_W, pinch.w);
                applyGeom(o);
                return;
            }
            if (!drag) return;
            const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
            if (!drag.lifted && Math.hypot(dx, dy) < DRAG_PX) return;
            if (!drag.lifted) lift();
            // Anywhere on screen; most of it may go past a side (that is how it tucks), never past the top or bottom.
            const r = drag.r, vw = window.innerWidth, vh = window.innerHeight;
            drag.dx = Math.min(Math.max(dx, -r.left - r.width + TAB_PX), vw - r.left - TAB_PX);
            drag.dy = Math.min(Math.max(dy, -r.top), vh - r.top - r.height);
            const now = performance.now();
            drag.hist.push({ x: e.clientX, y: e.clientY, t: now });
            while (drag.hist.length > 2 && now - drag.hist[0].t > 90) drag.hist.shift();
            if (!raf) raf = requestAnimationFrame(paint);
        };
        const onUp = (e) => {
            pts.delete(e.pointerId);
            try { el.releasePointerCapture(e.pointerId); } catch { /* */ }
            if (pinch) {
                if (pts.size < 2) { pinch = null; el.classList.remove('is-resizing'); settle(o); applyGeom(o); saveGeom(o); }
                return;
            }
            if (!drag) return;
            const d = drag; drag = null;
            if (raf) { cancelAnimationFrame(raf); raf = 0; }
            o.container.classList.remove('ov-pip-dock-hint');
            if (!d.lifted) {
                // A tap: the bar for a moment (a touch screen has no hover); a second within 300 ms toggles the size.
                const now = performance.now();
                if (e.type === 'pointerup' && now - lastTap < 300) { lastTap = 0; toggleSize(o); }
                else { lastTap = now; if (e.pointerType !== 'mouse') showBar(); }
                if (o.geom.tuck && e.type === 'pointerup') act(o, 'untuck');
                return;
            }
            el.classList.remove('is-dragging', 'is-lifted');
            // Where it was let go, and where a flick carries it (the last 90 ms, 120 ms on).
            const h = d.hist, a = h[0], z = h[h.length - 1], dt = Math.max(16, z.t - a.t);
            const vx = (z.x - a.x) / dt, vy = (z.y - a.y) / dt;
            const fast = Math.hypot(vx, vy) > 0.6;
            const from = { left: d.r.left + d.dx, top: d.r.top + d.dy, width: d.r.width, height: d.r.height };
            const vwid = window.innerWidth, vhei = window.innerHeight;
            let left = from.left + (fast ? vx * 120 : 0), top = from.top + (fast ? vy * 120 : 0);
            top = Math.min(Math.max(0, top), vhei - from.height);
            const p = o.container.getBoundingClientRect();
            const cx = left + from.width / 2, cy = top + from.height / 2;
            const fs = inFullscreen(o);
            const overPlayer = fs || (cx >= p.left && cx <= p.right && cy >= p.top && cy <= p.bottom);
            const frame = overPlayer ? p : { left: 0, top: 0, right: vwid, bottom: vhei, width: vwid, height: vhei };
            // Past a side of its frame by more than a third of itself (or thrown at it): tucked into that side.
            const out = from.width / 3;
            let tuck = null;
            if (left < frame.left - out || (fast && vx < -1.2 && left < frame.left + EDGE_PX)) tuck = 'left';
            else if (left + from.width > frame.right + out || (fast && vx > 1.2 && left + from.width > frame.right - EDGE_PX)) tuck = 'right';
            el.style.transform = '';
            el.style.left = ''; el.style.top = ''; el.style.width = '';
            toMode(o, overPlayer ? 'dock' : 'float', { left: Math.min(Math.max(frame.left, left), frame.right - from.width), top, width: from.width, height: from.height });
            o.geom.tuck = tuck;
            saveGeom(o);
            land(o, from);
        };
        el.addEventListener('pointerdown', onDown);
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp);
        el.addEventListener('pointercancel', onUp);
    }

    function toggleSize(o) {
        const from = o.el.getBoundingClientRect();
        o.geom.w = o.geom.w < BIG_W - 0.01 ? BIG_W : clamp((o.pip.defaults || {}).w, MIN_W, MAX_W, 0.25);
        o.geom.tuck = null;
        settle(o); saveGeom(o); land(o, from);
    }

    function wireResize(o) {
        const el = o.el;
        const handle = el.querySelector('.ov-pip-resize');
        let start = null;
        handle.addEventListener('pointerdown', (e) => {
            const b = boxOf(o);
            start = { px: e.clientX, py: e.clientY, w: o.geom.w, rw: b.rw };
            el.classList.add('is-resizing');
            try { handle.setPointerCapture(e.pointerId); } catch { /* */ }
            e.preventDefault(); e.stopPropagation();
        });
        handle.addEventListener('pointermove', (e) => {
            if (!start || !start.rw) return;
            // The handle's diagonal pull is the box's own width; `w` is the 16:9 width of the same area.
            const k = Math.sqrt((o.aspect || BASE) / BASE) || 1;
            const pull = ((e.clientX - start.px) + (e.clientY - start.py) * (o.aspect || BASE)) / 2;
            o.geom.w = clamp(start.w + pull / start.rw / k, MIN_W, MAX_W, start.w);
            const b = boxOf(o);
            o.geom.x = Math.min(o.geom.x, Math.max(0, 1 - b.wf));
            o.geom.y = Math.min(o.geom.y, Math.max(0, 1 - b.hf));
            applyGeom(o);
        });
        const end = (e) => {
            if (!start) return;
            start = null;
            el.classList.remove('is-resizing');
            try { handle.releasePointerCapture(e.pointerId); } catch { /* */ }
            settle(o); applyGeom(o); saveGeom(o);
        };
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
    }

    /* ── viewer sessions ──────────────────────────────────────── */

    function waitFor(ws, type, timeoutMs = 15000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { ws.removeEventListener('message', on); reject(new Error(`pip: timeout ${type}`)); }, timeoutMs);
            function on(ev) {
                let m; try { m = JSON.parse(ev.data); } catch { return; }
                if (m.type === type) { clearTimeout(timer); ws.removeEventListener('message', on); resolve(m); }
                else if (m.type === 'sfu-error' || m.type === 'sfu-viewer-error' || m.type === 'sfu-source-unavailable') {
                    clearTimeout(timer); ws.removeEventListener('message', on); reject(new Error(m.error || 'pip: source unavailable'));
                }
            }
            ws.addEventListener('message', on);
        });
    }

    const alive = (o, session) => host && host.overlays.get(o.pip.source_msid) === o && o.gen === host.gen && !o.closed && (session == null || session === o.session);

    /** A WebRTC source: a viewer of its mediasoup room, like the main player. */
    async function connectWebrtc(o, videoEl, session) {
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(`${proto}://${window.location.host}/ws/broadcast?streamId=${o.pip.stream_id}&role=viewer`);
        o.ws = ws;
        await new Promise((res, rej) => {
            ws.addEventListener('open', res, { once: true });
            ws.addEventListener('error', () => rej(new Error('pip: websocket failed')), { once: true });
        });
        if (!alive(o, session)) return;
        ws.addEventListener('close', () => { if (alive(o, session)) dropped(o); });
        ws.send(JSON.stringify({ type: 'watch' }));
        const ready = await waitFor(ws, 'sfu-viewer-ready', 20000);
        if (!alive(o, session)) return;

        const mod = await (window.loadMediasoupClient ? window.loadMediasoupClient() : Promise.reject(new Error('pip: mediasoup-client unavailable')));
        const Device = mod.Device || mod.default?.Device;
        const device = new Device();
        await device.load({ routerRtpCapabilities: ready.rtpCapabilities });
        if (!alive(o, session)) return;

        ws.send(JSON.stringify({ type: 'sfu-viewer-create-transport' }));
        const tp = await waitFor(ws, 'sfu-viewer-transport-created');
        if (!alive(o, session)) return;
        const iceServers = (typeof sanitizeIceServers === 'function' ? sanitizeIceServers(tp.iceServers) : tp.iceServers) || [];
        const transport = device.createRecvTransport({
            id: tp.id, iceParameters: tp.iceParameters, iceCandidates: tp.iceCandidates, dtlsParameters: tp.dtlsParameters,
            iceServers: iceServers.length ? iceServers : [{ urls: 'stun:stun.l.google.com:19302' }],
        });
        o.transport = transport;
        transport.on('connect', ({ dtlsParameters }, cb, errb) => {
            ws.send(JSON.stringify({ type: 'sfu-viewer-connect-transport', transportId: transport.id, dtlsParameters }));
            waitFor(ws, 'sfu-viewer-transport-connected').then(() => cb()).catch(errb);
        });
        transport.on('connectionstatechange', (st) => { if ((st === 'failed' || st === 'closed') && alive(o, session)) dropped(o); });

        const media = new MediaStream();
        for (const prod of (ready.producers || [])) {
            ws.send(JSON.stringify({ type: 'sfu-viewer-consume', transportId: transport.id, producerId: prod.id, rtpCapabilities: device.rtpCapabilities }));
            const cp = await waitFor(ws, 'sfu-viewer-consumed');
            if (!alive(o, session)) return;
            const consumer = await transport.consume({ id: cp.id, producerId: cp.producerId, kind: cp.kind, rtpParameters: cp.rtpParameters });
            o.consumers.push(consumer);
            consumer.track.addEventListener('ended', () => { if (alive(o, session)) setState(o, 'waiting'); });
            media.addTrack(consumer.track);
            ws.send(JSON.stringify({ type: 'sfu-viewer-resume', consumerId: cp.id }));
        }
        videoEl.srcObject = media;
    }

    /** An RTMP source: its FLV through Live's proxy (flv.js, loaded by the main player when it needed it). */
    async function connectFlv(o, videoEl, session) {
        if (typeof flvjs === 'undefined' || !flvjs.isSupported()) throw new Error('pip: flv.js unavailable');
        const player = flvjs.createPlayer({ type: 'flv', isLive: true, url: `/api/streams/rtmp-proxy/${o.pip.stream_id}.flv` },
            { enableStashBuffer: false, liveBufferLatencyChasing: true });
        o.flv = player;
        player.attachMediaElement(videoEl);
        player.on(flvjs.Events.ERROR, () => { if (alive(o, session)) dropped(o); });
        player.load();
    }

    /** End this PIP's viewer session, keeping its element and its last picture. */
    function teardown(o) {
        o.session = (o.session || 0) + 1;
        try { o.consumers.forEach((c) => { try { c.close(); } catch { /* */ } }); } catch { /* */ }
        o.consumers = [];
        try { o.transport?.close(); } catch { /* */ }
        o.transport = null;
        try { o.ws?.close(); } catch { /* */ }
        o.ws = null;
        try { o.flv?.destroy(); } catch { /* */ }
        o.flv = null;
    }

    async function connect(o) {
        const videoEl = o.el.querySelector('.ov-pip-video');
        teardown(o);
        const session = o.session;
        o.started = performance.now();
        if (o.state !== 'offline') setState(o, 'connecting');
        try {
            if (o.pip.protocol === 'rtmp') await connectFlv(o, videoEl, session);
            else await connectWebrtc(o, videoEl, session);
            if (!alive(o, session)) return;
            videoEl.muted = o.geom.muted;
            videoEl.play().catch(() => {});
            o.tries = 0;
            // Live once a frame arrives (watchFrames); until then it says it is waiting for the picture.
            if (o.state !== 'live') setState(o, 'waiting');
        } catch (err) {
            console.warn(`[PiP] ${o.pip.title || o.pip.source_msid} unavailable:`, err.message);
            if (alive(o, session)) dropped(o);
        }
    }

    /** The connection went: say so over the last picture and try again on a backoff while it is still listed. */
    function dropped(o) {
        if (o.closed) return;
        setState(o, 'offline');
        if (o.retryTimer) return;
        const delay = BACKOFF[Math.min(o.tries || 0, BACKOFF.length - 1)];
        o.tries = (o.tries || 0) + 1;
        o.retryTimer = setTimeout(() => { o.retryTimer = 0; if (alive(o) && !document.hidden) connect(o); else if (alive(o)) o.retryLater = true; }, delay);
    }

    /** Frames: live while they come; the wait after STALL_MS without one; a new connection after RETRY_MS. */
    function watchFrames(o) {
        const v = o.el.querySelector('.ov-pip-video');
        o.lastFrame = 0;
        const seen = () => { o.lastFrame = performance.now(); if (o.state !== 'live') setState(o, 'live'); };
        if (v && typeof v.requestVideoFrameCallback === 'function') {
            const cb = () => { if (o.closed) return; seen(); v.requestVideoFrameCallback(cb); };
            v.requestVideoFrameCallback(cb);
        } else if (v) v.addEventListener('timeupdate', seen);
        o.watch = setInterval(() => {
            if (o.closed) { clearInterval(o.watch); return; }
            if (document.hidden) return;
            if (o.retryLater) { o.retryLater = false; connect(o); return; }
            const idle = performance.now() - Math.max(o.lastFrame || 0, o.started || 0);
            if (o.state === 'live' && idle > STALL_MS) setState(o, 'waiting');
            else if (o.state === 'waiting' && idle > RETRY_MS && !o.retryTimer) connect(o);
        }, 1000);
    }

    function close(o, animate) {
        o.closed = true;
        clearInterval(o.watch);
        clearTimeout(o.retryTimer);
        clearTimeout(o.landTimer);
        teardown(o);
        const el = o.el;
        if (!el) return;
        if (animate && !reduced()) { el.classList.add('is-leaving'); setTimeout(() => { try { el.remove(); } catch { /* */ } }, 260); }
        else { try { el.remove(); } catch { /* */ } }
    }

    /* ── the list ─────────────────────────────────────────────── */

    /** Draw the live PIPs of `pips` and drop the rest; a PIP whose source restarted (a new stream) reconnects in place. */
    function sync(pips) {
        if (!host) return;
        const live = (Array.isArray(pips) ? pips : []).filter((p) => p && p.live && p.stream_id && p.source_msid);
        const keep = new Set(live.map((p) => p.source_msid));
        for (const [key, o] of host.overlays) {
            if (!keep.has(key)) { close(o, true); host.overlays.delete(key); }
        }
        live.forEach((pip) => {
            const cur = host.overlays.get(pip.source_msid);
            if (cur) {
                if (cur.pip.stream_id !== pip.stream_id) { cur.pip = pip; cur.tries = 0; connect(cur); }
                else if (cur.state === 'offline' && !cur.retryTimer) connect(cur);
                return;
            }
            const o = { pip, slot: host.slot, hostId: host.streamId, gen: host.gen, geom: loadGeom(host.slot, host.streamId, pip), consumers: [], el: null, started: performance.now() };
            host.overlays.set(pip.source_msid, o);
            build(o, host.container);
            watchFrames(o);
            connect(o);
        });
    }

    async function poll() {
        if (!host || document.hidden) return;
        const myGen = host.gen;
        try {
            const r = await fetch(`/api/streams/${encodeURIComponent(host.streamId)}/pips`, { credentials: 'same-origin' });
            if (!r.ok) return;
            const d = await r.json();
            if (host && host.gen === myGen) sync(d.pips);
        } catch { /* the next poll tries again */ }
    }

    function relayout() {
        if (!host) return;
        for (const o of host.overlays.values()) if (o.el && !o.el.classList.contains('is-lifted')) { placeIn(o); applyGeom(o); }
    }

    /* ── public API ───────────────────────────────────────────── */

    /**
     * Draw the PIPs of a stream (`pip_overlays`, or the N-1 `pip_overlay`). Safe to call on every player init; it tears
     * down any previous ones first. The account's places are read first (one request, kept for the visit).
     */
    async function attach(stream) {
        detach();
        const container = document.getElementById('video-container');
        if (!container || !stream || !stream.id) return;
        const pips = Array.isArray(stream.pip_overlays) ? stream.pip_overlays
            : (stream.pip_overlay ? [Object.assign({ source_msid: stream.pip_overlay.source_msid || 0 }, stream.pip_overlay)] : []);
        if (!pips.length) return;   // a slot with no PIPs never polls
        const h = { streamId: stream.id, slot: stream.managed_stream_id || stream.id, container, overlays: new Map(), gen: ++gen, timer: null, ro: null };
        host = h;
        await Promise.race([account.load(), new Promise((r) => setTimeout(r, 900))]);
        if (host !== h) return;
        sync(pips);
        h.timer = setInterval(poll, POLL_MS);
        // The player changes size (a window, theatre mode, fullscreen, a phone turned): the cap on height follows, and
        // a floating PIP keeps its place in the window.
        if (typeof ResizeObserver === 'function') {
            h.ro = new ResizeObserver(() => { if (host === h) relayout(); });
            h.ro.observe(container);
        }
        h.onWin = () => { if (host === h) relayout(); };
        window.addEventListener('resize', h.onWin);
        document.addEventListener('fullscreenchange', h.onWin);
        h.onVis = () => { if (host === h && !document.hidden) for (const o of h.overlays.values()) if (o.retryLater) { o.retryLater = false; connect(o); } };
        document.addEventListener('visibilitychange', h.onVis);
    }

    function detach() {
        gen++;
        if (!host) return;
        clearInterval(host.timer);
        try { host.ro?.disconnect(); } catch { /* */ }
        window.removeEventListener('resize', host.onWin);
        document.removeEventListener('fullscreenchange', host.onWin);
        document.removeEventListener('visibilitychange', host.onVis);
        for (const o of host.overlays.values()) close(o, false);
        try { host.container.classList.remove('ov-pip-dock-hint'); } catch { /* */ }
        host = null;
    }

    /** Where every PIP of this stream is, for the page and for tools (the same shape the account keeps). */
    function layout() {
        if (!host) return [];
        return [...host.overlays.values()].map((o) => ({ slot: o.slot, source: o.pip.source_msid, title: o.pip.title || null, state: o.state, geom: { ...o.geom } }));
    }

    window.streamPip = { attach, detach, layout, act: (source, what) => { const o = host && host.overlays.get(Number(source)); if (o) act(o, what); }, _test: { boxOf, settle, applyGeom, loadGeom, BASE, MAX_H } };
})();
