'use strict';
/* ─────────────────────────────────────────────────────────────────
   broadcast-state.js — Global broadcast state, per-stream state
   factory, constants, track keepalive/watchdog, and wake lock.
   Must load before all other broadcast-*.js modules.
   ─────────────────────────────────────────────────────────────── */

/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Live — Broadcast (Go Live)
   Supports WebRTC (browser + OBS), RTMP, and JSMPEG methods.
   Multiple simultaneous WebRTC browser streams with different devices.
   ═══════════════════════════════════════════════════════════════ */

/**
 * Per-stream state — one entry per active broadcast stream.
 */
function createStreamState(streamData) {
    return {
        streamData,
        localStream: null,
        signalingWs: null,
        heartbeatInterval: null,
        startedAt: streamData?.started_at || null,
        lastStatBytes: 0,
        lastStatTime: 0,
        gainNode: null,
        audioContext: null,
        vodRecorder: null,
        vodChunks: [],
        vodUploading: false,
        vodFinalized: false,
        vodId: null,
        vodSegmentId: 0,
        // Per-stream signaling reconnect state
        signalingReconnectTimer: null,
        signalingIntentionalClose: false,
        signalingReconnectDelay: 3000,
        mediaRecoveryTimer: null,
        mediaRecoveryAttempts: 0,
        mediaRecoveryInProgress: false,
        _suppressRecovery: false, // set true during intentional track stops (flip cam, screen share toggle)
        _trackKeepaliveInterval: null,
        _recoveryStartedAt: 0,
        _lastRecoveryCompletedAt: 0,
        lastThumbnailAt: 0,
        thumbnailCanvas: null,
        thumbnailCtx: null,
        statsPollPending: false,
        robotStreamer: null,
        // Screen share + camera PiP composite state
        _screenStream: null,       // raw getDisplayMedia stream
        _cameraOverlayStream: null, // raw getUserMedia camera stream for PiP
        _compositeCanvas: null,
        _compositeCtx: null,
        _compositeAnimFrame: null,
        _cameraOverlayEnabled: false,
        // PiP position/size (fraction of canvas, 0-1 range) — draggable/resizable
        _pipX: 0.78,  // fractional X (top-left of PiP)
        _pipY: 0.72,  // fractional Y
        _pipW: 0.20,  // fractional width (20% of canvas)
        _pipDragging: false,
        _pipResizing: false,
    };
}

const BROADCAST_SIGNALING_MAX_BUFFERED_AMOUNT = 512 * 1024;
const BROADCAST_THUMBNAIL_INTERVAL_MS = 115000;

/**
 * Keep the PipeWire / v4l2loopback / xdg-desktop-portal capture pipeline
 * active by periodically consuming a video frame.  On Linux (Steam Deck,
 * PipeWire) the capture source can be dropped if no consumer reads frames
 * for several seconds — this heartbeat prevents that idle-timeout.
 *
 * ALSO serves as the primary health watchdog: if frame grabs fail for
 * WATCHDOG_DEAD_THRESHOLD_MS consecutive milliseconds, we consider the
 * stream truly dead and trigger recovery. This replaces the unreliable
 * track ended/inactive event approach — PipeWire on Steam Deck fires
 * spurious ended events every few minutes during normal Gamescope
 * compositing, power transitions, and GPU context switches.
 */
const KEEPALIVE_INTERVAL_MS = 1000;
const WATCHDOG_DEAD_THRESHOLD_MS = 15000; // 15s of grabFrame failures with 'live' readyState
const WATCHDOG_ENDED_THRESHOLD_MS = 8000;  // 8s for track.readyState !== 'live' (definitive death)
// A phone has no PipeWire to keep awake, and copying a whole camera frame every second costs it battery: it counts the
// track's delivered frames instead (MediaStreamTrack stats, no copy), or grabs a frame every 5 s where those are missing.
const MOBILE_GRAB_EVERY_TICKS = 5;

