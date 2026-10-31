/* ───────────────────────────────────────────────────────────────
   ov-viewer-health.js — the shared "is the picture actually moving?" layer for every player.

   The channel's live player, the home page's featured block and the VOD/clip player all show a
   picture that can stop moving while everything else looks fine: the signaling websocket is open,
   the transport says "connected", the audio keeps playing. The viewer sees a frozen picture and
   nothing else explains it (plan L23, 2026-10-31: stream 2833 froze a few seconds in and a
   reload played fine).

   This module is the one place that knows how to answer "is it frozen?" and what to do about it:

     · telemetry  every 5 s the player sends one small message with the decoder's own numbers
                  (framesDecoded, framesDropped, packetsLost, jitter, jitterBufferDelay, the codec
                  and the decoder implementation). The server counts the freezes it sees.
     · recovery  a ladder, in steps, cheapest first:
                     1. ask for a keyframe (the server asks the broadcaster's encoder for one,
                        at most one ask per consumer every 2 s),
                     2. restart the receive transport (a fresh one, the media session rebuilt),
                     3. rebuild the whole viewer session.
                  The page is never reloaded.
     · notice    a small "The picture froze. Reconnecting…" line with a "Copy debug info" button
                  that copies a report the owner can paste to us: the stream, the time, the
                  browser, the codec, the decoder, the last telemetry sample and the steps taken.
                  The report never carries a token, a cookie or anything else personal.

   The ladder is a plain state machine with no DOM in it, so a test can drive it with a fake
   clock (test/viewer-health.test.js) and check the order of the steps.
   ─────────────────────────────────────────────────────────────── */

