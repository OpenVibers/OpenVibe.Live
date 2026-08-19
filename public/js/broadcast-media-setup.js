/* ───────────────────────────────────────────────────────────────
   broadcast-media-setup.js — device permission flow, live mic
   preview, and "what will actually be captured" summary.

   Three problems this exists to solve:

   1. Permission prompts arrived with no warning. The browser bar appeared,
      the streamer clicked something, and if they got it wrong the only
      feedback was silence once they were already live. We now explain what is
      about to be asked and why BEFORE triggering the prompt, and we explain
      how to recover if it was previously denied (the browser will not re-ask
      on its own once blocked).

   2. Device dropdowns read "Default". enumerateDevices() deliberately returns
      entries with an EMPTY label until the page holds a permission grant, so
      a list built before the grant can only ever show placeholders — and the
      deviceIds it returns are blank too, so selecting one silently captures
      the OS default. Every grant here re-enumerates and rebuilds.

   3. There was no way to tell whether a mic worked before going live. The
      meter below runs the real selected device through an AnalyserNode so
      "am I actually being heard" is answerable in the setup panel rather than
      after a viewer complains.
   ─────────────────────────────────────────────────────────────── */

(function () {
    'use strict';

    const KIND = {
        mic: {
            label: 'microphone',
            icon: 'fa-solid fa-microphone',
            permName: 'microphone',
            constraints: { audio: true },
            deviceKind: 'audioinput',
            why: 'so viewers can hear you talk over your stream',
        },
        camera: {
            label: 'camera',
            icon: 'fa-solid fa-video',
            permName: 'camera',
            constraints: { video: true },
            deviceKind: 'videoinput',
            why: 'so your camera can appear as a picture-in-picture over the screen share',
        },
    };

    /* ── Permission state ─────────────────────────────────────── */

    /**
     * 'granted' | 'denied' | 'prompt' | 'unknown'
     * The Permissions API is not universally implemented for camera/microphone
     * (notably older Safari), so 'unknown' is a normal answer and callers must
     * treat it as "we will have to ask and find out".
     */
    async function permissionState(kind) {
        const meta = KIND[kind];
        if (!meta) return 'unknown';
        try {
            if (!navigator.permissions?.query) return 'unknown';
            const st = await navigator.permissions.query({ name: meta.permName });
            return st.state || 'unknown';
        } catch { return 'unknown'; }
    }

    /** Do we already hold a grant? Labels are only populated once we do. */
    async function hasLabels(deviceKind) {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            return devices.some(d => d.kind === deviceKind && d.label);
        } catch { return false; }
    }

    /** Devices of one kind, only those the browser was willing to name. */
    async function listDevices(deviceKind) {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            return devices.filter(d => d.kind === deviceKind && d.deviceId && d.label);
        } catch { return []; }
    }

    /* ── Pre-flight explainer ─────────────────────────────────── */

    function browserHint() {
        const ua = navigator.userAgent;
        if (/Firefox\//.test(ua)) return 'Firefox shows the prompt just under the address bar. Tick “Remember this decision” so it stops asking.';
        if (/Edg\//.test(ua)) return 'Edge shows the prompt under the address bar, on the left.';
        if (/Chrome\//.test(ua)) return 'Chrome shows the prompt under the address bar, on the left.';
        if (/Safari\//.test(ua)) return 'Safari asks once per site — if you miss it, use Safari → Settings for This Website.';
        return 'Your browser will show the prompt near the address bar.';
    }

    function unblockHint(kind) {
        const ua = navigator.userAgent;
        const what = KIND[kind]?.label || 'device';
        if (/Firefox\//.test(ua)) return `Click the padlock in the address bar, then clear the blocked ${what} permission and reload.`;
        if (/Safari\//.test(ua)) return `Open Safari → Settings for This Website, set ${what} to Allow, then reload.`;
        return `Click the padlock (or camera icon) in the address bar, set ${what} to Allow, then reload.`;
    }

    /**
     * Show the explainer and resolve true if the streamer wants to continue.
     * Resolves immediately when we already hold a grant — re-explaining a
     * permission the browser will not even prompt for is pure friction.
     */
    function explain(kind, state) {
        const meta = KIND[kind];
        return new Promise((resolve) => {
            const blocked = state === 'denied';
            const wrap = document.createElement('div');
            wrap.className = 'bc-perm-overlay';
            wrap.innerHTML = `
                <div class="bc-perm-card" role="dialog" aria-modal="true" aria-label="${meta.label} access">
                    <div class="bc-perm-head">
                        <span class="bc-perm-icon ${blocked ? 'is-blocked' : ''}"><i class="${meta.icon}"></i></span>
                        <div>
                            <h3>${blocked ? `Your ${meta.label} is blocked` : `Allow your ${meta.label}?`}</h3>
                            <p>${blocked
                                ? `This site was previously denied ${meta.label} access, so the browser will not ask again on its own.`
                                : `We need it ${meta.why}.`}</p>
                        </div>
                    </div>

                    ${blocked ? `
                        <div class="bc-perm-steps">
                            <div class="bc-perm-step"><span>1</span><p>${unblockHint(kind)}</p></div>
                            <div class="bc-perm-step"><span>2</span><p>Come back here and turn the ${meta.label} on again.</p></div>
                        </div>
                    ` : `
                        <div class="bc-perm-mock" aria-hidden="true">
                            <div class="bc-perm-mock-bar">
                                <i class="fa-solid fa-lock"></i><span>openvibe.live</span>
                            </div>
                            <div class="bc-perm-mock-pop">
                                <p><i class="${meta.icon}"></i> Use your ${meta.label}?</p>
                                <div class="bc-perm-mock-btns">
                                    <span class="ghost">Block</span><span class="primary">Allow</span>
                                </div>
                            </div>
                        </div>
                        <p class="bc-perm-note"><i class="fa-solid fa-circle-info"></i> ${browserHint()}</p>
                        <p class="bc-perm-note"><i class="fa-solid fa-shield-halved"></i> Nothing is captured or sent until you press <strong>Go Live</strong> — this only lets us list your devices so you can pick one and test it.</p>
                    `}

                    <div class="bc-perm-actions">
                        <button type="button" class="btn btn-ghost" data-act="cancel">${blocked ? 'Close' : 'Not now'}</button>
                        ${blocked ? '' : `<button type="button" class="btn btn-primary" data-act="go"><i class="${meta.icon}"></i> Continue</button>`}
                    </div>
                </div>`;
            const done = (v) => { try { wrap.remove(); } catch { /* */ } resolve(v); };
            wrap.addEventListener('click', (e) => {
                if (e.target === wrap) return done(false);
                const act = e.target.closest('[data-act]')?.dataset.act;
                if (act === 'go') done(true);
                else if (act === 'cancel') done(false);
            });
            document.addEventListener('keydown', function esc(e) {
                if (e.key === 'Escape') { document.removeEventListener('keydown', esc); done(false); }
            });
            document.body.appendChild(wrap);
        });
    }

    /**
     * Full flow: explain → prompt → re-enumerate.
     * Returns { granted, devices, state, error }.
     *
     * The re-enumeration after the grant is the part that fixes labels reading
     * "Default": the list built before a grant carries empty labels AND empty
     * deviceIds, so it must be thrown away and rebuilt, not patched.
     */
    async function request(kind, { silent = false } = {}) {
        const meta = KIND[kind];
        if (!meta) return { granted: false, devices: [], state: 'unknown', error: 'unknown kind' };
        if (!navigator.mediaDevices?.getUserMedia) {
            return { granted: false, devices: [], state: 'unsupported', error: 'This browser cannot capture media.' };
        }

        let state = await permissionState(kind);
        if (state !== 'granted' && !(await hasLabels(meta.deviceKind))) {
            if (!silent) {
                const go = await explain(kind, state);
                if (!go) return { granted: false, devices: [], state, error: 'cancelled' };
            }
        }

        let stream = null;
        try {
            stream = await navigator.mediaDevices.getUserMedia(meta.constraints);
        } catch (err) {
            const denied = err.name === 'NotAllowedError' || err.name === 'SecurityError';
            if (denied && !silent) await explain(kind, 'denied');
            return {
                granted: false, devices: [], state: denied ? 'denied' : 'error',
                error: denied ? `${meta.label} access was blocked` : (err.message || String(err)),
            };
        } finally {
            // Release immediately — this grant exists to unlock device labels, not to capture.
            try { stream?.getTracks().forEach(t => t.stop()); } catch { /* */ }
        }

        const devices = await listDevices(meta.deviceKind);
        return { granted: true, devices, state: 'granted', error: null };
    }

    /* ── Live microphone meter ────────────────────────────────── */

    const meters = new Map();   // canvasId -> teardown()

    /**
     * Run the chosen microphone through an AnalyserNode and paint its level.
     *
     * Deliberately opens the SPECIFIC deviceId with an exact constraint, so the
     * meter proves the device the streamer picked actually produces audio —
     * a meter fed by the OS default would have happily shown a healthy signal
     * for the exact bug this feature is meant to catch.
     */
    async function startMeter(canvasId, deviceId, statusId) {
        stopMeter(canvasId);
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        const status = statusId ? document.getElementById(statusId) : null;
        const setStatus = (txt, cls) => {
            if (!status) return;
            status.textContent = txt;
            status.className = `bc-mic-meter-status ${cls || ''}`;
        };

        let stream = null, ctx = null, raf = null;
        try {
            const audio = (deviceId && deviceId !== 'default')
                ? { deviceId: { exact: deviceId } }
                : true;
            stream = await navigator.mediaDevices.getUserMedia({ audio });
        } catch (err) {
            setStatus(err.name === 'NotAllowedError' ? 'Microphone blocked' : 'Could not open this microphone', 'is-bad');
            return;
        }

        try {
            ctx = new (window.AudioContext || window.webkitAudioContext)();
            if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
            const src = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 1024;
            analyser.smoothingTimeConstant = 0.75;
            src.connect(analyser);
            const buf = new Uint8Array(analyser.fftSize);

            const g = canvas.getContext('2d');
            let peak = 0, silentFrames = 0, everHeard = false;

            const paint = () => {
                raf = requestAnimationFrame(paint);
                analyser.getByteTimeDomainData(buf);
                // RMS around the 128 midpoint, scaled so normal speech sits high
                // in the bar without clipping the display.
                let sum = 0;
                for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
                const rms = Math.sqrt(sum / buf.length);
                const level = Math.min(1, rms * 3.2);
                peak = Math.max(level, peak * 0.92);

                const w = canvas.width, h = canvas.height;
                g.clearRect(0, 0, w, h);
                g.fillStyle = 'rgba(255,255,255,0.07)';
                g.fillRect(0, 0, w, h);

                const segs = 28, gap = 2, sw = (w - gap * (segs - 1)) / segs;
                const lit = Math.round(level * segs);
                for (let i = 0; i < segs; i++) {
                    const frac = i / segs;
                    g.fillStyle = i < lit
                        ? (frac > 0.86 ? '#ef4444' : frac > 0.66 ? '#f59e0b' : '#22c55e')
                        : 'rgba(255,255,255,0.10)';
                    g.fillRect(i * (sw + gap), 0, sw, h);
                }
                const px = Math.round(peak * segs);
                if (px > 0 && px <= segs) {
                    g.fillStyle = 'rgba(255,255,255,0.75)';
                    g.fillRect(Math.min(segs - 1, px) * (sw + gap), 0, sw, h);
                }

                if (level > 0.045) { everHeard = true; silentFrames = 0; }
                else silentFrames++;

                if (everHeard) setStatus(level > 0.9 ? 'Very loud — try lowering your input level' : 'Sounding good', level > 0.9 ? 'is-warn' : 'is-good');
                else if (silentFrames > 150) setStatus('No sound yet — say something to test', 'is-warn');
                else setStatus('Listening…', '');
            };
            paint();
        } catch (err) {
            setStatus('Could not analyse this microphone', 'is-bad');
        }

        meters.set(canvasId, () => {
            try { if (raf) cancelAnimationFrame(raf); } catch { /* */ }
            try { stream?.getTracks().forEach(t => t.stop()); } catch { /* */ }
            try { ctx?.close(); } catch { /* */ }
            const c = document.getElementById(canvasId);
            if (c) { const gg = c.getContext('2d'); gg && gg.clearRect(0, 0, c.width, c.height); }
        });
    }

    function stopMeter(canvasId) {
        const teardown = meters.get(canvasId);
        if (teardown) { teardown(); meters.delete(canvasId); }
    }

    function stopAllMeters() { for (const id of [...meters.keys()]) stopMeter(id); }

    /* ── "What will be captured" summary ──────────────────────── */

    /**
     * Desktop/system audio is the most misunderstood part of screen sharing:
     * whether it is even offered depends on the browser AND on what the
     * streamer picks in the share picker (a whole screen usually cannot carry
     * audio on Linux; a tab usually can). Say so plainly up front rather than
     * letting them discover it from a silent VOD.
     */
    function systemAudioSupport() {
        const ua = navigator.userAgent;
        const isFirefox = /Firefox\//.test(ua);
        const isSafari = /Safari\//.test(ua) && !/Chrome\//.test(ua);
        const isLinux = /Linux/.test(ua) && !/Android/.test(ua);
        if (isSafari) return { level: 'no', text: 'Safari cannot share system audio — only your microphone will be captured.' };
        if (isFirefox) return { level: 'partial', text: 'Firefox only shares audio when you pick a browser tab, not a window or whole screen.' };
        if (isLinux) return { level: 'partial', text: 'On Linux, system audio usually only works when you share a browser tab.' };
        return { level: 'yes', text: 'Tick “Share system audio” in the picker to include desktop sound.' };
    }

    /**
     * Render the capture summary into `el`.
     * @param {object} o  { mic:boolean, micLabel:string, systemAudio:boolean, camera:boolean, cameraLabel:string }
     */
    function renderSummary(el, o) {
        if (!el) return;
        const sys = systemAudioSupport();
        const row = (on, icon, title, detail, warn) => `
            <div class="bc-cap-row ${on ? 'is-on' : 'is-off'}">
                <i class="${icon}"></i>
                <div>
                    <strong>${title}</strong>
                    <span>${detail}</span>
                </div>
                <em>${on ? 'On' : 'Off'}</em>
            </div>${warn ? `<p class="bc-cap-warn"><i class="fa-solid fa-triangle-exclamation"></i> ${warn}</p>` : ''}`;

        el.innerHTML = `
            <div class="bc-cap-list">
                ${row(true, 'fa-solid fa-display', 'Screen or window', 'Chosen when you press Go Live', '')}
                ${row(!!o.mic, 'fa-solid fa-microphone', 'Microphone',
                      o.mic ? (o.micLabel || 'Default microphone') : 'Viewers will not hear your voice', '')}
                ${row(!!o.systemAudio, 'fa-solid fa-volume-high', 'System audio',
                      o.systemAudio ? 'Desktop and app sound' : 'Desktop sound will not be included',
                      o.systemAudio && sys.level !== 'yes' ? sys.text : '')}
                ${row(!!o.camera, 'fa-solid fa-video', 'Camera',
                      o.camera ? (o.cameraLabel || 'Default camera') : 'No camera overlay', '')}
            </div>`;
    }

    window.bcMediaSetup = {
        request, permissionState, listDevices, hasLabels,
        startMeter, stopMeter, stopAllMeters,
        renderSummary, systemAudioSupport, unblockHint,
    };
})();
