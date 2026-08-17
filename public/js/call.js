/**
 * OpenVibe.Live — Group Call Client
 * 
 * Discord-style voice/video group call alongside a live stream.
 * Full-mesh WebRTC: each participant maintains a peer connection to every other.
 * Signaling via WebSocket at /ws/call?streamId=N&token=X
 */

/* ── State ─────────────────────────────────────────────────── */
const callState = {
    ws: null,
    streamId: null,
    channelId: null,     // voice channel ID (e.g. 'public', 'stream-5', 'user-123-...')
    vcMode: false,       // true when connected via voice-channels.js Chat tab
    myPeerId: null,
    callMode: null,     // 'mic', 'mic+cam', 'cam+mic'
    isStreamer: false,
    broadcastMode: false, // true when streamer is in the call from broadcast page
    localStream: null,
    /** @type {Map<string, {pc: RTCPeerConnection, username: string, userId: number|null, isStreamer: boolean, muted: boolean, cameraOff: boolean, forceMuted: boolean, forceCameraOff: boolean, localMuted: boolean, localVolume: number, localCameraOff: boolean, audioEl: HTMLAudioElement|null, videoEl: HTMLVideoElement|null, videoStream: MediaStream|null, avatarUrl: string|null, profileColor: string|null}>} */
    peers: new Map(),
    muted: false,
    cameraOff: true,
    forceMuted: false,         // server-side force mute applied to us
    forceCameraOff: false,     // server-side force camera off applied to us
    joined: false,
    connecting: false,
    intentionalDisconnect: false,
    selectedMic: 'default',
    selectedCam: 'default',
    reconnectTimer: null,
    reconnectDelay: 3000,
    openContextMenu: null,     // currently open peer context menu peerId
    openContextMenuRect: null,
    canModerate: false,
    localUsername: null,
    localAnonId: null,
    localDisplayName: null,
    localUserId: null,
    localNameFX: null,
    localAvatarUrl: null,
    localProfileColor: null,
    localSpeaking: false,
    localSpeechDetected: false,
    inputMode: 'open',
    pttKey: 'Space',
    pttPressed: false,
    vadThreshold: 32,
    audioContext: null,
    localAnalyser: null,
    localSpeechSource: null,
    analysisStream: null,
    levelInterval: null,
    speechHoldUntil: 0,
    statusPollTimer: null,
    lastSyncedCallMode: null,
    popoutPeerId: null,
    popoutWindow: null,
};

// ICE servers are fetched from the server at join time to avoid
// hardcoding credentials into client-side JS.
let _iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
];
async function _ensureIceServers() {
    try {
        const res = await fetch('/api/auth/ice-servers');
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data.iceServers) && data.iceServers.length) {
                _iceServers = data.iceServers;
            }
        }
    } catch (e) {
        console.warn('[Call] Could not fetch ICE servers, using STUN-only fallback', e);
    }
}
const CALL_WS_MAX_BUFFERED_AMOUNT = 256 * 1024;
const CALL_AUDIO_MAX_BITRATE = 32000;
const CALL_VIDEO_MAX_BITRATE = 350000;
const CALL_VIDEO_MAX_FRAMERATE = 15;

/* ── Join / Leave Sound Effects ────────────────────────────── */
const _callSounds = {
    _ctx: null,
    _volume: 0.25,
    _getCtx() {
        if (!this._ctx || this._ctx.state === 'closed') {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (Ctx) this._ctx = new Ctx();
        }
        if (this._ctx?.state === 'suspended') this._ctx.resume().catch(() => {});
        return this._ctx;
    },
    /** Play a short synth tone for join/leave events */
    play(type) {
        try {
            const ctx = this._getCtx();
            if (!ctx) return;
            const vol = this._volume;
            if (vol <= 0) return;
            const now = ctx.currentTime;

            if (type === 'join') {
                // Rising two-tone chime (Discord-like)
                const osc1 = ctx.createOscillator();
                const osc2 = ctx.createOscillator();
                const gain = ctx.createGain();
                osc1.connect(gain);
                osc2.connect(gain);
                gain.connect(ctx.destination);
                osc1.type = 'sine';
                osc2.type = 'sine';
                osc1.frequency.setValueAtTime(587, now); // D5
                osc2.frequency.setValueAtTime(880, now + 0.09); // A5
                gain.gain.setValueAtTime(vol * 0.7, now);
                gain.gain.setValueAtTime(vol, now + 0.09);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
                osc1.start(now);
                osc1.stop(now + 0.09);
                osc2.start(now + 0.09);
                osc2.stop(now + 0.28);
            } else if (type === 'leave') {
                // Falling two-tone (reverse chime)
                const osc1 = ctx.createOscillator();
                const osc2 = ctx.createOscillator();
                const gain = ctx.createGain();
                osc1.connect(gain);
                osc2.connect(gain);
                gain.connect(ctx.destination);
                osc1.type = 'sine';
                osc2.type = 'sine';
                osc1.frequency.setValueAtTime(587, now); // D5
                osc2.frequency.setValueAtTime(440, now + 0.09); // A4
                gain.gain.setValueAtTime(vol * 0.6, now);
                gain.gain.setValueAtTime(vol * 0.5, now + 0.09);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
                osc1.start(now);
                osc1.stop(now + 0.09);
                osc2.start(now + 0.09);
                osc2.stop(now + 0.25);
            }
        } catch {}
    },
};

_loadCallUserSettings();

/** Resolve element ID based on broadcast vs channel mode */
function _cid(id) {
    if (callState.broadcastMode) {
        const el = document.getElementById('bc-' + id);
        if (el) return el;
    }
    return document.getElementById(id);
}

function _loadCallUserSettings() {
    try {
        const raw = localStorage.getItem('openvibe_call_settings');
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (typeof saved.selectedMic === 'string' && saved.selectedMic) callState.selectedMic = saved.selectedMic;
        if (typeof saved.selectedCam === 'string' && saved.selectedCam) callState.selectedCam = saved.selectedCam;
        if (['open', 'ptt', 'vad'].includes(saved.inputMode)) callState.inputMode = saved.inputMode;
        if (typeof saved.pttKey === 'string' && saved.pttKey) callState.pttKey = saved.pttKey;
        const threshold = Number(saved.vadThreshold);
        if (Number.isFinite(threshold)) callState.vadThreshold = Math.max(5, Math.min(80, threshold));
    } catch {}
}

function _saveCallUserSettings() {
    try {
        localStorage.setItem('openvibe_call_settings', JSON.stringify({
            selectedMic: callState.selectedMic,
            selectedCam: callState.selectedCam,
            inputMode: callState.inputMode,
            pttKey: callState.pttKey,
            vadThreshold: callState.vadThreshold,
        }));
    } catch {}
}

function _syncCallSettingsUI() {
    const mappings = [
        ['call-input-mode', callState.inputMode],
        ['call-input-mode-switch', callState.inputMode],
        ['bc-call-input-mode-switch', callState.inputMode],
        ['vc-input-mode', callState.inputMode],
        ['vc-input-mode-switch', callState.inputMode],
        ['call-ptt-key', callState.pttKey],
        ['call-ptt-key-switch', callState.pttKey],
        ['bc-call-ptt-key-switch', callState.pttKey],
        ['vc-ptt-key', callState.pttKey],
        ['vc-ptt-key-switch', callState.pttKey],
        ['call-vad-threshold', String(callState.vadThreshold)],
        ['call-vad-threshold-switch', String(callState.vadThreshold)],
        ['bc-call-vad-threshold-switch', String(callState.vadThreshold)],
        ['vc-vad-threshold', String(callState.vadThreshold)],
        ['vc-vad-threshold-switch', String(callState.vadThreshold)],
    ];
    mappings.forEach(([id, value]) => {
        const el = document.getElementById(id);
        if (el) el.value = value;
    });

    ['call-vad-threshold-value', 'call-vad-threshold-value-switch', 'bc-call-vad-threshold-value-switch', 'vc-vad-value', 'vc-vad-switch-value'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = `${callState.vadThreshold}%`;
    });

    const showPtt = callState.inputMode === 'ptt';
    const showVad = callState.inputMode === 'vad';
    ['call-ptt-group', 'call-ptt-switch-group', 'bc-call-ptt-switch-group', 'vc-ptt-group', 'vc-ptt-switch-group'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = showPtt ? '' : 'none';
    });
    ['call-vad-group', 'call-vad-switch-group', 'bc-call-vad-switch-group', 'vc-vad-group', 'vc-vad-switch-group'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = showVad ? '' : 'none';
    });
    ['call-ptt-status', 'bc-call-ptt-status', 'vc-ptt-status'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = showPtt && callState.joined ? '' : 'none';
    });
    ['call-ptt-status-key', 'bc-call-ptt-status-key', 'vc-ptt-status-key'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = _formatCallKey(callState.pttKey);
    });
}

function _formatCallKey(code) {
    const map = {
        Space: 'Space', KeyV: 'V', KeyT: 'T', KeyB: 'B', KeyX: 'X',
        AltLeft: 'Left Alt', AltRight: 'Right Alt',
        ControlLeft: 'Left Ctrl', ShiftLeft: 'Left Shift',
        Mouse3: 'Middle Click', Mouse4: 'Mouse 4', Mouse5: 'Mouse 5',
    };
    return map[code] || code;
}

function _resolveParticipantDisplayName(info) {
    if (!info) return 'Unknown';
    if (info.userId || info.username) return info.displayName || info.username || 'Unknown';
    if (info.anonId) return info.anonId;
    if (typeof info.displayName === 'string' && /^anon\d+$/i.test(info.displayName)) return info.displayName;
    return info.displayName || 'Unknown';
}

function _applyLocalParticipantInfo(info) {
    callState.localUsername = info?.username || currentUser?.username || null;
    callState.localAnonId = info?.anonId || null;
    callState.localDisplayName = _resolveParticipantDisplayName(info) || currentUser?.display_name || currentUser?.username || 'You';
    callState.localUserId = info?.userId || currentUser?.id || null;
    callState.localNameFX = info?.nameFX || null;
    callState.localAvatarUrl = info?.avatarUrl || currentUser?.avatar_url || null;
    callState.localProfileColor = info?.profileColor || currentUser?.profile_color || null;
}

function _mergePeerParticipantInfo(peer, info) {
    if (!peer || !info) return;
    peer.username = info.username || null;
    peer.anonId = info.anonId || null;
    peer.displayName = _resolveParticipantDisplayName(info);
    peer.userId = info.userId || null;
    peer.isStreamer = !!info.isStreamer;
    peer.muted = !!info.muted;
    peer.cameraOff = info.cameraOff !== false;
    peer.forceMuted = !!info.forceMuted;
    peer.forceCameraOff = !!info.forceCameraOff;
    peer.speaking = !!info.speaking;
    peer.nameFX = info.nameFX || null;
    peer.avatarUrl = info.avatarUrl || null;
    peer.profileColor = info.profileColor || null;
}

