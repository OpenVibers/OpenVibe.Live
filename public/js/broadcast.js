'use strict';
/* ═══════════════════════════════════════════════════════════════
   broadcast.js — Core streaming: WebRTC signaling, RTMP, JSMPEG,
   restream, RobotStreamer, live controls, TTS, clip creation.
   State foundation  → broadcast-state.js
   Device enumeration→ broadcast-devices.js
   VOD archive       → broadcast-vods.js
   Workspace UI      → broadcast-workspace.js
   ═══════════════════════════════════════════════════════════════ */


/* ── Per-slot RobotStreamer config ───────────────────────────── */
// Each stream slot (managed stream) can carry its own RobotStreamer
// token + robot, configured in the slot's Restream Destinations panel.
// Slots with their own config auto-restream independently; slots without
// fall back to the account-level config + legacy single-slot reservation.
const _rsSlotIntegrationCache = new Map(); // managed_stream_id → { fetchedAt, integration|null }

async function fetchSlotRsIntegration(managedStreamId, { force = false } = {}) {
    if (!managedStreamId) return null;
    const cached = _rsSlotIntegrationCache.get(managedStreamId);
    if (!force && cached && Date.now() - cached.fetchedAt < 60000) return cached.integration;
    try {
        const data = await api(`/robotstreamer/integration?managed_stream_id=${managedStreamId}`);
        const integration = data.exists ? data.integration : null;
        _rsSlotIntegrationCache.set(managedStreamId, { fetchedAt: Date.now(), integration });
        return integration;
    } catch {
        return cached?.integration ?? null;
    }
}

function rsSlotIntegrationUsable(slotRs) {
    return !!(slotRs?.enabled && slotRs?.has_token && slotRs?.robot_id);
}

/* ── RS Restream Slot ────────────────────────────────────────── */
// Only one stream at a time can restream to RobotStreamer.
// Slot is stored as 'm:<managed_stream_id>' only.
// Legacy 's:<streamId>' and bare-integer formats are auto-migrated on read.
function parseRsRestreamSlotValue() {
    const raw = localStorage.getItem('bc-rs-restream-slot');
    if (!raw) return null;
    if (raw.startsWith('m:')) {
        const id = parseInt(raw.slice(2), 10);
        return Number.isFinite(id) && id > 0 ? { managedStreamId: id } : null;
    }
    // Legacy 's:<streamId>' or bare integer — migrate on read:
    // try to resolve to a managed_stream_id; if not possible, clear the slot.
    const legacyId = raw.startsWith('s:') ? parseInt(raw.slice(2), 10) : parseInt(raw, 10);
    if (Number.isFinite(legacyId) && legacyId > 0) {
        // Find corresponding managed stream among active broadcast streams
        for (const [, ss] of (typeof broadcastState !== 'undefined' ? broadcastState.streams : new Map())) {
            if (ss.streamData?.id === legacyId && ss.streamData?.managed_stream_id) {
                // Migrate to managed format in-place
                const migratedId = ss.streamData.managed_stream_id;
                localStorage.setItem('bc-rs-restream-slot', `m:${migratedId}`);
                console.log(`[RS Slot] Migrated legacy s:${legacyId} → m:${migratedId}`);
                return { managedStreamId: migratedId };
            }
        }
        // Could not migrate (stream not active) — clear stale legacy slot
        localStorage.removeItem('bc-rs-restream-slot');
        console.log(`[RS Slot] Cleared stale legacy slot value: ${raw}`);
    }
    return null;
}
function getRsRestreamSlotStreamId() {
    const value = parseRsRestreamSlotValue();
    if (!value) return null;

    if (value.managedStreamId) {
        for (const [id, ss] of broadcastState.streams) {
            if (ss.localStream && ss.streamData?.managed_stream_id === value.managedStreamId) {
                return id;
            }
        }
        return null;
    }

    return null;
}
function setRsRestreamSlot(streamId) {
    if (!streamId) {
        localStorage.removeItem('bc-rs-restream-slot');
        return;
    }
    const ss = getStreamState(streamId);
    if (ss?.streamData?.managed_stream_id) {
        localStorage.setItem('bc-rs-restream-slot', `m:${ss.streamData.managed_stream_id}`);
    } else {
        // Stream has no managed_stream_id — cannot store a slot-safe reference; clear slot.
        console.warn(`[RS Slot] Cannot assign RS slot for stream ${streamId}: no managed_stream_id`);
        localStorage.removeItem('bc-rs-restream-slot');
    }
}
function isRsRestreamAssigned(streamId) {
    const value = parseRsRestreamSlotValue();
    if (!value) return true; // no slot assigned → any stream can be used
    const ss = getStreamState(streamId);
    if (!ss) return false;
    // Only managed_stream_id-based slots are now valid
    return ss.streamData?.managed_stream_id === value.managedStreamId;
}
/** Toggle RS restream for the currently active stream */
function toggleRsRestreamSlot() {
    const streamId = broadcastState.activeStreamId;
    if (!streamId) return;
    const ss = getStreamState(streamId);
    if (!ss) return;
    const currentSlot = getRsRestreamSlotStreamId();
    if (currentSlot === streamId) {
        // Unassign — stop restream
        setRsRestreamSlot(null);
        stopRobotStreamerRestream(streamId).catch(() => {});
        toast('RS restream stopped', 'info');
    } else {
        // Assign this stream — stop restream on old slot first
        if (currentSlot) {
            const oldSs = getStreamState(currentSlot);
            if (oldSs?.robotStreamer?.active) {
                stopRobotStreamerRestream(currentSlot, { quiet: true }).catch(() => {});
            }
        }
        setRsRestreamSlot(streamId);
        if (ss.localStream && canUseRobotStreamerRestream()) {
            startRobotStreamerRestream(streamId).catch(() => {});
        }
        toast('RS restream assigned to this stream', 'success');
    }
    updateRsRestreamSlotUI();
}

/** Assign RS restream to a specific stream (from dropdown) */
function assignRsRestreamToStream(streamId) {
    streamId = parseInt(streamId);
    if (!streamId || !Number.isFinite(streamId)) return;
    const currentSlot = getRsRestreamSlotStreamId();
    if (currentSlot && currentSlot !== streamId) {
        stopRobotStreamerRestream(currentSlot, { quiet: true }).catch(() => {});
    }
    setRsRestreamSlot(streamId);
    const ss = getStreamState(streamId);
    if (ss?.localStream && canUseRobotStreamerRestream()) {
        startRobotStreamerRestream(streamId).catch(() => {});
    }
    updateRsRestreamSlotUI();
}

/** Stop RS restream and clear the slot */
function stopRsRestream() {
    const slot = getRsRestreamSlotStreamId();
    if (slot) {
        stopRobotStreamerRestream(slot).catch(() => {});
    }
    setRsRestreamSlot(null);
    updateRsRestreamSlotUI();
}

/** Start or retry RS restream for the current slot / active stream */
function startOrRetryRsRestream() {
    const slotStreamId = getRsRestreamSlotStreamId();
    let targetId = slotStreamId || broadcastState.activeStreamId;
    const slotValue = parseRsRestreamSlotValue();

    // If a managed slot is reserved but not currently live, do not auto-assign a different stream.
    if (!targetId && slotValue?.managedStreamId) {
        toast('RobotStreamer slot is reserved for a different stream slot.', 'info');
        return;
    }

    if (!targetId) return;
    const ss = getStreamState(targetId);
    if (!ss?.localStream) {
        if (slotStreamId) {
            // Slot stream is reserved but not live yet.
            toast('RobotStreamer slot stream is not live yet.', 'info');
            updateRsRestreamSlotUI();
            return;
        }
        targetId = broadcastState.activeStreamId;
        if (!targetId) return;
    }
    const targetSs = getStreamState(targetId);
    if (targetSs) {
        targetSs._rsConsecutiveShortLived = 0;
        targetSs._rsReconnectDelay = RS_RECONNECT_BASE_DELAY;
    }
    setRsRestreamSlot(targetId);
    stopRobotStreamerRestream(targetId, { quiet: true })
        .catch(() => {})
        .then(() => {
            startRobotStreamerRestream(targetId).catch(() => {});
        });
    updateRsRestreamSlotUI();
}

/** Update RS restream control panel in live controls */
function updateRsRestreamSlotUI() {
    updateRestreamControlPanel();
    const panel = document.getElementById('bc-rs-control');
    if (!panel) return;

    // If RS not configured (neither account-level nor any live slot config), hide the panel
    const hasSlotRs = [...broadcastState.streams.values()].some(s => rsSlotIntegrationUsable(s._rsSlotIntegration));
    if (!canUseRobotStreamerRestream() && !hasSlotRs) {
        panel.style.display = 'none';
        return;
    }
    panel.style.display = '';

    const liveStreams = [];
    for (const [id, ss] of broadcastState.streams) {
        if (ss.localStream && ss.streamData) {
            liveStreams.push({ id, title: ss.streamData.title || `Stream ${id}`, ss });
        }
    }

    const slotId = getRsRestreamSlotStreamId();
    const slotSs = slotId ? getStreamState(slotId) : null;
    const isLive = !!(slotSs?.robotStreamer?.active);
    const isStarting = !!(slotSs?._rsRestreamStarting);
    const hasFailed = !isLive && !isStarting && slotSs && !slotSs.robotStreamer && (slotSs._rsConsecutiveShortLived || 0) >= RS_MAX_SHORT_LIVED_RETRIES;

    let html = '';

    // Stream picker (only when multi-streaming)
    if (liveStreams.length > 1) {
        html += `<div class="bc-rs-stream-picker">
            <label><i class="fa-solid fa-tower-broadcast"></i> Stream:</label>
            <select onchange="assignRsRestreamToStream(this.value)">`;
        if (!slotId) html += `<option value="">— Select stream —</option>`;
        for (const s of liveStreams) {
            const sel = slotId === s.id ? 'selected' : '';
            html += `<option value="${s.id}" ${sel}>${s.title}</option>`;
        }
        html += `</select></div>`;
    }

    // Status + action buttons
    html += '<div class="bc-rs-status-row">';
    if (isLive) {
        html += `<span class="bc-rs-status bc-rs-live"><i class="fa-solid fa-circle"></i> RS Live</span>`;
        html += `<button class="bc-ctrl-btn bc-ctrl-btn-sm" onclick="stopRsRestream()"><i class="fa-solid fa-stop"></i> Stop</button>`;
    } else if (isStarting) {
        html += `<span class="bc-rs-status bc-rs-connecting"><i class="fa-solid fa-spinner fa-spin"></i> Connecting…</span>`;
        html += `<button class="bc-ctrl-btn bc-ctrl-btn-sm" onclick="stopRsRestream()"><i class="fa-solid fa-stop"></i> Cancel</button>`;
    } else if (hasFailed) {
        html += `<span class="bc-rs-status bc-rs-error"><i class="fa-solid fa-circle-exclamation"></i> Failed</span>`;
        html += `<button class="bc-ctrl-btn bc-ctrl-btn-sm" onclick="startOrRetryRsRestream()"><i class="fa-solid fa-rotate-right"></i> Retry</button>`;
    } else if (slotId && slotSs?.localStream) {
        // Slot assigned but not started yet (could be reconnecting)
        const isReconnecting = !!(slotSs._rsReconnectTimer);
        if (isReconnecting) {
            html += `<span class="bc-rs-status bc-rs-connecting"><i class="fa-solid fa-spinner fa-spin"></i> Reconnecting…</span>`;
            html += `<button class="bc-ctrl-btn bc-ctrl-btn-sm" onclick="stopRsRestream()"><i class="fa-solid fa-stop"></i> Cancel</button>`;
        } else {
            html += `<span class="bc-rs-status bc-rs-ready"><i class="fa-solid fa-robot"></i> Ready</span>`;
            html += `<button class="bc-ctrl-btn bc-ctrl-btn-sm" onclick="startOrRetryRsRestream()"><i class="fa-solid fa-play"></i> Start</button>`;
        }
    } else {
        // No slot assigned
        html += `<span class="bc-rs-status bc-rs-off"><i class="fa-solid fa-robot"></i> RS Off</span>`;
        html += `<button class="bc-ctrl-btn bc-ctrl-btn-sm" onclick="startOrRetryRsRestream()"><i class="fa-solid fa-play"></i> Start</button>`;
    }
    html += '</div>';

    panel.innerHTML = html;
}
/** Conditionally start RS restream — slot-specific config first, legacy account slot second */
async function maybeStartRsRestream(streamId) {
    const ss = getStreamState(streamId);
    const msId = ss?.streamData?.managed_stream_id || null;
    const slotRs = await fetchSlotRsIntegration(msId);
    if (slotRs) {
        // This slot has its own RS config — it restreams independently of the
        // legacy single-slot reservation and of other slots.
        if (ss) ss._rsSlotIntegration = slotRs;
        if (rsSlotIntegrationUsable(slotRs)) {
            startRobotStreamerRestream(streamId).catch(() => {});
            updateRsRestreamSlotUI();
        }
        return;
    }
    // Legacy account-level behavior
    if (!isRsRestreamAssigned(streamId)) return;
    // Auto-assign the slot on first live stream
    const currentSlot = getRsRestreamSlotStreamId();
    if (!currentSlot) setRsRestreamSlot(streamId);
    startRobotStreamerRestream(streamId).catch(() => {});
    updateRsRestreamSlotUI();
}

function sendBroadcastSignal(ss, msg) {
    if (!ss?.signalingWs || ss.signalingWs.readyState !== WebSocket.OPEN) return false;
    if (ss.signalingWs.bufferedAmount > BROADCAST_SIGNALING_MAX_BUFFERED_AMOUNT) return false;
    ss.signalingWs.send(JSON.stringify(msg));
    return true;
}

function _ensureSfuBroadcastReady(streamId, reason = 'startup') {
    const ss = getStreamState(streamId);
    if (!ss?.localStream || !ss?.signalingWs || ss.signalingWs.readyState !== WebSocket.OPEN) return;
    _handleSfuProduceRequest(streamId).catch((err) => {
        console.warn(`[SFU Produce] Auto-start failed for stream ${streamId} during ${reason}:`, err.message);
    });
}

function clearViewerReconnectTimer(ss, viewerPeerId) {
    const timer = ss?.viewerReconnectTimers?.get(viewerPeerId);
    if (timer) clearTimeout(timer);
    ss?.viewerReconnectTimers?.delete(viewerPeerId);
}

function scheduleViewerReconnect(streamId, viewerPeerId, delay = 2000) {
    const ss = getStreamState(streamId);
    if (!ss || !viewerPeerId || !ss._allowP2pFallback) return;
    clearViewerReconnectTimer(ss, viewerPeerId);
    ss.viewerReconnectTimers.set(viewerPeerId, setTimeout(() => {
        clearViewerReconnectTimer(ss, viewerPeerId);
        if (!broadcastState.streams.has(streamId)) return;
        if (!ss.localStream) return;
        if (!ss.signalingWs || ss.signalingWs.readyState !== WebSocket.OPEN) return;
        createViewerConnection(streamId, viewerPeerId).catch((err) => {
            console.warn(`[Broadcast] Viewer reconnect failed for ${viewerPeerId}:`, err.message);
        });
    }, delay));
}

/**
 * Attach diagnostic logging to track/stream events.
 *
 * IMPORTANT: These handlers NO LONGER trigger recovery directly.
 * Recovery is driven exclusively by the frame watchdog in startTrackKeepalive().
 *
 * On Steam Deck / PipeWire / Gamescope, track 'ended' and stream 'inactive'
 * events fire spuriously every few minutes during normal operation (GPU
 * compositing switches, power state transitions, PipeWire pipeline
 * renegotiations). Reacting to these events caused the stream to go black
 * and restart constantly. The watchdog approach only triggers recovery when
 * frames actually stop being produced for 20+ seconds.
 */
function attachLocalStreamRecoveryHandlers(streamId) {
    const ss = getStreamState(streamId);
    if (!ss?.localStream) return;
    const currentStream = ss.localStream;

    const isStillCurrent = () => {
        const latest = getStreamState(streamId);
        return latest && latest.localStream === currentStream;
    };

    currentStream.getTracks().forEach((track) => {
        track.addEventListener('ended', () => {
            if (!isStillCurrent()) return;
            console.log(`[Broadcast] Track '${track.kind}' ended event (readyState: ${track.readyState}) — watchdog will handle if persistent`);
        }, { once: true });

        track.addEventListener('mute', () => {
            if (!isStillCurrent()) return;
            console.log(`[Broadcast] Track '${track.kind}' muted (readyState: ${track.readyState})`);
            if (track.kind === 'video') {
                const ss2 = getStreamState(streamId);
                if (ss2) ss2._videoTrackMutedAt = Date.now();
            }
        });
        track.addEventListener('unmute', () => {
            if (!isStillCurrent()) return;
            console.log(`[Broadcast] Track '${track.kind}' unmuted (readyState: ${track.readyState})`);
            if (track.kind === 'video') {
                const ss2 = getStreamState(streamId);
                if (ss2) {
                    ss2._videoTrackMutedAt = null;
                    ss2._watchdogResetRequested = true; // signal watchdog to reset timer
                }
            }
        });
    });

    if (typeof currentStream.addEventListener === 'function') {
        currentStream.addEventListener('inactive', () => {
            if (!isStillCurrent()) return;
            const latest = getStreamState(streamId);
            if (latest._suppressRecovery) return;
            console.log('[Broadcast] MediaStream inactive event — watchdog will handle if persistent');
        }, { once: true });
    }
}

function scheduleMediaRecovery(streamId, reason = 'media interrupted') {
    const ss = getStreamState(streamId);
    if (!ss || ss.mediaRecoveryInProgress || ss.mediaRecoveryTimer || !broadcastState.streams.has(streamId)) return;

    // Recovery cooldown — if media was just recovered, spurious track events from
    // the fresh capture pipeline should be ignored. This prevents rapid recovery
    // loops on Steam Deck / PipeWire where tracks can fire ended events briefly
    // after a new getUserMedia call.
    const RECOVERY_COOLDOWN_MS = 60000;
    if (ss._lastRecoveryCompletedAt && (Date.now() - ss._lastRecoveryCompletedAt) < RECOVERY_COOLDOWN_MS) {
        console.log(`[Broadcast] Ignoring recovery trigger during cooldown (${reason})`);
        return;
    }

    if (broadcastState.settings.broadcastLimit === 'stop') {
        toast(`Broadcast input lost (${reason}). Stream stopping.`, 'error');
        api(`/streams/${streamId}`, { method: 'DELETE' }).catch(() => {}).finally(() => cleanupStream(streamId));
        return;
    }

    const delay = Math.min(2000 * (ss.mediaRecoveryAttempts + 1), 10000);
    ss.mediaRecoveryAttempts += 1;
    ss._recoveryStartedAt = Date.now();
    if (broadcastState.activeStreamId === streamId) {
        updateBroadcastStatus('checking');
        // Only show warning toast on first attempt — subsequent retries log silently
        if (ss.mediaRecoveryAttempts <= 1) {
            toast(`Broadcast interrupted — attempting recovery (${reason})`, 'warning');
        } else {
            console.warn(`[Broadcast] Media recovery retry ${ss.mediaRecoveryAttempts} (${reason})`);
        }
    }
    ss.mediaRecoveryTimer = setTimeout(() => {
        ss.mediaRecoveryTimer = null;
        recoverStreamMedia(streamId, reason).catch((err) => {
            console.warn('[Broadcast] Media recovery failed:', err.message);
            const latest = getStreamState(streamId);
            if (!latest) return;
            latest.mediaRecoveryInProgress = false;
            if (latest.mediaRecoveryAttempts < 4) {
                scheduleMediaRecovery(streamId, err.message || reason);
            } else if (broadcastState.activeStreamId === streamId) {
                updateBroadcastStatus('error');
                toast('Broadcast recovery failed — please restart the stream', 'error');
            }
        });
    }, delay);
}

async function recoverStreamMedia(streamId, reason = 'media interrupted') {
    const ss = getStreamState(streamId);
    if (!ss || ss.mediaRecoveryInProgress) return;
    ss.mediaRecoveryInProgress = true;
    await uploadVodRecording(streamId, { finalizeStream: false });

    // Stop the RS restream BEFORE nulling localStream — prevents the
    // "localStream lost before join" race if an RS start is in-flight.
    const hadRsRestream = !!ss.robotStreamer?.active;
    await stopRobotStreamerRestream(streamId, { quiet: true }).catch(() => {});
    _cleanupSfuProduce(streamId);

    // Suppress recovery and null-out localStream BEFORE stopping tracks.
    // This ensures the ended/inactive handlers see a different localStream
    // reference and bail out, preventing re-entrant recovery loops.
    stopTrackKeepalive(streamId);
    ss._suppressRecovery = true;
    if (ss.localStream) {
        const oldStream = ss.localStream;
        ss.localStream = null;
        try { oldStream.getTracks().forEach((track) => track.stop()); } catch {}
    }

    await startMediaCapture(streamId);
    ss._suppressRecovery = false; // new stream handlers are now attached
    startVodRecording(streamId);

    if (!ss.signalingWs || ss.signalingWs.readyState !== WebSocket.OPEN) {
        connectSignaling(streamId);
    } else {
        _ensureSfuBroadcastReady(streamId, 'media-recovery');
    }

    // Full RS restart after new media is acquired — old producers are dead
    // after a track-ended event so replaceTrack won't work.
    if (hadRsRestream || canUseRobotStreamerRestream()) {
        startRobotStreamerRestream(streamId).catch((err) => {
            console.warn('[RS Restream] Restart after media recovery failed:', err.message);
        });
    }

    ss.mediaRecoveryAttempts = 0;
    ss.mediaRecoveryInProgress = false;
    ss._lastRecoveryCompletedAt = Date.now();
    if (broadcastState.activeStreamId === streamId) {
        updateBroadcastStatusFromConnections(streamId);
        // Only show success toast if recovery was slow enough for the user to notice
        const elapsed = Date.now() - (ss._recoveryStartedAt || 0);
        if (elapsed > 5000) {
            toast(`Broadcast recovered after ${reason}`, 'success');
        } else {
            console.log(`[Broadcast] Silent recovery succeeded in ${elapsed}ms (${reason})`);
        }
    }
}

/** Get the active stream's state, or null */
function getActiveStreamState() {
    return broadcastState.activeStreamId != null ? broadcastState.streams.get(broadcastState.activeStreamId) || null : null;
}

/** Get specific stream state by ID */
function getStreamState(streamId) {
    return broadcastState.streams.get(streamId) || null;
}

/** Whether any streams are currently active */
function isStreaming() {
    return broadcastState.streams.size > 0;
}

/* ── Broadcast Tabs Management ──────────────────────────────── */

/**
 * Switch between broadcast tabs (Go Live, Past Streams, Broadcast Settings)
 */
function switchBroadcastTab(tabName) {
    // If switching away from the live broadcast view to a page-level tab,
    // hide the live/instructions panels so the tab content is visible
    const hidePanels = ['bc-browser-broadcast', 'bc-rtmp-instructions', 'bc-jsmpeg-instructions', 'bc-webrtc-obs-instructions'];
    for (const id of hidePanels) {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    }

    // Show the page tabs nav (it may be hidden during live view)
    const tabsNav = document.querySelector('.broadcast-page-tabs-nav');
    if (tabsNav) tabsNav.style.display = '';

    // Hide all tab content
    const allTabs = document.querySelectorAll('.broadcast-tab-content');
    allTabs.forEach(tab => tab.classList.remove('active'));

    // Show selected tab content
    const selectedTab = document.querySelector(`.broadcast-tab-content[data-tab="${tabName}"]`);
    if (selectedTab) {
        selectedTab.classList.add('active');
    }

    // Update tab button states
    const allButtons = document.querySelectorAll('.broadcast-page-tab-btn');
    allButtons.forEach(btn => btn.classList.remove('active'));

    const activeButton = document.querySelector(`.broadcast-page-tab-btn[data-tab="${tabName}"]`);
    if (activeButton) {
        activeButton.classList.add('active');
        updateTabIndicator(activeButton);
    }

    // Load tab content if needed
    if (tabName === 'past-streams') {
        loadBroadcastVODs();
    } else if (tabName === 'broadcast-settings') {
        loadBroadcastSettingsForm();
    } else if (tabName === 'go-live') {
        // If there's an active stream, restore the live broadcast view
        const ss = getActiveStreamState?.();
        if (ss && ss.localStream) {
            showBrowserBroadcast();
        }
    }

    // Save active tab preference
    try {
        localStorage.setItem('openvibe_active_broadcast_tab', tabName);
    } catch {}
}

/**
 * Update the tab indicator position
 */
function updateTabIndicator(activeButton) {
    const indicator = document.querySelector('.broadcast-page-tabs-indicator');
    if (!indicator || !activeButton) return;

    const container = document.querySelector('.broadcast-page-tabs-container');
    if (!container) return;

    const buttonRect = activeButton.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const relativeLeft = buttonRect.left - containerRect.left;

    indicator.style.left = `${relativeLeft}px`;
    indicator.style.width = `${buttonRect.width}px`;
}

/**
 * Initialize broadcast tabs on page load
 */
function initBroadcastTabs() {
    // Restore saved tab preference
    let savedTab = 'go-live';
    try {
        savedTab = localStorage.getItem('openvibe_active_broadcast_tab') || 'go-live';
    } catch {}

    switchBroadcastTab(savedTab);

    // Add resize listener for indicator
    window.addEventListener('resize', () => {
        const activeButton = document.querySelector('.broadcast-page-tab-btn.active');
        updateTabIndicator(activeButton);
    });
}

/* ── Load/Save Settings ──────────────────────────────────────── */
function loadBroadcastSettings() {
    try {
        const saved = localStorage.getItem('openvibe_broadcast_settings');
        if (saved) broadcastState.settings = { ...broadcastState.settings, ...JSON.parse(saved) };
    } catch { /* ignore */ }
}
function saveBroadcastSettings() {
    try { localStorage.setItem('openvibe_broadcast_settings', JSON.stringify(broadcastState.settings)); } catch {}
    // Persist to server for the selected managed stream (fire-and-forget)
    const msSelect = document.getElementById('bc-managed-stream');
    const msId = msSelect?.value ? parseInt(msSelect.value) : null;
    if (msId) {
        api('/streams/broadcast-settings', {
            method: 'PUT',
            body: { managed_stream_id: msId, settings: broadcastState.settings },
        }).catch(() => {});
    }
}

async function loadManagedStreamSettings(managedStreamId) {
    if (!managedStreamId) return;
    try {
        const data = await api(`/streams/broadcast-settings?managed_stream_id=${managedStreamId}`);
        if (data.settings && Object.keys(data.settings).length > 0) {
            broadcastState.settings = { ...broadcastState.settings, ...data.settings };
            try { localStorage.setItem('openvibe_broadcast_settings', JSON.stringify(broadcastState.settings)); } catch {}
        }
    } catch { /* ignore — use localStorage fallback */ }
}

function setRobotStreamerStatus(message, tone = 'info', targetId = 'bc-rsStatus') {
    const el = document.getElementById(targetId);
    if (!el) return;
    const colors = {
        success: 'var(--success, #22c55e)',
        error: 'var(--danger, #ef4444)',
        warning: 'var(--warning, #f59e0b)',
        info: 'var(--text-muted, #9ca3af)',
    };
    el.textContent = message;
    el.style.color = colors[tone] || colors.info;
}

function populateRobotStreamerSelect(robots = [], selectedRobotId = '') {
    const select = document.getElementById('bc-rsRobotSelect');
    if (!select) return;
    const items = Array.isArray(robots) ? robots : [];
    select.innerHTML = '<option value="">Validate to load your RobotStreamer streams</option>';
    items.forEach((robot) => {
        const option = document.createElement('option');
        option.value = robot.robot_id;
        const viewers = Number(robot.viewers || 0);
        option.textContent = `${robot.robot_name || `Robot ${robot.robot_id}`} (${robot.robot_id}) • ${robot.status || 'offline'} • ${viewers} viewer${viewers === 1 ? '' : 's'}`;
        select.appendChild(option);
    });
    if (selectedRobotId) select.value = String(selectedRobotId);
}

function syncRobotStreamerUI() {
    const rs = broadcastState.robotStreamer;
    const setCheck = (id, value) => { const el = document.getElementById(id); if (el) el.checked = !!value; };
    const setVal = (id, value) => { const el = document.getElementById(id); if (el) el.value = value || ''; };

    setCheck('bc-rsEnabled', rs.enabled);
    setCheck('bc-rsMirrorChat', rs.mirrorChat);
    setVal('bc-rsRobotInput', rs.robotId);
    populateRobotStreamerSelect(rs.availableRobots, rs.robotId);

    const tokenEl = document.getElementById('bc-rsToken');
    if (tokenEl) tokenEl.placeholder = rs.hasToken
        ? 'Saved token on file — paste a new one only if you want to replace it'
        : 'Paste your robotstreamer-token cookie or JWT';

    const summary = rs.ownerName || rs.streamName
        ? `Configured for ${rs.streamName || `Robot ${rs.robotId}`} as ${rs.ownerName || rs.ownerId || 'unknown owner'}.`
        : 'RobotStreamer restreaming works with browser WebRTC broadcasting. Paste your RobotStreamer token, validate a robot, then go live.';
    setRobotStreamerStatus(summary, rs.hasToken ? 'success' : 'info', 'bc-rsStatus');

    // Update live status based on current state
    const liveStatusEl = document.getElementById('bc-rsLiveStatus');
    if (liveStatusEl) {
        // Don't overwrite active status messages from ongoing restream
        const currentText = liveStatusEl.textContent;
        const isActiveStatus = currentText.includes('live') || currentText.includes('connecting') || currentText.includes('reconnect') || currentText.includes('Loading') || currentText.includes('Joining') || currentText.includes('Sending') || currentText.includes('Negotiating') || currentText.includes('Creating');
        if (!isActiveStatus) {
            if (rs.enabled && rs.hasToken && rs.robotId) {
                setRobotStreamerStatus('RobotStreamer restream ready — will start when you go live.', 'info', 'bc-rsLiveStatus');
                // If we're already live but RS isn't running, trigger start now
                // (fixes race condition where integration loads after go-live)
                for (const [streamId, ss] of broadcastState.streams) {
                    if (ss.localStream && !ss.robotStreamer?.active && !ss._rsRestreamStarting && isRsRestreamAssigned(streamId)) {
                        console.log('[RS Sync] Integration loaded while live — triggering RS start for stream', streamId);
                        maybeStartRsRestream(streamId);
                        break;
                    }
                }
            } else if (!rs.enabled) {
                setRobotStreamerStatus('RobotStreamer restream is disabled.', 'info', 'bc-rsLiveStatus');
            } else {
                setRobotStreamerStatus('RobotStreamer needs configuration — validate settings above.', 'info', 'bc-rsLiveStatus');
            }
        }
    }
    updateRsRestreamSlotUI();
}

async function loadRobotStreamerIntegration() {
    const doLoad = async () => {
        try {
            const data = await api('/robotstreamer/integration');
            const integration = data.integration || {};
            broadcastState.robotStreamer = {
                loaded: true,
                enabled: !!integration.enabled,
                mirrorChat: integration.mirror_chat !== false,
                hasToken: !!integration.has_token,
                robotId: integration.robot_id || '',
                ownerId: integration.owner_id || '',
                streamName: integration.stream_name || '',
                ownerName: integration.owner_name || '',
                availableRobots: integration.available_robots || [],
                passthrough: !!integration.passthrough,
            };
            console.log('[Broadcast] RS integration loaded:', { enabled: integration.enabled, hasToken: !!integration.has_token, robotId: integration.robot_id });
            syncRobotStreamerUI();
        } catch (err) {
            broadcastState.robotStreamer.loaded = true; // Mark loaded even on error so we don't block forever
            setRobotStreamerStatus(err.message || 'Failed to load RobotStreamer settings', 'error');
        }
    };
    _robotStreamerIntegrationPromise = doLoad();
    return _robotStreamerIntegrationPromise;
}

function getRobotStreamerFormData() {
    const selectRobot = document.getElementById('bc-rsRobotSelect')?.value || '';
    const inputRobot = document.getElementById('bc-rsRobotInput')?.value.trim() || '';
    return {
        enabled: !!document.getElementById('bc-rsEnabled')?.checked,
        mirror_chat: !!document.getElementById('bc-rsMirrorChat')?.checked,
        token: document.getElementById('bc-rsToken')?.value.trim() || '',
        robot_input: selectRobot || inputRobot,
    };
}

async function validateRobotStreamerIntegration() {
    const payload = getRobotStreamerFormData();
    setRobotStreamerStatus('Validating RobotStreamer settings…', 'info');
    try {
        const data = await api('/robotstreamer/integration/validate', { method: 'POST', body: payload });
        const integration = data.integration || {};
        broadcastState.robotStreamer = {
            ...broadcastState.robotStreamer,
            loaded: true,
            hasToken: !!integration.has_token || !!payload.token,
            robotId: integration.robot_id || payload.robot_input || '',
            ownerId: integration.owner_id || '',
            streamName: integration.stream_name || '',
            ownerName: integration.owner_name || '',
            availableRobots: integration.available_robots || [],
        };
        syncRobotStreamerUI();
        setRobotStreamerStatus(`Validated ${integration.stream_name || `robot ${integration.robot_id}`}.`, 'success');
        toast('RobotStreamer settings validated', 'success');
    } catch (err) {
        setRobotStreamerStatus(err.message || 'RobotStreamer validation failed', 'error');
        toast(err.message || 'RobotStreamer validation failed', 'error');
    }
}

async function saveRobotStreamerIntegration() {
    const payload = getRobotStreamerFormData();
    setRobotStreamerStatus('Saving RobotStreamer settings…', 'info');
    try {
        const data = await api('/robotstreamer/integration', { method: 'PUT', body: payload });
        const integration = data.integration || {};
        broadcastState.robotStreamer = {
            ...broadcastState.robotStreamer,
            loaded: true,
            enabled: !!integration.enabled,
            mirrorChat: integration.mirror_chat !== false,
            hasToken: !!integration.has_token,
            robotId: integration.robot_id || '',
            ownerId: integration.owner_id || '',
            streamName: integration.stream_name || '',
            ownerName: integration.owner_name || '',
            availableRobots: integration.available_robots || broadcastState.robotStreamer.availableRobots || [],
        };
        const tokenEl = document.getElementById('bc-rsToken');
        if (tokenEl) tokenEl.value = '';
        syncRobotStreamerUI();
        setRobotStreamerStatus('RobotStreamer settings saved.', 'success');
        const restreamTargets = [...broadcastState.streams.entries()]
            .filter(([, state]) => state?.localStream)
            .map(([streamId]) => streamId);
        for (const streamId of restreamTargets) {
            if (broadcastState.robotStreamer.enabled && isRsRestreamAssigned(streamId)) {
                stopRobotStreamerRestream(streamId, { quiet: true })
                    .catch(() => {})
                    .finally(() => startRobotStreamerRestream(streamId).catch(() => {}));
            } else {
                stopRobotStreamerRestream(streamId).catch(() => {});
            }
        }
        toast('RobotStreamer settings saved', 'success');
    } catch (err) {
        setRobotStreamerStatus(err.message || 'Failed to save RobotStreamer settings', 'error');
        toast(err.message || 'Failed to save RobotStreamer settings', 'error');
    }
}

