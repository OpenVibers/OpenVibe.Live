/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Live — Stream Player (JSMPEG / WebRTC / HLS)
   ═══════════════════════════════════════════════════════════════ */

let player = null;
let playerType = null;
// Bumped on every destroyPlayer(); WebRTC session closures capture the value at
// setup and bail if it changes, so a torn-down stream can't reconnect/clobber the
// player that replaced it (fixes "stuck loading" on fast stream switches).
let _playerGen = 0;

// mediasoup-client for SFU viewer consumption
let _mediasoupModulePromise = null;
let _mediasoupDevice = null;

async function loadMediasoupClient() {
    if (!_mediasoupModulePromise) {
        _mediasoupModulePromise = import('https://esm.sh/mediasoup-client@3.18.7');
        _mediasoupModulePromise.catch(() => { _mediasoupModulePromise = null; });
    }
    return _mediasoupModulePromise;
}

// Viewer manual play/pause intent. Tracked on the (persistent) <video> element so a
// stream reconnect — e.g. the streamer's connection cuts out and comes back — does NOT
// force a stream the viewer deliberately paused back into playback. Reset on every fresh
// stream load (initPlayer), set by the play/pause button, and enforced by a one-time
// 'play' listener that re-pauses any autoplay-attribute resume while intent is paused.
function viewerWantsPaused() {
    const v = document.getElementById('video-element');
    return !!(v && v._viewerPaused);
}
function setViewerPausedIntent(paused) {
    const v = document.getElementById('video-element');
    if (v) v._viewerPaused = !!paused;
}

// Module-level failure counter — prevents infinite reconnect loops
let _totalIceFailures = 0;
const MAX_ICE_FAILURES = 25;
// Guard: prevents concurrent handleSfuViewerReady() executions causing cascading re-watches
let _sfuViewerSetupInProgress = false;

// Clip recording state (rolling buffer for live clips)
let clipRecorder = null;
let clipHeaderChunk = null;  // First chunk contains the WebM EBML header — must be preserved
let clipChunks = [];
let clipStreamId = null;
let streamRef = null; // current stream object for clip recording
let clipSourceStream = null;
let clipRecorderMimeType = null;
let clipTimingBaseMs = 0;
let _jsmpegClipSetupTimer = null;
const CLIP_BUFFER_SECONDS = 30;
const externalScriptPromises = new Map();
const PLAYER_SIGNALING_MAX_BUFFERED_AMOUNT = 256 * 1024;
const PLAYER_VOLUME_KEY = 'openvibe_player_volume';
const PLAYER_MUTED_KEY = 'openvibe_player_muted';
const PLAYER_DIAGNOSTIC_EVENT_LIMIT = 80;
const PLAYER_PHASE_SLOW_TIMEOUTS = {
    signal: 8000,
    source: 10000,
    queue: 12000,
    engine: 7000,
    transport: 12000,
    buffer: 18000,
    reconnect: 15000,
};
const PLAYER_PHASE_SLOW_HINTS = {
    signal: 'The player is still opening the viewer session. If this hangs, the stream service or websocket path may be unavailable.',
    source: 'The broadcaster is live, but the source is still being attached for viewers.',
    queue: 'The live shell exists, but usable audio/video has not reached the viewer path yet.',
    engine: 'The playback engine is still loading. A browser extension, cached script error, or blocked dependency can stall here.',
    transport: 'ICE / DTLS negotiation is taking longer than expected. TURN or firewall issues are common causes here.',
    buffer: 'The player is connected but still waiting for usable frames or segments. This usually means the live source is not producing clean media yet.',
    reconnect: 'The player is retrying automatically. If this repeats, copy the diagnostics so we can see where the stream pipeline is stalling.',
};
const PLAYER_PHASE_DISPLAY_LABELS = {
    signal: 'Connecting',
    source: 'Finding stream',
    queue: 'Waiting for video',
    engine: 'Starting player',
    transport: 'Opening secure link',
    buffer: 'Finishing up',
    reconnect: 'Reconnecting',
    live: 'Live',
    error: 'Needs attention',
    ended: 'Stream ended',
};
const PLAYER_PHASE_BRIEF_COPY = {
    signal: 'Getting your viewer ready.',
    source: 'The stream is online and warming up.',
    queue: 'Looking for the live feed.',
    engine: 'Starting the playback engine.',
    transport: 'Opening a secure media path.',
    buffer: 'Bringing in the first live moments.',
    reconnect: 'Trying again automatically.',
    live: 'Everything is flowing.',
    error: 'Something interrupted playback.',
    ended: 'Thanks for hanging out.',
};
const PLAYER_STEP_LABELS = {
    signal: 'Signal',
    source: 'Source',
    engine: 'Engine',
    transport: 'Transport',
    buffer: 'Buffer',
    live: 'Live',
};
const PLAYER_STEP_SETS = {
    webrtc: ['signal', 'source', 'engine', 'transport', 'buffer', 'live'],
    hls: ['signal', 'engine', 'buffer', 'live'],
    rtmp: ['signal', 'engine', 'buffer', 'live'],
    flv: ['signal', 'engine', 'buffer', 'live'],
    jsmpeg: ['engine', 'transport', 'buffer', 'live'],
    default: ['signal', 'buffer', 'live'],
};
const PLAYER_PHASE_TO_STEP = {
    idle: 'signal',
    signal: 'signal',
    source: 'source',
    queue: 'source',
    engine: 'engine',
    transport: 'transport',
    buffer: 'buffer',
    reconnect: 'signal',
    live: 'live',
    error: 'buffer',
    ended: 'live',
};

let playerLoadState = null;
let _playerSlowTimer = null;
let _playerPlaceholderHideTimer = null;

function _escapePlayerHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function _getPlayerProtocolLabel(protocol) {
    switch (protocol) {
        case 'webrtc': return 'WebRTC SFU';
        case 'jsmpeg': return 'JSMPEG Relay';
        case 'flv': return 'HTTP-FLV';
        case 'rtmp':
        case 'hls': return 'HLS / RTMP';
        default: return 'Live Stream';
    }
}

function _getPlayerPhaseDisplayLabel(phase) {
    return PLAYER_PHASE_DISPLAY_LABELS[phase] || 'Loading';
}

function _getPlayerBriefCopy(phase) {
    return PLAYER_PHASE_BRIEF_COPY[phase] || 'Getting things ready.';
}

function _createPlayerLoadState(protocol = 'default', stream = null) {
    return {
        sessionId: Math.random().toString(36).slice(2, 10),
        protocol,
        streamId: stream?.id || null,
        streamSlug: stream?.slug || stream?.stream_slug || stream?.endpoint?.slug || '',
        phase: 'signal',
        title: 'Getting the stream ready',
        detail: 'Preparing the live player.',
        hint: '',
        severity: 'info',
        showDiagnostics: false,
        isSlow: false,
        startedAt: Date.now(),
        events: [],
    };
}

function _ensurePlayerLoadState(protocol = playerType || streamRef?.protocol || 'default', stream = streamRef) {
    const streamId = stream?.id || null;
    if (!playerLoadState || playerLoadState.protocol !== protocol || playerLoadState.streamId !== streamId) {
        playerLoadState = _createPlayerLoadState(protocol, stream);
    }
    return playerLoadState;
}

function _clearPlayerSlowTimer() {
    if (_playerSlowTimer) {
        clearTimeout(_playerSlowTimer);
        _playerSlowTimer = null;
    }
}

function _clearPlayerPlaceholderHideTimer() {
    if (_playerPlaceholderHideTimer) {
        clearTimeout(_playerPlaceholderHideTimer);
        _playerPlaceholderHideTimer = null;
    }
}

function _pushPlayerDiagnostic(event, detail = '') {
    const state = _ensurePlayerLoadState();
    state.events.push({ at: Date.now(), event, detail: String(detail || '') });
    if (state.events.length > PLAYER_DIAGNOSTIC_EVENT_LIMIT) {
        state.events.splice(0, state.events.length - PLAYER_DIAGNOSTIC_EVENT_LIMIT);
    }
}

function _resetPlayerLoadState(protocol = playerType || streamRef?.protocol || 'default', stream = streamRef) {
    _clearPlayerSlowTimer();
    playerLoadState = _createPlayerLoadState(protocol, stream);
    _pushPlayerDiagnostic('session.start', `${_getPlayerProtocolLabel(protocol)} session created`);
}

function _getPlayerStepStates(protocol, phase) {
    const steps = PLAYER_STEP_SETS[protocol] || PLAYER_STEP_SETS.default;
    const currentStep = PLAYER_PHASE_TO_STEP[phase] || 'signal';
    const currentIndex = Math.max(steps.indexOf(currentStep), 0);
    return steps.map((step, index) => ({
        key: step,
        label: PLAYER_STEP_LABELS[step] || step,
        state: index < currentIndex ? 'done' : (index === currentIndex ? 'current' : 'pending'),
    }));
}

function _getPlayerProgressMeta(protocol, phase) {
    const steps = PLAYER_STEP_SETS[protocol] || PLAYER_STEP_SETS.default;
    const currentStep = PLAYER_PHASE_TO_STEP[phase] || 'signal';
    const currentIndex = Math.max(steps.indexOf(currentStep), 0);
    const maxIndex = Math.max(steps.length - 1, 1);
    return {
        currentIndex,
        totalSteps: steps.length,
        progressPercent: phase === 'live' ? 100 : Math.round((currentIndex / maxIndex) * 100),
        stepText: phase === 'live' ? 'Ready to watch' : `Step ${Math.min(currentIndex + 1, steps.length)} of ${steps.length}`,
    };
}

function _collectPlayerRuntimeSnapshot() {
    const video = document.getElementById('video-element');
    const stream = video?.srcObject;
    const tracks = stream?.getTracks?.() || [];
    return {
        page: window.location.href,
        readyState: video?.readyState ?? 'n/a',
        networkState: video?.networkState ?? 'n/a',
        paused: video ? String(video.paused) : 'n/a',
        muted: video ? String(video.muted) : 'n/a',
        currentTime: video?.currentTime != null ? Number(video.currentTime).toFixed(2) : 'n/a',
        videoSize: video ? `${video.videoWidth || 0}x${video.videoHeight || 0}` : 'n/a',
        signalingWs: player?.ws ? player.ws.readyState : 'n/a',
        sfuTransport: player?._sfuRecvTransport?.connectionState || 'n/a',
        legacyPc: player?.pc?.iceConnectionState || 'n/a',
        trackSummary: tracks.length
            ? tracks.map((track) => `${track.kind}:${track.readyState}:muted=${track.muted}:enabled=${track.enabled}`).join(', ')
            : 'none',
        networkHint: navigator.connection?.effectiveType || 'unknown',
    };
}

function _buildPlayerDiagnosticsText() {
    const state = _ensurePlayerLoadState();
    const snapshot = _collectPlayerRuntimeSnapshot();
    const lines = [
        'OpenVibe.Live playback diagnostics',
        `session=${state.sessionId}`,
        `stream_id=${state.streamId || 'unknown'}`,
        `stream_slug=${state.streamSlug || 'unknown'}`,
        `protocol=${state.protocol}`,
        `phase=${state.phase}`,
        `title=${state.title}`,
        `detail=${state.detail || '-'}`,
        `hint=${state.hint || '-'}`,
        `page=${snapshot.page}`,
        `ready_state=${snapshot.readyState}`,
        `network_state=${snapshot.networkState}`,
        `paused=${snapshot.paused}`,
        `muted=${snapshot.muted}`,
        `current_time=${snapshot.currentTime}`,
        `video_size=${snapshot.videoSize}`,
        `signaling_ws=${snapshot.signalingWs}`,
        `sfu_transport=${snapshot.sfuTransport}`,
        `legacy_pc=${snapshot.legacyPc}`,
        `tracks=${snapshot.trackSummary}`,
        `network_hint=${snapshot.networkHint}`,
        `user_agent=${navigator.userAgent}`,
        'events:',
    ];
    for (const entry of state.events) {
        lines.push(`- ${new Date(entry.at).toISOString()} | ${entry.event}${entry.detail ? ` | ${entry.detail}` : ''}`);
    }
    return lines.join('\n');
}

async function copyPlayerDiagnostics() {
    const text = _buildPlayerDiagnosticsText();
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
        } else {
            const el = document.createElement('textarea');
            el.value = text;
            el.style.position = 'fixed';
            el.style.opacity = '0';
            document.body.appendChild(el);
            el.focus();
            el.select();
            document.execCommand('copy');
            el.remove();
        }
        if (typeof toast === 'function') toast('Playback diagnostics copied', 'success');
    } catch (err) {
        console.warn('[Player] Failed to copy diagnostics:', err.message);
        if (typeof toast === 'function') toast('Could not copy playback diagnostics', 'error');
    }
}

function reloadPlayerPage() {
    window.location.reload();
}

if (typeof window !== 'undefined') {
    window.copyPlayerDiagnostics = copyPlayerDiagnostics;
    window.reloadPlayerPage = reloadPlayerPage;
}

function _resetPlayerRevealState() {
    const container = document.getElementById('video-container');
    const placeholder = document.querySelector('.video-placeholder');
    const video = document.getElementById('video-element');
    const canvas = document.getElementById('video-canvas');

    _clearPlayerPlaceholderHideTimer();
    container?.classList.remove('player-handoff-active', 'player-handoff-complete');
    placeholder?.classList.remove('is-exiting');
    if (placeholder && placeholder.style.display === 'none' && playerLoadState?.phase !== 'live') {
        placeholder.style.display = '';
    }
    video?.classList.remove('is-revealed');
    canvas?.classList.remove('is-revealed');
}

function _revealPlayerSurface(surface = (playerType === 'jsmpeg' ? 'canvas' : 'video')) {
    const container = document.getElementById('video-container');
    const placeholder = document.querySelector('.video-placeholder');
    const video = document.getElementById('video-element');
    const canvas = document.getElementById('video-canvas');

    _clearPlayerPlaceholderHideTimer();
    container?.classList.remove('player-handoff-complete');
    container?.classList.add('player-handoff-active');

    if (surface === 'canvas') {
        canvas?.classList.add('is-revealed');
        video?.classList.remove('is-revealed');
    } else {
        video?.classList.add('is-revealed');
        canvas?.classList.remove('is-revealed');
    }

    requestAnimationFrame(() => {
        container?.classList.add('player-handoff-complete');
    });

    if (placeholder) {
        placeholder.style.display = '';
        placeholder.classList.add('is-exiting');
        _playerPlaceholderHideTimer = setTimeout(() => {
            placeholder.style.display = 'none';
            placeholder.classList.remove('is-exiting');
            _playerPlaceholderHideTimer = null;
        }, 520);
    }
}

function _ensurePlayerLoaderStructure(placeholder) {
    if (placeholder._playerLoaderEls?.shell && placeholder.contains(placeholder._playerLoaderEls.shell)) {
        return placeholder._playerLoaderEls;
    }

    placeholder.innerHTML = `
        <div class="player-loader-shell">
            <div class="player-loader-visual" aria-hidden="true">
                <div class="player-loader-halo halo-a"></div>
                <div class="player-loader-halo halo-b"></div>
                <div class="player-loader-orb orb-a"></div>
                <div class="player-loader-orb orb-b"></div>
                <div class="player-loader-core">
                    <div class="player-loader-core-ring"></div>
                    <div class="player-loader-core-dot"></div>
                </div>
                <div class="player-loader-grid"></div>
                <div class="player-loader-sheen"></div>
            </div>
            <div class="player-loader-copy">
                <div class="player-loader-kicker">
                    <span class="player-loader-badge"></span>
                    <span class="player-loader-meta"></span>
                </div>
                <div class="player-loader-summary">
                    <h3 class="player-loader-title"></h3>
                    <p class="player-loader-brief"></p>
                </div>
                <div class="player-loader-progress">
                    <div class="player-loader-progress-rail"><span class="player-loader-progress-fill"></span></div>
                    <div class="player-loader-steps"></div>
                </div>
                <div class="player-loader-expanded">
                    <p class="player-loader-detail"></p>
                    <p class="player-loader-hint">
                        <i class="fa-solid fa-wand-magic-sparkles"></i>
                        <span></span>
                    </p>
                    <div class="player-loader-actions">
                        <button class="player-loader-action" type="button" data-action="copy-diagnostics">
                            <i class="fa-solid fa-bug"></i> Copy debug info
                        </button>
                        <button class="player-loader-action secondary" type="button" data-action="reload-player">
                            <i class="fa-solid fa-rotate-right"></i> Refresh player
                        </button>
                        <button class="player-loader-action secondary" type="button" data-action="dismiss-player">
                            <i class="fa-solid fa-xmark"></i> Close notice
                        </button>
                    </div>
                    <details class="player-loader-diagnostics">
                        <summary>Technical details</summary>
                        <pre></pre>
                    </details>
                </div>
            </div>
        </div>`;

    placeholder._playerLoaderEls = {
        shell: placeholder.querySelector('.player-loader-shell'),
        badge: placeholder.querySelector('.player-loader-badge'),
        meta: placeholder.querySelector('.player-loader-meta'),
        title: placeholder.querySelector('.player-loader-title'),
        brief: placeholder.querySelector('.player-loader-brief'),
        progressFill: placeholder.querySelector('.player-loader-progress-fill'),
        steps: placeholder.querySelector('.player-loader-steps'),
        expanded: placeholder.querySelector('.player-loader-expanded'),
        detail: placeholder.querySelector('.player-loader-detail'),
        hint: placeholder.querySelector('.player-loader-hint'),
        hintText: placeholder.querySelector('.player-loader-hint span'),
        actions: placeholder.querySelector('.player-loader-actions'),
        diagnostics: placeholder.querySelector('.player-loader-diagnostics'),
        diagnosticsSummary: placeholder.querySelector('.player-loader-diagnostics summary'),
        diagnosticsPre: placeholder.querySelector('.player-loader-diagnostics pre'),
    };

    if (!placeholder._playerLoaderEls?.actionsListenerAttached) {
        const actionsEl = placeholder._playerLoaderEls.actions;
        if (actionsEl) {
            actionsEl.addEventListener('click', (event) => {
                const button = event.target.closest('button[data-action]');
                if (!button) return;
                const action = button.dataset.action;
                if (action === 'copy-diagnostics') {
                    copyPlayerDiagnostics();
                } else if (action === 'reload-player') {
                    reloadPlayerPage();
                } else if (action === 'dismiss-player') {
                    _hidePlayerPlaceholder();
                }
            });
            placeholder._playerLoaderEls.actionsListenerAttached = true;
        }
    }

    return placeholder._playerLoaderEls;
}

function _animatePlayerLoaderStatus(shell) {
    if (!shell) return;
    shell.classList.remove('is-phase-changing');
    void shell.offsetWidth;
    shell.classList.add('is-phase-changing');
    clearTimeout(shell._playerPhaseTimer);
    shell._playerPhaseTimer = setTimeout(() => {
        shell.classList.remove('is-phase-changing');
    }, 420);
}