/** A phone or tablet: a mobile browser (iPadOS says Macintosh, with a touch screen). */
function isMobileBroadcaster() {
    if (typeof navigator === 'undefined') return false;
    if (navigator.userAgentData && navigator.userAgentData.mobile) return true;
    const ua = navigator.userAgent || '';
    return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** Frames the camera has handed out so far (MediaStreamTrack video stats), or null where the browser has none. */
function _trackFrameCount(track) {
    try {
        const st = track && track.stats;
        if (st && typeof st.totalFrames === 'number') return st.totalFrames;
        if (st && typeof st.deliveredFrames === 'number') return st.deliveredFrames + (st.discardedFrames || 0);
    } catch { /* */ }
    return null;
}

function startTrackKeepalive(streamId) {
    const ss = getStreamState(streamId);
    if (!ss?.localStream) return;
    stopTrackKeepalive(streamId);
    let videoTrack = ss.localStream.getVideoTracks()[0];
    if (!videoTrack || typeof ImageCapture === 'undefined') return;
    let capture;
    try { capture = new ImageCapture(videoTrack); } catch { return; }

    // Watchdog state
    let lastSuccessfulFrame = Date.now();
    let watchdogTriggered = false;
    const streamRef = ss.localStream; // capture reference for staleness check
    const mobile = isMobileBroadcaster();
    let ticks = 0, lastFrameCount = null;

    ss._trackKeepaliveInterval = setInterval(() => {
        const current = getStreamState(streamId);
        if (!current?.localStream || current.localStream !== streamRef) {
            stopTrackKeepalive(streamId);
            return;
        }
        // A camera switch replaces the video track inside the same stream: watch the new one. Watching the
        // stopped one made every flip on a phone look like a dead camera 8 s later, and the recovery that
        // followed restarted the whole stream (owner, 2026-10-17).
        const nowTrack = streamRef.getVideoTracks()[0];
        if (nowTrack && nowTrack !== videoTrack) {
            videoTrack = nowTrack;
            try { capture = new ImageCapture(nowTrack); } catch { capture = null; }
            lastSuccessfulFrame = Date.now();
            watchdogTriggered = false;
        }

        // A phone pauses the camera of a tab in the background: no frames there is expected, and a recovery started
        // from the background cannot open the camera anyway (it failed four times and gave up while the streamer was in
        // another app). broadcast.js checks the camera the moment the tab is in front again.
        if (mobile && typeof document !== 'undefined' && document.hidden) {
            lastSuccessfulFrame = Date.now();
            watchdogTriggered = false;
            lastFrameCount = null;
            return;
        }

        // If recovery is already in progress or suppressed, just keep ticking
        if (current._suppressRecovery || current.mediaRecoveryInProgress || current.mediaRecoveryTimer) {
            lastSuccessfulFrame = Date.now(); // reset watchdog during recovery
            return;
        }

        // During cooldown after recovery, reset watchdog
        if (current._lastRecoveryCompletedAt && (Date.now() - current._lastRecoveryCompletedAt) < 60000) {
            lastSuccessfulFrame = Date.now();
            return;
        }

        // Check for unmute reset signal from mute/unmute event handlers
        if (current._watchdogResetRequested) {
            current._watchdogResetRequested = false;
            lastSuccessfulFrame = Date.now();
            watchdogTriggered = false;
        }

        if (videoTrack.readyState !== 'live') {
            // Track is definitively not live — use shorter threshold
            const deadDuration = Date.now() - lastSuccessfulFrame;
            if (deadDuration >= WATCHDOG_ENDED_THRESHOLD_MS && !watchdogTriggered) {
                watchdogTriggered = true;
                console.warn(`[Broadcast] Watchdog: video track dead for ${(deadDuration / 1000).toFixed(1)}s (readyState: ${videoTrack.readyState}) — triggering recovery`);
                scheduleMediaRecovery(streamId, 'video track dead (watchdog)');
            }
            return;
        }

        if (mobile) {
            // A camera the streamer turned off sends no frames on purpose.
            if (!videoTrack.enabled) { lastSuccessfulFrame = Date.now(); watchdogTriggered = false; lastFrameCount = null; return; }
            const count = _trackFrameCount(videoTrack);
            if (count != null) {
                if (lastFrameCount == null || count !== lastFrameCount) { lastSuccessfulFrame = Date.now(); watchdogTriggered = false; }
                lastFrameCount = count;
                const deadDuration = Date.now() - lastSuccessfulFrame;
                if (deadDuration >= WATCHDOG_DEAD_THRESHOLD_MS && !watchdogTriggered) {
                    watchdogTriggered = true;
                    console.warn(`[Broadcast] Watchdog: no camera frames for ${(deadDuration / 1000).toFixed(1)}s — triggering recovery`);
                    scheduleMediaRecovery(streamId, 'no camera frames (watchdog)');
                }
                return;
            }
            if (ticks++ % MOBILE_GRAB_EVERY_TICKS) return;
        }

        if (!capture) return;
        capture.grabFrame()
            .then(bmp => {
                bmp.close();
                lastSuccessfulFrame = Date.now();
                watchdogTriggered = false; // reset if we got a frame
            })
            .catch(() => {
                // Frame grab failed but track is still 'live' — PipeWire glitch
                // If track is muted, PipeWire is renegotiating — be patient
                const deadDuration = Date.now() - lastSuccessfulFrame;
                if (deadDuration >= WATCHDOG_DEAD_THRESHOLD_MS && !watchdogTriggered) {
                    watchdogTriggered = true;
                    const mutedNote = current._videoTrackMutedAt ? ` (muted for ${((Date.now() - current._videoTrackMutedAt) / 1000).toFixed(1)}s)` : '';
                    console.warn(`[Broadcast] Watchdog: frame grabs failing for ${(deadDuration / 1000).toFixed(1)}s${mutedNote} — triggering recovery`);
                    scheduleMediaRecovery(streamId, 'frame capture failed (watchdog)');
                }
            });
    }, KEEPALIVE_INTERVAL_MS);
    console.log(`[Broadcast] Track keepalive + watchdog started (${KEEPALIVE_INTERVAL_MS / 1000}s interval, ${WATCHDOG_ENDED_THRESHOLD_MS / 1000}s ended/${WATCHDOG_DEAD_THRESHOLD_MS / 1000}s stall threshold)`);
}

function stopTrackKeepalive(streamId) {
    const ss = getStreamState(streamId);
    if (ss?._trackKeepaliveInterval) {
        clearInterval(ss._trackKeepaliveInterval);
        ss._trackKeepaliveInterval = null;
        console.log('[Broadcast] Track keepalive stopped');
    }
}

/* ── Wake Lock ─────────────────────────────────────────────────
   Prevents the OS/browser from suspending media tracks when the
   tab is backgrounded or the device enters power-saving mode.
   ─────────────────────────────────────────────────────────────── */
let _wakeLockSentinel = null;

async function acquireWakeLock() {
    if (_wakeLockSentinel) return; // already held
    if (!('wakeLock' in navigator)) {
        console.log('[Broadcast] Wake Lock API not supported');
        return;
    }
    try {
        _wakeLockSentinel = await navigator.wakeLock.request('screen');
        console.log('[Broadcast] Wake Lock acquired');
        _wakeLockSentinel.addEventListener('release', () => {
            console.log('[Broadcast] Wake Lock released by system');
            _wakeLockSentinel = null;
            // Re-acquire if still broadcasting
            if (isStreaming()) acquireWakeLock();
        });
    } catch (err) {
        console.warn('[Broadcast] Wake Lock request failed:', err.message);
        _wakeLockSentinel = null;
    }
}

function releaseWakeLock() {
    if (_wakeLockSentinel) {
        _wakeLockSentinel.release().catch(() => {});
        _wakeLockSentinel = null;
        console.log('[Broadcast] Wake Lock released');
    }
}

// Re-acquire wake lock when the tab becomes visible again
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && isStreaming() && !_wakeLockSentinel) {
        acquireWakeLock();
    }
});