/* ── Broadcast Chat Helper ───────────────────────────────────── */
/**
 * Single entry point for broadcast-page chat. Shows the sidebar and
 * ensures a chat WebSocket is connected for the given stream.
 * Idempotent — safe to call multiple times for the same stream.
 */
function ensureBroadcastChat(streamId) {
    const sidebar = document.getElementById('bc-chat-sidebar');
    if (sidebar) sidebar.style.display = '';
    if (typeof initChat === 'function' && streamId) initChat(streamId);
}

/* ── Initialize Broadcast Page ───────────────────────────────── */
async function loadBroadcastPage() {
    loadBroadcastSettings();
    loadRobotStreamerIntegration().catch(() => {});
    loadRestreamDestinations().catch(() => {});
    loadBroadcastControlConfigs().catch(() => {}); // populates configs for other contexts

    // Init workspace (replaces loadBroadcastManagedStreams)
    initBroadcastWorkspace().catch(err => console.warn('[Broadcast] Workspace init failed:', err));

    // If THIS tab has active browser WebRTC streams (localStream exists), restore UI
    if (broadcastState.streams.size > 0 && broadcastState.activeStreamId != null) {
        const ss = getActiveStreamState();
        if (ss && ss.streamData?.protocol === 'webrtc' && ss.localStream) {
            await buildBroadcastTabs(broadcastState.activeStreamId);
            showBrowserBroadcast();
            const preview = document.getElementById('bc-video-preview');
            if (preview) { preview.srcObject = ss.localStream; preview.muted = true; preview.play().catch(() => {}); }
            const ph = document.getElementById('bc-video-placeholder');
            if (ph) ph.style.display = 'none';
            ensureBroadcastChat(ss.streamData.id);
            startGlobalDisplayTimers();
            updateRsRestreamSlotUI();
            startRestreamStatusPolling();
            return;
        }
    }

    // Always show stream manager — never auto-resume WebRTC streams from other tabs/devices
    // (connecting signaling would override the existing broadcaster)
    hideBroadcastTabs();
    showStreamManager();
    loadExistingStreams().catch(() => {});
}

/* ── Stream Manager (Step 0) ─────────────────────────────────── */
function showStreamManager() {
    const ids = ['bc-stream-manager', 'bc-browser-broadcast', 'bc-rtmp-instructions', 'bc-jsmpeg-instructions', 'bc-webrtc-obs-instructions'];
    ids.forEach((id, i) => { const el = document.getElementById(id); if (el) el.style.display = i === 0 ? '' : 'none'; });
    const chat = document.getElementById('bc-chat-sidebar'); if (chat) chat.style.display = 'none';
    const info = document.getElementById('bc-info-bar'); if (info) info.style.display = 'none';
}

/** Pre-fill broadcast form with last-used title/description/category from localStorage */
function _restoreLastBroadcastFields() {
    const titleEl = document.getElementById('bc-title');
    if (titleEl && !titleEl.value) titleEl.value = localStorage.getItem('bc-last-title') || '';
    const descEl = document.getElementById('bc-description');
    if (descEl && !descEl.value) descEl.value = localStorage.getItem('bc-last-description') || '';
    const catEl = document.getElementById('bc-category');
    const lastCat = localStorage.getItem('bc-last-category');
    if (catEl && lastCat) catEl.value = lastCat;
    // Populate username in create reassurance text
    const usernameEl = document.getElementById('bc-create-username');
    if (usernameEl && currentUser?.username) usernameEl.textContent = currentUser.username;
}

async function loadBroadcastManagedStreams() {
    const select = document.getElementById('bc-managed-stream');
    if (!select) return;
    try {
        const data = await api('/streams/managed');
        const managed = data.managed_streams || [];
        select.innerHTML = managed.length
            ? managed.map(ms => `<option value="${ms.id}">${esc(ms.title || 'Untitled')}${ms.slug ? ` (${esc(ms.slug)})` : ''}</option>`).join('')
            : '<option value="">Default stream</option>';
        // Load server-side settings for the initially selected managed stream
        if (managed.length && select.value) {
            loadManagedStreamSettings(parseInt(select.value)).then(() => syncSettingsUI()).catch(() => {});
        }
        // On change, load settings for the newly selected managed stream
        select.addEventListener('change', async () => {
            const msId = select.value ? parseInt(select.value) : null;
            if (msId) {
                await loadManagedStreamSettings(msId);
                syncSettingsUI();
            }
        });
    } catch {
        select.innerHTML = '<option value="">Default stream</option>';
    }
}

/* ── Broadcast Stream Tabs ───────────────────────────────────── */

/**
 * Build/rebuild the broadcast tab bar from the user's active streams.
 * @param {number|null} activeStreamId - Stream to mark active, or null for [+] tab
 * @param {number|null} excludeStreamId - Stream ID to exclude (just-ended, DELETE pending)
 */
async function buildBroadcastTabs(activeStreamId, excludeStreamId = null) {
    // The top per-stream tab bar is redundant with the dedicated "Active Streams"
    // tab, so it's disabled. Kept as a no-op so existing call sites don't break.
    hideBroadcastTabs();
    return;
    /* eslint-disable no-unreachable */
    const bar = document.getElementById('bc-tabs-bar');
    const scroll = document.getElementById('bc-tabs-scroll');
    if (!bar || !scroll) return;

    let liveStreams = [];
    try {
        const data = await api('/streams/mine');
        liveStreams = (data.streams || []).filter(s => s.is_live && s.id !== excludeStreamId);
    } catch {}

    if (liveStreams.length === 0 && !activeStreamId) {
        hideBroadcastTabs();
        return;
    }

    bar.style.display = '';

    // Mark [+] add button active state
    const addBtn = bar.querySelector('.bc-tab-add');
    if (addBtn) addBtn.classList.toggle('active', activeStreamId === null);

    scroll.innerHTML = liveStreams.map(s => {
        const isActive = s.id === activeStreamId;
        const title = esc(s.title || 'Untitled');
        const truncTitle = title.length > 25 ? title.slice(0, 23) + '…' : title;
        // Show a broadcasting indicator if this stream has active media state
        const hasBrowserState = broadcastState.streams.has(s.id) && broadcastState.streams.get(s.id).localStream;
        const dotClass = hasBrowserState ? 'bc-tab-dot bc-tab-dot-broadcasting' : 'bc-tab-dot';
        const vc = s.viewer_count || 0;
        return `<button class="bc-tab ${isActive ? 'active' : ''}"
                    onclick="switchToStreamTab(${s.id})"
                    data-stream-id="${s.id}" title="${title}">
            <span class="${dotClass}"></span>
            <span>${truncTitle}</span>
            <span class="bc-tab-viewers" data-stream-id="${s.id}"><i class="fa-solid fa-eye"></i> ${vc}</span>
            <span class="bc-tab-close" onclick="event.stopPropagation();endBroadcastTab(${s.id})" title="End stream"><i class="fa-solid fa-xmark"></i></span>
        </button>`;
    }).join('');
}

function hideBroadcastTabs() {
    const bar = document.getElementById('bc-tabs-bar');
    if (bar) bar.style.display = 'none';
}

/**
 * Switch to a live stream's controls view when its tab is clicked.
 */
async function switchToStreamTab(streamId) {
    // Update tab highlight
    const scroll = document.getElementById('bc-tabs-scroll');
    if (scroll) scroll.querySelectorAll('.bc-tab').forEach(t => t.classList.toggle('active', parseInt(t.dataset.streamId) === streamId));
    const addBtn = document.querySelector('.bc-tab-add');
    if (addBtn) addBtn.classList.remove('active');

    // If we have active state for this stream, just switch the preview (no teardown)
    const ss = getStreamState(streamId);
    if (ss && ss.localStream) {
        broadcastState.activeStreamId = streamId;
        showBrowserBroadcast();
        const preview = document.getElementById('bc-video-preview');
        if (preview) { preview.srcObject = ss.localStream; preview.muted = true; preview.play().catch(() => {}); }
        const ph = document.getElementById('bc-video-placeholder');
        if (ph) ph.style.display = 'none';
        startGlobalDisplayTimers();
        updateBroadcastStatusFromConnections(streamId);
        ensureBroadcastChat(streamId);
        if (!ss.robotStreamer?.active) maybeStartRsRestream(streamId);
        updateRsRestreamSlotUI();
        loadLiveControlsStatus(streamId).catch(() => {});
        return;
    }

    // No active state — load stream data and resume
    try {
        const data = await api(`/streams/${streamId}`);
        const stream = data.stream;
        if (!stream || !stream.is_live) {
            toast('Stream is no longer live', 'error');
            await buildBroadcastTabs(null);
            showStreamManager();
            loadExistingStreams();
            return;
        }
        await resumeStreamView(stream);
    } catch (e) {
        toast(e.message || 'Failed to load stream', 'error');
    }
}

/**
 * Show the create-stream form from the [+] button.
 * Keeps tabs visible so user can switch back to active streams.
 */
async function showCreateStreamPanel() {
    // Mark [+] as active, deactivate stream tabs
    const scroll = document.getElementById('bc-tabs-scroll');
    if (scroll) scroll.querySelectorAll('.bc-tab').forEach(t => t.classList.remove('active'));
    const addBtn = document.querySelector('.bc-tab-add');
    if (addBtn) addBtn.classList.add('active');

    // Don't tear down active browser streams — just hide the panels
    const ids = ['bc-browser-broadcast', 'bc-rtmp-instructions', 'bc-jsmpeg-instructions', 'bc-webrtc-obs-instructions'];
    ids.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
    const chat = document.getElementById('bc-chat-sidebar'); if (chat) chat.style.display = 'none';
    const info = document.getElementById('bc-info-bar'); if (info) info.style.display = 'none';

    // Show just the create section (hide existing streams panel since tabs replace it)
    const mgr = document.getElementById('bc-stream-manager');
    if (mgr) mgr.style.display = '';
    const existingEl = document.getElementById('bc-existing-streams');
    if (existingEl) existingEl.style.display = 'none';
    const createEl = document.getElementById('bc-create-section');
    if (createEl) createEl.style.display = '';

    // Restore last-used form fields from localStorage
    _restoreLastBroadcastFields();

    // Refresh control config selector so keyboard/HOLD profiles are always current
    loadBroadcastControlConfigs().catch(() => {});

    // Populate device selectors for the create form
    await populateCreateFormDevices();
}

/**
 * End a stream directly from its tab's close button (×).
 */
async function endBroadcastTab(streamId) {
    if (!confirm('End this stream?')) return;
    try {
        // Detach VOD state and clean up immediately — VOD finalize + DELETE happen in background
        const ss = getStreamState(streamId);
        let bgCtx = null;
        if (ss) {
            bgCtx = _detachVodForBackground(streamId);
            cleanupStream(streamId);
        }
        toast('Stream ended', 'info');
        _backgroundStreamEnd(streamId, bgCtx);

        // Rebuild tabs (exclude stopped stream — DELETE hasn't fired yet)
        const data = await api('/streams/mine');
        const remaining = (data.streams || []).filter(s => s.is_live && s.id !== streamId);
        if (remaining.length > 0) {
            // Keep tabs visible but return user to the create panel.
            // Do NOT auto-switch into another live stream — let the user click its tab explicitly.
            await buildBroadcastTabs(null, streamId);
            await showCreateStreamPanel();
        } else {
            hideBroadcastTabs();
            clearGlobalDisplayTimers();
            setNavLiveIndicator(false);
            showStreamManager();
            loadExistingStreams(streamId);
            // Scroll create section into view so user lands on "Create New Stream"
            const createSec = document.getElementById('bc-create-section');
            if (createSec) createSec.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    } catch (e) {
        toast(e.message || 'Failed to end stream', 'error');
        // Fallback — stream was already cleaned up, make sure UI recovers
        showStreamManager();
        loadExistingStreams(streamId);
    }
}

/**
 * Switch to a stream — if we have active state, just swap preview; otherwise resume fully.
 */
async function switchOrResumeStream(stream) {
    const ss = getStreamState(stream.id);
    if (ss && ss.localStream) {
        broadcastState.activeStreamId = stream.id;
        showBrowserBroadcast();
        const preview = document.getElementById('bc-video-preview');
        if (preview) { preview.srcObject = ss.localStream; preview.muted = true; preview.play().catch(() => {}); }
        const ph = document.getElementById('bc-video-placeholder');
        if (ph) ph.style.display = 'none';
        startGlobalDisplayTimers();
        updateBroadcastStatusFromConnections(stream.id);
        ensureBroadcastChat(stream.id);
        if (!ss.robotStreamer?.active) maybeStartRsRestream(stream.id);
    } else {
        await resumeStreamView(stream);
    }
}

/**
 * Show the appropriate UI for a stream without re-creating the stream session.
 * Called when switching tabs or loading the page with active streams.
 */
async function resumeStreamView(stream) {
    // Hide all panels first
    const ids = ['bc-stream-manager', 'bc-browser-broadcast', 'bc-rtmp-instructions', 'bc-jsmpeg-instructions', 'bc-webrtc-obs-instructions'];
    ids.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });

    // Fetch and sync call mode from server
    try {
        const callData = await api(`/streams/${stream.id}/call`);
        _broadcastCallMode = callData.call_mode || null;
    } catch { _broadcastCallMode = null; }

    if (stream.protocol === 'webrtc') {
        // Check if we already have active state for this stream
        const existing = getStreamState(stream.id);
        if (existing && existing.localStream) {
            // Already broadcasting — just switch preview
            broadcastState.activeStreamId = stream.id;
            showBrowserBroadcast();
            const preview = document.getElementById('bc-video-preview');
            if (preview) { preview.srcObject = existing.localStream; preview.muted = true; preview.play().catch(() => {}); }
            const ph = document.getElementById('bc-video-placeholder');
            if (ph) ph.style.display = 'none';
            ensureBroadcastChat(stream.id);
            startGlobalDisplayTimers();
            if (!existing.robotStreamer?.active) maybeStartRsRestream(stream.id);
            showBroadcastCallControls(); updateBroadcastCallUI();
            updateRsRestreamSlotUI();
            loadLiveControlsStatus(stream.id).catch(() => {});
            return;
        }
        // Not yet broadcasting — create per-stream state and start capture
        const ss = createStreamState(stream);
        ss.startedAt = stream.started_at || new Date().toISOString();
        broadcastState.streams.set(stream.id, ss);
        broadcastState.activeStreamId = stream.id;
        setNavLiveIndicator(true);
        updateWorkspaceLiveStatus();
        showBrowserBroadcast();
        populateDeviceLists(); populateTTSVoices(); syncSettingsUI();
        ensureBroadcastChat(stream.id);
        if (typeof refreshChatTTSContext === 'function') refreshChatTTSContext();
        startHeartbeat(stream.id);
        await startMediaCapture(stream.id); connectSignaling(stream.id); maybeStartRsRestream(stream.id); startVodRecording(stream.id);
        startGlobalDisplayTimers();
        acquireWakeLock();
        showBroadcastCallControls(); updateBroadcastCallUI();
        updateRsRestreamSlotUI();
        loadLiveControlsStatus(stream.id).catch(() => {});
        startRestreamStatusPolling();
    } else if (stream.protocol === 'rtmp') {
        const ss = createStreamState(stream);
        ss.startedAt = stream.started_at || new Date().toISOString();
        broadcastState.streams.set(stream.id, ss);
        broadcastState.activeStreamId = stream.id;
        setNavLiveIndicator(true);
        updateWorkspaceLiveStatus();
        showRTMPInstructions(stream);
        startHeartbeat(stream.id);
        startGlobalDisplayTimers();
        ensureBroadcastChat(stream.id);
        if (typeof refreshChatTTSContext === 'function') refreshChatTTSContext();
        showBroadcastCallControls(); updateBroadcastCallUI();
        startRestreamStatusPolling();
    } else if (stream.protocol === 'jsmpeg') {
        const ss = createStreamState(stream);
        ss.startedAt = stream.started_at || new Date().toISOString();
        broadcastState.streams.set(stream.id, ss);
        broadcastState.activeStreamId = stream.id;
        setNavLiveIndicator(true);
        updateWorkspaceLiveStatus();
        showJSMPEGInstructions(stream);
        startHeartbeat(stream.id);
        startGlobalDisplayTimers();
        ensureBroadcastChat(stream.id);
        if (typeof refreshChatTTSContext === 'function') refreshChatTTSContext();
        showBroadcastCallControls(); updateBroadcastCallUI();
        startRestreamStatusPolling();
    }
}

async function loadExistingStreams(excludeStreamId) {
    const activeListEl = document.getElementById('bc-active-list');
    if (!activeListEl) return;
    
    try {
        // Use the /mine endpoint to get all user's streams
        const data = await api('/streams/mine');
        // Exclude the just-ended stream (background DELETE may not have fired yet)
        const all = (data.streams || []).filter(s => !excludeStreamId || s.id !== excludeStreamId);
        
        // Only show ACTIVE streams in the top section
        const live = all.filter(s => s.is_live);
        activeListEl.innerHTML = live.map(s => renderStreamItem(s)).join('');
        _updateBroadcastTopTabs(live.length, live);
    } catch (err) {
        console.error('[Broadcast] Failed to load active streams:', err);
        _updateBroadcastTopTabs(0);
    }
}

/** Switch the top-level Go Live tab ('active' | 'mine'). */
function switchBroadcastTopTab(tab) {
    window._bcTopTab = tab;
    document.querySelectorAll('.bc-top-tab').forEach(b => b.classList.toggle('active', b.dataset.bctab === tab));
    document.querySelectorAll('.bc-top-tab-panel').forEach(p => p.classList.toggle('active', p.dataset.bctabpanel === tab));
}

/**
 * Show/hide the "Active Streams" tab based on whether any stream is live.
 * With no live streams the tab bar hides and only "My Streams" shows; the page
 * defaults to "My Streams" so slot config is front-and-center.
 */
function _updateBroadcastTopTabs(activeCount, liveStreams = []) {
    const count = Number(activeCount) || 0;
    const hasActive = count > 0;
    const bar = document.getElementById('bc-top-tabs');
    const activeBtn = document.querySelector('.bc-top-tab[data-bctab="active"]');
    const badge = document.getElementById('bc-active-count');
    if (bar) bar.style.display = hasActive ? 'flex' : 'none';
    if (activeBtn) activeBtn.style.display = hasActive ? '' : 'none';
    if (badge) {
        badge.textContent = count;
        badge.style.display = hasActive ? '' : 'none';
    }
    if (!hasActive) {
        switchBroadcastTopTab('mine');       // no active streams → always My Streams
        try { localStorage.removeItem('openvibe-device-active-stream'); } catch { /* */ }
    } else if (!window._bcTopTab) {
        // If THIS device started one of the currently-live streams, open Active
        // Streams so they can resume it (e.g. after a refresh/reboot). Otherwise My Streams.
        let deviceStarted = false;
        try {
            const tok = JSON.parse(localStorage.getItem('openvibe-device-active-stream') || 'null');
            const liveIds = new Set((liveStreams || []).map(s => s.id));
            deviceStarted = !!(tok && liveIds.has(tok.stream_id));
            if (tok && !deviceStarted) localStorage.removeItem('openvibe-device-active-stream'); // stale token
        } catch { /* */ }
        switchBroadcastTopTab(deviceStarted ? 'active' : 'mine');
    }
}

function renderStreamItem(s) {
    const badge = s.is_live ? '<span class="badge badge-live">LIVE</span>' : '<span class="badge badge-offline">Ended</span>';
    const time = s.started_at ? new Date(s.started_at.replace(' ', 'T') + 'Z').toLocaleString() : '';
    const duration = s.duration_seconds ? formatDuration(s.duration_seconds) : '';
    const hasBrowserState = broadcastState.streams.has(s.id);
    const resumeLabel = hasBrowserState ? 'Continue' : 'Resume';
    return `<div class="bc-stream-item ${s.is_live ? 'bc-stream-live' : ''}">
        <div class="bc-stream-info">
            <strong>${esc(s.title || 'Untitled')}</strong>
            <span class="muted">${(s.protocol || 'webrtc').toUpperCase()} · ${time}${duration ? ' · ' + duration : ''}${s.viewer_count ? ' · ' + s.viewer_count + ' viewer' + (s.viewer_count === 1 ? '' : 's') : ''}</span>
        </div>
        <div class="bc-stream-actions">
            ${s.is_live ? `<button class="btn btn-small btn-primary" onclick="resumeStream(${s.id})"><i class="fa-solid fa-play"></i> ${resumeLabel}</button> <button class="btn btn-small btn-danger" onclick="endExistingStream(${s.id})"><i class="fa-solid fa-stop"></i> End</button>` : ''}
            ${badge}
        </div>
    </div>`;
}

async function resumeStream(streamId) {
    try {
        const data = await api(`/streams/${streamId}`);
        const stream = data.stream;
        if (!stream || !stream.is_live) { toast('Stream is no longer live', 'error'); return loadExistingStreams(); }

        // Build tabs and activate this stream
        await buildBroadcastTabs(stream.id);
        await resumeStreamView(stream);
    } catch (e) { toast(e.message || 'Failed to resume stream', 'error'); }
}

async function endExistingStream(streamId) {
    try {
        const ss = getStreamState(streamId);
        let bgCtx = null;
        if (ss) {
            bgCtx = _detachVodForBackground(streamId);
            cleanupStream(streamId);
        }
        _backgroundStreamEnd(streamId, bgCtx);
        toast('Stream ended', 'info');

        // Stay on stream manager — just refresh tabs and stream list
        const data = await api('/streams/mine');
        const remaining = (data.streams || []).filter(s => s.is_live && s.id !== streamId);
        if (remaining.length > 0) {
            await buildBroadcastTabs(null, streamId);
        } else {
            hideBroadcastTabs();
            clearGlobalDisplayTimers();
            if (!isStreaming()) setNavLiveIndicator(false);
        }
        loadExistingStreams(streamId);
    } catch (e) {
        toast(e.message || 'Failed to end stream', 'error');
        loadExistingStreams(streamId);
    }
}

/* ── Method Selection ────────────────────────────────────────── */
const _methodExplainers = {
    browser: '<strong>Browser</strong> lets you stream directly from this browser tab using your camera, microphone, or screen — no extra software needed. Just click Create Stream and you\'re live.',
    whip: '<strong>WHIP</strong> sends video from OBS Studio (or any WHIP-compatible encoder) to our server via WebRTC. After creating the stream, you\'ll get a <strong>WHIP URL</strong> and <strong>Bearer Token</strong> to paste into OBS.',
    rtmp: '<strong>RTMP</strong> sends video from a dedicated streaming app (OBS Studio, Streamlabs, IRL Pro, etc.) to our server. After creating the stream, you\'ll get a <strong>Server URL</strong> and <strong>Stream Key</strong> to paste into your app. This gives you the best video quality and most customization.',
    cli: '<strong>CLI / FFmpeg</strong> uses a single FFmpeg command in your terminal to send video. It\'s the most lightweight method — ideal for Raspberry Pi, security cameras, headless Linux servers, and 24/7 unattended streams. After creating the stream, you\'ll get a ready-to-paste terminal command.',
    // Legacy aliases
    webrtc: '<strong>WebRTC</strong> lets you stream directly from this browser tab using your camera, microphone, or screen — no extra software needed.',
    jsmpeg: '<strong>JSMPEG</strong> uses a single FFmpeg command in your terminal to send video.',
};
function selectStreamMethod(method) {
    broadcastState.selectedMethod = method;
    document.querySelectorAll('.bc-method-card').forEach(el => el.classList.toggle('selected', el.dataset.method === method));
    const sub = document.getElementById('bc-webrtc-sub');
    if (sub) sub.style.display = (method === 'browser' || method === 'webrtc') ? 'block' : 'none';
    // Update method explainer text
    const explainer = document.getElementById('bc-method-explainer-text');
    if (explainer && _methodExplainers[method]) explainer.innerHTML = _methodExplainers[method];
    // Update step 3 header based on method
    _syncStep3Header(method);
    _syncBrowserSourceUI();
}
/** Update the step 3 header text/visibility based on the selected method */
function _syncStep3Header(method) {
    const hdr = document.getElementById('bc-step3-header');
    if (!hdr) return;
    const textEl = hdr.querySelector('.bc-step-text span');
    if (!textEl) return;
    if (method === 'browser' || method === 'webrtc') {
        hdr.style.display = '';
        textEl.textContent = 'Set up your camera, mic, or screen share';
    } else if (method === 'whip') {
        hdr.style.display = 'none';
    } else if (method === 'rtmp') {
        hdr.style.display = 'none';
    } else if (method === 'cli' || method === 'jsmpeg') {
        hdr.style.display = 'none';
    }
}
function selectWebRTCSub(sub) {
    broadcastState.selectedWebRTCSub = sub;
    document.querySelectorAll('[data-sub]').forEach(el => el.classList.toggle('selected', el.dataset.sub === sub));
    _syncBrowserSourceUI();
}
function selectBrowserSource(src) {
    broadcastState.selectedBrowserSource = src;
    document.querySelectorAll('[data-bsrc]').forEach(el => el.classList.toggle('selected', el.dataset.bsrc === src));
    _syncBrowserSourceUI();
}
/** Select screen capture source type from the visual picker buttons */
function selectScreenCaptureSource(source) {
    updateBroadcastSetting('screenCaptureSource', source);
    // Update visual picker buttons
    document.querySelectorAll('#bc-source-picker .bc-source-btn').forEach(btn => {
        btn.classList.toggle('selected', btn.dataset.source === source);
    });
    // Also sync the settings panel dropdown + create-form dropdown
    const settingsEl = document.getElementById('bc-screenCaptureSource');
    if (settingsEl) settingsEl.value = source;
    const createEl = document.getElementById('bc-screenCaptureSource-create');
    if (createEl) createEl.value = source;
}
/** Sync screen share capture option dropdowns in the create form to match settings */
function _syncScreenShareCreateOptions() {
    const s = broadcastState.settings;
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    const setCheck = (id, v) => { const el = document.getElementById(id); if (el) el.checked = v; };
    // Sync picker buttons
    document.querySelectorAll('#bc-source-picker .bc-source-btn').forEach(btn => {
        btn.classList.toggle('selected', btn.dataset.source === (s.screenCaptureSource || 'auto'));
    });
    setVal('bc-screenSystemAudio-create', s.screenSystemAudio || 'include');
    setVal('bc-screenSelfBrowser-create', s.screenSelfBrowser || 'exclude');
    setVal('bc-screenSurfaceSwitching-create', s.screenSurfaceSwitching || 'include');
    setCheck('bc-screenPreferCurrentTab-create', s.screenPreferCurrentTab || false);
}
/** Show/hide the correct device pickers based on current method/sub/source selection */
function _syncBrowserSourceUI() {
    const isBrowser = broadcastState.selectedMethod === 'webrtc' && broadcastState.selectedWebRTCSub === 'browser';
    const srcChoice = document.getElementById('bc-browser-source-choice');
    const camDevices = document.getElementById('bc-create-devices');
    const screenSetup = document.getElementById('bc-screen-share-setup');
    if (srcChoice) srcChoice.style.display = isBrowser ? 'block' : 'none';
    if (camDevices) camDevices.style.display = (isBrowser && broadcastState.selectedBrowserSource === 'camera') ? 'block' : 'none';
    if (screenSetup) {
        screenSetup.style.display = (isBrowser && broadcastState.selectedBrowserSource === 'screen') ? 'block' : 'none';
        if (isBrowser && broadcastState.selectedBrowserSource === 'screen') _syncScreenShareCreateOptions();
    }
}

/* ── Load Control Config Selector ─────────────────────────────── */
async function loadBroadcastControlConfigs() {
    const selector = document.getElementById('bc-config-selector');
    const select = document.getElementById('bc-control-config');
    const downloadBtn = document.getElementById('bc-download-bridge-btn');
    if (!selector || !select) return;

    try {
        const data = await api('/controls/configs');
        const configs = data.configs || [];
        if (!configs.length) {
            selector.style.display = 'none';
            return;
        }
        selector.style.display = '';

        // Get active config
        const settings = await api('/controls/settings/channel').catch(() => ({}));
        const activeId = settings.active_control_config_id;

        select.innerHTML = '<option value="">None (no controls)</option>' +
            configs.map(c => `<option value="${c.id}" ${c.id === activeId ? 'selected' : ''}>${esc(c.name)} (${c.button_count} buttons)</option>`).join('');

        // Show/hide script download button based on selection
        const updateBtn = () => {
            if (downloadBtn) downloadBtn.style.display = select.value ? '' : 'none';
        };
        select.addEventListener('change', updateBtn);
        updateBtn();
    } catch {
        if (selector) selector.style.display = 'none';
    }
}

/* ── Create New Stream ───────────────────────────────────────── */
async function createNewStream() {
    const title = document.getElementById('bc-title')?.value.trim();
    const description = document.getElementById('bc-description')?.value.trim() || '';
    const category = document.getElementById('bc-category')?.value || '';
    const method = broadcastState.selectedMethod;
    if (!title) return toast('Stream title is required', 'error');

    const isBrowserStream = method === 'webrtc' && broadcastState.selectedWebRTCSub === 'browser';
    const isScreenMode = isBrowserStream && broadcastState.selectedBrowserSource === 'screen';

    // Auto-request camera/mic permissions if user hasn't clicked "Allow Camera & Mic" yet (camera mode only)
    if (isBrowserStream && !isScreenMode) {
        const permReq = document.getElementById('bc-perm-request');
        if (permReq && permReq.style.display !== 'none') {
            await requestMediaPermissions();
            // If permissions failed, bc-perm-request will still be visible — abort
            if (permReq.style.display !== 'none') {
                return; // requestMediaPermissions() already showed the error toast
            }
        }
    }

    // Persist last-used values so they pre-fill next time
    localStorage.setItem('bc-last-title', title);
    localStorage.setItem('bc-last-description', description);
    localStorage.setItem('bc-last-category', category);

    // Restore existing-streams panel visibility for next time
    const existingEl = document.getElementById('bc-existing-streams');
    if (existingEl) existingEl.style.display = '';

    // Read device selection from create form (camera mode) and sync to broadcastState
    const createCamera = document.getElementById('bc-create-camera')?.value || 'default';
    const createAudio = document.getElementById('bc-create-audio')?.value || 'default';
    _syncCameraSelectionUI(createCamera);
    _syncAudioSelectionUI(createAudio);

    // Read screen share device selections.
    //
    // These four IDs never existed. The screen-share panel is rendered by
    // broadcast-workspace.js as bc-ws-screen-mic / -mic-select / -cam / -cam-select, and the
    // old bc-screen-* names were left behind here when that panel was rewritten. Every lookup
    // therefore returned null, and the `?? true` / `|| 'default'` defaults quietly papered
    // over it:
    //   - the chosen microphone was discarded and capture always fell back to the system
    //     default device, which is why viewers heard nothing whenever the OS default was not
    //     the mic the streamer picked, and why the UI kept reporting "Default";
    //   - screenCamEnabled defaulted to FALSE, so the camera overlay never ran at all.
    // The workspace's own sync helpers wrote into the same dead ids (_wsPopulateInlineDevices
    // ('bc-screen-audio', ...)), so nothing surfaced the breakage.
    //
    // Read the real controls, keeping the legacy ids as a fallback so any other host page
    // that still renders them keeps working.
    const _el = (...ids) => ids.map(id => document.getElementById(id)).find(Boolean) || null;
    const micToggleEl = _el('bc-ws-screen-mic', 'bc-screen-mic-enabled');
    const camToggleEl = _el('bc-ws-screen-cam', 'bc-screen-cam-enabled');
    const screenMicEnabled = micToggleEl ? !!micToggleEl.checked : true;
    const screenCamEnabled = camToggleEl ? !!camToggleEl.checked : false;
    const screenAudio = _el('bc-ws-screen-mic-select', 'bc-screen-audio')?.value || 'default';
    const screenCamera = _el('bc-ws-screen-cam-select', 'bc-screen-camera')?.value || 'default';
    console.log('[Broadcast] Screen-share devices — mic:', screenMicEnabled ? screenAudio : 'off',
                '| camera:', screenCamEnabled ? screenCamera : 'off');

    let _diagStreamId = null; // captured in catch for diagnostic logging
    try {
        const selectedConfig = document.getElementById('bc-control-config')?.value;
        const controlConfigId = selectedConfig ? parseInt(selectedConfig) : null;
        const selectedManagedStream = document.getElementById('bc-managed-stream')?.value;
        const managedStreamId = selectedManagedStream ? parseInt(selectedManagedStream) : null;
        const data = await api('/streams', {
            method: 'POST',
            body: {
                title,
                description,
                protocol: method,
                category,
                is_nsfw: document.getElementById('bc-nsfw')?.checked || false,
                control_config_id: controlConfigId,
                managed_stream_id: managedStreamId,
            }
        });
        const streamData = data.stream || data;
        _diagStreamId = streamData?.id;

        // Create per-stream state
        const ss = createStreamState(streamData);
        ss.startedAt = new Date().toISOString();
        broadcastState.streams.set(streamData.id, ss);
        broadcastState.activeStreamId = streamData.id;
        // Remember that THIS device started this session, so after a refresh/reboot
        // the broadcast page can open the Active Streams tab to resume it.
        try {
            localStorage.setItem('openvibe-device-active-stream', JSON.stringify({
                stream_id: streamData.id, managed_stream_id: streamData.managed_stream_id || null, ts: Date.now(),
            }));
        } catch { /* */ }
        setNavLiveIndicator(true);
        updateWorkspaceLiveStatus();

        // Init call controls (disabled by default, streamer enables after going live)
        _broadcastCallMode = null;

        // Build/refresh tabs with new stream active
        await buildBroadcastTabs(streamData.id);

        if (isBrowserStream) {
            // Set screen share mode before media capture
            if (isScreenMode) {
                broadcastState.settings.screenShare = true;
                ss._cameraOverlayEnabled = screenCamEnabled;
                saveBroadcastSettings();
            } else {
                broadcastState.settings.screenShare = false;
                saveBroadcastSettings();
            }

            showBrowserBroadcast(); populateDeviceLists(); populateTTSVoices(); syncSettingsUI();
            _syncScreenShareUI();
            ensureBroadcastChat(streamData.id);
            loadLiveControlsStatus(streamData.id).catch(() => {});

            if (isScreenMode) {
                // Screen share capture options
                const captureOpts = {
                    audioId: screenMicEnabled ? screenAudio : null,
                    cameraId: screenCamEnabled ? screenCamera : null,
                    skipMic: !screenMicEnabled,
                };
                await startMediaCapture(streamData.id, captureOpts);
            } else {
                await startMediaCapture(streamData.id, { cameraId: createCamera, audioId: createAudio });
            }

            connectSignaling(streamData.id);
            maybeStartRsRestream(streamData.id);
            startHeartbeat(streamData.id); startVodRecording(streamData.id);
            startGlobalDisplayTimers();
            acquireWakeLock();
            showBroadcastCallControls(); updateBroadcastCallUI();
            updateRsRestreamSlotUI();
            startRestreamStatusPolling();
            // Show/hide screen share live controls
            _syncScreenShareLiveControls(ss);
            toast('You are now LIVE!', 'success');
        } else if (method === 'webrtc' && broadcastState.selectedWebRTCSub === 'obs') {
            showWHIPInstructions(streamData); startHeartbeat(streamData.id);
            ensureBroadcastChat(streamData.id);
            showBroadcastCallControls(); updateBroadcastCallUI();
            startRestreamStatusPolling();
            toast('Stream created — configure OBS with the details below', 'success');
        } else if (method === 'rtmp') {
            showRTMPInstructions(streamData); startHeartbeat(streamData.id);
            ensureBroadcastChat(streamData.id);
            showBroadcastCallControls(); updateBroadcastCallUI();
            startRestreamStatusPolling();
            toast('Stream created — configure your streaming software', 'success');
        } else if (method === 'jsmpeg') {
            showJSMPEGInstructions(streamData); startHeartbeat(streamData.id);
            ensureBroadcastChat(streamData.id);
            showBroadcastCallControls(); updateBroadcastCallUI();
            startRestreamStatusPolling();
            toast('Stream created — start FFmpeg with the command below', 'success');
        }
    } catch (e) {
        toast(e.message || 'Failed to create stream', 'error');
        // Diagnostic: log the error to server so we can see it in logs
        fetch('/api/streams/diag-log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
            body: JSON.stringify({
                stream_id: _diagStreamId,
                error_name: e?.name,
                error_message: e?.message,
                method: broadcastState?.selectedMethod,
                sub: broadcastState?.selectedWebRTCSub,
                browser_source: broadcastState?.selectedBrowserSource,
                ua: navigator.userAgent,
            }),
        }).catch(() => {});
        // Clean up the orphaned stream state and server record if stream was created
        if (_diagStreamId) {
            cleanupStream(_diagStreamId);
            api(`/streams/${_diagStreamId}`, { method: 'DELETE' }).catch(() => {});
        }
    }
}