function _renderPlayerPlaceholder() {
    const placeholder = document.querySelector('.video-placeholder');
    if (!placeholder) return;

    const state = _ensurePlayerLoadState();
    const protocol = state.protocol || 'default';
    const video = document.getElementById('video-element');
    if (_isVideoPlaybackLive(video) && state.phase !== 'ended') {
        state.phase = 'live';
        state.isSlow = false;
        state.showDiagnostics = false;
        _hidePlayerPlaceholder();
        return;
    }
    const steps = _getPlayerStepStates(protocol, state.phase);
    const progress = _getPlayerProgressMeta(protocol, state.phase);
    const showExpanded = state.isSlow || state.severity === 'error';
    const showTroubleshooting = showExpanded && (state.showDiagnostics || state.severity === 'error');
    const briefCopy = _getPlayerBriefCopy(state.phase);
    const renderSignature = `${state.phase}|${state.title}|${showExpanded}|${showTroubleshooting}|${state.severity}`;

    _clearPlayerPlaceholderHideTimer();
    placeholder.style.display = '';
    placeholder.classList.add('player-placeholder-rich');
    placeholder.classList.remove('is-exiting');
    placeholder.dataset.protocol = protocol;
    placeholder.dataset.phase = state.phase || 'signal';
    placeholder.dataset.severity = state.severity || 'info';

    const els = _ensurePlayerLoaderStructure(placeholder);
    if (placeholder.dataset.renderSignature !== renderSignature) {
        _animatePlayerLoaderStatus(els.shell);
        placeholder.dataset.renderSignature = renderSignature;
    }

    els.shell.classList.toggle('is-slow', state.isSlow);
    els.shell.classList.toggle('is-expanded', showExpanded);
    els.shell.classList.toggle('is-error', state.severity === 'error');
    els.badge.textContent = _getPlayerProtocolLabel(protocol);
    els.meta.textContent = showExpanded ? _getPlayerPhaseDisplayLabel(state.phase) : progress.stepText;
    els.title.textContent = state.title;
    els.brief.textContent = briefCopy;
    els.progressFill.style.width = `${progress.progressPercent}%`;
    els.steps.innerHTML = steps.map((step) => `<span class="player-loader-step is-${step.state}">${step.label}</span>`).join('');
    els.expanded.classList.toggle('is-visible', showExpanded);
    els.detail.textContent = state.detail || briefCopy;
    els.detail.classList.toggle('is-visible', showExpanded && !!state.detail);
    els.hintText.textContent = state.hint || '';
    els.hint.classList.toggle('is-visible', showExpanded && !!state.hint);
    els.actions.classList.toggle('is-visible', showTroubleshooting);
    els.diagnostics.classList.toggle('is-visible', showTroubleshooting);
    els.diagnosticsSummary.textContent = state.severity === 'error' ? 'Technical details' : 'Need help? Open technical details';
    els.diagnosticsPre.textContent = showTroubleshooting ? _buildPlayerDiagnosticsText() : '';
    if (showTroubleshooting) {
        els.diagnostics.open = state.severity === 'error';
    } else {
        els.diagnostics.open = false;
    }
}

function _setPlayerStatus({
    protocol = playerLoadState?.protocol || playerType || streamRef?.protocol || 'default',
    phase = 'signal',
    title = 'Getting the stream ready',
    detail = '',
    hint = '',
    severity = 'info',
    showDiagnostics = false,
    slowAfterMs,
} = {}) {
    const state = _ensurePlayerLoadState(protocol, streamRef);
    state.protocol = protocol;
    state.phase = phase;
    state.title = title;
    state.detail = detail;
    state.hint = hint;
    state.severity = severity;
    state.showDiagnostics = showDiagnostics || severity === 'error';
    state.isSlow = false;

    _pushPlayerDiagnostic(`phase.${phase}`, `${title}${detail ? ` — ${detail}` : ''}`);
    _renderPlayerPlaceholder();

    _clearPlayerSlowTimer();
    const slowThreshold = slowAfterMs === undefined ? PLAYER_PHASE_SLOW_TIMEOUTS[phase] : slowAfterMs;
    if (slowThreshold && severity !== 'error' && phase !== 'live' && phase !== 'ended') {
        _playerSlowTimer = setTimeout(() => {
            const currentState = _ensurePlayerLoadState(protocol, streamRef);
            if (currentState.phase !== phase || currentState.severity === 'error') return;
            currentState.isSlow = true;
            currentState.showDiagnostics = true;
            if (!currentState.hint) currentState.hint = PLAYER_PHASE_SLOW_HINTS[phase] || '';
            _pushPlayerDiagnostic(`phase.${phase}.slow`, `Exceeded ${slowThreshold}ms`);
            _renderPlayerPlaceholder();
        }, slowThreshold);
    }
}

function _hidePlayerPlaceholder(surface = (playerType === 'jsmpeg' ? 'canvas' : 'video')) {
    _revealPlayerSurface(surface);
    _clearPlayerSlowTimer();
    const placeholder = document.querySelector('.video-placeholder');
    if (placeholder) {
        placeholder.style.display = 'none';
        placeholder.classList.remove('is-exiting');
    }
    if (playerLoadState) {
        playerLoadState.phase = 'live';
        playerLoadState.isSlow = false;
        _pushPlayerDiagnostic('phase.live', 'Playback is rendering live media');
    }
}

function _isVideoPlaybackLive(video) {
    return !!video && !video.paused && !video.ended && video.readyState >= 3 && (video.currentTime > 0 || video.readyState >= 4);
}

function _maybeHidePlayerPlaceholderForLiveVideo(video) {
    if (_isVideoPlaybackLive(video)) {
        _hidePlayerPlaceholder();
        return true;
    }
    return false;
}

// DVR state (live stream seeking via server-side VOD recording)
let dvrState = {
    active: false,       // DVR feature is available (live VOD exists)
    isLive: true,        // Currently showing real-time stream (vs rewound)
    vodId: null,         // Live VOD ID
    vodFilename: null,   // Live VOD filename for HTTP src
    duration: 0,         // Current total duration (seconds) from server
    seekable: false,     // Seekable copy available
    pollTimer: null,     // Interval for polling live-info
    updateTimer: null,   // Interval for UI updates
    streamStartTime: 0,  // Stream start timestamp (ms)
    savedSrcObject: null, // WebRTC MediaStream saved when switching to DVR
    savedLivePlayer: null, // HLS/FLV player saved when switching to DVR
    seeking: false,      // User is dragging the DVR progress bar
};

function loadExternalScriptOnce(src) {
    if (!src) return Promise.reject(new Error('Missing script URL'));
    if (externalScriptPromises.has(src)) return externalScriptPromises.get(src);

    const promise = new Promise((resolve, reject) => {
        const key = encodeURIComponent(src);
        const existing = document.querySelector(`script[data-external-src="${key}"]`);
        if (existing) {
            if (existing.dataset.loaded === 'true') {
                resolve();
                return;
            }
            existing.addEventListener('load', () => resolve(), { once: true });
            existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
            return;
        }

        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.dataset.externalSrc = key;
        script.onload = () => {
            script.dataset.loaded = 'true';
            resolve();
        };
        script.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(script);
    }).catch((err) => {
        externalScriptPromises.delete(src);
        throw err;
    });

    externalScriptPromises.set(src, promise);
    return promise;
}

function getJsmpegBufferProfile() {
    const connectionType = navigator.connection?.effectiveType || '';
    if (connectionType === 'slow-2g' || connectionType === '2g') {
        return { videoBufferSize: 256 * 1024, audioBufferSize: 64 * 1024 };
    }
    return { videoBufferSize: 512 * 1024, audioBufferSize: 128 * 1024 };
}

/* ── Reconnecting indicator (overlay on video) ────────────────── */
function _showReconnectingIndicator() {
    if (document.getElementById('reconnecting-indicator')) return;
    const container = document.getElementById('video-container');
    if (!container) return;
    const el = document.createElement('div');
    el.id = 'reconnecting-indicator';
    el.style.cssText = 'position:absolute;top:12px;right:12px;z-index:25;background:rgba(0,0,0,0.7);color:#fbbf24;padding:6px 14px;border-radius:8px;font-size:0.85rem;display:flex;align-items:center;gap:8px;pointer-events:none;';
    el.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="font-size:0.9rem"></i> Reconnecting...';
    container.appendChild(el);
}

function _hideReconnectingIndicator() {
    document.getElementById('reconnecting-indicator')?.remove();
}

function sendPlayerSignal(msg) {
    if (!player?.ws || player.ws.readyState !== WebSocket.OPEN) return false;
    if (player.ws.bufferedAmount > PLAYER_SIGNALING_MAX_BUFFERED_AMOUNT) return false;
    player.ws.send(JSON.stringify(msg));
    return true;
}

function isValidIceServerUrl(url) {
    return /^(stun|turn|turns):[^/][^\s]*$/i.test(String(url || '').trim());
}

function sanitizeIceServers(iceServers) {
    if (!Array.isArray(iceServers)) return [];
    const sanitized = [];
    for (const server of iceServers) {
        if (!server || typeof server !== 'object') continue;
        const urls = server.urls;
        const candidates = Array.isArray(urls) ? urls : [urls];
        const validUrls = candidates
            .filter((url) => isValidIceServerUrl(url))
            .map((url) => String(url).trim());
        if (!validUrls.length) continue;
        const safeServer = { urls: validUrls.length === 1 ? validUrls[0] : validUrls };
        if (server.username) safeServer.username = server.username;
        if (server.credential) safeServer.credential = server.credential;
        sanitized.push(safeServer);
    }
    return sanitized;
}

function isMediaRecorderSupported() {
    return typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function';
}

function getLiveStreamElapsedSeconds() {
    if (dvrState.streamStartTime && Number.isFinite(dvrState.streamStartTime) && dvrState.streamStartTime > 0) {
        return Math.max(0, (Date.now() - dvrState.streamStartTime) / 1000);
    }

    const startedAt = streamRef?.started_at || streamRef?.created_at;
    if (startedAt) {
        const normalized = typeof startedAt === 'string' && !startedAt.includes('T')
            ? `${startedAt.replace(' ', 'T')}Z`
            : startedAt;
        const ts = new Date(normalized).getTime();
        if (Number.isFinite(ts) && ts > 0) {
            return Math.max(0, (Date.now() - ts) / 1000);
        }
    }

    return Math.max(0, CLIP_BUFFER_SECONDS);
}

function buildClipRecorderCandidates(stream) {
    const hasVideo = !!stream?.getVideoTracks?.().length;
    const hasAudio = !!stream?.getAudioTracks?.().length;
    const candidates = [];

    if (!hasVideo) return candidates;

    const pushCandidate = (mimeType, options = {}) => {
        candidates.push({ mimeType, options });
    };

    const canUse = (mimeType) => !mimeType || !isMediaRecorderSupported() || MediaRecorder.isTypeSupported(mimeType);

    if (hasAudio) {
        [
            'video/webm;codecs=vp9,opus',
            'video/webm;codecs=vp8,opus',
            'video/webm;codecs=vp8',
            'video/webm',
        ].forEach((mimeType) => {
            if (canUse(mimeType)) {
                pushCandidate(mimeType, { videoBitsPerSecond: 2500000, audioBitsPerSecond: 128000 });
            }
        });
    }

    [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
        '',
    ].forEach((mimeType) => {
        if (canUse(mimeType)) {
            pushCandidate(mimeType, { videoBitsPerSecond: 2200000 });
        }
    });

    return candidates;
}

function createClipRecorder(stream) {
    if (typeof MediaRecorder === 'undefined') {
        throw new Error('MediaRecorder is not available in this browser');
    }

    const candidates = buildClipRecorderCandidates(stream);
    if (!candidates.length) {
        throw new Error('No supported recording codecs for this media stream');
    }

    let lastError = null;
    for (const candidate of candidates) {
        try {
            const opts = { ...candidate.options };
            if (candidate.mimeType) opts.mimeType = candidate.mimeType;
            const recorder = new MediaRecorder(stream, opts);
            return { recorder, mimeType: candidate.mimeType || recorder.mimeType || 'video/webm', sourceStream: stream };
        } catch (err) {
            lastError = err;
        }
    }

    const videoTracks = stream?.getVideoTracks?.() || [];
    const audioTracks = stream?.getAudioTracks?.() || [];
    if (videoTracks.length && audioTracks.length && typeof MediaStream !== 'undefined') {
        try {
            const videoOnlyStream = new MediaStream(videoTracks);
            const videoOnlyCandidates = buildClipRecorderCandidates(videoOnlyStream);
            for (const candidate of videoOnlyCandidates) {
                try {
                    const opts = { ...candidate.options };
                    if (candidate.mimeType) opts.mimeType = candidate.mimeType;
                    const recorder = new MediaRecorder(videoOnlyStream, opts);
                    console.warn('[Clip] Falling back to video-only recording for compatibility');
                    return { recorder, mimeType: candidate.mimeType || recorder.mimeType || 'video/webm', sourceStream: videoOnlyStream };
                } catch (err) {
                    lastError = err;
                }
            }
        } catch (err) {
            lastError = err;
        }
    }

    throw lastError || new Error('Unable to initialize MediaRecorder');
}

// Client-side clip recording is only needed when the SERVER can't cut clips itself.
// When streamRef.server_clip is true, the browser skips the continuous MediaRecorder
// rolling buffer (and the JSMPEG/HLS canvas capture) entirely — a big CPU/battery win.
function _clientClipRecordingEnabled() { return !(streamRef && streamRef.server_clip); }
function startClipRecordingIfNeeded(stream, streamId) {
    if (!stream) return;
    if (!_clientClipRecordingEnabled()) return;
    if (clipRecorder && clipSourceStream === stream && clipStreamId === streamId) return;
    clipSourceStream = stream;
    startClipRecording(stream, streamId);
}

/**
 * Initialize the appropriate player based on stream protocol.
 * @param {Object} stream - Stream object with protocol, endpoint info
 */
// Dress the loading screen with the stream's own thumbnail (blurred) and a colour sampled
// from it, so the "connecting" state feels like a sleek preview of that streamer rather than
// a generic spinner.
function _applyLoaderThumb(stream) {
    const placeholder = document.querySelector('.video-placeholder');
    if (!placeholder) return;
    const thumb = stream && stream.thumbnail_url;
    // Reset any previous stream's theming.
    placeholder.classList.remove('has-thumb');
    ['--loader-thumb', '--loader-a', '--loader-c'].forEach(v => placeholder.style.removeProperty(v));
    if (!thumb) return;
    placeholder.style.setProperty('--loader-thumb', `url("${thumb}")`);
    placeholder.classList.add('has-thumb');
    try {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            try {
                // Cluster the thumbnail's colours by hue and pull the TWO strongest, most
                // saturated clusters → a real two-tone palette to theme the loader with.
                const S = 28;
                const cv = document.createElement('canvas'); cv.width = S; cv.height = S;
                const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0, S, S);
                const d = ctx.getImageData(0, 0, S, S).data;
                const bins = Array.from({ length: 12 }, () => ({ r: 0, g: 0, b: 0, w: 0 }));
                for (let i = 0; i < d.length; i += 4) {
                    if (d[i + 3] < 100) continue;
                    const r = d[i], g = d[i + 1], b = d[i + 2];
                    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), dlt = mx - mn;
                    if (mx < 30 || (mx > 236 && dlt < 22)) continue; // skip black / white-grey
                    let h = 0;
                    if (dlt > 0) {
                        if (mx === r) h = ((g - b) / dlt) % 6; else if (mx === g) h = (b - r) / dlt + 2; else h = (r - g) / dlt + 4;
                        h *= 60; if (h < 0) h += 360;
                    }
                    const sat = mx === 0 ? 0 : dlt / mx;
                    const w = sat * (dlt + 12);
                    const bin = Math.floor(h / 30) % 12;
                    bins[bin].r += r * w; bins[bin].g += g * w; bins[bin].b += b * w; bins[bin].w += w;
                }
                const cols = bins.filter(x => x.w > 0).map(x => ({ r: x.r / x.w, g: x.g / x.w, b: x.b / x.w, w: x.w })).sort((a, b) => b.w - a.w);
                if (cols.length && document.querySelector('.video-placeholder') === placeholder) {
                    const boost = c => Math.min(255, Math.round(c * 1.12 + 16));
                    const rgb = c => `rgb(${boost(c.r)}, ${boost(c.g)}, ${boost(c.b)})`;
                    const a = cols[0];
                    const c = cols[1] || cols[0];
                    const mid = { r: (a.r + c.r) / 2, g: (a.g + c.g) / 2, b: (a.b + c.b) / 2 };
                    placeholder.style.setProperty('--loader-a', rgb(a));
                    placeholder.style.setProperty('--loader-b', rgb(mid));
                    placeholder.style.setProperty('--loader-c', rgb(c));
                }
            } catch { /* tainted canvas (cross-origin) — blurred thumb still applies */ }
        };
        img.src = thumb;
    } catch { /* */ }
}

function initPlayer(stream) {
    destroyPlayer();
    setViewerPausedIntent(false); // fresh stream — always start playing
    streamRef = stream; // Store for clip recording across all protocols
    _resetPlayerRevealState();
    _applyLoaderThumb(stream);
    const proto = stream.protocol || 'jsmpeg';
    const endpoint = stream.endpoint || {};

    _resetPlayerLoadState(proto, stream);
    _setPlayerStatus({
        protocol: proto,
        phase: 'signal',
        title: 'Getting the stream ready',
        detail: 'Preparing the live player and checking which playback path to use.',
    });

    switch (proto) {
        case 'jsmpeg':
            initJSMPEG(endpoint, stream);
            break;
        case 'webrtc':
            initWebRTC(stream);
            break;
        case 'rtmp':
            initHLS(endpoint, stream);
            break;
        default:
            console.warn('Unknown protocol:', proto);
            initJSMPEG(endpoint, stream); // fallback
    }

    setupVideoControls();

    // Initialize DVR for all protocols — server-side recording handles JSMPEG & RTMP,
    // client-side chunked upload handles WebRTC
    initDVR(stream);
}

/* ── JSMPEG (FFmpeg → HTTP → WebSocket → Canvas) ─────────────── */
function initJSMPEG(endpoint, stream) {
    const canvas = document.getElementById('video-canvas');
    const placeholder = document.querySelector('.video-placeholder');

    // Build WS URL
    const host = window.location.hostname;
    const port = endpoint.videoPort || endpoint.video_port || endpoint.wsPort || 9710;
    const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${wsProtocol}://${host}:${port}`;
    const bufferProfile = getJsmpegBufferProfile();

    _setPlayerStatus({
        protocol: 'jsmpeg',
        phase: 'engine',
        title: 'Starting instant playback',
        detail: 'Preparing the JSMPEG decoder and websocket video relay.',
        hint: 'If this hangs, the relay script may be blocked or the websocket endpoint may still be starting.',
    });

    // Check if JSMpeg lib is loaded (local copy preferred, CDN fallback)
    if (typeof JSMpeg === 'undefined') {
        loadExternalScriptOnce('/js/jsmpeg.min.js').then(() => {
            _pushPlayerDiagnostic('jsmpeg.script', 'Loaded local JSMPEG bundle');
            startJSMPEG(wsUrl, canvas, placeholder, bufferProfile);
        }).catch(() => {
            // Local copy failed — try CDN fallback
            console.warn('[Player] Local jsmpeg.min.js failed, trying CDN');
            _pushPlayerDiagnostic('jsmpeg.script.fallback', 'Local JSMPEG bundle failed, trying CDN fallback');
            loadExternalScriptOnce('https://jsmpeg.com/jsmpeg.min.js').then(() => {
                _pushPlayerDiagnostic('jsmpeg.script', 'Loaded CDN JSMPEG bundle');
                startJSMPEG(wsUrl, canvas, placeholder, bufferProfile);
            }).catch(() => {
                console.error('Failed to load JSMpeg library');
                showStreamError('JSMPEG player not available. The decoder script could not be loaded.');
            });
        });
    } else {
        _pushPlayerDiagnostic('jsmpeg.script', 'Using preloaded JSMPEG bundle');
        startJSMPEG(wsUrl, canvas, placeholder, bufferProfile);
    }

    playerType = 'jsmpeg';
}