function _optimizeCallSender(sender, track) {
    if (!sender || !track) return;

    try {
        if (track.kind === 'audio') track.contentHint = 'speech';
        if (track.kind === 'video') track.contentHint = 'motion';
    } catch {}

    if (typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') return;

    try {
        const params = sender.getParameters() || {};
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        if (track.kind === 'audio') {
            params.encodings[0].maxBitrate = CALL_AUDIO_MAX_BITRATE;
        } else if (track.kind === 'video') {
            params.encodings[0].maxBitrate = CALL_VIDEO_MAX_BITRATE;
            params.encodings[0].maxFramerate = CALL_VIDEO_MAX_FRAMERATE;
        }
        sender.setParameters(params).catch(err => {
            console.warn(`[Call] setParameters failed for ${track.kind}:`, err.message);
        });
    } catch {}
}

function _syncCallAuthState() {
    if (!callState.ws || callState.ws.readyState !== WebSocket.OPEN || !(callState.channelId || callState.streamId)) return;
    _sendCallMsg({ type: 'auth-update', token: _getAuthToken() || null });
}

/* ── Render Scheduling (coalesce rapid updates) ────────────── */

let _renderDirty = false;
let _renderRAF = null;
let _lastFullRenderTime = 0;
const _MIN_RENDER_INTERVAL = 100; // ms — no more than ~10 full rebuilds/sec

/**
 * Schedule a full UI render on the next animation frame.
 * Multiple calls within the same frame are coalesced into one render.
 * Throttled to avoid excessive DOM rebuilds from rapid state changes.
 */
function _scheduleRender() {
    if (_renderDirty) return;
    _renderDirty = true;
    if (_renderRAF) { cancelAnimationFrame(_renderRAF); _renderRAF = null; }
    _renderRAF = requestAnimationFrame(() => {
        const now = performance.now();
        if (now - _lastFullRenderTime < _MIN_RENDER_INTERVAL) {
            // Too soon — defer to next frame but keep dirty flag so calls are coalesced
            _renderRAF = requestAnimationFrame(() => {
                _renderDirty = false;
                _renderRAF = null;
                _lastFullRenderTime = performance.now();
                _renderCallUI();
            });
            return;
        }
        _renderDirty = false;
        _renderRAF = null;
        _lastFullRenderTime = now;
        _renderCallUI();
    });
}

/**
 * Targeted speaking-state update — avoids full grid rebuild for the most
 * frequent event (~12 updates/sec per speaking participant).
 * Returns true if the tile was found and updated in-place.
 */
function _updateTileSpeaking(peerId, speaking, muted, forceMuted) {
    const gridId = callState.vcMode ? 'vc-participants-grid' : (callState.broadcastMode ? 'bc-call-participants-grid' : 'call-participants-grid');
    const grid = document.getElementById(gridId);
    if (!grid) return false;

    const tile = grid.querySelector(`[data-peer-id="${CSS.escape(peerId)}"]`);
    if (!tile) return false;

    const isSpeaking = speaking && !muted && !forceMuted;
    tile.classList.toggle('is-speaking', isSpeaking);

    // Update the avatar ring glow for the speaking state
    const avatar = tile.querySelector('.call-avatar');
    if (avatar) {
        avatar.classList.toggle('speaking', isSpeaking);
    }

    // Swap the audio indicator icon in-place
    const indicators = tile.querySelector('.call-indicators');
    if (indicators) {
        const existingIcon = indicators.querySelector('.call-icon-speaking');
        if (isSpeaking && !existingIcon) {
            // Only add speaking icon if not muted (muted icon takes precedence)
            if (!indicators.querySelector('.call-icon-muted') && !indicators.querySelector('.call-icon-force-muted')) {
                const icon = document.createElement('i');
                icon.className = 'fa-solid fa-wave-square call-icon-speaking';
                icon.title = 'Speaking';
                indicators.insertBefore(icon, indicators.firstChild);
            }
        } else if (!isSpeaking && existingIcon) {
            existingIcon.remove();
        }
    }

    return true;
}

/**
 * Targeted mute-state update — avoids full grid rebuild for mute/unmute events.
 * Returns true if the tile was found and updated in-place.
 */
function _updateTileMuted(peerId, muted, forceMuted) {
    const gridId = callState.vcMode ? 'vc-participants-grid' : (callState.broadcastMode ? 'bc-call-participants-grid' : 'call-participants-grid');
    const grid = document.getElementById(gridId);
    if (!grid) return false;

    const tile = grid.querySelector(`[data-peer-id="${CSS.escape(peerId)}"]`);
    if (!tile) return false;

    tile.classList.toggle('is-muted', muted || forceMuted);
    if (muted || forceMuted) {
        tile.classList.remove('is-speaking');
        const avatar = tile.querySelector('.call-avatar');
        if (avatar) avatar.classList.remove('speaking');
    }

    // Update indicators
    const indicators = tile.querySelector('.call-indicators');
    if (indicators) {
        // Remove old mute/speaking icons
        indicators.querySelectorAll('.call-icon-muted, .call-icon-force-muted, .call-icon-speaking').forEach(el => el.remove());
        // Add the right one
        if (forceMuted) {
            const icon = document.createElement('i');
            icon.className = 'fa-solid fa-microphone-slash call-icon-force-muted';
            icon.title = 'Force-muted by streamer';
            indicators.insertBefore(icon, indicators.firstChild);
        } else if (muted) {
            const icon = document.createElement('i');
            icon.className = 'fa-solid fa-microphone-slash call-icon-muted';
            icon.title = 'Muted';
            indicators.insertBefore(icon, indicators.firstChild);
        }
    }

    return true;
}

/* ── Public API (called from stream page) ──────────────────── */

/**
 * Initialize the call panel UI for a stream.
 * Called when a channel page loads and the stream has call_mode set.
 */
function initCallPanel(stream) {
    const panel = document.getElementById('call-panel');
    if (!panel) return;

    callState.broadcastMode = false;

    callState.streamId = stream.id;
    callState.callMode = stream.call_mode;
    callState.lastSyncedCallMode = stream.call_mode || null;
    callState.isStreamer = !!(currentUser && stream.user_id === currentUser.id);

    _syncCallSettingsUI();
    _startViewerCallStatusSync(stream.id);

    if (!stream.call_mode) {
        panel.style.display = 'none';
        return;
    }

    panel.style.display = '';

    // Update mode display
    const modeLabel = document.getElementById('call-mode-label');
    if (modeLabel) {
        const labels = { 'mic': 'Voice Chat', 'mic+cam': 'Voice + Camera', 'cam+mic': 'Video Call' };
        modeLabel.textContent = labels[stream.call_mode] || 'Group Call';
    }

    // Update hint text based on mode
    const hint = document.getElementById('call-join-hint');
    if (hint) {
        const hints = {
            'mic': 'Join the voice chat to talk with the streamer and other viewers',
            'mic+cam': 'Join voice chat — you can optionally enable your camera',
            'cam+mic': 'Join the video call — microphone and camera required',
        };
        hint.textContent = hints[stream.call_mode] || '';
    }

    // Show/hide camera elements based on mode
    const camBtn = document.getElementById('call-btn-camera');
    if (camBtn) camBtn.style.display = stream.call_mode === 'mic' ? 'none' : '';

    const camGroup = document.getElementById('call-cam-group');
    if (camGroup) camGroup.style.display = stream.call_mode === 'mic' ? 'none' : '';

    // Reset connected badge
    const connBadge = document.getElementById('call-connected-badge');
    if (connBadge) connBadge.style.display = 'none';

    // Populate device selectors
    _populateCallDevices();

    // Fetch current participants
    _fetchCallStatus(stream.id);
}

/**
 * Initialize the call panel for the broadcast/dashboard page.
 * The streamer auto-joins the call — no join button needed.
 */
function initBroadcastCallPanel(streamId, callMode) {
    const panel = document.getElementById('bc-call-panel');
    if (!panel || !callMode) {
        if (panel) panel.style.display = 'none';
        return;
    }

    // If already in a call for this stream, skip re-init
    if ((callState.joined || callState.connecting) && callState.streamId === streamId && callState.broadcastMode && callState.callMode === callMode) return;

    // Clean up any previous call
    if (callState.joined || callState.connecting) {
        callState.joined = false;
        callState.connecting = false;
        _cleanupCall();
    }

    callState.streamId = streamId;
    callState.callMode = callMode;
    callState.lastSyncedCallMode = callMode;
    callState.isStreamer = true;
    callState.broadcastMode = true;

    // Show/hide camera elements based on mode
    const camBtn = document.getElementById('bc-call-btn-camera');
    if (camBtn) camBtn.style.display = callMode === 'mic' ? 'none' : '';
    const camSwitchGroup = document.getElementById('bc-call-cam-switch-group');
    if (camSwitchGroup) camSwitchGroup.style.display = callMode === 'mic' ? 'none' : '';

    // Populate device selectors
    _populateCallDevices();
    _syncCallSettingsUI();

    // Auto-join
    joinCall();
}

/** Leave the broadcast call (called when disabling call mode or ending stream) */
function leaveBroadcastCall() {
    if (!callState.broadcastMode) return;
    leaveCall();
    callState.broadcastMode = false;
    const panel = document.getElementById('bc-call-panel');
    if (panel) panel.style.display = 'none';
}

/** Join the group call */
async function joinCall() {
    if (callState.joined || callState.connecting || !(callState.channelId || callState.streamId)) return;

    callState.connecting = true;

    // Fetch ICE/TURN server config from the server before creating any peer connections
    await _ensureIceServers();

    if (callState.reconnectTimer) {
        clearTimeout(callState.reconnectTimer);
        callState.reconnectTimer = null;
    }

    const mode = callState.callMode;
    // Camera is always off by default — user must explicitly opt in
    const wantCameraOff = callState.startCameraOff !== undefined ? callState.startCameraOff : true;

    // If a reusable preview stream was passed in (from voice-channels setup),
    // use it directly instead of calling getUserMedia again — avoids the
    // double-acquisition lag on Steam Deck / PipeWire.
    let reuseStream = callState._reusableStream || null;
    delete callState._reusableStream;

    if (reuseStream) {
        // Ensure the reusable stream has an audio track; drop video if camera should be off
        const audioTracks = reuseStream.getAudioTracks();
        if (!audioTracks.length || audioTracks[0].readyState !== 'live') {
            // Stream is stale — fall through to fresh getUserMedia
            reuseStream.getTracks().forEach(t => t.stop());
            reuseStream = null;
        } else if (wantCameraOff) {
            // Strip video tracks when starting with camera off
            reuseStream.getVideoTracks().forEach(t => {
                t.stop();
                reuseStream.removeTrack(t);
            });
            callState.cameraOff = true;
        } else {
            callState.cameraOff = !reuseStream.getVideoTracks().some(t => t.readyState === 'live');
        }
    }

    if (reuseStream) {
        callState.localStream = reuseStream;
        callState.noMic = false;
    } else {
        // If we're broadcasting, clone the broadcast's audio track instead of
        // calling getUserMedia again — avoids device contention on Linux/PipeWire
        // where a second getUserMedia can steal the mic from the broadcast or
        // produce silent/dead tracks.
        let broadcastAudioTrack = null;
        if (typeof isStreaming === 'function' && isStreaming() && typeof getActiveStreamState === 'function') {
            const bss = getActiveStreamState();
            const bTrack = bss?.localStream?.getAudioTracks()?.[0];
            if (bTrack && bTrack.readyState === 'live') {
                broadcastAudioTrack = bTrack.clone();
                console.log('[Call] Sharing cloned audio track from broadcast — avoiding device contention');
            }
        }

        if (broadcastAudioTrack) {
            callState.localStream = new MediaStream([broadcastAudioTrack]);
            callState.cameraOff = true;
            callState._sharedBroadcastAudio = true;
            callState.noMic = false;

            // Camera: only add if user explicitly opted in and mode supports it
            if ((mode === 'cam+mic' || mode === 'mic+cam') && !wantCameraOff) {
                try {
                    const camStream = await navigator.mediaDevices.getUserMedia({
                        video: { deviceId: callState.selectedCam !== 'default' ? { exact: callState.selectedCam } : undefined, width: { ideal: 320 }, height: { ideal: 240 } }
                    });
                    camStream.getVideoTracks().forEach(t => callState.localStream.addTrack(t));
                    callState.cameraOff = false;
                } catch (camErr) {
                    console.warn('[Call] Camera acquisition failed (broadcast audio shared):', camErr.message);
                }
            }
        } else {
            // Not broadcasting or clone failed — acquire mic directly
            // Warn if broadcasting: a new getUserMedia might steal the mic from the stream
            if (typeof isStreaming === 'function' && isStreaming()) {
                console.warn('[Call] Broadcasting is active but could not clone audio — new getUserMedia may cause device contention');
            }
            const constraints = { audio: { deviceId: callState.selectedMic !== 'default' ? { exact: callState.selectedMic } : undefined } };

            // Camera: only enabled if the user explicitly opted in
            if ((mode === 'cam+mic' || mode === 'mic+cam') && !wantCameraOff) {
                constraints.video = { deviceId: callState.selectedCam !== 'default' ? { exact: callState.selectedCam } : undefined, width: { ideal: 320 }, height: { ideal: 240 } };
                callState.cameraOff = false;
            } else {
                constraints.video = false;
                callState.cameraOff = true;
            }

            try {
                callState.localStream = await navigator.mediaDevices.getUserMedia(constraints);
                callState.noMic = false;
            } catch (err) {
                console.warn('[Call] getUserMedia failed — joining without mic:', err.message);
                callState.noMic = true;
                callState.mediaErrorType = err.name;
                callState.localStream = new MediaStream(); // empty stream — still connect as listener
            }
        }
    }

    // Clear the one-shot preference
    delete callState.startCameraOff;

    _setupLocalAudioProcessing();
    _applyLocalAudioGate();

    // Show local preview
    _updateLocalPreview();

    // Connect signaling WebSocket
    _connectCallWs();
}

/** Leave the group call */
function leaveCall() {
    const streamId = callState.streamId;
    const wasBroadcast = callState.broadcastMode;
    const wasVcMode = callState.vcMode;
    callState.joined = false;
    callState.connecting = false;
    _cleanupCall();
    _renderCallUI();
    // Resume HTTP status polling for viewer call UI (not needed for broadcast or VC mode)
    if (streamId && !wasBroadcast && !wasVcMode) {
        _startViewerCallStatusSync(streamId);
    }
}

/** Internal cleanup (shared by leave, kick, ban) */
function _cleanupCall() {
    _closeCallVideoPopout();

    callState.intentionalDisconnect = true;

    // Close all peer connections
    for (const [peerId] of callState.peers) {
        _closePeer(peerId);
    }
    callState.peers.clear();

    // Stop local media
    if (callState.localStream) {
        callState.localStream.getTracks().forEach(t => t.stop());
        callState.localStream = null;
    }
    if (callState.analysisStream) {
        callState.analysisStream.getTracks().forEach(t => t.stop());
        callState.analysisStream = null;
    }
    if (callState.levelInterval) {
        clearInterval(callState.levelInterval);
        callState.levelInterval = null;
    }
    if (callState.localSpeechSource) {
        try { callState.localSpeechSource.disconnect(); } catch {}
        callState.localSpeechSource = null;
    }
    callState.localAnalyser = null;
    if (callState.audioContext) {
        try { callState.audioContext.close(); } catch {}
        callState.audioContext = null;
    }

    // Close sound effects AudioContext
    if (_callSounds._ctx) {
        try { _callSounds._ctx.close(); } catch {}
        _callSounds._ctx = null;
    }

    // Close shared peer audio context (volume amplification)
    if (_sharedPeerAudioCtx) {
        try { _sharedPeerAudioCtx.close(); } catch {}
        _sharedPeerAudioCtx = null;
    }

    // Close WebSocket
    if (callState.ws) {
        try { callState.ws.close(); } catch {}
        callState.ws = null;
    }

    if (callState.reconnectTimer) {
        clearTimeout(callState.reconnectTimer);
        callState.reconnectTimer = null;
    }

    callState.myPeerId = null;
    callState.muted = false;
    callState.cameraOff = true;
    callState.forceMuted = false;
    callState.forceCameraOff = false;
    callState.connecting = false;
    callState.canModerate = false;
    _closePeerContextMenu();
    callState.localUsername = null;
    callState.localAnonId = null;
    callState.localDisplayName = null;
    callState.localUserId = null;
    callState.localNameFX = null;
    callState.localAvatarUrl = null;
    callState.localProfileColor = null;
    callState.localSpeaking = false;
    callState.localSpeechDetected = false;
    callState.pttPressed = false;
    callState.speechHoldUntil = 0;
    delete callState._sharedBroadcastAudio;
    callState._localVideoEl = null;
}

/** Toggle mute */
function toggleCallMute() {
    if (callState.forceMuted) {
        _callSystemMessage('You are force-muted by the streamer');
        return;
    }
    callState.muted = !callState.muted;
    _applyLocalAudioGate();
    if (callState.muted && callState.localSpeaking) {
        callState.localSpeaking = false;
        _sendCallMsg({ type: 'speaking', speaking: false });
    }
    if (callState.ws && callState.ws.readyState === WebSocket.OPEN) {
        callState.ws.send(JSON.stringify({ type: 'mute', muted: callState.muted }));
    }
    _renderCallUI();
}

/** Toggle camera */
async function toggleCallCamera() {
    if (callState.callMode === 'mic') return;
    if (callState.forceCameraOff) {
        _callSystemMessage('Your camera is disabled by the streamer');
        return;
    }

    if (callState.cameraOff) {
        // Enable camera
        try {
            const camStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    deviceId: callState.selectedCam !== 'default' ? { exact: callState.selectedCam } : undefined,
                    width: { ideal: 320 }, height: { ideal: 240 },
                },
            });
            const camTrack = camStream.getVideoTracks()[0];
            callState.localStream.addTrack(camTrack);
            callState.cameraOff = false;

            // Add video track to all existing peer connections —
            // use replaceTrack if a video sender slot already exists (avoids renegotiation)
            for (const [peerId, peer] of callState.peers) {
                try {
                    const existingSender = peer.pc.getSenders().find(s => s.track?.kind === 'video' || (s.track === null && s._isVideoSlot));
                    if (existingSender) {
                        await existingSender.replaceTrack(camTrack);
                        _optimizeCallSender(existingSender, camTrack);
                    } else {
                        const sender = peer.pc.addTrack(camTrack, callState.localStream);
                        _optimizeCallSender(sender, camTrack);
                    }
                } catch (peerErr) {
                    console.warn(`[Call] Failed to add camera track to peer ${peerId}:`, peerErr.message);
                }
            }
        } catch (err) {
            console.warn('[Call] Camera enable failed:', err);
            _callSystemMessage('Could not enable camera');
            return;
        }
    } else {
        // Disable camera
        const videoTracks = callState.localStream.getVideoTracks();
        videoTracks.forEach(t => {
            t.stop();
            callState.localStream.removeTrack(t);
        });
        callState.cameraOff = true;

        // Remove video senders from all peer connections
        for (const [peerId, peer] of callState.peers) {
            try {
                const senders = peer.pc.getSenders();
                for (const sender of senders) {
                    if (sender.track && sender.track.kind === 'video') {
                        peer.pc.removeTrack(sender);
                    }
                }
            } catch (peerErr) {
                console.warn(`[Call] Failed to remove camera track from peer ${peerId}:`, peerErr.message);
            }
        }
    }

    if (callState.ws && callState.ws.readyState === WebSocket.OPEN) {
        callState.ws.send(JSON.stringify({ type: 'camera-off', cameraOff: callState.cameraOff }));
    }
    _updateLocalPreview();
    _renderCallUI();
}