/* ── Show Method-Specific Panels ─────────────────────────────── */
function showBrowserBroadcast() {
    document.getElementById('bc-stream-manager').style.display = 'none';
    document.getElementById('bc-browser-broadcast').style.display = '';
    document.getElementById('bc-rtmp-instructions').style.display = 'none';
    document.getElementById('bc-jsmpeg-instructions').style.display = 'none';
    document.getElementById('bc-webrtc-obs-instructions').style.display = 'none';
    document.getElementById('bc-chat-sidebar').style.display = '';
    const lb = document.getElementById('bc-live-badge'); if (lb) lb.style.display = '';
    const ib = document.getElementById('bc-info-bar'); if (ib) ib.style.display = '';
    _startRsViewerPoll();
    _startRestreamViewerPoll();
    syncBroadcastLiveButtonVisibility();
}

let _rtmpStatusPollTimer = null;

/* ── Controls Status + Live Profile Switcher ────────────────── */
/**
 * Load control profile status and populate the live profile selector
 * for all visible streaming method panels (RTMP, JSMPEG, WHIP, browser).
 * Determines the bound profile from stream-level first, channel default second.
 */
async function loadLiveControlsStatus(streamId) {
    // Status label elements (non-browser streaming panels)
    const statusEls = ['bc-rtmp-controls-status', 'bc-jsmpeg-controls-status', 'bc-whip-controls-status', 'bc-browser-controls-status']
        .map(id => document.getElementById(id)).filter(Boolean);

    // Profile selector elements (non-browser + browser panels)
    const selectorIds = ['bc-rtmp-live-config-select', 'bc-jsmpeg-live-config-select', 'bc-whip-live-config-select', 'bc-live-config-select'];

    try {
        const [settings, cdata, streamConfig] = await Promise.all([
            api('/controls/settings/channel').catch(() => ({})),
            api('/controls/configs').catch(() => ({})),
            streamId ? api(`/controls/${streamId}/config`).catch(() => ({ control_config_id: null })) : Promise.resolve({ control_config_id: null }),
        ]);

        const configs = cdata.configs || [];

        // Stream-level config takes precedence; fall back to channel default
        let configId = streamConfig?.control_config_id || null;
        if (!configId) {
            configId = settings.active_control_config_id || null;
        }

        // Populate all profile selectors with available configs
        const optionsHtml = '<option value="">None (no controls)</option>' +
            configs.map(c => `<option value="${c.id}">${esc(c.name)} (${c.button_count} btn)</option>`).join('');
        for (const selId of selectorIds) {
            const sel = document.getElementById(selId);
            if (!sel) continue;
            sel.innerHTML = optionsHtml;
            sel.value = configId ? String(configId) : '';
        }

        // Render status label
        if (!configId) {
            const html = '<p class="muted" style="font-size:0.85rem">No control profile active. Select one above and click Apply.</p>';
            statusEls.forEach(el => el.innerHTML = html);
            return;
        }
        const config = configs.find(c => c.id === configId);
        const name = config ? esc(config.name) : `Profile #${configId}`;
        const count = config ? config.button_count : '?';
        const plural = count === 1 ? 'button' : 'buttons';
        const keyboardCount = config ? (config.keyboard_count ?? '?') : '?';
        const html = `<div style="display:flex;align-items:center;gap:8px;padding:4px 0">
            <i class="fa-solid fa-circle" style="color:#4caf50;font-size:10px;flex-shrink:0"></i>
            <span><strong>${name}</strong> — ${count} ${plural} active for viewers</span>
        </div>`;
        statusEls.forEach(el => el.innerHTML = html);
    } catch {
        const html = '<p class="muted" style="font-size:0.85rem">Could not load control profile status.</p>';
        statusEls.forEach(el => el.innerHTML = html);
    }
}

/**
 * Apply the selected live control profile to the currently active stream.
 * Called from "Apply" buttons in all streaming method panels.
 * Uses whichever profile selector is currently visible/filled.
 */
async function applyLiveControlProfile() {
    const streamId = broadcastState.activeStreamId;
    if (!streamId) {
        toast('No active stream to apply profile to', 'error');
        return;
    }

    // Find the first populated selector that has a value
    const selectorIds = ['bc-live-config-select', 'bc-rtmp-live-config-select', 'bc-jsmpeg-live-config-select', 'bc-whip-live-config-select'];
    let selectedConfigId = null;
    for (const id of selectorIds) {
        const el = document.getElementById(id);
        if (el && el.value !== undefined && el.offsetParent !== null) {
            // Use the first visible selector's value
            selectedConfigId = el.value ? parseInt(el.value) : null;
            break;
        }
    }
    // Fallback: check all selectors for any non-empty value
    if (selectedConfigId === undefined) {
        for (const id of selectorIds) {
            const el = document.getElementById(id);
            if (el && el.value) { selectedConfigId = parseInt(el.value); break; }
        }
    }

    try {
        await api(`/controls/${streamId}/config`, {
            method: 'PUT',
            body: { control_config_id: selectedConfigId !== undefined ? selectedConfigId : null },
        });
        toast('Control profile applied — viewers will see the new buttons immediately', 'success');
        // Refresh status display
        await loadLiveControlsStatus(streamId);
    } catch (err) {
        toast(err.message || 'Failed to apply control profile', 'error');
    }
}


async function showRTMPInstructions(stream) {
    document.getElementById('bc-stream-manager').style.display = 'none';
    document.getElementById('bc-browser-broadcast').style.display = 'none';
    document.getElementById('bc-rtmp-instructions').style.display = '';
    document.getElementById('bc-jsmpeg-instructions').style.display = 'none';
    document.getElementById('bc-webrtc-obs-instructions').style.display = 'none';
    document.getElementById('bc-chat-sidebar').style.display = '';
    const ib = document.getElementById('bc-info-bar'); if (ib) ib.style.display = '';
    _startRsViewerPoll();
    _startRestreamViewerPoll();
    syncBroadcastLiveButtonVisibility();
    loadLiveControlsStatus(stream.id).catch(() => {});
    try {
        const data = await api(`/streams/${stream.id}/endpoint`);
        const ep = data.endpoint || {};
        const rtmpUrl = ep.rtmpUrl || `rtmp://${location.hostname}:1935/live`;
        const streamKey = ep.streamKey || data.stream_key || 'N/A';
        document.getElementById('bc-rtmp-url').textContent = rtmpUrl;
        document.getElementById('bc-rtmp-key').textContent = streamKey;
        // Mirror into IRL Pro guide fields
        const irlUrl = document.getElementById('bc-irlpro-url');
        const irlKey = document.getElementById('bc-irlpro-key');
        const irlCombined = document.getElementById('bc-irlpro-combined');
        if (irlUrl) irlUrl.textContent = rtmpUrl;
        if (irlKey) irlKey.textContent = streamKey;
        if (irlCombined) irlCombined.textContent = `${rtmpUrl}/${streamKey}`;
        // Populate FFmpeg CLI commands
        const fullUrl = `${rtmpUrl}/${streamKey}`;
        const camEl = document.getElementById('bc-rtmp-ffmpeg-cam');
        if (camEl) camEl.textContent = `ffmpeg -f v4l2 -i /dev/video0 -f alsa -i default -c:v libx264 -preset veryfast -tune zerolatency -b:v 2500k -maxrate 2500k -bufsize 5000k -g 60 -c:a aac -b:a 128k -ar 44100 -f flv ${fullUrl}`;
        const screenEl = document.getElementById('bc-rtmp-ffmpeg-screen');
        if (screenEl) screenEl.textContent = `ffmpeg -f x11grab -s 1920x1080 -r 30 -i :0.0 -f pulse -i default -c:v libx264 -preset veryfast -tune zerolatency -b:v 3000k -g 60 -c:a aac -b:a 128k -ar 44100 -f flv ${fullUrl}`;
        const printerEl = document.getElementById('bc-rtmp-ffmpeg-printer');
        if (printerEl) printerEl.textContent = `ffmpeg -f v4l2 -framerate 10 -video_size 1280x720 -i /dev/video0 -c:v libx264 -preset ultrafast -b:v 500k -maxrate 600k -bufsize 1200k -g 100 -an -f flv ${fullUrl}`;
    } catch {
        document.getElementById('bc-rtmp-url').textContent = `rtmp://${location.hostname}:1935/live`;
        document.getElementById('bc-rtmp-key').textContent = 'Error loading key';
    }
    // Start polling RTMP feed status
    startRtmpStatusPoll(stream.id);
}

function startRtmpStatusPoll(streamId) {
    stopRtmpStatusPoll();
    setRtmpStatusUI(false);
    const poll = async () => {
        try {
            const data = await api(`/streams/${streamId}/rtmp-status`);
            setRtmpStatusUI(data.receiving, data.connected_at);
        } catch { /* ignore */ }
    };
    poll();
    _rtmpStatusPollTimer = setInterval(poll, 3000);
}

function stopRtmpStatusPoll() {
    if (_rtmpStatusPollTimer) { clearInterval(_rtmpStatusPollTimer); _rtmpStatusPollTimer = null; }
}

function setRtmpStatusUI(receiving, connectedAt) {
    const wrap = document.getElementById('bc-rtmp-status');
    if (!wrap) return;
    const spinner = document.getElementById('bc-rtmp-status-spinner');
    const ok = document.getElementById('bc-rtmp-status-ok');
    const label = document.getElementById('bc-rtmp-status-label');
    const detail = document.getElementById('bc-rtmp-status-detail');
    if (receiving) {
        wrap.className = 'bc-rtmp-status receiving';
        spinner.style.display = 'none';
        ok.style.display = '';
        label.textContent = 'Receiving RTMP feed';
        if (connectedAt) {
            const secs = Math.floor((Date.now() - new Date(connectedAt).getTime()) / 1000);
            const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
            const dur = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
            detail.textContent = `Connected for ${dur}`;
        } else {
            detail.textContent = 'Your stream is live and connected';
        }
        // Start live thumbnail preview for RTMP
        const ss = getActiveStreamState();
        if (ss?.streamData?.id) startRtmpPreview(ss.streamData.id);
    } else {
        wrap.className = 'bc-rtmp-status waiting';
        spinner.style.display = '';
        ok.style.display = 'none';
        label.textContent = 'Waiting for stream...';
        detail.textContent = 'Start streaming in OBS or your app to connect';
        stopRtmpPreview();
    }
}

/* ── Stream Key Regeneration ─────────────────────────────────── */
async function regenerateStreamKey() {
    if (!confirm('Generate a new stream key? Your current key will stop working immediately. You will need to update it in OBS/Streamlabs/etc.')) return;
    try {
        let newKey;
        // Use the managed-stream endpoint if the active stream has a managed_stream_id
        const activeSS = getActiveStreamState();
        const managedId = activeSS?.streamData?.managed_stream_id;
        if (managedId) {
            const data = await api(`/streams/managed/${managedId}/regenerate-key`, { method: 'POST' });
            newKey = data.stream_key;
        } else {
            // Fallback: user-level key (legacy / unmanaged streams)
            const data = await api('/auth/stream-key/regenerate', { method: 'POST' });
            newKey = data.stream_key;
        }
        // Update all visible key displays
        const keyEl = document.getElementById('bc-rtmp-key');
        if (keyEl) keyEl.textContent = newKey;
        const irlKey = document.getElementById('bc-irlpro-key');
        if (irlKey) irlKey.textContent = newKey;
        const irlCombined = document.getElementById('bc-irlpro-combined');
        if (irlCombined) {
            const rtmpUrl = document.getElementById('bc-rtmp-url')?.textContent || '';
            irlCombined.textContent = `${rtmpUrl}/${newKey}`;
        }
        toast('Stream key regenerated — update your streaming software', 'success');
    } catch (e) {
        toast(e.message || 'Failed to regenerate stream key', 'error');
    }
}

/* ── Sync TTS/settings from external method panels (RTMP/JSMPEG/WHIP) ─ */
function syncExternalTTSSetting(key, value) {
    // Mirror the value into the main WebRTC TTS controls so all methods share the same state
    const mainEl = document.getElementById('bc-' + key);
    if (mainEl) {
        if (mainEl.type === 'range' || mainEl.tagName === 'SELECT') mainEl.value = value;
        else if (mainEl.type === 'checkbox') mainEl.checked = !!value;
    }
    // Trigger the same save logic as the WebRTC settings
    updateBroadcastSetting(key, value);
}

async function showJSMPEGInstructions(stream) {
    document.getElementById('bc-stream-manager').style.display = 'none';
    document.getElementById('bc-browser-broadcast').style.display = 'none';
    document.getElementById('bc-rtmp-instructions').style.display = 'none';
    document.getElementById('bc-jsmpeg-instructions').style.display = '';
    document.getElementById('bc-webrtc-obs-instructions').style.display = 'none';
    document.getElementById('bc-chat-sidebar').style.display = '';
    const ib = document.getElementById('bc-info-bar'); if (ib) ib.style.display = '';
    _startRsViewerPoll();
    _startRestreamViewerPoll();
    syncBroadcastLiveButtonVisibility();
    loadLiveControlsStatus(stream.id).catch(() => {});
    try {
        const data = await api(`/streams/${stream.id}/endpoint`);
        const ep = data.endpoint || {};
        const host = location.hostname;
        const baseUrl = `http://${host}:${ep.videoPort || 9710}/${data.stream_key}/640/480/`;
        const audioUrl = `http://${host}:${ep.audioPort || 9711}/${data.stream_key}/`;
        const hdUrl = `http://${host}:${ep.videoPort || 9710}/${data.stream_key}/1280/720/`;

        // Video + Audio
        document.getElementById('bc-jsmpeg-cmd').textContent = ep.ffmpegCommand || `ffmpeg -f v4l2 -i /dev/video0 -f alsa -i default -f mpegts -codec:v mpeg1video -s 640x480 -b:v 350k -bf 0 -codec:a mp2 -b:a 128k -ar 44100 -ac 1 -muxdelay 0.001 ${baseUrl}`;
        // Video only
        const videoOnlyEl = document.getElementById('bc-jsmpeg-cmd-videoonly');
        if (videoOnlyEl) videoOnlyEl.textContent = ep.ffmpegVideoOnly || `ffmpeg -f v4l2 -i /dev/video0 -f mpegts -codec:v mpeg1video -s 640x480 -b:v 350k -bf 0 -muxdelay 0.001 ${baseUrl}`;
        // Screen capture
        const screenEl = document.getElementById('bc-jsmpeg-cmd-screen');
        if (screenEl) screenEl.textContent = ep.ffmpegScreen || `ffmpeg -f x11grab -s 1920x1080 -r 24 -i :0.0 -f pulse -i default -f mpegts -codec:v mpeg1video -s 640x480 -b:v 500k -bf 0 -codec:a mp2 -b:a 128k -ar 44100 -ac 1 -muxdelay 0.001 ${baseUrl}`;
        // OBS Virtual Camera
        const obsEl = document.getElementById('bc-jsmpeg-cmd-obs');
        if (obsEl) obsEl.textContent = ep.ffmpegOBS || `ffmpeg -f v4l2 -i /dev/video2 -f pulse -i default -f mpegts -codec:v mpeg1video -s 640x480 -b:v 500k -bf 0 -codec:a mp2 -b:a 128k -ar 44100 -ac 1 -muxdelay 0.001 ${baseUrl}`;
        // Audio only
        const audioEl = document.getElementById('bc-jsmpeg-cmd-audioonly');
        if (audioEl) audioEl.textContent = ep.ffmpegAudioOnly || `ffmpeg -f alsa -i default -f mpegts -codec:a mp2 -b:a 128k -ar 44100 -ac 1 ${audioUrl}`;
        // HD 720p
        const hdEl = document.getElementById('bc-jsmpeg-cmd-hd');
        if (hdEl) hdEl.textContent = ep.ffmpegHD || `ffmpeg -f v4l2 -video_size 1280x720 -framerate 30 -i /dev/video0 -f alsa -i default -f mpegts -codec:v mpeg1video -s 1280x720 -b:v 1200k -r 30 -bf 0 -codec:a mp2 -b:a 128k -ar 44100 -ac 2 -muxdelay 0.001 ${hdUrl}`;
        // 3D Printer / long-running (low bitrate, 10fps, no audio)
        const printerEl = document.getElementById('bc-jsmpeg-cmd-printer');
        if (printerEl) printerEl.textContent = `ffmpeg -f v4l2 -framerate 10 -video_size 640x480 -i /dev/video0 -f mpegts -codec:v mpeg1video -s 640x480 -b:v 250k -bf 0 -muxdelay 0.001 ${baseUrl}`;
        // IP camera (RTSP) → JSMPEG
        const ipcamEl = document.getElementById('bc-jsmpeg-cmd-ipcam');
        if (ipcamEl) ipcamEl.textContent = `ffmpeg -rtsp_transport tcp -i rtsp://CAMERA_IP:554/stream -f mpegts -codec:v mpeg1video -s 640x480 -b:v 350k -bf 0 -muxdelay 0.001 ${baseUrl}`;
    } catch { document.getElementById('bc-jsmpeg-cmd').textContent = 'Error loading command'; }
}

function getStoredAuthToken() {
    return localStorage.getItem('token') || localStorage.getItem('ov_token') ||
        (document.cookie.match(/(?:^|; )ov_token=([^;]+)/) || [])[1] ||
        (document.cookie.match(/(?:^|; )token=([^;]+)/) || [])[1] ||
        null;
}

async function showWHIPInstructions(stream) {
    document.getElementById('bc-stream-manager').style.display = 'none';
    document.getElementById('bc-browser-broadcast').style.display = 'none';
    document.getElementById('bc-rtmp-instructions').style.display = 'none';
    document.getElementById('bc-jsmpeg-instructions').style.display = 'none';
    document.getElementById('bc-webrtc-obs-instructions').style.display = '';
    document.getElementById('bc-chat-sidebar').style.display = '';
    const ib = document.getElementById('bc-info-bar'); if (ib) ib.style.display = '';
    _startRsViewerPoll();
    _startRestreamViewerPoll();
    syncBroadcastLiveButtonVisibility();
    loadLiveControlsStatus(stream.id).catch(() => {});
    const isLocalHost = /^(localhost|127\.|\[::1\])$/.test(location.hostname);
    let whipBaseUrl = null;
    try {
        const data = await api(`/streams/${stream.id}/endpoint`);
        whipBaseUrl = data.endpoint?.whipUrlBase || null;
        if (data.endpoint?.whipUrlSource === 'request_host') {
            console.warn('[WHIP] Server did not provide a configured WHIP URL. Request-host fallback is being used; please configure WHIP_PUBLIC_URL or WEBRTC_PUBLIC_URL to avoid incorrect client endpoints.');
        }
    } catch (err) {
        console.warn('[WHIP] Failed to load canonical WHIP endpoint from server:', err.message);
    }
    if (!whipBaseUrl) {
        whipBaseUrl = location.origin;
        if (!isLocalHost) {
            console.warn('[WHIP] Falling back to the current page origin for WHIP URL outside of localhost. This is only safe for local development. Configure WHIP_PUBLIC_URL or WEBRTC_PUBLIC_URL in the registry to fix this.');
        }
    }
    document.getElementById('bc-whip-url').textContent = `${whipBaseUrl}/whip/${stream.id}`;
    const token = getStoredAuthToken() || 'N/A';
    const tokenEl = document.getElementById('bc-whip-token');
    if (tokenEl) {
        tokenEl.dataset.value = token;
        tokenEl.textContent = token === 'N/A' ? token : 'hidden';
    }
    const toggleBtn = document.getElementById('bc-whip-token-toggle');
    if (toggleBtn) {
        toggleBtn.textContent = token === 'N/A' ? 'Show' : 'Show';
        toggleBtn.dataset.showing = 'false';
    }
}

function toggleWhipToken() {
    const tokenEl = document.getElementById('bc-whip-token');
    const toggleBtn = document.getElementById('bc-whip-token-toggle');
    if (!tokenEl || !toggleBtn) return;
    const actualToken = tokenEl.dataset.value || 'N/A';
    const showing = toggleBtn.dataset.showing === 'true';
    if (showing) {
        tokenEl.textContent = actualToken === 'N/A' ? actualToken : 'hidden';
        toggleBtn.textContent = 'Show';
        toggleBtn.dataset.showing = 'false';
    } else {
        tokenEl.textContent = actualToken;
        toggleBtn.textContent = 'Hide';
        toggleBtn.dataset.showing = 'true';
    }
}

function copyWhipToken() {
    const tokenEl = document.getElementById('bc-whip-token');
    if (!tokenEl) return;
    copyToClipboard(tokenEl.dataset.value || tokenEl.textContent || '');
}

/* ── End Setup Stream (for non-browser methods) ──────────────── */
async function endSetupStream() {
    stopRtmpStatusPoll();
    const ss = getActiveStreamState();
    const endingStreamId = ss?.streamData?.id || broadcastState.activeStreamId;
    try { if (endingStreamId) await api(`/streams/${endingStreamId}`, { method: 'DELETE' }); } catch {}
    if (endingStreamId) cleanupStream(endingStreamId);

    // Check if other streams are still live (exclude just-ended stream)
    try {
        const data = await api('/streams/mine');
        const remaining = (data.streams || []).filter(s => s.is_live && s.id !== endingStreamId);
        if (remaining.length > 0) {
            // Keep tabs visible but return user to the create panel.
            // Do NOT auto-switch into another live stream — let the user click its tab explicitly.
            await buildBroadcastTabs(null, endingStreamId);
            await showCreateStreamPanel();
            toast('Stream ended', 'info');
            return;
        }
    } catch {}

    hideBroadcastTabs();
    clearGlobalDisplayTimers();
    if (!isStreaming()) setNavLiveIndicator(false);
    showStreamManager(); loadExistingStreams(endingStreamId); toast('Stream ended', 'info');
}

/* Device enumeration functions → broadcast-devices.js */
/* ── TTS Voice Population ─────────────────────────────────────── */
function populateTTSVoices() {
    const select = document.getElementById('bc-ttsVoice');
    if (!select) return;
    const loadVoices = () => {
        const voices = speechSynthesis.getVoices();
        select.innerHTML = '';
        voices.forEach((v, i) => {
            const opt = document.createElement('option'); opt.value = i;
            opt.textContent = `${v.name} (${v.lang})`; select.appendChild(opt);
        });
        if (broadcastState.settings.ttsVoice) select.value = broadcastState.settings.ttsVoice;
    };
    loadVoices();
    if (speechSynthesis.onvoiceschanged !== undefined) speechSynthesis.onvoiceschanged = loadVoices;
}

/* ── Sync Settings UI ────────────────────────────────────────── */
function syncSettingsUI() {
    const s = broadcastState.settings;
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    const setCheck = (id, v) => { const el = document.getElementById(id); if (el) el.checked = v; };
    setVal('bc-ttsVolume', s.ttsVolume); setVal('bc-ttsPitch', s.ttsPitch); setVal('bc-ttsRate', s.ttsRate);
    setVal('bc-ttsDuration', s.ttsDuration); setVal('bc-ttsNames', s.ttsNames); setVal('bc-ttsQueue', s.ttsQueue);
    setVal('bc-notificationVolume', s.notificationVolume); setVal('bc-manualGain', s.manualGain);
    setCheck('bc-autoGain', s.autoGain); setCheck('bc-echoCancellation', s.echoCancellation);
    setCheck('bc-noiseSuppression', s.noiseSuppression); setCheck('bc-manualGainEnabled', s.manualGainEnabled);
    setCheck('bc-force48kSampleRate', s.force48kSampleRate);
    // Restore disconnect audio alert from localStorage (not synced to server — local preference)
    try {
        const discAudio = localStorage.getItem('bc-disconnect-audio') === '1';
        _disconnectAudioEnabled = discAudio;
        setCheck('bc-disconnectAudio', discAudio);
    } catch {}
    setVal('bc-broadcastRes', s.broadcastRes); setVal('bc-broadcastFps', s.broadcastFps);
    setVal('bc-broadcastCodec', s.broadcastCodec); setVal('bc-broadcastBps', s.broadcastBps);
    setVal('bc-broadcastBpsMin', s.broadcastBpsMin); setVal('bc-broadcastLimit', s.broadcastLimit);
    setCheck('bc-serverReconnect', s.serverReconnect !== false);
    setVal('bc-allowSounds', s.allowSounds); setVal('bc-soundVolume', s.soundVolume);
    _syncAudioSelectionUI(s.forceAudio || 'default', { persist: false });
    setCheck('bc-screenShare', s.screenShare);
    // Screen share capture settings
    setVal('bc-screenCaptureSource', s.screenCaptureSource || 'auto');
    setVal('bc-screenSystemAudio', s.screenSystemAudio || 'include');
    setVal('bc-screenSelfBrowser', s.screenSelfBrowser || 'exclude');
    setVal('bc-screenSurfaceSwitching', s.screenSurfaceSwitching || 'include');
    setCheck('bc-screenPreferCurrentTab', s.screenPreferCurrentTab || false);
    _syncCameraSelectionUI(s.forceCamera || _getPreferredCameraId(), { persist: false });
    _syncScreenShareUI();
    syncRobotStreamerUI();
}

function updateBroadcastSetting(key, value) {
    broadcastState.settings[key] = value; saveBroadcastSettings();
}

/**
 * Detach VOD recording state from a stream so it can be finalized in the background.
 * Redirects the recorder's ondataavailable to a standalone array, then nulls the
 * stream state's recorder reference so cleanupStream() won't touch it.
 */
function _detachVodForBackground(streamId) {
    const ss = getStreamState(streamId);
    if (!ss) return null;

    const recorder = ss.vodRecorder;
    const streamDataId = ss.streamData?.id;
    const finalized = ss.vodFinalized;
    const segmentId = ss.vodSegmentId || 0;
    const chunks = ss.vodChunks ? ss.vodChunks.splice(0) : [];

    // Redirect any final ondataavailable events to our standalone array
    if (recorder) {
        recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) chunks.push(e.data);
        };
    }

    // Prevent cleanupStream from stopping the recorder or clearing chunks
    ss.vodRecorder = null;
    ss.vodChunks = [];

    return { recorder, chunks, streamDataId, finalized, segmentId };
}

/**
 * Background: stop recorder, upload remaining VOD chunks, finalize, and delete stream.
 * Fire-and-forget — errors are logged but never surface to the UI.
 */
function _backgroundStreamEnd(streamId, vodCtx) {
    (async () => {
        if (vodCtx) {
            try {
                // Stop recorder — triggers final ondataavailable into vodCtx.chunks
                if (vodCtx.recorder && vodCtx.recorder.state !== 'inactive') {
                    try { vodCtx.recorder.stop(); } catch {}
                    await new Promise(r => setTimeout(r, 600));
                }

                // Upload remaining chunks
                if (vodCtx.chunks.length > 0 && vodCtx.streamDataId) {
                    const blob = new Blob(vodCtx.chunks, { type: 'video/webm' });
                    if (blob.size >= 100) {
                        const fd = new FormData();
                        fd.append('chunk', blob, `chunk-${streamId}-final.webm`);
                        fd.append('segmentId', String(vodCtx.segmentId || 1));
                        await fetch(`/api/vods/stream/${vodCtx.streamDataId}/chunk`, {
                            method: 'POST',
                            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` },
                            body: fd,
                        });
                    }
                }

                // Tell server to remux for seeking
                if (vodCtx.streamDataId && !vodCtx.finalized) {
                    await fetch(`/api/vods/stream/${vodCtx.streamDataId}/finalize`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${localStorage.getItem('token')}`,
                            'Content-Type': 'application/json',
                        },
                    });
                    console.log('[VOD] Background finalize complete for stream', streamId);
                }
            } catch (err) {
                console.warn('[VOD] Background finalization error:', err.message);
            }
        }

        // Delete stream on server
        try { await api(`/streams/${streamId}`, { method: 'DELETE' }); } catch {}
    })();
}