function startJSMPEG(wsUrl, canvas, placeholder, bufferProfile = getJsmpegBufferProfile()) {
    try {
        canvas.style.display = 'block';
        if (placeholder) placeholder.style.display = '';
        _setPlayerStatus({
            protocol: 'jsmpeg',
            phase: 'transport',
            title: 'Opening the live feed',
            detail: 'Connecting to the server-side MPEG-TS websocket relay for instant playback.',
            hint: 'If this stalls, the relay service may be offline or blocked by a proxy/firewall.',
        });

        if (_jsmpegClipSetupTimer) {
            clearTimeout(_jsmpegClipSetupTimer);
            _jsmpegClipSetupTimer = null;
        }

        player = new JSMpeg.Player(wsUrl, {
            canvas: canvas,
            autoplay: true,
            audio: true,
            videoBufferSize: bufferProfile.videoBufferSize,
            audioBufferSize: bufferProfile.audioBufferSize,
            preserveDrawingBuffer: true,
            onSourceEstablished: () => {
                console.log('[JSMPEG] Source established — applying saved volume and checking audio context');
                _setPlayerStatus({
                    protocol: 'jsmpeg',
                    phase: 'live',
                    title: 'You’re live',
                    detail: 'The decoder is receiving frames from the server relay.',
                    slowAfterMs: 0,
                });
                _hidePlayerPlaceholder('canvas');
                const audioPrefs = getSavedPlayerAudioState();
                if (player && player.audioOut && player.audioOut.gain) {
                    player.audioOut.gain.value = audioPrefs.muted ? 0 : audioPrefs.volume;
                }
                // Check if AudioContext is suspended (autoplay policy)
                const audioCtx = player?.audioOut?.context || player?.audioOut?.destination?.context;
                if (audioCtx && audioCtx.state === 'suspended' && !audioPrefs.muted) {
                    console.warn('[JSMPEG] AudioContext suspended — showing unmute overlay');
                    // Show unmute overlay on the canvas container
                    const container = document.getElementById('video-container');
                    if (container && !document.getElementById('unmute-overlay')) {
                        const overlay = document.createElement('div');
                        overlay.id = 'unmute-overlay';
                        overlay.style.cssText = 'position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;cursor:pointer;background:rgba(0,0,0,0.45);transition:background 0.2s;';
                        overlay.innerHTML = `
                            <div style="display:flex;flex-direction:column;align-items:center;gap:12px;">
                                <div style="width:72px;height:72px;border-radius:50%;background:rgba(255,255,255,0.15);border:2px solid rgba(255,255,255,0.6);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);transition:transform 0.15s,background 0.15s;">
                                    <i class="fa-solid fa-play" style="font-size:1.8rem;color:#fff;margin-left:4px;"></i>
                                </div>
                                <span style="color:#fff;font-size:0.9rem;opacity:0.85;text-shadow:0 1px 4px rgba(0,0,0,0.6);">Click to enable audio</span>
                            </div>`;
                        overlay.addEventListener('click', () => {
                            audioCtx.resume().then(() => {
                                console.log('[JSMPEG] AudioContext resumed by user click');
                            }).catch(() => {});
                            overlay.remove();
                        }, { once: true });
                        container.appendChild(overlay);
                    }
                }

                // Delay clip recording start so JSMpeg has time to decode & render
                // frames. Using an offscreen 2D canvas avoids WebGL captureStream issues.
                _jsmpegClipSetupTimer = setTimeout(() => {
                    _jsmpegClipSetupTimer = null;
                    // Server cuts clips from its own recording → skip the CPU-heavy 30fps
                    // canvas capture + rolling MediaRecorder on the viewer's machine.
                    if (!_clientClipRecordingEnabled()) return;
                    try {
                        const offCanvas = document.createElement('canvas');
                        offCanvas.width = canvas.width || 640;
                        offCanvas.height = canvas.height || 480;
                        const offCtx = offCanvas.getContext('2d');
                        if (!offCtx) throw new Error('Unable to create canvas context');
                        const clipStream = offCanvas.captureStream(30);

                        // Draw JSMpeg's canvas onto our offscreen 2D canvas at ~30fps
                        const _jsmpegDrawInterval = setInterval(() => {
                            if (canvas.width && canvas.height) {
                                if (offCanvas.width !== canvas.width) offCanvas.width = canvas.width;
                                if (offCanvas.height !== canvas.height) offCanvas.height = canvas.height;
                            }
                            offCtx.drawImage(canvas, 0, 0, offCanvas.width, offCanvas.height);
                        }, 33);
                        window._jsmpegDrawInterval = _jsmpegDrawInterval;

                        // Try to capture JSMpeg's Web Audio output for clip audio
                        try {
                            const audioCtx = player.audioOut?.context || player.audioOut?.destination?.context;
                            const gainNode = player.audioOut?.gain || player.audioOut;
                            if (audioCtx && gainNode && gainNode.connect) {
                                const audioDest = audioCtx.createMediaStreamDestination();
                                gainNode.connect(audioDest);
                                for (const track of audioDest.stream.getAudioTracks()) {
                                    clipStream.addTrack(track);
                                }
                                console.log('[JSMPEG] Audio capture attached to clip recorder');
                            }
                        } catch (audioErr) {
                            console.warn('[JSMPEG] Audio capture not available:', audioErr.message);
                        }
                        startClipRecordingIfNeeded(clipStream, streamRef?.id);
                    } catch (err) {
                        console.warn('[JSMPEG] Clip recording setup failed:', err.message);
                    }
                }, 2500); // Wait 2.5s for frames to be decoded & rendered
            },
            onSourceCompleted: () => {
                console.log('[JSMPEG] Source completed (stream ended?)');
                showStreamEnded();
            },
        });
    } catch (e) {
        console.error('JSMPEG init failed:', e);
        canvas.style.display = 'none';
        showStreamError('Failed to connect to the JSMPEG live relay.');
    }
}

/* ── WebRTC (Browser Broadcast via Signaling Relay) ───────────── */
async function initWebRTC(stream) {
    const video = document.getElementById('video-element');
    const placeholder = document.querySelector('.video-placeholder');
    streamRef = stream; // set module-level ref for clip recording in handleViewerOffer

    try {
        video.playsInline = true;
        video.preload = 'auto';
        // Keep placeholder visible ("Connecting to stream...") until video actually plays
        // The video element stays hidden until ontrack + playing event
        video.style.display = 'none';
        playerType = 'webrtc';

        // Status phase tracking — shown in the rich placeholder so the viewer can see what is happening.
        const _updateStatus = (text, options = {}) => {
            _setPlayerStatus({
                protocol: 'webrtc',
                phase: options.phase || 'signal',
                title: text,
                detail: options.detail || '',
                hint: options.hint || '',
                severity: options.severity || 'info',
                showDiagnostics: options.showDiagnostics || false,
                slowAfterMs: options.slowAfterMs,
            });
        };
        _updateStatus('Joining the stream', {
            phase: 'signal',
            detail: 'Connecting to the stream service and preparing a low-latency viewer session.',
            hint: 'If this hangs, the websocket path or stream service may be unavailable.',
        });

        // Connect to the broadcast signaling relay as a viewer
        const host = window.location.hostname;
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const portSuffix = window.location.port ? `:${window.location.port}` : '';
        const token = localStorage.getItem('token') || '';
        const wsUrl = `${protocol}://${host}${portSuffix}/ws/broadcast?streamId=${streamRef.id}&role=viewer&token=${token}`;

        const ws = new WebSocket(wsUrl);
        player = { ws, video, pc: null, myPeerId: null, watchSent: false, _wsUrl: wsUrl, _serverIceServers: null };
        const _myGen = _playerGen; // this session's generation; stale once destroyPlayer bumps it
        let _broadcasterDisconnectTimer = null;
        let _viewerReconnectTimer = null;
        let _viewerReconnectDelay = 3000; // exponential backoff: 3s → 30s max
        let _viewerIntentionalClose = false;
        let _viewerRewatchTimer = null;
        let _watchOfferTimer = null; // generic timeout: sent 'watch' but never got a usable response
        let _rewatchCount = 0;
        const MAX_REWATCH_ATTEMPTS = 12;

        // Start a timer when 'watch' is sent — if the server never acknowledges it with a
        // queue/source/transport response, re-request the watch session.
        const startWatchOfferTimeout = () => {
            if (_watchOfferTimer) clearTimeout(_watchOfferTimer);
            _watchOfferTimer = setTimeout(() => {
                _watchOfferTimer = null;
                if (!player || _viewerIntentionalClose || _myGen !== _playerGen) return;
                // Check total ICE failure cap first
                if (_totalIceFailures >= MAX_ICE_FAILURES) {
                    console.error('[Player] Too many total ICE failures — stream may require a TURN server');
                    showStreamError('Could not establish media connection. Your network may be blocking WebRTC traffic.');
                    return;
                }
                // No response received — the broadcaster or SFU publish path may still be warming up.
                if (_rewatchCount < MAX_REWATCH_ATTEMPTS) {
                    console.warn(`[Player] No watch response received within 6s (attempt ${_rewatchCount + 1}/${MAX_REWATCH_ATTEMPTS})`);
                    _updateStatus('Still warming up', {
                        phase: 'queue',
                        detail: 'The server has not acknowledged the viewer watch request yet. Retrying automatically.',
                        hint: 'If this keeps repeating, the broadcaster may still be spinning up the SFU publish transport.',
                        showDiagnostics: true,
                    });
                    scheduleViewerRewatch(500);
                } else {
                    console.error('[Player] Max rewatch attempts reached — stream may be unavailable');
                    showStreamError('Stream is not responding. Try refreshing the page.');
                }
            }, 6000);
        };

        const scheduleViewerRewatch = (delay = 1500) => {
            if (_viewerIntentionalClose || !player || _myGen !== _playerGen) return;
            if (_rewatchCount >= MAX_REWATCH_ATTEMPTS) {
                console.error('[Player] Max rewatch attempts reached, giving up');
                showStreamError('Could not connect to stream. Try refreshing the page.');
                return;
            }
            if (_viewerRewatchTimer) clearTimeout(_viewerRewatchTimer);
            _viewerRewatchTimer = setTimeout(() => {
                _viewerRewatchTimer = null;
                if (!player?.ws || player.ws.readyState !== WebSocket.OPEN) return;
                _rewatchCount++;
                player.watchSent = false;
                sendPlayerSignal({ type: 'watch' });
                player.watchSent = true;
                startWatchOfferTimeout();
            }, delay);
        };

        // Expose startWatchOfferTimeout on player so handleViewerOffer's triggerRewatch can use it
        player._startWatchOfferTimeout = startWatchOfferTimeout;

        ws.onopen = () => {
            console.log('[Player] Broadcast signaling connected');
            _updateStatus('Looking for the live feed', {
                phase: 'queue',
                detail: 'The viewer session is open. Waiting for a live source to be attached.',
                hint: 'If this sits here, the broadcaster may not be publishing media into the SFU yet.',
                showDiagnostics: true,
            });
            _viewerReconnectDelay = 3000; // reset backoff on successful connect
            const pcState = player?.pc?.iceConnectionState;
            if (!player.watchSent || pcState === 'failed' || pcState === 'disconnected' || pcState === 'closed') {
                scheduleViewerRewatch(250);
            }
        };

        ws.onmessage = async (e) => {
            try {
                const msg = JSON.parse(e.data);
                switch (msg.type) {
                    case 'welcome':
                        player.myPeerId = msg.peerId;
                        // Store server-provided ICE servers (includes TURN if configured)
                        if (msg.iceServers && Array.isArray(msg.iceServers)) {
                            player._serverIceServers = msg.iceServers;
                        }
                        player._allowP2pFallback = !!msg.allowP2pFallback;
                        console.log('[Player] Welcome, peerId:', msg.peerId, 'iceServers:', (player._serverIceServers || []).length);
                        _updateStatus('Waiting for the live feed', {
                            phase: 'queue',
                            detail: 'The viewer session is ready. Waiting for the broadcaster or SFU source to become available.',
                            hint: 'If this takes a while, the live feed may still be warming up on the server.',
                            showDiagnostics: true,
                        });
                        // Don't send watch here — wait for broadcaster-ready
                        break;
                    case 'broadcaster-ready':
                        // Broadcaster connected/reconnected — request to watch
                        console.log('[Player] Broadcaster ready, requesting watch');
                        _updateStatus('Stream found', {
                            phase: 'source',
                            detail: 'The broadcaster is live. Asking the server to attach this viewer to the SFU.',
                            hint: 'If this stalls, the broadcaster may still be starting the SFU publish transport.',
                        });
                        // Cancel any pending rewatch timer (prevents double-watch race)
                        if (_viewerRewatchTimer) { clearTimeout(_viewerRewatchTimer); _viewerRewatchTimer = null; }
                        // Cancel any pending disconnect grace timer
                        if (_broadcasterDisconnectTimer) {
                            clearTimeout(_broadcasterDisconnectTimer);
                            _broadcasterDisconnectTimer = null;
                        }
                        // Reset retry count — broadcaster is back
                        _rewatchCount = 0;
                        // Hide reconnecting indicator if shown
                        _hideReconnectingIndicator();
                        // Skip re-negotiation if the existing media path is still healthy.
                        if (player.pc) {
                            const state = player.pc.iceConnectionState;
                            if (state === 'connected' || state === 'completed') {
                                console.log(`[Player] Peer connection still healthy (ICE: ${state}), skipping re-negotiate`);
                                break;
                            }
                        }
                        if (player._sfuRecvTransport) {
                            const state = player._sfuRecvTransport.connectionState;
                            if (state === 'connected') {
                                console.log('[Player] SFU recv transport still healthy, skipping re-watch');
                                break;
                            }
                        }
                        player.watchSent = false; // allow re-watch on reconnect
                        _rewatchCount++;
                        sendPlayerSignal({ type: 'watch' });
                        player.watchSent = true;
                        startWatchOfferTimeout();
                        break;
                    case 'offer':
                        if (!player._allowP2pFallback) {
                            console.warn('[Player] Ignoring legacy P2P offer — SFU-only mode is active');
                            _pushPlayerDiagnostic('p2p.offer.ignored', 'Received unexpected offer while SFU-only mode was active');
                            break;
                        }
                        // Broadcaster sent us an offer (legacy P2P rollback path) — create answer
                        console.log('[Player] Received offer from broadcaster');
                        _updateStatus('Switching to the fallback path', {
                            phase: 'transport',
                            detail: 'Emergency P2P fallback is enabled for this session. Negotiating direct media.',
                            hint: 'This path should normally stay disabled. Copy the log if you were not expecting it.',
                            showDiagnostics: true,
                        });
                        // Clear the watch-to-offer timeout — offer received successfully
                        if (_watchOfferTimer) { clearTimeout(_watchOfferTimer); _watchOfferTimer = null; }
                        _rewatchCount = 0; // reset retry count on successful offer
                        _hideReconnectingIndicator();
                        // Clear any stale error overlay — we got a valid offer
                        _clearStreamError();
                        await handleViewerOffer(msg, player.ws, video);
                        break;
                    case 'sfu-viewer-ready':
                        // Server has SFU producers — use mediasoup-client RecvTransport
                        console.log('[Player] SFU viewer ready — starting mediasoup-client flow');
                        _updateStatus('Starting playback', {
                            phase: 'engine',
                            detail: 'The server has a healthy live source. Preparing the low-latency viewer engine.',
                            hint: 'If this hangs, the mediasoup viewer client may have failed to initialize.',
                        });
                        if (_watchOfferTimer) { clearTimeout(_watchOfferTimer); _watchOfferTimer = null; }
                        _rewatchCount = 0;
                        _hideReconnectingIndicator();
                        _clearStreamError();
                        // Prevent concurrent executions: a second sfu-viewer-ready can arrive while
                        // the first is still mid-await (JS async yields to the event loop).
                        if (_sfuViewerSetupInProgress) {
                            console.warn('[Player] SFU viewer setup already in progress — ignoring duplicate sfu-viewer-ready');
                            break;
                        }
                        _sfuViewerSetupInProgress = true;
                        try {
                            await handleSfuViewerReady(msg, player.ws, video, _updateStatus, scheduleViewerRewatch);
                        } finally {
                            _sfuViewerSetupInProgress = false;
                        }
                        break;
                    case 'ice-candidate':
                        if (!player._allowP2pFallback) {
                            console.warn('[Player] Ignoring legacy P2P ICE candidate — SFU-only mode is active');
                            break;
                        }
                        // ICE candidate from broadcaster
                        if (player.pc && msg.candidate) {
                            await player.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
                        }
                        break;
                    case 'broadcaster-disconnected':
                        console.log('[Player] Broadcaster signaling disconnected — media may still be active');
                        _pushPlayerDiagnostic('signal.disconnect', 'Broadcaster signaling disconnected while viewer session remained open');
                        // Show a subtle indicator — the WebRTC PeerConnection is independent
                        // of the signaling WS so video likely still works
                        _showReconnectingIndicator();
                        // Start a grace timer matching the server's 60s disconnect window.
                        // Only show "ended" if both the signaling AND PeerConnection are dead.
                        if (_broadcasterDisconnectTimer) clearTimeout(_broadcasterDisconnectTimer);
                        _broadcasterDisconnectTimer = setTimeout(() => {
                            _broadcasterDisconnectTimer = null;
                            // Check if PeerConnection is still delivering media
                            const pcState = player?.pc?.iceConnectionState;
                            if (pcState === 'connected' || pcState === 'completed') {
                                // PC still working — don't show "ended", just log
                                console.log('[Player] Broadcaster signaling gone but PC still connected, waiting...');
                                return;
                            }
                            console.log('[Player] Broadcaster did not reconnect and PC is dead, stream ended');
                            _hideReconnectingIndicator();
                            showStreamEnded();
                        }, 60000);
                        break;
                    case 'stream-ended':
                        console.log('[Player] Stream ended by server');
                        if (_broadcasterDisconnectTimer) clearTimeout(_broadcasterDisconnectTimer);
                        _hideReconnectingIndicator();
                        _viewerIntentionalClose = true; // don't reconnect on explicit end
                        showStreamEnded();
                        break;
                    case 'viewer-count':
                        const vcEl = document.getElementById('vc-viewers');
                        const extVc = (typeof _cachedExternalViewerCount === 'number') ? _cachedExternalViewerCount : 0;
                        if (typeof _cachedHsViewerCount !== 'undefined') _cachedHsViewerCount = msg.count || 0;
                        if (vcEl) vcEl.textContent = (msg.count || 0) + extVc;
                        break;
                    case 'sfu-source-unavailable':
                        // Server: ingest source is gone or stale — stop aggressive retrying.
                        // We will poll gently every 10 s; if the source comes back, the server
                        // sends sfu-viewer-ready (or broadcaster-ready) and we resume.
                        console.warn(`[Player] SFU source unavailable (reason: ${msg.reason || 'unknown'}) — waiting for recovery`);
                        if (_watchOfferTimer) { clearTimeout(_watchOfferTimer); _watchOfferTimer = null; }
                        if (_viewerRewatchTimer) { clearTimeout(_viewerRewatchTimer); _viewerRewatchTimer = null; }
                        _rewatchCount = 0; // source loss does not count as a retry failure
                        _updateStatus('Hang tight — reconnecting', {
                            phase: 'queue',
                            detail: msg.reason === 'producer_removed'
                                ? 'Stream source temporarily unavailable. The live source dropped out after it was already playing. Waiting for the broadcaster to publish again.'
                                : 'Stream source temporarily unavailable. The server sees the stream, but it does not have a healthy live source for viewers yet.',
                            hint: 'Copy the playback log if this keeps looping so we can see whether the stall is before publish, during transport setup, or after media starts.',
                            showDiagnostics: true,
                        });
                        _showReconnectingIndicator();
                        // Clear the SFU frozen checker — a new one will start after recovery
                        if (player._sfuFrozenInterval) { clearInterval(player._sfuFrozenInterval); player._sfuFrozenInterval = null; }
                        // Gentle poll: send watch every 10 s WITHOUT starting the P2P offer timeout.
                        // The server will respond with sfu-viewer-ready, sfu-source-unavailable, or watch-queued.
                        _viewerRewatchTimer = setTimeout(() => {
                            _viewerRewatchTimer = null;
                            if (!player?.ws || player.ws.readyState !== WebSocket.OPEN || _viewerIntentionalClose) return;
                            player.watchSent = false;
                            sendPlayerSignal({ type: 'watch' });
                            player.watchSent = true;
                            // intentionally NOT calling _startWatchOfferTimeout() — SFU never responds with 'offer'
                        }, 10000);
                        break;
                    case 'watch-queued':
                        // Server: no broadcaster or healthy SFU yet — viewer added to pending queue.
                        // Stop the watch→offer timeout; we'll receive broadcaster-ready when ready.
                        console.log('[Player] Watch queued — waiting for stream source to become available');
                        if (_watchOfferTimer) { clearTimeout(_watchOfferTimer); _watchOfferTimer = null; }
                        _rewatchCount = 0;
                        _updateStatus('Waiting for the stream', {
                            phase: 'queue',
                            detail: msg.detail || 'The stream is live, but the viewer path is still warming up and waiting for usable media.',
                            hint: 'If this takes a while, the broadcaster may still be establishing the SFU publish transport or the ingest may be unhealthy.',
                            showDiagnostics: true,
                        });
                        break;
                    case 'sfu-keyframe-requested':
                        // Server acknowledged the re-watch by requesting a keyframe from the producer.
                        // Clear the offer timeout so we don't loop into "Still warming up".
                        // The playing event or frozen-frame detector will dismiss the overlay once frames arrive.
                        console.log('[Player] SFU keyframe requested by server — clearing watch timeout, waiting for first frame');
                        if (_watchOfferTimer) { clearTimeout(_watchOfferTimer); _watchOfferTimer = null; }
                        _rewatchCount = 0;
                        break;
                }
            } catch (err) {
                console.error('[Player] Message error:', err);
            }
        };

        ws.onerror = () => {
            console.error('[Player] Broadcast signaling error');
            _updateStatus('Reconnecting', {
                phase: 'reconnect',
                detail: 'The viewer session hit a websocket error. Reconnecting automatically.',
                hint: 'If this persists, the stream service may be restarting or blocked upstream.',
                showDiagnostics: true,
            });
        };

        ws.onclose = (ev) => {
            console.log(`[Player] Broadcast signaling closed (code=${ev.code})`);
            // Stale session (player was torn down / replaced) — never reconnect.
            if (_viewerIntentionalClose || _myGen !== _playerGen) return;
            _updateStatus('Reconnecting', {
                phase: 'reconnect',
                detail: 'The viewer session disconnected and is retrying automatically.',
                hint: 'If this keeps bouncing, copy the playback log so we can inspect the disconnect pattern.',
                showDiagnostics: true,
            });
            // Reconnect signaling WS with exponential backoff
            // The WebRTC peer connection may still be delivering media even without signaling
            if (player && streamRef) {
                const delay = _viewerReconnectDelay;
                _viewerReconnectDelay = Math.min(_viewerReconnectDelay * 1.5, 30000);
                console.log(`[Player] Reconnecting signaling in ${Math.round(delay)}ms`);
                _viewerReconnectTimer = setTimeout(() => {
                    _viewerReconnectTimer = null;
                    if (!player || _viewerIntentionalClose || _myGen !== _playerGen) return;
                    try {
                        const newWs = new WebSocket(wsUrl);
                        player.ws = newWs;
                        // Re-attach all handlers to the new WS
                        newWs.onopen = ws.onopen;
                        newWs.onmessage = ws.onmessage;
                        newWs.onerror = ws.onerror;
                        newWs.onclose = ws.onclose;
                    } catch (err) {
                        console.error('[Player] Signaling reconnect failed:', err);
                    }
                }, delay);
            }
        };
    } catch (e) {
        console.error('[Player] WebRTC init failed:', e);
        showStreamError('WebRTC not available');
    }
}