/** Enable microphone while in-call (e.g. after joining without mic or after permission recovery) */
async function requestMicAccess() {
    if (!callState.joined) return;
    const btn = document.getElementById('vc-enable-mic-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Requesting…'; }

    try {
        const constraints = {
            audio: { deviceId: callState.selectedMic !== 'default' ? { exact: callState.selectedMic } : undefined }
        };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        const audioTrack = stream.getAudioTracks()[0];
        if (!callState.localStream) callState.localStream = new MediaStream();
        callState.localStream.addTrack(audioTrack);
        callState.noMic = false;
        callState.mediaErrorType = null;
        callState.muted = false;

        // Add audio track to all existing peer connections
        for (const [peerId, peer] of callState.peers) {
            try {
                const existingSender = peer.pc.getSenders().find(s => s.track?.kind === 'audio');
                if (existingSender) {
                    await existingSender.replaceTrack(audioTrack);
                    _optimizeCallSender(existingSender, audioTrack);
                } else {
                    const sender = peer.pc.addTrack(audioTrack, callState.localStream);
                    _optimizeCallSender(sender, audioTrack);
                }
            } catch (peerErr) {
                console.warn(`[Call] Failed to add mic track to peer ${peerId}:`, peerErr.message);
            }
        }

        _setupLocalAudioProcessing();
        _applyLocalAudioGate();
        _updateLocalPreview();

        if (callState.ws && callState.ws.readyState === WebSocket.OPEN) {
            callState.ws.send(JSON.stringify({ type: 'mute', muted: false }));
        }

        _callSystemMessage('Microphone enabled', 'success');
        _renderCallUI();
    } catch (err) {
        if (btn) { btn.disabled = false; btn.textContent = 'Enable Mic'; }
        const msg = err.name === 'NotAllowedError'
            ? 'Mic permission denied — check your browser address bar to allow microphone access'
            : `Mic error: ${err.message}`;
        _callSystemMessage(msg, 'error');
        _renderCallUI();
    }
}

/** End the call (streamer only) */
function endCall() {
    if (!callState.isStreamer) return;
    if (callState.ws && callState.ws.readyState === WebSocket.OPEN) {
        callState.ws.send(JSON.stringify({ type: 'end-call' }));
    }
    leaveCall();
}

/** Clean up — called when leaving the channel page */
function destroyCall() {
    leaveCall();
    _stopViewerCallStatusSync();
    callState.streamId = null;
    callState.channelId = null;
    callState.vcMode = false;
    callState.callMode = null;
    callState.isStreamer = false;
    callState.broadcastMode = false;
    callState.lastSyncedCallMode = null;
}

/* ── WebSocket Signaling ───────────────────────────────────── */

function _connectCallWs() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = _getAuthToken();
    const channelParam = callState.channelId || callState.streamId;
    let url = `${proto}//${location.host}/ws/call?channelId=${encodeURIComponent(channelParam)}`;
    if (token) url += `&token=${token}`;

    if (callState.reconnectTimer) {
        clearTimeout(callState.reconnectTimer);
        callState.reconnectTimer = null;
    }

    callState.intentionalDisconnect = false;

    // Defensive: close any lingering WebSocket to prevent duplicate connections
    if (callState.ws) {
        const old = callState.ws;
        old.onclose = null;
        old.onerror = null;
        old.onmessage = null;
        try { old.close(); } catch {}
        callState.ws = null;
    }

    // Clean up stale peer connections from the previous WS session
    // so the new welcome message starts from a clean state
    for (const [peerId] of callState.peers) {
        _closePeer(peerId);
    }
    callState.peers.clear();

    callState.ws = new WebSocket(url);

    callState.ws.onopen = () => {
        callState.reconnectDelay = 3000;
    };

    callState.ws.onmessage = (e) => {
        try {
            const msg = JSON.parse(e.data);
            _handleCallMessage(msg);
        } catch {}
    };

    callState.ws.onclose = () => {
        const shouldReconnect = !callState.intentionalDisconnect && (callState.joined || callState.connecting) && (callState.channelId || callState.streamId);
        callState.ws = null;
        if (shouldReconnect) {
            // Reconnect
            callState.reconnectTimer = setTimeout(() => {
                if (!callState.intentionalDisconnect && (callState.joined || callState.connecting) && (callState.channelId || callState.streamId)) {
                    _connectCallWs();
                }
            }, callState.reconnectDelay);
            callState.reconnectDelay = Math.min(callState.reconnectDelay * 1.5, 15000);
        } else {
            callState.connecting = false;
        }
    };

    callState.ws.onerror = (e) => {
        console.warn('[Call] WebSocket error:', e);
    };
}