/* ── Stop Broadcasting ───────────────────────────────────────── */
async function stopBroadcast() {
    const activeId = broadcastState.activeStreamId;
    let bgCtx = null;

    if (activeId) {
        bgCtx = _detachVodForBackground(activeId);
        cleanupStream(activeId);
    }

    // Fire background DELETE early so the server knows immediately
    if (activeId) _backgroundStreamEnd(activeId, bgCtx);

    // Check if other streams are still live (exclude the stopped stream — DELETE may be in-flight)
    try {
        const data = await api('/streams/mine');
        const remaining = (data.streams || []).filter(s => s.is_live && s.id !== activeId);
        if (remaining.length > 0) {
            // Keep tabs visible but return user to the create panel.
            // Do NOT auto-switch into another live stream — let the user click its tab explicitly.
            await buildBroadcastTabs(null, activeId);
            await showCreateStreamPanel();
            toast('Stream ended', 'info');
            return;
        }
    } catch {}

    hideBroadcastTabs();
    clearGlobalDisplayTimers();
    if (!isStreaming()) setNavLiveIndicator(false);
    showStreamManager(); loadExistingStreams(activeId); toast('Stream ended', 'info');
    // Scroll create section into view so user lands on "Create New Stream"
    const createSec = document.getElementById('bc-create-section');
    if (createSec) createSec.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * Clean up a single stream's state (media, signaling, timers).
 */
function cleanupStream(streamId) {
    const ss = broadcastState.streams.get(streamId);
    if (!ss) return;

    // Leave the broadcast call if we're in one for this stream
    if (callState.broadcastMode && callState.streamId === streamId) {
        leaveBroadcastCall();
    }

    // Stop media tracks (suppress recovery so ended events don't trigger it)
    stopTrackKeepalive(streamId);
    ss._suppressRecovery = true;
    _cleanupComposite(ss);
    if (ss._screenStream) { ss._screenStream.getTracks().forEach(t => t.stop()); ss._screenStream = null; }
    if (ss.localStream) { ss.localStream.getTracks().forEach(t => t.stop()); ss.localStream = null; }
    _teardownAudioMixer(ss);
    stopRobotStreamerRestream(streamId, { quiet: true }).catch(() => {});
    _cleanupSfuProduce(streamId);

    // Clear RS restream slot if this stream had it
    if (getRsRestreamSlotStreamId() === streamId) setRsRestreamSlot(null);

    // Close viewer connections
    for (const [, pc] of ss.viewerConnections) { try { pc.close(); } catch {} }
    ss.viewerConnections.clear();
    for (const [, timer] of ss.viewerReconnectTimers) clearTimeout(timer);
    ss.viewerReconnectTimers.clear();

    // Close signaling WS
    ss.signalingIntentionalClose = true;
    ss.signalingReconnectDelay = 3000;
    if (ss.signalingReconnectTimer) { clearTimeout(ss.signalingReconnectTimer); ss.signalingReconnectTimer = null; }
    if (ss.mediaRecoveryTimer) { clearTimeout(ss.mediaRecoveryTimer); ss.mediaRecoveryTimer = null; }
    ss.mediaRecoveryAttempts = 0;
    ss.mediaRecoveryInProgress = false;
    if (ss.signalingWs) { try { ss.signalingWs.close(); } catch {} ss.signalingWs = null; }

    // Close audio context
    if (ss.audioContext) { ss.audioContext.close().catch(() => {}); ss.audioContext = null; }

    // Stop VOD recording (chunks already safely on server)
    if (ss.vodRecorder && ss.vodRecorder.state !== 'inactive') { try { ss.vodRecorder.stop(); } catch {} }
    ss.vodRecorder = null; ss.vodChunks = []; ss.vodUploading = false;

    // Clear per-stream timers
    clearInterval(ss.heartbeatInterval);
    ss.heartbeatInterval = null;

    // Remove from map
    broadcastState.streams.delete(streamId);
    _perStreamViewerCounts.delete(streamId);
    _updateTotalViewerCount();

    // Stop RS viewer polling if no streams left
    if (broadcastState.streams.size === 0) { _stopRsViewerPoll(); _stopRestreamViewerPoll(); }

    // If this was the active stream, clear the preview.
    // Do NOT auto-switch to a sibling stream — the caller (endBroadcastTab, stopBroadcast, etc.)
    // is responsible for deciding what to show next.
    if (broadcastState.activeStreamId === streamId) {
        broadcastState.activeStreamId = null;
        const preview = document.getElementById('bc-video-preview'); if (preview) preview.srcObject = null;
    }

    if (!isStreaming()) {
        setNavLiveIndicator(false);
        clearGlobalDisplayTimers();
        releaseWakeLock();
        stopRestreamStatusPolling();
        // Close any background broadcast chat WS now that we're no longer live
        if (typeof destroyBgBroadcastChat === 'function') destroyBgBroadcastChat();
    }

    if (typeof refreshChatTTSContext === 'function') refreshChatTTSContext();

    updateBroadcastMobileChatFab();
    updateRsRestreamSlotUI();
    updateWorkspaceLiveStatus();
}

/**
 * Clean up ALL streams (full teardown).
 */
function cleanupAllStreams() {
    for (const streamId of [...broadcastState.streams.keys()]) {
        cleanupStream(streamId);
    }
    clearGlobalDisplayTimers();
    broadcastState.activeStreamId = null;
    setNavLiveIndicator(false);
}

function setNavLiveIndicator(isLive) {
    const dot = document.getElementById('nav-live-dot');
    if (dot) dot.style.display = isLive ? '' : 'none';
    const link = document.getElementById('nav-broadcast');
    if (link) {
        link.classList.toggle('nav-live', isLive);
        link.dataset.tooltip = isLive ? 'LIVE' : 'Go Live';
    }
}

/* ── Global Display Timers (Stats + Uptime) ──────────────────── */

function startGlobalDisplayTimers() {
    // Stats polling — reads from active stream
    clearInterval(_globalStatsInterval);
    _globalStatsInterval = setInterval(async () => {
        const ss = getActiveStreamState();
        if (!ss || ss.statsPollPending) return;
        ss.statsPollPending = true;
        let totalBytesSent = 0, frameRate = 0, resolution = '', connState = 'waiting', codec = '';
        let hasStats = false;
        try {
            // Helper: extract video stats from an RTCStatsReport
            const extractStats = (stats) => {
                let bytes = 0;
                stats.forEach(r => {
                    if (r.type === 'outbound-rtp' && r.kind === 'video') {
                        bytes += r.bytesSent || 0;  // sum all video layers (simulcast)
                        if (r.framesPerSecond) frameRate = r.framesPerSecond;
                        if (r.frameWidth && r.frameHeight) resolution = `${r.frameWidth}x${r.frameHeight}`;
                    }
                    if (r.type === 'codec' && r.mimeType?.startsWith('video/')) codec = r.mimeType.replace('video/', '');
                });
                return bytes;
            };

            // Primary source: the SFU produce transport — this IS the broadcaster's
            // real ingest uplink, so its byte counter and connection state are the
            // authoritative numbers to show. (Viewer PCs are only P2P-fallback downlinks.)
            const sfuState = _sfuProduceStates.get(ss.streamData?.id);
            if (sfuState?.transport) {
                try {
                    connState = sfuState.transport.connectionState || connState;
                    totalBytesSent = extractStats(await sfuState.transport.getStats());
                    hasStats = totalBytesSent > 0;
                } catch {}
            }

            // Fallback: direct P2P viewer connections. Pick the healthiest one
            // (most bytes sent) rather than blindly sampling the first — the first
            // entry may be a still-negotiating or failed peer.
            if (!hasStats && ss.viewerConnections.size > 0) {
                for (const [, pc] of ss.viewerConnections) {
                    try {
                        const s = pc.iceConnectionState;
                        const bytes = extractStats(await pc.getStats());
                        if (bytes > totalBytesSent) { totalBytesSent = bytes; connState = s; }
                    } catch {}
                }
                hasStats = totalBytesSent > 0;
            }

            // Fallback: local stream settings (when no WebRTC stats available yet).
            // Don't claim "connected" here — report the true transport/signaling state
            // so the overlay never shows a fake healthy status.
            if (!hasStats && ss.localStream) {
                const vt = ss.localStream.getVideoTracks()[0];
                if (vt) {
                    const st = vt.getSettings();
                    resolution = `${st.width || '?'}x${st.height || '?'}`;
                    frameRate = st.frameRate || 0;
                }
                connState = sfuState?.transport?.connectionState
                    || (ss.signalingWs?.readyState === WebSocket.OPEN ? 'checking' : 'disconnected');
            }

            // Compute bitrate from byte deltas
            const now = Date.now();
            let bitrateKbps = 0;
            if (ss.lastStatTime > 0 && totalBytesSent > 0) {
                const db = totalBytesSent - ss.lastStatBytes;
                const dm = now - ss.lastStatTime;
                if (dm > 0 && db >= 0) bitrateKbps = Math.round((db * 8) / dm);
            }
            ss.lastStatBytes = totalBytesSent;
            ss.lastStatTime = now;

            // Format bitrate for display
            const setT = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
            let bitrateText;
            if (hasStats && bitrateKbps > 0) {
                bitrateText = bitrateKbps >= 1000 ? `${(bitrateKbps / 1000).toFixed(1)} Mbps` : `${bitrateKbps} kbps`;
            } else if (hasStats) {
                bitrateText = 'measuring...';
            } else {
                // No WebRTC stats — show target bitrate as estimate
                const targetKbps = parseInt(broadcastState.settings.broadcastBps, 10) || 0;
                bitrateText = targetKbps > 0 ? `~${targetKbps >= 1000 ? (targetKbps / 1000).toFixed(1) + ' Mbps' : targetKbps + ' kbps'}` : '--';
            }
            setT('bc-stat-bitrate', bitrateText);
            setT('bc-stat-fps', `${Math.round(frameRate)} fps`);
            setT('bc-stat-resolution', resolution || '--');
            setT('bc-stat-status', connState);
            setT('bc-stat-codec', codec || '--');

            // Health classification
            const healthEl = document.getElementById('bc-stat-health');
            if (healthEl) {
                let health = 'unknown', color = '#888';
                if (connState === 'connected' || connState === 'completed') {
                    const fps = Math.round(frameRate);
                    if (bitrateKbps >= 500 && fps >= 20) {
                        health = 'Good'; color = '#22c55e';
                    } else if (bitrateKbps >= 200 || fps >= 10) {
                        health = 'Fair'; color = '#f59e0b';
                    } else if (bitrateKbps > 0 || fps > 0) {
                        health = 'Poor'; color = '#ef4444';
                    } else {
                        health = 'Measuring'; color = '#888';
                    }
                } else if (connState === 'disconnected' || connState === 'failed') {
                    health = 'Offline'; color = '#ef4444';
                } else if (connState === 'checking' || connState === 'new') {
                    health = 'Connecting'; color = '#f59e0b';
                }
                healthEl.textContent = health;
                healthEl.style.color = color;
            }
        } finally {
            if (ss) ss.statsPollPending = false;
        }
    }, 6000);

    // Uptime — reads from active stream
    clearInterval(_globalUptimeInterval);
    _globalUptimeInterval = setInterval(() => {
        const ss = getActiveStreamState();
        if (!ss || !ss.startedAt) return;
        let raw = ss.startedAt;
        if (typeof raw === 'string' && !raw.includes('T')) raw = raw.replace(' ', 'T') + 'Z';
        const start = new Date(raw).getTime();
        if (isNaN(start)) return;
        const d = Date.now() - start;
        const h = Math.floor(d / 3600000), m = Math.floor((d % 3600000) / 60000), sec = Math.floor((d % 60000) / 1000);
        const el = document.getElementById('bc-uptime');
        if (el) el.textContent = `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    }, 1000);
}

function clearGlobalDisplayTimers() {
    clearInterval(_globalStatsInterval); _globalStatsInterval = null;
    clearInterval(_globalUptimeInterval); _globalUptimeInterval = null;
    _stopRsViewerPoll();
    _stopRestreamViewerPoll();
}

/* ── Per-Stream Heartbeat ────────────────────────────────────── */

function startHeartbeat(streamId) {
    const ss = getStreamState(streamId);
    if (!ss || !ss.streamData) return;
    clearInterval(ss.heartbeatInterval);
    const sid = ss.streamData.id;
    ss.heartbeatInterval = setInterval(async () => {
        try {
            const res = await fetch(`/api/streams/${sid}/heartbeat`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('token')}`,
                    'Content-Type': 'application/json',
                },
            });
            if (!res.ok) {
                // Server might be restarting — retry several times before giving up.
                // During a deploy the server is briefly unavailable, and the stale-stream
                // cleanup could end our stream before our heartbeat comes through.
                // Actual ingest activity is still authoritative; this heartbeat is a
                // resilience fallback to keep the stream record alive during browser-side
                // reconnects and setup delays.
                ss._heartbeatFailCount = (ss._heartbeatFailCount || 0) + 1;
                if (ss._heartbeatFailCount < 5) {
                    console.warn(`[Heartbeat] Stream ${streamId} returned ${res.status} — retry ${ss._heartbeatFailCount}/5`);
                    return;
                }
                console.warn(`[Heartbeat] Stream ${streamId} heartbeat failed ${ss._heartbeatFailCount} times — cleaning up`);
                cleanupStream(streamId);
                if (!isStreaming()) {
                    hideBroadcastTabs();
                    clearGlobalDisplayTimers();
                    setNavLiveIndicator(false);
                    showStreamManager();
                    loadExistingStreams();
                }
                return;
            }
            // Reset fail counter on success
            ss._heartbeatFailCount = 0;
        } catch {
            // Network error — don't clean up, server may be restarting
        }
        // Only capture thumbnail if this is the active stream (has the preview element)
        if (broadcastState.activeStreamId === streamId) captureLiveThumbnail(streamId);
    }, 30000);
}

function captureLiveThumbnail(streamId) {
    const ss = getStreamState(streamId);
    if (!ss || !ss.streamData) return;
    if (document.hidden) return;
    if (Date.now() - (ss.lastThumbnailAt || 0) < BROADCAST_THUMBNAIL_INTERVAL_MS) return;
    const sid = ss.streamData.id;
    const video = document.getElementById('bc-video-preview');
    if (!video || !video.videoWidth) return;
    try {
        const canvas = ss.thumbnailCanvas || document.createElement('canvas');
        ss.thumbnailCanvas = canvas;
        ss.thumbnailCtx = ss.thumbnailCtx || canvas.getContext('2d', { alpha: false });
        const ctx = ss.thumbnailCtx;
        if (!ctx) return;
        const scale = 320 / Math.max(video.videoWidth, 1);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        ss.lastThumbnailAt = Date.now();
        api(`/thumbnails/live/${sid}`, { method: 'POST', body: { image: dataUrl } }).catch(() => {});
    } catch {}
}

/* ── Per-Stream VOD Recording (Incremental Chunk Upload) ─────── */

/**
 * Start recording a stream and incrementally uploading chunks to the server.
 * Every 30 seconds a chunk is captured and uploaded, so:
 *  - VOD is viewable while the stream is still live
 *  - If the browser/stream dies unexpectedly, the VOD is preserved
 */
function startVodRecording(streamId) {
    const ss = getStreamState(streamId);
    if (!ss || !ss.localStream) return;
    if (ss.vodRecorder && ss.vodRecorder.state !== 'inactive') return;
    try {
        const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
        if (!mimeType) { console.warn('[VOD] No supported codec'); return; }

        ss.vodChunks = [];          // pending chunks queue
        ss.vodUploading = false;    // upload lock
        ss.vodFinalized = false;    // prevent double finalize on actual stream end
        ss.vodSegmentId = (ss.vodSegmentId || 0) + 1;
        ss.vodRecorder = new MediaRecorder(ss.localStream, {
            mimeType,
            videoBitsPerSecond: Math.max(600000, Math.round(getTargetVideoBitrate() * 0.85)),
            audioBitsPerSecond: 128000,
        });

        ss.vodRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
                ss.vodChunks.push(e.data);
                uploadVodChunk(streamId);   // try to flush immediately
            }
        };

        // Capture chunks every 30 seconds
        ss.vodRecorder.start(30000);
        console.log('[VOD] Incremental recording started for stream', streamId, 'segment', ss.vodSegmentId);
    } catch (err) { console.warn('[VOD] Failed to start:', err); }
}

/**
 * Upload the next pending VOD chunk to the server.
 * Sequential — only one upload at a time per stream to maintain chunk order.
 */
async function uploadVodChunk(streamId) {
    const ss = getStreamState(streamId);
    if (!ss || ss.vodUploading || !ss.vodChunks.length || !ss.streamData) return;

    ss.vodUploading = true;
    try {
        // Drain all pending chunks into one blob for this upload
        const blob = new Blob(ss.vodChunks.splice(0), { type: 'video/webm' });
        if (blob.size < 100) { ss.vodUploading = false; return; }

        const fd = new FormData();
        fd.append('chunk', blob, `chunk-${streamId}-${Date.now()}.webm`);
        fd.append('segmentId', String(ss.vodSegmentId || 1));

        const resp = await fetch(`/api/vods/stream/${ss.streamData.id}/chunk`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` },
            body: fd,
        });

        if (resp.ok) {
            const data = await resp.json();
            if (data.vodId) ss.vodId = data.vodId;
        } else {
            console.warn('[VOD] Chunk upload HTTP error:', resp.status);
        }
    } catch (err) {
        console.warn('[VOD] Chunk upload failed:', err.message);
    }
    ss.vodUploading = false;

    // If more chunks arrived while we were uploading, flush again
    if (ss.vodChunks.length > 0) uploadVodChunk(streamId);
}

/**
 * Stop recording and finalize the VOD.
 * Flushes remaining chunks and tells the server to remux for seeking.
 */
async function uploadVodRecording(streamId, { finalizeStream = true } = {}) {
    const ss = getStreamState(streamId);
    if (!ss) return;

    // Stop the MediaRecorder (triggers final ondataavailable)
    if (ss.vodRecorder && ss.vodRecorder.state !== 'inactive') {
        try { ss.vodRecorder.stop(); } catch {}
        await new Promise(r => setTimeout(r, 500)); // wait for final chunk
    }

    // Flush any remaining chunks
    if (ss.vodChunks && ss.vodChunks.length > 0) {
        await uploadVodChunk(streamId);
        // Wait for upload to complete
        let retries = 0;
        while (ss.vodUploading && retries++ < 20) await new Promise(r => setTimeout(r, 300));
    }

    // Tell server to finalize (remux for seeking, update duration)
    if (finalizeStream && ss.streamData && !ss.vodFinalized) {
        ss.vodFinalized = true;
        try {
            await fetch(`/api/vods/stream/${ss.streamData.id}/finalize`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('token')}`,
                    'Content-Type': 'application/json',
                },
            });
            console.log('[VOD] Finalized for stream', streamId);
        } catch (err) {
            console.warn('[VOD] Finalize request failed (server will auto-finalize):', err.message);
        }
    }

    ss.vodChunks = [];
    ss.vodRecorder = null;
    if (finalizeStream) ss.vodSegmentId = 0;
}

// Upload last chunk on page unload as best-effort
if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
        for (const [streamId, ss] of broadcastState.streams) {
            if (ss.vodChunks && ss.vodChunks.length > 0 && ss.streamData) {
                // Use sendBeacon for reliable last-chance upload
                const blob = new Blob(ss.vodChunks.splice(0), { type: 'video/webm' });
                if (blob.size > 100) {
                    const fd = new FormData();
                    fd.append('chunk', blob, `chunk-${streamId}-final.webm`);
                    fd.append('segmentId', String(ss.vodSegmentId || 1));
                    navigator.sendBeacon(`/api/vods/stream/${ss.streamData.id}/chunk?token=${localStorage.getItem('token')}`, fd);
                }
            }
        }
    });
}

/* ── Per-Stream Media Capture ────────────────────────────────── */

/**
 * Build getDisplayMedia() constraints from the user's screen share settings.
 * Modular helper — each constraint is independent so partial browser support is fine.
 * @param {object} [resolution] - {w, h} — video resolution to request
 * @returns {MediaStreamConstraints}
 */
function _buildDisplayMediaConstraints(resolution) {
    const s = broadcastState.settings;
    const res = resolution || { w: 1280, h: 720 };

    const videoConstraints = {
        width: { ideal: res.w },
        height: { ideal: res.h },
        frameRate: { ideal: getBroadcastFrameRate() },
    };

    // Display surface preference: which type of source the picker should prefer
    // 'auto' = let browser decide (no constraint), 'monitor'|'window'|'browser' = hint
    if (s.screenCaptureSource && s.screenCaptureSource !== 'auto') {
        videoConstraints.displaySurface = s.screenCaptureSource;
    }

    // Audio: system/tab audio capture
    let audioConstraint = true; // default: request audio
    if (s.screenSystemAudio === 'exclude') {
        audioConstraint = false;
    } else if (s.screenSystemAudio === 'include') {
        // Some browsers support systemAudio constraint on the top-level
        audioConstraint = { systemAudio: 'include' };
    }
    // 'auto' leaves it as `true` (let browser decide)

    const constraints = { video: videoConstraints, audio: audioConstraint };

    // Self browser surface: whether the current tab appears in the picker
    // 'exclude' prevents accidentally capturing your own broadcast page
    if (s.screenSelfBrowser === 'exclude') {
        constraints.selfBrowserSurface = 'exclude';
    } else if (s.screenSelfBrowser === 'include') {
        constraints.selfBrowserSurface = 'include';
    }

    // Surface switching: allow changing the shared surface while live (browser support varies)
    if (s.screenSurfaceSwitching === 'include') {
        constraints.surfaceSwitching = 'include';
    } else if (s.screenSurfaceSwitching === 'exclude') {
        constraints.surfaceSwitching = 'exclude';
    }

    // Prefer current tab (useful for tab capture workflows)
    if (s.screenPreferCurrentTab) {
        constraints.preferCurrentTab = true;
    }

    // Mono audio hint for screen audio (reduces bandwidth)
    if (constraints.audio && typeof constraints.audio === 'object') {
        constraints.audio.channelCount = { ideal: 2 };
    }

    console.log('[Broadcast] Display media constraints:', JSON.stringify(constraints));
    return constraints;
}

/**
 * Start media capture for a specific stream.
 * @param {number} streamId
 * @param {object} [opts] - Optional device overrides
 * @param {string} [opts.cameraId] - Camera device ID (overrides global setting)
 * @param {string} [opts.audioId] - Audio device ID (overrides global setting)
 */
async function startMediaCapture(streamId, opts = {}) {
    const ss = getStreamState(streamId);
    if (!ss) return;
    const s = broadcastState.settings;
    const forceCamera = opts.cameraId || s.forceCamera;
    const forceAudio = (opts.skipMic) ? null : (opts.audioId || s.forceAudio);
    const resMap = { '360': { w: 640, h: 360 }, '480': { w: 854, h: 480 }, '720': { w: 1280, h: 720 }, '1080': { w: 1920, h: 1080 }, '1440': { w: 2560, h: 1440 } };
    const res = resMap[s.broadcastRes] || resMap['720'];
    let videoConstraints, audioConstraints;

    if (s.screenShare) {
        // Stop any previous composite resources
        _cleanupComposite(ss);

        const displayConstraints = _buildDisplayMediaConstraints(res);
        let screenStream;
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia(displayConstraints);
        } catch (err) {
            // Some browsers don't support all constraint keys — retry with minimal constraints
            if (err.name === 'TypeError' || err.name === 'OverconstrainedError') {
                console.warn('[Broadcast] getDisplayMedia constraints not fully supported, retrying with minimal:', err.message);
                screenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: { width: { ideal: res.w }, height: { ideal: res.h }, frameRate: { ideal: getBroadcastFrameRate() } },
                    audio: s.screenSystemAudio !== 'exclude',
                });
            } else {
                throw err; // permission denied, user cancelled, etc — let caller handle
            }
        }
        ss._screenStream = screenStream;

        // Handle user cancelling screen share picker (track ended immediately)
        const screenTrack = screenStream.getVideoTracks()[0];
        if (screenTrack) {
            screenTrack.addEventListener('ended', () => {
                // User clicked "Stop sharing" in browser UI — switch back to camera
                if (broadcastState.settings.screenShare && !ss._suppressRecovery) {
                    console.log('[Broadcast] Screen share ended by user/OS — switching back to camera');
                    broadcastState.settings.screenShare = false; saveBroadcastSettings();
                    _syncScreenShareUI();
                    _syncScreenShareLiveControls(ss);
                    // Re-acquire camera
                    const sid = broadcastState.activeStreamId;
                    if (sid && ss === getStreamState(sid)) {
                        ss._suppressRecovery = true;
                        _cleanupComposite(ss);
                        startMediaCapture(sid).then(() => {
                            _replaceAllViewerTracks(sid);
                            startVodRecording(sid);
                            ss._suppressRecovery = false;
                        }).catch(() => { ss._suppressRecovery = false; });
                    }
                }
            }, { once: true });
        }

        // Get mic audio separately (unless skipped). Desktop audio comes from getDisplayMedia.
        let micStream = null;
        if (forceAudio !== null) {
            audioConstraints = buildAudioConstraints(s, forceAudio); // uses exact for explicit devices
            try {
                micStream = await _getUserMediaWithTimeout({ audio: audioConstraints, video: false });
                // Verify the browser attached the requested mic
                if (forceAudio && forceAudio !== 'default') {
                    const appliedMic = micStream.getAudioTracks()[0]?.getSettings?.().deviceId;
                    if (appliedMic && appliedMic !== forceAudio) {
                        console.warn('[Broadcast] Screen share mic mismatch: requested', forceAudio, 'got', appliedMic);
                        _warnDeviceMismatch('mic');
                    }
                }
            } catch (micErr) {
                // Exact constraint rejected — retry soft
                if ((micErr.name === 'OverconstrainedError' || micErr.name === 'NotFoundError') && forceAudio && forceAudio !== 'default') {
                    try {
                        const softAudio = buildAudioConstraints(s, forceAudio, { soft: true });
                        micStream = await _getUserMediaWithTimeout({ audio: softAudio, video: false });
                        _warnDeviceMismatch('mic');
                    } catch { micStream = null; }
                } else {
                    micStream = null;
                }
            }
        }
        ss._micEnabled = forceAudio !== null;

        // Always publish the mixer's output, even when only one source exists right now:
        // the mic can be toggled at any point during the stream, and a stable output track
        // is what makes that invisible to the VOD recorder, the SFU producer, the
        // RobotStreamer producer and every viewer connection.
        const screenAudioTracks = screenStream.getAudioTracks();
        _ensureAudioMixer(ss);
        if (screenAudioTracks.length > 0) _mixSetSource(ss, 'desktop', new MediaStream(screenAudioTracks));
        if (micStream) { _mixSetSource(ss, 'mic', micStream); ss._micStream = micStream; }
        const finalAudioTrack = _mixOutputTrack(ss);

        // If camera overlay is enabled, capture camera too and composite onto canvas
        if (ss._cameraOverlayEnabled) {
            let camStream;
            try {
                const camConstraints = { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: getBroadcastFrameRate() } };
                if (forceCamera && forceCamera !== 'default') camConstraints.deviceId = { exact: forceCamera };
                camStream = await _getUserMediaWithTimeout({ video: camConstraints, audio: false });
            } catch (err) {
                // Exact overlay camera constraint rejected — retry soft
                if ((err.name === 'OverconstrainedError' || err.name === 'NotFoundError') && forceCamera && forceCamera !== 'default') {
                    try {
                        const softCam = { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: getBroadcastFrameRate() }, deviceId: forceCamera };
                        camStream = await _getUserMediaWithTimeout({ video: softCam, audio: false });
                        _warnDeviceMismatch('camera');
                    } catch { camStream = null; }
                } else {
                    console.warn('[Broadcast] Camera overlay failed, proceeding without:', err.message);
                    camStream = null;
                }
            }
            ss._cameraOverlayStream = camStream;

            if (camStream) {
                _startPipComposite(ss, screenStream, screenTrack, camStream, finalAudioTrack, res);
            } else {
                // Camera not available — screen-only
                const combined = new MediaStream();
                screenStream.getVideoTracks().forEach(t => combined.addTrack(t));
                if (finalAudioTrack) combined.addTrack(finalAudioTrack);
                ss.localStream = combined;
            }
        } else {
            // Screen share without camera overlay
            const combined = new MediaStream();
            screenStream.getVideoTracks().forEach(t => combined.addTrack(t));
            if (finalAudioTrack) combined.addTrack(finalAudioTrack);
            ss.localStream = combined;
        }
    } else {
        // Hoist these so post-capture verification below can see them regardless of
        // which inner branch ran (micOnly / cameraOnly / standard).
        let hasExplicitCamera = forceCamera && forceCamera !== 'default';
        let hasExplicitAudio  = forceAudio  && forceAudio  !== 'default' && forceAudio !== null;
        let _captureFellBack = false;

        // ── Mic-only mode: audio only, generate a placeholder video canvas ──
        if (s.micOnly) {
            audioConstraints = buildAudioConstraints(s, forceAudio);
            try {
                const audioStream = await _getUserMediaWithTimeout({ video: false, audio: audioConstraints });
                // Create a placeholder canvas video track (dark with mic icon)
                const canvas = document.createElement('canvas');
                canvas.width = 640;
                canvas.height = 360;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#1a1a2e';
                ctx.fillRect(0, 0, 640, 360);
                ctx.fillStyle = 'rgba(255,255,255,0.15)';
                ctx.font = '48px FontAwesome, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('\uF130', 320, 160);  // microphone icon
                ctx.font = '18px sans-serif';
                ctx.fillStyle = 'rgba(255,255,255,0.4)';
                ctx.fillText('Audio Only', 320, 220);
                const canvasStream = canvas.captureStream(1);
                ss.localStream = new MediaStream();
                canvasStream.getVideoTracks().forEach(t => ss.localStream.addTrack(t));
                audioStream.getAudioTracks().forEach(t => ss.localStream.addTrack(t));
                ss._micOnlyCanvas = canvas;  // keep reference to prevent GC
            } catch (e) {
                console.error('[Broadcast] Mic-only capture failed:', e.message);
                throw new Error('Could not access microphone for audio-only mode');
            }
        // ── Camera-only mode: video only, no microphone ──
        } else if (s.cameraOnly) {
            videoConstraints = {
                width: { ideal: res.w },
                height: { ideal: res.h },
                frameRate: { ideal: getBroadcastFrameRate() },
            };
            if (hasExplicitCamera) videoConstraints.deviceId = { exact: forceCamera };
            try {
                ss.localStream = await _getUserMediaWithTimeout({ video: videoConstraints, audio: false });
            } catch (e) {
                console.warn('[Broadcast] Camera-only exact constraint failed, trying fallback:', e.message);
                try {
                    ss.localStream = await _getUserMediaWithTimeout({ video: true, audio: false });
                } catch (e2) {
                    throw new Error('Could not access camera for video-only mode');
                }
            }
        // ── Standard camera + mic mode ──
        } else {
        videoConstraints = {
            width: { ideal: res.w },
            height: { ideal: res.h },
            frameRate: { ideal: getBroadcastFrameRate() },
        };
        // Use exact deviceId for explicit selections so Chrome must use the chosen camera.
        // On exact failure (OverconstrainedError / NotFoundError) we fall back and warn.
        if (hasExplicitCamera) videoConstraints.deviceId = { exact: forceCamera };
        audioConstraints = buildAudioConstraints(s, forceAudio); // uses exact internally
        try {
            ss.localStream = await _getUserMediaWithTimeout({ video: videoConstraints, audio: audioConstraints });
        } catch (firstErr) {
            // If exact constraint was the cause (OverconstrainedError / NotFoundError), relax and warn
            const isExactFail = firstErr.name === 'OverconstrainedError' || firstErr.name === 'NotFoundError';
            if (isExactFail && (hasExplicitCamera || hasExplicitAudio)) {
                console.warn('[Broadcast] Exact device constraint rejected, relaxing:', firstErr.message);
                _captureFellBack = true;
                // Retry with soft (ideal) constraints for the selected devices
                const softVideo = { ...videoConstraints };
                if (hasExplicitCamera) softVideo.deviceId = forceCamera; // soft
                const softAudio = buildAudioConstraints(s, forceAudio, { soft: true });
                try {
                    ss.localStream = await _getUserMediaWithTimeout({ video: softVideo, audio: softAudio });
                } catch { /* fall through to facingMode fallback below */ }
            }
            if (!ss.localStream) {
            // Fallback 1: drop deviceId, use facingMode (common mobile fix)
            console.warn('[Broadcast] getUserMedia failed, trying facingMode fallback:', firstErr.message);
            try {
                const fallbackVideo = { facingMode: 'user', width: { ideal: res.w }, height: { ideal: res.h } };
                const fallbackAudio = buildAudioConstraints(s, 'default', { soft: true });
                ss.localStream = await _getUserMediaWithTimeout({ video: fallbackVideo, audio: fallbackAudio });
            } catch (secondErr) {
                // Fallback 2: bare minimum — just {video: true, audio: true}
                console.warn('[Broadcast] facingMode fallback failed, trying bare minimum:', secondErr.message);
                try {
                    ss.localStream = await _getUserMediaWithTimeout({ video: true, audio: true });
                } catch (thirdErr) {
                    // Fallback 3: video and audio separately
                    console.warn('[Broadcast] Combined bare failed, trying separate:', thirdErr.message);
                    let vStream, aStream;
                    try { vStream = await _getUserMediaWithTimeout({ video: true }); } catch {}
                    try { aStream = await _getUserMediaWithTimeout({ audio: true }); } catch {}
                    if (!vStream && !aStream) throw new Error('Could not access any camera or microphone');
                    ss.localStream = new MediaStream();
                    if (vStream) vStream.getTracks().forEach(t => ss.localStream.addTrack(t));
                    if (aStream) aStream.getTracks().forEach(t => ss.localStream.addTrack(t));
                }
            }
            } // end if (!ss.localStream)
        }
        } // end standard camera+mic mode

        // Post-capture device verification — detect if browser silently used a different device
        if (ss.localStream) {
            const vt = ss.localStream.getVideoTracks()[0];
            const at = ss.localStream.getAudioTracks()[0];
            if (vt && hasExplicitCamera) {
                const appliedCam = vt.getSettings?.().deviceId;
                if (appliedCam && appliedCam !== forceCamera) {
                    console.warn('[Broadcast] Camera mismatch: requested', forceCamera, 'got', appliedCam);
                    _warnDeviceMismatch('camera');
                } else if (_captureFellBack) {
                    console.warn('[Broadcast] Camera constraint was relaxed — browser may not have used the selected camera.');
                    _warnDeviceMismatch('camera');
                }
            }
            if (at && hasExplicitAudio) {
                const appliedMic = at.getSettings?.().deviceId;
                if (appliedMic && appliedMic !== forceAudio) {
                    console.warn('[Broadcast] Mic mismatch: requested', forceAudio, 'got', appliedMic);
                    _warnDeviceMismatch('mic');
                } else if (_captureFellBack) {
                    console.warn('[Broadcast] Audio constraint was relaxed — browser may not have used the selected mic.');
                    _warnDeviceMismatch('mic');
                }
            }
        }
    }

    optimizeOutgoingStream(streamId);
    applyManualGain(streamId);
    attachLocalStreamRecoveryHandlers(streamId);
    startTrackKeepalive(streamId);

    // Only attach to preview if this is the active stream
    if (broadcastState.activeStreamId === streamId) {
        const preview = document.getElementById('bc-video-preview');
        if (preview) { preview.srcObject = ss.localStream; preview.muted = true; preview.play().catch(() => {}); }
        const ph = document.getElementById('bc-video-placeholder'); if (ph) ph.style.display = 'none';

        // Detect vertical video and add class for responsive mobile layout
        _detectBroadcastVerticalPreview(ss.localStream);

        // Listen for video dimension changes (e.g., device rotation mid-stream)
        if (preview) {
            preview.addEventListener('resize', () => _detectBroadcastVerticalPreview(ss.localStream));
        }
    }
    updateBroadcastMobileChatFab();
}

function buildAudioConstraints(s, forceAudio, { soft = false } = {}) {
    const audio = {};
    const audioDevice = forceAudio || s.forceAudio;
    // Use exact deviceId for explicit selections so the browser must use the chosen mic.
    // Pass soft:true only for fallback paths where we intentionally relax the constraint.
    if (audioDevice && audioDevice !== 'default') {
        audio.deviceId = soft ? audioDevice : { exact: audioDevice };
    }
    audio.autoGainControl = !!s.autoGain; audio.echoCancellation = !!s.echoCancellation; audio.noiseSuppression = !!s.noiseSuppression;
    if (s.force48kSampleRate) audio.sampleRate = 48000;
    return audio;
}

function applyManualGain(streamId) {
    const ss = getStreamState(streamId);
    if (!broadcastState.settings.manualGainEnabled || !ss || !ss.localStream) return;
    try {
        const audioTrack = ss.localStream.getAudioTracks()[0]; if (!audioTrack) return;
        const ctx = new AudioContext(); const source = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
        const gain = ctx.createGain(); gain.gain.value = broadcastState.settings.manualGain / 100;
        source.connect(gain); const dest = ctx.createMediaStreamDestination(); gain.connect(dest);
        ss.localStream.removeTrack(audioTrack); ss.localStream.addTrack(dest.stream.getAudioTracks()[0]);
        ss.audioContext = ctx; ss.gainNode = gain;
    } catch (err) { console.warn('[Broadcast] Manual gain failed:', err); }
}

/* ── Multi-Platform Restream Destinations ──────────────────── */

const RESTREAM_PLATFORM_META = {
    youtube:       { name: 'YouTube',       icon: 'fa-brands fa-youtube', color: '#ff0000' },
    twitch:        { name: 'Twitch',        icon: 'fa-brands fa-twitch',  color: '#9146ff' },
    kick:          { name: 'Kick',          icon: 'fa-solid fa-k',        color: '#53fc18' },
    custom:        { name: 'Custom',        icon: 'fa-solid fa-globe',    color: '#888' },
    // RobotStreamer uses WebSocket (not RTMP) so it is NOT a standard RTMP destination.
    // It is listed here so the UI can show its status card and link to its own settings panel.
    robotstreamer: { name: 'RobotStreamer', icon: 'fa-solid fa-robot',    color: '#00bcd4', isRobotStreamer: true },
};

/** Client-side cache of loaded destinations */
let _restreamDestinations = [];
let _restreamStatusPollInterval = null;

/** Load restream destinations from server */
async function loadRestreamDestinations() {
    try {
        const activeSS = getActiveStreamState();
        const selectedManagedStream = document.getElementById('bc-managed-stream')?.value;
        const managedStreamId = activeSS?.streamData?.managed_stream_id || (selectedManagedStream ? parseInt(selectedManagedStream, 10) : null);
        const url = managedStreamId ? `/restream/destinations?managed_stream_id=${managedStreamId}` : '/restream/destinations';
        const data = await api(url);
        _restreamDestinations = data.destinations || [];
    } catch (err) {
        console.warn('[Restream] Failed to load destinations:', err.message);
    }
}

/** Start restream for a specific destination */
async function startRestreamDest(destId) {
    try {
        const payload = broadcastState.activeStreamId ? { streamId: broadcastState.activeStreamId } : {};
        await api(`/restream/destinations/${destId}/start`, { method: 'POST', body: payload });
        toast('Restream starting…', 'info');
        // Poll status immediately
        await pollRestreamStatus();
    } catch (err) {
        toast(err.message || 'Failed to start restream', 'error');
    }
}

