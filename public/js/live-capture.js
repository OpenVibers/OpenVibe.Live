/*
 * Live's capture system: window.OVCapture. Everything the go-live page does with a camera and a microphone, built from
 * parts that can each be replaced, and nothing that talks to another site.
 *
 * The owner, 2026-11-12: "we don't want to use openvibe.cam for OpenVibe.Live, we already had our own custom system for
 * live stream … so long as we can completely customize it and it's implemented in a highly over engineered modular
 * editable way." Until then the page loaded OpenVibe.Cam's cam-kit.js for this, and from 11-09 to 11-12 nobody could
 * turn a camera on when that load was refused.
 *
 * Using it:
 *   OVCapture.open({ mode, facing, lens, mic, resolution })  → a MediaStream. Runs the strategies in order, each with
 *                                                             its own time limit; the first that opens wins.
 *   OVCapture.devices()                                      → the browser's cameras and microphones.
 *   OVCapture.meter(stream, onLevel)                         → stop(): the microphone's level, 0 to 1, each frame.
 *   OVCapture.network()                                      → 'offline' | 'weak' | 'good' | '' (unknown).
 *   OVCapture.stop(stream)
 *   OVCapture.explain(error, mode)                           → { title, steps }: what happened and what to tap.
 *   OVCapture.settings.load() / .save(partial)               → this device's choices: facing, lens, mic, resolution,
 *                                                              mirror (the 'store' part; this browser by default).
 *
 * Changing it:
 *   OVCapture.use(name, impl)   replaces a part and returns the one it replaced, so a wrapper can call through:
 *                               const before = OVCapture.use('constraints', (o) => ({ ...before(o), video: … }));
 *   OVCapture.part(name)        the part now in use. Parts: constraints, getUserMedia, enumerate, meter, network,
 *                               store, explain, timeoutMs.
 *   OVCapture.strategies        the ways to open a camera, in order: .list(), .add(strategy, { before, after }),
 *                               .remove(name), .replace(name, strategy). A strategy is { name, open(options, capture) }.
 *   OVCapture.on(event, fn)     'opening' { strategy, options } · 'opened' { strategy, stream } ·
 *                               'failed' { strategy, error } · 'gave-up' { error } · 'settings' { settings }.
 *                               Returns off().
 * Every name and every default is in this file; nothing is hidden in a library.
 */