function _handleCallMessage(msg) {
    switch (msg.type) {
        case 'welcome':
            callState.myPeerId = msg.peerId;
            callState.joined = true;
            callState.connecting = false;
            callState.isStreamer = msg.isStreamer;
            // Server provides canonical moderation capability for this channel.
            callState.canModerate = !!msg.canModerate;

            // Stop redundant HTTP polling while we have a live WS connection
            _stopViewerCallStatusSync();

            {
                const me = (msg.participants || []).find(p => p.peerId === msg.peerId);
                _applyLocalParticipantInfo(me);
            }

            // Create peer connections to existing participants — stagger creation
            // to avoid a burst of WebRTC negotiation that freezes the UI
            {
                callState._sessionGen = (callState._sessionGen || 0) + 1;
                const gen = callState._sessionGen;
                const others = (msg.participants || []).filter(p => p.peerId !== callState.myPeerId);
                if (others.length <= 2) {
                    // Small room — create immediately
                    others.forEach(p => _createPeerConnection(p.peerId, true, p));
                } else {
                    // Larger room — stagger 200ms apart to keep the UI responsive
                    // and avoid overwhelming the network with parallel ICE negotiations
                    others.forEach((p, i) => {
                        if (i === 0) {
                            _createPeerConnection(p.peerId, true, p);
                        } else {
                            setTimeout(() => {
                                if (callState.joined && callState._sessionGen === gen) _createPeerConnection(p.peerId, true, p);
                            }, i * 200);
                        }
                    });
                }
            }
            _renderCallUI();
            if (callState.noMic) {
                _callSystemMessage('Joined! Click "Enable Mic" below to start speaking', 'info');
            } else {
                _callSystemMessage('You joined the call', 'success');
            }
            break;

        case 'peer-joined': {
            _createPeerConnection(msg.peerId, true, msg);
            _renderCallUI();
            _callSystemMessage(`${_resolveParticipantDisplayName(msg)} joined the call`);
            _callSounds.play('join');
            break;
        }

        case 'peer-updated': {
            const peer = callState.peers.get(msg.peerId);
            if (peer) {
                _mergePeerParticipantInfo(peer, msg);
                _scheduleRender();
            }
            break;
        }

        case 'self-updated': {
            callState.isStreamer = !!msg.isStreamer;
            if (typeof msg.canModerate === 'boolean') callState.canModerate = msg.canModerate;
            _applyLocalParticipantInfo(msg.participant);
            _scheduleRender();
            break;
        }

        case 'peer-left': {
            const leftPeer = callState.peers.get(msg.peerId);
            const leftName = leftPeer ? (leftPeer.displayName || leftPeer.username) : (msg.displayName || 'Someone');
            _closePeer(msg.peerId);
            callState.peers.delete(msg.peerId);
            _renderCallUI();
            if (msg.reason === 'kicked') {
                _callSystemMessage(`${leftName} was kicked from the call`);
            } else if (msg.reason === 'banned') {
                _callSystemMessage(`${leftName} was banned from the call`);
            } else {
                _callSystemMessage(`${leftName} left the call`);
            }
            _callSounds.play('leave');
            break;
        }

        case 'offer': {
            _handleOffer(msg);
            break;
        }

        case 'answer': {
            _handleAnswer(msg);
            break;
        }

        case 'ice-candidate': {
            _handleIceCandidate(msg);
            break;
        }

        case 'peer-muted': {
            const peer = callState.peers.get(msg.peerId);
            if (peer) {
                peer.muted = msg.muted;
                if (msg.muted) peer.speaking = false;
                // Try targeted update first to avoid full rebuild
                if (!_updateTileMuted(msg.peerId, peer.muted, peer.forceMuted)) {
                    _scheduleRender();
                }
            }
            break;
        }

        case 'peer-camera': {
            const peer = callState.peers.get(msg.peerId);
            if (peer) {
                peer.cameraOff = msg.cameraOff;
                _scheduleRender();
            }
            break;
        }

        case 'peer-speaking': {
            const peer = callState.peers.get(msg.peerId);
            if (peer) {
                peer.speaking = !!msg.speaking;
                // Targeted update — skip full grid rebuild for the hottest event
                if (!_updateTileSpeaking(msg.peerId, peer.speaking, peer.muted, peer.forceMuted)) {
                    _scheduleRender();
                }
            }
            break;
        }

        case 'peer-force-muted': {
            const peer = callState.peers.get(msg.peerId);
            if (peer) {
                peer.forceMuted = msg.forceMuted;
                if (msg.forceMuted) peer.speaking = false;
                if (!_updateTileMuted(msg.peerId, peer.muted, peer.forceMuted)) {
                    _scheduleRender();
                }
            }
            break;
        }

        case 'peer-force-camera-off': {
            const peer = callState.peers.get(msg.peerId);
            if (peer) {
                peer.forceCameraOff = msg.forceCameraOff;
                _scheduleRender();
            }
            break;
        }

        case 'force-muted': {
            // Server force-muted us
            callState.forceMuted = msg.forceMuted;
            if (msg.forceMuted) callState.muted = true;
            _applyLocalAudioGate();
            if (callState.localSpeaking) {
                callState.localSpeaking = false;
                _sendCallMsg({ type: 'speaking', speaking: false });
            }
            _callSystemMessage(msg.forceMuted ? 'The streamer muted your microphone for everyone' : 'The streamer unmuted your microphone');
            _renderCallUI();
            break;
        }

        case 'force-camera-off': {
            callState.forceCameraOff = msg.forceCameraOff;
            if (msg.forceCameraOff && callState.localStream && !callState.cameraOff) {
                // Force disable camera
                const videoTracks = callState.localStream.getVideoTracks();
                videoTracks.forEach(t => { t.stop(); callState.localStream.removeTrack(t); });
                callState.cameraOff = true;
                for (const [, peer] of callState.peers) {
                    const senders = peer.pc.getSenders();
                    for (const sender of senders) {
                        if (sender.track && sender.track.kind === 'video') peer.pc.removeTrack(sender);
                    }
                }
            }
            _callSystemMessage(msg.forceCameraOff ? 'The streamer disabled your camera for everyone' : 'The streamer re-enabled your camera permission');
            _renderCallUI();
            break;
        }

        case 'kicked': {
            _callSystemMessage('You were kicked from the call');
            callState.joined = false;
            callState.connecting = false;
            _cleanupCall();
            _renderCallUI();
            break;
        }

        case 'banned': {
            _callSystemMessage('You were banned from the call');
            callState.joined = false;
            callState.connecting = false;
            _cleanupCall();
            _renderCallUI();
            break;
        }

        case 'call-ended': {
            _callSystemMessage('The call has ended');
            leaveCall();
            if (callState.streamId && !callState.broadcastMode && !callState.vcMode) {
                _fetchCallStatus(callState.streamId);
            }
            break;
        }

        case 'participant-count': {
            const badge = document.getElementById('call-count-badge');
            if (badge) badge.textContent = msg.count;
            // Also update broadcast call count elements
            ['', '-rtmp', '-jsmpeg', '-whip'].forEach(suffix => {
                const el = document.getElementById(`bc-call-count${suffix}`);
                if (el) el.textContent = `${msg.count} in call`;
            });
            // Voice channel mode — update channel list counts
            if (callState.vcMode && typeof vcUpdateParticipantCount === 'function') {
                vcUpdateParticipantCount(msg.count);
            }
            break;
        }

        case 'error': {
            _callSystemMessage(msg.message || 'Call error');
            if (!callState.joined) {
                callState.connecting = false;
                _cleanupCall();
                _renderCallUI();
            }
            break;
        }
    }
}

/* ── WebRTC Peer Connection Management ─────────────────────── */

function _createPeerConnection(peerId, initiator, peerInfo) {
    if (callState.peers.has(peerId)) {
        _closePeer(peerId);
    }

    const pc = new RTCPeerConnection({ iceServers: _iceServers });

    const peer = {
        pc,
        username: peerInfo?.username || null,
        anonId: peerInfo?.anonId || null,
        displayName: _resolveParticipantDisplayName(peerInfo),
        userId: peerInfo?.userId || null,
        isStreamer: peerInfo?.isStreamer || false,
        muted: peerInfo?.muted || false,
        cameraOff: peerInfo?.cameraOff !== false,
        forceMuted: peerInfo?.forceMuted || false,
        forceCameraOff: peerInfo?.forceCameraOff || false,
        speaking: peerInfo?.speaking || false,
        nameFX: peerInfo?.nameFX || null,
        localMuted: false,
        localVolume: 100,
        localCameraOff: false,
        avatarUrl: peerInfo?.avatarUrl || null,
        profileColor: peerInfo?.profileColor || null,
        audioEl: null,
        videoEl: null,
        mediaStream: new MediaStream(),
        videoStream: null,
    };
    callState.peers.set(peerId, peer);

    // Add local tracks to the connection
    if (callState.localStream) {
        callState.localStream.getTracks().forEach(track => {
            const sender = pc.addTrack(track, callState.localStream);
            _optimizeCallSender(sender, track);
        });
    }

    // ICE candidates
    pc.onicecandidate = (e) => {
        if (e.candidate) {
            _sendCallMsg({
                type: 'ice-candidate',
                targetPeerId: peerId,
                candidate: e.candidate,
            });
        }
    };

    // Remote tracks
    pc.ontrack = (e) => {
        if (e.track.kind === 'audio') {
            _attachPeerAudioTrack(peerId, peer, e.track);
        }

        if (e.track.kind === 'video') {
            _attachPeerVideoTrack(peerId, peer, e.track);
        }
    };

    // Connection state — handle disconnected (transient) vs failed (permanent)
    pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        if (state === 'disconnected') {
            // Transient network glitch — attempt ICE restart after 4s grace period
            console.warn(`[Call] Peer ${peerId} ICE disconnected — will attempt restart`);
            peer._disconnectTimer = setTimeout(() => {
                if (!callState.joined) return;
                const curState = peer.pc?.iceConnectionState;
                if (curState === 'disconnected' || curState === 'failed') {
                    peer._iceRestartCount = (peer._iceRestartCount || 0) + 1;
                    if (peer._iceRestartCount > 3) {
                        console.warn(`[Call] Too many ICE restarts for ${peerId}, giving up`);
                        _closePeer(peerId);
                        callState.peers.delete(peerId);
                        _scheduleRender();
                        return;
                    }
                    console.log(`[Call] Attempting ICE restart for peer ${peerId} (attempt ${peer._iceRestartCount})`);
                    try {
                        peer.pc.restartIce();
                        peer.pc.createOffer({ iceRestart: true }).then(offer => {
                            return peer.pc.setLocalDescription(offer);
                        }).then(() => {
                            _sendCallMsg({ type: 'offer', targetPeerId: peerId, sdp: peer.pc.localDescription });
                        }).catch(err => {
                            console.warn(`[Call] ICE restart offer failed for ${peerId}:`, err.message);
                            _closePeer(peerId);
                            callState.peers.delete(peerId);
                            _scheduleRender();
                        });
                    } catch {
                        _closePeer(peerId);
                        callState.peers.delete(peerId);
                        _scheduleRender();
                    }
                }
            }, 4000);
        } else if (state === 'connected' || state === 'completed') {
            if (peer._disconnectTimer) { clearTimeout(peer._disconnectTimer); peer._disconnectTimer = null; }
            // Reset restart counter on successful connection
            peer._iceRestartCount = 0;
        } else if (state === 'failed') {
            if (peer._disconnectTimer) { clearTimeout(peer._disconnectTimer); peer._disconnectTimer = null; }
            // One ICE restart attempt before giving up
            if (!peer._iceRestartAttempted) {
                peer._iceRestartAttempted = true;
                console.log(`[Call] Peer ${peerId} ICE failed — attempting one restart`);
                try {
                    peer.pc.restartIce();
                    peer.pc.createOffer({ iceRestart: true }).then(offer => {
                        return peer.pc.setLocalDescription(offer);
                    }).then(() => {
                        _sendCallMsg({ type: 'offer', targetPeerId: peerId, sdp: peer.pc.localDescription });
                    }).catch(() => {
                        _closePeer(peerId);
                        callState.peers.delete(peerId);
                        _scheduleRender();
                    });
                } catch {
                    _closePeer(peerId);
                    callState.peers.delete(peerId);
                    _scheduleRender();
                }
            } else {
                _closePeer(peerId);
                callState.peers.delete(peerId);
                _scheduleRender();
            }
        } else if (state === 'closed') {
            if (peer._disconnectTimer) { clearTimeout(peer._disconnectTimer); peer._disconnectTimer = null; }
            _closePeer(peerId);
            callState.peers.delete(peerId);
            _scheduleRender();
        }
    };

    // Negotiation needed — set on ALL peer connections so track additions
    // (e.g. camera toggle) trigger renegotiation from either side.
    // Uses "perfect negotiation" pattern with polite/impolite roles for glare resolution.
    peer._negotiating = false;
    peer._handlingRemoteOffer = false;
    peer._iceRestartCount = 0;
    pc.onnegotiationneeded = async () => {
        if (peer._negotiating || peer._handlingRemoteOffer) return; // prevent re-entrant negotiation
        peer._negotiating = true;
        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            _sendCallMsg({
                type: 'offer',
                targetPeerId: peerId,
                sdp: pc.localDescription,
            });
        } catch (err) {
            console.error('[Call] Offer creation failed:', err);
        } finally {
            peer._negotiating = false;
        }
    };
}

async function _handleOffer(msg) {
    const peerId = msg.fromPeerId;
    if (!callState.peers.has(peerId)) {
        // Peer sent an offer before we received their peer-joined message —
        // create the connection with whatever info the offer message carries
        // (may include username, displayName from the server relay).
        _createPeerConnection(peerId, false, msg);
    }
    const peer = callState.peers.get(peerId);
    if (!peer) return;

    try {
        // Perfect negotiation: detect offer collision (both sides sent offers simultaneously)
        const offerCollision = peer._negotiating || peer.pc.signalingState !== 'stable';
        // Deterministic politeness: the peer with the "larger" peerId is polite (yields)
        const isPolite = callState.myPeerId > peerId;

        if (offerCollision && !isPolite) {
            // We are impolite and already have a pending offer — drop the incoming one
            console.log(`[Call] Offer glare with ${peerId} — impolite side, ignoring incoming offer`);
            return;
        }

        if (offerCollision) {
            // We are polite — rollback our pending offer and accept the remote one
            console.log(`[Call] Offer glare with ${peerId} — polite side, rolling back`);
            await peer.pc.setLocalDescription({ type: 'rollback' });
            peer._negotiating = false;
        }

        peer._handlingRemoteOffer = true;
        await peer.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        _sendCallMsg({
            type: 'answer',
            targetPeerId: peerId,
            sdp: peer.pc.localDescription,
        });
    } catch (err) {
        console.error('[Call] Handle offer failed:', err);
    } finally {
        peer._handlingRemoteOffer = false;
    }
}