/** Stop restream for a specific destination */
async function stopRestreamDest(destId) {
    try {
        await api(`/restream/destinations/${destId}/stop`, { method: 'POST' });
        toast('Restream stopped', 'info');
        await pollRestreamStatus();
    } catch (err) {
        toast(err.message || 'Failed to stop restream', 'error');
    }
}

/**
 * Poll restream status from the server and update the control panel.
 * Called periodically while streaming.
 */
let _lastRestreamStatuses = {};
async function pollRestreamStatus() {
    try {
        const data = await api('/restream/status');
        _lastRestreamStatuses = data.statuses || {};
        updateRestreamControlPanel();
    } catch {
        // Silent — polling failure is non-critical
    }
}

/** Start polling restream status (called when going live) */
function startRestreamStatusPolling() {
    stopRestreamStatusPolling();
    pollRestreamStatus();
    _restreamStatusPollInterval = setInterval(pollRestreamStatus, 5000);
}

/** Stop polling */
function stopRestreamStatusPolling() {
    if (_restreamStatusPollInterval) {
        clearInterval(_restreamStatusPollInterval);
        _restreamStatusPollInterval = null;
    }
}

/**
 * Update the restream control panel in the live controls section.
 * Shows all RTMP destinations + RS status as a unified bar.
 */
function updateRestreamControlPanel() {
    const panel = document.getElementById('bc-restream-control');
    if (!panel) return;

    const enabledDests = _restreamDestinations.filter(d => d.enabled);
    const hasRs = canUseRobotStreamerRestream();

    if (enabledDests.length === 0 && !hasRs) {
        panel.style.display = 'none';
        return;
    }

    // Flatten all stream statuses into a destId → status map
    const statusMap = {};
    for (const streamStatuses of Object.values(_lastRestreamStatuses)) {
        for (const s of (streamStatuses || [])) {
            statusMap[s.destId] = s;
        }
    }

    let html = '';

    // RTMP destinations
    for (const dest of enabledDests) {
        const meta = RESTREAM_PLATFORM_META[dest.platform] || RESTREAM_PLATFORM_META.custom;
        const status = statusMap[dest.id];
        const statusLabel = status?.status || 'idle';

        let badgeClass = 'bc-restream-status-idle';
        let badgeIcon = 'fa-solid fa-circle';
        let badgeText = 'Idle';

        if (statusLabel === 'live') {
            badgeClass = 'bc-restream-status-live';
            badgeText = 'Live';
        } else if (statusLabel === 'starting') {
            badgeClass = 'bc-restream-status-starting';
            badgeIcon = 'fa-solid fa-spinner fa-spin';
            badgeText = 'Starting…';
        } else if (statusLabel === 'error') {
            badgeClass = 'bc-restream-status-error';
            badgeIcon = 'fa-solid fa-circle-exclamation';
            badgeText = 'Error';
        } else if (statusLabel === 'failed') {
            badgeClass = 'bc-restream-status-failed';
            badgeIcon = 'fa-solid fa-circle-xmark';
            badgeText = 'Failed';
        }

        const isActive = statusLabel === 'live' || statusLabel === 'starting';

        html += `<div class="bc-restream-row">
            <span class="bc-restream-platform-icon" style="color:${meta.color}"><i class="${meta.icon}"></i></span>
            <span class="bc-restream-name">${dest.name || meta.name}</span>
            <span class="bc-restream-status-badge ${badgeClass}"><i class="${badgeIcon}"></i> ${badgeText}</span>
            <div class="bc-restream-actions">
                ${isActive
                    ? `<button class="bc-ctrl-btn-sm" onclick="stopRestreamDest(${dest.id})"><i class="fa-solid fa-stop"></i> Stop</button>`
                    : `<button class="bc-ctrl-btn-sm" onclick="startRestreamDest(${dest.id})"><i class="fa-solid fa-play"></i> Start</button>`
                }
            </div>
        </div>`;
    }

    // RS status row (if configured)
    if (hasRs) {
        const slotId = getRsRestreamSlotStreamId();
        const slotSs = slotId ? getStreamState(slotId) : null;
        const isRsLive = !!(slotSs?.robotStreamer?.active);
        const isRsStarting = !!(slotSs?._rsRestreamStarting);

        let rsBadgeClass = 'bc-restream-status-idle';
        let rsBadgeIcon = 'fa-solid fa-circle';
        let rsBadgeText = 'Idle';

        if (isRsLive) {
            rsBadgeClass = 'bc-restream-status-live';
            rsBadgeText = 'Live';
        } else if (isRsStarting || slotSs?._rsReconnectTimer) {
            rsBadgeClass = 'bc-restream-status-starting';
            rsBadgeIcon = 'fa-solid fa-spinner fa-spin';
            rsBadgeText = isRsStarting ? 'Starting…' : 'Reconnecting…';
        }

        html += `<div class="bc-restream-row">
            <span class="bc-restream-platform-icon" style="color:#4a9eff"><i class="fa-solid fa-robot"></i></span>
            <span class="bc-restream-name">RobotStreamer</span>
            <span class="bc-restream-status-badge ${rsBadgeClass}"><i class="${rsBadgeIcon}"></i> ${rsBadgeText}</span>
            <div class="bc-restream-actions">
                ${isRsLive
                    ? `<button class="bc-ctrl-btn-sm" onclick="stopRsRestream()"><i class="fa-solid fa-stop"></i> Stop</button>`
                    : `<button class="bc-ctrl-btn-sm" onclick="startOrRetryRsRestream()"><i class="fa-solid fa-play"></i> Start</button>`
                }
            </div>
        </div>`;
    }

    panel.innerHTML = html;
    panel.style.display = html ? '' : 'none';
}

/* ── RobotStreamer Restream ─────────────────────────────────── */

let _robotStreamerMediasoupModulePromise = null;
let _robotStreamerIntegrationPromise = null;
const RS_RECONNECT_BASE_DELAY = 3000;
const RS_RECONNECT_MAX_DELAY = 60000;
const RS_STABLE_CONNECTION_MS = 30000; // connection must survive 30s to reset backoff
const RS_MAX_SHORT_LIVED_RETRIES = 15;  // give up after this many consecutive short-lived sessions

function canUseRobotStreamerRestream() {
    const rs = broadcastState.robotStreamer;
    return !!(rs?.enabled && rs?.hasToken && rs?.robotId);
}

/** Wait for the RS integration to finish loading (resolves immediately if already loaded). */
async function ensureRobotStreamerLoaded() {
    if (broadcastState.robotStreamer.loaded) return;
    if (_robotStreamerIntegrationPromise) {
        await _robotStreamerIntegrationPromise;
    }
}

function getRobotStreamerPublishUrl(streamId) {
    const host = window.location.hostname;
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const portSuffix = window.location.port ? `:${window.location.port}` : '';
    const token = localStorage.getItem('token');
    return `${protocol}://${host}${portSuffix}/ws/robotstreamer-publish?token=${encodeURIComponent(token || '')}&streamId=${encodeURIComponent(streamId)}`;
}

function buildRobotStreamerDeviceDescriptor(device /*, stream — no longer needed */) {
    // Construct a descriptor matching what the RS SFU expects from the
    // official robotstreamer.com web client (HAR protocol analysis).
    // The RS client serializes the mediasoup Device class which exposes
    // underscore-prefixed internal properties. We replicate this structure
    // using the Device's public API for compatibility.
    return {
        _handlerName: device.handlerName,
        _loaded: device.loaded,
        _canProduceByKind: {
            audio: device.canProduce('audio'),
            video: device.canProduce('video'),
        },
        _sctpCapabilities: device.sctpCapabilities || { numStreams: { OS: 1024, MIS: 1024 } },
    };
}

function createRobotStreamerRpc(ws) {
    let nextId = 1;
    const pending = new Map();
    const RPC_TIMEOUT_MS = 15000;

    ws.addEventListener('message', (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (!msg?.response || !pending.has(msg.id)) return;
        const deferred = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(deferred.timer);
        if (msg.ok === false) {
            console.warn('[RS RPC] Error response for', deferred.method, ':', msg.error || msg.reason);
            deferred.reject(new Error(msg.error || msg.reason || 'RobotStreamer request failed'));
        } else {
            console.log('[RS RPC] Response OK for', deferred.method);
            deferred.resolve(msg.data);
        }
    });

    const rejectAll = (error) => {
        for (const deferred of pending.values()) { clearTimeout(deferred.timer); deferred.reject(error); }
        pending.clear();
    };

    ws.addEventListener('close', (ev) => {
        const detail = ev.reason ? ` (${ev.code}: ${ev.reason})` : ev.code ? ` (code ${ev.code})` : '';
        rejectAll(new Error(`RobotStreamer publish connection closed${detail}`));
    });
    ws.addEventListener('error', () => rejectAll(new Error('RobotStreamer publish connection failed')));

    return {
        async request(method, data = {}) {
            if (ws.readyState !== WebSocket.OPEN) throw new Error('RobotStreamer publish connection is not open');
            const id = nextId++;
            const payload = { request: true, id, method, data };
            console.log('[RS RPC] Sending:', method, '(id:', id + ')');
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    if (pending.has(id)) {
                        pending.delete(id);
                        console.error('[RS RPC] Timeout after', RPC_TIMEOUT_MS, 'ms for', method, '(id:', id + ')');
                        reject(new Error(`RobotStreamer RPC timeout: ${method} (no response in ${RPC_TIMEOUT_MS / 1000}s)`));
                    }
                }, RPC_TIMEOUT_MS);
                pending.set(id, { resolve, reject, timer, method });
                ws.send(JSON.stringify(payload));
            });
        },
    };
}

async function loadRobotStreamerMediasoup() {
    if (!_robotStreamerMediasoupModulePromise) {
        _robotStreamerMediasoupModulePromise = import('https://esm.sh/mediasoup-client@3.18.7');
        // Clear cache on rejection so the next call retries instead of being
        // permanently broken by a transient network error or CSP violation.
        _robotStreamerMediasoupModulePromise.catch(() => {
            _robotStreamerMediasoupModulePromise = null;
        });
    }
    return _robotStreamerMediasoupModulePromise;
}

async function startRobotStreamerRestream(streamId) {
    const ss = getStreamState(streamId);
    if (!ss?.localStream) { console.log('[RS Restream] No localStream, skipping'); return null; }

    // Wait for integration settings to load first (fixes race condition on page load)
    await ensureRobotStreamerLoaded();

    // Slot-specific config wins over the account-level integration
    const slotRs = ss._rsSlotIntegration
        || await fetchSlotRsIntegration(ss.streamData?.managed_stream_id || null);
    if (slotRs) ss._rsSlotIntegration = slotRs;

    if (slotRs) {
        if (!rsSlotIntegrationUsable(slotRs)) {
            console.log('[RS Restream] Slot config not usable — enabled:', slotRs.enabled, 'hasToken:', slotRs.has_token, 'robotId:', slotRs.robot_id);
            if (!slotRs.enabled) setRobotStreamerStatus('RobotStreamer restream is disabled for this stream slot.', 'info', 'bc-rsLiveStatus');
            return null;
        }
    } else if (!canUseRobotStreamerRestream()) {
        const rs = broadcastState.robotStreamer;
        console.log('[RS Restream] Cannot start — enabled:', rs.enabled, 'hasToken:', rs.hasToken, 'robotId:', rs.robotId);
        if (!rs.enabled) setRobotStreamerStatus('RobotStreamer restream is disabled.', 'info', 'bc-rsLiveStatus');
        return null;
    }
    if (ss.robotStreamer?.active) return ss.robotStreamer;

    // Server-side RAW passthrough owns this robot — the server forwards our already-encoded
    // stream to RobotStreamer with zero re-encode, so the browser must NOT publish a second
    // (double) encode. Skip the client publish entirely.
    if (broadcastState.robotStreamer?.passthrough) {
        console.log('[RS Restream] Server passthrough active — skipping browser publish for stream', streamId);
        setRobotStreamerStatus('Restreaming to RobotStreamer via server (raw passthrough, no re-encode).', 'success', 'bc-rsLiveStatus');
        return null;
    }

    // Guard against concurrent startRobotStreamerRestream calls
    if (ss._rsRestreamStarting) {
        console.log('[RS Restream] Already starting for stream', streamId, '— skipping duplicate');
        return null;
    }
    ss._rsRestreamStarting = true;

    /** Check localStream availability — if media recovery is in progress, abort gracefully
     *  (recovery flow will restart RS restream when done). */
    const requireLocalStream = (step) => {
        if (!getStreamState(streamId)) throw new _RSAbortError('stream state gone');
        if (ss.localStream) return true;
        if (ss.mediaRecoveryInProgress || ss.mediaRecoveryTimer) {
            console.log(`[RS Restream] localStream null at ${step} — media recovery active, aborting gracefully`);
            throw new _RSAbortError('media recovery in progress');
        }
        console.log(`[RS Restream] localStream null at ${step} — no recovery active, will retry`);
        return false;
    };

    setRobotStreamerStatus('Connecting RobotStreamer restream…', 'info', 'bc-rsLiveStatus');
    console.log('[RS Restream] Starting for stream', streamId);

    let ws = null;
    try {
        console.log('[RS Restream] Step 1/7: Loading mediasoup-client…');
        setRobotStreamerStatus('Loading mediasoup library…', 'info', 'bc-rsLiveStatus');
        const mod = await loadRobotStreamerMediasoup();
        const Device = mod.Device || mod.default?.Device;
        if (!Device) throw new Error('mediasoup-client failed to load');
        console.log('[RS Restream] Step 1/7 done: mediasoup-client loaded');

        console.log('[RS Restream] Step 2/7: Opening WebSocket to proxy…');
        setRobotStreamerStatus('Connecting to RobotStreamer proxy…', 'info', 'bc-rsLiveStatus');
        const wsUrl = getRobotStreamerPublishUrl(streamId);
        console.log('[RS Restream] WS URL:', wsUrl.replace(/token=[^&]+/, 'token=***'));
        ws = new WebSocket(wsUrl);
        await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve, { once: true });
            ws.addEventListener('error', () => reject(new Error('RobotStreamer publish websocket failed')), { once: true });
            ws.addEventListener('close', (ev) => reject(new Error(`RobotStreamer publish websocket closed (${ev.code})`)), { once: true });
        });
        console.log('[RS Restream] Step 2/7 done: WebSocket open');

        const rpc = createRobotStreamerRpc(ws);

        console.log('[RS Restream] Step 3/7: Getting router RTP capabilities…');
        setRobotStreamerStatus('Negotiating RobotStreamer capabilities…', 'info', 'bc-rsLiveStatus');
        const routerRtpCapabilities = await rpc.request('getRouterRtpCapabilities', {});
        console.log('[RS Restream] Step 3/7 done: Got', routerRtpCapabilities?.codecs?.length || 0, 'codecs');

        const device = new Device();
        await device.load({ routerRtpCapabilities });
        console.log('[RS Restream] Device loaded, handler:', device.handlerName);

        console.log('[RS Restream] Step 4/7: Creating WebRTC transport…');
        setRobotStreamerStatus('Creating RobotStreamer transport…', 'info', 'bc-rsLiveStatus');
        const transportInfo = await rpc.request('createWebRtcTransport', { producing: true, consuming: false });
        console.log('[RS Restream] Step 4/7 done: Transport ID:', transportInfo?.id);

        console.log('[RS Restream] Step 5/7: Joining room…');
        setRobotStreamerStatus('Joining RobotStreamer room…', 'info', 'bc-rsLiveStatus');
        if (!requireLocalStream('join')) throw new Error('localStream unavailable for join');
        await rpc.request('join', {
            device: buildRobotStreamerDeviceDescriptor(device),
            rtpCapabilities: device.rtpCapabilities,
        });
        console.log('[RS Restream] Step 5/7 done: Joined');

        console.log('[RS Restream] Step 6/7: Creating send transport…');
        const transport = device.createSendTransport(transportInfo);
        transport.on('connect', ({ dtlsParameters }, callback, errback) => {
            rpc.request('connectWebRtcTransport', { transportId: transport.id, dtlsParameters })
                .then(() => callback())
                .catch(errback);
        });
        transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
            rpc.request('produce', { transportId: transport.id, kind, rtpParameters, appData })
                .then((data) => callback({ id: data?.id }))
                .catch(errback);
        });
        let _rsDisconnectTimer = null;
        transport.on('connectionstatechange', (state) => {
            console.log('[RS Restream] Transport state:', state);
            // Clear any pending disconnect timer on any state change
            if (_rsDisconnectTimer) { clearTimeout(_rsDisconnectTimer); _rsDisconnectTimer = null; }
            if (state === 'connected') {
                setRobotStreamerStatus('RobotStreamer restream is live.', 'success', 'bc-rsLiveStatus');
            } else if (state === 'connecting') {
                setRobotStreamerStatus('RobotStreamer restream is connecting…', 'info', 'bc-rsLiveStatus');
            } else if (state === 'disconnected') {
                // ICE disconnected — may recover on its own, but if it stays
                // disconnected for 15s, treat it as a failure and reconnect.
                setRobotStreamerStatus('RobotStreamer restream disconnected — waiting for recovery…', 'warning', 'bc-rsLiveStatus');
                _rsDisconnectTimer = setTimeout(() => {
                    _rsDisconnectTimer = null;
                    if (ss.robotStreamer === session && session.active) {
                        console.warn('[RS Restream] Transport stuck in disconnected state for 15s — reconnecting');
                        setRobotStreamerStatus('RobotStreamer restream timed out — will retry.', 'error', 'bc-rsLiveStatus');
                        scheduleRobotStreamerReconnect(streamId);
                    }
                }, 15000);
            } else if (state === 'failed' || state === 'closed') {
                setRobotStreamerStatus('RobotStreamer restream connection failed — will retry.', 'error', 'bc-rsLiveStatus');
                scheduleRobotStreamerReconnect(streamId);
            }
        });

        const session = {
            active: true,
            ws,
            rpc,
            device,
            transport,
            videoProducer: null,
            audioProducer: null,
            reconnectTimer: null,
            intentionalClose: false,
            connectedAt: Date.now(),
        };
        ss.robotStreamer = session;

        // Start a stability timer — if connection survives RS_STABLE_CONNECTION_MS,
        // reset the backoff delay and consecutive failure counter.
        ss._rsStabilityTimer = setTimeout(() => {
            ss._rsStabilityTimer = null;
            if (ss.robotStreamer === session && session.active) {
                console.log('[RS Restream] Connection stable for', RS_STABLE_CONNECTION_MS / 1000, 's — resetting backoff');
                ss._rsReconnectDelay = RS_RECONNECT_BASE_DELAY;
                ss._rsConsecutiveShortLived = 0;
            }
        }, RS_STABLE_CONNECTION_MS);

        console.log('[RS Restream] Step 7/7: Producing tracks…');
        setRobotStreamerStatus('Sending media to RobotStreamer…', 'info', 'bc-rsLiveStatus');
        if (!requireLocalStream('produce')) {
            // Clean up partially-built session
            try { transport.close(); } catch {}
            try { ws.close(1000); } catch {}
            ss.robotStreamer = null;
            throw new Error('localStream unavailable for produce');
        }
        const videoTrack = ss.localStream.getVideoTracks()[0] || null;
        const audioTrack = ss.localStream.getAudioTracks()[0] || null;
        console.log('[RS Restream] Tracks — video:', !!videoTrack, 'audio:', !!audioTrack);
        if (videoTrack) {
            // stopTracks: false — the broadcast owns these tracks, not the RS producer.
            // Without this, Producer.close() calls track.stop() on the ORIGINAL broadcast
            // tracks, killing the stream when RS reconnects.
            session.videoProducer = await transport.produce({ track: videoTrack, stopTracks: false });
            console.log('[RS Restream] Video producer ID:', session.videoProducer.id);
        }
        if (audioTrack) {
            session.audioProducer = await transport.produce({ track: audioTrack, stopTracks: false });
            console.log('[RS Restream] Audio producer ID:', session.audioProducer.id);
        }

        // Monitor producer track-ended events — on Steam Deck / PipeWire, these
        // fire spuriously during normal Gamescope compositing. Do NOT trigger an
        // independent RS reconnect — the frame watchdog in startTrackKeepalive()
        // will detect if the stream is truly dead and trigger media recovery,
        // which will restart the RS restream as part of its flow.
        const onProducerTrackEnded = (kind) => {
            if (ss.robotStreamer !== session || !session.active) return;
            // If media recovery is already in progress, it will restart RS when done
            if (ss.mediaRecoveryInProgress || ss.mediaRecoveryTimer) {
                console.log(`[RS Restream] ${kind} producer trackended — media recovery active, will restart after`);
                return;
            }
            // Log but do NOT reconnect — let the watchdog decide
            console.log(`[RS Restream] ${kind} producer trackended — deferring to frame watchdog`);
        };
        if (session.videoProducer) {
            session.videoProducer.on('trackended', () => onProducerTrackEnded('video'));
        }
        if (session.audioProducer) {
            session.audioProducer.on('trackended', () => onProducerTrackEnded('audio'));
        }

        ws.addEventListener('close', (ev) => {
            if (ss.robotStreamer === session) {
                const sessionAge = Date.now() - (session.connectedAt || 0);
                session.active = false;
                if (!session.intentionalClose) {
                    console.warn(`[RS Restream] WebSocket closed unexpectedly — code: ${ev.code}, reason: ${ev.reason || '(none)'}, session age: ${sessionAge}ms`);
                    const detail = ev.reason ? ` — ${ev.reason}` : '';
                    setRobotStreamerStatus(`RobotStreamer restream disconnected${detail} — reconnecting…`, 'warning', 'bc-rsLiveStatus');
                    scheduleRobotStreamerReconnect(streamId);
                } else {
                    console.log(`[RS Restream] WebSocket closed intentionally — code: ${ev.code}, session age: ${sessionAge}ms`);
                }
            }
        });

        console.log('[RS Restream] Live! stream:', streamId);
        setRobotStreamerStatus('RobotStreamer restream is live.', 'success', 'bc-rsLiveStatus');
        ss._rsRestreamStarting = false;
        return session;
    } catch (err) {
        ss._rsRestreamStarting = false;
        // If this was a graceful abort (media recovery active), don't schedule reconnect —
        // the recovery flow will restart RS restream when it's done.
        if (err instanceof _RSAbortError) {
            console.log('[RS Restream] Gracefully aborted:', err.message);
            // Clean up WS if it was opened
            if (ws && ws.readyState === WebSocket.OPEN) { try { ws.close(1000); } catch {} }
            ss.robotStreamer = null;
            return null;
        }
        ss.robotStreamer = null;
        setRobotStreamerStatus(err.message || 'RobotStreamer restream failed — will retry.', 'error', 'bc-rsLiveStatus');
        console.warn('[RS Restream] Failed:', err.message);
        scheduleRobotStreamerReconnect(streamId);
        return null;
    }
}

/** Sentinel error class for graceful RS restream aborts (no reconnect needed) */
class _RSAbortError extends Error { constructor(msg) { super(msg); this.name = '_RSAbortError'; } }

function scheduleRobotStreamerReconnect(streamId) {
    const ss = getStreamState(streamId);
    if (!ss?.localStream || !canUseRobotStreamerRestream()) return;

    // Track short-lived sessions (connection lasted < RS_STABLE_CONNECTION_MS)
    const session = ss.robotStreamer;
    if (session?.connectedAt) {
        const sessionAge = Date.now() - session.connectedAt;
        if (sessionAge < RS_STABLE_CONNECTION_MS) {
            ss._rsConsecutiveShortLived = (ss._rsConsecutiveShortLived || 0) + 1;
        }
    }

    // Cancel stability timer since connection is being torn down
    if (ss._rsStabilityTimer) { clearTimeout(ss._rsStabilityTimer); ss._rsStabilityTimer = null; }

    // Give up after too many consecutive short-lived sessions
    if ((ss._rsConsecutiveShortLived || 0) >= RS_MAX_SHORT_LIVED_RETRIES) {
        console.warn(`[RS Restream] Giving up after ${ss._rsConsecutiveShortLived} consecutive short-lived sessions`);
        setRobotStreamerStatus(
            `RobotStreamer restream failed after ${ss._rsConsecutiveShortLived} attempts — click Retry to try again.`,
            'error', 'bc-rsLiveStatus'
        );
        ss._rsReconnectDelay = RS_RECONNECT_BASE_DELAY; // reset for manual retry
        return;
    }

    // Use stream-state-level delay so it persists across sessions
    const delay = ss._rsReconnectDelay || RS_RECONNECT_BASE_DELAY;
    const nextDelay = Math.min(delay * 1.5, RS_RECONNECT_MAX_DELAY);
    ss._rsReconnectDelay = nextDelay;

    console.log(`[RS Restream] Scheduling reconnect in ${delay}ms (attempt ${ss._rsConsecutiveShortLived || 0}/${RS_MAX_SHORT_LIVED_RETRIES}, next delay: ${nextDelay}ms)`);

    // Dedup: clear any previously scheduled reconnect for this stream
    if (ss._rsReconnectTimer) { clearTimeout(ss._rsReconnectTimer); ss._rsReconnectTimer = null; }
    if (session?.reconnectTimer) { clearTimeout(session.reconnectTimer); session.reconnectTimer = null; }

    const timer = setTimeout(async () => {
        ss._rsReconnectTimer = null;
        // Only reconnect if local stream is still live and RS is still enabled
        const currSs = getStreamState(streamId);
        if (!currSs?.localStream || !canUseRobotStreamerRestream()) return;
        console.log('[RS Restream] Attempting reconnect for stream', streamId);

        // Clean up old session
        await stopRobotStreamerRestream(streamId, { quiet: true }).catch(() => {});

        // Start fresh
        await startRobotStreamerRestream(streamId);
    }, delay);

    // Store timer on BOTH stream state and session for reliable dedup
    ss._rsReconnectTimer = timer;
    if (session) {
        session.reconnectTimer = timer;
    }
}

async function syncRobotStreamerTracks(streamId) {
    const ss = getStreamState(streamId);
    const session = ss?.robotStreamer;
    if (!session?.active || !ss?.localStream) return;
    const videoTrack = ss.localStream.getVideoTracks()[0] || null;
    const audioTrack = ss.localStream.getAudioTracks()[0] || null;

    // Check if producers are still usable — when a track ends, mediasoup closes
    // the producer and replaceTrack() will fail. Detect this and do a full restart.
    const isProducerDead = (p) => {
        if (!p) return false;
        try { return p.closed || p.track?.readyState === 'ended'; } catch { return true; }
    };

    if (isProducerDead(session.videoProducer) || isProducerDead(session.audioProducer)) {
        console.warn('[RS Restream] Producer(s) dead after track change — full restart needed');
        setRobotStreamerStatus('RobotStreamer restream restarting after track change…', 'warning', 'bc-rsLiveStatus');
        stopRobotStreamerRestream(streamId, { quiet: true })
            .catch(() => {})
            .then(() => startRobotStreamerRestream(streamId).catch(() => {}));
        return;
    }

    try {
        if (session.videoProducer && videoTrack) await session.videoProducer.replaceTrack({ track: videoTrack });
        else if (!session.videoProducer && videoTrack) session.videoProducer = await session.transport.produce({ track: videoTrack });

        if (session.audioProducer && audioTrack) await session.audioProducer.replaceTrack({ track: audioTrack });
        else if (!session.audioProducer && audioTrack) session.audioProducer = await session.transport.produce({ track: audioTrack });
    } catch (err) {
        console.warn('[RS Restream] Track sync failed:', err.message, '— restarting');
        setRobotStreamerStatus('RobotStreamer restream restarting…', 'warning', 'bc-rsLiveStatus');
        stopRobotStreamerRestream(streamId, { quiet: true })
            .catch(() => {})
            .then(() => startRobotStreamerRestream(streamId).catch(() => {}));
    }
}

async function stopRobotStreamerRestream(streamId, { quiet = false } = {}) {
    const ss = getStreamState(streamId);
    const session = ss?.robotStreamer;

    // Cancel any pending reconnect timer
    if (session?.reconnectTimer) { clearTimeout(session.reconnectTimer); session.reconnectTimer = null; }
    if (ss?._rsReconnectTimer) { clearTimeout(ss._rsReconnectTimer); ss._rsReconnectTimer = null; }

    // Clear the "starting" guard so a fresh start can proceed
    if (ss) ss._rsRestreamStarting = false;

    if (!session) return;

    session.intentionalClose = true;
    // Cancel stability timer
    if (ss._rsStabilityTimer) { clearTimeout(ss._rsStabilityTimer); ss._rsStabilityTimer = null; }
    try { session.videoProducer?.close?.(); } catch {}
    try { session.audioProducer?.close?.(); } catch {}
    try { session.transport?.close?.(); } catch {}
    try { session.ws?.close?.(1000); } catch {}
    ss.robotStreamer = null;

    if (!quiet) setRobotStreamerStatus('RobotStreamer restream stopped.', 'info', 'bc-rsLiveStatus');
}

/* ── Per-Stream Signaling ────────────────────────────────────── */

function connectSignaling(streamId) {
    const ss = getStreamState(streamId);
    if (!ss || !ss.streamData || !ss.localStream) return;

    // Clear any pending reconnect
    if (ss.signalingReconnectTimer) { clearTimeout(ss.signalingReconnectTimer); ss.signalingReconnectTimer = null; }

    // Close existing WS cleanly before creating a new one
    if (ss.signalingWs) {
        ss.signalingIntentionalClose = true;
        try { ss.signalingWs.close(); } catch {}
        ss.signalingWs = null;
    }

    const host = window.location.hostname;
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const portSuffix = window.location.port ? `:${window.location.port}` : '';
    const token = localStorage.getItem('token');
    const wsUrl = `${protocol}://${host}${portSuffix}/ws/broadcast?token=${token}&streamId=${ss.streamData.id}&role=broadcaster`;
    const ws = new WebSocket(wsUrl);
    ss.signalingWs = ws;
    ss.signalingIntentionalClose = false;

    ws.onopen = () => {
        console.log(`[Broadcast] Signaling connected for stream ${streamId}`);
        ss.signalingReconnectDelay = 3000; // reset backoff on successful connect
        // Clear stale SFU produce state — the server's SFU room is fresh after reconnect,
        // so any old producers are invalid and would cause "already-producing" false positives.
        if (_sfuProduceStates.has(streamId)) {
            console.log('[SFU Produce] Clearing stale produce state on signaling reconnect for stream', streamId);
            _cleanupSfuProduce(streamId);
        }
        _ensureSfuBroadcastReady(streamId, 'signaling-open');
        if (broadcastState.activeStreamId === streamId) updateBroadcastStatus('checking');
    };

    ws.onmessage = async (e) => {
        try { await handleSignalingMessage(streamId, JSON.parse(e.data)); }
        catch (err) { console.error('[Broadcast] Signaling message error:', err); }
    };

    ws.onerror = (err) => {
        console.error(`[Broadcast] Signaling error for stream ${streamId}`);
        if (broadcastState.activeStreamId === streamId) updateBroadcastStatus('error');
    };

    ws.onclose = (ev) => {
        console.log(`[Broadcast] Signaling closed for stream ${streamId} (code=${ev.code}, intentional=${ss.signalingIntentionalClose})`);
        // Only reconnect if this was NOT an intentional close and the stream is still active
        if (ss.signalingIntentionalClose) return;

        // If server reconnect is disabled, clean up the stream on signaling disconnect
        if (broadcastState.settings.serverReconnect === false) {
            if (broadcastState.activeStreamId === streamId) updateBroadcastStatus('disconnected');
            console.log(`[Broadcast] Server reconnect disabled — stopping stream ${streamId}`);
            toast('Server disconnected — stream stopped (auto-reconnect is off)', 'warning');
            cleanupStream(streamId);
            if (!isStreaming()) {
                hideBroadcastTabs(); clearGlobalDisplayTimers();
                setNavLiveIndicator(false); showStreamManager(); loadExistingStreams();
            }
            return;
        }

        if (broadcastState.streams.has(streamId) && ss.streamData) {
            const delay = ss.signalingReconnectDelay;
            ss.signalingReconnectDelay = Math.min(ss.signalingReconnectDelay * 1.5, 30000);
            console.log(`[Broadcast] Reconnecting signaling for stream ${streamId} in ${Math.round(delay)}ms`);
            if (broadcastState.activeStreamId === streamId) {
                // Reconnecting, not dead — the server keeps the stream live during a grace
                // window, so show "Connecting…" rather than a scary "Disconnected".
                updateBroadcastStatus('checking');
                toast('Server disconnected — reconnecting...', 'warning');
            }
            ss.signalingReconnectTimer = setTimeout(() => {
                ss.signalingReconnectTimer = null;
                if (broadcastState.streams.has(streamId)) connectSignaling(streamId);
            }, delay);
        }
    };
}

