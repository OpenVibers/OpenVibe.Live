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
    function liveHere() { return onBroadcastPage() && browserViewShown() && !!localStream(); }
    function wanted() { return NARROW.matches && liveHere() && st.dismissedFor !== activeId(); }

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

    /** Front ↔ back in one tap: the first camera facing the other way (a phone's main one), else the next camera. */
    async function flip() {
        if (st.busy) return;
        if (screenSharing()) return say('You are sharing your screen. Stop sharing to use the camera.');
        if (typeof _switchActiveCamera !== 'function' || typeof _enumerateBroadcastVideoInputs !== 'function') return;
        st.busy = true;
        refresh();
        try {
            const cams = await _enumerateBroadcastVideoInputs({ ensureLabels: false });
            st.cameras = cams.length;
            if (cams.length < 2) { say('This device has only one camera'); return; }
            const now = (videoTrack() && videoTrack().getSettings && videoTrack().getSettings()) || {};
            const was = facing();
            const other = was && cams.find((d) => d.deviceId !== now.deviceId && _getCameraFacingHint(d) && _getCameraFacingHint(d) !== was);
            const i = cams.findIndex((d) => d.deviceId === now.deviceId);
            const next = other || cams[(i + 1) % cams.length];
            st.torch = false;
            zoom.level = null;
            await _switchActiveCamera(next.deviceId);
            applyTracks();
        } catch (err) {
            say('Could not switch camera: ' + ((err && err.message) || 'unknown error'), 'error');
        } finally {
            st.busy = false;
            refresh();
        }
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

    /** Copies the channel link. (The system share sheet takes a phone away from this tab, which pauses the camera.) */
    function share() {
        const user = typeof currentUser !== 'undefined' && currentUser ? currentUser.username : null;
        if (!user) return;
        const url = `${location.origin}/@${encodeURIComponent(user)}`;
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(() => say('Link copied. Paste it anywhere to share your stream.', 'success'), () => say(url));
        else if (typeof copyToClipboard === 'function') copyToClipboard(url);
        else say(url);
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

    // ── The overlay ──
    function railButton(act, ico, label, onClick) {
        return el('button', { type: 'button', class: 'bcs-btn', 'data-act': act, onclick: onClick },
            el('span', { class: 'bcs-ico' }, icon(ico)), el('span', { class: 'bcs-lbl', text: label }));
    }
    function build() {
        const top = el('div', { class: 'bcs-top' },
            el('div', { class: 'bcs-top-l' },
                el('span', { class: 'bcs-live' }, el('span', { class: 'bcs-live-dot', 'aria-hidden': 'true' }), 'LIVE'),
                el('span', { class: 'bcs-pill', id: 'bcs-time', title: 'Time live' }, '0:00'),
                el('span', { class: 'bcs-pill', id: 'bcs-viewers', title: 'Watching now' }, icon('fa-eye'), el('b', { text: '0' })),
                el('button', { type: 'button', class: 'bcs-pill bcs-restream', id: 'bcs-restream', hidden: true, onclick: () => openSheet('restreams') })),
            el('div', { class: 'bcs-top-r' },
                el('button', { type: 'button', class: 'bcs-pill bcs-health', id: 'bcs-health', onclick: toggleHealth },
                    el('span', { class: 'bcs-dot', 'aria-hidden': 'true' }), el('span', { class: 'bcs-health-t', text: 'Connecting' })),
                el('button', { type: 'button', class: 'bcs-end', id: 'bcs-end', onclick: openConfirm }, 'End')));
        const rail = el('div', { class: 'bcs-rail', role: 'toolbar', 'aria-label': 'Live controls', 'aria-orientation': 'vertical' },
            railButton('flip', 'fa-camera-rotate', 'Flip', flip),
            railButton('mic', 'fa-microphone', 'Mic', toggleMic),
            railButton('cam', 'fa-video', 'Camera', toggleCamera),
            railButton('light', 'fa-bolt', 'Light', toggleLight),
            railButton('chat', 'fa-comment', 'Chat', () => { st.chatHidden = !st.chatHidden; refresh(); }),
            railButton('clip', 'fa-scissors', 'Clip', () => quickClip(30)),
            railButton('more', 'fa-ellipsis', 'More', () => openSheet()));
        return el('div', { class: 'bcs', id: 'bc-studio' }, top, el('div', { class: 'bcs-flags', id: 'bcs-flags', 'aria-live': 'polite' }), rail,
            el('div', { class: 'bcs-zoom', id: 'bcs-zoom', hidden: true, 'aria-live': 'polite' }));
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
        if (typeof _enumerateBroadcastVideoInputs === 'function') _enumerateBroadcastVideoInputs({ ensureLabels: false }).then((c) => { st.cameras = c.length; refresh(); }, () => {});
        refresh();
    }
    function unmount() {
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
        // 0:05:07 → 5:07 while under an hour.
        const up = /^(\d+):(\d\d):(\d\d)$/.exec(text('bc-uptime'));
        $('bcs-time').textContent = up ? (up[1] === '0' ? `${Number(up[2])}:${up[3]}` : `${up[1]}:${up[2]}:${up[3]}`) : (text('bc-uptime') || '0:00');
        const viewers = $('bcs-viewers').querySelector('b');
        viewers.textContent = text('bc-viewer-count') || '0';
        $('bcs-viewers').title = `${viewers.textContent} watching now`;

        const rs = restreamSummary();
        const chip = $('bcs-restream');
        chip.hidden = !rs;
        if (rs) { chip.className = `bcs-pill bcs-restream ${rs.cls}`; chip.textContent = rs.text; }

        const conn = $('bc-connection-status');
        const bad = conn && conn.classList.contains('bc-status-bad');
        const [cls, label] = bad ? ['is-bad', 'Reconnecting'] : (HEALTH[text('bc-stat-health').toLowerCase()] || ['is-warn', 'Connecting']);
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
        if (back) back.hidden = !(NARROW.matches && liveHere() && st.dismissedFor === activeId());
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
            tile('fa-camera', 'Choose camera', after(() => openCameraSwitcher())),
            canScreen ? tile('fa-display', screenSharing() ? 'Stop sharing screen' : 'Share screen', after(() => toggleScreenShare())) : null,
            tile('fa-film', 'Media requests', after(() => toggleMediaPip())),
            tile('fa-scissors', 'Clip last minute', after(() => quickClip(60))),
            tile(previewHidden ? 'fa-eye' : 'fa-eye-slash', previewHidden ? 'Show my preview' : 'Hide my preview', after(() => toggleBroadcastPreview()), previewHidden ? null : 'Saves battery'),
            tile('fa-chart-line', 'Stream health', after(toggleHealth)),
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

    function toggleHealth() { if (typeof toggleBroadcastStats === 'function') toggleBroadcastStats(); }

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
    function syncGoLiveDock() {
        const real = NARROW.matches && onBroadcastPage() && !localStream() ? goLiveButton() : null;
        let inView = false;
        if (real) { const r = real.getBoundingClientRect(); inView = r.top < window.innerHeight - 8 && r.bottom > 0; }
        const show = !!real && !inView;
        let dock = $('bcs-golive');
        if (show && !dock) {
            dock = el('div', { class: 'bcs-golive', id: 'bcs-golive' },
                el('button', { type: 'button', class: 'bcs-golive-btn', onclick: () => { const b = goLiveButton(); if (b && !b.disabled) b.click(); } },
                    icon('fa-tower-broadcast'), ' Go live'),
                el('small', { class: 'bcs-golive-where' }));
            document.body.append(dock);
        }
        if (dock) {
            dock.hidden = !show;
            if (show) {
                const where = real.parentElement && real.parentElement.querySelector('.bc-create-reassurance');
                dock.querySelector('.bcs-golive-where').textContent = where ? where.textContent.trim() : '';
                dock.querySelector('.bcs-golive-btn').disabled = !!real.disabled;
            }
        }
        document.body.classList.toggle('bc-golive-dock-on', show);
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
            if (has && typeof _enumerateBroadcastVideoInputs === 'function') _enumerateBroadcastVideoInputs({ ensureLabels: false }).then((c) => { st.cameras = c.length; syncDesktopButtons(); }, () => {});
            if (!has) { st.micOff = false; st.camOff = false; st.torch = false; st.dismissedFor = null; }
        }
        if (wanted()) { if (!st.root) mount(); refresh(); }
        else { if (st.root) unmount(); applyTracks(); syncDesktopButtons(); }
        syncGoLiveDock();
    }
    setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
    if (NARROW.addEventListener) NARROW.addEventListener('change', tick);
    ensureReturn();

    window.bcStudio = { toggleMic, toggleCamera, flip, showViewer, phone: () => NARROW.matches, open: () => { st.dismissedFor = null; tick(); }, _state: st };
})();