(function () {
    'use strict';
    if (window.OVViewerHealth) return;

    /* How long a picture may stand still before we call it frozen, how many keyframes we ask
       for before we restart the transport, and how long each step is given. */
    const T = {
        freezeMs: 1500,          // no new decoded frame for this long while connected = frozen
        serverFreezeMs: 2000,    // the server's own threshold (a freeze it counts and logs)
        keyframeLimit: 3,        // three keyframe asks, then the transport is restarted
        keyframeIntervalMs: 2000,// the server takes one keyframe ask per consumer every 2 s
        restartAfterMs: 8000,    // eight seconds of asking = restart the transport anyway
        rebuildAfterMs: 8000,    // a restarted transport gets eight seconds before a full rebuild
        silentMs: 20000,         // no video packets at all for this long = the transport may be dead: climb the ladder
        telemetryMs: 5000,       // one telemetry message every five seconds
        pollMs: 1000,            // how often the decoder's numbers are read
    };

    const STAGE_LABEL = {
        0: 'playing',
        1: 'asking for a keyframe',
        2: 'restarting the transport',
        3: 'rebuilding the session',
    };

    /* ── the recovery ladder ─────────────────────────────────────────────── */

    /**
     * The recovery ladder. Pure: it takes the time from opts.now() and returns the next step.
     *   markFrame()      a new decoded frame arrived (the picture moved)
     *   setConnected()   the transport is up (or down)
     *   tick()           → { action: 'keyframe' | 'restart-transport' | 'rebuild' | 'wait' | 'none' }
     */
    function createLadder(opts = {}) {
        const now = opts.now || (() => Date.now());
        const th = Object.assign({}, T, opts.thresholds || {});
        // A fresh transport that follows a ladder restart starts at stage 2: the keyframe asks
        // were already spent on the previous transport, so a still-frozen picture rebuilds the
        // whole session after the stage-2 grace period instead of asking all over again.
        let stage = Math.max(0, Math.min(3, Number(opts.startStage) || 0));
        let stageAt = now();
        let lastFrameAt = now();
        let lastAskAt = 0;
        let keyframeAsks = 0;
        let freezeCount = 0;
        let freezeMs = 0;
        let freezeStartedAt = 0;
        let connected = false;
        // Video packets since the last decoded frame, and when the last one came. A still picture with no packets is a
        // quiet sender (a static screen share sends frames only when something changes), not a frozen decoder: the
        // ladder climbs only when packets arrive and no frame decodes, or when nothing at all has arrived for silentMs.
        let packetsSinceFrame = false;
        let lastPacketAt = now();

        const closeFreeze = (at) => {
            if (!freezeStartedAt) return;
            freezeMs += Math.max(0, at - freezeStartedAt);
            freezeStartedAt = 0;
        };

        return {
            thresholds: th,
            get stage() { return stage; },
            get stageLabel() { return STAGE_LABEL[stage] || 'playing'; },
            get keyframeAsks() { return keyframeAsks; },
            get freezeCount() { return freezeCount; },
            /** Total time the picture stood still, including the freeze that is running now. */
            get freezeMs() { return freezeMs + (freezeStartedAt ? Math.max(0, now() - freezeStartedAt) : 0); },
            get connected() { return connected; },
            get stalledFor() { return now() - lastFrameAt; },
            /** The transport is up (or went down): a fresh transport has not delivered a frame yet. */
            setConnected(v) {
                const next = !!v;
                if (next === connected) return;
                connected = next;
                if (connected) { lastFrameAt = now(); lastPacketAt = now(); packetsSinceFrame = false; }
                else { stage = 0; stageAt = 0; keyframeAsks = 0; lastAskAt = 0; }
            },
            /** A new decoded frame: the picture moved. */
            markFrame(at) {
                const t0 = typeof at === 'number' ? at : now();
                lastFrameAt = t0;
                packetsSinceFrame = false;
                if (stage !== 0) { stage = 0; stageAt = 0; keyframeAsks = 0; lastAskAt = 0; }
                closeFreeze(t0);
            },
            /** Video packets arrived (the inbound packet count rose). */
            markPackets(at) {
                lastPacketAt = typeof at === 'number' ? at : now();
                packetsSinceFrame = true;
            },
            /** One step of the ladder. Returns what the caller should do now. */
            tick() {
                const t0 = now();
                if (!connected) return { action: 'none', stage, reason: 'not-connected', stalledFor: 0 };
                const stalledFor = t0 - lastFrameAt;
                if (stalledFor < th.freezeMs) {
                    closeFreeze(t0);
                    return { action: 'none', stage, stalledFor };
                }
                // Nothing arrived since the last frame and not for long: a quiet sender, not a freeze.
                if (!packetsSinceFrame && t0 - lastPacketAt < th.silentMs) {
                    closeFreeze(t0);
                    return { action: 'none', stage, stalledFor, reason: 'quiet' };
                }
                // A freeze lasts from the moment the picture stopped. The 2 s threshold is the
                // server's rule for calling it a freeze; the duration is measured from the stop.
                if (!freezeStartedAt) {
                    freezeStartedAt = lastFrameAt;
                    freezeCount++;
                }
                if (stage === 0) {
                    stage = 1; stageAt = t0; keyframeAsks = 1; lastAskAt = t0;
                    return { action: 'keyframe', stage, stalledFor, keyframeAsks };
                }
                if (stage === 1) {
                    if (keyframeAsks >= th.keyframeLimit || t0 - stageAt >= th.restartAfterMs) {
                        stage = 2; stageAt = t0;
                        return { action: 'restart-transport', stage, stalledFor, keyframeAsks };
                    }
                    if (t0 - lastAskAt >= th.keyframeIntervalMs) {
                        keyframeAsks++; lastAskAt = t0;
                        return { action: 'keyframe', stage, stalledFor, keyframeAsks };
                    }
                    return { action: 'wait', stage, stalledFor, keyframeAsks };
                }
                if (stage === 2) {
                    if (t0 - stageAt >= th.rebuildAfterMs) {
                        stage = 3; stageAt = t0;
                        return { action: 'rebuild', stage, stalledFor, keyframeAsks };
                    }
                    return { action: 'wait', stage, stalledFor, keyframeAsks };
                }
                return { action: 'wait', stage, stalledFor, keyframeAsks };
            },
        };
    }

    /* ── the telemetry sample ───────────────────────────────────────────── */

    const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
    const str = (v, max = 64) => (typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, max) : '');

    /**
     * The numbers we send every 5 s, read from the browser's own RTCInboundRtpStreamStats.
     * Everything is optional: a browser that does not report a field simply leaves it out.
     */
    function readStats(sample) {
        const s = sample || {};
        return {
            framesDecoded: num(s.framesDecoded),
            framesDropped: num(s.framesDropped),
            framesPerSecond: num(s.framesPerSecond),
            packetsReceived: num(s.packetsReceived),
            packetsLost: num(s.packetsLost),
            jitter: num(s.jitter),
            jitterBufferDelay: num(s.jitterBufferDelay),
            nackCount: num(s.nackCount),
            pliCount: num(s.pliCount),
            decoderImplementation: str(s.decoderImplementation, 48),
            codecId: str(s.codecId, 24),
        };
    }

    /** A telemetry message, ready to be sent over the signaling websocket. */
    function buildTelemetry({ streamId, stats = {}, freezeCount = 0, freezeMs = 0, codec = '', decoder = '' }) {
        return {
            type: 'sfu-viewer-telemetry',
            streamId: str(streamId, 32),
            data: {
                ...readStats(stats),
                codec: str(codec || stats.codecId, 32),
                decoder: str(decoder || stats.decoderImplementation, 48),
                freezeCount: num(freezeCount) || 0,
                freezeMs: num(freezeMs) || 0,
                at: Date.now(),
            },
        };
    }

    /* ── the freeze notice ──────────────────────────────────────────────── */

    let noticeEl = null;
    let styleEl = null;

    function ensureStyles() {
        if (styleEl || typeof document === 'undefined') return;
        styleEl = document.createElement('style');
        styleEl.id = 'ov-viewer-health-style';
        styleEl.textContent = [
            '.ov-freeze-notice{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);z-index:40;',
            'display:flex;align-items:center;gap:10px;max-width:min(92%,420px);padding:9px 12px;border-radius:10px;',
            'background:rgba(12,12,16,.86);color:#fff;font:13px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;',
            'box-shadow:0 6px 20px rgba(0,0,0,.35)}',
            '.ov-freeze-notice[hidden]{display:none}',
            '.ov-freeze-notice-text{flex:1 1 auto;min-width:0}',
            '.ov-freeze-notice b{display:block;font-weight:600}',
            '.ov-freeze-notice small{opacity:.75;font-size:11px}',
            '.ov-freeze-notice button{flex:0 0 auto;border:1px solid rgba(255,255,255,.35);background:rgba(255,255,255,.1);',
            'color:#fff;border-radius:7px;padding:5px 9px;font:inherit;font-size:12px;cursor:pointer}',
            '.ov-freeze-notice button:hover{background:rgba(255,255,255,.2)}',
        ].join('');
        (document.head || document.documentElement).appendChild(styleEl);
    }

    /**
     * Show the "The picture froze. Reconnecting…" line with its Copy debug info button.
     * Returns the notice element (so the caller can remove it).
     */
    function showFreezeNotice({ container, title = 'The picture froze. Reconnecting…', detail = '', onCopy }) {
        if (typeof document === 'undefined') return null;
        ensureStyles();
        // The host can be a function: a picture that moved into the mini player must show its
        // notice in the mini player, not in the page it came from.
        const host = (typeof container === 'function' ? container() : container) || document.body;
        if (!host) return null;
        if (!noticeEl || noticeEl.parentElement !== host) {
            if (noticeEl && noticeEl.parentElement) { try { noticeEl.remove(); } catch { /* */ } }
            noticeEl = document.createElement('div');
            noticeEl.className = 'ov-freeze-notice';
            noticeEl.setAttribute('role', 'status');
            const text = document.createElement('div');
            text.className = 'ov-freeze-notice-text';
            const b = document.createElement('b');
            const small = document.createElement('small');
            text.appendChild(b);
            text.appendChild(small);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = 'Copy debug info';
            btn.addEventListener('click', () => { try { onCopy && onCopy(); } catch (e) { /* nothing to do */ } });
            noticeEl.appendChild(text);
            noticeEl.appendChild(btn);
            noticeEl._title = b;
            noticeEl._detail = small;
        }
        noticeEl._title.textContent = title;
        noticeEl._detail.textContent = detail || '';
        if (!noticeEl.parentElement) host.appendChild(noticeEl);
        noticeEl.hidden = false;
        return noticeEl;
    }

    function hideFreezeNotice() {
        if (noticeEl) noticeEl.hidden = true;
    }

    /* ── the debug report ───────────────────────────────────────────────── */

    /**
     * The report the "Copy debug info" button copies. It names the stream, the time, the browser,
     * the codec and the decoder, the last telemetry sample and the recovery steps taken — and
     * nothing else: no token, no cookie, no account, no personal data.
     */
    function buildDebugReport({ streamId, codec, decoder, telemetry, steps, browser, at }) {
        const t = telemetry || {};
        const lines = [
            'OpenVibe.Live viewer report',
            `time=${new Date(at || Date.now()).toISOString()}`,
            `stream_id=${streamId || 'unknown'}`,
            `browser=${browser || (typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown')}`,
            `codec=${codec || t.codec || 'unknown'}`,
            `decoder=${decoder || t.decoder || t.decoderImplementation || 'unknown'}`,
            'last_sample:',
        ];
        const fields = ['framesDecoded', 'framesDropped', 'framesPerSecond', 'packetsReceived', 'packetsLost',
            'jitter', 'jitterBufferDelay', 'nackCount', 'pliCount', 'freezeCount', 'freezeMs'];
        for (const f of fields) {
            if (t[f] !== undefined && t[f] !== null) lines.push(`  ${f}=${t[f]}`);
        }
        lines.push('recovery:');
        const list = steps && steps.length ? steps : ['(nothing yet)'];
        for (const s of list) lines.push(`  - ${s}`);
        return lines.join('\n');
    }

    /* ── the monitor ────────────────────────────────────────────────────── */

    /**
     * Watches one playback session: reads the decoder's numbers, keeps the ladder, sends the
     * telemetry and shows the notice.
     *
     *   getReceiver()      → the RTCRtpReceiver (or null)
     *   send(message)      → send one signaling message
     *   codec              → the negotiated codec, e.g. "video/H264"
     *   restartTransport() → a fresh receive transport (ladder step 2)
     *   rebuild()          → a whole new viewer session (ladder step 3)
     */
    function createMonitor(opts = {}) {
        const now = opts.now || (() => Date.now());
        const ladder = createLadder({ now, thresholds: opts.thresholds, startStage: opts.startStage });
        const steps = [];
        let timer = null;
        let lastStats = null;
        let lastFramesDecoded = null;
        let lastPacketsReceived = null;
        let lastSampleAt = 0;
        let stopped = false;
        let polling = false;

        const note = (step) => {
            steps.push(`${new Date(now()).toISOString()} — ${step}`);
            if (steps.length > 20) steps.splice(0, steps.length - 20);
        };

        /** A new decoded frame: the picture moved. The first one also means the media flows. */
        const noteFrame = () => {
            if (!ladder.connected) ladder.setConnected(true);
            ladder.markFrame();
            hideFreezeNotice();
            if (opts.onFrame) { try { opts.onFrame(); } catch { /* the caller's bookkeeping never breaks playback */ } }
        };

        const readReceiverStats = async () => {
            const receiver = opts.getReceiver && opts.getReceiver();
            if (!receiver || typeof receiver.getStats !== 'function') return null;
            try {
                const stats = await receiver.getStats();
                let inbound = null;
                if (stats && typeof stats.forEach === 'function') {
                    stats.forEach((r) => {
                        if (r && r.type === 'inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) inbound = r;
                    });
                }
                return inbound || null;
            } catch { return null; }
        };

        const poll = async () => {
            // getStats() can take longer than the 1 s tick under load; a second poll must not
            // tick the same ladder twice and ask for two keyframes.
            if (stopped || polling) return;
            polling = true;
            try {
                const sample = await readReceiverStats();
                if (stopped) return;
                // No video receiver (an audio-only stream) or no stats yet: nothing to judge, so the ladder waits.
                if (!sample) return;
                lastStats = sample;
                const pr = num(sample.packetsReceived);
                if (pr !== null && lastPacketsReceived !== null && pr > lastPacketsReceived) ladder.markPackets();
                if (pr !== null) lastPacketsReceived = pr;
                const fd = num(sample.framesDecoded);
                if (fd !== null && fd !== lastFramesDecoded) {
                    lastFramesDecoded = fd;
                    noteFrame();
                }
                const step = ladder.tick();
                if (step.action === 'keyframe') {
                    note('asked for a keyframe');
                    if (opts.onStage) opts.onStage(1, step);
                    showNotice();
                    if (opts.send) opts.send({ type: 'sfu-viewer-keyframe' });
                } else if (step.action === 'restart-transport') {
                    note('restarted the receive transport');
                    if (opts.onStage) opts.onStage(2, step);
                    showNotice();
                    if (opts.restartTransport) opts.restartTransport();
                } else if (step.action === 'rebuild') {
                    note('rebuilt the viewer session');
                    if (opts.onStage) opts.onStage(3, step);
                    showNotice();
                    if (opts.rebuild) opts.rebuild();
                }
                // The telemetry goes out every 5 s, whatever the ladder is doing.
                if (now() - lastSampleAt >= T.telemetryMs) {
                    lastSampleAt = now();
                    sendTelemetry();
                }
            } finally {
                polling = false;
            }
        };

        const sendTelemetry = () => {
            if (!opts.send) return;
            const t = buildTelemetry({
                streamId: opts.streamId,
                stats: lastStats || {},
                freezeCount: ladder.freezeCount,
                freezeMs: ladder.freezeMs,
                codec: opts.codec,
                decoder: lastStats ? lastStats.decoderImplementation : '',
            });
            try { opts.send(t); } catch { /* the socket is gone; the ladder still runs */ }
        };

        const showNotice = () => {
            if (!opts.notice) return;
            showFreezeNotice({
                container: opts.notice,
                title: 'The picture froze. Reconnecting…',
                detail: `Step: ${ladder.stageLabel}`,
                onCopy: () => {
                    const text = buildDebugReport({
                        streamId: opts.streamId,
                        codec: opts.codec,
                        decoder: lastStats ? lastStats.decoderImplementation : '',
                        telemetry: {
                            ...(lastStats ? readStats(lastStats) : {}),
                            freezeCount: ladder.freezeCount,
                            freezeMs: ladder.freezeMs,
                        },
                        steps,
                    });
                    copyText(text);
                    if (opts.onCopy) opts.onCopy(text);
                },
            });
        };

        return {
            ladder,
            get steps() { return steps.slice(); },
            get lastStats() { return lastStats; },
            /** The transport is up: the ladder starts counting from now. */
            connected() { ladder.setConnected(true); },
            /** The transport is gone: no ladder steps until it is back. */
            disconnected() { ladder.setConnected(false); },
            /** A new frame arrived outside the stats (requestVideoFrameCallback): the picture moved. */
            markFrame() { noteFrame(); },
            start() {
                if (timer || stopped) return;
                timer = setInterval(() => { poll().catch(() => {}); }, T.pollMs);
            },
            stop() {
                stopped = true;
                if (timer) { clearInterval(timer); timer = null; }
                hideFreezeNotice();
            },
            /** One poll by hand (the test drives it, and a page that comes back to the front polls at once). */
            poll,
            report() {
                return buildDebugReport({
                    streamId: opts.streamId,
                    codec: opts.codec,
                    decoder: lastStats ? lastStats.decoderImplementation : '',
                    telemetry: {
                        ...(lastStats ? readStats(lastStats) : {}),
                        freezeCount: ladder.freezeCount,
                        freezeMs: ladder.freezeMs,
                    },
                    steps,
                });
            },
        };
    }

    /** Copy text to the clipboard, with the old execCommand path for browsers without the async API. */
    function copyText(text) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).catch(() => {});
                return true;
            }
        } catch { /* fall through */ }
        try {
            const el = document.createElement('textarea');
            el.value = text;
            el.style.position = 'fixed';
            el.style.opacity = '0';
            document.body.appendChild(el);
            el.focus();
            el.select();
            document.execCommand('copy');
            el.remove();
            return true;
        } catch { return false; }
    }

    window.OVViewerHealth = {
        thresholds: T,
        createLadder,
        createMonitor,
        readStats,
        buildTelemetry,
        buildDebugReport,
        showFreezeNotice,
        hideFreezeNotice,
        copyText,
    };
})();