async function createViewerConnection(streamId, viewerPeerId) {
    const ss = getStreamState(streamId);
    if (!ss) return;
    if (!ss._allowP2pFallback) {
        console.warn(`[Broadcast] Ignoring createViewerConnection(${streamId}, ${viewerPeerId}) — SFU-only mode is active`);
        return;
    }
    if (ss.viewerConnections.has(viewerPeerId)) closeViewerConnection(streamId, viewerPeerId);
    const s = broadcastState.settings;
    const maxBitrate = getTargetVideoBitrate();
    const maxFrameRate = getBroadcastFrameRate();
    const scaleDownBy = getSuggestedScaleDown(s);
    // Use server-provided ICE servers (with TURN support) if available
    const iceServers = (ss._serverIceServers && ss._serverIceServers.length > 0)
        ? ss._serverIceServers
        : [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
    const pc = new RTCPeerConnection({ iceServers });
    ss.viewerConnections.set(viewerPeerId, pc);
    ss.localStream.getTracks().forEach(track => {
        try {
            track.contentHint = track.kind === 'audio' ? 'speech' : (s.screenShare ? 'detail' : 'motion');
        } catch {}
        pc.addTrack(track, ss.localStream);
    });

    pc.getTransceivers().forEach(t => {
        if (t.sender?.track?.kind === 'video') {
            try { t.direction = 'sendonly'; } catch {}
            try { t.setCodecPreferences?.((RTCRtpReceiver.getCapabilities('video')?.codecs || []).filter(Boolean)); } catch {}
        }
    });

    const codec = s.broadcastCodec || 'auto';
    if (codec !== 'auto' && pc.getTransceivers) {
        const vt = pc.getTransceivers().find(t => t.sender?.track?.kind === 'video');
        if (vt && typeof vt.setCodecPreferences === 'function') {
            try {
                const codecs = RTCRtpReceiver.getCapabilities('video')?.codecs || [];
                const mimeMap = { vp8: 'video/VP8', vp9: 'video/VP9', h264: 'video/H264' };
                const pref = codecs.filter(c => c.mimeType === mimeMap[codec]);
                const rest = codecs.filter(c => c.mimeType !== mimeMap[codec]);
                if (pref.length) vt.setCodecPreferences([...pref, ...rest]);
            } catch {}
        }
    }

    pc.getSenders().forEach(sender => {
        if (sender.track?.kind === 'video') {
            const params = sender.getParameters(); if (!params.encodings) params.encodings = [{}];
            params.encodings[0].maxBitrate = maxBitrate;
            params.encodings[0].maxFramerate = maxFrameRate;
            params.encodings[0].scaleResolutionDownBy = scaleDownBy;
            params.encodings[0].priority = 'high';
            const minBps = parseInt(s.broadcastBpsMin); if (minBps > 50) params.encodings[0].minBitrate = minBps * 1000;
            params.degradationPreference = s.screenShare ? 'maintain-resolution' : 'balanced';
            sender.setParameters(params).catch(() => {});
        } else if (sender.track?.kind === 'audio') {
            const params = sender.getParameters();
            if (!params.encodings) params.encodings = [{}];
            params.encodings[0].priority = 'high';
            sender.setParameters(params).catch(() => {});
        }
    });

    pc.onicecandidate = (e) => { if (e.candidate) sendBroadcastSignal(ss, { type: 'ice-candidate', candidate: e.candidate, targetPeerId: viewerPeerId }); };
    pc.oniceconnectionstatechange = () => {
        const iceState = pc.iceConnectionState;
        console.log(`[Broadcast] Stream ${streamId} viewer ${viewerPeerId} ICE state: ${iceState}`);
        if (iceState === 'connected' || iceState === 'completed') clearViewerReconnectTimer(ss, viewerPeerId);
        if (iceState === 'failed' || iceState === 'disconnected') {
            scheduleViewerReconnect(streamId, viewerPeerId, iceState === 'failed' ? 1500 : 4000);
        }
        if (iceState === 'closed') {
            closeViewerConnection(streamId, viewerPeerId);
        }
        if (broadcastState.activeStreamId === streamId) updateBroadcastStatusFromConnections(streamId);
    };

    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    sendBroadcastSignal(ss, { type: 'offer', sdp: pc.localDescription, targetPeerId: viewerPeerId });
}

function closeViewerConnection(streamId, viewerPeerId) {
    const ss = getStreamState(streamId);
    if (!ss) return;
    clearViewerReconnectTimer(ss, viewerPeerId);
    const pc = ss.viewerConnections.get(viewerPeerId);
    if (pc) { try { pc.close(); } catch {} ss.viewerConnections.delete(viewerPeerId); }
}

function updateBroadcastStatusFromConnections(streamId) {
    const ss = getStreamState(streamId);
    if (!ss) return;
    if (broadcastState.activeStreamId !== streamId) return; // Only update UI for active stream
    const signalingOpen = ss.signalingWs?.readyState === WebSocket.OPEN;
    const sfuState = _sfuProduceStates.get(streamId);
    const sfuConnState = sfuState?.transport?.connectionState;
    const hasHealthySfu = !!(sfuState && (sfuConnState === 'connected' || sfuConnState === 'completed' || sfuState.videoProducer || sfuState.audioProducer));

    if (hasHealthySfu) {
        updateBroadcastStatus('connected');
        return;
    }

    if (ss._allowP2pFallback && ss.viewerConnections.size > 0) {
        let hasConnectedP2p = false;
        for (const [, pc] of ss.viewerConnections) {
            const state = pc.iceConnectionState;
            if (state === 'connected' || state === 'completed') {
                hasConnectedP2p = true;
                break;
            }
        }
        updateBroadcastStatus(hasConnectedP2p ? 'connected' : (signalingOpen ? 'checking' : 'disconnected'));
        return;
    }

    updateBroadcastStatus(signalingOpen ? 'checking' : 'disconnected');
}

/* ── SFU Produce for Server-Side Restreaming ─────────────────── */
// When the server needs WebRTC → RTMP restreaming, it asks the broadcaster
// to produce tracks into the Mediasoup SFU via the signaling WebSocket.
// This is similar to the RS restream flow but targets our own SFU.

/** Per-stream SFU produce state */
const _sfuProduceStates = new Map();

/** Pending SFU message resolvers, keyed by streamId */
const _sfuPendingMessages = new Map();

function _resolveSfuMessage(streamId, msg) {
    const pending = _sfuPendingMessages.get(streamId);
    if (!pending?.length) return;
    // Find the first pending handler that matches this message type
    const idx = pending.findIndex(p => p.type === msg.type);
    if (idx >= 0) {
        const handler = pending.splice(idx, 1)[0];
        if (msg.type === 'sfu-error') handler.reject(new Error(msg.error || 'SFU error'));
        else handler.resolve(msg);
    }
}

function _waitForSfuMessage(streamId, type, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        if (!_sfuPendingMessages.has(streamId)) _sfuPendingMessages.set(streamId, []);
        const pending = _sfuPendingMessages.get(streamId);
        const timer = setTimeout(() => {
            const idx = pending.findIndex(p => p.id === id);
            if (idx >= 0) pending.splice(idx, 1);
            reject(new Error(`SFU message timeout: ${type}`));
        }, timeoutMs);
        const id = Math.random();
        // Also listen for sfu-error as a rejection for any pending request
        pending.push({ id, type, resolve: (msg) => { clearTimeout(timer); resolve(msg); }, reject: (err) => { clearTimeout(timer); reject(err); } });
        pending.push({ id: id + 0.1, type: 'sfu-error', resolve: () => {}, reject: (err) => {
            clearTimeout(timer);
            const idx2 = pending.findIndex(p => p.id === id);
            if (idx2 >= 0) { pending.splice(idx2, 1); }
            reject(err);
        }});
    });
}

async function _handleSfuProduceRequest(streamId) {
    const ss = getStreamState(streamId);
    if (!ss?.localStream || !ss?.signalingWs) {
        console.warn('[SFU Produce] No local stream or signaling — cannot produce');
        sendBroadcastSignal(ss, { type: 'sfu-produce-status', status: 'skipped', detail: !ss?.localStream ? 'no-localStream' : 'no-signalingWs' });
        return;
    }

    // Already producing?
    if (_sfuProduceStates.has(streamId)) {
        console.log('[SFU Produce] Already producing for stream', streamId);
        sendBroadcastSignal(ss, { type: 'sfu-produce-status', status: 'already-producing' });
        return;
    }

    console.log('[SFU Produce] Starting SFU produce for stream', streamId);
    const state = { active: true, transport: null, videoProducer: null, audioProducer: null };
    _sfuProduceStates.set(streamId, state);

    try {
        // Step 1: Load mediasoup-client (reuse the same loader as RS restream)
        const mod = await loadRobotStreamerMediasoup();
        const Device = mod.Device || mod.default?.Device;
        if (!Device) throw new Error('mediasoup-client failed to load');

        // Step 2: Get router capabilities from our SFU
        if (!sendBroadcastSignal(ss, { type: 'sfu-get-capabilities' })) {
            throw new Error('signaling WS not open — cannot send sfu-get-capabilities');
        }
        const capsMsg = await _waitForSfuMessage(streamId, 'sfu-capabilities');

        const device = new Device();
        await device.load({ routerRtpCapabilities: capsMsg.rtpCapabilities });

        // Step 3: Create send transport
        sendBroadcastSignal(ss, { type: 'sfu-create-transport' });
        const transportMsg = await _waitForSfuMessage(streamId, 'sfu-transport-created');

        const transport = device.createSendTransport({
            id: transportMsg.id,
            iceParameters: transportMsg.iceParameters,
            iceCandidates: transportMsg.iceCandidates,
            dtlsParameters: transportMsg.dtlsParameters,
            iceServers: transportMsg.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }],
        });
        state.transport = transport;

        console.log('[SFU Produce] Transport created — ICE candidates from server:', JSON.stringify(transportMsg.iceCandidates));
        console.log('[SFU Produce] ICE servers:', JSON.stringify(transportMsg.iceServers?.map(s => s.urls)));
        console.log('[SFU Produce] ICE parameters:', JSON.stringify(transportMsg.iceParameters));
        console.log('[SFU Produce] DTLS parameters:', JSON.stringify(transportMsg.dtlsParameters));

        // Hook into the internal RTCPeerConnection for ICE diagnostics
        try {
            const pc = transport._handler?._pc;
            if (pc) {
                pc.addEventListener('iceconnectionstatechange', () => {
                    console.log('[SFU Produce] PC iceConnectionState:', pc.iceConnectionState);
                });
                pc.addEventListener('icegatheringstatechange', () => {
                    console.log('[SFU Produce] PC iceGatheringState:', pc.iceGatheringState);
                });
                pc.addEventListener('icecandidate', (e) => {
                    console.log('[SFU Produce] PC icecandidate:', e.candidate ? e.candidate.candidate : 'null (gathering done)');
                });
                pc.addEventListener('signalingstatechange', () => {
                    console.log('[SFU Produce] PC signalingState:', pc.signalingState);
                });
                console.log('[SFU Produce] PC initial state — signaling:', pc.signalingState, 'ice:', pc.iceConnectionState, 'gathering:', pc.iceGatheringState);
            } else {
                console.log('[SFU Produce] Cannot access internal PC (handler not ready yet)');
            }
        } catch (e) {
            console.log('[SFU Produce] Could not hook PC events:', e.message);
        }

        transport.on('connect', ({ dtlsParameters }, callback, errback) => {
            sendBroadcastSignal(ss, {
                type: 'sfu-connect-transport',
                transportId: transport.id,
                dtlsParameters,
            });
            _waitForSfuMessage(streamId, 'sfu-transport-connected')
                .then(() => callback())
                .catch(errback);
        });

        transport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
            sendBroadcastSignal(ss, {
                type: 'sfu-produce',
                transportId: transport.id,
                kind,
                rtpParameters,
            });
            _waitForSfuMessage(streamId, 'sfu-produced')
                .then((msg) => callback({ id: msg.id }))
                .catch(errback);
        });

        transport.on('connectionstatechange', (connState) => {
            console.log('[SFU Produce] Transport state:', connState);
            if (connState === 'connected') {
                console.log('[SFU Produce] Transport connected — RTP data flowing to SFU');
            }
            // Drive the broadcaster status label off the REAL ingest transport state,
            // not just the signaling socket — otherwise it stays stuck on "Connecting…".
            updateBroadcastStatusFromConnections(streamId);
            if (connState === 'failed' || connState === 'closed') {
                // Log ICE/DTLS stats before cleanup for debugging
                try {
                    transport.getStats().then(stats => {
                        stats.forEach(s => {
                            if (s.type === 'transport' || s.type === 'candidate-pair' || s.type === 'local-candidate' || s.type === 'remote-candidate') {
                                console.log(`[SFU Produce] Transport stats (${s.type}):`, JSON.stringify(s));
                            }
                        });
                    }).catch(() => {});
                } catch {}
                _cleanupSfuProduce(streamId);
            }
        });

        // Step 4: Produce video + audio tracks
        const videoTrack = ss.localStream.getVideoTracks()[0];
        const audioTrack = ss.localStream.getAudioTracks()[0];

        if (videoTrack) {
            state.videoProducer = await transport.produce({ track: videoTrack, stopTracks: false });
            console.log('[SFU Produce] Video producer:', state.videoProducer.id);
        }
        if (audioTrack) {
            state.audioProducer = await transport.produce({ track: audioTrack, stopTracks: false });
            console.log('[SFU Produce] Audio producer:', state.audioProducer.id);
        }

        console.log('[SFU Produce] Producing into local SFU for stream', streamId);

        // Producers now exist — reflect "live" in the status label immediately,
        // even if the transport 'connected' event already fired before this point.
        updateBroadcastStatusFromConnections(streamId);

        // Log internal PC state after producing (PC is now fully set up)
        try {
            const pc = transport._handler?._pc;
            if (pc) {
                console.log('[SFU Produce] Post-produce PC state — signaling:', pc.signalingState, 'ice:', pc.iceConnectionState, 'gathering:', pc.iceGatheringState, 'connection:', pc.connectionState);
                const localDesc = pc.localDescription;
                const remoteDesc = pc.remoteDescription;
                console.log('[SFU Produce] Local SDP type:', localDesc?.type, 'Remote SDP type:', remoteDesc?.type);
                if (remoteDesc?.sdp) {
                    // Log ICE-related lines from remote SDP
                    const iceLines = remoteDesc.sdp.split('\n').filter(l => l.startsWith('a=candidate') || l.startsWith('a=ice-'));
                    console.log('[SFU Produce] Remote SDP ICE lines:', iceLines.join(' | '));
                }
            }
        } catch (e) {
            console.log('[SFU Produce] Could not log post-produce PC state:', e.message);
        }

        sendBroadcastSignal(ss, { type: 'sfu-produce-status', status: 'ok', detail: `video=${!!state.videoProducer} audio=${!!state.audioProducer}` });
    } catch (err) {
        console.error('[SFU Produce] Failed:', err.message);
        sendBroadcastSignal(ss, { type: 'sfu-produce-status', status: 'error', error: err.message });
        _cleanupSfuProduce(streamId);
    }
}

function _cleanupSfuProduce(streamId) {
    const state = _sfuProduceStates.get(streamId);
    if (!state) return;

    state.active = false;
    if (state.videoProducer) { try { state.videoProducer.close(); } catch {} }
    if (state.audioProducer) { try { state.audioProducer.close(); } catch {} }
    if (state.transport) { try { state.transport.close(); } catch {} }
    _sfuProduceStates.delete(streamId);
    _sfuPendingMessages.delete(streamId);

    // Notify server we stopped producing
    const ss = getStreamState(streamId);
    if (ss) sendBroadcastSignal(ss, { type: 'sfu-stop-produce' });

    console.log('[SFU Produce] Cleaned up for stream', streamId);
}

/**
 * Replace video/audio tracks in the local SFU mediasoup producers after a live track switch.
 * This ensures server-side SFU consumers (VOD restream, etc.) receive the updated tracks.
 * Called after any track switch — camera, mic, screen share toggle, etc.
 */
async function _syncSfuProducerTracks(streamId) {
    const ss = getStreamState(streamId);
    if (!ss?.localStream) return;
    const state = _sfuProduceStates.get(streamId);
    if (!state?.active) return;
    const videoTrack = ss.localStream.getVideoTracks()[0] || null;
    const audioTrack = ss.localStream.getAudioTracks()[0] || null;
    if (state.videoProducer && videoTrack) {
        try {
            await state.videoProducer.replaceTrack({ track: videoTrack });
            console.log('[SFU] Video producer track replaced');
        } catch (e) {
            console.warn('[SFU] Video replaceTrack failed:', e.message);
        }
    }
    if (state.audioProducer && audioTrack) {
        try {
            await state.audioProducer.replaceTrack({ track: audioTrack });
            console.log('[SFU] Audio producer track replaced');
        } catch (e) {
            console.warn('[SFU] Audio replaceTrack failed:', e.message);
        }
    }
}

/**
 * Show a non-blocking UI warning when the browser attaches a different device
 * than was explicitly requested. Does not block the stream — just informs the user.
 */
function _warnDeviceMismatch(kind) {
    const label = kind === 'camera' ? 'camera' : 'microphone';
    console.warn(`[Broadcast] Device mismatch: browser may have attached a different ${label} than selected.`);
    // Show a non-intrusive info toast (not an error — stream is still live)
    toast(
        `Note: Chrome may not have used your selected ${label}. If the wrong device is active, try selecting it again or change Chrome’s site settings for this page.`,
        'info'
    );
}

/**
 * Re-enumerate devices and warn if the currently active device has been unplugged.
 * Called automatically on 'devicechange' events.
 */
async function _checkActiveDevicePresence() {
    const ss = getActiveStreamState();
    if (!ss?.localStream) return;
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoIds = new Set(devices.filter(d => d.kind === 'videoinput').map(d => d.deviceId));
        const audioIds = new Set(devices.filter(d => d.kind === 'audioinput').map(d => d.deviceId));
        const vt = ss.localStream.getVideoTracks()[0];
        const at = ss.localStream.getAudioTracks()[0];
        if (vt && vt.readyState !== 'ended') {
            const activeCam = vt.getSettings().deviceId;
            if (activeCam && activeCam !== 'default' && !videoIds.has(activeCam)) {
                console.warn('[Broadcast] Active camera device removed from system:', activeCam);
                toast('Camera device unplugged. Select a replacement camera to continue broadcasting.', 'error');
            }
        }
        if (at && at.readyState !== 'ended') {
            const activeMic = at.getSettings().deviceId;
            if (activeMic && activeMic !== 'default' && !audioIds.has(activeMic)) {
                console.warn('[Broadcast] Active microphone device removed from system:', activeMic);
                toast('Microphone device unplugged. Select a replacement mic to continue broadcasting.', 'error');
            }
        }
    } catch { /* non-critical */ }
}

/**
 * Rebuild the screen-share audio mix when the user changes mic during screen share.
 * Stops the old mic stream, acquires the new one, and re-mixes with desktop audio.
 * Propagates the new audio track to all viewer connections and SFU producers.
 */
async function _rebuildScreenShareAudio(audioId, streamId) {
    const ss = getStreamState(streamId);
    if (!ss || !ss._screenStream) return;
    const screenAudioTracks = ss._screenStream.getAudioTracks();

    // Stop existing mic stream
    if (ss._micStream) {
        ss._micStream.getTracks().forEach(t => t.stop());
        ss._micStream = null;
    }
    // The mixer keeps its output track across a device swap — see _ensureAudioMixer.

    // Acquire the new mic (if audioId is not null and mic is enabled)
    let newMicStream = null;
    if (audioId && ss._micEnabled) {
        const audioConstraints = buildAudioConstraints(broadcastState.settings, audioId);
        try {
            newMicStream = await _getUserMediaWithTimeout({ audio: audioConstraints, video: false });
            // Verify the device was attached correctly
            const appliedMic = newMicStream.getAudioTracks()[0]?.getSettings?.().deviceId;
            if (audioId !== 'default' && appliedMic && appliedMic !== audioId) {
                console.warn('[Broadcast] Screen share mic mismatch: requested', audioId, 'got', appliedMic);
                _warnDeviceMismatch('mic');
            }
        } catch (err) {
            // Exact constraint rejected — retry soft
            if ((err.name === 'OverconstrainedError' || err.name === 'NotFoundError') && audioId !== 'default') {
                const softAudio = buildAudioConstraints(broadcastState.settings, audioId, { soft: true });
                try { newMicStream = await _getUserMediaWithTimeout({ audio: softAudio, video: false }); _warnDeviceMismatch('mic'); } catch {}
            }
        }
    }

    // Point the mixer at the new device. Its OUTPUT track is unchanged, so viewers, the
    // VOD recorder and every restream carry on with the track they already hold — a mic
    // swap mid-stream is now inaudible as a glitch rather than a silent failure.
    _ensureAudioMixer(ss);
    if (screenAudioTracks.length > 0) _mixSetSource(ss, 'desktop', new MediaStream(screenAudioTracks));
    _mixSetSource(ss, 'mic', newMicStream);
    ss._micStream = newMicStream;

    const finalAudioTrack = _mixOutputTrack(ss);
    if (!finalAudioTrack) {
        if (!newMicStream) toast('Could not acquire microphone for screen share', 'error');
        return;
    }

    // Only touches anything on the one-off migration from a pre-mixer session.
    const published = ss.localStream?.getAudioTracks()[0] || null;
    if (published !== finalAudioTrack && ss.localStream) {
        if (published) ss.localStream.removeTrack(published);
        ss.localStream.addTrack(finalAudioTrack);
        _republishAudioTrack(streamId, finalAudioTrack);
    }
    toast(newMicStream ? 'Microphone updated (screen share mode)' : 'Microphone off (screen share mode)', 'success');
}

async function handleSignalingMessage(streamId, msg) {
    const ss = getStreamState(streamId);
    if (!ss) return;
    switch (msg.type) {
        case 'viewer-joined':
            if (!ss._allowP2pFallback) {
                console.warn(`[Broadcast] Ignoring legacy viewer-joined for stream ${streamId} — SFU-only mode is active`);
                break;
            }
            if (msg.peerId && ss.localStream) {
                // Skip re-negotiation if the existing peer connection is still healthy
                const existingPc = ss.viewerConnections.get(msg.peerId);
                if (existingPc) {
                    const state = existingPc.iceConnectionState;
                    if (state === 'connected' || state === 'completed') {
                        console.log(`[Broadcast] Stream ${streamId} viewer ${msg.peerId} already connected (ICE: ${state}), skipping re-negotiate`);
                        break;
                    }
                }
                await createViewerConnection(streamId, msg.peerId);
            }
            break;
        case 'viewer-left':
            if (ss._allowP2pFallback && msg.peerId) closeViewerConnection(streamId, msg.peerId);
            break;
        case 'answer':
            if (ss._allowP2pFallback) {
                const pc = ss.viewerConnections.get(msg.fromPeerId);
                if (pc && msg.sdp) await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
            } else {
                console.warn(`[Broadcast] Ignoring legacy answer for stream ${streamId} — SFU-only mode is active`);
            }
            break;
        case 'ice-candidate':
            if (ss._allowP2pFallback) {
                const pc = ss.viewerConnections.get(msg.fromPeerId);
                if (pc && msg.candidate) await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
            } else {
                console.warn(`[Broadcast] Ignoring legacy ice-candidate for stream ${streamId} — SFU-only mode is active`);
            }
            break;
        case 'viewer-count':
            _perStreamViewerCounts.set(streamId, msg.count || 0);
            _updateTabViewerCount(streamId, msg.count || 0);
            _updateTotalViewerCount();
            break;
        case 'welcome':
            console.log(`[Broadcast] Stream ${streamId} welcome:`, msg);
            // Store server-provided ICE servers (includes TURN if configured)
            if (msg.iceServers && Array.isArray(msg.iceServers)) {
                ss._serverIceServers = msg.iceServers;
            }
            ss._allowP2pFallback = !!msg.allowP2pFallback;
            break;
        case 'error': toast(msg.message || 'Broadcast error', 'error'); break;

        // ── SFU Produce (for server-side WebRTC → RTMP restreaming) ──
        case 'sfu-produce-request':
            // Server is asking us to produce our tracks into the Mediasoup SFU
            // so the restream manager can consume them via PlainRtpTransport
            _handleSfuProduceRequest(streamId).catch(err => {
                console.warn('[SFU Produce] Failed:', err.message);
            });
            break;
        case 'sfu-capabilities':
        case 'sfu-transport-created':
        case 'sfu-transport-connected':
        case 'sfu-produced':
        case 'sfu-error':
            // These are handled by the SFU produce flow's promise-based handlers
            _resolveSfuMessage(streamId, msg);
            break;
    }
}

/* ── UI Updates ──────────────────────────────────────────────── */

/** Per-stream viewer counts from signaling, keyed by streamId */
const _perStreamViewerCounts = new Map();
let _rsViewerCount = 0;
let _rsViewerPollTimer = null;
/** Platform viewer counts (Twitch, Kick, etc.) fetched from server */
let _platformViewerCount = 0;
let _platformViewerBreakdown = [];

function updateBroadcastStatus(state) {
    const el = document.getElementById('bc-connection-status'); if (!el) return;
    // Determine streaming method label from active stream
    const ss = getActiveStreamState();
    const proto = (ss?.streamData?.protocol || 'webrtc').toUpperCase();
    const map = {
        connected:    { text: proto,            cls: 'bc-status-good' },
        checking:     { text: 'Connecting…',    cls: 'bc-status-warn' },
        completed:    { text: proto,            cls: 'bc-status-good' },
        disconnected: { text: 'Disconnected',   cls: 'bc-status-bad'  },
        failed:       { text: 'Failed',          cls: 'bc-status-bad'  },
        error:        { text: 'Error',           cls: 'bc-status-bad'  },
        new:          { text: 'Starting…',       cls: 'bc-status-warn' },
    };
    const s = map[state] || { text: state, cls: '' };
    el.textContent = s.text; el.className = 'bc-connection-status ' + s.cls;

    // Disconnect alert banner
    if (state === 'disconnected' || state === 'failed') {
        showDisconnectAlert(state === 'failed' ? 'connection failed' : 'reconnecting...');
    } else if (state === 'connected' || state === 'completed') {
        dismissDisconnectAlert();
    }
}

function _updateTabViewerCount(streamId, count) {
    const badge = document.querySelector(`.bc-tab-viewers[data-stream-id="${streamId}"]`);
    if (badge) badge.innerHTML = `<i class="fa-solid fa-eye"></i> ${count}`;
}

function _updateTotalViewerCount() {
    let hsTotal = 0;
    for (const [, c] of _perStreamViewerCounts) hsTotal += c;
    const total = hsTotal + _rsViewerCount + _platformViewerCount;
    const el = document.getElementById('bc-viewer-count');
    if (el) el.textContent = total;
    // RS viewer count badge (show breakdown when RS viewers exist)
    const rsEl = document.getElementById('bc-rs-viewer-count');
    if (rsEl) {
        if (_rsViewerCount > 0) { rsEl.style.display = ''; rsEl.querySelector('strong').textContent = _rsViewerCount; }
        else rsEl.style.display = 'none';
    }
    // Platform viewer count badges (Twitch/Kick/YouTube)
    _updatePlatformViewerBadges();
}

/** Render platform viewer count badges (Twitch/Kick/YouTube) in the broadcaster info bar */
function _updatePlatformViewerBadges() {
    const container = document.getElementById('bc-platform-viewer-badges');
    if (!container) return;
    if (!_platformViewerBreakdown || _platformViewerBreakdown.length === 0) {
        container.innerHTML = '';
        return;
    }
    const platformIcons = { twitch: 'fa-brands fa-twitch', kick: 'fa-brands fa-kickstarter-k', youtube: 'fa-brands fa-youtube', custom: 'fa-solid fa-globe' };
    const platformColors = { twitch: '#9146ff', kick: '#53fc18', youtube: '#ff0000', custom: '#888' };
    let html = '';
    for (const entry of _platformViewerBreakdown) {
        const icon = platformIcons[entry.platform] || platformIcons.custom;
        const color = platformColors[entry.platform] || platformColors.custom;
        const name = entry.name || entry.platform;
        const countDisplay = entry.count != null ? `<strong>${entry.count}</strong>` : `<strong style="opacity:0.6">N/A</strong>`;
        html += `<div class="bc-info-item" style="color:${color}"><i class="${icon}"></i> ${countDisplay} on ${name}</div>`;
    }
    container.innerHTML = html;
}

async function _startRsViewerPoll() {
    _stopRsViewerPoll();
    // Wait for RS integration to load before checking enabled/robotId
    if (_robotStreamerIntegrationPromise) {
        try { await _robotStreamerIntegrationPromise; } catch {}
    }
    const rs = broadcastState.robotStreamer;
    if (!rs?.enabled || !rs?.robotId) return;
    const poll = async () => {
        try {
            const data = await api('/robotstreamer/integration/validate', { method: 'POST', body: { robot_input: rs.robotId } });
            const robots = data.integration?.available_robots || [];
            const robot = robots.find(r => String(r.robot_id) === String(rs.robotId));
            _rsViewerCount = robot ? Number(robot.viewers || 0) : 0;
        } catch { _rsViewerCount = 0; }
        _updateTotalViewerCount();
    };
    poll();
    _rsViewerPollTimer = setInterval(poll, 60000);
}

function _stopRsViewerPoll() {
    if (_rsViewerPollTimer) { clearInterval(_rsViewerPollTimer); _rsViewerPollTimer = null; }
    _rsViewerCount = 0;
}

/* ── Restream Platform Viewer Count Polling ───────────────────── */
// Server polls Kick/Twitch APIs directly (official API with OAuth tokens).
// Client only fetches the aggregated counts from our server.
let _restreamViewerPollTimer = null;

function _startRestreamViewerPoll() {
    _stopRestreamViewerPoll();
    // Poll every 60s, with initial 10s delay
    setTimeout(async () => {
        await _pollRestreamViewerCounts();
        _restreamViewerPollTimer = setInterval(_pollRestreamViewerCounts, 60000);
    }, 10000);
}

function _stopRestreamViewerPoll() {
    if (_restreamViewerPollTimer) { clearInterval(_restreamViewerPollTimer); _restreamViewerPollTimer = null; }
    _platformViewerCount = 0;
    _platformViewerBreakdown = [];
}

async function _pollRestreamViewerCounts() {
    if (!_restreamDestinations || _restreamDestinations.length === 0) return;

    // Fetch all platform viewer counts from server (Kick + Twitch + others)
    try {
        const data = await api('/restream/viewer-counts');
        _platformViewerCount = data?.total || 0;
        _platformViewerBreakdown = data?.breakdown || [];
    } catch {
        _platformViewerCount = 0;
        _platformViewerBreakdown = [];
    }
    _updateTotalViewerCount();
}

/* ── Broadcaster Controls ─────────────────────────────────────── */

/** Toggle broadcast page mobile chat bottom sheet */
let _bcMobileChatOpen = false;
function toggleBroadcastMobileChat() {
    const sidebar = document.getElementById('bc-chat-sidebar');
    const fab = document.getElementById('bc-mobile-chat-toggle');
    if (!sidebar) return;
    _bcMobileChatOpen = !_bcMobileChatOpen;
    sidebar.classList.toggle('mobile-chat-open', _bcMobileChatOpen);
    document.body.classList.toggle('mobile-chat-visible', _bcMobileChatOpen);
    if (fab) {
        const icon = fab.querySelector('i');
        if (icon) icon.className = _bcMobileChatOpen ? 'fa-solid fa-xmark' : 'fa-solid fa-comment';
    }
    if (_bcMobileChatOpen) {
        const msgs = document.getElementById('bc-chat-messages');
        if (msgs) msgs.scrollTop = msgs.scrollHeight;
        const badge = document.getElementById('bc-mobile-chat-badge');
        if (badge) { badge.style.display = 'none'; badge.textContent = '0'; }
    }
}
/** Show/hide the broadcast mobile chat FAB based on screen size and live state */
function updateBroadcastMobileChatFab() {
    const fab = document.getElementById('bc-mobile-chat-toggle');
    if (!fab) return;
    const isLive = broadcastState.streams.size > 0;
    const isMobile = window.innerWidth <= 768;
    // On mobile, chat sidebar stacks below main content and may be scrolled off screen.
    // Show the FAB so users can toggle it as an overlay.
    fab.style.display = (isLive && isMobile) ? 'flex' : 'none';
}

/** Detect if the broadcast preview video is vertical and toggle a class on the container */
function _detectBroadcastVerticalPreview(stream) {
    const container = document.querySelector('.bc-video-container');
    if (!container || !stream) return;
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) return;
    const settings = videoTrack.getSettings();
    if (settings.width && settings.height) {
        container.classList.toggle('bc-vertical-preview', settings.height > settings.width);
    }
}

/** Re-detect vertical preview for the currently active stream */
function _refreshVerticalPreview() {
    try {
        const ss = getActiveStreamState();
        if (ss?.localStream) _detectBroadcastVerticalPreview(ss.localStream);
    } catch { /* ignore if no active stream */ }
}

/* ── Orientation & Resize Listeners for Camera Rotation ──── */
(function _initOrientationHandlers() {
    // Re-enumerate devices when hardware is connected/disconnected.
    // Preserves the desired selection and warns if the active device disappears.
    if (navigator.mediaDevices && !navigator.mediaDevices._openvibeDevicechangeListening) {
        navigator.mediaDevices._openvibeDevicechangeListening = true;
        navigator.mediaDevices.addEventListener('devicechange', async () => {
            console.log('[Broadcast] Device change detected — re-enumerating devices');
            await populateDeviceLists().catch(() => {});
            await _checkActiveDevicePresence();
        });
    }
    // Listen for device orientation changes (mobile rotation)
    if ('orientation' in screen) {
        try {
            screen.orientation.addEventListener('change', () => {
                _refreshVerticalPreview();
                updateBroadcastMobileChatFab();
            });
        } catch { /* orientation API not supported */ }
    }
    // Fallback: legacy orientationchange event
    window.addEventListener('orientationchange', () => {
        // Delay slightly — track dimensions may take a moment to update
        setTimeout(() => {
            _refreshVerticalPreview();
            updateBroadcastMobileChatFab();
        }, 300);
    });
    // Also re-check on window resize
    let _resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(_resizeTimer);
        _resizeTimer = setTimeout(() => {
            _refreshVerticalPreview();
            updateBroadcastMobileChatFab();
        }, 200);
    });
})();

function closeCameraSwitcher() {
    const sheet = document.getElementById('bc-camera-sheet');
    if (sheet) sheet.style.display = 'none';
}

function _renderCameraSwitcherChoices(devices, activeCameraId) {
    const list = document.getElementById('bc-camera-sheet-list');
    if (!list) return;
    list.innerHTML = '';

    const options = [{ deviceId: 'default', label: 'System Default Camera', _default: true }, ...devices];
    options.forEach((device, index) => {
        const current = (activeCameraId || 'default') === device.deviceId;
        const meta = device._default
            ? { icon: 'fa-solid fa-wand-magic-sparkles', title: 'Default Camera', detail: 'Let the browser choose the preferred camera for this device.' }
            : _describeCameraRole(device, index - 1);
        const titleText = device._default ? 'System Default Camera' : (device.label || meta.title);
        const subtitleText = device._default ? meta.detail : `${meta.title} • ${meta.detail}`;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = `bc-camera-choice${current ? ' is-active' : ''}`;
        button.innerHTML = `
            <span class="bc-camera-choice-icon"><i class="${meta.icon}"></i></span>
            <span class="bc-camera-choice-body">
                <span class="bc-camera-choice-title">
                    <span>${titleText}</span>
                    ${current ? '<span class="bc-camera-choice-badge">Live</span>' : ''}
                </span>
                <span class="bc-camera-choice-subtitle">${subtitleText}</span>
            </span>
            <span class="bc-camera-choice-arrow"><i class="fa-solid fa-chevron-right"></i></span>
        `;
        button.addEventListener('click', () => chooseBroadcastCamera(device.deviceId, button));
        list.appendChild(button);
    });
}

async function openCameraSwitcher() {
    const sheet = document.getElementById('bc-camera-sheet');
    const list = document.getElementById('bc-camera-sheet-list');
    if (!sheet || !list) return;

    sheet.style.display = 'flex';
    list.innerHTML = '<div class="bc-camera-sheet-empty"><i class="fa-solid fa-spinner fa-spin"></i><span>Loading cameras…</span></div>';

    try {
        const devices = await _enumerateBroadcastVideoInputs({ ensureLabels: true });
        if (!devices.length) {
            list.innerHTML = '<div class="bc-camera-sheet-empty"><i class="fa-solid fa-camera-slash"></i><span>No cameras detected.</span></div>';
            return;
        }
        const ss = getActiveStreamState();
        const activeTrack = ss?.localStream?.getVideoTracks?.()[0] || null;
        const activeCameraId = activeTrack?.getSettings?.().deviceId || _getPreferredCameraId();
        _renderCameraSwitcherChoices(devices, activeCameraId);
    } catch (err) {
        list.innerHTML = `<div class="bc-camera-sheet-empty"><i class="fa-solid fa-circle-exclamation"></i><span>${err.message || 'Could not load cameras.'}</span></div>`;
    }
}