async function _handleAnswer(msg) {
    const peer = callState.peers.get(msg.fromPeerId);
    if (!peer) return;
    // Guard: only accept answers when we have a pending local offer
    if (peer.pc.signalingState !== 'have-local-offer') {
        console.warn(`[Call] Ignoring stale answer from ${msg.fromPeerId} (state: ${peer.pc.signalingState})`);
        return;
    }
    try {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    } catch (err) {
        console.error('[Call] Handle answer failed:', err);
    }
}

async function _handleIceCandidate(msg) {
    const peer = callState.peers.get(msg.fromPeerId);
    if (!peer) return;
    try {
        if (msg.candidate) {
            await peer.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        }
    } catch (err) {
        // ICE candidate errors are common during renegotiation, ignore
    }
}

function _closePeer(peerId) {
    const peer = callState.peers.get(peerId);
    if (!peer) return;
    if (callState.popoutPeerId === peerId) {
        _closeCallVideoPopout();
    }
    if (peer._disconnectTimer) { clearTimeout(peer._disconnectTimer); peer._disconnectTimer = null; }
    if (peer.pc) {
        peer.pc.onicecandidate = null;
        peer.pc.ontrack = null;
        peer.pc.oniceconnectionstatechange = null;
        peer.pc.onnegotiationneeded = null;
        peer.pc.close();
        peer.pc = null;
    }
    // Disconnect gain chain (shared AudioContext is closed in _cleanupCall)
    if (peer._gainSource) {
        try { peer._gainSource.disconnect(); } catch {}
        peer._gainSource = null;
    }
    if (peer._gainNode) {
        try { peer._gainNode.disconnect(); } catch {}
        peer._gainNode = null;
    }
    if (peer.audioEl) {
        peer.audioEl.srcObject = null;
        peer.audioEl.remove();
    }
    if (peer.videoEl) {
        peer.videoEl.srcObject = null;
    }
    if (peer.mediaStream) {
        peer.mediaStream.getTracks().forEach(track => {
            try { peer.mediaStream.removeTrack(track); } catch {}
        });
    }
    peer.videoStream = null;
}

function _attachPeerAudioTrack(peerId, peer, track) {
    // Remove stale audio tracks before adding the new one
    peer.mediaStream.getAudioTracks().forEach(t => {
        if (t.id !== track.id) {
            try { peer.mediaStream.removeTrack(t); } catch {}
        }
    });
    if (!peer.mediaStream.getAudioTracks().some(t => t.id === track.id)) {
        peer.mediaStream.addTrack(track);
    }

    if (!peer.audioEl) {
        peer.audioEl = document.createElement('audio');
        peer.audioEl.id = `call-audio-${peerId}`;
        peer.audioEl.setAttribute('autoplay', '');
        peer.audioEl.setAttribute('playsinline', '');
        document.body.appendChild(peer.audioEl);
    }

    // Create a fresh MediaStream for the audio element to force the browser to
    // re-evaluate the source — reassigning the same object is a no-op in some engines
    const audioStream = new MediaStream([track]);
    peer.audioEl.srcObject = audioStream;
    peer.audioEl.volume = Math.min(peer.localVolume / 100, 1.0);
    peer.audioEl.muted = peer.localMuted;

    // Ensure playback starts (autoplay policy may block without a user gesture)
    const playPromise = peer.audioEl.play();
    if (playPromise && playPromise.catch) {
        playPromise.catch((err) => {
            console.warn(`[Call] Audio playback blocked for peer ${peerId}:`, err.message);
            _resumeAllPeerAudioPlayback();
        });
    }

    track.onended = () => {
        if (!callState.peers.has(peerId)) return;
        try { peer.mediaStream.removeTrack(track); } catch {}
    };
    track.onunmute = () => {
        // When a track unmutes (e.g. after renegotiation), ensure playback resumes
        if (peer.audioEl && peer.audioEl.paused) {
            peer.audioEl.play().catch(() => {});
        }
        _resumeAllPeerAudioPlayback();
    };
}

function _resumeAllPeerAudioPlayback() {
    if (!callState.joined) return;

    // Resuming the shared context can unblock gain-node routed audio in some browsers.
    const ctx = _getSharedPeerAudioCtx();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});

    for (const [, peer] of callState.peers) {
        if (!peer?.audioEl || peer.localMuted) continue;
        if (peer.audioEl.paused) peer.audioEl.play().catch(() => {});
    }
}

function _attachPeerVideoTrack(peerId, peer, track) {
    peer.mediaStream.getVideoTracks().forEach(t => {
        if (t.id !== track.id) {
            try { peer.mediaStream.removeTrack(t); } catch {}
        }
    });
    if (!peer.mediaStream.getVideoTracks().some(t => t.id === track.id)) {
        peer.mediaStream.addTrack(track);
    }
    peer.videoStream = peer.mediaStream;
    if (!peer.forceCameraOff) peer.cameraOff = false;
    if (peer.videoEl) {
        _bindVideoElement(peer.videoEl, peer.videoStream, false);
    }
    _syncCallVideoPopout();
    _scheduleRender();

    track.onunmute = () => {
        peer.cameraOff = false;
        _syncCallVideoPopout();
        _scheduleRender();
    };
    track.onmute = () => {
        _syncCallVideoPopout();
        _scheduleRender();
    };
    track.onended = () => {
        if (!callState.peers.has(peerId)) return;
        try { peer.mediaStream.removeTrack(track); } catch {}
        if (peer.videoStream && peer.videoStream.getVideoTracks().length === 0) {
            peer.videoStream = null;
        }
        _syncCallVideoPopout();
        _scheduleRender();
    };
}

function _peerHasActiveVideo(opts) {
    if (opts.cameraOff || opts.localCameraOff || opts.forceCameraOff) return false;
    if (opts.isLocal) {
        return !!callState.localStream?.getVideoTracks?.().some(track => track.readyState === 'live' && track.enabled !== false);
    }
    const tracks = opts.videoStream?.getVideoTracks?.() || [];
    return tracks.some(track => track.readyState === 'live' && track.muted !== true);
}

/**
 * Set a GainNode on a peer's audio for volume amplification (>100%).
 * Uses Web Audio API to route the audio element through a gain node.
 * Shares a single AudioContext across all peers to avoid browser limits.
 */
let _sharedPeerAudioCtx = null;
function _getSharedPeerAudioCtx() {
    if (!_sharedPeerAudioCtx || _sharedPeerAudioCtx.state === 'closed') {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        _sharedPeerAudioCtx = new Ctx();
    }
    if (_sharedPeerAudioCtx.state === 'suspended') _sharedPeerAudioCtx.resume().catch(() => {});
    return _sharedPeerAudioCtx;
}

function _setPeerGain(peer, gainValue) {
    if (!peer.audioEl) return;
    try {
        // Create or reuse the gain chain
        if (!peer._gainNode) {
            const ctx = _getSharedPeerAudioCtx();
            if (!ctx) return;
            peer._gainSource = ctx.createMediaElementSource(peer.audioEl);
            peer._gainNode = ctx.createGain();
            peer._gainSource.connect(peer._gainNode);
            peer._gainNode.connect(ctx.destination);
        }
        peer._gainNode.gain.value = gainValue;
    } catch (err) {
        console.warn('[Call] GainNode setup failed:', err.message);
    }
}

function _bindVideoElement(video, stream, muted) {
    if (!video || !stream) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    video.muted = !!muted;
    const playPromise = video.play?.();
    if (playPromise?.catch) playPromise.catch(() => {});
}

function _openCallVideoPopout(peerId) {
    const opts = peerId === callState.myPeerId
        ? {
            peerId,
            displayName: callState.localDisplayName || callState.localAnonId || 'You',
            isLocal: true,
            videoStream: callState.localStream,
        }
        : _getPeerContextMenuOpts(peerId);
    if (!opts) return;

    const stream = opts.isLocal ? callState.localStream : opts.videoStream;
    if (!_peerHasActiveVideo({ ...opts, videoStream: stream, cameraOff: opts.isLocal ? callState.cameraOff : opts.cameraOff, forceCameraOff: opts.isLocal ? callState.forceCameraOff : opts.forceCameraOff })) {
        _callSystemMessage('No active webcam feed available to pop out');
        return;
    }

    let pop = callState.popoutWindow;
    if (!pop || pop.closed) {
        pop = window.open('', 'openvibe-call-webcam-popout', 'width=520,height=420,resizable=yes');
        if (!pop) {
            _callSystemMessage('Popup blocked by the browser');
            return;
        }
        callState.popoutWindow = pop;
        pop.document.write(`<!DOCTYPE html><html><head><title>Webcam Popout</title><style>
            html,body{margin:0;background:#000;color:#fff;font-family:system-ui,sans-serif;height:100%;overflow:hidden}
            body{display:flex;flex-direction:column}
            header{padding:10px 12px;background:#111;border-bottom:1px solid #222;font-size:14px;font-weight:600;flex:0 0 auto}
            .stage{position:relative;flex:1 1 auto;display:flex;align-items:center;justify-content:center;overflow:hidden;background:#000;min-height:0}
            video{display:block;max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;object-position:center center;background:#000}
            .empty{display:flex;align-items:center;justify-content:center;position:absolute;inset:0;color:#aaa;padding:24px;text-align:center}
        </style></head><body><header id="call-popout-title">Webcam</header><div class="stage"><video id="call-popout-video" autoplay playsinline muted></video><div id="call-popout-empty" class="empty" style="display:none">Camera not available</div></div></body></html>`);
        pop.document.close();
        pop.addEventListener('beforeunload', () => {
            if (callState.popoutWindow === pop) {
                callState.popoutWindow = null;
                callState.popoutPeerId = null;
            }
        });
    }

    callState.popoutPeerId = peerId;
    _syncCallVideoPopout();
}

function _syncCallVideoPopout() {
    const pop = callState.popoutWindow;
    if (!pop || pop.closed || !callState.popoutPeerId) return;

    const isLocal = callState.popoutPeerId === callState.myPeerId;
    const peer = isLocal ? null : callState.peers.get(callState.popoutPeerId);
    const stream = isLocal ? callState.localStream : peer?.videoStream;
    const title = isLocal ? (callState.localDisplayName || 'You') : (peer?.displayName || peer?.username || 'Webcam');
    const hasVideo = isLocal
        ? _peerHasActiveVideo({ isLocal: true, videoStream: callState.localStream, cameraOff: callState.cameraOff, forceCameraOff: callState.forceCameraOff })
        : !!peer && _peerHasActiveVideo(peer);

    const titleEl = pop.document.getElementById('call-popout-title');
    const videoEl = pop.document.getElementById('call-popout-video');
    const emptyEl = pop.document.getElementById('call-popout-empty');
    if (!titleEl || !videoEl || !emptyEl) return;

    titleEl.textContent = `${title} Webcam`;
    if (hasVideo && stream) {
        emptyEl.style.display = 'none';
        videoEl.style.display = '';
        _bindVideoElement(videoEl, stream, true);
    } else {
        videoEl.style.display = 'none';
        videoEl.srcObject = null;
        emptyEl.style.display = 'flex';
    }
}

function _closeCallVideoPopout() {
    if (callState.popoutWindow && !callState.popoutWindow.closed) {
        callState.popoutWindow.close();
    }
    callState.popoutWindow = null;
    callState.popoutPeerId = null;
}

/* ── UI Rendering ──────────────────────────────────────────── */