async function handleViewerOffer(msg, ws, video) {
    // Safety: player must be set by initWebRTC before we get here
    if (!player) {
        console.warn('[Player] handleViewerOffer called but player is null');
        return;
    }
    // Close existing PC if re-negotiating — detach handlers first to prevent
    // the old PC's 'closed' state from triggering a cascading re-watch loop
    if (player.pc) {
        const oldPc = player.pc;
        oldPc.oniceconnectionstatechange = null;
        oldPc.ontrack = null;
        oldPc.onicecandidate = null;
        try { oldPc.close(); } catch (ignored) {}
    }
    // Clear any pending stall/ICE timers from the previous connection
    if (player._iceTimeout) { clearTimeout(player._iceTimeout); player._iceTimeout = null; }
    if (player._stallTimer) { clearTimeout(player._stallTimer); player._stallTimer = null; }
    if (player._playRetryTimer) { clearTimeout(player._playRetryTimer); player._playRetryTimer = null; }

    // Use server-provided ICE servers (with TURN support) if available, else fallback to STUN-only
    const iceServers = (player._serverIceServers && player._serverIceServers.length > 0)
        ? player._serverIceServers
        : [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' },
        ];

    const pc = new RTCPeerConnection({ iceServers });
    player.pc = pc;
    let _iceConnected = false;
    let _hasVideoFrames = false;
    let _playPending = false; // debounce play() across multiple ontrack events

    // Schedules a re-watch if the current PC is still ours
    const triggerRewatch = (reason) => {
        if (!player || player.pc !== pc) return;
        // Track ICE failures separately — these never reset (prevents infinite loop)
        if (reason.includes('ICE') || reason.includes('stall') || reason.includes('SDP')) {
            _totalIceFailures++;
            console.log(`[Player] Re-watching: ${reason} (ICE failures: ${_totalIceFailures}/${MAX_ICE_FAILURES})`);
            if (_totalIceFailures >= MAX_ICE_FAILURES) {
                console.error('[Player] Too many ICE/connection failures — giving up');
                showStreamError('Could not establish media connection. Your network may be blocking WebRTC traffic. Try a different network or refresh the page.');
                return;
            }
        } else {
            console.log(`[Player] Re-watching: ${reason}`);
        }
        player.watchSent = false;
        sendPlayerSignal({ type: 'watch' });
        player.watchSent = true;
        // Start watch-to-offer timeout for this re-watch too
        if (player._startWatchOfferTimeout) player._startWatchOfferTimeout();
    };

    // Debounced play() — always starts muted (guaranteed autoplay), then unmutes if allowed.
    // Previous approach tried unmuted first, hit NotAllowedError, then retried muted — but the
    // muted retry could also fail with AbortError if the first play() was still settling,
    // leading to "Playback failed even muted" and no frames ever rendering.
    const tryPlay = () => {
        if (_playPending || !player || player.pc !== pc) return;
        // Viewer deliberately paused — don't force playback on a reconnect.
        if (viewerWantsPaused()) { try { video.pause(); } catch {} return; }
        _playPending = true;
        if (player._playRetryTimer) { clearTimeout(player._playRetryTimer); player._playRetryTimer = null; }

        // Always start muted — this is the only way to guarantee autoplay across all browsers.
        // We unmute after playback starts if the user hasn't muted.
        video.muted = true;
        video.volume = 1;

        video.play().then(() => {
            _playPending = false;
            console.log('[Player] Playback started (muted autoplay)');

            // Now try to unmute based on user prefs
            const audioPrefs = getSavedPlayerAudioState();
            if (!audioPrefs.muted) {
                video.volume = Math.max(0.01, audioPrefs.volume);
                video.muted = false;
                // If unmuting fails (autoplay policy), show overlay
                // Some browsers will pause on unmute — re-play muted if needed
                const playPromise = video.play();
                if (playPromise) {
                    playPromise.catch(() => {
                        video.muted = true;
                        video.play().catch(() => {});
                        showUnmuteOverlay(video);
                    });
                }
            } else {
                video.muted = true;
                video.volume = 0;
                // Already muted — remove stale overlay if present
                document.getElementById('unmute-overlay')?.remove();
            }
        }).catch((err) => {
            _playPending = false;
            if (err.name === 'AbortError') {
                // play() interrupted — retry after a tick (second ontrack can cause this)
                console.log('[Player] play() interrupted, retrying in 300ms');
                player._playRetryTimer = setTimeout(() => {
                    player._playRetryTimer = null;
                    _playPending = false;
                    tryPlay();
                }, 300);
            } else {
                console.warn('[Player] Muted play() failed:', err.name, err.message);
                // Retry once after short delay — video element may not have enough data yet
                player._playRetryTimer = setTimeout(() => {
                    player._playRetryTimer = null;
                    _playPending = false;
                    tryPlay();
                }, 1000);
            }
        });
    };

    let _trackCount = 0; // count received tracks — only tryPlay after both video+audio arrive

    pc.ontrack = (e) => {
        _trackCount++;
        console.log('[Player] Got remote track:', e.track.kind, `(${_trackCount} total)`);
        if (e.streams && e.streams[0]) {
            video.srcObject = e.streams[0];
            startClipRecordingIfNeeded(e.streams[0], streamRef?.id);
        } else {
            let mediaStream = video.srcObject;
            if (!mediaStream) {
                mediaStream = new MediaStream();
                video.srcObject = mediaStream;
            }
            mediaStream.addTrack(e.track);
            startClipRecordingIfNeeded(mediaStream, streamRef?.id);
        }

        // Monitor remote track health — if it ends or mutes, trigger re-watch
        const track = e.track;
        track.addEventListener('ended', () => {
            if (player?.pc !== pc) return;
            console.warn(`[Player] Remote ${track.kind} track ended`);
            triggerRewatch(`remote ${track.kind} track ended`);
        }, { once: true });
        track.addEventListener('mute', () => {
            if (player?.pc !== pc) return;
            console.warn(`[Player] Remote ${track.kind} track muted`);
            // Give muted tracks a grace period — they may unmute on their own (e.g. track replacement)
            setTimeout(() => {
                if (player?.pc !== pc || !track.muted) return;
                triggerRewatch(`remote ${track.kind} track stayed muted`);
            }, 5000);
        }, { once: true });

        // Show the video element now that we have tracks
        video.style.display = 'block';

        // Register the playing event listener for EACH new PC (fresh _hasVideoFrames each time)
        if (_trackCount === 1) {
            const onPlaying = () => {
                video.removeEventListener('playing', onPlaying);
                _hasVideoFrames = true;
                if (player._stallTimer) { clearTimeout(player._stallTimer); player._stallTimer = null; }
                _hidePlayerPlaceholder();
                // Only remove unmute overlay if video is actually playing with audio
                if (!video.muted) {
                    document.getElementById('unmute-overlay')?.remove();
                }
            };
            video.addEventListener('playing', onPlaying);
        }

        // Video stall detection — if no frames render within 8s of getting tracks, re-watch
        if (!player._stallTimer && !_hasVideoFrames) {
            player._stallTimer = setTimeout(() => {
                player._stallTimer = null;
                if (player?.pc !== pc || _hasVideoFrames) return;
                // Check if video element is actually rendering
                if (video.videoWidth === 0 || video.paused || video.readyState < 2) {
                    console.warn('[Player] Video stall detected — no frames after 8s');
                    triggerRewatch('video stall — no frames rendered');
                }
            }, 8000);
        }

        // Delay tryPlay until we have at least 2 tracks (video + audio) or 500ms
        // after first track (handles audio-only/video-only streams).
        // This prevents the first tryPlay() from racing with the second ontrack
        // which causes AbortError on the first play() call.
        if (_trackCount >= 2) {
            tryPlay();
        } else if (_trackCount === 1) {
            player._playRetryTimer = setTimeout(() => {
                player._playRetryTimer = null;
                _playPending = false;
                tryPlay();
            }, 500);
        }
    };

    pc.onicecandidate = (e) => {
        // Use player.ws (not the passed ws param) so this works after WS reconnection
        if (e.candidate) {
            sendPlayerSignal({
                type: 'ice-candidate',
                candidate: e.candidate,
            });
        }
    };

    pc.oniceconnectionstatechange = () => {
        // Ignore state changes from a stale (replaced) PC
        if (!player || player.pc !== pc) return;
        console.log('[Player] ICE state:', pc.iceConnectionState);
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
            _iceConnected = true;
            if (player._iceTimeout) { clearTimeout(player._iceTimeout); player._iceTimeout = null; }
            // If the stall timer is already running and no frames yet, restart it from ICE-connected
            // time — ICE negotiation itself can take several seconds, so the 8s clock should start
            // from when media can actually flow, not from when ontrack fired.
            if (player._stallTimer && !_hasVideoFrames) {
                clearTimeout(player._stallTimer);
                player._stallTimer = setTimeout(() => {
                    player._stallTimer = null;
                    if (player?.pc !== pc || _hasVideoFrames) return;
                    if (video.videoWidth === 0 || video.paused || video.readyState < 2) {
                        console.warn('[Player] Video stall detected — no frames after ICE connected + 8s');
                        triggerRewatch('video stall — no frames after ICE connect');
                    }
                }, 8000);
            }
            return;
        }
        if (pc.iceConnectionState === 'failed') {
            if (player._iceTimeout) { clearTimeout(player._iceTimeout); player._iceTimeout = null; }
            triggerRewatch('ICE failed');
            return;
        }
        if (pc.iceConnectionState === 'disconnected') {
            setTimeout(() => {
                if (!player?.pc || player.pc !== pc) return;
                const state = pc.iceConnectionState;
                if (state === 'disconnected' || state === 'failed') {
                    triggerRewatch('ICE disconnected/failed after grace period');
                }
            }, 2500);
        }
        // 'disconnected' is transient and often recovers on its own — don't show error
        // 'closed' is handled by detaching handlers before close — no cascading re-watch
    };

    // Wrap SDP operations in try/catch — retry on failure instead of silent black screen
    try {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        // Use player.ws (not the passed ws param) so this works after WS reconnection
        sendPlayerSignal({
            type: 'answer',
            sdp: answer,
        });
        console.log('[Player] Sent answer to broadcaster');
    } catch (sdpErr) {
        console.error('[Player] SDP negotiation failed:', sdpErr);
        // Close the failed PC and retry after a short delay
        pc.oniceconnectionstatechange = null;
        pc.ontrack = null;
        try { pc.close(); } catch {}
        if (player.pc === pc) player.pc = null;
        setTimeout(() => triggerRewatch('SDP negotiation failed'), 2000);
        return;
    }

    // ICE connection timeout — if not connected within 10s, something is stuck
    player._iceTimeout = setTimeout(() => {
        player._iceTimeout = null;
        if (!player || player.pc !== pc || _iceConnected) return;
        const state = pc.iceConnectionState;
        if (state !== 'connected' && state !== 'completed') {
            console.warn(`[Player] ICE timeout after 10s (state: ${state})`);
            triggerRewatch('ICE connection timeout');
        }
    }, 10000);
}