// Battery saver: 480p at 30 fps and at most 1 Mbps, whatever the slot asks. A setting of this device (its own
// localStorage key): broadcastState.settings also goes to the slot on the server, and a phone's saver must not follow
// the streamer to their computer.
const BATTERY_SAVER = { res: '480', fps: 30, kbps: 1000 };
const BATTERY_SAVER_KEY = 'openvibe_battery_saver';
let _batterySaver = (() => { try { return localStorage.getItem(BATTERY_SAVER_KEY) === '1'; } catch { return false; } })();
function batterySaverOn() { return _batterySaver; }
function setBatterySaver(on) {
    _batterySaver = !!on;
    try { localStorage.setItem(BATTERY_SAVER_KEY, _batterySaver ? '1' : '0'); } catch { /* this visit only */ }
}

function getBroadcastFrameRate() {
    if (_batterySaver) return BATTERY_SAVER.fps;
    const fps = parseInt(broadcastState.settings.broadcastFps, 10);
    return Number.isFinite(fps) && fps > 0 ? fps : 30;
}

/** The capture height asked for ('360' … '1440'). */
function getBroadcastResolution() {
    if (_batterySaver) return BATTERY_SAVER.res;
    return String(broadcastState.settings.broadcastRes || '720');
}

function getTargetVideoBitrate() {
    if (_batterySaver) return BATTERY_SAVER.kbps * 1000;
    const kbps = parseInt(broadcastState.settings.broadcastBps, 10);
    return (Number.isFinite(kbps) && kbps > 0 ? kbps : 2500) * 1000;
}

/**
 * What the SFU producer of the broadcast's video sends. The codec: the one chosen in settings, else H.264 on a phone or
 * tablet (its hardware encoder: VP8, the router's first, is a software encode on most phones and costs battery and
 * frames), else the router's first (VP8). Screen shares stay on the router's first. At most the target bitrate and the
 * chosen frame rate (the settings' Max Bitrate, FPS and Codec Preference never reached the encoder before).
 * @param {object} device - a loaded mediasoup-client Device
 */