function _renderCallUI() {
    _syncCallSettingsUI();

    // Voice channel mode — delegate rendering to voice-channels.js
    if (callState.vcMode && typeof vcRenderUI === 'function') {
        vcRenderUI();
        return;
    }

    const isBroadcast = callState.broadcastMode;
    const panel = isBroadcast ? document.getElementById('bc-call-panel') : document.getElementById('call-panel');
    if (!panel) return;

    const joinArea = isBroadcast ? null : document.getElementById('call-join-area');
    const activeArea = isBroadcast ? null : document.getElementById('call-active-area');
    const grid = isBroadcast ? document.getElementById('bc-call-participants-grid') : document.getElementById('call-participants-grid');
    const connBadge = isBroadcast ? null : document.getElementById('call-connected-badge');

    if (!callState.joined) {
        if (isBroadcast) {
            panel.style.display = 'none';
        } else {
            if (joinArea) joinArea.style.display = '';
            if (activeArea) activeArea.style.display = 'none';
            if (connBadge) connBadge.style.display = 'none';
        }
        return;
    }

    // Active call
    if (isBroadcast) {
        panel.style.display = '';
    } else {
        if (joinArea) joinArea.style.display = 'none';
        if (activeArea) activeArea.style.display = '';
        if (connBadge) connBadge.style.display = '';
    }

    // Update control buttons
    const muteBtn = _cid('call-btn-mute');
    if (muteBtn) {
        const isMuted = callState.muted || callState.forceMuted;
        muteBtn.innerHTML = isMuted
            ? '<i class="fa-solid fa-microphone-slash"></i>'
            : '<i class="fa-solid fa-microphone"></i>';
        muteBtn.classList.toggle('active', isMuted);
        muteBtn.title = callState.forceMuted ? 'Force-muted by streamer' : (callState.muted ? 'Unmute' : 'Mute');
    }

    const camBtn = _cid('call-btn-camera');
    if (camBtn && callState.callMode !== 'mic') {
        const camOff = callState.cameraOff || callState.forceCameraOff;
        camBtn.innerHTML = camOff
            ? '<i class="fa-solid fa-video-slash"></i>'
            : '<i class="fa-solid fa-video"></i>';
        camBtn.classList.toggle('active', camOff);
        camBtn.title = callState.forceCameraOff ? 'Camera disabled by streamer' : (callState.cameraOff ? 'Enable Camera' : 'Disable Camera');
    }

    // End call button — only for streamer (channel page only; broadcast has its own)
    if (!isBroadcast) {
        const endBtn = document.getElementById('call-btn-end');
        if (endBtn) endBtn.style.display = callState.isStreamer ? '' : 'none';
    }

    // Hide camera device switcher in mic-only mode
    const camSwitchGroup = _cid('call-cam-switch-group');
    if (camSwitchGroup) camSwitchGroup.style.display = callState.callMode === 'mic' ? 'none' : '';

    // Render participant grid
    if (!grid) return;
    grid.innerHTML = '';

    // Local participant tile
    grid.appendChild(_createParticipantTile({
        peerId: callState.myPeerId,
        username: callState.localUsername,
        displayName: callState.localDisplayName || (currentUser ? (currentUser.display_name || currentUser.username) : 'You'),
        anonId: callState.localAnonId,
        userId: callState.localUserId || currentUser?.id || null,
        isStreamer: callState.isStreamer,
        muted: callState.muted || callState.forceMuted,
        speaking: callState.localSpeaking,
        cameraOff: callState.cameraOff || callState.forceCameraOff,
        forceMuted: callState.forceMuted,
        forceCameraOff: callState.forceCameraOff,
        nameFX: callState.localNameFX,
        avatarUrl: callState.localAvatarUrl || currentUser?.avatar_url || null,
        profileColor: callState.localProfileColor || currentUser?.profile_color || null,
        isLocal: true,
    }));

    // Remote participants
    for (const [peerId, peer] of callState.peers) {
        grid.appendChild(_createParticipantTile({
            peerId,
            username: peer.username,
            anonId: peer.anonId,
            displayName: peer.displayName,
            userId: peer.userId,
            isStreamer: peer.isStreamer,
            muted: peer.muted,
            speaking: peer.speaking,
            cameraOff: peer.cameraOff,
            forceMuted: peer.forceMuted,
            forceCameraOff: peer.forceCameraOff,
            nameFX: peer.nameFX,
            localMuted: peer.localMuted,
            localVolume: peer.localVolume,
            localCameraOff: peer.localCameraOff,
            videoStream: peer.videoStream,
            avatarUrl: peer.avatarUrl,
            profileColor: peer.profileColor,
        }));
    }

    _syncCallVideoPopout();
    _renderFloatingPeerContextMenu();
}

function _createParticipantTile(opts) {
    const tile = document.createElement('div');
    tile.className = 'call-participant-tile';
    tile.dataset.peerId = opts.peerId;
    if (opts.isStreamer) tile.classList.add('is-streamer');
    if (opts.muted || opts.forceMuted) tile.classList.add('is-muted');
    if (opts.localMuted) tile.classList.add('is-local-muted');
    if (opts.speaking && !opts.muted && !opts.forceMuted) tile.classList.add('is-speaking');

    // Video or avatar placeholder
    const showVideo = _peerHasActiveVideo(opts);
    if (showVideo) {
        let video;
        if (opts.isLocal) {
            // Cache the local video element to avoid flicker on re-render
            if (!callState._localVideoEl) callState._localVideoEl = document.createElement('video');
            video = callState._localVideoEl;
        } else {
            video = callState.peers.get(opts.peerId)?.videoEl || document.createElement('video');
        }
        video.autoplay = true;
        video.playsInline = true;
        video.className = 'call-video';
        if (opts.isLocal) {
            _bindVideoElement(video, callState.localStream, true);
        } else if (opts.videoStream) {
            const peer = callState.peers.get(opts.peerId);
            if (peer) peer.videoEl = video;
            _bindVideoElement(video, opts.videoStream, false);
        }
        tile.appendChild(video);
    } else {
        const avatar = document.createElement('div');
        avatar.className = 'call-avatar';
        if (opts.speaking && !opts.muted && !opts.forceMuted) avatar.classList.add('speaking');
        const initial = (opts.displayName || opts.username || opts.anonId || '?')[0].toUpperCase();
        if (opts.avatarUrl) {
            avatar.style.backgroundImage = `url(${opts.avatarUrl})`;
            avatar.style.backgroundSize = 'cover';
            avatar.textContent = '';
        } else {
            if (opts.profileColor) avatar.style.background = opts.profileColor;
            avatar.textContent = initial;
        }
        tile.appendChild(avatar);
    }

    // Status indicators bar (top-right)
    const indicators = document.createElement('div');
    indicators.className = 'call-indicators';
    if (opts.forceMuted) indicators.innerHTML += '<i class="fa-solid fa-microphone-slash call-icon-force-muted" title="Force-muted by streamer"></i>';
    else if (opts.muted) indicators.innerHTML += '<i class="fa-solid fa-microphone-slash call-icon-muted" title="Muted"></i>';
    else if (opts.speaking) indicators.innerHTML += '<i class="fa-solid fa-wave-square call-icon-speaking" title="Speaking"></i>';
    if (opts.forceCameraOff) indicators.innerHTML += '<i class="fa-solid fa-video-slash call-icon-force-cam" title="Camera disabled by streamer"></i>';
    if (opts.localMuted) indicators.innerHTML += '<i class="fa-solid fa-volume-xmark call-icon-local-muted" title="Muted for you"></i>';
    if (opts.localVolume !== undefined && opts.localVolume < 100 && !opts.localMuted && !opts.isLocal) {
        indicators.innerHTML += `<i class="fa-solid fa-volume-low call-icon-low-vol" title="Volume ${opts.localVolume}%"></i>`;
    }
    if (indicators.innerHTML) tile.appendChild(indicators);

    // Name label (bottom)
    const label = document.createElement('div');
    label.className = 'call-participant-label';
    const nameEl = document.createElement('span');
    nameEl.className = `call-name${opts.nameFX?.cssClass ? ` ${opts.nameFX.cssClass}` : ''}${opts.username ? ' call-name-clickable' : ''}`;
    nameEl.textContent = opts.displayName || opts.anonId || opts.username || 'Unknown';
    if (!opts.nameFX?.cssClass && opts.profileColor) {
        nameEl.style.color = opts.profileColor;
    }
    _attachCallUserContextHandlers(nameEl, opts);
    label.appendChild(nameEl);
    if (opts.isStreamer) {
        const streamerIcon = document.createElement('i');
        streamerIcon.className = 'fa-solid fa-broadcast-tower call-streamer-icon';
        streamerIcon.title = 'Streamer';
        label.appendChild(streamerIcon);
    }
    if (opts.isLocal) {
        const youBadge = document.createElement('span');
        youBadge.className = 'call-you-badge';
        youBadge.textContent = '(you)';
        label.appendChild(youBadge);
    }
    tile.appendChild(label);

    // Context menu button (not for local tile)
    if (!opts.isLocal) {
        const menuBtn = document.createElement('button');
        menuBtn.className = 'call-tile-menu-btn';
        menuBtn.innerHTML = '<i class="fa-solid fa-ellipsis-vertical"></i>';
        menuBtn.title = 'Options';
        menuBtn.dataset.peerId = opts.peerId;
        menuBtn.onclick = (e) => {
            e.stopPropagation();
            _togglePeerContextMenu(opts.peerId, menuBtn);
        };
        tile.appendChild(menuBtn);

        // Right-click anywhere on a remote tile to open options (helps when
        // the 3-dot hit area is hard to click on compact/anon tiles).
        tile.oncontextmenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            _togglePeerContextMenu(opts.peerId, menuBtn);
        };

        // Touch/mobile fallback: tapping the tile opens options when the target
        // isn't already an interactive child control.
        tile.onclick = (e) => {
            const t = e.target;
            if (t?.closest?.('.call-name-clickable, .call-tile-menu-btn, .call-tile-popout-btn, .call-peer-menu')) return;
            e.stopPropagation();
            _togglePeerContextMenu(opts.peerId, menuBtn);
        };
    }

    if (showVideo) {
        const popoutBtn = document.createElement('button');
        popoutBtn.className = 'call-tile-popout-btn';
        popoutBtn.innerHTML = '<i class="fa-solid fa-up-right-and-down-left-from-center"></i>';
        popoutBtn.title = 'Open webcam popout';
        popoutBtn.onclick = (e) => {
            e.stopPropagation();
            _openCallVideoPopout(opts.peerId);
        };
        tile.appendChild(popoutBtn);
    }

    return tile;
}

function _togglePeerContextMenu(peerId, anchorEl) {
    if (callState.openContextMenu === peerId) {
        _closePeerContextMenu();
        return;
    }
    callState.openContextMenu = peerId;
    callState.openContextMenuRect = anchorEl?.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null;
    _renderCallUI();
}

function _closePeerContextMenu() {
    callState.openContextMenu = null;
    callState.openContextMenuRect = null;
    _removeFloatingPeerContextMenu();
}

function _removeFloatingPeerContextMenu() {
    const existing = document.getElementById('call-peer-menu-floating');
    if (existing) existing.remove();
}

function _getPeerContextMenuOpts(peerId) {
    const peer = callState.peers.get(peerId);
    if (!peer) return null;
    return {
        peerId,
        username: peer.username,
        anonId: peer.anonId,
        displayName: peer.displayName,
        userId: peer.userId,
        isStreamer: peer.isStreamer,
        muted: peer.muted,
        cameraOff: peer.cameraOff,
        forceMuted: peer.forceMuted,
        forceCameraOff: peer.forceCameraOff,
        nameFX: peer.nameFX,
        localMuted: peer.localMuted,
        localVolume: peer.localVolume,
        localCameraOff: peer.localCameraOff,
        videoStream: peer.videoStream,
        avatarUrl: peer.avatarUrl,
        profileColor: peer.profileColor,
    };
}

function _renderFloatingPeerContextMenu() {
    _removeFloatingPeerContextMenu();
    if (!callState.openContextMenu) return;

    const opts = _getPeerContextMenuOpts(callState.openContextMenu);
    if (!opts) {
        _closePeerContextMenu();
        return;
    }

    const menu = _buildPeerContextMenu(opts);
    menu.id = 'call-peer-menu-floating';
    menu.classList.add('call-peer-menu-floating');
    document.body.appendChild(menu);

    const anchor = document.querySelector(`.call-tile-menu-btn[data-peer-id="${opts.peerId}"]`);
    const anchorRect = anchor?.getBoundingClientRect ? anchor.getBoundingClientRect() : callState.openContextMenuRect;
    _positionFloatingPeerContextMenu(menu, anchorRect);
}

function _positionFloatingPeerContextMenu(menu, anchorRect) {
    if (!menu || !anchorRect) return;

    const viewportPad = 8;
    const menuRect = menu.getBoundingClientRect();
    let top = anchorRect.bottom + 6;
    let left = anchorRect.left;

    if (left + menuRect.width > window.innerWidth - viewportPad) {
        left = Math.max(viewportPad, window.innerWidth - menuRect.width - viewportPad);
    }

    if (top + menuRect.height > window.innerHeight - viewportPad) {
        top = anchorRect.top - menuRect.height - 6;
    }

    if (top < viewportPad) {
        top = viewportPad;
    }

    menu.style.top = `${Math.round(top)}px`;
    menu.style.left = `${Math.round(left)}px`;
}

