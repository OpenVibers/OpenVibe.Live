/* ───────────────────────────────────────────────────────────────
   stream-pip.js — viewer-side picture-in-picture camera overlay.

   The camera is NOT a second track inside the screen-share stream. It is an
   ordinary stream published to its own slot, which is what lets it inherit
   everything the platform already does per stream — its own VOD, its own clips,
   its own transcript, its own restreams — and what lets the viewer move and
   resize it independently of the screen share underneath.

   So this module is a second, self-contained viewer session: its own websocket,
   its own mediasoup recv transport, its own consumers. It deliberately does not
   reuse stream-player.js's machinery, because that is written around
   module-level singletons (player / playerType / streamRef) and cannot be
   instantiated twice.

   Geometry is stored as FRACTIONS of the player box so the overlay lands in the
   same relative place on any window size, and is remembered per stream so a
   viewer who drags it out of the way finds it there next time.
   ─────────────────────────────────────────────────────────────── */

(function () {
    'use strict';

    const LS_KEY = (streamId) => `ov-pip-geom-${streamId}`;
    const MIN_W = 0.08, MAX_W = 0.60;

    let state = null;   // { streamId, srcStreamId, ws, device, transport, consumers, el, geom, gen }
    let gen = 0;

    /* ── geometry ─────────────────────────────────────────────── */

    function loadGeom(streamId, defaults) {
        const fallback = {
            x: clamp(defaults?.x, 0, 1, 0.72),
            y: clamp(defaults?.y, 0, 1, 0.70),
            w: clamp(defaults?.w, MIN_W, MAX_W, 0.25),
            hidden: false, muted: true,
        };
        try {
            const raw = JSON.parse(localStorage.getItem(LS_KEY(streamId)) || 'null');
            if (!raw) return fallback;
            return {
                x: clamp(raw.x, 0, 1, fallback.x),
                y: clamp(raw.y, 0, 1, fallback.y),
                w: clamp(raw.w, MIN_W, MAX_W, fallback.w),
                hidden: !!raw.hidden,
                // Default to muted: the screen share underneath already carries the
                // broadcast audio, and two live audio tracks would double every word.
                muted: raw.muted !== false,
            };
        } catch { return fallback; }
    }

    function saveGeom() {
        if (!state) return;
        try { localStorage.setItem(LS_KEY(state.streamId), JSON.stringify(state.geom)); } catch { /* */ }
    }

    function clamp(v, lo, hi, dflt) {
        const n = Number(v);
        if (!Number.isFinite(n)) return dflt;
        return Math.min(hi, Math.max(lo, n));
    }

    function applyGeom() {
        if (!state?.el) return;
        const { x, y, w, hidden } = state.geom;
        const box = state.el;
        box.style.left = `${x * 100}%`;
        box.style.top = `${y * 100}%`;
        box.style.width = `${w * 100}%`;
        box.classList.toggle('is-hidden', !!hidden);
    }

    /* ── DOM ──────────────────────────────────────────────────── */

    function build(container, label) {
        const el = document.createElement('div');
        el.className = 'ov-pip';
        el.innerHTML = `
            <video class="ov-pip-video" autoplay playsinline muted></video>
            <div class="ov-pip-bar">
                <span class="ov-pip-title" title="${escapeHtml(label)}"><i class="fa-solid fa-video"></i> ${escapeHtml(label)}</span>
                <span class="ov-pip-actions">
                    <button type="button" data-act="mute"  title="Unmute camera"><i class="fa-solid fa-volume-xmark"></i></button>
                    <button type="button" data-act="reset" title="Reset position"><i class="fa-solid fa-arrows-to-dot"></i></button>
                    <button type="button" data-act="hide"  title="Hide camera"><i class="fa-solid fa-eye-slash"></i></button>
                </span>
            </div>
            <div class="ov-pip-resize" title="Drag to resize"></div>
            <div class="ov-pip-offline"><i class="fa-solid fa-video-slash"></i><span>Camera offline</span></div>`;
        container.appendChild(el);

        const showRestore = () => {
            let pill = container.querySelector('.ov-pip-restore');
            if (pill) return pill;
            pill = document.createElement('button');
            pill.type = 'button';
            pill.className = 'ov-pip-restore';
            pill.innerHTML = '<i class="fa-solid fa-video"></i> Show camera';
            pill.addEventListener('click', () => { state.geom.hidden = false; saveGeom(); applyGeom(); pill.remove(); });
            container.appendChild(pill);
            return pill;
        };

        el.querySelector('.ov-pip-actions').addEventListener('click', (e) => {
            const act = e.target.closest('[data-act]')?.dataset.act;
            if (!act) return;
            e.stopPropagation();
            if (act === 'hide') { state.geom.hidden = true; saveGeom(); applyGeom(); showRestore(); }
            else if (act === 'reset') {
                const d = state.defaults || {};
                state.geom.x = clamp(d.x, 0, 1, 0.72);
                state.geom.y = clamp(d.y, 0, 1, 0.70);
                state.geom.w = clamp(d.w, MIN_W, MAX_W, 0.25);
                saveGeom(); applyGeom();
            } else if (act === 'mute') {
                state.geom.muted = !state.geom.muted;
                const v = el.querySelector('.ov-pip-video');
                v.muted = state.geom.muted;
                if (!state.geom.muted) v.play().catch(() => {});
                const btn = e.target.closest('[data-act="mute"]');
                btn.title = state.geom.muted ? 'Unmute camera' : 'Mute camera';
                btn.innerHTML = `<i class="fa-solid ${state.geom.muted ? 'fa-volume-xmark' : 'fa-volume-high'}"></i>`;
                saveGeom();
            }
        });

        wireDrag(el, container);
        wireResize(el, container);
        if (state?.geom?.hidden) showRestore();
        return el;
    }

    /** Pointer-driven move, constrained so the overlay can never be dragged off-screen. */
    function wireDrag(el, container) {
        let start = null;
        const onDown = (e) => {
            if (e.target.closest('[data-act]') || e.target.closest('.ov-pip-resize')) return;
            const r = container.getBoundingClientRect();
            start = { px: e.clientX, py: e.clientY, x: state.geom.x, y: state.geom.y, rw: r.width, rh: r.height };
            el.classList.add('is-dragging');
            el.setPointerCapture?.(e.pointerId);
            e.preventDefault();
        };
        const onMove = (e) => {
            if (!start) return;
            const box = el.getBoundingClientRect();
            const r = container.getBoundingClientRect();
            const maxX = 1 - (box.width / r.width);
            const maxY = 1 - (box.height / r.height);
            state.geom.x = Math.min(Math.max(0, start.x + (e.clientX - start.px) / start.rw), Math.max(0, maxX));
            state.geom.y = Math.min(Math.max(0, start.y + (e.clientY - start.py) / start.rh), Math.max(0, maxY));
            applyGeom();
        };
        const onUp = (e) => {
            if (!start) return;
            start = null;
            el.classList.remove('is-dragging');
            el.releasePointerCapture?.(e.pointerId);
            saveGeom();
        };
        el.addEventListener('pointerdown', onDown);
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp);
        el.addEventListener('pointercancel', onUp);
    }

    function wireResize(el, container) {
        const handle = el.querySelector('.ov-pip-resize');
        let start = null;
        handle.addEventListener('pointerdown', (e) => {
            const r = container.getBoundingClientRect();
            start = { px: e.clientX, w: state.geom.w, rw: r.width };
            el.classList.add('is-resizing');
            handle.setPointerCapture?.(e.pointerId);
            e.preventDefault(); e.stopPropagation();
        });
        handle.addEventListener('pointermove', (e) => {
            if (!start) return;
            state.geom.w = clamp(start.w + (e.clientX - start.px) / start.rw, MIN_W, MAX_W, start.w);
            // Keep it inside the player as it grows.
            const box = el.getBoundingClientRect(), r = container.getBoundingClientRect();
            state.geom.x = Math.min(state.geom.x, Math.max(0, 1 - box.width / r.width));
            state.geom.y = Math.min(state.geom.y, Math.max(0, 1 - box.height / r.height));
            applyGeom();
        });
        const end = (e) => {
            if (!start) return;
            start = null;
            el.classList.remove('is-resizing');
            handle.releasePointerCapture?.(e.pointerId);
            saveGeom();
        };
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
    }

    function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    /* ── viewer session ───────────────────────────────────────── */

    function waitFor(ws, type, timeoutMs = 15000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { ws.removeEventListener('message', on); reject(new Error(`pip: timeout ${type}`)); }, timeoutMs);
            function on(ev) {
                let m; try { m = JSON.parse(ev.data); } catch { return; }
                if (m.type === type) { clearTimeout(timer); ws.removeEventListener('message', on); resolve(m); }
                else if (m.type === 'sfu-error' || m.type === 'sfu-source-unavailable') {
                    clearTimeout(timer); ws.removeEventListener('message', on); reject(new Error(m.error || 'pip: source unavailable'));
                }
            }
            ws.addEventListener('message', on);
        });
    }

    async function connect(srcStreamId, videoEl, myGen) {
        const host = window.location.hostname;
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const port = window.location.port ? `:${window.location.port}` : '';
        const token = localStorage.getItem('token') || '';
        const ws = new WebSocket(`${proto}://${host}${port}/ws/broadcast?streamId=${srcStreamId}&role=viewer&token=${token}`);
        if (state) state.ws = ws;

        await new Promise((res, rej) => {
            ws.addEventListener('open', res, { once: true });
            ws.addEventListener('error', () => rej(new Error('pip: websocket failed')), { once: true });
        });
        if (myGen !== gen) { try { ws.close(); } catch { /* */ } return; }

        ws.send(JSON.stringify({ type: 'watch' }));
        const ready = await waitFor(ws, 'sfu-viewer-ready', 20000);
        if (myGen !== gen) return;

        const mod = await (window.loadMediasoupClient ? window.loadMediasoupClient() : Promise.reject(new Error('pip: mediasoup-client unavailable')));
        const Device = mod.Device || mod.default?.Device;
        const device = new Device();
        await device.load({ routerRtpCapabilities: ready.rtpCapabilities });
        if (myGen !== gen) return;

        ws.send(JSON.stringify({ type: 'sfu-viewer-create-transport' }));
        const tp = await waitFor(ws, 'sfu-viewer-transport-created');
        if (myGen !== gen) return;

        const iceServers = (typeof sanitizeIceServers === 'function' ? sanitizeIceServers(tp.iceServers) : tp.iceServers) || [];
        const transport = device.createRecvTransport({
            id: tp.id, iceParameters: tp.iceParameters, iceCandidates: tp.iceCandidates,
            dtlsParameters: tp.dtlsParameters,
            iceServers: iceServers.length ? iceServers : [{ urls: 'stun:stun.l.google.com:19302' }],
        });
        if (state) { state.device = device; state.transport = transport; }

        transport.on('connect', ({ dtlsParameters }, cb, errb) => {
            ws.send(JSON.stringify({ type: 'sfu-viewer-connect-transport', transportId: transport.id, dtlsParameters }));
            waitFor(ws, 'sfu-viewer-transport-connected').then(() => cb()).catch(errb);
        });
        transport.on('connectionstatechange', (st) => {
            if (st === 'failed' || st === 'closed') markOffline(true);
        });

        const media = new MediaStream();
        for (const prod of (ready.producers || [])) {
            ws.send(JSON.stringify({
                type: 'sfu-viewer-consume', transportId: transport.id,
                producerId: prod.id, rtpCapabilities: device.rtpCapabilities,
            }));
            const cp = await waitFor(ws, 'sfu-viewer-consumed');
            if (myGen !== gen) return;
            const consumer = await transport.consume({
                id: cp.id, producerId: cp.producerId, kind: cp.kind, rtpParameters: cp.rtpParameters,
            });
            state?.consumers.push(consumer);
            media.addTrack(consumer.track);
            ws.send(JSON.stringify({ type: 'sfu-viewer-resume', consumerId: cp.id }));
        }

        videoEl.srcObject = media;
        videoEl.muted = state ? state.geom.muted : true;
        videoEl.play().catch(() => {});
        markOffline(false);

        // The camera slot going away should read as "camera offline", not as a broken
        // overlay — the screen share underneath is unaffected and must keep playing.
        ws.addEventListener('close', () => { if (myGen === gen) markOffline(true); });
    }

    function markOffline(off) {
        if (!state?.el) return;
        state.el.classList.toggle('is-offline', !!off);
    }

    /* ── public API ───────────────────────────────────────────── */

    /**
     * Attach the overlay for a stream, if it has a live PiP camera configured.
     * Safe to call on every player init; it tears down any previous overlay first.
     */
    async function attach(stream) {
        detach();
        const pip = stream?.pip_overlay;
        if (!pip || !pip.live || !pip.stream_id) return;

        const container = document.getElementById('video-container');
        if (!container) return;

        const myGen = ++gen;
        state = {
            streamId: stream.id, srcStreamId: pip.stream_id, ws: null, device: null,
            transport: null, consumers: [], el: null,
            defaults: pip.defaults || {}, geom: loadGeom(stream.id, pip.defaults),
        };
        state.el = build(container, pip.title || 'Camera');
        applyGeom();

        try {
            await connect(pip.stream_id, state.el.querySelector('.ov-pip-video'), myGen);
        } catch (err) {
            console.warn('[PiP] Camera overlay unavailable:', err.message);
            if (myGen === gen) markOffline(true);
        }
    }

    function detach() {
        gen++;
        if (!state) return;
        try { state.consumers.forEach(c => { try { c.close(); } catch { /* */ } }); } catch { /* */ }
        try { state.transport?.close(); } catch { /* */ }
        try { state.ws?.close(); } catch { /* */ }
        try { state.el?.remove(); } catch { /* */ }
        try { document.querySelector('.ov-pip-restore')?.remove(); } catch { /* */ }
        state = null;
    }

    window.streamPip = { attach, detach };
})();