/**
 * Switch the live audio track to a different device while streaming.
 */
async function _switchActiveAudio(audioId) {
    const ss = getActiveStreamState();
    const streamId = broadcastState.activeStreamId;
    if (!ss || !ss.localStream || !streamId) return;

    const s = broadcastState.settings;
    const isExplicit = audioId && audioId !== 'default';
    // Use exact constraint for explicit device selections so Chrome must use the chosen mic.
    const audioConstraints = buildAudioConstraints(s, audioId);
    let newStream;
    try {
        newStream = await _getUserMediaWithTimeout({ audio: audioConstraints, video: false });
    } catch (err) {
        // Exact constraint rejected — retry with soft and warn
        if ((err.name === 'OverconstrainedError' || err.name === 'NotFoundError') && isExplicit) {
            console.warn('[Broadcast] Exact mic constraint rejected, relaxing:', err.message);
            const softConstraints = buildAudioConstraints(s, audioId, { soft: true });
            try {
                newStream = await _getUserMediaWithTimeout({ audio: softConstraints, video: false });
                _warnDeviceMismatch('mic');
            } catch (softErr) {
                throw new Error('Could not access microphone: ' + softErr.message);
            }
        } else {
            throw new Error('Could not access microphone: ' + err.message);
        }
    }
    const newTrack = newStream.getAudioTracks()[0];
    if (!newTrack) { newStream.getTracks().forEach(t => t.stop()); throw new Error('No audio track returned'); }

    // Post-switch device verification
    if (isExplicit) {
        const appliedMic = newTrack.getSettings?.().deviceId;
        if (appliedMic && appliedMic !== audioId) {
            console.warn('[Broadcast] Mic mismatch after switch: requested', audioId, 'got', appliedMic);
            _warnDeviceMismatch('mic');
        }
    }

    // Stop old audio track
    const oldTrack = ss.localStream.getAudioTracks()[0];
    if (oldTrack) { oldTrack.stop(); ss.localStream.removeTrack(oldTrack); }
    ss.localStream.addTrack(newTrack);

    // Replace on all viewer connections, RobotStreamer, and SFU producers
    _replaceAllViewerTracks(streamId);

    // Apply manual gain if enabled
    applyManualGain(streamId);

    toast('Microphone switched', 'success');
}

async function _switchActiveCamera(cameraId) {
    const ss = getActiveStreamState();
    if (!ss || !ss.localStream) return;

    // Block live camera replacement during screen share — screen mode owns the video track.
    if (broadcastState.settings.screenShare) {
        toast('Camera selection saved. Turn off screen share to switch the live camera track.', 'info');
        return;
    }

    const videoTrack = ss.localStream.getVideoTracks()[0]; if (!videoTrack) return;
    const oldSettings = videoTrack.getSettings();
    const oldDeviceId = oldSettings.deviceId;
    if ((cameraId || 'default') === (oldDeviceId || 'default')) return;

    const devices = await _enumerateBroadcastVideoInputs({ ensureLabels: false });
    const chosenDevice = devices.find(d => d.deviceId === cameraId) || null;
    const facingHint = _getCameraFacingHint(chosenDevice) || oldSettings.facingMode || 'user';
    const trackWidth = oldSettings.width || 1280;
    const trackHeight = oldSettings.height || 720;
    const trackFrameRate = oldSettings.frameRate || getBroadcastFrameRate();

    const candidateConstraints = cameraId && cameraId !== 'default'
        ? [
            { video: { deviceId: { exact: cameraId }, width: { ideal: trackWidth }, height: { ideal: trackHeight }, frameRate: { ideal: trackFrameRate } } },
            { video: { deviceId: cameraId, width: { ideal: trackWidth }, height: { ideal: trackHeight }, frameRate: { ideal: trackFrameRate } } },
            { video: { deviceId: { ideal: cameraId }, facingMode: { ideal: facingHint }, width: { ideal: trackWidth }, height: { ideal: trackHeight }, frameRate: { ideal: trackFrameRate } } },
        ]
        : [
            { video: { facingMode: { ideal: facingHint }, width: { ideal: trackWidth }, height: { ideal: trackHeight }, frameRate: { ideal: trackFrameRate } } },
            { video: true },
        ];

    ss._suppressRecovery = true; // prevent track.ended from triggering recovery
    const suppressTimeout = setTimeout(() => { ss._suppressRecovery = false; }, 15000);
    videoTrack.stop();
    ss.localStream.removeTrack(videoTrack);

    try {
        let newStream = null;
        let lastError = null;
        for (const constraints of candidateConstraints) {
            try {
                newStream = await _getUserMediaWithTimeout(constraints);
                if (newStream?.getVideoTracks?.().length) break;
            } catch (err) {
                lastError = err;
            }
        }
        if (!newStream?.getVideoTracks?.().length) throw (lastError || new Error('Could not access the selected camera'));

        const newTrack = newStream.getVideoTracks()[0];
        ss.localStream.addTrack(newTrack);
        for (const [, pc] of ss.viewerConnections) {
            const sender = pc.getSenders().find(s => s.track === null || s.track?.kind === 'video');
            if (sender) sender.replaceTrack(newTrack);
        }
        syncRobotStreamerTracks(broadcastState.activeStreamId).catch(() => {});
        _syncSfuProducerTracks(broadcastState.activeStreamId).catch(() => {});
        const preview = document.getElementById('bc-video-preview'); if (preview) preview.srcObject = ss.localStream;
        _detectBroadcastVerticalPreview(ss.localStream);
        clearTimeout(suppressTimeout);
        ss._suppressRecovery = false;
        attachLocalStreamRecoveryHandlers(broadcastState.activeStreamId);
        const appliedDeviceId = newTrack.getSettings?.().deviceId || cameraId || 'default';
        // Warn if browser gave us a different camera than requested
        if (cameraId && cameraId !== 'default' && appliedDeviceId && appliedDeviceId !== cameraId) {
            console.warn('[Broadcast] Camera mismatch after switch: requested', cameraId, 'got', appliedDeviceId);
            _warnDeviceMismatch('camera');
        }
        _syncCameraSelectionUI(appliedDeviceId);
        toast('Camera switched', 'success');
    } catch (err) {
        console.error('[Broadcast] switch camera failed:', err);
        try {
            const recovery = await _getUserMediaWithTimeout({ video: { deviceId: oldDeviceId ? { ideal: oldDeviceId } : undefined, facingMode: { ideal: oldSettings.facingMode || 'user' }, width: { ideal: trackWidth }, height: { ideal: trackHeight }, frameRate: { ideal: trackFrameRate } } });
            const recoveryTrack = recovery.getVideoTracks()[0];
            ss.localStream.addTrack(recoveryTrack);
            for (const [, pc] of ss.viewerConnections) {
                const sender = pc.getSenders().find(s => s.track === null || s.track?.kind === 'video');
                if (sender) sender.replaceTrack(recoveryTrack);
            }
            syncRobotStreamerTracks(broadcastState.activeStreamId).catch(() => {});
            _syncSfuProducerTracks(broadcastState.activeStreamId).catch(() => {});
            const preview = document.getElementById('bc-video-preview'); if (preview) preview.srcObject = ss.localStream;
            _detectBroadcastVerticalPreview(ss.localStream);
            _syncCameraSelectionUI(oldDeviceId || 'default');
        } catch { /* truly stuck — no video track */ }
        clearTimeout(suppressTimeout);
        ss._suppressRecovery = false;
        attachLocalStreamRecoveryHandlers(broadcastState.activeStreamId);
        throw err;
    }
}

async function chooseBroadcastCamera(cameraId, buttonEl = null) {
    const previousCameraId = _getPreferredCameraId();
    const buttons = Array.from(document.querySelectorAll('#bc-camera-sheet .bc-camera-choice'));
    buttons.forEach(btn => btn.classList.add('is-loading'));
    if (buttonEl) buttonEl.classList.add('is-active');
    _syncCameraSelectionUI(cameraId);
    try {
        const ss = getActiveStreamState();
        if (ss?.localStream) await _switchActiveCamera(cameraId);
        closeCameraSwitcher();
    } catch (err) {
        _syncCameraSelectionUI(previousCameraId);
        toast('Could not switch camera: ' + (err.message || 'Unknown error'), 'error');
    } finally {
        buttons.forEach(btn => btn.classList.remove('is-loading'));
    }
}

async function flipCamera() {
    await openCameraSwitcher();
}

async function toggleScreenShare() {
    broadcastState.settings.screenShare = !broadcastState.settings.screenShare; saveBroadcastSettings();
    _syncScreenShareUI();
    const ss = getActiveStreamState();
    const streamId = broadcastState.activeStreamId;
    if (ss && ss.localStream && streamId) {
        try {
            await uploadVodRecording(streamId, { finalizeStream: false });
            ss._suppressRecovery = true;
            // Stop old tracks and composite
            _cleanupComposite(ss);
            ss.localStream.getTracks().forEach(t => t.stop());
            await startMediaCapture(streamId);
            startVodRecording(streamId);
            _replaceAllViewerTracks(streamId);
            ss._suppressRecovery = false;
            toast(broadcastState.settings.screenShare ? 'Screen share on' : 'Camera on', 'success');
        } catch (err) {
            ss._suppressRecovery = false;
            toast('Failed to switch: ' + err.message, 'error');
            broadcastState.settings.screenShare = !broadcastState.settings.screenShare; saveBroadcastSettings();
            _syncScreenShareUI();
        }
    }
}

/** Toggle camera PiP overlay during screen share */
async function toggleCameraOverlay() {
    const ss = getActiveStreamState();
    const streamId = broadcastState.activeStreamId;
    if (!ss || !broadcastState.settings.screenShare) {
        toast('Camera overlay only works during screen share', 'info');
        return;
    }
    ss._cameraOverlayEnabled = !ss._cameraOverlayEnabled;
    const btn = document.getElementById('bc-btn-cam-overlay');
    if (btn) btn.classList.toggle('bc-ctrl-btn-active', ss._cameraOverlayEnabled);
    if (ss.localStream && streamId) {
        try {
            await uploadVodRecording(streamId, { finalizeStream: false });
            ss._suppressRecovery = true;
            _cleanupComposite(ss);
            ss.localStream.getTracks().forEach(t => t.stop());
            if (ss._screenStream) { ss._screenStream.getTracks().forEach(t => t.stop()); ss._screenStream = null; }
            await startMediaCapture(streamId);
            startVodRecording(streamId);
            _replaceAllViewerTracks(streamId);
            ss._suppressRecovery = false;
            toast(ss._cameraOverlayEnabled ? 'Camera overlay on' : 'Camera overlay off', 'success');
        } catch (err) {
            ss._suppressRecovery = false;
            ss._cameraOverlayEnabled = !ss._cameraOverlayEnabled;
            if (btn) btn.classList.toggle('bc-ctrl-btn-active', ss._cameraOverlayEnabled);
            toast('Failed to toggle camera overlay: ' + err.message, 'error');
        }
    }
}

/** Replace live tracks across all active outputs (legacy P2P only when enabled, RobotStreamer, and SFU producers). */
function _replaceAllViewerTracks(streamId) {
    const ss = getStreamState(streamId);
    if (!ss || !ss.localStream) return;
    const nvt = ss.localStream.getVideoTracks()[0];
    const nat = ss.localStream.getAudioTracks()[0];
    if (ss._allowP2pFallback) {
        for (const [, pc] of ss.viewerConnections) {
            const vs = pc.getSenders().find(s => s.track?.kind === 'video' || s.track === null);
            if (vs && nvt) vs.replaceTrack(nvt);
            const as = pc.getSenders().find(s => s.track?.kind === 'audio');
            if (as && nat) as.replaceTrack(nat);
        }
    }
    syncRobotStreamerTracks(streamId).catch(() => {});
    // Also update the local SFU mediasoup producers so server-side consumers get the new tracks
    _syncSfuProducerTracks(streamId).catch(() => {});
}

/**
 * Start the PiP composite — draws screen + camera overlay onto a canvas.
 * Camera position is controlled by ss._pipX / _pipY / _pipW (fractions of canvas).
 */

/* ── Stable audio mixer ───────────────────────────────────────────────────────
   Every consumer of the broadcast audio binds to a track ONCE and keeps it:
   MediaRecorder snapshots its tracks at construction and never notices later
   ones, mediasoup Producers wrap a specific track, and viewer RTCPeerConnection
   senders hold their own reference. So the old approach — removeTrack/addTrack
   on ss.localStream whenever the mic toggled — changed nothing for anybody
   downstream: viewers kept hearing the previous track and the VOD kept
   recording it, silently, for the rest of the session.

   Instead, route all audio through one MediaStreamAudioDestinationNode. Its
   output track is created once and stays valid for the life of the context, so
   toggling the microphone is just connecting or disconnecting a source node and
   nothing downstream has to be told anything at all.
   ──────────────────────────────────────────────────────────────────────────── */

function _ensureAudioMixer(ss) {
    if (ss._audioMix) return ss._audioMix;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const dest = ctx.createMediaStreamDestination();
    // A zero-offset constant source keeps the graph running when nothing else is
    // connected, so the output track stays live (and silent) rather than ending
    // when the last real input goes away.
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.connect(dest);
    try { silence.start(); } catch { /* already started */ }
    ss._audioMix = { ctx, dest, silence, mic: null, desktop: null };
    return ss._audioMix;
}

/** Connect or disconnect one named input ('mic' | 'desktop'). Output track is untouched. */
function _mixSetSource(ss, key, stream) {
    const mix = _ensureAudioMixer(ss);
    if (mix[key]) {
        try { mix[key].node.disconnect(); } catch { /* */ }
        mix[key] = null;
    }
    if (stream && stream.getAudioTracks && stream.getAudioTracks().length) {
        try {
            const node = mix.ctx.createMediaStreamSource(stream);
            node.connect(mix.dest);
            mix[key] = { node, stream };
        } catch (err) {
            console.warn('[Broadcast] Could not add', key, 'to the audio mix:', err.message);
        }
    }
    return _mixOutputTrack(ss);
}

/** The one audio track the whole broadcast should ever publish. */
function _mixOutputTrack(ss) {
    try { return ss._audioMix?.dest.stream.getAudioTracks()[0] || null; } catch { return null; }
}

function _teardownAudioMixer(ss) {
    if (!ss?._audioMix) return;
    const mix = ss._audioMix;
    for (const key of ['mic', 'desktop']) {
        if (mix[key]) { try { mix[key].node.disconnect(); } catch { /* */ } }
    }
    try { mix.silence.stop(); } catch { /* */ }
    try { mix.ctx.close(); } catch { /* */ }
    ss._audioMix = null;
}

function _startPipComposite(ss, screenStream, screenTrack, camStream, finalAudioTrack, res) {
    const canvas = document.createElement('canvas');
    canvas.width = res.w; canvas.height = res.h;
    const ctx = canvas.getContext('2d');
    ss._compositeCanvas = canvas;
    ss._compositeCtx = ctx;

    // Hidden video elements for drawing
    const screenVid = document.createElement('video');
    screenVid.srcObject = screenStream; screenVid.muted = true; screenVid.playsInline = true; screenVid.play().catch(() => {});

    const camVid = document.createElement('video');
    camVid.srcObject = camStream; camVid.muted = true; camVid.playsInline = true; camVid.play().catch(() => {});

    const fps = getBroadcastFrameRate();
    const interval = 1000 / fps;
    let lastDraw = 0;

    function draw(now) {
        ss._compositeAnimFrame = requestAnimationFrame(draw);
        if (now - lastDraw < interval) return;
        lastDraw = now;

        // Draw screen full-canvas
        ctx.drawImage(screenVid, 0, 0, canvas.width, canvas.height);

        // Draw camera PiP if video is ready
        if (camVid.readyState >= 2) {
            const pw = Math.round(canvas.width * ss._pipW);
            const aspectRatio = camVid.videoHeight / camVid.videoWidth || 0.75;
            const ph = Math.round(pw * aspectRatio);
            const px = Math.round(canvas.width * ss._pipX);
            const py = Math.round(canvas.height * ss._pipY);

            // Rounded rectangle clip (with fallback for older browsers)
            const radius = 12;
            ctx.save();
            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(px, py, pw, ph, radius);
            } else {
                // Manual rounded rect fallback
                ctx.moveTo(px + radius, py);
                ctx.lineTo(px + pw - radius, py); ctx.arcTo(px + pw, py, px + pw, py + radius, radius);
                ctx.lineTo(px + pw, py + ph - radius); ctx.arcTo(px + pw, py + ph, px + pw - radius, py + ph, radius);
                ctx.lineTo(px + radius, py + ph); ctx.arcTo(px, py + ph, px, py + ph - radius, radius);
                ctx.lineTo(px, py + radius); ctx.arcTo(px, py, px + radius, py, radius);
            }
            ctx.clip();
            ctx.drawImage(camVid, px, py, pw, ph);
            ctx.restore();

            // Thin border
            ctx.strokeStyle = 'rgba(255,255,255,0.5)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(px, py, pw, ph, radius);
            } else {
                ctx.moveTo(px + radius, py);
                ctx.lineTo(px + pw - radius, py); ctx.arcTo(px + pw, py, px + pw, py + radius, radius);
                ctx.lineTo(px + pw, py + ph - radius); ctx.arcTo(px + pw, py + ph, px + pw - radius, py + ph, radius);
                ctx.lineTo(px + radius, py + ph); ctx.arcTo(px, py + ph, px, py + ph - radius, radius);
                ctx.lineTo(px, py + radius); ctx.arcTo(px, py, px + radius, py, radius);
            }
            ctx.stroke();
        }
    }
    ss._compositeAnimFrame = requestAnimationFrame(draw);

    // Capture composite as stream
    const compositeStream = canvas.captureStream(fps);
    if (finalAudioTrack) compositeStream.addTrack(finalAudioTrack);
    ss.localStream = compositeStream;
}

/** Sync screen share live controls (Mic toggle, Camera PiP button) for screen mode */
function _syncScreenShareLiveControls(ss) {
    const isScreen = broadcastState.settings.screenShare;
    const micBtn = document.getElementById('bc-btn-toggle-mic');
    const camBtn = document.getElementById('bc-btn-cam-overlay');

    // Show mic toggle only in screen share mode
    if (micBtn) {
        micBtn.style.display = isScreen ? '' : 'none';
        micBtn.classList.toggle('bc-ctrl-btn-active', !!(ss && ss._micEnabled));
        const icon = micBtn.querySelector('i');
        if (icon) {
            icon.className = (ss && ss._micEnabled) ? 'fas fa-microphone' : 'fas fa-microphone-slash';
        }
    }
    // Camera overlay button
    if (camBtn) {
        camBtn.style.display = isScreen ? '' : 'none';
        camBtn.classList.toggle('bc-ctrl-btn-active', !!(ss && ss._cameraOverlayEnabled));
    }
}

/** Toggle mic on/off during screen share */
async function toggleScreenShareMic() {
    const ss = getActiveStreamState();
    if (!ss || !broadcastState.settings.screenShare) return;

    if (ss._micEnabled) {
        // Disconnect the mic from the mix and release the device. The published track is
        // the mixer's output, which does not change — so viewers, the VOD recorder and
        // every restream keep the exact same track and simply stop hearing the mic.
        _mixSetSource(ss, 'mic', null);
        if (ss._micStream) {
            ss._micStream.getTracks().forEach(t => t.stop());
            ss._micStream = null;
        }
        ss._micEnabled = false;
        toast('Mic muted', 'info');
    } else {
        const s = broadcastState.settings;
        let micStream;
        try {
            micStream = await _getUserMediaWithTimeout({ audio: buildAudioConstraints(s, s.forceAudio), video: false });
        } catch (err) {
            toast('Could not access microphone: ' + err.message, 'error');
            return;
        }
        ss._micStream = micStream;
        _mixSetSource(ss, 'mic', micStream);

        // If capture began before a mixer existed (older session, or a path that published
        // a raw track), the published track is NOT the mixer output — swap it in once, and
        // tell the consumers that hold their own reference.
        const mixed = _mixOutputTrack(ss);
        const published = ss.localStream?.getAudioTracks()[0] || null;
        if (mixed && published !== mixed && ss.localStream) {
            if (published) ss.localStream.removeTrack(published);
            ss.localStream.addTrack(mixed);
            _republishAudioTrack(broadcastState.activeStreamId, mixed);
        }
        ss._micEnabled = true;
        toast('Mic unmuted', 'info');
    }
    _syncScreenShareLiveControls(ss);
}

/**
 * Push a new audio track to everything that captured its own reference.
 *
 * Only needed when the published track genuinely changes identity — with the mixer in
 * place that is a one-off migration, not the normal path. MediaRecorder cannot swap
 * tracks at all, so the VOD segment is rolled instead; the chunked uploader already
 * treats segments as independent, so this costs a segment boundary and nothing else.
 */
function _republishAudioTrack(streamId, track) {
    const ss = getStreamState(streamId);
    if (!ss || !track) return;

    // Local SFU producer
    try {
        const st = _sfuProduceStates.get(streamId);
        st?.audioProducer?.replaceTrack({ track }).catch((e) => console.warn('[Broadcast] SFU audio replaceTrack failed:', e.message));
    } catch { /* */ }

    // RobotStreamer producer
    try {
        ss.robotStreamer?.audioProducer?.replaceTrack({ track }).catch((e) => console.warn('[RS Restream] audio replaceTrack failed:', e.message));
    } catch { /* */ }

    // Direct viewer peer connections
    try {
        ss.viewerConnections?.forEach((pc) => {
            const sender = pc.getSenders?.().find(x => x.track && x.track.kind === 'audio');
            sender?.replaceTrack(track).catch(() => {});
        });
    } catch { /* */ }

    // VOD: MediaRecorder is bound to the tracks it was constructed with, so roll the
    // segment. uploadVodRecording({finalizeStream:false}) flushes what has been captured
    // so far without ending the recording server-side; startVodRecording() then opens a
    // fresh segment around the new track. The chunk uploader already treats segments as
    // independent units, so the cost is one segment boundary.
    (async () => {
        try {
            if (!ss.vodRecorder || ss.vodRecorder.state === 'inactive') return;
            console.log('[VOD] Rolling segment to pick up the new audio track');
            await uploadVodRecording(streamId, { finalizeStream: false });
            startVodRecording(streamId);
        } catch (e) { console.warn('[VOD] Could not roll segment for audio change:', e.message); }
    })();
}

/** Cleanup composite canvas + camera overlay resources */
function _cleanupComposite(ss) {
    if (ss._compositeAnimFrame) { cancelAnimationFrame(ss._compositeAnimFrame); ss._compositeAnimFrame = null; }
    if (ss._cameraOverlayStream) { ss._cameraOverlayStream.getTracks().forEach(t => t.stop()); ss._cameraOverlayStream = null; }
    _teardownAudioMixer(ss);
    if (ss._micStream) { ss._micStream.getTracks().forEach(t => t.stop()); ss._micStream = null; }
    ss._compositeCanvas = null;
    ss._compositeCtx = null;
}

/** Sync screen share button UI state */
function _syncScreenShareUI() {
    const active = broadcastState.settings.screenShare;
    const el = document.getElementById('bc-screenShare');
    if (el) el.checked = active;
    const btn = document.getElementById('bc-btn-screenshare');
    if (btn) btn.classList.toggle('bc-ctrl-btn-active', active);
    // Show/hide camera overlay button
    const camBtn = document.getElementById('bc-btn-cam-overlay');
    if (camBtn) camBtn.style.display = active ? '' : 'none';
    if (!active && camBtn) camBtn.classList.remove('bc-ctrl-btn-active');
}

/**
 * Sync which live-control buttons are visible/enabled based on the current active
 * stream's protocol.  Browser streams show Screen/Cam-PiP/Mic; RTMP/JSMPEG/WHIP do not.
 */
function syncBroadcastLiveButtonVisibility() {
    const isBrowser = !!(getActiveStreamState()?.localStream);
    const hasDisplayMedia = !!(navigator.mediaDevices?.getDisplayMedia);

    const screenBtn = document.getElementById('bc-btn-screenshare');
    const switchCamBtn = document.getElementById('bc-btn-switch-cam');

    if (screenBtn) {
        screenBtn.style.display = (isBrowser && hasDisplayMedia) ? '' : 'none';
        screenBtn.title = hasDisplayMedia ? 'Toggle screen share' : 'Screen sharing not supported in this browser';
    }
    if (switchCamBtn) {
        switchCamBtn.style.display = isBrowser ? '' : 'none';
    }
    // Mic / Cam PiP are further gated by _syncScreenShareLiveControls()
}

/**
 * Sync which live-control buttons are visible/enabled based on the current active
 * stream's protocol.  Browser streams show Screen/Cam-PiP/Mic; RTMP/JSMPEG/WHIP do not.
 */
function syncBroadcastLiveButtonVisibility() {
    const isBrowser = !!(getActiveStreamState()?.localStream);
    const hasDisplayMedia = !!(navigator.mediaDevices?.getDisplayMedia);

    const screenBtn = document.getElementById('bc-btn-screenshare');
    const switchCamBtn = document.getElementById('bc-btn-switch-cam');

    if (screenBtn) {
        screenBtn.style.display = (isBrowser && hasDisplayMedia) ? '' : 'none';
        screenBtn.title = hasDisplayMedia ? 'Toggle screen share' : 'Screen sharing not supported in this browser';
    }
    if (switchCamBtn) {
        switchCamBtn.style.display = isBrowser ? '' : 'none';
    }
    // Mic / Cam PiP are further gated by _syncScreenShareLiveControls()
}

function toggleBroadcastStats() { const el = document.getElementById('bc-stats-overlay'); if (el) el.style.display = el.style.display === 'none' ? 'flex' : 'none'; }

/* ── Group Call Controls ───────────────────────────────────────── */
let _broadcastCallMode = null;
let _broadcastCallPollTimer = null;

/**
 * Show the broadcast call panel and auto-join the streamer's voice channel.
 * Delegates to initBroadcastCallPanel() in call.js which handles the actual
 * WebRTC call setup and auto-join.
 */
function showBroadcastCallControls() {
    if (typeof initBroadcastCallPanel !== 'function') return;
    const streamId = broadcastState.activeStreamId;
    const mode = _broadcastCallMode || 'mic+cam';
    if (!streamId) return;
    initBroadcastCallPanel(streamId, mode);
    const panel = document.getElementById('bc-call-panel');
    if (panel) panel.style.display = '';
}

function hideBroadcastCallControls() {
    if (typeof leaveBroadcastCall === 'function') leaveBroadcastCall();
    const panel = document.getElementById('bc-call-panel');
    if (panel) panel.style.display = 'none';
}

function updateBroadcastCallUI() {
    // call.js handles its own UI rendering via _renderCallUI()
}

function onCallModeChange(mode) {
    _broadcastCallMode = mode || null;
    if (!mode) {
        hideBroadcastCallControls();
        return;
    }
    if (isStreaming()) {
        showBroadcastCallControls();
    }
}

function endBroadcastCall() {
    hideBroadcastCallControls();
}

function _startCallStatusPoll() {}
function _stopCallStatusPoll() {
    if (_broadcastCallPollTimer) { clearInterval(_broadcastCallPollTimer); _broadcastCallPollTimer = null; }
}

/* ── Clipboard Helper ─────────────────────────────────────────── */
function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard!', 'success')).catch(() => {
        const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        toast('Copied!', 'success');
    });
}

/* ── TTS System ──────────────────────────────────────────────── */
let ttsQueue = [];
let ttsSpeaking = false;
let _bcTtsAudioQueue = [];
let _bcTtsAudioPlaying = false;

function testTTS() {
    const mode = broadcastState.settings.ttsMode || 'site-wide';
    if (mode === 'self') {
        speakBroadcastTTS('This is a TTS test message from OpenVibe.Live');
    } else {
        // For site-wide, request server synthesis so we hear the actual espeak-ng output
        api('/tts/admin/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'This is a TTS test message from OpenVibe.Live' }),
        }).then(result => {
            if (result?.audio && result?.mimeType) {
                playBroadcastTTSAudio(result);
            } else {
                toast('TTS test: no audio returned from server', 'warning');
            }
        }).catch(err => {
            console.warn('[TTS] Server test failed, falling back to browser TTS:', err.message);
            speakBroadcastTTS('This is a TTS test message from OpenVibe.Live');
        });
    }
}
function cancelTTS() {
    speechSynthesis.cancel(); ttsQueue = []; ttsSpeaking = false;
    _bcTtsAudioQueue = []; _bcTtsAudioPlaying = false;
    toast('TTS reset', 'info');
}

function speakBroadcastTTS(text, username) {
    const s = broadcastState.settings;
    if (s.ttsMode === 'off') return;
    // "." prefix = TTS explicitly skipped.
    if (String(text || '').trimStart().startsWith('.')) return;
    const maxQueue = parseInt(s.ttsQueue) || 0;
    if (maxQueue > 0 && ttsQueue.length >= maxQueue) return;
    // Replace real links with TTS-friendly descriptions (shared with chat.js + server).
    let cleanText = OpenVibeChat.ttsReplaceLinks(text, username);
    // Cap to the channel's max TTS length.
    const _ttsMax = (window._channelChatLimits && window._channelChatLimits.tts_max_length) || 200;
    if (cleanText.length > _ttsMax) cleanText = cleanText.slice(0, _ttsMax);
    const fullText = s.ttsNames === 'on' && username ? `${OpenVibeChat.ttsUsername(username)} says: ${cleanText}` : cleanText;
    ttsQueue.push(fullText); processTTSQueue();
}

/** Play server-synthesized TTS audio on the broadcast page (site-wide mode) */
function playBroadcastTTSAudio(msg) {
    const s = broadcastState.settings;
    console.log('[TTS] playBroadcastTTSAudio called — mode:', s.ttsMode, 'hasAudio:', !!msg.audio, 'mimeType:', msg.mimeType);
    if (s.ttsMode !== 'site-wide') return;
    if (!msg.audio || !msg.mimeType) return;
    // "." prefix = TTS explicitly skipped.
    if (String(msg.message || msg.text || '').trimStart().startsWith('.')) return;
    const maxQueue = parseInt(s.ttsQueue) || 0;
    if (maxQueue > 0 && _bcTtsAudioQueue.length >= maxQueue) return;
    _bcTtsAudioQueue.push(msg);
    _processBcTtsAudioQueue();
}

function _processBcTtsAudioQueue() {
    if (_bcTtsAudioPlaying || _bcTtsAudioQueue.length === 0) return;
    _bcTtsAudioPlaying = true;
    const msg = _bcTtsAudioQueue.shift();
    try {
        const binaryStr = atob(msg.audio);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        const blob = new Blob([bytes], { type: msg.mimeType });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        const s = broadcastState.settings;
        const volume = (s.ttsVolume || 800) / 1000;
        // Speed = tempo (pitch preserved); pitch = independent shift (units, 100=+1oct).
        // Reuses the pitch-shifter helpers defined in chat.js (loaded first).
        const speedMod = Number(msg.speed) || 1.0;
        const pitchShift = Number(msg.pitchShift || 0);
        if (typeof _setSoundSpeed === 'function') { _setSoundSpeed(audio, speedMod); }
        else { audio.playbackRate = Math.max(0.25, Math.min(4.0, speedMod)); audio.preservesPitch = true; }
        // Use Web Audio API GainNode for volume — Audio.volume is unreliable on PipeWire/Steam Deck
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const source = ctx.createMediaElementSource(audio);
            const gain = ctx.createGain();
            gain.gain.value = volume;
            if (pitchShift && typeof _createJunglePitchShifter === 'function') {
                try {
                    const shifter = _createJunglePitchShifter(ctx);
                    shifter.setPitchOffset(pitchShift / 100);
                    source.connect(shifter.input);
                    shifter.output.connect(gain).connect(ctx.destination);
                } catch { source.connect(gain).connect(ctx.destination); }
            } else {
                source.connect(gain).connect(ctx.destination);
            }
            const cleanup = () => { URL.revokeObjectURL(url); try { ctx.close(); } catch {} _bcTtsAudioPlaying = false; _processBcTtsAudioQueue(); };
            audio.onended = cleanup;
            audio.onerror = cleanup;
            audio.play().catch(cleanup);
        } catch {
            // Fallback to Audio.volume if Web Audio API unavailable
            audio.volume = volume;
            audio.onended = () => { URL.revokeObjectURL(url); _bcTtsAudioPlaying = false; _processBcTtsAudioQueue(); };
            audio.onerror = () => { URL.revokeObjectURL(url); _bcTtsAudioPlaying = false; _processBcTtsAudioQueue(); };
            audio.play().catch(() => { URL.revokeObjectURL(url); _bcTtsAudioPlaying = false; _processBcTtsAudioQueue(); });
        }
    } catch {
        _bcTtsAudioPlaying = false;
        _processBcTtsAudioQueue();
    }
}

function processTTSQueue() {
    if (ttsSpeaking || ttsQueue.length === 0) return;
    ttsSpeaking = true;
    const text = ttsQueue.shift(); const s = broadcastState.settings;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.volume = s.ttsVolume / 1000; utterance.pitch = s.ttsPitch / 100; utterance.rate = s.ttsRate / 10;
    const voices = speechSynthesis.getVoices(); const voiceIdx = parseInt(s.ttsVoice);
    if (!isNaN(voiceIdx) && voices[voiceIdx]) utterance.voice = voices[voiceIdx];
    const dur = parseInt(s.ttsDuration) || 0; let timeout = null;
    if (dur > 0) timeout = setTimeout(() => speechSynthesis.cancel(), dur * 1000);
    utterance.onend = () => { if (timeout) clearTimeout(timeout); ttsSpeaking = false; processTTSQueue(); };
    utterance.onerror = () => { if (timeout) clearTimeout(timeout); ttsSpeaking = false; processTTSQueue(); };
    speechSynthesis.speak(utterance);
}

function cancelSounds() { toast('Sounds reset', 'info'); }

