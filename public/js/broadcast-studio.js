/* The live studio on a phone (owner, 2026-10-16: "I can't change cameras on the whim… all these buttons that don't
   really mean anything"). While a stream from this browser is live on a narrow screen, the camera fills the screen
   and the controls sit on the picture, the way phone streaming apps work:

     top      LIVE, time live, people watching, restreams, connection, End
     right    Flip (front ↔ back in one tap), Mic, Camera, Light (a back camera's torch), Chat, Clip, More
     picture  pinch to zoom the camera, double tap for 1×
     bottom   the stream chat, over the picture
     More     a sheet: share, watch as a viewer, any camera, screen, media requests, a longer clip, chat read
              aloud, restreams, stream health, all settings and the full page

   It drives what broadcast.js already has (_switchActiveCamera, stopBroadcast, createBroadcastClip, …) and reads
   the page's own counters, so there is no second copy of the streaming state. Mic and camera off set
   MediaStreamTrack.enabled = false: viewers get silence or black while the stream and its recording go on. The
   choice is applied again every second, so a replaced track (a camera switch, a recovery) keeps it.

   Before going live, a phone also keeps "Go live" in reach (a bar at the bottom while the slot's own button is off
   screen). window.bcStudio (toggleMic, toggleCamera, flip, open) also serves the desktop control row. */