/* ── SFU Viewer via mediasoup-client (replaces hand-built SDP) ── */
async function handleSfuViewerReady(msg, ws, video, updateStatus, scheduleRewatch) {
    if (!player) return;

    // Clean up old PC if any (from P2P fallback or previous SFU attempt)
    if (player.pc) {
        const oldPc = player.pc;
        oldPc.oniceconnectionstatechange = null;
        oldPc.ontrack = null;
        oldPc.onicecandidate = null;
        try { oldPc.close(); } catch {}
        player.pc = null;
    }
    if (player._iceTimeout) { clearTimeout(player._iceTimeout); player._iceTimeout = null; }
    if (player._stallTimer) { clearTimeout(player._stallTimer); player._stallTimer = null; }
    if (player._playRetryTimer) { clearTimeout(player._playRetryTimer); player._playRetryTimer = null; }
    // Clear any post-play frozen-video checker from the previous SFU session
    if (player._sfuFrozenInterval) { clearInterval(player._sfuFrozenInterval); player._sfuFrozenInterval = null; }
    // Cancel pending ICE/DTLS connect timeout for any prior SFU transport
    if (player._sfuTransportConnectTimeout) {
        clearTimeout(player._sfuTransportConnectTimeout);
        player._sfuTransportConnectTimeout = null;
    }
    // Close previous SFU recv transport — null BEFORE close() so the old transport's
    // 'connectionstatechange' → 'closed' event handler sees null and does not cascade into
    // a spurious re-watch.
    if (player._sfuRecvTransport) {
        const _oldRecvTransport = player._sfuRecvTransport;
        player._sfuRecvTransport = null;
        try { _oldRecvTransport.close(); } catch {}
    }

    const { rtpCapabilities, producers } = msg;
    if (!rtpCapabilities || !producers?.length) {
        console.warn('[Player] sfu-viewer-ready missing capabilities or producers');
        scheduleRewatch(2000);
        return;
    }

    try {
        // Step 1: Load mediasoup-client
        updateStatus('Starting playback', {
            phase: 'engine',
            detail: 'Loading the mediasoup viewer client and preparing router capabilities.',
            hint: 'If this stalls, the mediasoup client bundle may be blocked or failed to initialize.',
        });
        const mod = await loadMediasoupClient();
        const { Device } = mod;
        if (!Device) throw new Error('mediasoup-client Device not available');

        // Step 2: Create and load Device with router capabilities
        const device = new Device();
        await device.load({ routerRtpCapabilities: rtpCapabilities });
        _mediasoupDevice = device;

        // Step 3: Request a recv transport from the server
        updateStatus('Securing the connection', {
            phase: 'transport',
            detail: 'Negotiating ICE and DTLS with the SFU so media can flow to this viewer.',
            hint: 'If this takes too long, TURN / firewall / ICE connectivity is the first thing to inspect.',
        });
        const transportParams = await _sfuViewerRequest(ws, 'sfu-viewer-create-transport', 'sfu-viewer-transport-created');

        // Step 4: Create the local RecvTransport
        let iceServers = sanitizeIceServers(transportParams.iceServers);
        if (!iceServers.length) {
            iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
            console.warn('[Player] Falling back to default STUN-only ICE servers for mediasoup transport');
        }
        console.log('[Player] Using SFU ICE servers:', iceServers.map((s) => (Array.isArray(s.urls) ? s.urls.join(',') : s.urls)).join(' | '));

        const recvTransport = device.createRecvTransport({
            id: transportParams.id,
            iceParameters: transportParams.iceParameters,
            iceCandidates: transportParams.iceCandidates,
            dtlsParameters: transportParams.dtlsParameters,
            iceServers,
        });
        player._sfuRecvTransport = recvTransport;

        // Wire transport 'connect' event — mediasoup-client fires this when DTLS needs to start
        recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
            sendPlayerSignal({
                type: 'sfu-viewer-connect-transport',
                transportId: recvTransport.id,
                dtlsParameters,
            });
            // Wait for server confirmation
            _sfuViewerWaitFor(ws, 'sfu-viewer-transport-connected')
                .then(() => callback())
                .catch(errback);
        });

        // 15-second ICE/DTLS connect timeout — if transport never reaches 'connected', abandon and re-watch.
        // This fires before the stall timer (which only starts once connected) and handles stuck ICE.
        const _sfuConnectTimeout = setTimeout(() => {
            if (!player || player._sfuRecvTransport !== recvTransport) return;
            if (recvTransport.connectionState === 'connected') return;
            console.warn(`[Player] SFU recv transport failed to connect within 15s (state: ${recvTransport.connectionState}) — re-watching`);
            if (player._stallTimer) { clearTimeout(player._stallTimer); player._stallTimer = null; }
            player._sfuTransportConnectTimeout = null;
            _totalIceFailures++;
            if (_totalIceFailures < MAX_ICE_FAILURES) {
                player.watchSent = false;
                sendPlayerSignal({ type: 'watch' });
                player.watchSent = true;
                // Do NOT call _startWatchOfferTimeout() — we are in SFU mode; the server
                // responds with sfu-viewer-ready, sfu-source-unavailable, or watch-queued.
            } else {
                showStreamError('Could not establish media connection. Try refreshing.');
            }
        }, 15000);
        player._sfuTransportConnectTimeout = _sfuConnectTimeout;

        recvTransport.on('connectionstatechange', (state) => {
            // Guard: ignore events from a transport that is no longer the active one.
            // This prevents the old transport's 'closed' event (fired when handleSfuViewerReady
            // explicitly closes it) from cascading into a spurious re-watch.
            if (!player || player._sfuRecvTransport !== recvTransport) return;
            console.log(`[Player] SFU recv transport state: ${state}`);
            if (state === 'connected') {
                updateStatus('Almost there', {
                    phase: 'buffer',
                    detail: 'ICE and DTLS are up. Waiting for the next keyframe and live media packets.',
                    hint: 'If this keeps spinning, the broadcaster may not be producing clean frames or the next keyframe has not arrived yet.',
                    showDiagnostics: true,
                    slowAfterMs: 20000,
                });
                // ICE + DTLS succeeded — clear the connect timeout
                if (player._sfuTransportConnectTimeout) {
                    clearTimeout(player._sfuTransportConnectTimeout);
                    player._sfuTransportConnectTimeout = null;
                }
                // Start the first-frame grace window NOW, from when media can actually flow.
                // OBS default keyint=250 @ 30fps = ~8.33s per keyframe. Allow 20s so a
                // late-joining viewer receives the next keyframe even under jitter/TCP fallback.
                if (!_hasVideoFrames && !player._stallTimer) {
                    console.log('[Player] SFU transport connected — starting 20s first-frame grace window');
                    player._stallTimer = setTimeout(() => {
                        player._stallTimer = null;
                        if (!player || player._sfuRecvTransport !== recvTransport || _hasVideoFrames) return;
                        const streamTracks = video.srcObject?.getTracks() || [];
                        const trackInfo = streamTracks.map(t => `${t.kind}:${t.readyState}:enabled=${t.enabled}:muted=${t.muted}`).join(', ');
                        console.warn(`[Player] SFU video stall — no frames after 20s post-connect | readyState=${video.readyState} videoWidth=${video.videoWidth} paused=${video.paused} currentTime=${video.currentTime.toFixed(2)} networkState=${video.networkState} error=${video.error?.message || 'none'} srcObjectActive=${video.srcObject?.active} tracks=[${trackInfo}] transportState=${recvTransport.connectionState}`);
                        player.watchSent = false;
                        sendPlayerSignal({ type: 'watch' });
                        player.watchSent = true;
                        // Do NOT call _startWatchOfferTimeout() — SFU mode; server responds with
                        // sfu-viewer-ready / sfu-source-unavailable / watch-queued, never 'offer'.
                    }, 20000);
                }
                return;
            }
            if (state === 'failed' || state === 'closed') {
                // Transport is dead — clear both timers before re-watching
                if (player._sfuTransportConnectTimeout) {
                    clearTimeout(player._sfuTransportConnectTimeout);
                    player._sfuTransportConnectTimeout = null;
                }
                if (player._stallTimer) { clearTimeout(player._stallTimer); player._stallTimer = null; }
                _totalIceFailures++;
                if (_totalIceFailures < MAX_ICE_FAILURES) {
                    console.warn(`[Player] SFU transport ${state} — re-watching`);
                    player.watchSent = false;
                    sendPlayerSignal({ type: 'watch' });
                    player.watchSent = true;
                    // Do NOT call _startWatchOfferTimeout() — SFU mode; server never responds with 'offer'.
                } else {
                    showStreamError('Could not establish media connection. Try refreshing.');
                }
            }
        });

        // Step 5: Consume each producer
        updateStatus('Bringing the feed in', {
            phase: 'buffer',
            detail: 'Subscribing to the live audio/video tracks and waiting for usable frames.',
            hint: 'If this stalls, the live source may exist but not be delivering healthy media yet.',
            showDiagnostics: true,
        });
        const mediaStream = new MediaStream();
        let _hasVideoFrames = false;
        let _playPending = false;

        const tryPlay = () => {
            if (_playPending || !player) return;
            // Viewer deliberately paused — don't force playback on a reconnect.
            if (viewerWantsPaused()) { try { video.pause(); } catch {} return; }
            _playPending = true;
            if (player._playRetryTimer) { clearTimeout(player._playRetryTimer); player._playRetryTimer = null; }
            video.muted = true;
            video.volume = 1;

            console.log(`[Player] tryPlay() — video state: readyState=${video.readyState} videoWidth=${video.videoWidth} paused=${video.paused} srcObject tracks=${video.srcObject?.getTracks().length || 0}`);

            video.play().then(() => {
                _playPending = false;
                console.log(`[Player] SFU playback started (muted) — readyState=${video.readyState} videoWidth=${video.videoWidth}`);
                const audioPrefs = getSavedPlayerAudioState();
                if (!audioPrefs.muted) {
                    video.volume = Math.max(0.01, audioPrefs.volume);
                    video.muted = false;
                    const p = video.play();
                    if (p) p.catch(() => {
                        video.muted = true;
                        video.play().catch(() => {});
                        showUnmuteOverlay(video);
                    });
                } else {
                    video.muted = true;
                    video.volume = 0;
                    document.getElementById('unmute-overlay')?.remove();
                }
                _maybeHidePlayerPlaceholderForLiveVideo(video);
            }).catch((err) => {
                _playPending = false;
                console.warn(`[Player] play() failed: ${err.name}: ${err.message} — readyState=${video.readyState} videoWidth=${video.videoWidth} networkState=${video.networkState}`);
                if (err.name === 'AbortError') {
                    player._playRetryTimer = setTimeout(() => {
                        player._playRetryTimer = null;
                        _playPending = false;
                        tryPlay();
                    }, 300);
                } else {
                    player._playRetryTimer = setTimeout(() => {
                        player._playRetryTimer = null;
                        _playPending = false;
                        tryPlay();
                    }, 1000);
                }
            });
        };

        let consumedCount = 0;
        for (const prod of producers) {
            const consumerParams = await _sfuViewerRequest(ws, 'sfu-viewer-consume', 'sfu-viewer-consumed', {
                transportId: recvTransport.id,
                producerId: prod.id,
                rtpCapabilities: device.rtpCapabilities,
            });

            const consumer = await recvTransport.consume({
                id: consumerParams.id,
                producerId: consumerParams.producerId,
                kind: consumerParams.kind,
                rtpParameters: consumerParams.rtpParameters,
            });

            // Playout buffering. This used to force BOTH receivers to 0, which removed the
            // very slack playback depends on:
            //
            //  • A/V sync. The browser aligns audio to video from RTCP sender reports, and
            //    that means holding audio back until the matching video frame has decoded.
            //    A 0 target on the AUDIO receiver leaves nowhere to hold it, so audio renders
            //    the instant it arrives and runs ahead of video — the "audio plays early"
            //    desync, which is why it showed up on openvibe.live and not just on restreams.
            //  • Freezes. A 0 target on video leaves no buffer to absorb ordinary network
            //    jitter, so a slightly late frame is simply late — visible as a frozen frame.
            //
            // The old comment claimed the receiver still grows the buffer adaptively; a hard 0
            // target fights that adaptation rather than cooperating with it.
            //
            // So we now set NEITHER and let the browser manage both buffers. Its adaptive
            // jitter buffer already targets the minimum delay the network allows and grows
            // only when it has to — that is strictly better than any constant we could pick
            // here, and unlike a hardcoded target it costs no latency on a clean connection.

            // Keep a handle on the VIDEO receiver so the freeze watchdog can read framesDecoded
            // when requestVideoFrameCallback isn't available.
            if (consumer.kind === 'video') player._sfuVideoReceiver = consumer.rtpReceiver || null;

            mediaStream.addTrack(consumer.track);
            console.log(`[Player] SFU consumed ${consumer.kind} track — enabled=${consumer.track.enabled} muted=${consumer.track.muted} readyState=${consumer.track.readyState} paused=${consumer.paused} id=${consumer.id}`);

            // Monitor track health
            consumer.track.addEventListener('ended', () => {
                console.warn(`[Player] SFU ${consumer.kind} track ended`);
                if (player?._sfuRecvTransport === recvTransport) {
                    player.watchSent = false;
                    sendPlayerSignal({ type: 'watch' });
                    player.watchSent = true;
                    // Do NOT call _startWatchOfferTimeout() — SFU mode; server never responds with 'offer'.
                }
            }, { once: true });

            consumer.track.addEventListener('mute', () => {
                console.warn(`[Player] SFU ${consumer.kind} track muted`);
            });
            consumer.track.addEventListener('unmute', () => {
                console.log(`[Player] SFU ${consumer.kind} track unmuted — data flowing`);
            });

            consumedCount++;
        }

        // Set video source
        video.srcObject = mediaStream;
        video.style.display = 'block';
        startClipRecordingIfNeeded(mediaStream, streamRef?.id);

        const _onVideoPlaybackProgress = () => {
            if (_maybeHidePlayerPlaceholderForLiveVideo(video)) {
                video.removeEventListener('timeupdate', _onVideoPlaybackProgress);
                video.removeEventListener('loadeddata', _onVideoPlaybackProgress);
            }
        };
        video.addEventListener('timeupdate', _onVideoPlaybackProgress);
        video.addEventListener('loadeddata', _onVideoPlaybackProgress);
        _maybeHidePlayerPlaceholderForLiveVideo(video);

        // Log MediaStream state
        const tracks = mediaStream.getTracks();
        console.log(`[Player] MediaStream set — active=${mediaStream.active} tracks=${tracks.length} (${tracks.map(t => `${t.kind}:${t.readyState}:enabled=${t.enabled}:muted=${t.muted}`).join(', ')})`);

        // Playing event — hide placeholder
        const onPlaying = () => {
            video.removeEventListener('playing', onPlaying);
            _hasVideoFrames = true;
            if (player?._stallTimer) { clearTimeout(player._stallTimer); player._stallTimer = null; }
            console.log(`[Player] SFU video playing! videoWidth=${video.videoWidth} videoHeight=${video.videoHeight}`);
            _hidePlayerPlaceholder();
            if (!video.muted) document.getElementById('unmute-overlay')?.remove();

            // Post-play VIDEO-freeze watchdog.
            //
            // The old detector watched video.currentTime — but for a WebRTC MediaStream that
            // clock keeps advancing as long as the AUDIO track renders. So when only the VIDEO
            // decoder stalls (a lost keyframe after packet loss, a decode hiccup), the screen goes
            // black yet currentTime never stops → the stall was invisible → viewers had to refresh.
            //
            // Instead we watch actual VIDEO frame PRESENTATION via requestVideoFrameCallback
            // (falling back to getStats framesDecoded). On a video-only stall we recover in two
            // stages: (1) a cheap keyframe request via re-watch — the server responds with
            // consumer.requestKeyFrame(), which unsticks a missing-keyframe black frame without a
            // rebuild; (2) if that doesn't help within a few seconds, rebuild the receive transport
            // (full re-consume). No manual refresh needed.
            const _nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
            const STALL_CHECK_MS = 1500;
            const STALL_TRIGGER_MS = 3500;   // no new video frame for this long (while playing) = frozen
            const STALL_ESCALATE_MS = 6000;  // still frozen this long after a keyframe nudge = rebuild
            let _lastFrameAt = _nowMs();
            let _lastFramesDecoded = -1;
            let _recoverStage = 0;           // 0 = healthy, 1 = keyframe requested
            let _recoverAt = 0;
            let _usingRVFC = false;

            // Primary signal: rVFC fires only when a NEW frame is actually presented.
            if (typeof video.requestVideoFrameCallback === 'function') {
                _usingRVFC = true;
                const _onFrame = () => {
                    _lastFrameAt = _nowMs();
                    if (player?._sfuRecvTransport === recvTransport && video.srcObject) {
                        try { video.requestVideoFrameCallback(_onFrame); } catch { /* */ }
                    }
                };
                try { video.requestVideoFrameCallback(_onFrame); } catch { _usingRVFC = false; }
            }

            const _frozenInterval = setInterval(async () => {
                if (!player || player._sfuRecvTransport !== recvTransport) { clearInterval(_frozenInterval); return; }
                if (video.paused || !(video.srcObject?.active)) { clearInterval(_frozenInterval); return; }

                // Fallback progress signal when rVFC is unavailable (e.g. older Firefox): decoded
                // video frame count from getStats. A rising count == video is still rendering.
                if (!_usingRVFC && player._sfuVideoReceiver?.getStats) {
                    try {
                        const stats = await player._sfuVideoReceiver.getStats();
                        let fd = null;
                        stats.forEach((r) => { if (r.type === 'inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video') && typeof r.framesDecoded === 'number') fd = r.framesDecoded; });
                        if (fd != null && fd !== _lastFramesDecoded) { _lastFrameAt = _nowMs(); _lastFramesDecoded = fd; }
                    } catch { /* */ }
                }

                const stalledFor = _nowMs() - _lastFrameAt;

                if (stalledFor <= STALL_TRIGGER_MS) {
                    // Video is progressing — healthy (or recovered after a nudge).
                    if (_recoverStage !== 0) { console.log('[Player] SFU video recovered'); _recoverStage = 0; }
                    return;
                }

                if (_recoverStage === 0) {
                    // Stage 1: cheap keyframe request (server calls consumer.requestKeyFrame() on re-watch).
                    console.warn(`[Player] SFU video frozen ~${(stalledFor / 1000).toFixed(1)}s (audio may still be playing) — requesting keyframe via re-watch`);
                    _recoverStage = 1; _recoverAt = _nowMs();
                    player.watchSent = false;
                    sendPlayerSignal({ type: 'watch' });
                    player.watchSent = true;
                    // Intentionally NOT calling _startWatchOfferTimeout() — SFU mode.
                } else if (_recoverStage === 1 && (_nowMs() - _recoverAt) > STALL_ESCALATE_MS) {
                    // Stage 2: keyframe didn't unstick it — rebuild the receive transport.
                    console.warn('[Player] SFU video still frozen after keyframe nudge — rebuilding receive transport');
                    clearInterval(_frozenInterval);
                    if (player._sfuFrozenInterval === _frozenInterval) player._sfuFrozenInterval = null;
                    _hasVideoFrames = false;
                    if (player._sfuRecvTransport === recvTransport) player._sfuRecvTransport = null;
                    try { recvTransport.close(); } catch { /* */ }
                    scheduleRewatch(1000);
                }
            }, STALL_CHECK_MS);
            player._sfuFrozenInterval = _frozenInterval;
        };
        video.addEventListener('playing', onPlaying);

        // NOTE: the first-frame stall timer is now armed in the 'connected'
        // connectionstatechange handler above, not here. Arming it here (before transport
        // connects) was the root cause of the 8-second re-watch loop: the timer fired before
        // ICE + DTLS completed AND before the first H.264 keyframe could arrive.

        // Start playback after all tracks consumed
        if (consumedCount >= 2) {
            tryPlay();
        } else {
            player._playRetryTimer = setTimeout(() => {
                player._playRetryTimer = null;
                _playPending = false;
                tryPlay();
            }, 500);
        }

        console.log(`[Player] SFU viewer consuming ${consumedCount} track(s)`);

    } catch (err) {
        console.error('[Player] SFU viewer setup failed:', err);
        // Close the transport explicitly so the server sees it as dead on the next
        // watch — otherwise the server's re-watch guard keeps the old transport alive
        // and never sends a fresh sfu-viewer-ready (root cause of the Firefox retry loop).
        if (player._sfuRecvTransport === recvTransport) {
            player._sfuRecvTransport = null;
        }
        try { recvTransport.close(); } catch (_) {}
        _totalIceFailures++;
        if (_totalIceFailures < MAX_ICE_FAILURES) {
            scheduleRewatch(2000);
        } else {
            showStreamError('Could not establish media connection. Try refreshing.');
        }
    }
}

/**
 * Send a signaling message and wait for a specific response type.
 * Returns the response message payload.
 */
function _sfuViewerRequest(ws, sendType, expectType, extra = {}) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`Timeout waiting for ${expectType}`));
        }, 10000);

        const handler = (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (msg.type === expectType) {
                    cleanup();
                    resolve(msg);
                } else if (msg.type === 'sfu-viewer-error') {
                    cleanup();
                    reject(new Error(msg.error || 'SFU viewer error'));
                }
            } catch {}
        };

        const cleanup = () => {
            clearTimeout(timeout);
            ws.removeEventListener('message', handler);
        };

        ws.addEventListener('message', handler);
        sendPlayerSignal({ type: sendType, ...extra });
    });
}

/**
 * Wait for a specific message type on the WS (no sending).
 */
function _sfuViewerWaitFor(ws, expectType) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`Timeout waiting for ${expectType}`));
        }, 10000);

        const handler = (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (msg.type === expectType) {
                    cleanup();
                    resolve(msg);
                } else if (msg.type === 'sfu-viewer-error') {
                    cleanup();
                    reject(new Error(msg.error || 'SFU viewer error'));
                }
            } catch {}
        };

        const cleanup = () => {
            clearTimeout(timeout);
            ws.removeEventListener('message', handler);
        };

        ws.addEventListener('message', handler);
    });
}

/* ── HLS / HTTP-FLV (RTMP transcoded) ──────────────────────────── */
function initHLS(endpoint, stream) {
    const video = document.getElementById('video-element');
    const placeholder = document.querySelector('.video-placeholder');

    const hlsUrl = endpoint.hls_url || endpoint.hlsUrl;
    const flvUrl = endpoint.flv_url || endpoint.flvUrl;

    if (!hlsUrl && !flvUrl) {
        showStreamError('RTMP stream endpoint not available. Ensure the RTMP server is running and your streaming software is connected.');
        return;
    }

    video.style.display = 'none';
    video.playsInline = true;
    video.preload = 'auto';
    if (placeholder) placeholder.style.display = '';
    playerType = 'hls';

    _setPlayerStatus({
        protocol: 'hls',
        phase: 'engine',
        title: 'Starting playback',
        detail: 'Loading the adaptive live player and checking which relay path is available.',
        hint: 'If this stalls, the relay or player script may still be starting.',
    });

    // Start clip recording when video begins playing (for any RTMP sub-method)
    const _startClipOnPlay = () => {
        video.removeEventListener('playing', _startClipOnPlay);
        video.style.display = 'block';
        _setPlayerStatus({
            protocol: 'hls',
            phase: 'live',
            title: 'You’re live',
            detail: 'Playback has enough media buffered to stay at the live edge.',
            slowAfterMs: 0,
        });
        _hidePlayerPlaceholder('video');
        // Skip all client-side clip capture (captureStream + the 30fps canvas fallback)
        // when the server records this stream and cuts clips itself.
        if (_clientClipRecordingEnabled()) try {
            const capturedStream = video.captureStream ? video.captureStream() :
                                   video.mozCaptureStream ? video.mozCaptureStream() : null;
            if (capturedStream) {
                startClipRecordingIfNeeded(capturedStream, streamRef?.id);
            } else {
                console.warn('[HLS] captureStream() not available — using canvas fallback for clips');
                // Canvas-based fallback: draw video frames to an offscreen canvas
                try {
                    const offCanvas = document.createElement('canvas');
                    offCanvas.width = video.videoWidth || 1280;
                    offCanvas.height = video.videoHeight || 720;
                    const ctx = offCanvas.getContext('2d');
                    if (!ctx) throw new Error('Unable to create fallback canvas context');
                    const fallbackStream = offCanvas.captureStream(30);

                    // Try to capture audio via captureStream on AudioContext
                    try {
                        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                        const source = audioCtx.createMediaElementSource(video);
                        const audioDest = audioCtx.createMediaStreamDestination();
                        source.connect(audioDest);
                        source.connect(audioCtx.destination); // keep audio audible
                        for (const track of audioDest.stream.getAudioTracks()) {
                            fallbackStream.addTrack(track);
                        }
                    } catch (audioErr) {
                        console.warn('[HLS] Audio capture fallback failed:', audioErr.message);
                    }

                    // Periodically draw video onto the offscreen canvas
                    let _canvasDrawInterval = setInterval(() => {
                        if (video.paused || video.ended) return;
                        if (video.videoWidth && video.videoHeight) {
                            offCanvas.width = video.videoWidth;
                            offCanvas.height = video.videoHeight;
                        }
                        ctx.drawImage(video, 0, 0, offCanvas.width, offCanvas.height);
                    }, 33); // ~30fps
                    // Store cleanup ref
                    window._rtmpCanvasDrawInterval = _canvasDrawInterval;

                    startClipRecordingIfNeeded(fallbackStream, streamRef?.id);
                } catch (fallbackErr) {
                    console.warn('[HLS] Canvas fallback also failed:', fallbackErr.message);
                }
            }
        } catch (err) {
            console.warn('[HLS] Clip recording setup failed:', err.message);
        }
    };
    video.addEventListener('playing', _startClipOnPlay);

    // Try HLS first
    if (hlsUrl) {
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
            // Native HLS (Safari)
            _setPlayerStatus({
                protocol: 'hls',
                phase: 'buffer',
                title: 'Loading the live feed',
                detail: 'Your browser can play HLS natively. Waiting for the first live segments.',
                hint: 'If this never starts, the HLS relay may not be producing segments yet.',
                showDiagnostics: true,
            });
            video.playsInline = true;
            video.autoplay = true;
            video.muted = true;
            video.src = hlsUrl;
            video.play().catch(() => {
                showUnmuteOverlay(video);
            });
            return;
        }

        if (typeof Hls !== 'undefined') {
            const hls = new Hls({
                enableWorker: true,
                lowLatencyMode: true,
                backBufferLength: 30,
                liveSyncDurationCount: 2,
                liveMaxLatencyDurationCount: 4,
                maxLiveSyncPlaybackRate: 1.5,
            });
            hls.loadSource(hlsUrl);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                _setPlayerStatus({
                    protocol: 'hls',
                    phase: 'buffer',
                    title: 'Loading the live feed',
                    detail: 'The live playlist loaded. Waiting for enough media to start smoothly.',
                    hint: 'If buffering never finishes, the RTMP/HLS relay may not be producing clean segments yet.',
                    showDiagnostics: true,
                });
                video.playsInline = true;
                video.autoplay = true;
                video.muted = true;
                video.play().catch(() => {
                    showUnmuteOverlay(video);
                });
            });
            hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    console.warn('[HLS] Fatal error, trying HTTP-FLV fallback');
                    _pushPlayerDiagnostic('hls.fatal', `${data.type || 'unknown'}:${data.details || 'unknown'}`);
                    hls.destroy();
                    if (flvUrl) {
                        _setPlayerStatus({
                            protocol: 'flv',
                            phase: 'transport',
                            title: 'Trying the backup feed',
                            detail: 'The HLS path failed, so the player is trying the direct live relay instead.',
                            hint: 'If this also fails, copy the playback log so we can compare both relay attempts.',
                            showDiagnostics: true,
                        });
                        tryFlvPlayer(flvUrl, video);
                    }
                    else showStreamError('HLS stream not available yet. Make sure your RTMP software is streaming.');
                }
            });
            player = { hls, video };
            return;
        }

        // Load HLS.js dynamically
        _setPlayerStatus({
            protocol: 'hls',
            phase: 'engine',
            title: 'Loading the player',
            detail: 'Fetching the HLS playback engine for this browser.',
            hint: 'If this hangs, a CDN issue or browser extension may be blocking the player script.',
        });
        loadExternalScriptOnce('https://cdn.jsdelivr.net/npm/hls.js@latest').then(() => {
            const hls = new Hls({
                enableWorker: true,
                lowLatencyMode: true,
                backBufferLength: 30,
                liveSyncDurationCount: 2,
                liveMaxLatencyDurationCount: 4,
                maxLiveSyncPlaybackRate: 1.5,
            });
            hls.loadSource(hlsUrl);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                _setPlayerStatus({
                    protocol: 'hls',
                    phase: 'buffer',
                    title: 'Loading the live feed',
                    detail: 'The live playlist loaded. Waiting for enough media to begin playback.',
                    hint: 'If this never resolves, the RTMP/HLS relay may not be producing healthy live segments yet.',
                    showDiagnostics: true,
                });
                video.playsInline = true;
                video.autoplay = true;
                video.muted = true;
                video.play().catch(() => {
                    showUnmuteOverlay(video);
                });
            });
            hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    _pushPlayerDiagnostic('hls.fatal', `${data.type || 'unknown'}:${data.details || 'unknown'}`);
                    hls.destroy();
                    if (flvUrl) {
                        _setPlayerStatus({
                            protocol: 'flv',
                            phase: 'transport',
                            title: 'Trying the backup feed',
                            detail: 'The HLS path failed, so the player is trying the direct live relay instead.',
                            hint: 'If this also fails, copy the playback log so we can compare both relay attempts.',
                            showDiagnostics: true,
                        });
                        tryFlvPlayer(flvUrl, video);
                    }
                    else showStreamError('HLS stream not ready. Make sure your RTMP software is streaming.');
                }
            });
            player = { hls, video };
        }).catch(() => {
            if (flvUrl) tryFlvPlayer(flvUrl, video);
            else showStreamError('HLS.js failed to load');
        });
    } else if (flvUrl) {
        tryFlvPlayer(flvUrl, video);
    }
}