function sfuVideoProduceOptions(device, track) {
    const s = broadcastState.settings;
    const codecs = (device && device.rtpCapabilities && device.rtpCapabilities.codecs) || [];
    const find = (name) => codecs.find((c) => c.kind === 'video' && String(c.mimeType).toLowerCase() === `video/${name}`) || null;
    const chosen = s.broadcastCodec === 'h264' || s.broadcastCodec === 'vp8' ? s.broadcastCodec : null;
    const want = chosen || (!s.screenShare && isMobileBroadcaster() ? 'h264' : null);
    const codec = want ? find(want) : null;
    const kbps = Math.round(getTargetVideoBitrate() / 1000);
    const opts = {
        track, stopTracks: false,
        encodings: [{ maxBitrate: kbps * 1000, maxFramerate: getBroadcastFrameRate() }],
        // Start near the target, so viewers get a sharp picture at once (the router gives VP8 this; H.264 had none).
        codecOptions: { videoGoogleStartBitrate: Math.min(2500, kbps) },
    };
    if (codec) opts.codec = codec;
    return opts;
}

/**
 * Under a slow network or a busy phone, keep the frame rate and drop resolution first (a camera), or keep the detail
 * (a screen share): the browser's default for a camera trades frames away, which reads as lag.
 */
async function applyVideoSenderPrefs(producer) {
    const sender = producer && producer.rtpSender;
    if (!sender || typeof sender.getParameters !== 'function') return;
    try {
        const params = sender.getParameters();
        params.degradationPreference = broadcastState.settings.screenShare ? 'maintain-resolution' : 'maintain-framerate';
        await sender.setParameters(params);
    } catch { /* an older browser: its default stands */ }
}

function getSuggestedScaleDown(settings) {
    const res = String(settings.broadcastRes || '720');
    const kbps = parseInt(settings.broadcastBps, 10) || 2500;
    if (res === '1440' && kbps < 5500) return 2;
    if (res === '1080' && kbps < 3500) return 1.5;
    if (res === '720' && kbps < 1200) return 1.25;
    return 1;
}

function optimizeOutgoingStream(streamId) {
    const ss = getStreamState(streamId);
    if (!ss || !ss.localStream) return;

    const settings = broadcastState.settings;
    const videoTrack = ss.localStream.getVideoTracks()[0] || null;
    const audioTrack = ss.localStream.getAudioTracks()[0] || null;

    if (videoTrack) {
        try { videoTrack.contentHint = settings.screenShare ? 'detail' : 'motion'; } catch {}
    }
    if (audioTrack) {
        try { audioTrack.contentHint = 'speech'; } catch {}
    }
}

let broadcastState = {
    /** @type {Map<number, object>} streamId → per-stream state */
    streams: new Map(),
    /** Which stream's preview is currently shown */
    activeStreamId: null,
    selectedMethod: 'webrtc',
    selectedWebRTCSub: 'browser',
    selectedBrowserSource: 'camera', // 'camera' or 'screen'

    // Settings (persisted to localStorage) — global across all streams
    settings: {
        ttsMode: 'site-wide', ttsVolume: 800, ttsPitch: 100, ttsRate: 10, ttsVoice: '', ttsDuration: 10, ttsNames: 'off', ttsQueue: 5,
        notificationVolume: 800, forceAudio: 'default', autoGain: false, echoCancellation: false, noiseSuppression: false,
        manualGainEnabled: false, manualGain: 100, force48kSampleRate: false,
        forceCamera: 'default', broadcastRes: '720', broadcastFps: '30', broadcastCodec: 'auto',
        broadcastBps: '2500', broadcastBpsMin: '500', broadcastLimit: 'restart', screenShare: false,
        // Screen share capture preferences (hints to getDisplayMedia)
        screenCaptureSource: 'auto',        // 'auto' | 'monitor' | 'window' | 'browser'
        screenSystemAudio: 'include',        // 'include' | 'exclude' | 'auto'
        screenSelfBrowser: 'exclude',        // 'exclude' | 'include'
        screenSurfaceSwitching: 'include',   // 'include' | 'exclude'
        screenPreferCurrentTab: false,       // whether to bias toward the current tab
        serverReconnect: true,
        micOnly: false,                      // mic-only mode (no video)
        cameraOnly: false,                   // camera-only mode (no audio)
        allowSounds: 'false', soundVolume: 800,
    },
    robotStreamer: {
        loaded: false,
        enabled: false,
        mirrorChat: true,
        hasToken: false,
        robotId: '',
        ownerId: '',
        streamName: '',
        ownerName: '',
        availableRobots: [],
    },
};

// Global display timers (stats + uptime) — always show active stream info
let _globalStatsInterval = null;
let _globalUptimeInterval = null;