function _buildPeerContextMenu(opts) {
    const menu = document.createElement('div');
    menu.className = 'call-peer-menu';
    menu.onclick = (e) => e.stopPropagation();

    const peer = callState.peers.get(opts.peerId);
    if (!peer) return menu;

    // Header
    const header = document.createElement('div');
    header.className = 'call-peer-menu-header';
    header.innerHTML = `<strong>${_esc(opts.displayName || opts.username || 'Unknown')}</strong>`;
    if (opts.isStreamer) header.innerHTML += ' <i class="fa-solid fa-broadcast-tower" style="color:var(--accent);font-size:0.7rem"></i>';
    menu.appendChild(header);

    if (opts.username && typeof showChatContextMenu === 'function') {
        _addMenuItem(menu, 'fa-id-card', 'View profile', (e) => {
            _closePeerContextMenu();
            _openCallUserContextMenu(opts, e?.currentTarget || null);
        });
    }

    if (_peerHasActiveVideo(opts)) {
        _addMenuItem(menu, 'fa-up-right-and-down-left-from-center', 'Open webcam popout', () => {
            _closePeerContextMenu();
            _openCallVideoPopout(opts.peerId);
        });
    }

    // Volume slider (local)
    const volGroup = document.createElement('div');
    volGroup.className = 'call-peer-menu-item call-peer-vol-group';
    volGroup.innerHTML = `<i class="fa-solid fa-volume-high"></i><span>Volume <span class="call-vol-label">${peer.localVolume}%</span></span>`;
    const volSlider = document.createElement('input');
    volSlider.type = 'range';
    volSlider.min = '0';
    volSlider.max = '200';
    volSlider.value = peer.localVolume;
    volSlider.className = 'call-vol-slider';
    volSlider.title = `${peer.localVolume}%`;
    volSlider.oninput = (e) => {
        e.stopPropagation();
        const vol = parseInt(volSlider.value);
        peer.localVolume = vol;
        volSlider.title = `${vol}%`;
        const label = volGroup.querySelector('.call-vol-label');
        if (label) label.textContent = `${vol}%`;

        if (peer.audioEl) {
            if (peer._gainNode) {
                // Once a gain chain exists, always use it (createMediaElementSource
                // redirects output through Web Audio API permanently)
                peer.audioEl.volume = 1.0;
                peer._gainNode.gain.value = vol / 100;
            } else if (vol > 100) {
                // Activate gain chain for amplification
                peer.audioEl.volume = 1.0;
                _setPeerGain(peer, vol / 100);
            } else {
                peer.audioEl.volume = vol / 100;
            }
        }
    };
    volGroup.appendChild(volSlider);
    menu.appendChild(volGroup);

    // Local mute toggle
    _addMenuItem(menu, peer.localMuted ? 'fa-volume-xmark' : 'fa-volume-high',
        peer.localMuted ? 'Unmute for me' : 'Mute for me', () => {
        peer.localMuted = !peer.localMuted;
        if (peer.audioEl) peer.audioEl.muted = peer.localMuted;
        _closePeerContextMenu();
        _renderCallUI();
    });

    // Local camera hide (if not mic-only)
    if (callState.callMode !== 'mic') {
        _addMenuItem(menu, peer.localCameraOff ? 'fa-eye' : 'fa-eye-slash',
            peer.localCameraOff ? 'Show camera for me' : 'Hide camera for me', () => {
            peer.localCameraOff = !peer.localCameraOff;
            _closePeerContextMenu();
            _renderCallUI();
        });
    }

    // Streamer-only moderation controls
    if (callState.canModerate && !opts.isStreamer) {
        const divider = document.createElement('div');
        divider.className = 'call-peer-menu-divider';
        menu.appendChild(divider);

        const modLabel = document.createElement('div');
        modLabel.className = 'call-peer-menu-section';
        modLabel.textContent = 'Moderation';
        menu.appendChild(modLabel);

        // Force mute for everyone
        _addMenuItem(menu, peer.forceMuted ? 'fa-microphone' : 'fa-microphone-slash',
            peer.forceMuted ? 'Unmute for everyone' : 'Mute for everyone', () => {
            _sendCallMsg({ type: 'force-mute', targetPeerId: opts.peerId, forceMuted: !peer.forceMuted });
            _closePeerContextMenu();
        }, 'call-peer-menu-mod');

        // Force camera off for everyone (if not mic-only)
        if (callState.callMode !== 'mic') {
            _addMenuItem(menu, peer.forceCameraOff ? 'fa-video' : 'fa-video-slash',
                peer.forceCameraOff ? 'Enable camera for everyone' : 'Disable camera for everyone', () => {
                _sendCallMsg({ type: 'force-camera-off', targetPeerId: opts.peerId, forceCameraOff: !peer.forceCameraOff });
                _closePeerContextMenu();
            }, 'call-peer-menu-mod');
        }

        // Kick
        _addMenuItem(menu, 'fa-right-from-bracket', 'Kick from call', () => {
            _sendCallMsg({ type: 'kick', targetPeerId: opts.peerId });
            _closePeerContextMenu();
        }, 'call-peer-menu-danger');

        // Ban
        _addMenuItem(menu, 'fa-ban', 'Ban from call', () => {
            if (confirm(`Ban ${opts.username || opts.displayName} from the call? They won't be able to rejoin.`)) {
                _sendCallMsg({ type: 'ban', targetPeerId: opts.peerId });
                _closePeerContextMenu();
            }
        }, 'call-peer-menu-danger');
    }

    return menu;
}

function _addMenuItem(parent, icon, text, onclick, extraClass) {
    const item = document.createElement('button');
    item.className = 'call-peer-menu-item' + (extraClass ? ` ${extraClass}` : '');
    item.innerHTML = `<i class="fa-solid ${icon}"></i><span>${text}</span>`;
    item.onclick = (e) => { e.stopPropagation(); onclick(e); };
    parent.appendChild(item);
}

function _attachCallUserContextHandlers(el, opts) {
    if (!el || !opts?.username || typeof showChatContextMenu !== 'function') return;
    el.dataset.username = opts.username;
    if (opts.userId) el.dataset.userId = String(opts.userId);
    el.onclick = (e) => {
        e.stopPropagation();
        _openCallUserContextMenu(opts, el);
    };
    el.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        _openCallUserContextMenu(opts, el, e.clientX, e.clientY);
    };
}

function _openCallUserContextMenu(opts, anchorEl, x, y) {
    if (!opts?.username || typeof showChatContextMenu !== 'function') return;
    if (typeof dismissContextMenu === 'function') dismissContextMenu();

    const rect = anchorEl?.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null;
    const clientX = x ?? (rect ? rect.left + Math.min(rect.width / 2, 80) : 24);
    const clientY = y ?? (rect ? rect.bottom + 6 : 24);
    const target = anchorEl || document.createElement('span');
    target.dataset.username = opts.username;
    if (opts.userId) target.dataset.userId = String(opts.userId);

    showChatContextMenu({
        preventDefault() {},
        stopPropagation() {},
        currentTarget: target,
        target,
        clientX,
        clientY,
    });
}

function _sendCallMsg(msg) {
    if (callState.ws && callState.ws.readyState === WebSocket.OPEN && callState.ws.bufferedAmount <= CALL_WS_MAX_BUFFERED_AMOUNT) {
        callState.ws.send(JSON.stringify(msg));
    }
}

function _updateLocalPreview() {
    // Local video preview is handled by the tile in _renderCallUI
    _renderCallUI();
}

function _callSystemMessage(text, type = 'error') {
    // In VC mode, show a toast + log so the user actually sees errors
    if (callState.vcMode) {
        console.log('[VC]', text);
        if (typeof toast === 'function') toast(text, type);
        // Also append to VC status area if visible
        const vcStatus = document.getElementById('vc-connected-status');
        if (vcStatus) {
            vcStatus.textContent = text;
            vcStatus.style.display = '';
            setTimeout(() => { if (vcStatus.textContent === text) vcStatus.style.display = 'none'; }, 8000);
        }
        return;
    }
    const log = _cid('call-log');
    if (log) {
        const el = document.createElement('div');
        el.className = 'call-log-msg';
        el.textContent = text;
        log.appendChild(el);
        log.scrollTop = log.scrollHeight;
        // Keep max 50 messages
        while (log.children.length > 50) log.removeChild(log.firstChild);
    }
}

function _startViewerCallStatusSync(streamId) {
    _stopViewerCallStatusSync();
    if (!streamId || callState.broadcastMode) return;

    const poll = async () => {
        try {
            const data = await api(`/streams/${streamId}/call`);
            _syncCallModeFromStatus(data.call_mode || null, data.participant_count || 0);
        } catch {}
    };

    poll();
    callState.statusPollTimer = setInterval(poll, 5000);
}

function _stopViewerCallStatusSync() {
    if (callState.statusPollTimer) {
        clearInterval(callState.statusPollTimer);
        callState.statusPollTimer = null;
    }
}

function _syncCallModeFromStatus(nextMode, participantCount = 0) {
    const badge = document.getElementById('call-count-badge');
    if (badge) badge.textContent = participantCount;

    const prevMode = callState.lastSyncedCallMode;
    callState.lastSyncedCallMode = nextMode;
    callState.callMode = nextMode;

    const panel = document.getElementById('call-panel');
    if (!panel || callState.broadcastMode) return;

    if (!nextMode) {
        if (callState.joined || callState.connecting) {
            _callSystemMessage('The streamer disabled voice chat for this stream');
            leaveCall();
        }
        panel.style.display = 'none';
        return;
    }

    panel.style.display = '';
    const labels = { 'mic': 'Voice Chat', 'mic+cam': 'Voice + Camera', 'cam+mic': 'Video Call' };
    const hints = {
        'mic': 'Join the voice chat to talk with the streamer and other viewers',
        'mic+cam': 'Join voice chat — you can optionally enable your camera',
        'cam+mic': 'Join the video call — microphone and camera required',
    };
    const modeLabel = document.getElementById('call-mode-label');
    if (modeLabel) modeLabel.textContent = labels[nextMode] || 'Group Call';
    const hint = document.getElementById('call-join-hint');
    if (hint) hint.textContent = hints[nextMode] || '';
    const camBtn = document.getElementById('call-btn-camera');
    if (camBtn) camBtn.style.display = nextMode === 'mic' ? 'none' : '';
    const camGroup = document.getElementById('call-cam-group');
    if (camGroup) camGroup.style.display = nextMode === 'mic' ? 'none' : '';
    const camSwitchGroup = document.getElementById('call-cam-switch-group');
    if (camSwitchGroup) camSwitchGroup.style.display = nextMode === 'mic' ? 'none' : '';

    if (prevMode && prevMode !== nextMode && callState.joined) {
        _callSystemMessage('The streamer changed the call mode. Please rejoin with the new settings.');
        leaveCall();
    } else {
        _renderCallUI();
    }
}

function _setupLocalAudioProcessing() {
    const audioTrack = callState.localStream?.getAudioTracks?.()[0];
    if (!audioTrack) return;

    // Tear down any previous analysis state
    if (callState.levelInterval) { clearInterval(callState.levelInterval); callState.levelInterval = null; }
    if (callState.localSpeechSource) {
        try { callState.localSpeechSource.disconnect(); } catch {}
        callState.localSpeechSource = null;
    }
    callState.localAnalyser = null;
    if (callState.audioContext) {
        try { callState.audioContext.close(); } catch {}
        callState.audioContext = null;
    }
    if (callState.analysisStream) {
        callState.analysisStream.getTracks().forEach(t => t.stop());
        callState.analysisStream = null;
    }

    try {
        const analysisTrack = audioTrack.clone();
        callState.analysisStream = new MediaStream([analysisTrack]);
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        callState.audioContext = new Ctx();
        // Resume the context in case it starts suspended (autoplay policy)
        if (callState.audioContext.state === 'suspended') {
            callState.audioContext.resume().catch(() => {});
        }
        callState.localSpeechSource = callState.audioContext.createMediaStreamSource(callState.analysisStream);
        callState.localAnalyser = callState.audioContext.createAnalyser();
        callState.localAnalyser.fftSize = 512;
        callState.localAnalyser.smoothingTimeConstant = 0.7;
        callState.localSpeechSource.connect(callState.localAnalyser);
        callState.levelInterval = setInterval(_processLocalSpeechFrame, 80);
    } catch (err) {
        console.warn('[Call] Audio analysis setup failed:', err.message);
    }
}