function tryFlvPlayer(flvUrl, video) {
    _setPlayerStatus({
        protocol: 'flv',
        phase: 'transport',
        title: 'Connecting the backup feed',
        detail: 'Opening the backup live relay for browsers that cannot use HLS right now.',
        hint: 'If this stalls, the backup relay may be offline or still starting.',
        showDiagnostics: true,
    });

    // Attempt to play HTTP-FLV via flv.js if available
    if (typeof flvjs !== 'undefined' && flvjs.isSupported()) {
        const flvPlayer = flvjs.createPlayer(
            { type: 'flv', url: flvUrl, isLive: true },
            {
                enableStashBuffer: false,
                stashInitialSize: 128,
                lazyLoad: false,
                autoCleanupSourceBuffer: true,
                autoCleanupMaxBackwardDuration: 30,
                autoCleanupMinBackwardDuration: 10,
            }
        );
        flvPlayer.attachMediaElement(video);
        flvPlayer.on?.(flvjs.Events.ERROR, (type, detail, info) => {
            _pushPlayerDiagnostic('flv.error', `${type || 'unknown'}:${detail || 'unknown'}:${info ? JSON.stringify(info) : ''}`);
            showStreamError('HTTP-FLV playback failed while trying to load the live relay.');
        });
        flvPlayer.load();
        _setPlayerStatus({
            protocol: 'flv',
            phase: 'buffer',
            title: 'Loading the backup feed',
            detail: 'The HTTP-FLV relay is connected. Waiting for enough media to start playback.',
            hint: 'If this never starts, the backup relay may not be producing usable frames yet.',
            showDiagnostics: true,
        });
        video.playsInline = true;
        video.autoplay = true;
        video.muted = true;
        flvPlayer.play().catch(() => {
            showUnmuteOverlay(video);
        });
        player = { flv: flvPlayer, video };
    } else {
        loadExternalScriptOnce('https://cdn.jsdelivr.net/npm/flv.js@latest').then(() => {
            if (flvjs.isSupported()) {
                const flvPlayer = flvjs.createPlayer(
                    { type: 'flv', url: flvUrl, isLive: true },
                    {
                        enableStashBuffer: false,
                        stashInitialSize: 128,
                        lazyLoad: false,
                        autoCleanupSourceBuffer: true,
                        autoCleanupMaxBackwardDuration: 30,
                        autoCleanupMinBackwardDuration: 10,
                    }
                );
                flvPlayer.attachMediaElement(video);
                flvPlayer.on?.(flvjs.Events.ERROR, (type, detail, info) => {
                    _pushPlayerDiagnostic('flv.error', `${type || 'unknown'}:${detail || 'unknown'}:${info ? JSON.stringify(info) : ''}`);
                    showStreamError('HTTP-FLV playback failed while trying to load the live relay.');
                });
                flvPlayer.load();
                _setPlayerStatus({
                    protocol: 'flv',
                    phase: 'buffer',
                    title: 'Loading the backup feed',
                    detail: 'The HTTP-FLV relay is connected. Waiting for enough media to begin playback.',
                    hint: 'If this never starts, the backup relay may not be producing usable frames yet.',
                    showDiagnostics: true,
                });
                video.playsInline = true;
                video.autoplay = true;
                video.muted = true;
                flvPlayer.play().catch(() => {
                    showUnmuteOverlay(video);
                });
                player = { flv: flvPlayer, video };
            } else {
                showStreamError('Your browser does not support FLV playback');
            }
        }).catch(() => showStreamError('Failed to load FLV player'));
    }
}

/* ── DVR (Live Stream Seeking via Server-Side VOD) ───────────── */

/**
 * Initialize DVR capability for a live stream.
 * Checks if a server-side VOD recording exists, then enables seeking.
 */
async function initDVR(stream) {
    destroyDVR();
    const streamId = stream.id;

    // Parse stream start time for elapsed calculation
    let startedAt = stream.started_at || stream.created_at;
    if (startedAt) {
        if (typeof startedAt === 'string' && !startedAt.includes('T')) startedAt = startedAt.replace(' ', 'T') + 'Z';
        dvrState.streamStartTime = new Date(startedAt).getTime();
    } else {
        dvrState.streamStartTime = Date.now();
    }

    // Delay first check — give the broadcaster time to upload initial chunks
    dvrState.pollTimer = setTimeout(() => pollDVR(streamId), 5000);
}

/**
 * Poll the server for live VOD info and update DVR state.
 */
async function pollDVR(streamId) {
    try {
        const data = await api(`/vods/stream/${streamId}/live`);
        if (data && data.vod) {
            const vod = data.vod;
            dvrState.vodId = vod.id;
            if (vod.file_path) {
                dvrState.vodFilename = vod.file_path.split('/').pop();
            }

            // Fetch live-info for seekable status and duration
            try {
                const info = await api(`/vods/${vod.id}/live-info`);
                dvrState.duration = info.duration || 0;
                dvrState.seekable = info.seekable || false;
            } catch {}

            // Show DVR controls when we have a seekable copy
            if (dvrState.seekable && dvrState.vodFilename) {
                dvrState.active = true;
                showDVRControls();
            }
        }
    } catch {
        // No live VOD yet — normal for first ~30-60s
    }

    // Continue polling every 20s
    dvrState.pollTimer = setTimeout(() => pollDVR(streamId), 20000);
}

/**
 * Show the DVR progress bar and related controls.
 */
function showDVRControls() {
    const wrap = document.getElementById('dvr-progress-wrap');
    const timeEl = document.getElementById('dvr-time-display');
    const liveBtn = document.getElementById('dvr-live-btn');

    if (wrap) wrap.style.display = '';
    if (timeEl) timeEl.style.display = '';
    if (liveBtn) liveBtn.style.display = '';

    // Start UI update loop
    if (!dvrState.updateTimer) {
        dvrState.updateTimer = setInterval(updateDVRUI, 1000);
        updateDVRUI();
    }

    setupDVRSeek();
}

