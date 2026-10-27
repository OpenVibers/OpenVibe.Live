/* ───────────────────────────────────────────────────────────────
   stream-pip.js — the streams drawn over a live stream (picture-in-picture).

   A slot lists up to three other slots (stream_pips, migration 0021): the streamer's own (their camera while the main
   stream is a screen share) or anyone's on the site. Each is an ordinary stream in its own right, with its own VOD,
   clips, transcript and restreams, so each PIP here is a second, self-contained viewer session: its own websocket,
   mediasoup recv transport and consumers (an RTMP source plays its FLV through the same proxy as the main player). It
   deliberately does not reuse stream-player.js's machinery, which is written around module-level singletons.

   The server sends every PIP with the stream (`pip_overlays`: source slot, its live stream or null, the streamer's
   default place and sound). Only live ones are drawn; every 30 s the list is asked for again
   (GET /api/streams/:id/pips), so one that goes live appears and one that ends goes. Geometry is kept as FRACTIONS
   of the player box, remembered per stream and per PIP, so a viewer who drags one out of the way finds it there next
   time. A PIP that cannot play reads as "offline" and never stops the stream underneath.
   ─────────────────────────────────────────────────────────────── */

(function () {
    'use strict';

    const LS_KEY = (streamId, sourceMsid) => `ov-pip-geom-${streamId}-${sourceMsid}`;
    const LS_OLD = (streamId) => `ov-pip-geom-${streamId}`;   // the single PIP before 0021: the first PIP still reads it
    const MIN_W = 0.08, MAX_W = 0.60;
    const POLL_MS = 30000;

    let host = null;   // { streamId, container, overlays: Map(source_msid → overlay), timer, gen }
    let gen = 0;

    /* ── geometry ─────────────────────────────────────────────── */

    function clamp(v, lo, hi, dflt) {
        const n = Number(v);
        if (!Number.isFinite(n)) return dflt;
        return Math.min(hi, Math.max(lo, n));
    }

    function loadGeom(streamId, pip, first) {
        const d = pip.defaults || {};
        const fallback = {
            x: clamp(d.x, 0, 1, 0.72), y: clamp(d.y, 0, 1, 0.70), w: clamp(d.w, MIN_W, MAX_W, 0.25),
            // The streamer's choice; by default muted: the stream underneath already carries the voice, and two live
            // audio tracks would double every word.
            hidden: false, muted: pip.muted !== false,
        };
        try {
            let raw = JSON.parse(localStorage.getItem(LS_KEY(streamId, pip.source_msid)) || 'null');
            if (!raw && first) raw = JSON.parse(localStorage.getItem(LS_OLD(streamId)) || 'null');
            if (!raw) return fallback;
            return {
                x: clamp(raw.x, 0, 1, fallback.x), y: clamp(raw.y, 0, 1, fallback.y), w: clamp(raw.w, MIN_W, MAX_W, fallback.w),
                hidden: !!raw.hidden, muted: typeof raw.muted === 'boolean' ? raw.muted : fallback.muted,
            };
        } catch { return fallback; }
    }

    function saveGeom(o) {
        try { localStorage.setItem(LS_KEY(o.hostId, o.pip.source_msid), JSON.stringify(o.geom)); } catch { /* */ }
    }

    function applyGeom(o) {
        const { x, y, w, hidden } = o.geom;
        o.el.style.left = `${x * 100}%`;
        o.el.style.top = `${y * 100}%`;
        o.el.style.width = `${w * 100}%`;
        o.el.classList.toggle('is-hidden', !!hidden);
    }

    /* ── DOM ──────────────────────────────────────────────────── */

    function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function muteButton(btn, muted, label) {
        btn.title = muted ? `Turn on ${label}'s sound` : `Mute ${label}`;
        btn.setAttribute('aria-label', btn.title);
        btn.innerHTML = `<i class="fa-solid ${muted ? 'fa-volume-xmark' : 'fa-volume-high'}"></i>`;
    }

    function build(o, container) {
        const label = o.pip.title || 'Picture-in-picture';
        const href = o.pip.username ? `/@${encodeURIComponent(o.pip.username)}${o.pip.slug ? `/${encodeURIComponent(o.pip.slug)}` : ''}` : null;
        const el = document.createElement('div');
        el.className = 'ov-pip';
        el.dataset.pipSource = String(o.pip.source_msid);
        el.innerHTML = `
            <video class="ov-pip-video" autoplay playsinline muted></video>
            <div class="ov-pip-bar">
                <span class="ov-pip-title" title="${escapeHtml(label)}"><i class="fa-solid fa-video"></i> ${href
                    ? `<a href="${escapeHtml(href)}" onclick="return handleLinkClick(event, '${escapeHtml(href)}')">${escapeHtml(label)}</a>` : escapeHtml(label)}</span>
                <span class="ov-pip-actions">
                    <button type="button" data-act="mute"></button>
                    <button type="button" data-act="reset" title="Back to where the streamer put it" aria-label="Back to where the streamer put it"><i class="fa-solid fa-arrows-to-dot"></i></button>
                    <button type="button" data-act="hide" title="Hide ${escapeHtml(label)}" aria-label="Hide ${escapeHtml(label)}"><i class="fa-solid fa-eye-slash"></i></button>
                </span>
            </div>
            <div class="ov-pip-resize" title="Drag to resize"></div>
            <div class="ov-pip-offline"><i class="fa-solid fa-video-slash"></i><span>${escapeHtml(label)} is offline</span></div>`;
        container.appendChild(el);
        o.el = el;
        muteButton(el.querySelector('[data-act="mute"]'), o.geom.muted, label);

        el.querySelector('.ov-pip-actions').addEventListener('click', (e) => {
            const act = e.target.closest('[data-act]')?.dataset.act;
            if (!act) return;
            e.stopPropagation();
            if (act === 'hide') { o.geom.hidden = true; saveGeom(o); applyGeom(o); showRestore(o, container); }
            else if (act === 'reset') {
                const d = o.pip.defaults || {};
                o.geom.x = clamp(d.x, 0, 1, 0.72); o.geom.y = clamp(d.y, 0, 1, 0.70); o.geom.w = clamp(d.w, MIN_W, MAX_W, 0.25);
                saveGeom(o); applyGeom(o);
            } else if (act === 'mute') {
                o.geom.muted = !o.geom.muted;
                const v = el.querySelector('.ov-pip-video');
                v.muted = o.geom.muted;
                if (!o.geom.muted) v.play().catch(() => {});
                muteButton(e.target.closest('[data-act="mute"]'), o.geom.muted, label);
                saveGeom(o);
            }
        });
        wireDrag(o, container);
        wireResize(o, container);
        applyGeom(o);
        if (o.geom.hidden) showRestore(o, container);
    }

    /** The "Show …" pill for a hidden PIP; pills of several hidden PIPs sit side by side. */
    function showRestore(o, container) {
        if (o.pill) return;
        let bar = container.querySelector('.ov-pip-restores');
        if (!bar) { bar = document.createElement('div'); bar.className = 'ov-pip-restores'; container.appendChild(bar); }
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'ov-pip-restore';
        pill.innerHTML = `<i class="fa-solid fa-video"></i> Show ${escapeHtml(o.pip.title || 'picture-in-picture')}`;
        pill.addEventListener('click', () => { o.geom.hidden = false; saveGeom(o); applyGeom(o); removeRestore(o); });
        bar.appendChild(pill);
        o.pill = pill;
    }

    function removeRestore(o) {
        if (!o.pill) return;
        const bar = o.pill.parentNode;
        o.pill.remove();
        o.pill = null;
        if (bar && !bar.children.length) bar.remove();
    }

    /** Pointer-driven move, constrained so the overlay can never be dragged off-screen. */
    function wireDrag(o, container) {
        const el = o.el;
        let start = null;
        const onDown = (e) => {
            if (e.target.closest('[data-act]') || e.target.closest('.ov-pip-resize') || e.target.closest('a')) return;
            const r = container.getBoundingClientRect();
            start = { px: e.clientX, py: e.clientY, x: o.geom.x, y: o.geom.y, rw: r.width, rh: r.height };
            el.classList.add('is-dragging');
            el.setPointerCapture?.(e.pointerId);
            e.preventDefault();
        };
        const onMove = (e) => {
            if (!start) return;
            const box = el.getBoundingClientRect();
            const r = container.getBoundingClientRect();
            o.geom.x = Math.min(Math.max(0, start.x + (e.clientX - start.px) / start.rw), Math.max(0, 1 - (box.width / r.width)));
            o.geom.y = Math.min(Math.max(0, start.y + (e.clientY - start.py) / start.rh), Math.max(0, 1 - (box.height / r.height)));
            applyGeom(o);
        };
        const onUp = (e) => {
            if (!start) return;
            start = null;
            el.classList.remove('is-dragging');
            el.releasePointerCapture?.(e.pointerId);
            saveGeom(o);
        };
        el.addEventListener('pointerdown', onDown);
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp);
        el.addEventListener('pointercancel', onUp);
    }

    function wireResize(o, container) {
        const el = o.el;
        const handle = el.querySelector('.ov-pip-resize');
        let start = null;
        handle.addEventListener('pointerdown', (e) => {
            const r = container.getBoundingClientRect();
            start = { px: e.clientX, w: o.geom.w, rw: r.width };
            el.classList.add('is-resizing');
            handle.setPointerCapture?.(e.pointerId);
            e.preventDefault(); e.stopPropagation();
        });
        handle.addEventListener('pointermove', (e) => {
            if (!start) return;
            o.geom.w = clamp(start.w + (e.clientX - start.px) / start.rw, MIN_W, MAX_W, start.w);
            // Keep it inside the player as it grows.
            const box = el.getBoundingClientRect(), r = container.getBoundingClientRect();
            o.geom.x = Math.min(o.geom.x, Math.max(0, 1 - box.width / r.width));
            o.geom.y = Math.min(o.geom.y, Math.max(0, 1 - box.height / r.height));
            applyGeom(o);
        });
        const end = (e) => {
            if (!start) return;
            start = null;
            el.classList.remove('is-resizing');
            handle.releasePointerCapture?.(e.pointerId);
            saveGeom(o);
        };
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
    }

    function markOffline(o, off) {
        if (o.el) o.el.classList.toggle('is-offline', !!off);
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

    const alive = (o) => host && host.overlays.get(o.pip.source_msid) === o && o.gen === host.gen && !o.closed;

    /** A WebRTC source: a viewer of its mediasoup room, like the main player. */
    async function connectWebrtc(o, videoEl) {
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(`${proto}://${window.location.host}/ws/broadcast?streamId=${o.pip.stream_id}&role=viewer`);
        o.ws = ws;
        await new Promise((res, rej) => {
            ws.addEventListener('open', res, { once: true });
            ws.addEventListener('error', () => rej(new Error('pip: websocket failed')), { once: true });
        });
        if (!alive(o)) return;
        ws.addEventListener('close', () => { if (alive(o)) markOffline(o, true); });
        ws.send(JSON.stringify({ type: 'watch' }));
        const ready = await waitFor(ws, 'sfu-viewer-ready', 20000);
        if (!alive(o)) return;

        const mod = await (window.loadMediasoupClient ? window.loadMediasoupClient() : Promise.reject(new Error('pip: mediasoup-client unavailable')));
        const Device = mod.Device || mod.default?.Device;
        const device = new Device();
        await device.load({ routerRtpCapabilities: ready.rtpCapabilities });
        if (!alive(o)) return;

        ws.send(JSON.stringify({ type: 'sfu-viewer-create-transport' }));
        const tp = await waitFor(ws, 'sfu-viewer-transport-created');
        if (!alive(o)) return;
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
        transport.on('connectionstatechange', (st) => { if (st === 'failed' || st === 'closed') markOffline(o, true); });

        const media = new MediaStream();
        for (const prod of (ready.producers || [])) {
            ws.send(JSON.stringify({ type: 'sfu-viewer-consume', transportId: transport.id, producerId: prod.id, rtpCapabilities: device.rtpCapabilities }));
            const cp = await waitFor(ws, 'sfu-viewer-consumed');
            if (!alive(o)) return;
            const consumer = await transport.consume({ id: cp.id, producerId: cp.producerId, kind: cp.kind, rtpParameters: cp.rtpParameters });
            o.consumers.push(consumer);
            media.addTrack(consumer.track);
            ws.send(JSON.stringify({ type: 'sfu-viewer-resume', consumerId: cp.id }));
        }
        videoEl.srcObject = media;
    }

    /** An RTMP source: its FLV through Live's proxy (flv.js, loaded by the main player when it needed it). */
    async function connectFlv(o, videoEl) {
        if (typeof flvjs === 'undefined' || !flvjs.isSupported()) throw new Error('pip: flv.js unavailable');
        const player = flvjs.createPlayer({ type: 'flv', isLive: true, url: `/api/streams/rtmp-proxy/${o.pip.stream_id}.flv` },
            { enableStashBuffer: false, liveBufferLatencyChasing: true });
        o.flv = player;
        player.attachMediaElement(videoEl);
        player.on(flvjs.Events.ERROR, () => { if (alive(o)) markOffline(o, true); });
        player.load();
    }

    async function connect(o) {
        const videoEl = o.el.querySelector('.ov-pip-video');
        try {
            if (o.pip.protocol === 'rtmp') await connectFlv(o, videoEl);
            else await connectWebrtc(o, videoEl);
            if (!alive(o)) return;
            videoEl.muted = o.geom.muted;
            videoEl.play().catch(() => {});
            markOffline(o, false);
        } catch (err) {
            console.warn(`[PiP] ${o.pip.title || o.pip.source_msid} unavailable:`, err.message);
            if (alive(o)) markOffline(o, true);
        }
    }

    function close(o) {
        o.closed = true;
        try { o.consumers.forEach((c) => { try { c.close(); } catch { /* */ } }); } catch { /* */ }
        try { o.transport?.close(); } catch { /* */ }
        try { o.ws?.close(); } catch { /* */ }
        try { o.flv?.destroy(); } catch { /* */ }
        removeRestore(o);
        try { o.el?.remove(); } catch { /* */ }
    }

    /* ── the list ─────────────────────────────────────────────── */

    /** Draw the live PIPs of `pips` and drop the rest; a PIP whose source restarted (a new stream) reconnects. */
    function sync(pips) {
        if (!host) return;
        const live = (Array.isArray(pips) ? pips : []).filter((p) => p && p.live && p.stream_id && p.source_msid);
        const keep = new Set(live.map((p) => p.source_msid));
        for (const [key, o] of host.overlays) {
            if (!keep.has(key)) { close(o); host.overlays.delete(key); }
        }
        live.forEach((pip, i) => {
            const cur = host.overlays.get(pip.source_msid);
            if (cur && cur.pip.stream_id === pip.stream_id && !cur.el.classList.contains('is-offline')) return;
            if (cur) { close(cur); host.overlays.delete(pip.source_msid); }
            const o = { pip, hostId: host.streamId, gen: host.gen, geom: loadGeom(host.streamId, pip, i === 0), consumers: [], el: null, pill: null };
            host.overlays.set(pip.source_msid, o);
            build(o, host.container);
            connect(o);
        });
    }

    async function poll() {
        if (!host) return;
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
     * down any previous ones first.
     */
    function attach(stream) {
        detach();
        const container = document.getElementById('video-container');
        if (!container || !stream || !stream.id) return;
        const pips = Array.isArray(stream.pip_overlays) ? stream.pip_overlays
            : (stream.pip_overlay ? [Object.assign({ source_msid: stream.pip_overlay.source_msid || 0 }, stream.pip_overlay)] : []);
        if (!pips.length) return;   // a slot with no PIPs never polls
        host = { streamId: stream.id, container, overlays: new Map(), gen: ++gen, timer: null };
        sync(pips);
        host.timer = setInterval(poll, POLL_MS);
    }

    function detach() {
        gen++;
        if (!host) return;
        clearInterval(host.timer);
        for (const o of host.overlays.values()) close(o);
        try { host.container.querySelector('.ov-pip-restores')?.remove(); } catch { /* */ }
        host = null;
    }

    window.streamPip = { attach, detach };
})();