(function () {
    'use strict';

    // ── Parts: each one plain, each one replaceable with use(). ─────────────────────────────────────────────────────
    const parts = {
        /** What to ask the browser for, from the options (facing, lens, mic, resolution, mode). */
        constraints(o = {}) {
            const height = Number(o.resolution) || 720;
            const video = o.video === false ? false : {
                facingMode: { ideal: o.facing || 'user' },
                ...(o.lens && o.lens !== 'main' && o.lens !== 'default' ? { deviceId: { ideal: o.lens } } : {}),
                width: { ideal: Math.round(height * 16 / 9) }, height: { ideal: height },
            };
            const audio = o.audio === false ? false : (o.mic && o.mic !== 'default' ? { deviceId: { ideal: o.mic } } : true);
            return { video, audio };
        },
        getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
        enumerate: () => navigator.mediaDevices.enumerateDevices(),
        meter(stream, onLevel) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC || !stream || !stream.getAudioTracks().length) return () => {};
            const ctx = new AC(), analyser = ctx.createAnalyser(), data = new Uint8Array(512);
            let frame = 0, closed = false;
            analyser.fftSize = 512;
            ctx.createMediaStreamSource(stream).connect(analyser);
            if (ctx.state === 'suspended') {
                ctx.resume().catch(() => {});
                document.addEventListener('pointerdown', () => { ctx.resume().catch(() => {}); }, { once: true, capture: true });
            }
            const tick = () => {
                if (closed) return;
                analyser.getByteTimeDomainData(data);
                let sum = 0;
                for (let i = 0; i < data.length; i++) { const d = (data[i] - 128) / 128; sum += d * d; }
                onLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
                frame = requestAnimationFrame(tick);
            };
            frame = requestAnimationFrame(tick);
            return () => { closed = true; cancelAnimationFrame(frame); ctx.close().catch(() => {}); };
        },
        network() {
            if (navigator.onLine === false) return 'offline';
            const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
            if (!c || !(c.effectiveType || c.downlink)) return '';
            return /(^|-)(2g|3g)$/.test(c.effectiveType || '') || (c.downlink && c.downlink < 2.5) ? 'weak' : 'good';
        },
        /** Where this device's camera choices live: this browser, because device ids are this browser's own. */
        store: {
            key: 'ov_capture_settings',
            load() { try { return JSON.parse(localStorage.getItem(this.key) || 'null') || {}; } catch { return {}; } },
            save(settings) { try { localStorage.setItem(this.key, JSON.stringify(settings)); } catch { /* private mode */ } },
        },
        explain: null,   // set below (explainFailure): the plain words for a failure, by browser
        timeoutMs: 10000,
    };

    // ── Events ──────────────────────────────────────────────────────────────────────────────────────────────────
    const listeners = new Map();
    function on(event, fn) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(fn);
        return () => listeners.get(event).delete(fn);
    }
    function emit(event, detail) {
        (listeners.get(event) || []).forEach((fn) => { try { fn(detail); } catch (e) { console.warn('[capture] listener', event, e); } });
    }

    // ── Strategies: the ways to open a camera, tried in order. ──────────────────────────────────────────────────────
    const wants = (o) => ({ video: o.mode !== 'mic_only' && o.video !== false, audio: o.mode !== 'camera_only' && o.audio !== false });
    const merge = (...streams) => {
        const out = new MediaStream();
        streams.filter(Boolean).forEach((s) => s.getTracks().forEach((t) => out.addTrack(t)));
        return out;
    };
    const defaults = [
        {
            name: 'preferred',
            note: 'Camera and microphone together, as chosen (facing, lens, microphone, resolution).',
            open: (o, c) => c.part('getUserMedia')(c.part('constraints')({ ...o, ...wants(o) })),
        },
        {
            name: 'separately',
            note: 'The camera, then the microphone, each on its own (some Android phones refuse both at once).',
            async open(o, c) {
                const w = wants(o), gum = c.part('getUserMedia'), cons = c.part('constraints');
                let video = null, audio = null, last = null;
                if (w.video) { try { video = await gum({ video: cons(o).video, audio: false }); } catch (e) { last = e; } }
                if (w.audio) { try { audio = await gum({ video: false, audio: cons(o).audio }); } catch (e) { last = e; } }
                if (!video && !audio) throw last || new DOMException('No camera or microphone', 'NotFoundError');
                return merge(video, audio);
            },
        },
        {
            name: 'basic',
            note: 'Any camera and any microphone, nothing asked of them.',
            open: (o, c) => c.part('getUserMedia')(wants(o)),
        },
    ];
    let order = defaults.slice();
    const strategies = {
        list: () => order.map((s) => ({ name: s.name, note: s.note || '' })),
        add(strategy, at = {}) {
            if (!strategy || !strategy.name || typeof strategy.open !== 'function') throw new TypeError('a strategy is { name, open(options, capture) }');
            order = order.filter((s) => s.name !== strategy.name);
            const i = at.before ? order.findIndex((s) => s.name === at.before) : at.after ? order.findIndex((s) => s.name === at.after) + 1 : -1;
            if (i < 0 || i > order.length) order.push(strategy); else order.splice(i, 0, strategy);
        },
        remove(name) { order = order.filter((s) => s.name !== name); },
        replace(name, strategy) { order = order.map((s) => (s.name === name ? { ...strategy, name } : s)); },
        reset() { order = defaults.slice(); },
    };

    // A refusal says the most about what to do, so it wins over "not found" when several strategies failed differently.
    const WEIGHT = { NotAllowedError: 6, PermissionDeniedError: 6, SecurityError: 5, NotReadableError: 4, TrackStartError: 4, AbortError: 3, OverconstrainedError: 2, NotFoundError: 1, DevicesNotFoundError: 1, TimeoutError: 1 };
    const heavier = (a, b) => (!a ? b : (WEIGHT[b && b.name] || 0) > (WEIGHT[a.name] || 0) ? b : a);
    function within(promise, ms, name) {
        let timer;
        return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new DOMException(`${name} took longer than ${ms} ms`, 'TimeoutError')), ms); })])
            .finally(() => clearTimeout(timer));
    }

    async function open(options = {}) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('This browser has no camera here'), { name: 'NoApi' });
        const o = { ...capture.settings.load(), ...options };
        let worst = null;
        for (const s of order) {
            emit('opening', { strategy: s.name, options: o });
            try {
                const stream = await within(Promise.resolve(s.open(o, capture)), Number(s.timeoutMs || parts.timeoutMs), s.name);
                const w = wants(o);
                // A strategy that opened less than was asked for has not opened it: say so and stop the tracks.
                if ((w.video && !stream.getVideoTracks().length) || (w.audio && !stream.getAudioTracks().length)) {
                    stream.getTracks().forEach((t) => t.stop());
                    throw new DOMException('The requested device was not available', 'NotFoundError');
                }
                emit('opened', { strategy: s.name, stream });
                return stream;
            } catch (error) {
                worst = heavier(worst, error);
                emit('failed', { strategy: s.name, error });
                // A refusal is the person's answer: asking again in another way would only ask again.
                if (error && (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError' || error.name === 'SecurityError')) break;
            }
        }
        emit('gave-up', { error: worst });
        throw worst || new Error('The camera did not open');
    }

    // ── Plain words for a failure, by browser (the go-live card's fix box). ─────────────────────────────────────────
    function explainFailure(err, mode) {
        const ua = navigator.userAgent || '';
        const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
        const android = /Android/.test(ua);
        const firefox = /Firefox|FxiOS/.test(ua);
        const safari = /Safari/.test(ua) && !/Chrome|CriOS|Chromium|Edg|FxiOS/.test(ua);
        const inApp = /FBAN|FBAV|Instagram|Line\/|Twitter|Discord|TikTok|musical_ly|Snapchat|GSA\//.test(ua) || /; wv\)/.test(ua);
        const what = mode === 'mic_only' ? 'microphone' : mode === 'camera_only' ? 'camera' : 'camera and microphone';
        const name = err && err.name;
        if (name === 'NoApi' || (inApp && name !== 'NotReadableError')) {
            return { title: 'This browser can\'t use your camera here', steps: inApp
                ? ['You opened this inside another app (like Discord, Instagram or TikTok). Those can\'t share a camera.', `Tap the ⋮ or ⋯ menu and choose "Open in ${ios ? 'Safari' : 'Chrome'}" (or "Open in browser").`, 'Sign in there if asked, then press Turn on camera again.']
                : ['Open openvibe.live in Chrome, Safari, Edge or Firefox, then press Turn on camera.'] };
        }
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
            const steps = ios && safari ? ['Tap "aA" (or the page icon) at the left of the address bar.', 'Tap Website Settings.', `Set Camera${mode === 'camera_only' ? '' : ' and Microphone'} to Allow.`]
                : ios ? ['Open the iPhone Settings app, find this browser, and turn on Camera and Microphone.', 'Come back here.']
                : android && !firefox ? ['Tap the icon at the left of the address bar (a lock or two sliders).', 'Tap Permissions (or Site settings).', `Set Camera${mode === 'camera_only' ? '' : ' and Microphone'} to Allow.`]
                : firefox ? ['Click the camera icon with a line through it, at the left of the address bar.', 'Remove "Blocked temporarily" (the ×).']
                : safari ? ['Open Safari\'s menu → Settings for openvibe.live.', `Set Camera${mode === 'camera_only' ? '' : ' and Microphone'} to Allow.`]
                : ['Click the camera icon at the right end of the address bar (or the lock at the left).', `Choose "Always allow" for the ${what}, then Done.`];
            return { title: `Your browser said no to the ${what}`, steps: [...steps, 'Then press Try again below.'] };
        }
        if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
            return { title: 'Another app is using your camera', steps: ['Close apps that use the camera, like Zoom, FaceTime, WhatsApp, Instagram or the Camera app (and other tabs with a call).', 'Then press Try again below.'] };
        }
        if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
            return { title: `No ${what} found`, steps: [mode === 'mic_only' ? 'Plug in a microphone or headset, then press Try again.' : 'Plug in a camera (or open its privacy cover), then press Try again.', 'Or go live with your screen instead: "Use a screen or an app instead" below.'] };
        }
        if (name === 'OverconstrainedError') {
            return { title: 'That camera can\'t start with these settings', steps: ['Press Try again: it starts with simpler settings.', 'Still stuck? Pick another camera in Camera settings.'] };
        }
        if (name === 'TimeoutError') {
            return { title: 'Your browser didn\'t answer', steps: ['Look for the browser\'s question at the top of the screen and tap Allow.', 'Nothing there? Press Try again below.'] };
        }
        return { title: 'The camera didn\'t start', steps: ['Press Try again below.', 'Still stuck? Reload this page, or try Chrome or Safari.'] };
    }
    parts.explain = explainFailure;

    // ── The API ─────────────────────────────────────────────────────────────────────────────────────────────────
    const capture = {
        version: 1,
        part(name) {
            if (!(name in parts)) throw new RangeError(`no capture part "${name}"; the parts are ${Object.keys(parts).join(', ')}`);
            return parts[name];
        },
        use(name, impl) {
            const before = capture.part(name);
            parts[name] = impl;
            return before;
        },
        parts: () => Object.keys(parts),
        strategies,
        on,
        open,
        devices: () => parts.enumerate(),
        meter: (stream, onLevel) => parts.meter(stream, onLevel),
        network: () => parts.network(),
        stop: (stream) => { try { stream && stream.getTracks().forEach((t) => t.stop()); } catch { /* already stopped */ } },
        explain: (error, mode) => parts.explain(error, mode),
        settings: {
            load: () => ({ facing: 'user', lens: 'main', mic: 'default', resolution: '720', mirror: true, ...parts.store.load() }),
            save(partial) {
                const next = { ...capture.settings.load(), ...(partial || {}) };
                parts.store.save(next);
                emit('settings', { settings: next });
                return next;
            },
        },
    };
    window.OVCapture = capture;
})();