function _processLocalSpeechFrame() {
    if (!callState.localAnalyser) return;
    const bins = new Uint8Array(callState.localAnalyser.frequencyBinCount);
    callState.localAnalyser.getByteFrequencyData(bins);
    // Only average bins in the speech frequency band (~85–3400 Hz) to reduce
    // false positives from fans, keyboard clicks, and low-frequency rumble
    const sampleRate = callState.audioContext?.sampleRate || 48000;
    const binHz = sampleRate / callState.localAnalyser.fftSize;
    const startBin = Math.max(1, Math.floor(85 / binHz));
    const endBin = Math.min(Math.ceil(3400 / binHz), bins.length);
    let sum = 0;
    for (let i = startBin; i < endBin; i++) sum += bins[i];
    const avg = (endBin - startBin) > 0 ? sum / (endBin - startBin) : 0;
    const percent = Math.round((avg / 255) * 100);
    // Use a softer threshold for speaking indicators in open/PTT modes so
    // indicators better match what others can hear.
    const speakingThreshold = callState.inputMode === 'vad'
        ? callState.vadThreshold
        : Math.max(8, Math.min(30, Math.round(callState.vadThreshold * 0.5)));
    const detected = percent >= speakingThreshold;
    if (detected) callState.speechHoldUntil = Date.now() + 250;
    callState.localSpeechDetected = detected || Date.now() < callState.speechHoldUntil;

    _applyLocalAudioGate();

    const speaking = _shouldBeSpeaking();
    if (speaking !== callState.localSpeaking) {
        callState.localSpeaking = speaking;
        _sendCallMsg({ type: 'speaking', speaking });
        // Targeted update for local tile — avoids full grid rebuild during speech detection
        if (!callState.myPeerId || !_updateTileSpeaking(callState.myPeerId, speaking, callState.muted || callState.forceMuted, false)) {
            _scheduleRender();
        }
    }
}

function _isPttKeyEvent(event) {
    if (!event) return false;
    // Mouse button PTT keys use a synthetic 'code' format: Mouse3, Mouse4, Mouse5
    if (event._pttMouseCode) return event._pttMouseCode === callState.pttKey;
    return event.code === callState.pttKey || event.key === callState.pttKey;
}

function _shouldTransmitAudio() {
    if (callState.muted || callState.forceMuted) return false;
    if (callState.inputMode === 'ptt') return !!callState.pttPressed;
    if (callState.inputMode === 'vad') return !!callState.localSpeechDetected;
    return true;
}

function _shouldBeSpeaking() {
    if (callState.muted || callState.forceMuted) return false;
    if (callState.inputMode === 'ptt') return !!callState.pttPressed;
    if (callState.inputMode === 'vad') return !!callState.localSpeechDetected;
    return !!callState.localSpeechDetected;
}

function _forceStopLocalSpeaking() {
    if (!callState.localSpeaking) return;
    callState.localSpeaking = false;
    _sendCallMsg({ type: 'speaking', speaking: false });
    if (!callState.myPeerId || !_updateTileSpeaking(callState.myPeerId, false, callState.muted || callState.forceMuted, false)) {
        _scheduleRender();
    }
}

function _applyLocalAudioGate() {
    const enabled = _shouldTransmitAudio();
    if (callState.localStream) {
        callState.localStream.getAudioTracks().forEach(t => {
            // Avoid redundant toggles — WebRTC can react badly to rapid enabled flips
            if (t.enabled !== enabled) t.enabled = enabled;
        });
    }
    _syncCallSettingsUI();
}

function onCallInputModeChange(value) {
    if (!['open', 'ptt', 'vad'].includes(value)) return;
    callState.inputMode = value;
    _saveCallUserSettings();
    _syncCallSettingsUI();
    _applyLocalAudioGate();
}

function onCallPttKeyChange(value) {
    if (!value) return;
    callState.pttKey = value;
    _saveCallUserSettings();
    _syncCallSettingsUI();
}

function onCallVadThresholdChange(value) {
    const num = Math.max(5, Math.min(80, parseInt(value, 10) || 32));
    callState.vadThreshold = num;
    _saveCallUserSettings();
    _syncCallSettingsUI();
}

async function _fetchCallStatus(streamId) {
    try {
        const data = await api(`/streams/${streamId}/call`);
        _syncCallModeFromStatus(data.call_mode || null, data.participant_count || 0);
    } catch {}
}

async function _populateCallDevices() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        // Populate both pre-join selects, in-call switcher selects, and broadcast selects
        const micSelects = [
            document.getElementById('call-mic-select'),
            document.getElementById('call-mic-switch'),
            document.getElementById('bc-call-mic-switch'),
        ].filter(Boolean);
        const camSelects = [
            document.getElementById('call-cam-select'),
            document.getElementById('call-cam-switch'),
            document.getElementById('bc-call-cam-switch'),
        ].filter(Boolean);

        const audioInputs = devices.filter(d => d.kind === 'audioinput');
        const videoInputs = devices.filter(d => d.kind === 'videoinput');

        micSelects.forEach(sel => {
            sel.innerHTML = '<option value="default">Default Microphone</option>';
            audioInputs.forEach(d => {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Microphone ${sel.options.length}`;
                sel.appendChild(opt);
            });
            if ([...sel.options].some(opt => opt.value === callState.selectedMic)) sel.value = callState.selectedMic;
            sel.onchange = () => { callState.selectedMic = sel.value; _saveCallUserSettings(); };
        });

        camSelects.forEach(sel => {
            sel.innerHTML = '<option value="default">Default Camera</option>';
            videoInputs.forEach(d => {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Camera ${sel.options.length}`;
                sel.appendChild(opt);
            });
            if ([...sel.options].some(opt => opt.value === callState.selectedCam)) sel.value = callState.selectedCam;
            sel.onchange = () => { callState.selectedCam = sel.value; _saveCallUserSettings(); };
        });
        _syncCallSettingsUI();
    } catch {}
}

/** Switch microphone while in an active call */
async function switchCallMic(deviceId) {
    if (!callState.joined || !callState.localStream) return;
    // Prevent mic switch when sharing broadcast audio — would steal the mic from the stream
    if (callState._sharedBroadcastAudio) {
        _callSystemMessage('Cannot switch mic while sharing broadcast audio');
        return;
    }
    callState.selectedMic = deviceId;
    _saveCallUserSettings();
    try {
        const newStream = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: deviceId !== 'default' ? { exact: deviceId } : undefined }
        });
        const newTrack = newStream.getAudioTracks()[0];
        const oldTrack = callState.localStream.getAudioTracks()[0];

        // Replace track in local stream
        if (oldTrack) {
            callState.localStream.removeTrack(oldTrack);
            oldTrack.stop();
        }
        callState.localStream.addTrack(newTrack);
        _setupLocalAudioProcessing();
        _applyLocalAudioGate();

        // Replace track in all peer connections
        for (const [, peer] of callState.peers) {
            const sender = peer.pc.getSenders().find(s => s.track && s.track.kind === 'audio');
            if (sender) await sender.replaceTrack(newTrack);
        }
        _callSystemMessage('Microphone switched');
    } catch (err) {
        console.warn('[Call] Mic switch failed:', err);
        _callSystemMessage('Failed to switch microphone');
    }
}

/** Switch camera while in an active call */
async function switchCallCam(deviceId) {
    if (!callState.joined || !callState.localStream || callState.callMode === 'mic') return;
    callState.selectedCam = deviceId;
    _saveCallUserSettings();
    if (callState.cameraOff) return; // Just save preference, will use on next enable
    try {
        const newStream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: deviceId !== 'default' ? { exact: deviceId } : undefined, width: { ideal: 320 }, height: { ideal: 240 } }
        });
        const newTrack = newStream.getVideoTracks()[0];
        const oldTrack = callState.localStream.getVideoTracks()[0];

        if (oldTrack) {
            callState.localStream.removeTrack(oldTrack);
            oldTrack.stop();
        }
        callState.localStream.addTrack(newTrack);

        // Replace track in all peer connections
        for (const [, peer] of callState.peers) {
            const sender = peer.pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) {
                await sender.replaceTrack(newTrack);
                _optimizeCallSender(sender, newTrack);
            }
        }
        _renderCallUI();
        _callSystemMessage('Camera switched');
    } catch (err) {
        console.warn('[Call] Camera switch failed:', err);
        _callSystemMessage('Failed to switch camera');
    }
}

function _esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

/** Close call context menus when clicking outside */
document.addEventListener('click', () => {
    if (callState.openContextMenu) {
        _closePeerContextMenu();
    }
});

// Autoplay recovery hooks for browsers that require fresh user gestures.
['click', 'pointerdown', 'touchstart', 'keydown'].forEach((evt) => {
    document.addEventListener(evt, () => {
        _resumeAllPeerAudioPlayback();
    }, { passive: true });
});

window.addEventListener('resize', () => {
    if (callState.openContextMenu) {
        _renderFloatingPeerContextMenu();
    }
});

document.addEventListener('scroll', () => {
    if (callState.openContextMenu) {
        _renderFloatingPeerContextMenu();
    }
}, true);

document.addEventListener('keydown', (e) => {
    if (e.repeat || callState.inputMode !== 'ptt' || !_isPttKeyEvent(e)) return;
    const target = e.target;
    const tag = target?.tagName?.toLowerCase?.();
    if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;
    // Prevent default for PTT keys to avoid unwanted side effects (e.g. scrolling on Space)
    if (['Space', 'AltLeft', 'AltRight'].includes(e.code)) e.preventDefault();
    callState.pttPressed = true;
    _applyLocalAudioGate();
    _updatePttIndicator();
});

document.addEventListener('keyup', (e) => {
    if (callState.inputMode !== 'ptt' || !_isPttKeyEvent(e)) return;
    callState.pttPressed = false;
    _forceStopLocalSpeaking();
    _applyLocalAudioGate();
    _updatePttIndicator();
});

// Mouse button PTT support (middle click, mouse 4/5)
document.addEventListener('mousedown', (e) => {
    if (callState.inputMode !== 'ptt') return;
    const mouseCode = `Mouse${e.button + 1}`;
    if (mouseCode !== callState.pttKey) return;
    e.preventDefault();
    callState.pttPressed = true;
    _applyLocalAudioGate();
    _updatePttIndicator();
});

document.addEventListener('mouseup', (e) => {
    if (callState.inputMode !== 'ptt') return;
    const mouseCode = `Mouse${e.button + 1}`;
    if (mouseCode !== callState.pttKey) return;
    callState.pttPressed = false;
    _forceStopLocalSpeaking();
    _applyLocalAudioGate();
    _updatePttIndicator();
});

window.addEventListener('blur', () => {
    if (callState.inputMode !== 'ptt') return;
    callState.pttPressed = false;
    _forceStopLocalSpeaking();
    _applyLocalAudioGate();
    _updatePttIndicator();
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden && callState.inputMode === 'ptt') {
        callState.pttPressed = false;
        _forceStopLocalSpeaking();
        _applyLocalAudioGate();
        _updatePttIndicator();
    }
});

// Prevent context menu from appearing when using right/middle mouse PTT
document.addEventListener('contextmenu', (e) => {
    if (callState.inputMode === 'ptt' && callState.pttKey.startsWith('Mouse')) {
        e.preventDefault();
    }
});

/**
 * Update the visual PTT "transmitting" indicator across all PTT status elements.
 */
function _updatePttIndicator() {
    const isActive = callState.pttPressed && callState.joined && callState.inputMode === 'ptt';
    ['call-ptt-status', 'bc-call-ptt-status', 'vc-ptt-status'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('ptt-active', isActive);
    });
    // Also update the mute button to show transmitting state
    ['call-btn-mute', 'bc-call-btn-mute', 'vc-btn-mute'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('ptt-transmitting', isActive);
    });
}

window.addEventListener('openvibe-auth-changed', () => {
    if (callState.joined || callState.connecting) {
        _syncCallAuthState();
        _scheduleRender();
    }
});

function _getAuthToken() {
    // Prefer the live auth cookie over localStorage so account switches
    // do not leave stale websocket identities behind.
    try {
        const openvibeMatch = document.cookie.match(/(?:^|;\s*)ov_token=([^;]+)/);
        if (openvibeMatch) return decodeURIComponent(openvibeMatch[1]);
        const legacyMatch = document.cookie.match(/(?:^|;\s*)token=([^;]+)/);
        if (legacyMatch) return decodeURIComponent(legacyMatch[1]);
        const stored = localStorage.getItem('token');
        return stored || null;
    } catch {
        return null;
    }
}