function _dvrFmtTime(s) {
    if (!s || isNaN(s) || !isFinite(s)) return '0:00';
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
        : `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * Update the DVR progress bar and time display.
 */
function updateDVRUI() {
    if (!dvrState.active) return;

    const fill = document.getElementById('dvr-progress-fill');
    const timeEl = document.getElementById('dvr-time-display');
    const container = document.getElementById('video-container');

    if (dvrState.isLive) {
        // At live edge — progress bar is full (100%)
        if (fill) fill.style.width = '100%';
        const elapsed = dvrState.duration > 0
            ? dvrState.duration
            : Math.max(0, Math.floor((Date.now() - dvrState.streamStartTime) / 1000));
        if (timeEl) timeEl.textContent = `${_dvrFmtTime(elapsed)} [LIVE]`;
        if (container) container.classList.remove('dvr-rewound');
    } else {
        // Rewound — show position within the DVR buffer
        const video = document.getElementById('video-element');
        if (video && dvrState.duration > 0 && !dvrState.seeking) {
            const pct = (video.currentTime / dvrState.duration) * 100;
            if (fill) fill.style.width = Math.min(pct, 100) + '%';
            if (timeEl) timeEl.textContent = `${_dvrFmtTime(video.currentTime)} / ${_dvrFmtTime(dvrState.duration)}`;
        }
        if (container) container.classList.add('dvr-rewound');
    }
}

/**
 * Set up DVR seek bar interaction (click + drag).
 */
function setupDVRSeek() {
    const wrap = document.getElementById('dvr-progress-wrap');
    const fill = document.getElementById('dvr-progress-fill');
    const liveBtn = document.getElementById('dvr-live-btn');
    if (!wrap) return;

    // Prevent duplicate listeners
    if (wrap._dvrListenersAttached) return;
    wrap._dvrListenersAttached = true;

    const seekToPercent = (pct) => {
        if (!dvrState.seekable || dvrState.duration <= 0) return;
        const targetTime = pct * dvrState.duration;
        switchToDVR(targetTime);
    };

    wrap.addEventListener('click', (e) => {
        if (!dvrState.active || !dvrState.seekable) return;
        const rect = wrap.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        seekToPercent(pct);
    });

    // Drag to seek
    wrap.addEventListener('mousedown', (e) => {
        if (!dvrState.active || !dvrState.seekable) return;
        dvrState.seeking = true;
        const rect = wrap.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        if (fill) fill.style.width = pct * 100 + '%';
    });

    const onMove = (e) => {
        if (!dvrState.seeking) return;
        const rect = wrap.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        if (fill) fill.style.width = pct * 100 + '%';
    };
    const onUp = (e) => {
        if (!dvrState.seeking) return;
        dvrState.seeking = false;
        const rect = wrap.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        seekToPercent(pct);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);

    // Touch seek (scoped to the bar so it works on mobile without a hover).
    wrap.addEventListener('touchstart', (e) => {
        if (!dvrState.active || !dvrState.seekable || !e.touches[0]) return;
        dvrState.seeking = true;
        const rect = wrap.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.touches[0].clientX - rect.left) / rect.width));
        if (fill) fill.style.width = pct * 100 + '%';
        e.preventDefault();
    }, { passive: false });
    wrap.addEventListener('touchmove', (e) => {
        if (!dvrState.seeking || !e.touches[0]) return;
        const rect = wrap.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.touches[0].clientX - rect.left) / rect.width));
        if (fill) fill.style.width = pct * 100 + '%';
        e.preventDefault();
    }, { passive: false });
    wrap.addEventListener('touchend', (e) => {
        if (!dvrState.seeking) return;
        dvrState.seeking = false;
        const rect = wrap.getBoundingClientRect();
        const t = (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0].clientX : rect.left;
        const pct = Math.max(0, Math.min(1, (t - rect.left) / rect.width));
        seekToPercent(pct);
    });

    // Live button — jump back to real-time stream
    if (liveBtn) {
        liveBtn.onclick = () => jumpToLive();
    }
}

/**
 * Switch from real-time stream to server-side VOD for seeking.
 * Handles all three protocols: WebRTC (save srcObject), JSMPEG (hide canvas),
 * and HLS/RTMP (detach live player).
 * @param {number} targetTime - Seek position in seconds
 */
function switchToDVR(targetTime) {
    if (!dvrState.vodFilename || !dvrState.seekable) return;

    const video = document.getElementById('video-element');
    const canvas = document.getElementById('video-canvas');
    if (!video) return;

    const liveBtn = document.getElementById('dvr-live-btn');

    // Save the live state for later restoration
    if (dvrState.isLive) {
        if (playerType === 'webrtc' && video.srcObject) {
            dvrState.savedSrcObject = video.srcObject;
        } else if (playerType === 'jsmpeg') {
            // Pause JSMPEG player but keep it alive for quick restoration
            if (player && player.pause) player.pause();
            if (canvas) canvas.style.display = 'none';
        } else if (playerType === 'hls') {
            // Detach the HLS/FLV player from the video element
            dvrState.savedLivePlayer = player;
            if (player && player.hls) {
                try { player.hls.detachMedia(); } catch {}
            } else if (player && player.flv) {
                try { player.flv.pause(); player.flv.unload(); player.flv.detachMediaElement(); } catch {}
            }
        }
    }

    dvrState.isLive = false;

    // Show "Jump to Live" button in alert style
    if (liveBtn) {
        liveBtn.classList.add('dvr-behind');
        liveBtn.innerHTML = '<i class="fa-solid fa-forward"></i> Back to LIVE';
    }

    // Ensure the video element is visible (JSMPEG normally hides it)
    video.style.display = 'block';

    // Switch video source from live to HTTP VOD file
    video.srcObject = null;
    video.src = `/api/vods/file/${dvrState.vodFilename}?t=${Date.now()}`;

    video.addEventListener('loadedmetadata', function _seekOnLoad() {
        video.removeEventListener('loadedmetadata', _seekOnLoad);
        // Use server duration or video.duration, whichever is valid
        const dur = isFinite(video.duration) ? video.duration : dvrState.duration;
        video.currentTime = Math.min(targetTime, dur);
        video.play().catch(() => {});
    });

    console.log(`[DVR] Switched to VOD seeking at ${Math.round(targetTime)}s`);
}

/**
 * Jump back to the live (real-time) stream from DVR mode.
 * Handles all three protocols: WebRTC (restore srcObject),
 * JSMPEG (show canvas, resume player), HLS/RTMP (re-attach live player).
 */
function jumpToLive() {
    const video = document.getElementById('video-element');
    const canvas = document.getElementById('video-canvas');
    if (!video) return;

    const liveBtn = document.getElementById('dvr-live-btn');

    if (playerType === 'webrtc') {
        // Restore WebRTC MediaStream
        if (dvrState.savedSrcObject) {
            video.removeAttribute('src');
            video.srcObject = dvrState.savedSrcObject;
            video.play().catch(() => {});
        }
    } else if (playerType === 'jsmpeg') {
        // Switch back to the JSMPEG canvas player
        video.pause();
        video.removeAttribute('src');
        video.srcObject = null;
        video.style.display = 'none';
        if (canvas) canvas.style.display = 'block';
        if (player && player.play) player.play();
    } else if (playerType === 'hls') {
        // Re-attach HLS/FLV live player to the video element
        video.removeAttribute('src');
        video.srcObject = null;
        if (dvrState.savedLivePlayer) {
            if (dvrState.savedLivePlayer.hls) {
                try {
                    dvrState.savedLivePlayer.hls.attachMedia(video);
                    player = dvrState.savedLivePlayer;
                    video.play().catch(() => {});
                } catch (err) {
                    console.warn('[DVR] HLS re-attach failed, re-initializing:', err.message);
                    if (streamRef) initHLS(streamRef.endpoint || {}, streamRef);
                }
            } else if (dvrState.savedLivePlayer.flv) {
                try {
                    dvrState.savedLivePlayer.flv.attachMediaElement(video);
                    dvrState.savedLivePlayer.flv.load();
                    dvrState.savedLivePlayer.flv.play();
                    player = dvrState.savedLivePlayer;
                } catch (err) {
                    console.warn('[DVR] FLV re-attach failed, re-initializing:', err.message);
                    if (streamRef) initHLS(streamRef.endpoint || {}, streamRef);
                }
            }
        } else if (streamRef) {
            // Fallback: re-initialize the live player from scratch
            initHLS(streamRef.endpoint || {}, streamRef);
        }
    }

    dvrState.isLive = true;

    // Reset live button
    if (liveBtn) {
        liveBtn.classList.remove('dvr-behind');
        liveBtn.innerHTML = '<i class="fa-solid fa-tower-broadcast"></i> LIVE';
    }

    updateDVRUI();
    console.log('[DVR] Jumped back to live');
}

/**
 * Clean up DVR state and timers.
 */
function destroyDVR() {
    if (dvrState.pollTimer) { clearTimeout(dvrState.pollTimer); dvrState.pollTimer = null; }
    if (dvrState.updateTimer) { clearInterval(dvrState.updateTimer); dvrState.updateTimer = null; }
    dvrState.active = false;
    dvrState.isLive = true;
    dvrState.vodId = null;
    dvrState.vodFilename = null;
    dvrState.duration = 0;
    dvrState.seekable = false;
    dvrState.streamStartTime = 0;
    dvrState.savedSrcObject = null;
    dvrState.savedLivePlayer = null;
    dvrState.seeking = false;

    // Hide DVR UI elements
    const wrap = document.getElementById('dvr-progress-wrap');
    const timeEl = document.getElementById('dvr-time-display');
    const liveBtn = document.getElementById('dvr-live-btn');
    if (wrap) { wrap.style.display = 'none'; wrap._dvrListenersAttached = false; }
    if (timeEl) timeEl.style.display = 'none';
    if (liveBtn) liveBtn.style.display = 'none';
}

/* ── Player controls ──────────────────────────────────────────── */
function setupVideoControls() {
    const btnPlay = document.getElementById('btn-play-pause');
    const btnVol = document.getElementById('btn-volume');
    const volSlider = document.getElementById('volume-slider');
    const btnFull = document.getElementById('btn-fullscreen');

    // Restore persisted volume (or default 75)
    const audioPrefs = getSavedPlayerAudioState();
    const savedVol = Math.round(audioPrefs.volume * 100);
    volSlider.value = savedVol;
    // For WebRTC, tryPlay() in handleViewerOffer sets volume + handles autoplay policy.
    // For JSMPEG, onSourceEstablished handles it. For HLS, set it here.
    if (playerType === 'hls') {
        setVolume(savedVol / 100, { muted: audioPrefs.muted });
    }

    let muted = audioPrefs.muted;
    let playing = true;

    // Sync mute button icon to initial state
    btnVol.innerHTML = muted
        ? '<i class="fa-solid fa-volume-xmark"></i>'
        : '<i class="fa-solid fa-volume-high"></i>';

    // Detect vertical (portrait) video and add CSS class for responsive layout
    const _detectVerticalVideo = () => {
        const vid = document.getElementById('video-element');
        const container = document.getElementById('video-container');
        if (!vid || !container) return;
        const w = vid.videoWidth;
        const h = vid.videoHeight;
        if (w > 0 && h > 0) {
            container.classList.toggle('is-vertical', h > w);
        }
    };
    const vid = document.getElementById('video-element');
    if (vid) {
        vid.addEventListener('loadedmetadata', _detectVerticalVideo);
        vid.addEventListener('resize', _detectVerticalVideo);

        // Sync local muted state when the browser auto-mutes for autoplay policy
        vid.addEventListener('volumechange', () => {
            // Enforce the user's saved MUTED preference: if something (a reconnect,
            // track replacement, autoplay quirk) unmutes the element while the user
            // has audio turned off, re-mute it. User unmute actions persist muted=0
            // first, so getSavedMuted() is false by the time this runs — no conflict.
            if (getSavedMuted() && !vid.muted && vid.volume > 0) {
                vid.muted = true;
                vid.volume = 0;
                return; // this triggers volumechange again; next pass is consistent
            }
            const actuallyMuted = vid.muted || vid.volume === 0;
            if (actuallyMuted !== muted) {
                muted = actuallyMuted;
                btnVol.innerHTML = muted
                    ? '<i class="fa-solid fa-volume-xmark"></i>'
                    : '<i class="fa-solid fa-volume-high"></i>';
            }
        });
    }

    btnPlay.onclick = () => {
        playing = !playing;
        btnPlay.innerHTML = playing
            ? '<i class="fa-solid fa-pause"></i>'
            : '<i class="fa-solid fa-play"></i>';

        // Record intent BEFORE calling play()/pause() so the 'play' guard below
        // (and reconnect tryPlay()) knows this is a deliberate viewer choice.
        setViewerPausedIntent(!playing);

        if (playerType === 'jsmpeg' && player && dvrState.isLive) {
            playing ? player.play() : player.pause();
        } else {
            const vid = document.getElementById('video-element');
            playing ? vid.play().catch(() => {}) : vid.pause();
        }
    };
    // Enforce pause intent against the element's autoplay attribute: swapping srcObject
    // on a reconnect makes an autoplay <video> resume on its own, bypassing tryPlay().
    // If the viewer paused, immediately re-pause. (Legit resume clears intent first.)
    // Installed once — setupVideoControls re-runs per stream switch on the same element.
    if (vid && !vid._pauseIntentGuard) {
        vid._pauseIntentGuard = true;
        vid.addEventListener('play', () => {
            if (!vid._viewerPaused) return;
            try { vid.pause(); } catch {}
            const btn = document.getElementById('btn-play-pause');
            if (btn) btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        });
    }
    // Start showing pause icon since autoplay
    btnPlay.innerHTML = '<i class="fa-solid fa-pause"></i>';

    btnVol.onclick = () => {
        muted = !muted;
        btnVol.innerHTML = muted
            ? '<i class="fa-solid fa-volume-xmark"></i>'
            : '<i class="fa-solid fa-volume-high"></i>';
        setVolume(muted ? 0 : volSlider.value / 100, { muted, persistLevel: !muted });
        // User interacted — remove unmute overlay if unmuting
        if (!muted) {
            const vid = document.getElementById('video-element');
            if (vid && vid.muted) { vid.muted = false; vid.play().catch(() => {}); }
            document.getElementById('unmute-overlay')?.remove();
        }
    };

    volSlider.oninput = () => {
        const v = volSlider.value / 100;
        setVolume(v, { muted: v === 0 });
        muted = v === 0;
        btnVol.innerHTML = muted
            ? '<i class="fa-solid fa-volume-xmark"></i>'
            : '<i class="fa-solid fa-volume-high"></i>';
        // User interacted — remove unmute overlay and ensure unmuted
        if (v > 0) {
            const vid = document.getElementById('video-element');
            if (vid && vid.muted) { vid.muted = false; vid.play().catch(() => {}); }
            document.getElementById('unmute-overlay')?.remove();
        }
    };

    btnFull.onclick = () => {
        const container = document.getElementById('video-container');
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            container.requestFullscreen().catch(() => {});
        }
    };

    // Clip button
    document.getElementById('btn-clip').onclick = () => {
        if (!currentUser) return showModal('login');
        createLiveClip();
    };

    // Stats button — toggle the live stream-stats overlay
    const btnStats = document.getElementById('btn-stats');
    if (btnStats) btnStats.onclick = () => toggleStreamStats();
    const btnStatsClose = document.getElementById('btn-stats-close');
    if (btnStatsClose) btnStatsClose.onclick = () => toggleStreamStats(false);

    // Keyboard shortcuts for DVR seeking
    const container = document.getElementById('video-container');
    if (container) {
        container.tabIndex = 0;
        container.addEventListener('keydown', (e) => {
            if (!dvrState.active || !dvrState.seekable) return;
            const video = document.getElementById('video-element');
            if (!video) return;

            switch (e.key) {
                case 'ArrowLeft':
                    e.preventDefault();
                    if (dvrState.isLive) {
                        // First rewind: jump to 10s before live edge
                        const pos = Math.max(0, dvrState.duration - 10);
                        switchToDVR(pos);
                    } else {
                        // Already in DVR — rewind 5 more seconds
                        const newTime = Math.max(0, video.currentTime - 5);
                        video.currentTime = newTime;
                        updateDVRUI();
                    }
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    if (!dvrState.isLive) {
                        const newTime = video.currentTime + 5;
                        if (newTime >= dvrState.duration - 2) {
                            jumpToLive();
                        } else {
                            video.currentTime = newTime;
                            updateDVRUI();
                        }
                    }
                    break;
            }
        });
    }
}

/* ── Clip Recording (rolling buffer with periodic cycling) ──── */
let _clipCycleTimer = null;
let _clipPrevSegment = null; // Backup from previous recorder cycle
let _clipCycleGen = 0;      // Generation counter — prevents stale recorder events from corrupting state

function startClipRecording(stream, streamId) {
    stopClipRecording();
    clipStreamId = streamId;
    _startNewRecorderCycle(stream);

    // Cycle the recorder every CLIP_BUFFER_SECONDS to keep WebM cluster
    // timestamps fresh. Without cycling, a 2-hour stream produces clusters
    // timestamped at ~7200s — browsers can't play files with no data at t=0.
    _clipCycleTimer = setInterval(() => {
        _cycleClipRecorder(stream);
    }, CLIP_BUFFER_SECONDS * 1000);
}

function _startNewRecorderCycle(stream) {
    const gen = ++_clipCycleGen;
    clipHeaderChunk = null;
    clipChunks = [];
    clipRecorderMimeType = null;
    clipTimingBaseMs = Date.now();

    try {
        const { recorder, mimeType } = createClipRecorder(stream);
        clipRecorder = recorder;
        clipRecorderMimeType = mimeType;
        const initialElapsedSeconds = getLiveStreamElapsedSeconds();
        clipTimingBaseMs = Date.now() - Math.round(initialElapsedSeconds * 1000);

        clipRecorder.ondataavailable = (e) => {
            // Ignore events from a stale recorder that was stopped during a cycle.
            // Without this guard, the old recorder's final ondataavailable fires
            // asynchronously AFTER _startNewRecorderCycle resets clipHeaderChunk,
            // causing a data chunk to be stored as the "header" (corrupt EBML).
            if (gen !== _clipCycleGen) return;

            if (e.data && e.data.size > 0) {
                const capturedAt = Date.now();
                const approxEndSeconds = Math.max(0, (capturedAt - clipTimingBaseMs) / 1000);
                const approxStartSeconds = Math.max(0, approxEndSeconds - 1);
                // The very first chunk contains the WebM EBML header + initialization
                // segment. We store it separately so the rolling window never discards it.
                if (!clipHeaderChunk) {
                    clipHeaderChunk = e.data;
                    console.log(`[Clip] Header chunk captured (${e.data.size} bytes)`);
                    return; // don't add to the timed buffer
                }
                clipChunks.push({
                    data: e.data,
                    time: capturedAt,
                    startStreamSeconds: approxStartSeconds,
                    endStreamSeconds: approxEndSeconds,
                });
                // Keep only last CLIP_BUFFER_SECONDS worth of data chunks
                const cutoff = capturedAt - (CLIP_BUFFER_SECONDS * 1000);
                clipChunks = clipChunks.filter(c => c.time >= cutoff);
            }
        };

        clipRecorder.onerror = (e) => {
            console.error('[Clip] MediaRecorder error:', e.error?.message || e);
        };

        // Record in 1-second intervals to fill the buffer
        clipRecorder.start(1000);
        console.log(`[Clip] Rolling buffer recording started (${mimeType}, tracks: ${stream.getTracks().map(t => t.kind).join(', ')})`);
    } catch (err) {
        console.warn('[Clip] MediaRecorder not available:', err.message);
    }
}

function _cycleClipRecorder(stream) {
    // Save current cycle as backup (so clips right after a cycle still have data)
    if (clipHeaderChunk && clipChunks.length) {
        _clipPrevSegment = {
            header: clipHeaderChunk,
            chunks: [...clipChunks],
            mimeType: clipRecorderMimeType,
        };
    }

    // Stop current recorder (triggers final ondataavailable)
    if (clipRecorder && clipRecorder.state !== 'inactive') {
        try { clipRecorder.stop(); } catch {}
    }

    // Start a fresh recorder with reset timestamps
    _startNewRecorderCycle(stream);
    console.log('[Clip] Recorder cycled — timestamps reset');
}

function stopClipRecording() {
    if (_clipCycleTimer) { clearInterval(_clipCycleTimer); _clipCycleTimer = null; }
    _clipCycleGen++; // invalidate any pending ondataavailable from the stopped recorder
    if (clipRecorder && clipRecorder.state !== 'inactive') {
        try { clipRecorder.stop(); } catch {}
    }
    clipRecorder = null;
    clipSourceStream = null;
    clipHeaderChunk = null;
    clipChunks = [];
    clipStreamId = null;
    clipRecorderMimeType = null;
    clipTimingBaseMs = 0;
    _clipPrevSegment = null;
}

let liveClipRequestInFlight = false;

function setClipButtonBusy(isBusy) {
    const btn = document.getElementById('btn-clip');
    if (!btn) return;
    btn.disabled = !!isBusy;
    btn.classList.toggle('is-busy', !!isBusy);
    btn.innerHTML = isBusy
        ? '<i class="fa-solid fa-spinner fa-spin"></i>'
        : '<i class="fa-solid fa-scissors"></i>';
}

async function createLiveClip() {
    if (liveClipRequestInFlight) {
        toast('A clip is already being created — please wait a moment', 'info');
        return;
    }
    if (!streamRef || !streamRef.id) { toast('No stream selected', 'error'); return; }
    liveClipRequestInFlight = true;
    setClipButtonBusy(true);
    try {
        // Server-side first: works whenever the stream is being recorded (the default, and
        // self-healing). Only if the server truly has no recording do we fall back to the
        // browser's rolling MediaRecorder buffer. This makes clipping robust even if the
        // client's cached `server_clip` flag is stale (e.g. recording healed after page load).
        const result = await _serverLiveClipAttempt(false);
        if (result === 'no_recording') await _clientLiveClip();
    } catch (err) {
        toast('Failed to create clip: ' + (err.message || 'error'), 'error');
    } finally {
        liveClipRequestInFlight = false;
        setClipButtonBusy(false);
    }
}

// Fallback: assemble a clip from the browser's rolling MediaRecorder buffer and upload it.
// Used only when the server has no recording for this stream. Caller owns busy/in-flight state.
async function _clientLiveClip() {
    // Use current cycle if it has enough data, otherwise fall back to previous
    let header = clipHeaderChunk;
    let chunks = clipChunks;
    let mimeType = clipRecorderMimeType;

    if ((!header || chunks.length < 3) && _clipPrevSegment) {
        header = _clipPrevSegment.header;
        chunks = _clipPrevSegment.chunks;
        mimeType = _clipPrevSegment.mimeType;
    }

    // Client-side EBML header validation — first 4 bytes must be 1A 45 DF A3.
    // If the header chunk is corrupt (e.g. a stale data chunk), fall back to
    // the previous segment before the server rejects it.
    if (header && header.size >= 4) {
        try {
            const headerBytes = new Uint8Array(await header.slice(0, 4).arrayBuffer());
            const validEbml = headerBytes[0] === 0x1A && headerBytes[1] === 0x45
                           && headerBytes[2] === 0xDF && headerBytes[3] === 0xA3;
            if (!validEbml) {
                console.warn('[Clip] Current header chunk has invalid EBML magic — falling back to previous segment');
                if (_clipPrevSegment && _clipPrevSegment.header) {
                    const prevBytes = new Uint8Array(await _clipPrevSegment.header.slice(0, 4).arrayBuffer());
                    const prevValid = prevBytes[0] === 0x1A && prevBytes[1] === 0x45
                                   && prevBytes[2] === 0xDF && prevBytes[3] === 0xA3;
                    if (prevValid) {
                        header = _clipPrevSegment.header;
                        chunks = _clipPrevSegment.chunks;
                        mimeType = _clipPrevSegment.mimeType;
                    } else {
                        toast('Clip data is temporarily corrupt — please try again in a few seconds', 'warning');
                        return;
                    }
                } else {
                    toast('Clip data is temporarily corrupt — please try again in a few seconds', 'warning');
                    return;
                }
            }
        } catch (ebmlErr) {
            console.warn('[Clip] EBML validation failed:', ebmlErr.message);
        }
    }

    if (!header || !chunks.length || !clipStreamId) {
        toast('No clip data available yet — wait a moment', 'info');
        return;
    }

    toast('Creating clip…', 'info');

    try {
        // Assemble: header chunk first, then rolling buffer chunks.
        // The header contains the WebM EBML header + track initialization
        // which is required for the file to be playable.
        const blobs = [header, ...chunks.map(c => c.data)];
        // Always use 'video/webm' — MediaRecorder on all platforms produces WebM,
        // but some browsers set Blob.type to codec-qualified strings or empty,
        // which can trip the server's MIME filter.
        const clipBlob = new Blob(blobs, { type: 'video/webm' });

        const firstChunk = chunks[0];
        const lastChunk = chunks[chunks.length - 1];
        const startTime = Math.max(0, Math.floor(firstChunk.startStreamSeconds || 0));
        const endTime = Math.max(startTime + 1, Math.ceil(lastChunk.endStreamSeconds || startTime + chunks.length));
        const duration = Math.max(1, endTime - startTime);

        const formData = new FormData();
        formData.append('video', clipBlob, `clip-${Date.now()}.webm`);
        formData.append('stream_id', clipStreamId);
        formData.append('title', `Clip from stream`);
        formData.append('start_time', String(startTime));
        formData.append('end_time', String(endTime));

        const token = localStorage.getItem('token');
        const resp = await fetch('/api/vods/clips', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData,
        });

        if (!resp.ok) {
            let errMsg = 'Upload failed';
            try { const err = await resp.json(); errMsg = err.error || errMsg; } catch { errMsg = `Server error (${resp.status})`; }
            throw new Error(errMsg);
        }

        const data = await resp.json();
        const clipId = data.clip?.id;
        toast(`Clip created! (${Math.round(duration)}s) — Trim & title it`, 'success');

        // Let the user trim and title the clip (only the final cut is stored)
        if (clipId) {
            openClipTrimEditor(clipId);
        }
    } catch (err) {
        toast('Failed to create clip: ' + err.message, 'error');
    }
}

// Server cuts the clip from its own live recording — no client encoding/upload.
// Returns 'ok' | 'no_recording' | 'handled'. Shows escalating progress while the cut is
// slow, and auto-retries once when the recording is just spinning back up (e.g. after a
// server restart). Caller owns busy/in-flight state.
async function _serverLiveClipAttempt(isRetry) {
    let slow1, slow2;
    const startProgress = (label) => {
        toast(label, 'info');
        slow1 = setTimeout(() => toast('Still processing your clip… hang tight', 'info'), 6000);
        slow2 = setTimeout(() => toast('Almost there — finalizing the clip…', 'info'), 14000);
    };
    const clearSlow = () => { clearTimeout(slow1); clearTimeout(slow2); };
    startProgress(isRetry ? 'Retrying clip…' : 'Creating clip…');
    try {
        const token = localStorage.getItem('token');
        const resp = await fetch('/api/vods/clips', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ stream_id: streamRef.id, live: true, duration: CLIP_BUFFER_SECONDS, title: 'Clip from stream' }),
        });
        const data = await resp.json().catch(() => ({}));
        clearSlow();
        if (!resp.ok) {
            // Recording is warming back up (post-restart heal) — auto-retry once.
            if (data.recording_starting && !isRetry) {
                toast('Recording is warming up — retrying in a few seconds…', 'info');
                await new Promise(r => setTimeout(r, 5000));
                return _serverLiveClipAttempt(true);
            }
            if (data.no_recording) return 'no_recording'; // caller falls back to the browser buffer
            if (resp.status === 429) { toast(data.error || 'You are clipping too fast — wait a moment', 'warning'); return 'handled'; }
            toast(data.error || 'Failed to create clip', 'error');
            return 'handled';
        }
        const clipId = data.clip && data.clip.id;
        if (data.deduplicated) toast('That moment is already clipped — opening it', 'info');
        else toast('Clip created! — Trim & title it', 'success');
        if (clipId) openClipTrimEditor(clipId);
        return 'ok';
    } catch (err) {
        clearSlow();
        toast('Failed to create clip: ' + (err.message || 'error'), 'error');
        return 'handled';
    }
}

/**
 * Show a modal prompt for the user to title their clip after creation.
 * @param {number} clipId - The newly created clip's ID
 */
function promptClipTitle(clipId) {
    // Exit fullscreen first — the browser top layer hides body-appended overlays
    const showOverlay = () => {
        const overlay = document.createElement('div');
        overlay.id = 'clip-title-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;';
        _buildClipTitleModal(overlay, clipId);
    };
    if (document.fullscreenElement) {
        document.exitFullscreen().then(showOverlay).catch(showOverlay);
    } else {
        showOverlay();
    }
}

function _buildClipTitleModal(overlay, clipId) {
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--card-bg, #1a1a2e);border:1px solid var(--border, #333);border-radius:12px;padding:24px;max-width:400px;width:90%;text-align:center;';
    modal.innerHTML = `
        <h3 style="margin:0 0 8px 0"><i class="fa-solid fa-scissors"></i> Name Your Clip</h3>
        <p style="margin:0 0 16px 0;opacity:0.7;font-size:0.9rem">Give your clip a title so others know what it is</p>
        <input type="text" id="live-clip-title-input" class="form-input" placeholder="Enter clip title..."
               maxlength="200" style="width:100%;box-sizing:border-box;margin-bottom:16px;font-size:1rem;padding:10px 12px">
        <div style="display:flex;gap:8px;justify-content:center">
            <button id="live-clip-title-save" class="btn btn-primary" style="flex:1">
                <i class="fa-solid fa-check"></i> Save Title
            </button>
            <button id="live-clip-title-skip" class="btn" style="flex:0.6;opacity:0.7">
                Skip
            </button>
        </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const input = document.getElementById('live-clip-title-input');
    input.focus();

    const saveTitle = async () => {
        const title = input.value.trim();
        if (!title) {
            input.style.borderColor = '#e53e3e';
            input.placeholder = 'Please enter a title...';
            input.focus();
            return;
        }
        try {
            const token = localStorage.getItem('token');
            const resp = await fetch(`/api/clips/${clipId}/title`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ title }),
            });
            if (!resp.ok) throw new Error('Failed to save');
            toast('Clip titled!', 'success');
        } catch (err) {
            toast('Failed to save title: ' + err.message, 'error');
        }
        overlay.remove();
    };

    const skip = () => overlay.remove();

    document.getElementById('live-clip-title-save').onclick = saveTitle;
    document.getElementById('live-clip-title-skip').onclick = skip;
    input.onkeydown = (e) => { if (e.key === 'Enter') saveTitle(); if (e.key === 'Escape') skip(); };
    overlay.onclick = (e) => { if (e.target === overlay) skip(); };
}