/* ── Settings Change Handlers ─────────────────────────────────── */
function initBroadcastSettingsListeners() {
    ['ttsVolume', 'ttsPitch', 'ttsRate', 'notificationVolume', 'soundVolume', 'manualGain'].forEach(key => {
        const el = document.getElementById(`bc-${key}`);
        if (el) el.addEventListener('input', () => updateBroadcastSetting(key, parseInt(el.value)));
    });
    ['ttsDuration', 'ttsNames', 'ttsQueue', 'ttsMode', 'broadcastLimit', 'broadcastBps', 'broadcastBpsMin',
     'broadcastRes', 'broadcastFps', 'broadcastCodec', 'allowSounds', 'ttsVoice'].forEach(key => {
        const el = document.getElementById(`bc-${key}`);
        if (el) el.addEventListener('change', () => updateBroadcastSetting(key, el.value));
    });
    const forceAudioEl = document.getElementById('bc-forceAudio');
    if (forceAudioEl) {
        forceAudioEl.addEventListener('change', () => _syncAudioSelectionUI(forceAudioEl.value));
    }
    const forceCameraEl = document.getElementById('bc-forceCamera');
    if (forceCameraEl) {
        forceCameraEl.addEventListener('change', () => _syncCameraSelectionUI(forceCameraEl.value));
    }
    ['autoGain', 'echoCancellation', 'noiseSuppression', 'manualGainEnabled', 'force48kSampleRate'].forEach(key => {
        const el = document.getElementById(`bc-${key}`);
        if (el) el.addEventListener('change', () => {
            updateBroadcastSetting(key, el.checked);
            // Re-acquire audio track live if an audio processing setting changed while streaming
            if (['autoGain', 'echoCancellation', 'noiseSuppression', 'force48kSampleRate'].includes(key)) {
                const ss = getActiveStreamState();
                const streamId = broadcastState.activeStreamId;
                if (ss && ss.localStream && streamId && !broadcastState.settings.screenShare) {
                    _switchActiveAudio(broadcastState.settings.forceAudio).catch(err => {
                        console.warn('[Broadcast] Live audio re-acquire after settings change failed:', err.message);
                    });
                }
            }
        });
    });
    // Screen share checkbox: toggle live if streaming, otherwise just save setting
    const screenShareEl = document.getElementById('bc-screenShare');
    if (screenShareEl) {
        screenShareEl.addEventListener('change', () => {
            const ss = getActiveStreamState();
            if (ss && ss.localStream) {
                // Revert the checkbox — toggleScreenShare() will set it properly
                screenShareEl.checked = broadcastState.settings.screenShare;
                toggleScreenShare();
            } else {
                updateBroadcastSetting('screenShare', screenShareEl.checked);
                _syncScreenShareUI();
            }
        });
    }
    // Screen share capture preference dropdowns
    ['screenCaptureSource', 'screenSystemAudio', 'screenSelfBrowser', 'screenSurfaceSwitching'].forEach(key => {
        const el = document.getElementById(`bc-${key}`);
        if (el) el.addEventListener('change', () => updateBroadcastSetting(key, el.value));
    });
    const screenPreferEl = document.getElementById('bc-screenPreferCurrentTab');
    if (screenPreferEl) {
        screenPreferEl.addEventListener('change', () => updateBroadcastSetting('screenPreferCurrentTab', screenPreferEl.checked));
    }
}

/* ── Live Clip Creator ──────────────────────────────────────── */

let _bcClipStart = 0;
let _bcClipEnd = 0;

/** Get the current stream uptime in seconds */
function _getBroadcastUptimeSeconds() {
    const ss = getActiveStreamState();
    if (!ss || !ss.startedAt) return 0;
    let raw = ss.startedAt;
    if (typeof raw === 'string' && !raw.includes('T')) raw = raw.replace(' ', 'T') + 'Z';
    const start = new Date(raw).getTime();
    if (isNaN(start)) return 0;
    return Math.max(0, (Date.now() - start) / 1000);
}

function toggleBroadcastClipPanel() {
    const panel = document.getElementById('bc-clip-panel');
    if (!panel) return;
    const btn = document.getElementById('bc-btn-clip');
    const visible = panel.style.display !== 'none';
    panel.style.display = visible ? 'none' : 'block';
    if (btn) btn.classList.toggle('bc-ctrl-btn-active', !visible);
    if (!visible) {
        // Initialize marks: last 30s by default
        const now = _getBroadcastUptimeSeconds();
        _bcClipEnd = Math.floor(now);
        _bcClipStart = Math.max(0, _bcClipEnd - 30);
        _updateBroadcastClipUI();
    }
}

function setBroadcastClipMark(which) {
    const now = Math.floor(_getBroadcastUptimeSeconds());
    if (which === 'start') {
        _bcClipStart = now;
        if (_bcClipEnd <= _bcClipStart) _bcClipEnd = Math.min(_bcClipStart + 30, Math.floor(_getBroadcastUptimeSeconds()));
    } else {
        _bcClipEnd = now;
        if (_bcClipStart >= _bcClipEnd) _bcClipStart = Math.max(0, _bcClipEnd - 30);
    }
    _updateBroadcastClipUI();
}

function setBroadcastClipLast30() {
    const now = Math.floor(_getBroadcastUptimeSeconds());
    _bcClipEnd = now;
    _bcClipStart = Math.max(0, now - 30);
    _updateBroadcastClipUI();
}

function _formatClipTime(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
}

function _updateBroadcastClipUI() {
    const startEl = document.getElementById('bc-clip-start');
    const endEl = document.getElementById('bc-clip-end');
    const durEl = document.getElementById('bc-clip-duration');
    if (startEl) startEl.value = _formatClipTime(_bcClipStart);
    if (endEl) endEl.value = _formatClipTime(_bcClipEnd);
    const dur = _bcClipEnd - _bcClipStart;
    if (durEl) {
        durEl.textContent = `${dur}s`;
        durEl.style.color = (dur > 60 || dur <= 0) ? '#e74c3c' : '';
    }
}

async function createBroadcastClip() {
    const ss = getActiveStreamState();
    if (!ss) return showToast('No active stream', 'error');

    // Auto-retry if VOD not ready yet (up to 3 attempts, 2s apart)
    if (!ss.vodId) {
        const btn = document.getElementById('bc-clip-create-btn');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Waiting for VOD…'; }
        for (let attempt = 0; attempt < 3; attempt++) {
            await new Promise(r => setTimeout(r, 2000));
            const retry = getActiveStreamState();
            if (retry?.vodId) { ss.vodId = retry.vodId; break; }
        }
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-scissors"></i> Create Clip'; }
        if (!ss.vodId) return showToast('VOD recording not ready yet — try again in a few seconds', 'error');
    }

    const duration = _bcClipEnd - _bcClipStart;
    if (duration <= 0) return showToast('End time must be after start time', 'error');
    if (duration > 60) return showToast('Clip cannot exceed 60 seconds', 'error');
    if (_bcClipStart < 0) return showToast('Invalid start time', 'error');

    const title = document.getElementById('bc-clip-title')?.value?.trim() || 'Untitled Clip';
    const btn = document.getElementById('bc-clip-create-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Creating…'; }

    try {
        const res = await fetch('/api/vods/clips', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                vod_id: ss.vodId,
                stream_id: ss.streamData?.id,
                start_time: _bcClipStart,
                end_time: _bcClipEnd,
                title,
            }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to create clip');

        showToast(`Clip created! "${title}"`, 'success');

        // Reset panel
        const titleInput = document.getElementById('bc-clip-title');
        if (titleInput) titleInput.value = '';
        // Update marks to current time
        const now = Math.floor(_getBroadcastUptimeSeconds());
        _bcClipEnd = now;
        _bcClipStart = Math.max(0, now - 30);
        _updateBroadcastClipUI();
    } catch (err) {
        console.error('[Clip] Error:', err);
        showToast(err.message || 'Failed to create clip', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-scissors"></i> Create Clip'; }
    }
}

/* ── /Live Clip Creator ────────────────────────────────────── */

/* ── PiP Drag & Resize on Preview ─────────────────────────── */
/**
 * Allow the streamer to drag/resize the camera PiP overlay by clicking on the preview video.
 * Works in screen share + camera overlay mode. The preview shows the composite canvas output.
 * - Click & drag inside PiP rect = move
 * - Click & drag bottom-right corner of PiP = resize
 * - Positions stored as fractions (0-1) in ss._pipX/_pipY/_pipW
 */
function _initPipDragResize() {
    const preview = document.getElementById('bc-video-preview');
    if (!preview) return;

    function _getCanvasRelPos(e, rect) {
        const cx = (e.clientX - rect.left) / rect.width;
        const cy = (e.clientY - rect.top) / rect.height;
        return { cx: Math.max(0, Math.min(1, cx)), cy: Math.max(0, Math.min(1, cy)) };
    }

    function _getPipRect(ss) {
        if (!ss || !ss._compositeCanvas) return null;
        const w = ss._pipW;
        const aspect = (ss._cameraOverlayStream?.getVideoTracks()[0]?.getSettings()?.height /
                        ss._cameraOverlayStream?.getVideoTracks()[0]?.getSettings()?.width) || 0.75;
        const h = w * aspect;
        return { x: ss._pipX, y: ss._pipY, w, h };
    }

    let _dragState = null; // { mode: 'move'|'resize', startCx, startCy, startPipX, startPipY, startPipW }

    function onPointerDown(e) {
        const ss = getActiveStreamState();
        if (!ss || !ss._cameraOverlayEnabled || !broadcastState.settings.screenShare) return;
        const rect = preview.getBoundingClientRect();
        const { cx, cy } = _getCanvasRelPos(e, rect);
        const pip = _getPipRect(ss);
        if (!pip) return;

        // Check if inside PiP rectangle
        if (cx >= pip.x && cx <= pip.x + pip.w && cy >= pip.y && cy <= pip.y + pip.h) {
            e.preventDefault();
            // Check if near bottom-right corner for resize (last 20% of pip)
            const resizeThresh = 0.2;
            const isResize = (cx > pip.x + pip.w * (1 - resizeThresh)) && (cy > pip.y + pip.h * (1 - resizeThresh));
            _dragState = {
                mode: isResize ? 'resize' : 'move',
                startCx: cx, startCy: cy,
                startPipX: ss._pipX, startPipY: ss._pipY, startPipW: ss._pipW,
            };
            preview.style.cursor = isResize ? 'nwse-resize' : 'grabbing';
            preview.setPointerCapture(e.pointerId);
        }
    }

    function onPointerMove(e) {
        if (!_dragState) {
            // Show grab cursor when hovering over PiP
            const ss = getActiveStreamState();
            if (ss && ss._cameraOverlayEnabled && broadcastState.settings.screenShare) {
                const rect = preview.getBoundingClientRect();
                const { cx, cy } = _getCanvasRelPos(e, rect);
                const pip = _getPipRect(ss);
                if (pip && cx >= pip.x && cx <= pip.x + pip.w && cy >= pip.y && cy <= pip.y + pip.h) {
                    const resizeThresh = 0.2;
                    const isResize = (cx > pip.x + pip.w * (1 - resizeThresh)) && (cy > pip.y + pip.h * (1 - resizeThresh));
                    preview.style.cursor = isResize ? 'nwse-resize' : 'grab';
                } else {
                    preview.style.cursor = '';
                }
            }
            return;
        }
        e.preventDefault();
        const ss = getActiveStreamState();
        if (!ss) { _dragState = null; return; }
        const rect = preview.getBoundingClientRect();
        const { cx, cy } = _getCanvasRelPos(e, rect);
        const dx = cx - _dragState.startCx;
        const dy = cy - _dragState.startCy;

        if (_dragState.mode === 'move') {
            ss._pipX = Math.max(0, Math.min(1 - ss._pipW, _dragState.startPipX + dx));
            // Estimate pip height for bounds clamping
            const aspect = (ss._cameraOverlayStream?.getVideoTracks()[0]?.getSettings()?.height /
                            ss._cameraOverlayStream?.getVideoTracks()[0]?.getSettings()?.width) || 0.75;
            const pipH = ss._pipW * aspect;
            ss._pipY = Math.max(0, Math.min(1 - pipH, _dragState.startPipY + dy));
        } else if (_dragState.mode === 'resize') {
            // Resize — change width proportionally, min 8%, max 50%
            const newW = Math.max(0.08, Math.min(0.50, _dragState.startPipW + dx));
            ss._pipW = newW;
        }
    }

    function onPointerUp(e) {
        if (_dragState) {
            _dragState = null;
            preview.style.cursor = '';
            try { preview.releasePointerCapture(e.pointerId); } catch {}
        }
    }

    preview.addEventListener('pointerdown', onPointerDown);
    preview.addEventListener('pointermove', onPointerMove);
    preview.addEventListener('pointerup', onPointerUp);
    preview.addEventListener('pointercancel', onPointerUp);
}

document.addEventListener('DOMContentLoaded', () => {
    initBroadcastSettingsListeners();
    initBroadcastTabs();

    // Update mobile chat FAB visibility on resize
    window.addEventListener('resize', () => {
        updateBroadcastMobileChatFab();
        if (window.innerWidth > 768) {
            _bcMobileChatOpen = false;
            const sidebar = document.getElementById('bc-chat-sidebar');
            if (sidebar) sidebar.classList.remove('mobile-chat-open');
            document.body.classList.remove('mobile-chat-visible');
            closeCameraSwitcher();
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeCameraSwitcher();
    });

    const robotSelect = document.getElementById('bc-rsRobotSelect');
    if (robotSelect) {
        robotSelect.addEventListener('change', () => {
            const input = document.getElementById('bc-rsRobotInput');
            if (input && robotSelect.value) input.value = robotSelect.value;
        });
    }

    // Programmatic click handler for permission button — more reliable than inline onclick on mobile
    const permBtn = document.getElementById('bc-perm-btn');
    if (permBtn) {
        let _permTouchHandled = false;
        permBtn.addEventListener('click', (e) => {
            if (_permTouchHandled) { _permTouchHandled = false; return; }
            e.preventDefault();
            requestMediaPermissions();
        });
        // Belt-and-suspenders: also handle touch directly for mobile browsers
        permBtn.addEventListener('touchend', (e) => {
            e.preventDefault();
            _permTouchHandled = true;
            requestMediaPermissions();
        }, { passive: false });
    }

    // ── Screen share device toggle listeners ──
    const screenCamCheck = document.getElementById('bc-screen-cam-enabled');
    const screenCamSelect = document.getElementById('bc-screen-cam-select');
    if (screenCamCheck && screenCamSelect) {
        screenCamCheck.addEventListener('change', () => {
            screenCamSelect.style.display = screenCamCheck.checked ? 'block' : 'none';
        });
    }
    const screenMicCheck = document.getElementById('bc-screen-mic-enabled');
    const screenMicSelect = document.getElementById('bc-screen-mic-select');
    if (screenMicCheck && screenMicSelect) {
        screenMicCheck.addEventListener('change', () => {
            screenMicSelect.style.display = screenMicCheck.checked ? 'block' : 'none';
        });
    }

    // ── PiP drag/resize on preview ──
    _initPipDragResize();
});

// ═══════════════════════════════════════════════════════════════
// Media Request PiP Player (inline on broadcast page)
// ═══════════════════════════════════════════════════════════════
let _mediaPipState = null;     // { now_playing, queue, settings }
let _mediaPipPollTimer = null;
let _mediaPipSocket = null;
let _mediaPipCurrentId = null;
let _mediaPipHls = null;
const _mediaPipScriptPromises = new Map();

function toggleMediaPip() {
    const panel = document.getElementById('bc-media-pip');
    if (!panel) return;
    const btn = document.getElementById('bc-btn-media-pip');
    const visible = panel.style.display !== 'none';
    panel.style.display = visible ? 'none' : '';
    if (btn) btn.classList.toggle('bc-ctrl-btn-active', !visible);
    if (!visible) {
        _mediaPipRefresh();
        _startMediaPipPoll();
        _connectMediaPipSocket();
    } else {
        _stopMediaPipPoll();
        try { _mediaPipSocket?.close(); } catch {}
        _mediaPipSocket = null;
    }
}

function mediaPopout() {
    if (currentUser?.username) window.open(`/media/${currentUser.username}`, '_blank');
}

async function _mediaPipRefresh() {
    if (!currentUser?.username) return;
    try {
        const data = await api(`/media/channel/${encodeURIComponent(currentUser.username)}`);
        _mediaPipState = data.state;
        _renderMediaPip();
    } catch (e) {
        console.warn('[MediaPip] refresh error:', e.message);
    }
}

function _renderMediaPip() {
    const state = _mediaPipState;
    if (!state) return;

    const np = state.now_playing;
    const header = document.getElementById('bc-media-pip-now');
    const emptyEl = document.getElementById('bc-media-pip-empty');
    const loadingEl = document.getElementById('bc-media-pip-loading');
    const controlsEl = document.getElementById('bc-media-pip-controls');
    const hostEl = document.getElementById('bc-media-pip-host');
    const queueEl = document.getElementById('bc-media-pip-queue');

    // Now playing
    if (np) {
        header.textContent = np.title || 'Now Playing';
        emptyEl.style.display = 'none';
        controlsEl.style.display = '';
        document.getElementById('bc-media-pip-track').textContent = np.title || 'Unknown';
        document.getElementById('bc-media-pip-requester').textContent = `Requested by ${np.username || '?'}`;

        // Load player if different request
        if (_mediaPipCurrentId !== np.id) {
            _mediaPipCurrentId = np.id;
            _loadMediaPipPlayer(np);
        }
    } else {
        header.textContent = 'Media Requests';
        emptyEl.style.display = '';
        controlsEl.style.display = 'none';
        _destroyMediaPipPlayer();
    }

    // Queue
    const queue = state.queue || [];
    if (queue.length === 0) {
        queueEl.innerHTML = '<div class="bc-media-pip-queue-empty">Queue empty</div>';
    } else {
        queueEl.innerHTML = queue.slice(0, 10).map(q =>
            `<div class="bc-pip-queue-item">
                <span class="bc-pip-queue-title">${_escPip(q.title)}</span>
                <span class="bc-pip-queue-user">${_escPip(q.username)}</span>
            </div>`
        ).join('');
        if (queue.length > 10) {
            queueEl.innerHTML += `<div class="bc-media-pip-queue-empty">+${queue.length - 10} more</div>`;
        }
    }
}

function _escPip(s) {
    return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function _loadMediaPipScriptOnce(src) {
    if (!src) return Promise.reject(new Error('Missing script URL'));
    if (_mediaPipScriptPromises.has(src)) return _mediaPipScriptPromises.get(src);

    const promise = new Promise((resolve, reject) => {
        const key = encodeURIComponent(src);
        const existing = document.querySelector(`script[data-external-src="${key}"]`);
        if (existing) {
            if (existing.dataset.loaded === 'true') return resolve();
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
    });

    _mediaPipScriptPromises.set(src, promise);
    return promise;
}

function _isMediaPipHlsUrl(url) {
    const value = String(url || '');
    return /\.m3u8(?:$|[?#])/i.test(value) || /\/api\/manifest\/(?:hls|dash)_playlist\//i.test(value);
}

async function _attachMediaPipSource(media, url) {
    if (!_isMediaPipHlsUrl(url)) {
        media.src = url;
        return;
    }

    if (media.canPlayType('application/vnd.apple.mpegurl')) {
        media.src = url;
        return;
    }

    await _loadMediaPipScriptOnce('https://cdn.jsdelivr.net/npm/hls.js@latest');
    if (typeof Hls === 'undefined' || !Hls.isSupported()) {
        throw new Error('HLS playback is not supported in this browser');
    }

    if (_mediaPipHls) {
        try { _mediaPipHls.destroy(); } catch {}
        _mediaPipHls = null;
    }

    _mediaPipHls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 30,
    });
    _mediaPipHls.loadSource(url);
    _mediaPipHls.attachMedia(media);
    _mediaPipHls.on(Hls.Events.ERROR, (_event, data) => {
        if (data?.fatal) {
            try { _mediaPipHls.destroy(); } catch {}
            _mediaPipHls = null;
            media.dispatchEvent(new Event('error'));
        }
    });
}

async function _loadMediaPipPlayer(request) {
    const host = document.getElementById('bc-media-pip-host');
    const empty = document.getElementById('bc-media-pip-empty');
    const loading = document.getElementById('bc-media-pip-loading');
    _destroyMediaPipPlayer();

    let url = request.stream_url;
    if (!url || request.download_status !== 'ready') {
        try {
            const data = await api(`/media/queue/${request.id}/stream-url`);
            url = data?.stream_url || null;
        } catch {
            url = null;
        }
    }

    const playUrl = url;

    if (!playUrl) {
        empty.style.display = '';
        empty.querySelector('span').textContent = 'Server is still preparing this media';
        loading.style.display = 'none';
        return;
    }

    const isAudio = request.provider === 'audio';
    const media = document.createElement(isAudio ? 'audio' : 'video');
    media.src = playUrl;
    media.autoplay = true;
    media.controls = true;
    if (!isAudio) media.style.cssText = 'width:100%;height:100%;display:block;background:#000';
    else media.style.cssText = 'width:100%;min-height:60px;display:block;background:#111';

    media.addEventListener('canplay', () => { loading.style.display = 'none'; });
    media.addEventListener('error', () => { loading.style.display = 'none'; });

    host.appendChild(media);
    empty.style.display = 'none';

    try {
        await _attachMediaPipSource(media, playUrl);
    } catch (err) {
        console.warn('[MediaPip] player attach error:', err.message);
        empty.style.display = '';
        empty.querySelector('span').textContent = err.message || 'Media failed to load';
    }
    loading.style.display = 'none';
}

function _destroyMediaPipPlayer() {
    if (_mediaPipHls) {
        try { _mediaPipHls.destroy(); } catch {}
        _mediaPipHls = null;
    }
    const host = document.getElementById('bc-media-pip-host');
    if (!host) return;
    const el = host.querySelector('video, audio');
    if (el) {
        try { el.pause?.(); } catch {}
        el.remove();
    }
    _mediaPipCurrentId = null;
}

async function mediaPipSkip() {
    const np = _mediaPipState?.now_playing;
    if (!np) { toast('Nothing playing', 'warning'); return; }
    try {
        await api('/media/advance', { method: 'POST', body: { status: 'skipped' } });
        _mediaPipRefresh();
    } catch (e) { toast(e.message, 'error'); }
}

async function mediaPipStartNext() {
    try {
        await api('/media/start', { method: 'POST' });
        _mediaPipRefresh();
    } catch (e) { toast(e.message, 'error'); }
}

function _startMediaPipPoll() {
    _stopMediaPipPoll();
    _mediaPipPollTimer = setInterval(_mediaPipRefresh, 8000);
}

function _stopMediaPipPoll() {
    if (_mediaPipPollTimer) { clearInterval(_mediaPipPollTimer); _mediaPipPollTimer = null; }
}

function _connectMediaPipSocket() {
    const activeId = broadcastState.activeStreamId;
    if (!activeId) return;
    if (_mediaPipSocket && _mediaPipSocket._sid === activeId && _mediaPipSocket.readyState <= 1) return;
    try { _mediaPipSocket?.close(); } catch {}

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(`${protocol}//${window.location.host}/ws/chat`);
    const token = localStorage.getItem('token');
    if (token) url.searchParams.set('token', token);
    url.searchParams.set('stream', activeId);

    const ws = new WebSocket(url.toString());
    ws._sid = activeId;
    ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'join_stream', streamId: activeId, token: token || undefined }));
    });
    ws.addEventListener('message', (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'media_queue_update' && msg.state) {
                _mediaPipState = msg.state;
                _renderMediaPip();
            } else if (msg.type === 'media_now_playing' && msg.request) {
                if (_mediaPipState) _mediaPipState.now_playing = msg.request;
                _renderMediaPip();
            }
        } catch {}
    });
    ws.addEventListener('close', () => {
        if (_mediaPipSocket === ws) _mediaPipSocket = null;
    });
    _mediaPipSocket = ws;
}
/* VOD archive functions → broadcast-vods.js */
/**
 * Load Broadcast Settings form
 */
function loadBroadcastSettingsForm() {
    loadNewsPreference();
    try {
        const saved = localStorage.getItem('openvibe_broadcast_settings_form') || '{}';
        const settings = JSON.parse(saved);

        // Populate form fields
        if (settings.defaultMethod) {
            selectDefaultStreamingMethod(settings.defaultMethod);
            document.getElementById('bc-settings-default-method')?.setAttribute('value', settings.defaultMethod);
        }

        if (settings.camera) document.getElementById('bc-settings-camera').value = settings.camera;
        if (settings.microphone) document.getElementById('bc-settings-microphone').value = settings.microphone;
        if (settings.micGain) {
            document.getElementById('bc-settings-mic-gain').value = settings.micGain;
            document.getElementById('bc-settings-mic-gain-display').textContent = settings.micGain + '%';
        }
        if (settings.echoCancellation !== undefined) {
            document.getElementById('bc-settings-echo-cancellation').checked = settings.echoCancellation;
        }
        if (settings.noiseSuppression !== undefined) {
            document.getElementById('bc-settings-noise-suppression').checked = settings.noiseSuppression;
        }
        if (settings.resolution) document.getElementById('bc-settings-resolution').value = settings.resolution;
        if (settings.fps) document.getElementById('bc-settings-fps').value = settings.fps;
        if (settings.bitrate) document.getElementById('bc-settings-bitrate').value = settings.bitrate;
        if (settings.ttsMode) document.getElementById('bc-settings-tts-mode').value = settings.ttsMode;
        if (settings.ttsVoice) document.getElementById('bc-settings-tts-voice').value = settings.ttsVoice;
        if (settings.vodPublic !== undefined) {
            document.getElementById('bc-settings-vod-public').checked = settings.vodPublic;
        }
    } catch (err) {
        console.error('Error loading broadcast settings form:', err);
    }

    // Refresh restream destinations and RS config into the settings tab
    loadRestreamDestinations().catch(() => {});
    loadRobotStreamerIntegration().catch(() => {});
}

/**
 * Update broadcast settings form
 */
function updateBroadcastSettings() {
    // Update mic gain display
    const gain = document.getElementById('bc-settings-mic-gain');
    const display = document.getElementById('bc-settings-mic-gain-display');
    if (gain && display) {
        display.textContent = gain.value + '%';
    }
}

/**
 * Save broadcast settings form
 */
function saveBroadcastSettingsForm() {
    try {
        const settings = {
            defaultMethod: document.getElementById('bc-settings-default-method')?.value || 'webrtc',
            camera: document.getElementById('bc-settings-camera')?.value || 'default',
            microphone: document.getElementById('bc-settings-microphone')?.value || 'default',
            micGain: parseInt(document.getElementById('bc-settings-mic-gain')?.value || 100),
            echoCancellation: document.getElementById('bc-settings-echo-cancellation')?.checked === true,
            noiseSuppression: document.getElementById('bc-settings-noise-suppression')?.checked === true,
            resolution: document.getElementById('bc-settings-resolution')?.value || '480p',
            fps: document.getElementById('bc-settings-fps')?.value || '30',
            bitrate: parseInt(document.getElementById('bc-settings-bitrate')?.value || 2500),
            ttsMode: document.getElementById('bc-settings-tts-mode')?.value || 'off',
            ttsVoice: document.getElementById('bc-settings-tts-voice')?.value || 'en-us',
            vodPublic: document.getElementById('bc-settings-vod-public')?.checked !== false
        };

        localStorage.setItem('openvibe_broadcast_settings_form', JSON.stringify(settings));

        // Sync settings form values to the live broadcastState so go-live uses them
        if (settings.microphone) _syncAudioSelectionUI(settings.microphone);
        if (settings.echoCancellation !== undefined) {
            broadcastState.settings.echoCancellation = settings.echoCancellation;
        }
        if (settings.noiseSuppression !== undefined) {
            broadcastState.settings.noiseSuppression = settings.noiseSuppression;
        }
        saveBroadcastSettings();

        // Show save confirmation
        const status = document.getElementById('bc-settings-save-status');
        if (status) {
            status.textContent = '✓ Settings saved';
            status.style.color = 'var(--success, #22c55e)';
            setTimeout(() => {
                status.textContent = '';
            }, 3000);
        }
    } catch (err) {
        console.error('Error saving settings:', err);
    }
}

/**
 * Reset broadcast settings to defaults
 */
function resetBroadcastSettingsForm() {
    if (!confirm('Reset all settings to defaults?')) return;

    try {
        localStorage.removeItem('openvibe_broadcast_settings_form');
        loadBroadcastSettingsForm();

        // Show reset confirmation
        const status = document.getElementById('bc-settings-save-status');
        if (status) {
            status.textContent = '✓ Settings reset';
            status.style.color = 'var(--success, #22c55e)';
            setTimeout(() => {
                status.textContent = '';
            }, 3000);
        }
    } catch (err) {
        console.error('Error resetting settings:', err);
    }
}

/**
 * Select default streaming method (updates both form and hidden input)
 */
function selectDefaultStreamingMethod(method) {
    const cards = document.querySelectorAll('#bc-broadcast-settings-tab .bc-method-card');
    cards.forEach(card => {
        card.classList.toggle('selected', card.dataset.method === method);
    });
    
    const input = document.getElementById('bc-settings-default-method');
    if (input) input.value = method;
}

/**
 * Format duration in seconds to HH:MM:SS
 */
function formatDuration(seconds) {
    if (!seconds || seconds < 0) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Load Broadcast Settings values into the Go Live form
 */
function loadBroadcastSettingsToForm() {
    try {
        const saved = localStorage.getItem('openvibe_broadcast_settings_form') || '{}';
        const settings = JSON.parse(saved);

        // Select the streaming method
        if (settings.defaultMethod) {
            selectStreamMethod(settings.defaultMethod);
        }

        // Pre-select devices if saved
        if (settings.camera) {
            const cameraSelect = document.getElementById('bc-create-camera');
            if (cameraSelect) cameraSelect.value = settings.camera;
        }
        if (settings.microphone) {
            const micSelect = document.getElementById('bc-create-audio');
            if (micSelect) micSelect.value = settings.microphone;
        }

        // Show a confirmation message
        toast('✓ Defaults loaded from Broadcast Settings', 'success');
    } catch (err) {
        console.error('Error loading broadcast settings to form:', err);
        toast('Error loading settings', 'error');
    }
}

/* ── Breaking News Preference ────────────────────────────────── */
async function loadNewsPreference() {
    try {
        const data = await api('/news/my-settings');
        const cb = document.getElementById('bc-settings-news-enabled');
        const status = document.getElementById('bc-news-status');
        if (cb) cb.checked = !!data.enabled;
        if (status) status.textContent = data.enabled === null ? 'Inheriting global setting' : '';
    } catch { /* non-critical */ }
}

async function updateNewsPreference(enabled) {
    try {
        await api('/news/my-settings', { method: 'PUT', body: { enabled } });
        const status = document.getElementById('bc-news-status');
        if (status) status.textContent = enabled ? 'News headlines enabled for your streams' : 'News headlines disabled';
    } catch (err) {
        toast(err.message || 'Failed to update news setting', 'error');
    }
}

/* ── Preview Toggle ──────────────────────────────────────────── */
let _viewerPreviewWindow = null;

function toggleBroadcastPreview() {
    const video = document.getElementById('bc-video-preview');
    const btn = document.getElementById('bc-btn-toggle-preview');
    if (!video || !btn) return;
    if (video.style.display === 'none') {
        video.style.display = '';
        btn.innerHTML = '<i class="fa-solid fa-eye"></i> Preview';
    } else {
        video.style.display = 'none';
        btn.innerHTML = '<i class="fa-solid fa-eye-slash"></i> Preview';
    }
}

/**
 * Open a viewer-style preview — shows what viewers actually see.
 * Opens the active stream's direct watch URL so the user sees the right stream
 * even if they have multiple slots.
 */
function openViewerPreview() {
    const streamId = broadcastState.activeStreamId;
    if (!streamId && !currentUser?.username) {
        toast('Log in to use viewer preview', 'error');
        return;
    }
    if (_viewerPreviewWindow && !_viewerPreviewWindow.closed) {
        _viewerPreviewWindow.focus();
        return;
    }
    // Use the stream's direct URL (slug from streamData if available, else /watch/:id)
    const ss = streamId ? getStreamState(streamId) : null;
    const streamData = ss?.streamData || null;
    const slug = streamData?.slug || null;
    let url;
    if (streamId) {
        url = slug && currentUser?.username
            ? `/${currentUser.username}/${slug}`
            : `/watch/${streamId}`;
    } else {
        url = `/${currentUser?.username || ''}`;
    }
    _viewerPreviewWindow = window.open(
        url,
        'viewer-preview',
        'width=960,height=620,menubar=no,toolbar=no,location=no'
    );
}

/* ── Popout Chat ─────────────────────────────────────────────── */
function popoutBroadcastChat() {
    // Use the same lightweight popout as stream/global chat (consistent behavior)
    if (typeof popoutStreamChat === 'function') {
        popoutStreamChat();
    } else if (currentUser?.username) {
        window.open(`/${currentUser.username}`, '_blank', 'width=400,height=700');
    }
}

/* ── RTMP/JSMPEG Live Thumbnail Preview ──────────────────────── */
let _rtmpPreviewTimer = null;

function startRtmpPreview(streamId) {
    stopRtmpPreview();
    const el = document.getElementById('bc-rtmp-preview');
    const img = document.getElementById('bc-rtmp-preview-img');
    if (!el || !img) return;
    const update = () => {
        img.src = `/thumbnails/stream-${streamId}-live.jpg?t=${Date.now()}`;
        img.onerror = () => { el.style.display = 'none'; };
        img.onload = () => { el.style.display = ''; };
    };
    update();
    _rtmpPreviewTimer = setInterval(update, 10000);
}

function stopRtmpPreview() {
    if (_rtmpPreviewTimer) { clearInterval(_rtmpPreviewTimer); _rtmpPreviewTimer = null; }
    const el = document.getElementById('bc-rtmp-preview');
    if (el) el.style.display = 'none';
}

/* ── Disconnect Alert Banner + Audible Alert ─────────────────── */
let _disconnectAlertShown = false;
let _disconnectAudioEnabled = false; // Default off — user must opt in

/** Play an audible alert beep using Web Audio API */
function _playDisconnectBeep() {
    if (!_disconnectAudioEnabled) return;
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 800;
        osc.type = 'square';
        gain.gain.value = 0.3;
        osc.start();
        // Two beeps: 150ms on, 100ms off, 150ms on
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.setValueAtTime(0, ctx.currentTime + 0.15);
        gain.gain.setValueAtTime(0.3, ctx.currentTime + 0.25);
        gain.gain.setValueAtTime(0, ctx.currentTime + 0.4);
        osc.stop(ctx.currentTime + 0.45);
        osc.onended = () => ctx.close();
    } catch { /* Web Audio not available */ }
}

function showDisconnectAlert(reason) {
    if (_disconnectAlertShown) return;
    _disconnectAlertShown = true;
    let banner = document.getElementById('bc-disconnect-alert');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'bc-disconnect-alert';
        banner.className = 'bc-disconnect-alert';
        const container = document.querySelector('.bc-video-container') || document.getElementById('bc-live-section');
        if (container) container.parentElement.insertBefore(banner, container);
    }
    banner.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> <span>Connection lost — ${reason || 'reconnecting...'}</span><button class="btn btn-small btn-outline" onclick="dismissDisconnectAlert()"><i class="fa-solid fa-xmark"></i></button>`;
    banner.style.display = '';
    _playDisconnectBeep();
}

function dismissDisconnectAlert() {
    _disconnectAlertShown = false;
    const banner = document.getElementById('bc-disconnect-alert');
    if (banner) banner.style.display = 'none';
}
