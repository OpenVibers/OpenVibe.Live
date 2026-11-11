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

   Anywhere (owner, 2026-11-11: "move it anywhere … on top of shit … more solid feeling and more responsive"): the move,
   tuck, size, keys and kept place are openvibe-shared/ov-float.js now (it is the same code, lifted). This file keeps
   the viewer sessions, the waits and the actions. The behaviour:
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
    const BIG_W = 0.5;            // a double tap's large size
    const MIN_PX = 150;           // the smallest 16:9 width on a phone-sized frame
    const TAB_PX = 30;            // what stays on screen of a tucked PIP
    const STALL_MS = 4000;        // no new frame for this long: show the wait
    const RETRY_MS = 15000;       // still nothing: connect again
    const BACKOFF = [2000, 4000, 8000, 15000, 30000];

    let host = null;   // { streamId, slot, container, overlays: Map(source_msid → overlay), timer, gen }
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

    /** The account plug the engine saves through; the key is Live's `<slot>:<source>`, not the browser key. */
    const pipStore = { load: () => account.load(), get: (key) => account.get(key), put: (key, value) => account.put(key, value) };

    /* ── geometry (the shared engine's; these adapters keep the shape test) ─────────────────────────────── */

    const engine = () => window.OVFloat;

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
        if (!raw || typeof raw !== 'object') return Object.assign({}, fallback);
        return {
            x: clamp(raw.x, 0, 1, fallback.x), y: clamp(raw.y, 0, 1, fallback.y), w: clamp(raw.w, MIN_W, MAX_W, fallback.w),
            mode: raw.mode === 'float' ? 'float' : 'dock',
            tuck: raw.tuck === 'left' || raw.tuck === 'right' ? raw.tuck : (raw.hidden ? 'right' : null),
            muted: typeof raw.muted === 'boolean' ? raw.muted : fallback.muted,
            at: Number(raw.at) || 0,
        };
    }

    /** The place this session had before 2026-11-11, if the per-slot one does not exist yet. */
    function legacyGeom(streamId, pip) {
        try { return JSON.parse(localStorage.getItem(LS_V1(streamId, pip.source_msid)) || 'null'); } catch { return null; }
    }

    /** This browser's copy, the streamer's place and the account are the engine's; Live keeps its own events and slots. */
    function saveGeom(o) {
        o.geom.at = Date.now();
        try { localStorage.setItem(LS_KEY(o.slot, o.pip.source_msid), JSON.stringify(o.geom)); } catch { /* */ }
        account.put(`${o.slot}:${o.pip.source_msid}`, o.geom);
        try { window.dispatchEvent(new CustomEvent('ov:pip', { detail: { slot: o.slot, source: o.pip.source_msid, geom: { ...o.geom } } })); } catch { /* */ }
    }

    /** The source's shape, from the video itself: on its first frame and whenever it changes (a phone turned). */
    function watchShape(o, videoEl) {
        const read = () => {
            const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
            if (!vw || !vh) return;
            const a = vw / vh;
            if (o.aspect && Math.abs(o.aspect - a) < 0.01) return;
            o.aspect = a;
            if (o.float) o.float.setAspect(a);
        };
        videoEl.addEventListener('loadedmetadata', read);
        videoEl.addEventListener('resize', read);
    }

    const _test = {
        boxOf(o) {
            return engine()._test.boxOf(o.geom, o.container.getBoundingClientRect(), { aspect: o.aspect || BASE, minPx: MIN_PX });
        },
        settle(o) { return engine()._test.settle(o.geom, _test.boxOf(o)); },
        applyGeom(o) { engine()._test.paint(o.el, o.geom, _test.boxOf(o), { floating: false }); },
        BASE, MAX_H,
    };

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
            <button type="button" class="ov-pip-tab" data-act="untuck" data-ov-float-tab title="Bring ${escapeHtml(label)} back" aria-label="Bring ${escapeHtml(label)} back"><span class="ov-pip-tab-l"><i class="fa-solid fa-chevron-left"></i></span><span class="ov-pip-tab-r"><i class="fa-solid fa-chevron-right"></i></span></button>
            <div class="ov-pip-resize" data-ov-float-resize title="Drag to resize" aria-hidden="true"></div>`;
        o.el = el;
        o.container = container;
        el.tabIndex = 0;
        el.setAttribute('role', 'group');
        el.setAttribute('aria-label', `${label}, picture-in-picture. Drag it anywhere; arrow keys move it, plus and minus size it, M mutes it, T tucks it aside, F pops it out of the player.`);
        muteButton(el.querySelector('[data-act="mute"]'), o.geom && typeof o.geom.muted === 'boolean' ? o.geom.muted : defaultsOf(o.pip).muted, label);
        watchShape(o, el.querySelector('.ov-pip-video'));
        setState(o, 'connecting');

        el.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-act]');
            if (!btn || !el.contains(btn)) return;
            e.stopPropagation();
            act(o, btn.dataset.act);
        });

        const OVFloat = window.OVFloat;
        if (OVFloat && typeof OVFloat.attach === 'function') {
            const legacy = shapeGeom(legacyGeom(o.hostId, o.pip), defaultsOf(o.pip));
            o.float = OVFloat.attach(el, {
                frame: container,
                key: LS_KEY(o.slot, o.pip.source_msid),
                accountKey: `${o.slot}:${o.pip.source_msid}`,
                store: pipStore,
                defaults: legacy,
                aspect: o.aspect || BASE,
                minPx: MIN_PX,
                bigW: BIG_W,
                tabPx: TAB_PX,
                tab: false,
                resize: false,
                hintClass: 'ov-pip-dock-hint',
                ignore: '[data-act], .ov-pip-resize, [data-ov-float-resize], a',
                onChange(geom) { o.geom = geom; saveGeom(o); },
            });
            o.geom = o.float.geom();
            muteButton(el.querySelector('[data-act="mute"]'), o.geom.muted, label);
            const v = el.querySelector('.ov-pip-video');
            v.muted = o.geom.muted;
        } else {
            // The player feature loads /shared/ov-float.js before this file; a page that did not gets the picture but
            // not the move rather than a broken player.
            console.warn('[PiP] openvibe-shared/ov-float.js is not loaded');
            o.geom = o.geom || defaultsOf(o.pip);
            container.appendChild(el);
        }
        wireMuteKey(o);
        wireResize(o);
        setTimeout(() => el.classList.remove('is-entering'), 420);
    }

    /** The corner grip: the shared engine owns pinch and the keys; this is the same sizing on the PIP's own handle. */
    function wireResize(o) {
        const el = o.el;
        const handle = el.querySelector('.ov-pip-resize');
        let start = null;
        handle.addEventListener('pointerdown', (e) => {
            if (e.button > 0) return;
            const b = o.float.metrics();
            start = { px: e.clientX, py: e.clientY, w: o.float.geom().w, rw: b.rw };
            el.classList.add('is-resizing');
            try { handle.setPointerCapture(e.pointerId); } catch { /* */ }
            e.preventDefault();
            e.stopPropagation();
        });
        handle.addEventListener('pointermove', (e) => {
            if (!start || !start.rw) return;
            // The handle's diagonal pull is the box's own width; `w` is the 16:9 width of the same area.
            const k = Math.sqrt((o.aspect || BASE) / BASE) || 1;
            const pull = ((e.clientX - start.px) + (e.clientY - start.py) * (o.aspect || BASE)) / 2;
            o.float.set({ w: clamp(start.w + pull / start.rw / k, MIN_W, MAX_W, start.w) });
        });
        const end = (e) => {
            if (!start) return;
            start = null;
            el.classList.remove('is-resizing');
            try { handle.releasePointerCapture(e.pointerId); } catch { /* */ }
            o.float.settle();
            o.float.save();
        };
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
    }

    /** With focus, M mutes; the engine owns the arrows, + and −, T, F and Home. */
    function wireMuteKey(o) {
        o.el.addEventListener('keydown', (e) => {
            if (e.target !== o.el || e.altKey || e.ctrlKey || e.metaKey) return;
            if (e.key !== 'm' && e.key !== 'M') return;
            e.preventDefault();
            act(o, 'mute');
        });
    }

    function act(o, what) {
        if (!o.float) return;
        if (what === 'tuck') o.float.tuck();
        else if (what === 'untuck') o.float.untuck();
        else if (what === 'reset') o.float.reset();
        else if (what === 'float') { o.float.toggleMode(); }
        else if (what === 'mute') {
            const geom = o.float.geom();
            const muted = !geom.muted;
            const v = o.el.querySelector('.ov-pip-video');
            v.muted = muted;
            if (!muted) v.play().catch(() => {});
            muteButton(o.el.querySelector('[data-act="mute"]'), muted, o.pip.title || 'Picture-in-picture');
            o.float.set({ muted }, { save: true });
            o.geom = o.float.geom();
        }
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
        if (o.float) { try { o.float.destroy(); } catch { /* */ } o.float = null; }
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
            const o = { pip, slot: host.slot, hostId: host.streamId, gen: host.gen, geom: null, aspect: BASE, consumers: [], el: null, started: performance.now() };
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
        const h = { streamId: stream.id, slot: stream.managed_stream_id || stream.id, container, overlays: new Map(), gen: ++gen, timer: null };
        host = h;
        await Promise.race([account.load(), new Promise((r) => setTimeout(r, 900))]);
        if (host !== h) return;
        sync(pips);
        h.timer = setInterval(poll, POLL_MS);
        h.onVis = () => { if (host === h && !document.hidden) for (const o of h.overlays.values()) if (o.retryLater) { o.retryLater = false; connect(o); } };
        document.addEventListener('visibilitychange', h.onVis);
    }

    function detach() {
        gen++;
        if (!host) return;
        clearInterval(host.timer);
        document.removeEventListener('visibilitychange', host.onVis);
        for (const o of host.overlays.values()) close(o, false);
        try { host.container.classList.remove('ov-pip-dock-hint'); } catch { /* */ }
        host = null;
    }

    /** Where every PIP of this stream is, for the page and for tools (the same shape the account keeps). */
    function layout() {
        if (!host) return [];
        return [...host.overlays.values()].map((o) => ({ slot: o.slot, source: o.pip.source_msid, title: o.pip.title || null, state: o.state, geom: o.float ? o.float.geom() : { ...o.geom } }));
    }

    window.streamPip = { attach, detach, layout, act: (source, what) => { const o = host && host.overlays.get(Number(source)); if (o) act(o, what); }, _test };
})();
