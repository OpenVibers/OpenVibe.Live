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
        /** @type {Map<string, RTCPeerConnection>} peerId → PC */
        viewerConnections: new Map(),
        viewerReconnectTimers: new Map(),
        _allowP2pFallback: false,
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

function startTrackKeepalive(streamId) {
    const ss = getStreamState(streamId);
    if (!ss?.localStream) return;
    stopTrackKeepalive(streamId);
    const videoTrack = ss.localStream.getVideoTracks()[0];
    if (!videoTrack || typeof ImageCapture === 'undefined') return;
    let capture;
    try { capture = new ImageCapture(videoTrack); } catch { return; }

    // Watchdog state
    let lastSuccessfulFrame = Date.now();
    let watchdogTriggered = false;
    const streamRef = ss.localStream; // capture reference for staleness check

    ss._trackKeepaliveInterval = setInterval(() => {
        const current = getStreamState(streamId);
        if (!current?.localStream || current.localStream !== streamRef) {
            stopTrackKeepalive(streamId);
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

function getBroadcastFrameRate() {
    const fps = parseInt(broadcastState.settings.broadcastFps, 10);
    return Number.isFinite(fps) && fps > 0 ? fps : 30;
}

function getTargetVideoBitrate() {
    const kbps = parseInt(broadcastState.settings.broadcastBps, 10);
    return (Number.isFinite(kbps) && kbps > 0 ? kbps : 2500) * 1000;
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