// After a clip is created, let the user preview it and trim the start/end further.
// Only the final cut is stored (the server re-encodes and replaces the file).
// Falls back to the plain title prompt if the clip can't be loaded for preview.
async function openClipTrimEditor(clipId) {
    let clip;
    try {
        const token = localStorage.getItem('token');
        const resp = await fetch(`/api/clips/${clipId}`, token ? { headers: { 'Authorization': `Bearer ${token}` } } : undefined);
        const data = await resp.json().catch(() => ({}));
        clip = data.clip;
    } catch { /* */ }
    if (!clip || !clip.file_path || !(clip.duration_seconds > 0)) {
        // Can't preview — fall back to the simple title prompt.
        return promptClipTitle(clipId);
    }
    const fileName = String(clip.file_path).split('/').pop();
    const dur = Number(clip.duration_seconds);

    const show = () => _buildClipTrimModal(clipId, fileName, dur, clip.title || '');
    if (document.fullscreenElement) document.exitFullscreen().then(show).catch(show);
    else show();
}

function _buildClipTrimModal(clipId, fileName, dur, defaultTitle) {
    const fmt = (s) => {
        s = Math.max(0, s);
        const m = Math.floor(s / 60);
        const sec = (s % 60).toFixed(1).padStart(4, '0');
        return `${m}:${sec}`;
    };

    let startT = 0, endT = dur;

    const overlay = document.createElement('div');
    overlay.id = 'clip-trim-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.78);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--card-bg,#1a1a2e);border:1px solid var(--border,#333);border-radius:14px;padding:22px;max-width:600px;width:100%;box-sizing:border-box;max-height:92vh;overflow:auto;';
    modal.innerHTML = `
        <h3 style="margin:0 0 4px 0"><i class="fa-solid fa-scissors"></i> Trim &amp; Name Your Clip</h3>
        <p style="margin:0 0 14px 0;opacity:0.7;font-size:0.88rem">Drag the handles to trim the start and end. Only the final cut is saved.</p>
        <div style="position:relative;background:#000;border-radius:10px;overflow:hidden;margin-bottom:14px">
            <video id="clip-trim-video" src="/api/vods/file/${fileName}" muted playsinline autoplay
                   style="width:100%;max-height:46vh;display:block;background:#000"></video>
        </div>
        <div style="margin-bottom:10px">
            <div id="clip-trim-track" style="position:relative;height:8px;border-radius:6px;background:var(--border,#333);margin:6px 2px 4px">
                <div id="clip-trim-region" style="position:absolute;top:0;bottom:0;left:0;right:0;background:var(--accent,#8b5cf6);border-radius:6px;opacity:0.65"></div>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:0.8rem;opacity:0.85;margin-bottom:8px">
                <span>Start: <strong id="clip-trim-start-lbl">0:00.0</strong></span>
                <span>Length: <strong id="clip-trim-len-lbl">${fmt(dur)}</strong></span>
                <span>End: <strong id="clip-trim-end-lbl">${fmt(dur)}</strong></span>
            </div>
            <label style="display:block;font-size:0.78rem;opacity:0.7;margin:2px 0">Start</label>
            <input type="range" id="clip-trim-start" min="0" max="${dur}" step="0.1" value="0" style="width:100%">
            <label style="display:block;font-size:0.78rem;opacity:0.7;margin:6px 0 2px">End</label>
            <input type="range" id="clip-trim-end" min="0" max="${dur}" step="0.1" value="${dur}" style="width:100%">
        </div>
        <input type="text" id="clip-trim-title" class="form-input" placeholder="Give your clip a title..."
               maxlength="200" style="width:100%;box-sizing:border-box;margin:10px 0 14px;font-size:1rem;padding:10px 12px">
        <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
            <button id="clip-trim-skip" class="btn" style="opacity:0.7">Skip</button>
            <button id="clip-trim-save" class="btn btn-primary"><i class="fa-solid fa-check"></i> Save Clip</button>
        </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const video = modal.querySelector('#clip-trim-video');
    const startSl = modal.querySelector('#clip-trim-start');
    const endSl = modal.querySelector('#clip-trim-end');
    const region = modal.querySelector('#clip-trim-region');
    const startLbl = modal.querySelector('#clip-trim-start-lbl');
    const endLbl = modal.querySelector('#clip-trim-end-lbl');
    const lenLbl = modal.querySelector('#clip-trim-len-lbl');
    const titleInput = modal.querySelector('#clip-trim-title');
    const saveBtn = modal.querySelector('#clip-trim-save');
    const skipBtn = modal.querySelector('#clip-trim-skip');
    if (defaultTitle && defaultTitle !== 'Clip from stream') titleInput.value = defaultTitle;

    const MIN_LEN = 1;
    const refresh = () => {
        startLbl.textContent = fmt(startT);
        endLbl.textContent = fmt(endT);
        lenLbl.textContent = fmt(endT - startT);
        region.style.left = (dur > 0 ? (startT / dur) * 100 : 0) + '%';
        region.style.right = (dur > 0 ? (1 - endT / dur) * 100 : 0) + '%';
    };
    refresh();

    startSl.addEventListener('input', () => {
        startT = parseFloat(startSl.value);
        if (startT > endT - MIN_LEN) { startT = Math.max(0, endT - MIN_LEN); startSl.value = startT; }
        try { video.currentTime = startT; } catch { /* */ }
        refresh();
    });
    endSl.addEventListener('input', () => {
        endT = parseFloat(endSl.value);
        if (endT < startT + MIN_LEN) { endT = Math.min(dur, startT + MIN_LEN); endSl.value = endT; }
        try { video.currentTime = Math.max(startT, endT - 0.15); } catch { /* */ }
        refresh();
    });

    // Loop playback within the selected [start, end] window.
    video.addEventListener('timeupdate', () => {
        if (video.currentTime >= endT - 0.04 || video.currentTime < startT - 0.4) {
            try { video.currentTime = startT; } catch { /* */ }
        }
    });
    video.play().catch(() => {});

    const close = () => { try { video.pause(); } catch {} overlay.remove(); };

    const doSave = async () => {
        const title = titleInput.value.trim();
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
        try {
            const token = localStorage.getItem('token');
            const resp = await fetch(`/api/vods/clips/${clipId}/trim`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ start: startT, end: endT, title }),
            });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok) throw new Error(data.error || 'Failed to save');
            toast(data.unchanged ? 'Clip saved!' : 'Clip trimmed & saved!', 'success');
            close();
        } catch (err) {
            toast('Failed to save clip: ' + (err.message || 'error'), 'error');
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<i class="fa-solid fa-check"></i> Save Clip';
        }
    };

    saveBtn.onclick = doSave;
    skipBtn.onclick = close;
    titleInput.onkeydown = (e) => { if (e.key === 'Enter') doSave(); if (e.key === 'Escape') close(); };
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
}

function setVolume(v) {
    const options = arguments[1] || {};
    const volume = Math.max(0, Math.min(1, Number(v) || 0));
    const muted = options.muted ?? (volume === 0);
    if (playerType === 'jsmpeg' && player && player.audioOut && dvrState.isLive) {
        player.audioOut.gain.value = muted ? 0 : volume;
    } else {
        const vid = document.getElementById('video-element');
        if (vid) {
            vid.volume = muted ? 0 : volume;
            vid.muted = muted;
        }
    }
    try {
        if (options.persistLevel !== false) localStorage.setItem(PLAYER_VOLUME_KEY, String(Math.round(volume * 100)));
        localStorage.setItem(PLAYER_MUTED_KEY, muted ? '1' : '0');
    } catch {}
}

function getSavedVolume() {
    try {
        const v = parseInt(localStorage.getItem(PLAYER_VOLUME_KEY), 10);
        return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 75;
    } catch { return 75; }
}

function getSavedMuted() {
    try {
        return localStorage.getItem(PLAYER_MUTED_KEY) === '1';
    } catch {
        return false;
    }
}

function getSavedPlayerAudioState() {
    return {
        volume: getSavedVolume() / 100,
        muted: getSavedMuted(),
    };
}

/* ── Cleanup ──────────────────────────────────────────────────── */
function destroyPlayer() {
    _playerGen++; // invalidate any in-flight WebRTC reconnect/rewatch closures from the old session
    stopClipRecording();
    destroyDVR();
    _hideReconnectingIndicator();
    _clearPlayerSlowTimer();
    _clearPlayerPlaceholderHideTimer();
    _resetPlayerRevealState();
    if (_jsmpegClipSetupTimer) {
        clearTimeout(_jsmpegClipSetupTimer);
        _jsmpegClipSetupTimer = null;
    }
    // Clean up RTMP canvas fallback interval
    if (window._rtmpCanvasDrawInterval) {
        clearInterval(window._rtmpCanvasDrawInterval);
        window._rtmpCanvasDrawInterval = null;
    }
    // Clean up JSMPEG offscreen canvas draw interval
    if (window._jsmpegDrawInterval) {
        clearInterval(window._jsmpegDrawInterval);
        window._jsmpegDrawInterval = null;
    }
    if (player) {
        if (playerType === 'jsmpeg' && player.destroy) player.destroy();
        if (playerType === 'webrtc') {
            if (player.pc) player.pc.close();
            if (player.ws) player.ws.close();
        }
        if (playerType === 'hls') {
            if (player.hls) player.hls.destroy();
            if (player.flv) { player.flv.pause(); player.flv.unload(); player.flv.detachMediaElement(); player.flv.destroy(); }
        }
        player = null;
    }
    playerType = null;
    streamRef = null;

    const canvas = document.getElementById('video-canvas');
    const video = document.getElementById('video-element');
    if (canvas) canvas.style.display = 'none';
    if (video) { video.style.display = 'none'; video.muted = true; video.srcObject = null; video.removeAttribute('src'); }
    document.getElementById('unmute-overlay')?.remove();

    // Clean up VOD & Clip video elements so they stop playing on navigation
    for (const id of ['vp-video', 'clp-video']) {
        const el = document.getElementById(id);
        if (el) {
            el.pause();
            el.removeAttribute('src');
            el.load(); // forces the browser to release the media resource
            el.style.display = 'none';
        }
    }

    const placeholder = document.querySelector('.video-placeholder');
    if (placeholder) {
        _resetPlayerLoadState('default', null);
        _setPlayerStatus({
            protocol: 'default',
            phase: 'signal',
            title: 'Getting the stream ready',
            detail: 'Preparing the live player.',
        });
    }
}

function showStreamEnded() {
    _hideReconnectingIndicator();
    _resetPlayerRevealState();
    _setPlayerStatus({
        protocol: playerType || streamRef?.protocol || playerLoadState?.protocol || 'default',
        phase: 'ended',
        title: 'Stream has ended',
        detail: 'Check back later for the next live session.',
        slowAfterMs: 0,
    });
    document.getElementById('video-canvas').style.display = 'none';
    document.getElementById('video-element').style.display = 'none';
    // Tell the channel page immediately. It owns the live/offline swap and the
    // go-live polling, and would otherwise only notice on its next 15s tick —
    // leaving viewers staring at this card long after a quick restart.
    try {
        window.dispatchEvent(new CustomEvent('openvibe:stream-ended', {
            detail: { streamId: streamRef?.id || null },
        }));
    } catch { /* non-critical accelerator */ }
}

function showStreamError(msg) {
    _resetPlayerRevealState();
    _setPlayerStatus({
        protocol: playerType || streamRef?.protocol || playerLoadState?.protocol || 'default',
        phase: 'error',
        title: 'Couldn’t start playback',
        detail: msg,
        hint: 'Copy the playback log below and send it our way if you want help debugging it faster.',
        severity: 'error',
        showDiagnostics: true,
        slowAfterMs: 0,
    });
}

/** Clear stream error and reset placeholder to default connecting state */
function _clearStreamError() {
    if (playerLoadState?.severity === 'error') {
        playerLoadState.severity = 'info';
        playerLoadState.showDiagnostics = false;
        playerLoadState.isSlow = false;
        const placeholder = document.querySelector('.video-placeholder');
        if (placeholder) placeholder.style.display = 'none';
    }
}

/**
 * Show a click-to-play overlay when autoplay policy forced muted playback.
 * One tap unmutes, restores volume, and removes the overlay.
 */
function showUnmuteOverlay(video) {
    // Don't duplicate
    if (document.getElementById('unmute-overlay')) return;
    const container = document.getElementById('video-container');
    if (!container) return;
    const overlay = document.createElement('div');
    overlay.id = 'unmute-overlay';
    overlay.style.cssText = 'position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;cursor:pointer;background:rgba(0,0,0,0.45);transition:background 0.2s;';
    overlay.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;gap:12px;">
            <div style="width:72px;height:72px;border-radius:50%;background:rgba(255,255,255,0.15);border:2px solid rgba(255,255,255,0.6);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);transition:transform 0.15s,background 0.15s;">
                <i class="fa-solid fa-play" style="font-size:1.8rem;color:#fff;margin-left:4px;"></i>
            </div>
            <span style="color:#fff;font-size:0.9rem;opacity:0.85;text-shadow:0 1px 4px rgba(0,0,0,0.6);">Click to enable audio</span>
        </div>`;
    // Hover effect on the play circle
    const circle = overlay.querySelector('div > div');
    overlay.addEventListener('mouseenter', () => { if (circle) { circle.style.transform = 'scale(1.1)'; circle.style.background = 'rgba(255,255,255,0.25)'; } });
    overlay.addEventListener('mouseleave', () => { if (circle) { circle.style.transform = ''; circle.style.background = ''; } });
    overlay.addEventListener('click', () => {
        video.muted = false;
        // Restore volume from saved preference / slider
        const slider = document.getElementById('volume-slider');
        const savedVol = getSavedVolume();
        const vol = savedVol > 0 ? savedVol / 100 : (slider ? slider.value / 100 : 0.75);
        video.volume = vol;
        if (slider) slider.value = Math.round(vol * 100);
        try { localStorage.setItem(PLAYER_MUTED_KEY, '0'); } catch {}
        overlay.remove();
        // Sync the volume button icon
        const volBtn = document.getElementById('btn-volume');
        if (volBtn) volBtn.innerHTML = vol === 0
            ? '<i class="fa-solid fa-volume-xmark"></i>'
            : '<i class="fa-solid fa-volume-high"></i>';
        // Try playing again now that user has interacted
        video.play().catch(() => {});
    }, { once: true });
    container.appendChild(overlay);
}

/* ── Player stats overlay ─────────────────────────────────────
   Toggled by the gauge button. Shows the real streaming method, codec,
   bitrate, resolution, fps and loss — measured live from the video element
   and (for WebRTC/SFU) RTCPeerConnection/Transport getStats(). */
let _statsPoll = null;
let _statsPrev = null;        // { id, ts, bytes } for the chosen video inbound-rtp
let _statsPrevFrames = null;  // totalVideoFrames for the HLS/JSMPEG fps fallback

function toggleStreamStats(force) {
    const panel = document.getElementById('stream-stats-panel');
    if (!panel) return;
    const show = (force === undefined) ? (panel.style.display === 'none') : !!force;
    panel.style.display = show ? '' : 'none';
    if (show) {
        _statsPrev = null;
        _updateStreamStats();
        if (_statsPoll) clearInterval(_statsPoll);
        _statsPoll = setInterval(_updateStreamStats, 1000);
    } else if (_statsPoll) {
        clearInterval(_statsPoll); _statsPoll = null;
    }
}

function _getStatsSource() {
    // Both RTCPeerConnection (legacy) and the mediasoup recv Transport expose getStats()
    if (typeof player !== 'undefined' && player) {
        if (player.pc && typeof player.pc.getStats === 'function') return player.pc;
        if (player._sfuRecvTransport && typeof player._sfuRecvTransport.getStats === 'function') return player._sfuRecvTransport;
    }
    return null;
}

async function _updateStreamStats() {
    const body = document.getElementById('stream-stats-body');
    if (!body) return;
    const vid = document.getElementById('video-element');
    const rows = [];
    let method = 'Unknown';
    try { method = (typeof _getPlayerProtocolLabel === 'function') ? _getPlayerProtocolLabel(playerType) : (typeof playerType !== 'undefined' ? playerType : 'Unknown'); } catch { /* */ }
    rows.push(['Method', method || 'Unknown']);
    let haveRes = false;
    if (vid && vid.videoWidth) { rows.push(['Resolution', `${vid.videoWidth}×${vid.videoHeight}`]); haveRes = true; }

    let codec = null, fps = null, kbps = null, loss = null, jitter = null;
    const src = _getStatsSource();
    if (src) {
        try {
            const report = await src.getStats();
            // Pick the VIDEO inbound-rtp (kind/mediaType, or one that's decoding frames).
            // On the SFU path kind isn't always tagged, so fall back to the inbound
            // with the most bytes — never audio, which caused 0 kbps / odd loss.
            let inbound = null, bestBytes = -1;
            report.forEach(st => {
                if (st.type !== 'inbound-rtp') return;
                const isVideo = st.kind === 'video' || st.mediaType === 'video' || st.frameWidth > 0 || st.framesDecoded > 0;
                if (isVideo && (st.bytesReceived || 0) > bestBytes) { inbound = st; bestBytes = st.bytesReceived || 0; }
            });
            if (!inbound) report.forEach(st => { if (st.type === 'inbound-rtp' && (st.bytesReceived || 0) > bestBytes) { inbound = st; bestBytes = st.bytesReceived || 0; } });
            if (inbound) {
                if (inbound.framesPerSecond) fps = Math.round(inbound.framesPerSecond);
                if (!haveRes && inbound.frameWidth) { rows.push(['Resolution', `${inbound.frameWidth}×${inbound.frameHeight}`]); haveRes = true; }
                if (typeof inbound.packetsLost === 'number') loss = Math.max(0, inbound.packetsLost);
                if (typeof inbound.jitter === 'number') jitter = Math.round(inbound.jitter * 1000);
                const now = inbound.timestamp, bytes = inbound.bytesReceived || 0, id = inbound.id;
                if (_statsPrev && _statsPrev.id === id && bytes >= _statsPrev.bytes && now > _statsPrev.ts) {
                    kbps = Math.max(0, Math.round(((bytes - _statsPrev.bytes) * 8) / (now - _statsPrev.ts))); // bits/ms = kbit/s
                }
                _statsPrev = { id, ts: now, bytes };
                if (inbound.codecId && report.get) { const c = report.get(inbound.codecId); if (c && c.mimeType) codec = c.mimeType.replace(/^(video|audio)\//, '').toUpperCase(); }
            }
        } catch { /* getStats unavailable */ }
    }
    // FPS fallback for HLS/JSMPEG (no peer connection)
    if (fps == null && vid && vid.getVideoPlaybackQuality) {
        try {
            const q = vid.getVideoPlaybackQuality();
            if (_statsPrevFrames != null) fps = Math.max(0, q.totalVideoFrames - _statsPrevFrames);
            _statsPrevFrames = q.totalVideoFrames;
        } catch { /* */ }
    }
    if (codec) rows.push(['Codec', codec]);
    if (kbps != null) rows.push(['Bitrate', kbps >= 1000 ? (kbps / 1000).toFixed(1) + ' Mbps' : kbps + ' kbps']);
    if (fps != null) rows.push(['FPS', String(fps)]);
    if (loss != null) rows.push(['Packets lost', String(loss)]);
    if (jitter != null) rows.push(['Jitter', jitter + ' ms']);
    if (navigator.connection && navigator.connection.effectiveType) rows.push(['Network', navigator.connection.effectiveType]);
    const esc2 = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    body.innerHTML = rows.map(([k, v]) => `<span class="ssp-k">${esc2(k)}</span><span class="ssp-v">${esc2(v)}</span>`).join('');
}