(function () {
    'use strict';
    // A phone held upright, or turned sideways (wide but short, with a touch screen).
    const NARROW = window.matchMedia('(max-width: 760px), (pointer: coarse) and (max-height: 520px)');
    const st = {
        root: null, micOff: false, camOff: false, torch: false, chatHidden: false, busy: false, viewer: null, viewerMute: 0,
        dismissedFor: null, hadLocal: false, sheet: null, confirm: null, parked: [], cameras: 0, lastFocus: null,
        choices: [], startingSince: 0, healthOpen: false,
    };

    const $ = (id) => document.getElementById(id);
    function el(tag, attrs, ...kids) {
        const n = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (v == null || v === false) continue;
            if (k === 'class') n.className = v;
            else if (k === 'text') n.textContent = v;
            else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
            else n.setAttribute(k, v === true ? '' : v);
        }
        for (const kid of kids) if (kid != null && kid !== false) n.append(kid);
        return n;
    }
    const icon = (name) => el('i', { class: `fa-solid ${name}`, 'aria-hidden': 'true' });
    const say = (text, kind) => { if (typeof toast === 'function') toast(text, kind || 'info'); };

    function streamState() {
        try { return typeof getActiveStreamState === 'function' ? getActiveStreamState() : null; } catch { return null; }
    }
    function localStream() { const ss = streamState(); return ss && ss.localStream ? ss.localStream : null; }
    function activeId() { try { return typeof broadcastState !== 'undefined' ? broadcastState.activeStreamId : null; } catch { return null; } }
    function screenSharing() { try { return !!broadcastState.settings.screenShare; } catch { return false; } }
    function videoTrack() { const s = localStream(); return s ? s.getVideoTracks()[0] || null : null; }
    function onBroadcastPage() { const p = $('page-broadcast'); return !!(p && p.classList.contains('active')); }
    function browserViewShown() { const v = $('bc-browser-broadcast'); return !!(v && v.style.display !== 'none'); }
    // The studio is up for the whole session: while the camera starts, while a recovery reopens it, and live. Tying it to
    // "a camera stream exists right now" showed the full page for a moment on every start (it mounted on the next
    // second's tick) and for the whole of every recovery, with "Error" and a stray Connecting box (owner, 2026-10-27).
    function sessionHere() { return onBroadcastPage() && browserViewShown() && !!streamState(); }
    function liveHere() { return sessionHere() && !!localStream(); }
    /** 'starting' (no camera yet), 'recovering' (the media restarts) or 'live'. */
    function phase() {
        const ss = streamState();
        if (!ss) return null;
        if (ss.mediaRecoveryInProgress || ss.mediaRecoveryTimer) return 'recovering';
        return ss.localStream ? 'live' : 'starting';
    }
    // A camera that never starts (permission refused) gives the page back after a while, with its error.
    const STARTING_GIVE_UP_MS = 25000;
    function wanted() {
        if (!sessionHere()) { st.startingSince = 0; return false; }
        if (!NARROW.matches || st.dismissedFor === activeId()) return false;
        if (phase() === 'starting') {
            if (!st.startingSince) st.startingSince = Date.now();
            return Date.now() - st.startingSince < STARTING_GIVE_UP_MS;
        }
        st.startingSince = 0;
        return true;
    }

    // ── Mic, camera and light: the choice holds across replaced tracks ──
    function applyTracks() {
        const s = localStream();
        if (!s) return;
        for (const t of s.getAudioTracks()) if (t.enabled === st.micOff) t.enabled = !st.micOff;
        for (const t of s.getVideoTracks()) if (t.enabled === st.camOff) t.enabled = !st.camOff;
        keepZoom();
    }
    function torchCapable() {
        const t = videoTrack();
        try { return !!(t && typeof t.getCapabilities === 'function' && t.getCapabilities().torch); } catch { return false; }
    }
    function facing() {
        const t = videoTrack();
        if (!t) return null;
        const s = (t.getSettings && t.getSettings()) || {};
        if (s.facingMode) return s.facingMode;
        return typeof _getCameraFacingHint === 'function' ? _getCameraFacingHint({ label: t.label }) : null;
    }

    // ── Pinch to zoom (owner, 2026-10-20: "some way to zoom while you're live on phone") ──
    // Two fingers on the picture drive the camera's own zoom (MediaStreamTrack `zoom`: the lens or a sensor crop, so
    // viewers get a sharp picture, never a stretched one); a double tap goes back to 1×. A camera without zoom says so
    // once. The level holds across a replaced track (a recovery on the same camera) and resets when the camera changes.
    const zoom = { level: null, deviceId: null, startLevel: 0, startDist: 0, busy: false, pending: null, lastTap: 0, told: false, badgeTimer: 0, surface: null };
    function zoomRange() {
        const t = videoTrack();
        try { const c = t && typeof t.getCapabilities === 'function' && t.getCapabilities().zoom; return c && c.max > c.min ? c : null; } catch { return null; }
    }
    function trackZoom() { const t = videoTrack(); const s = (t && t.getSettings && t.getSettings()) || {}; return Number(s.zoom) || (zoomRange() || {}).min || 1; }
    function trackDevice() { const t = videoTrack(); return (t && t.getSettings && t.getSettings().deviceId) || null; }
    function showZoom(z) {
        const b = $('bcs-zoom');
        if (!b) return;
        b.textContent = `${(Math.round(z * 10) / 10).toFixed(1)}×`;
        b.hidden = false;
        clearTimeout(zoom.badgeTimer);
        zoom.badgeTimer = setTimeout(() => { b.hidden = true; }, 1200);
    }
    function setZoom(level) {
        const r = zoomRange();
        const t = videoTrack();
        if (!r || !t) return;
        const step = r.step > 0 ? r.step : 0.1;
        const z = Math.min(r.max, Math.max(r.min, r.min + Math.round((level - r.min) / step) * step));
        zoom.level = z;
        zoom.deviceId = trackDevice();
        showZoom(z);
        if (zoom.busy) { zoom.pending = z; return; }   // one applyConstraints at a time; the newest level wins
        zoom.busy = true;
        t.applyConstraints({ advanced: [{ zoom: z }] }).catch(() => {}).finally(() => {
            zoom.busy = false;
            if (zoom.pending != null) { const next = zoom.pending; zoom.pending = null; setZoom(next); }
        });
    }
    const fingers = (e) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    function onZoomTouchStart(e) {
        if (e.touches.length === 2) {
            if (!zoomRange()) {
                if (!zoom.told) { zoom.told = true; say('This camera cannot zoom'); }
                return;
            }
            e.preventDefault();
            zoom.startDist = fingers(e);
            zoom.startLevel = zoom.level != null ? zoom.level : trackZoom();
        } else if (e.touches.length === 1) {
            const now = Date.now();
            const r = zoomRange();
            if (r && now - zoom.lastTap < 320) { e.preventDefault(); zoom.lastTap = 0; setZoom(r.min); } else zoom.lastTap = now;
        }
    }
    function onZoomTouchMove(e) {
        if (e.touches.length !== 2 || !zoom.startDist) return;
        e.preventDefault();
        setZoom(zoom.startLevel * (fingers(e) / zoom.startDist));
    }
    function onZoomTouchEnd(e) { if (e.touches.length < 2) zoom.startDist = 0; }
    function attachZoom() {
        const v = $('bc-video-preview');
        const surface = v && v.closest('.bc-video-container');
        if (!surface || zoom.surface === surface) return;
        detachZoom();
        zoom.surface = surface;
        surface.addEventListener('touchstart', onZoomTouchStart, { passive: false });
        surface.addEventListener('touchmove', onZoomTouchMove, { passive: false });
        surface.addEventListener('touchend', onZoomTouchEnd);
        surface.addEventListener('touchcancel', onZoomTouchEnd);
    }
    function detachZoom() {
        const s = zoom.surface;
        if (!s) return;
        s.removeEventListener('touchstart', onZoomTouchStart);
        s.removeEventListener('touchmove', onZoomTouchMove);
        s.removeEventListener('touchend', onZoomTouchEnd);
        s.removeEventListener('touchcancel', onZoomTouchEnd);
        zoom.surface = null;
    }
    /** The chosen zoom, again on a replaced track of the same camera; forgotten when the camera changes. */
    function keepZoom() {
        if (zoom.level == null || zoom.busy) return;
        if (trackDevice() !== zoom.deviceId) { zoom.level = null; return; }
        const r = zoomRange();
        if (r && Math.abs(trackZoom() - zoom.level) > (r.step > 0 ? r.step : 0.1) / 2) setZoom(zoom.level);
    }

    function toggleMic() { st.micOff = !st.micOff; applyTracks(); refresh(); }
    function toggleCamera() { st.camOff = !st.camOff; applyTracks(); refresh(); }
    async function toggleLight() {
        const t = videoTrack();
        if (!t || !torchCapable()) return;
        const on = !st.torch;
        try { await t.applyConstraints({ advanced: [{ torch: on }] }); st.torch = on; } catch { say('This camera cannot turn its light on', 'error'); }
        refresh();
    }

    async function loadCameras() {
        if (typeof _enumerateBroadcastVideoInputs !== 'function') return st.choices;
        const cams = await _enumerateBroadcastVideoInputs({ ensureLabels: false });
        st.cameras = cams.length;
        st.choices = typeof _bcCameraChoices === 'function' ? _bcCameraChoices(cams) : cams.map((d, i) => ({ deviceId: d.deviceId, name: `Camera ${i + 1}`, facing: _getCameraFacingHint(d) }));
        return st.choices;
    }
    const rememberSide = (facing, id) => { try { if (facing && id) localStorage.setItem(`bc-last-camera-${facing}`, id); } catch { /* */ } };
    const lastOnSide = (facing) => { try { return localStorage.getItem(`bc-last-camera-${facing}`); } catch { return null; } };
    async function useCamera(choice) {
        if (st.busy || !choice) return;
        if (screenSharing()) return say('You are sharing your screen. Stop sharing to use the camera.');
        if (typeof _switchActiveCamera !== 'function') return;
        st.busy = true;
        refresh();
        try {
            st.torch = false;
            zoom.level = null;
            // Quietly: the picture changing is the answer; a toast on every flip covered the chat.
            await _switchActiveCamera(choice.deviceId, { quiet: true });
            rememberSide(choice.facing, choice.deviceId);
            applyTracks();
        } catch (err) {
            say('Could not switch camera: ' + ((err && err.message) || 'unknown error'), 'error');
        } finally {
            st.busy = false;
            refresh();
        }
    }
    /** One tap: the other side, on the camera last used there (a phone's main one the first time); else the next camera. */
    async function flip() {
        if (st.busy) return;
        const choices = await loadCameras();
        if (choices.length < 2) { say('This device has only one camera'); return; }
        const nowId = (videoTrack() && videoTrack().getSettings && videoTrack().getSettings().deviceId) || null;
        const current = choices.find((c) => c.deviceId === nowId);
        const was = facing() || (current && current.facing);
        const otherSide = was === 'user' ? 'environment' : was === 'environment' ? 'user' : null;
        let next = null;
        if (otherSide) {
            const side = choices.filter((c) => c.facing === otherSide);
            next = side.find((c) => c.deviceId === lastOnSide(otherSide)) || side[0] || null;
        }
        if (!next) { const i = choices.findIndex((c) => c.deviceId === nowId); next = choices[(i + 1) % choices.length]; }
        await useCamera(next);
    }
    /** Every camera, by side, the one in use ticked: what holding Flip opens when there are more than two. */
    async function openCameras() {
        const choices = await loadCameras();
        closeSheet();
        st.lastFocus = document.activeElement;
        const nowId = (videoTrack() && videoTrack().getSettings && videoTrack().getSettings().deviceId) || null;
        const group = (title, list) => list.length ? el('div', { class: 'bcs-cam-group' }, el('h3', { text: title }),
            el('div', { class: 'bcs-cam-list' }, ...list.map((c) => el('button', {
                type: 'button', class: 'bcs-cam', 'aria-pressed': String(c.deviceId === nowId),
                onclick: () => { closeSheet(); if (c.deviceId !== nowId) useCamera(c); },
            }, icon(c.facing === 'user' ? 'fa-user' : c.facing === 'environment' ? 'fa-mountain-sun' : 'fa-video'),
            el('span', { text: c.name }), c.deviceId === nowId ? icon('fa-check') : null)))) : null;
        const sheet = el('div', { class: 'bcs-sheet bcs-cam-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'bcs-cam-title' },
            el('div', { class: 'bcs-grab', 'aria-hidden': 'true' }),
            el('div', { class: 'bcs-sheet-head' },
                el('div', { class: 'bcs-sheet-who' }, el('b', { id: 'bcs-cam-title', text: 'Cameras' }), el('small', { text: 'Tap Flip to switch sides; this one is remembered for its side' })),
                el('button', { type: 'button', class: 'bcs-x', 'aria-label': 'Close', onclick: closeSheet }, icon('fa-xmark'))),
            group('Front', choices.filter((c) => c.facing === 'user')),
            group('Back', choices.filter((c) => c.facing === 'environment')),
            group('Other cameras', choices.filter((c) => !c.facing)));
        st.sheet = el('div', { class: 'bcs-sheet-wrap', onclick: (e) => { if (e.target === st.sheet) closeSheet(); } }, sheet);
        document.body.append(st.sheet);
        const on = sheet.querySelector('.bcs-cam[aria-pressed="true"]') || sheet.querySelector('.bcs-cam');
        if (on) on.focus();
    }
    /** Flip's button: a tap flips; holding it (or a long press) lists every camera when there are more than two. */
    function flipButton() {
        const b = railButton('flip', 'fa-camera-rotate', 'Flip', null);
        b.append(el('span', { class: 'bcs-more-cams', hidden: true, 'aria-hidden': 'true' }));
        let timer = 0, held = false;
        const many = () => st.choices.length > 2;
        b.addEventListener('pointerdown', () => {
            held = false;
            clearTimeout(timer);
            if (!many()) return;
            timer = setTimeout(() => { held = true; try { navigator.vibrate && navigator.vibrate(12); } catch { /* */ } openCameras(); }, 450);
        });
        for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => clearTimeout(timer));
        b.addEventListener('contextmenu', (e) => e.preventDefault());
        b.addEventListener('click', () => { if (held) { held = false; return; } flip(); });
        return b;
    }

    function quickClip(seconds) {
        if (typeof createBroadcastClip !== 'function' || typeof _getBroadcastUptimeSeconds !== 'function') return;
        const end = Math.floor(_getBroadcastUptimeSeconds());
        if (end < 5) return say('Stream a few more seconds first, then clip it');
        // The clip panel's marks are what createBroadcastClip reads.
        if (seconds === 30 && typeof setBroadcastClipLast30 === 'function') setBroadcastClipLast30();
        else { try { _bcClipEnd = end; _bcClipStart = Math.max(0, end - seconds); } catch { /* the panel's own defaults stand */ } }
        const title = $('bc-clip-title');
        if (title) title.value = '';
        // The Clip button spins until the clip is saved; then broadcast.js's card offers to name it (or skip, and the
        // AI names it).
        const b = st.root && st.root.querySelector('[data-act="clip"]');
        if (b && b.classList.contains('is-busy')) return;
        const look = (busy) => {
            if (!b) return;
            b.classList.toggle('is-busy', busy);
            b.querySelector('i').className = `fa-solid ${busy ? 'fa-spinner fa-spin' : 'fa-scissors'}`;
            b.querySelector('.bcs-lbl').textContent = busy ? 'Clipping' : 'Clip';
        };
        look(true);
        Promise.resolve(createBroadcastClip()).catch(() => null).finally(() => look(false));
    }

    /** Your stream's address, the one to share: openvibe.live/@name (never a stream's slug, never /broadcast). */
    function streamLink() {
        const user = typeof currentUser !== 'undefined' && currentUser ? currentUser.username : null;
        return user ? `${location.origin}/@${encodeURIComponent(user)}` : null;
    }

    /** Copies the channel link, and says so on the button that asked. (The system share sheet takes a phone away from
     *  this tab, which pauses the camera, so a phone copies.) → whether it was copied. */
    function copyLink(btn, { quiet = false } = {}) {
        const url = streamLink();
        if (!url) return Promise.resolve(false);
        const label = btn && btn.querySelector ? btn.querySelector('span') : null;
        const done = (ok) => {
            if (label) {
                const was = label.dataset.was || label.textContent;
                label.dataset.was = was;
                if (ok) { btn.classList.add('is-copied'); label.textContent = ' Copied'; setTimeout(() => { btn.classList.remove('is-copied'); label.textContent = was; }, 2200); }
            }
            if (!quiet) say(ok ? 'Link copied. Paste it anywhere to share your stream.' : url, ok ? 'success' : 'info');
            return ok;
        };
        if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(url).then(() => done(true), () => done(false));
        if (typeof copyToClipboard === 'function') { copyToClipboard(url); return Promise.resolve(done(true)); }
        return Promise.resolve(done(false));
    }
    function share() { copyLink(null); }

    /**
     * The moment a stream from this browser goes live (the owner, 2026-10-28: "I've seen them struggle to share the
     * URL… they try and copy the URL that's in the browser"): a card says you're live and hands over the link,
     * openvibe.live/@name, with one tap to copy (never the system share sheet, which takes a phone off this tab). It goes by itself after 20 seconds, a hand
     * or focus on it holds it, and it shows once per stream.
     */
    const CARD_MS = 20000;
    function celebrate(streamId) {
        const url = streamLink();
        if (!url) return false;
        try { const key = `ov-golive-card:${streamId || 'x'}`; if (streamId && sessionStorage.getItem(key)) return false; sessionStorage.setItem(key, '1'); } catch { /* still show it */ }
        document.querySelectorAll('.bcs-livecard').forEach((n) => n.remove());
        const copy = el('button', { type: 'button', class: 'bcs-gl-copy' }, icon('fa-copy'), el('span', { text: ' Copy link' }));
        const close = el('button', { type: 'button', class: 'bcs-gl-x', 'aria-label': 'Close' }, icon('fa-xmark'));
        const sub = el('p', { class: 'bcs-gl-sub', text: 'Share this link. It always opens your stream:' });
        const code = el('code', { text: url.replace(/^https?:\/\//, '') });
        const bar = el('i');
        const card = el('div', { class: 'bcs-livecard', role: 'status', 'aria-live': 'polite' },
            el('div', { class: 'bcs-gl-burst', 'aria-hidden': 'true' }, ...Array.from({ length: 10 }, (_, i) => el('i', { style: `--a:${i * 36}deg;--d:${(i % 3) * 50}ms` }))),
            el('div', { class: 'bcs-gl-head' }, el('span', { class: 'bcs-gl-dot', 'aria-hidden': 'true' }), el('b', { text: 'You\u2019re live!' }), close),
            sub,
            el('div', { class: 'bcs-gl-link' }, code, copy),
            el('div', { class: 'bcs-gl-bar', 'aria-hidden': 'true' }, bar));
        document.body.append(card);
        let left = CARD_MS, last = Date.now(), held = false;
        const end = () => { clearInterval(timer); card.classList.add('is-out'); setTimeout(() => card.remove(), 260); };
        const timer = setInterval(() => {
            const now = Date.now();
            if (!held) left -= now - last;
            last = now;
            bar.style.transform = `scaleX(${Math.max(0, left / CARD_MS)})`;
            if (left <= 0 || !card.isConnected) end();
        }, 200);
        for (const ev of ['pointerenter', 'touchstart', 'focusin']) card.addEventListener(ev, () => { held = true; }, { passive: true });
        for (const ev of ['pointerleave', 'focusout']) card.addEventListener(ev, () => { held = false; last = Date.now(); });
        close.addEventListener('click', end);
        copy.addEventListener('click', () => copyLink(copy, { quiet: true }).then((ok) => {
            if (ok) { sub.textContent = 'Copied. Paste it in a group chat, on Discord or in a post.'; left = Math.min(left, 4000); return; }
            // No clipboard here: the link is selected, so a long press or Ctrl+C copies it.
            try { const r = document.createRange(); r.selectNodeContents(code); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); } catch { /* */ }
            sub.textContent = 'Press and hold the link to copy it.';
        }));
        return true;
    }

    // ── Staying on this tab ──
    // A phone pauses the camera of a tab it leaves, and the stream ends a minute later: every way out of the page
    // while live either stays in it (the viewer preview below), asks first (leaving), or says what happened.
    /** What viewers see, over the page: the channel in a frame, its sound off (the phone's mic would hear it). */
    function showViewer(url) {
        closeViewer();
        const frame = el('iframe', { class: 'bcs-viewer-frame', src: url, title: 'Your stream, as viewers see it' });
        const box = el('div', { class: 'bcs-viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'What viewers see' },
            el('div', { class: 'bcs-viewer-head' },
                el('div', null, el('b', { text: 'What viewers see' }), el('small', { text: 'A few seconds behind you, sound off' })),
                el('button', { type: 'button', class: 'bcs-x', 'aria-label': 'Close', onclick: closeViewer }, icon('fa-xmark'))),
            frame);
        st.viewer = el('div', { class: 'bcs-sheet-wrap bcs-center', onclick: (e) => { if (e.target === st.viewer) closeViewer(); } }, box);
        document.body.append(st.viewer);
        st.viewerMute = setInterval(() => {
            try { for (const m of frame.contentDocument.querySelectorAll('video, audio')) { m.muted = true; m.volume = 0; } } catch { /* not loaded yet */ }
        }, 400);
    }
    function closeViewer() {
        clearInterval(st.viewerMute);
        if (st.viewer) { st.viewer.remove(); st.viewer = null; }
    }
    window.addEventListener('beforeunload', (e) => {
        if (!localStream()) return;
        e.preventDefault();
        e.returnValue = 'You are live. Leaving this page ends your stream.';
    });
    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
        if (!localStream()) { hiddenAt = 0; return; }
        if (document.hidden) { hiddenAt = Date.now(); return; }
        if (hiddenAt && NARROW.matches && Date.now() - hiddenAt > 3000) say('Keep this tab open in front while you are live. A phone pauses the camera in other tabs and apps, and the stream ends after a minute.');
        hiddenAt = 0;
    });

    // ── Where people are watching (owner, 2026-10-26): the count adds up OpenVibe, RobotStreamer, Twitch, Kick and
    // YouTube (broadcast.js broadcastViewerPlaces), and a tap on it lists them (viewer-places.js), under the pill.
    function viewerPlaces() { return typeof broadcastViewerPlaces === 'function' ? broadcastViewerPlaces() : []; }
    function toggleViewers() {
        if (!window.OVViewerPlaces) return;
        closeSheet();
        closeHealth();
        OVViewerPlaces.toggle($('bcs-viewers'), viewerPlaces, {
            below: true,
            // Restreams sit with the places they send to ("Also on 1" was a second chip for the same thing).
            extra: () => ({ title: 'Restreams', rows: restreamRows(), action: restreamRows().length ? { label: 'Manage restreams', onClick: () => { OVViewerPlaces.close(); openSheet('restreams'); } } : null }),
        });
    }

    // ── The overlay ──
    function railButton(act, ico, label, onClick) {
        return el('button', { type: 'button', class: 'bcs-btn', 'data-act': act, onclick: onClick },
            el('span', { class: 'bcs-ico' }, icon(ico)), el('span', { class: 'bcs-lbl', text: label }));
    }
    function build() {
        // LIVE and the time were two pills saying one thing (owner, 2026-10-27): one red pill, its dot pulsing, the time in it.
        const top = el('div', { class: 'bcs-top' },
            el('div', { class: 'bcs-top-l' },
                el('span', { class: 'bcs-live', id: 'bcs-live', role: 'status' }, el('span', { class: 'bcs-live-dot', 'aria-hidden': 'true' }),
                    el('span', { class: 'bcs-live-t', id: 'bcs-time', text: '0:00' })),
                el('button', { type: 'button', class: 'bcs-pill bcs-viewers', id: 'bcs-viewers', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: toggleViewers },
                    icon('fa-eye'), el('b', { text: '0' }))),
            el('div', { class: 'bcs-top-r' },
                el('button', { type: 'button', class: 'bcs-pill bcs-health', id: 'bcs-health', 'aria-expanded': 'false', 'aria-controls': 'bc-stats-overlay', onclick: toggleHealth },
                    el('span', { class: 'bcs-dot', 'aria-hidden': 'true' }), el('span', { class: 'bcs-health-t', text: 'Connecting' })),
                el('button', { type: 'button', class: 'bcs-end', id: 'bcs-end', onclick: openConfirm }, 'End')));
        const rail = el('div', { class: 'bcs-rail', role: 'toolbar', 'aria-label': 'Live controls', 'aria-orientation': 'vertical' },
            flipButton(),
            railButton('mic', 'fa-microphone', 'Mic', toggleMic),
            railButton('cam', 'fa-video', 'Camera', toggleCamera),
            railButton('light', 'fa-bolt', 'Light', toggleLight),
            railButton('chat', 'fa-comment', 'Chat', () => { st.chatHidden = !st.chatHidden; refresh(); }),
            railButton('clip', 'fa-scissors', 'Clip', () => quickClip(30)),
            railButton('more', 'fa-ellipsis', 'More', () => openSheet()));
        // While the camera starts or a recovery reopens it, the picture says so instead of freezing on its last frame.
        const stateCard = el('div', { class: 'bcs-state', id: 'bcs-state', hidden: true, role: 'status' },
            el('span', { class: 'bcs-state-spin', 'aria-hidden': 'true' }), el('b', { class: 'bcs-state-t' }), el('small', { class: 'bcs-state-d' }));
        return el('div', { class: 'bcs', id: 'bc-studio' }, top, el('div', { class: 'bcs-flags', id: 'bcs-flags', 'aria-live': 'polite' }), rail,
            el('div', { class: 'bcs-zoom', id: 'bcs-zoom', hidden: true, 'aria-live': 'polite' }), stateCard);
    }

    function mount() {
        document.body.classList.add('bc-studio-on');
        st.root = build();
        document.body.append(st.root);
        attachZoom();
        // The overlay chat replaces the phone chat sheet.
        try { if (typeof _bcMobileChatOpen !== 'undefined' && _bcMobileChatOpen && typeof toggleBroadcastMobileChat === 'function') toggleBroadcastMobileChat(); } catch { /* not open */ }
        // The studio chat has no emote or GIF buttons: a picker opened before it would have no way to close.
        try { if (typeof closeEmotePicker === 'function') closeEmotePicker(); if (typeof closeGifPicker === 'function') closeGifPicker(); } catch { /* none open */ }
        const v = $('bc-video-preview');
        if (v) v.play().catch(() => {});
        const msgs = $('bc-chat-messages');
        if (msgs) msgs.scrollTop = msgs.scrollHeight;
        loadCameras().then(() => refresh(), () => {});
        refresh();
    }
    function unmount() {
        if (window.OVViewerPlaces) OVViewerPlaces.close();
        closeHealth();
        closeSheet();
        closeConfirm();
        closeViewer();
        document.body.classList.remove('bc-studio-on', 'bc-studio-chat-off');
        detachZoom();
        if (st.root) st.root.remove();
        st.root = null;
        const v = $('bc-video-preview');
        if (v) { v.classList.remove('bcs-mirror'); v.play().catch(() => {}); }
    }

    function text(id) { const n = $(id); return n ? n.textContent.trim() : ''; }
    /** Each restream and its state, read from the page's restream panels: [{ name, state: 'ok'|'warn'|'bad'|'idle', text }]. */
    function restreamRows() {
        const rows = [];
        const stateOf = (n) => n.querySelector('.bc-restream-status-live, .bc-rs-live') ? ['ok', 'Live']
            : n.querySelector('.bc-restream-status-starting, .bc-rs-connecting') ? ['warn', 'Connecting']
                : n.querySelector('.bc-restream-status-error, .bc-restream-status-failed, .bc-rs-error') ? ['bad', 'Failed'] : ['idle', 'Off'];
        const panel = $('bc-restream-control');
        if (panel && panel.style.display !== 'none') {
            for (const r of panel.querySelectorAll('.bc-restream-row')) {
                const nameEl = r.querySelector('.bc-restream-name');
                const name = nameEl ? (nameEl.firstChild && nameEl.firstChild.nodeType === 3 ? nameEl.firstChild.textContent : nameEl.textContent).trim() : 'Restream';
                const [state, text] = stateOf(r);
                rows.push({ name, state, text });
            }
        }
        const rs = $('bc-rs-control');
        if (rs && rs.style.display !== 'none' && !rows.some((r) => /robotstreamer/i.test(r.name))) {
            const [state, text] = stateOf(rs);
            if (state !== 'idle') rows.push({ name: 'RobotStreamer', state, text });
        }
        return rows;
    }
    function restreamSummary() {
        const scope = [$('bc-rs-control'), $('bc-restream-control')].filter((n) => n && n.style.display !== 'none');
        let live = 0, starting = 0, failed = 0;
        for (const n of scope) {
            live += n.querySelectorAll('.bc-rs-live, .bc-restream-status-live').length;
            starting += n.querySelectorAll('.bc-rs-connecting, .bc-restream-status-starting').length;
            failed += n.querySelectorAll('.bc-rs-error, .bc-restream-status-error, .bc-restream-status-failed').length;
        }
        if (failed) return { cls: 'is-bad', text: failed === 1 ? 'Restream failed' : `${failed} restreams failed` };
        if (starting) return { cls: 'is-warn', text: 'Restream connecting' };
        if (live) return { cls: 'is-ok', text: `Also on ${live}` };
        return null;
    }
    const HEALTH = {
        good: ['is-ok', 'Good'], fair: ['is-warn', 'Weak'], poor: ['is-bad', 'Poor'], offline: ['is-bad', 'Offline'],
        connecting: ['is-warn', 'Connecting'], measuring: ['is-warn', 'Checking'],
    };

    /** Brings the overlay up to date with the page (once a second, and after every action). */
    function refresh() {
        applyTracks();
        syncDesktopButtons();
        if (!st.root) return;
        document.body.classList.toggle('bc-studio-chat-off', st.chatHidden);
        // 0:05:07 → 5:07 while under an hour; while the camera starts or comes back, the pill says so.
        const ph = phase();
        const up = /^(\d+):(\d\d):(\d\d)$/.exec(text('bc-uptime'));
        const time = up ? (up[1] === '0' ? `${Number(up[2])}:${up[3]}` : `${up[1]}:${up[2]}:${up[3]}`) : (text('bc-uptime') || '0:00');
        const livePill = $('bcs-live');
        livePill.dataset.phase = ph || 'live';
        $('bcs-time').textContent = ph === 'starting' ? 'Starting' : time;
        livePill.setAttribute('aria-label', ph === 'starting' ? 'Starting your stream' : `Live for ${time}`);
        const stateCard = $('bcs-state');
        const stateText = ph === 'starting' ? ['Starting your camera…', 'Viewers see you in a moment']
            : ph === 'recovering' ? ['Reconnecting your camera…', 'You are still live; viewers wait a few seconds'] : null;
        stateCard.hidden = !stateText;
        if (stateText) { stateCard.querySelector('.bcs-state-t').textContent = stateText[0]; stateCard.querySelector('.bcs-state-d').textContent = stateText[1]; }
        const viewers = $('bcs-viewers').querySelector('b');
        viewers.textContent = text('bc-viewer-count') || '0';
        const places = viewerPlaces();
        const where = places.length > 1 && window.OVViewerPlaces ? `: ${OVViewerPlaces.summary(places)}` : '';
        $('bcs-viewers').title = `${viewers.textContent} watching now${where}`;
        $('bcs-viewers').setAttribute('aria-label', `${viewers.textContent} watching now${where}. Show where`);

        // A restream connecting or failed marks the viewers pill; its list is in the pill's panel.
        const rs = restreamSummary();
        $('bcs-viewers').dataset.rs = rs ? rs.cls.replace('is-', '') : '';
        if (rs && rs.cls !== 'is-ok') $('bcs-viewers').setAttribute('aria-label', `${viewers.textContent} watching now${where}. ${rs.text}. Show where`);
        if (window.OVViewerPlaces && OVViewerPlaces.isOpen()) OVViewerPlaces.update();

        const conn = $('bc-connection-status');
        const bad = conn && conn.classList.contains('bc-status-bad');
        const [cls, label] = ph === 'recovering' || bad ? ['is-bad', 'Reconnecting'] : ph === 'starting' ? ['is-warn', 'Starting']
            : (HEALTH[text('bc-stat-health').toLowerCase()] || ['is-warn', 'Connecting']);
        const health = $('bcs-health');
        health.className = `bcs-pill bcs-health ${cls}`;
        health.querySelector('.bcs-health-t').textContent = label;
        health.setAttribute('aria-label', `Connection: ${label}. Show stream health`);

        const set = (act, { on, ico, label: lbl, hidden, busy }) => {
            const b = st.root.querySelector(`[data-act="${act}"]`);
            if (!b) return;
            b.hidden = !!hidden;
            if (on !== undefined) b.setAttribute('aria-pressed', on ? 'true' : 'false');
            if (ico) b.querySelector('i').className = `fa-solid ${ico}`;
            if (lbl) b.querySelector('.bcs-lbl').textContent = lbl;
            b.classList.toggle('is-off', act === 'mic' ? st.micOff : act === 'cam' ? st.camOff : false);
            b.classList.toggle('is-busy', !!busy);
        };
        set('flip', { hidden: st.cameras === 1 || screenSharing(), busy: st.busy, ico: st.busy ? 'fa-spinner fa-spin' : 'fa-camera-rotate' });
        // More than two cameras: a small "+" on Flip says holding it lists them.
        const moreCams = st.root.querySelector('.bcs-more-cams');
        if (moreCams) moreCams.hidden = st.choices.length <= 2;
        const flipBtn = st.root.querySelector('[data-act="flip"]');
        if (flipBtn) flipBtn.setAttribute('aria-label', st.choices.length > 2 ? 'Flip camera. Hold to choose a camera' : 'Flip camera');
        set('mic', { on: st.micOff, ico: st.micOff ? 'fa-microphone-slash' : 'fa-microphone', label: st.micOff ? 'Unmute' : 'Mute' });
        set('cam', { on: st.camOff, ico: st.camOff ? 'fa-video-slash' : 'fa-video', label: st.camOff ? 'Camera on' : 'Camera' });
        set('light', { hidden: !torchCapable(), on: st.torch, label: st.torch ? 'Light off' : 'Light' });
        set('chat', { on: !st.chatHidden, ico: st.chatHidden ? 'fa-comment-slash' : 'fa-comment', label: st.chatHidden ? 'Show chat' : 'Chat' });

        const flags = [];
        if (st.micOff) flags.push(['fa-microphone-slash', 'Mic off: viewers hear nothing']);
        if (st.camOff) flags.push(['fa-video-slash', 'Camera off: viewers see black']);
        const v = $('bc-video-preview');
        if (v && v.style.display === 'none') flags.push(['fa-eye-slash', 'Preview hidden, still live']);
        const box = $('bcs-flags');
        const sig = JSON.stringify(flags);
        if (box.dataset.sig !== sig) {
            box.dataset.sig = sig;
            box.replaceChildren(...flags.map(([i, t]) => el('span', { class: 'bcs-flag' }, icon(i), t)));
        }
        if (v) v.classList.toggle('bcs-mirror', facing() === 'user' && !screenSharing());
    }

    // ── Desktop row: the same Mute / Camera off / Flip ──
    function syncDesktopButtons() {
        const live = !!localStream();
        const mic = $('bc-btn-mic-mute');
        if (mic) {
            mic.style.display = live && !screenSharing() ? '' : 'none';
            mic.classList.toggle('bc-ctrl-btn-active', st.micOff);
            mic.setAttribute('aria-pressed', st.micOff ? 'true' : 'false');
            mic.replaceChildren(icon(st.micOff ? 'fa-microphone-slash' : 'fa-microphone'), st.micOff ? ' Unmute' : ' Mute');
        }
        const cam = $('bc-btn-cam-off');
        if (cam) {
            cam.style.display = live && !screenSharing() ? '' : 'none';
            cam.classList.toggle('bc-ctrl-btn-active', st.camOff);
            cam.setAttribute('aria-pressed', st.camOff ? 'true' : 'false');
            cam.replaceChildren(icon(st.camOff ? 'fa-video-slash' : 'fa-video'), st.camOff ? ' Camera on' : ' Camera off');
        }
        const fl = $('bc-btn-flip');
        if (fl) fl.style.display = live && !screenSharing() && st.cameras > 1 ? '' : 'none';
        const back = $('bcs-return');
        if (back) back.hidden = !(NARROW.matches && sessionHere() && st.dismissedFor === activeId());
    }

    // ── More ──
    // ── Video quality, changed while live (owner, 2026-10-25: "adjustable settings for mobile") ──
    // Resolution and frame rate apply at once (the camera and the encoder, no restart: broadcast.js
    // applyBroadcastQuality) and become the slot's defaults. Battery saver is this phone's own setting.
    const RES_KBPS = { '480': 1200, '720': 2500, '1080': 4500 };
    const suggestedKbps = (res, fps) => Math.round(((RES_KBPS[res] || 2500) * (Number(fps) >= 50 ? 1.5 : 1)) / 100) * 100;
    let qualityQueue = Promise.resolve();
    function videoSection() {
        const s = broadcastState.settings;
        const saver = typeof batterySaverOn === 'function' && batterySaverOn();
        const seg = (label, options, current, key) => el('div', { class: 'bcs-seg', role: 'group', 'aria-label': label },
            ...options.map(([v, text]) => el('button', {
                type: 'button', class: 'bcs-seg-b', 'aria-pressed': String(!saver && String(current) === v), disabled: saver,
                onclick: () => setQuality({ [key]: v }),
            }, text)));
        return el('div', { class: 'bcs-sec bcs-video', id: 'bcs-video' },
            el('div', { class: 'bcs-video-head' }, el('h3', { text: 'Video' }), el('small', { class: 'bcs-video-now', id: 'bcs-video-now', 'aria-live': 'polite' })),
            seg('Resolution', [['480', '480p'], ['720', '720p'], ['1080', '1080p']], s.broadcastRes, 'broadcastRes'),
            seg('Frame rate', [['30', '30 fps'], ['60', '60 fps']], s.broadcastFps, 'broadcastFps'),
            el('div', { class: 'bcs-row' },
                el('div', null, el('b', { id: 'bcs-saver-t', text: 'Battery saver' }), el('small', { text: '480p at 30 fps: a cooler phone and a longer stream' })),
                el('button', { type: 'button', class: 'bcs-switch', role: 'switch', 'aria-checked': String(saver), 'aria-labelledby': 'bcs-saver-t',
                    onclick: () => setQuality({ batterySaver: !saver }) }, el('span', { class: 'bcs-switch-k', 'aria-hidden': 'true' }))));
    }
    function showVideoNow(info) {
        const n = $('bcs-video-now');
        if (!n || !info || !info.width) return;
        n.textContent = `Sending ${info.width}×${info.height} · ${info.fps} fps${info.codec ? ` · ${info.codec}` : ''}`;
    }
    function setQuality(patch) {
        const s = broadcastState.settings;
        if ('batterySaver' in patch) setBatterySaver(patch.batterySaver);
        else {
            Object.assign(s, patch);
            s.broadcastBps = String(suggestedKbps(String(s.broadcastRes), s.broadcastFps));
            if (typeof saveBroadcastSettings === 'function') saveBroadcastSettings();
            const ss = streamState();
            const msId = ss && ss.streamData ? ss.streamData.managed_stream_id : null;
            if (typeof _wsRememberQuality === 'function') _wsRememberQuality(msId, { resolution: s.broadcastRes, fps: s.broadcastFps, bitrate: s.broadcastBps }).catch(() => {});
        }
        const old = $('bcs-video');
        if (old) old.replaceWith(videoSection());
        qualityQueue = qualityQueue.then(() => applyBroadcastQuality()).then(showVideoNow, () => {});
    }

    function tile(ico, label, onClick, hint) {
        return el('button', { type: 'button', class: 'bcs-tile', onclick: onClick },
            icon(ico), el('span', { class: 'bcs-tile-t', text: label }), hint ? el('small', { text: hint }) : null);
    }
    /** The full page, optionally scrolled to `target` (a selector); a button brings the studio back. */
    function leave(target) {
        st.dismissedFor = activeId();
        unmount();
        ensureReturn();
        syncDesktopButtons();
        if (target) { const n = document.querySelector(target); if (n) n.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    }
    function ensureReturn() {
        if ($('bcs-return')) return;
        document.body.append(el('button', { type: 'button', class: 'bcs-return', id: 'bcs-return', hidden: true,
            onclick: () => { st.dismissedFor = null; tick(); } }, icon('fa-mobile-screen'), ' Back to live studio'));
    }

    function openSheet(section) {
        closeSheet();
        if (window.OVViewerPlaces) OVViewerPlaces.close();
        st.lastFocus = document.activeElement;
        const ss = streamState();
        const title = (ss && ss.streamData && ss.streamData.title) || 'Your stream';
        const user = typeof currentUser !== 'undefined' && currentUser ? currentUser.username : '';
        const preview = $('bc-video-preview');
        const previewHidden = preview && preview.style.display === 'none';
        const canScreen = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && typeof toggleScreenShare === 'function';
        const after = (fn) => () => { closeSheet(); fn(); };

        const grid = el('div', { class: 'bcs-grid' },
            tile('fa-tv', 'Watch as a viewer', after(() => openViewerPreview())),
            tile('fa-camera', 'Cameras', after(() => openCameras()), st.choices.length > 2 ? `${st.choices.length} on this phone` : null),
            canScreen ? tile('fa-display', screenSharing() ? 'Stop sharing screen' : 'Share screen', after(() => toggleScreenShare())) : null,
            tile('fa-film', 'Media requests', after(() => toggleMediaPip())),
            tile('fa-scissors', 'Clip last minute', after(() => quickClip(60))),
            tile(previewHidden ? 'fa-eye' : 'fa-eye-slash', previewHidden ? 'Show my preview' : 'Hide my preview', after(() => toggleBroadcastPreview()), previewHidden ? null : 'Saves battery'),
            tile('fa-sliders', 'All settings', after(() => leave('#bc-live-section .bc-settings-group'))),
            tile('fa-up-right-and-down-left-from-center', 'Full page', after(() => leave())));

        const voice = el('div', { class: 'bcs-row' },
            el('div', null, el('b', { text: 'Chat read aloud' }), el('small', { text: 'Messages are spoken on this device' })),
            el('div', { class: 'bcs-row-acts' },
                el('button', { type: 'button', class: 'bcs-chip', onclick: () => testTTS() }, 'Test'),
                el('button', { type: 'button', class: 'bcs-chip', onclick: () => cancelTTS() }, 'Skip current')));

        const restreams = el('div', { class: 'bcs-sec', id: 'bcs-restreams' }, el('h3', { text: 'Restreams' }));
        for (const id of ['bc-rs-control', 'bc-restream-control']) {
            const n = $(id);
            if (!n || n.style.display === 'none' || !n.childElementCount) continue;
            const mark = document.createComment(`bc-studio:${id}`);
            n.before(mark);
            st.parked.push({ node: n, mark });
            restreams.append(n);
        }

        const sheet = el('div', { class: 'bcs-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'bcs-sheet-title' },
            el('div', { class: 'bcs-grab', 'aria-hidden': 'true' }),
            el('div', { class: 'bcs-sheet-head' },
                el('div', { class: 'bcs-sheet-who' }, el('b', { id: 'bcs-sheet-title', text: title }), user ? el('small', { text: `openvibe.live/@${user}` }) : null),
                el('button', { type: 'button', class: 'bcs-chip bcs-chip-strong', onclick: share }, icon('fa-link'), ' Copy link'),
                el('button', { type: 'button', class: 'bcs-x', 'aria-label': 'Close', onclick: closeSheet }, icon('fa-xmark'))),
            grid, typeof applyBroadcastQuality === 'function' ? videoSection() : null, voice, st.parked.length ? restreams : null);
        st.sheet = el('div', { class: 'bcs-sheet-wrap', onclick: (e) => { if (e.target === st.sheet) closeSheet(); } }, sheet);
        document.body.append(st.sheet);
        const focus = section === 'restreams' && st.parked.length ? restreams : sheet.querySelector('.bcs-tile');
        if (section === 'restreams' && st.parked.length) restreams.scrollIntoView({ block: 'start' });
        if (focus && focus.focus) focus.focus({ preventScroll: section === 'restreams' });
        if (typeof broadcastVideoInfo === 'function') showVideoNow(broadcastVideoInfo());
    }
    function closeSheet() {
        for (const { node, mark } of st.parked.splice(0)) { mark.replaceWith(node); }
        if (st.sheet) { st.sheet.remove(); st.sheet = null; if (st.lastFocus && st.lastFocus.focus) st.lastFocus.focus(); }
    }

    function healthCard() { return $('bc-stats-overlay'); }
    function closeHealth() {
        const c = healthCard();
        if (c && c.style.display !== 'none') c.style.display = 'none';
        const p = $('bcs-health');
        if (p) p.setAttribute('aria-expanded', 'false');
        document.removeEventListener('pointerdown', onHealthOutside, true);
    }
    function onHealthOutside(e) {
        const c = healthCard(), p = $('bcs-health');
        if ((c && c.contains(e.target)) || (p && p.contains(e.target))) return;
        closeHealth();
    }
    function toggleHealth() {
        const c = healthCard();
        if (!c) return;
        if (c.style.display !== 'none') { closeHealth(); return; }
        if (window.OVViewerPlaces) OVViewerPlaces.close();
        c.style.display = 'grid';
        const p = $('bcs-health');
        if (p) p.setAttribute('aria-expanded', 'true');
        if (st.root) document.addEventListener('pointerdown', onHealthOutside, true);
    }

    function openConfirm() {
        closeConfirm();
        st.lastFocus = document.activeElement;
        const keep = el('button', { type: 'button', class: 'bcs-chip', onclick: closeConfirm }, 'Keep streaming');
        const box = el('div', { class: 'bcs-confirm', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'bcs-confirm-t', 'aria-describedby': 'bcs-confirm-d' },
            el('h3', { id: 'bcs-confirm-t', text: 'End your stream?' }),
            el('p', { id: 'bcs-confirm-d', text: 'Viewers will see it end. Restreams stop too, and the recording goes to your VODs.' }),
            el('div', { class: 'bcs-confirm-acts' }, keep,
                el('button', { type: 'button', class: 'bcs-end', onclick: () => { closeConfirm(); stopBroadcast(); } }, 'End stream')));
        st.confirm = el('div', { class: 'bcs-sheet-wrap bcs-center', onclick: (e) => { if (e.target === st.confirm) closeConfirm(); } }, box);
        document.body.append(st.confirm);
        keep.focus();
    }
    function closeConfirm() {
        if (st.confirm) { st.confirm.remove(); st.confirm = null; if (st.lastFocus && st.lastFocus.focus) st.lastFocus.focus(); }
    }

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (st.viewer) closeViewer();
        else if (st.confirm) closeConfirm();
        else if (st.sheet) closeSheet();
    });

    // ── Before going live on a phone: "Go live" stays in reach ──
    // The slot workspace puts the real Go Live button below the title, method, capture mode, quality and devices,
    // about two screens down on a phone. While it is out of view, a bar at the bottom presses it.
    function goLiveButton() { const b = $('bc-ws-golive-btn'); return b && b.offsetParent ? b : null; }
    // Nothing until the page knows the streamer's streams (broadcast.js loadExistingStreams): the bar said "Go live" for
    // a moment on every load, and while a stream of theirs was already live (owner, 2026-10-27). With one live and this
    // page not holding it, the bar resumes it instead of starting another.
    function inView(n) { if (!n || !n.offsetParent) return false; const r = n.getBoundingClientRect(); return r.top < window.innerHeight - 8 && r.bottom > 0; }
    function syncGoLiveDock() {
        const ready = NARROW.matches && onBroadcastPage() && !localStream() && !streamState() && !!window._bcMyLoaded;
        const liveMine = ready ? (window._bcMyLive || []) : [];
        let mode = null, real = null;
        if (ready && liveMine.length) {
            const card = document.querySelector('#bc-active-list .bc-live-card-main');
            if (!inView(card)) mode = 'resume';
        } else if (ready) {
            real = goLiveButton();
            if (real && !inView(real)) mode = 'golive';
        }
        let dock = $('bcs-golive');
        if (mode && !dock) {
            dock = el('div', { class: 'bcs-golive', id: 'bcs-golive' },
                el('button', { type: 'button', class: 'bcs-golive-btn', onclick: () => {
                    if (dock.dataset.mode === 'resume') { const s = (window._bcMyLive || [])[0]; if (s && typeof resumeStream === 'function') resumeStream(s.id); return; }
                    const b = goLiveButton(); if (b && !b.disabled) b.click();
                } }, icon('fa-tower-broadcast'), el('span', { class: 'bcs-golive-t', text: 'Go live' })),
                el('small', { class: 'bcs-golive-where' }));
            document.body.append(dock);
        }
        if (dock) {
            dock.hidden = !mode;
            dock.dataset.mode = mode || '';
            if (mode === 'resume') {
                const s = liveMine[0];
                dock.querySelector('.bcs-golive-btn i').className = 'fa-solid fa-play';
                dock.querySelector('.bcs-golive-t').textContent = liveMine.length > 1 ? 'Resume a live stream' : 'Resume your stream';
                dock.querySelector('.bcs-golive-where').textContent = liveMine.length > 1 ? `${liveMine.length} of your streams are live` : `"${(s && s.title) || 'Your stream'}" is still live`;
                dock.querySelector('.bcs-golive-btn').disabled = false;
            } else if (mode === 'golive') {
                dock.querySelector('.bcs-golive-btn i').className = 'fa-solid fa-tower-broadcast';
                dock.querySelector('.bcs-golive-t').textContent = 'Go live';
                const where = real.parentElement && real.parentElement.querySelector('.bc-create-reassurance');
                dock.querySelector('.bcs-golive-where').textContent = where ? where.textContent.trim() : '';
                dock.querySelector('.bcs-golive-btn').disabled = !!real.disabled;
            }
        }
        document.body.classList.toggle('bc-golive-dock-on', !!mode);
    }
    document.addEventListener('scroll', () => { if ($('bcs-golive') || goLiveButton()) syncGoLiveDock(); }, { capture: true, passive: true });

    // ── Once a second: mount, update or leave ──
    function tick() {
        // A hidden tab draws nothing: no work until it shows again (visibilitychange below).
        if (document.hidden) return;
        const has = !!localStream();
        if (has !== st.hadLocal) {
            st.hadLocal = has;
            // The camera button was hidden when the live view showed before the camera started.
            if (typeof syncBroadcastLiveButtonVisibility === 'function') syncBroadcastLiveButtonVisibility();
            if (has) loadCameras().then(() => { syncDesktopButtons(); refresh(); }, () => {});
            // A camera gone because the stream ended resets the switches; one gone for a recovery keeps them.
            if (!has && !streamState()) { st.micOff = false; st.camOff = false; st.torch = false; st.dismissedFor = null; }
        }
        if (wanted()) { if (!st.root) mount(); refresh(); }
        else { if (st.root) unmount(); applyTracks(); syncDesktopButtons(); }
        syncGoLiveDock();
    }
    setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
    document.addEventListener('bc-session', tick);
    if (NARROW.addEventListener) NARROW.addEventListener('change', tick);
    ensureReturn();

    window.bcStudio = { toggleMic, toggleCamera, flip, showViewer, copyLink, celebrate, streamLink, phone: () => NARROW.matches, open: () => { st.dismissedFor = null; tick(); }, _state: st };
})();
