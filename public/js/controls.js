/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Live — Interactive Controls Client (WebSocket)
   Supports: Keyboard hold (key_down/key_up), Video click,
             Traditional buttons, ONVIF PTZ cameras
   ═══════════════════════════════════════════════════════════════ */

let controlWs = null;
let controlCooldowns = {};
let onvifCooldowns = {};
let heldKeys = new Map();       // holdKey → { controlId, command, btnEl } — structured hold state
let controlSettings = {};       // Channel control settings from server
let _controlReconnectTimer = null;
let _controlReconnectDelay = 1000;
let _controlStreamId = null;    // Stream ID for reconnect
let _hardwareConnected = false; // Whether hardware bridge is online
let _hardwareStatusKnown = false; // Have we received a hardware_status yet?
let _controlsHaveContent = false; // Panel has button controls to show
let _controlsHaveOnvif = false;   // Panel has ONVIF camera controls (work without the hardware bridge)
// currentStreamId is declared in app.js (global scope)

/**
 * Show/hide the controls panel. Viewers only see controls when the hardware
 * bridge is online (buttons do nothing otherwise) — but ONVIF camera controls
 * don't need the bridge, so a panel with cameras stays visible.
 */
let _controlsCollapsed = false;
function _applyControlsVisibility() {
    // Controls live in a section directly under the player (above the streamer info),
    // shown only when the watched stream has usable controls (buttons need the hardware
    // bridge online; ONVIF cameras don't).
    const show = _controlsHaveContent && !(_hardwareStatusKnown && !_hardwareConnected && !_controlsHaveOnvif);
    const section = document.getElementById('ch-controls-section');
    const toggle = document.getElementById('ch-controls-toggle');
    if (toggle) toggle.style.display = show ? '' : 'none';
    if (section) section.style.display = (show && !_controlsCollapsed) ? '' : 'none';
    if (!show) _undockControls();
    _positionControlsToggle();
    _syncControlsToggleUI();
}
// The collapse/expand toggle lives NEXT TO the dock button (in the controls header)
// while the section is open, and only relocates into the info bar once the section is
// hidden — so there's always a visible way to bring the controls back.
function _positionControlsToggle() {
    const toggle = document.getElementById('ch-controls-toggle');
    if (!toggle) return;
    const btns = document.querySelector('#ch-controls-section .controls-header-btns');
    const infoRight = document.querySelector('#ch-info-bar .ch-info-bar-right');
    if (_controlsCollapsed) {
        if (infoRight && toggle.parentElement !== infoRight) infoRight.insertBefore(toggle, infoRight.firstChild);
    } else {
        if (btns && toggle.parentElement !== btns) btns.insertBefore(toggle, btns.firstChild);
    }
}
function _syncControlsToggleUI() {
    const toggle = document.getElementById('ch-controls-toggle');
    if (!toggle) return;
    toggle.classList.toggle('collapsed', _controlsCollapsed);
    if (_controlsCollapsed) {
        // In the info bar: a clear "show controls" affordance (distinct from the dock arrow).
        toggle.innerHTML = '<i class="fa-solid fa-gamepad"></i><i class="fa-solid fa-chevron-down ch-controls-toggle-caret"></i>';
        toggle.title = 'Show controls';
        toggle.setAttribute('aria-label', 'Show controls');
    } else {
        // In the header next to the dock button: a "hide/collapse" chevron.
        toggle.innerHTML = '<i class="fa-solid fa-chevron-up"></i>';
        toggle.title = 'Hide controls';
        toggle.setAttribute('aria-label', 'Hide controls');
    }
}
// Collapse/expand the under-player controls section.
function toggleControlsSection() {
    _controlsCollapsed = !_controlsCollapsed;
    _positionControlsToggle();   // relocate the toggle BEFORE hiding the section
    _syncControlsToggleUI();
    const section = document.getElementById('ch-controls-section');
    if (section) section.style.display = _controlsCollapsed ? 'none' : '';
}

/* ── Docked controls: fixed compact bottom bar ──────────────────
   Moves the live #controls-grid into a fixed bottom bar so viewers can drive controls
   while still watching + chatting (great on mobile). The grid NODE is moved (not
   re-created), so all button handlers + live re-renders keep working. */
let _controlsDocked = false;
function toggleControlsDock() {
    const dock = document.getElementById('controls-dock');
    const dockBody = document.getElementById('controls-dock-body');
    const panel = document.getElementById('controls-panel');
    const grid = document.getElementById('controls-grid');
    const btn = document.getElementById('controls-dock-btn');
    if (!dock || !dockBody || !panel || !grid) return;
    _controlsDocked = !_controlsDocked;
    if (_controlsDocked) {
        dockBody.appendChild(grid);
        dock.style.display = '';
        document.body.classList.add('controls-docked');
        let ph = document.getElementById('controls-dock-ph');
        if (!ph) { ph = document.createElement('div'); ph.id = 'controls-dock-ph'; ph.className = 'controls-dock-ph'; panel.appendChild(ph); }
        ph.innerHTML = '<i class="fa-solid fa-arrow-down"></i> Controls are docked at the bottom of your screen so you can use them while you watch. <button class="btn btn-sm btn-outline" onclick="toggleControlsDock()"><i class="fa-solid fa-arrow-up"></i> Bring back here</button>';
        if (btn) { btn.innerHTML = '<i class="fa-solid fa-arrow-up"></i>'; btn.title = 'Undock controls (bring back under the player)'; }
    } else {
        panel.appendChild(grid);
        dock.style.display = 'none';
        document.body.classList.remove('controls-docked');
        const ph = document.getElementById('controls-dock-ph'); if (ph) ph.remove();
        if (btn) { btn.innerHTML = '<i class="fa-solid fa-arrow-down"></i>'; btn.title = 'Dock controls to the bottom of the screen'; }
    }
}
function _undockControls() { if (_controlsDocked) toggleControlsDock(); }

/**
 * Load and display interactive controls for a stream.
 */
async function loadStreamControls(streamId) {
    const panel = document.getElementById('controls-panel');
    const grid = document.getElementById('controls-grid');
    currentStreamId = streamId;

    try {
        const data = await api(`/controls/${streamId}`);
        const controls = data.controls || [];
        controlSettings = data.settings || {};

        const hasControls = controls.length > 0;
        const hasVideoClick = !!controlSettings.video_click_enabled;

        if (!hasControls && !hasVideoClick) {
            _controlsHaveContent = false;
            _controlsHaveOnvif = false;
            _applyControlsVisibility();
            destroyVideoClickOverlay();
            return;
        }

        // Separate ONVIF controls from regular controls
        const onvifControls = controls.filter(c => c.control_type === 'onvif' && c.camera_id);
        // Track content for hardware-aware visibility
        _controlsHaveContent = hasControls;
        _controlsHaveOnvif = onvifControls.length > 0;
        // Show panel if there are button controls (gated on hardware presence)
        _applyControlsVisibility();
        const regularControls = controls.filter(c => c.control_type !== 'onvif' || !c.camera_id);

        let html = '';

        // Render regular controls (buttons + keyboard hold)
        if (regularControls.length > 0) {
            html += '<div class="controls-row regular-controls">';
            html += regularControls.map(c => {
                const isKeyboard = c.control_type === 'keyboard';
                const btnStyle = buildBtnStyle(c);
                const bindingBadge = c.key_binding ? `<span class="control-keybind">${esc(c.key_binding.toUpperCase())}</span>` : '';

                if (isKeyboard) {
                    // Keyboard control — uses hold detection (mousedown/mouseup + keydown/keyup)
                    const cd = (c.cooldown_ms != null && Number.isFinite(Number(c.cooldown_ms))) ? Number(c.cooldown_ms) : 100;
                    return `
                        <button class="control-btn control-btn-keyboard" data-id="${c.id}" data-cmd="${esc(c.command)}" data-cooldown="${cd}"
                                data-keybind="${esc(c.key_binding || '')}"
                                onmousedown="startKeyHold(${c.id}, '${esc(c.command)}', this)"
                                onmouseup="stopKeyHold(${c.id}, '${esc(c.command)}', this)"
                                onmouseleave="stopKeyHold(${c.id}, '${esc(c.command)}', this)"
                                ontouchstart="startKeyHold(${c.id}, '${esc(c.command)}', this); event.preventDefault()"
                                ontouchend="stopKeyHold(${c.id}, '${esc(c.command)}', this)"
                                ontouchcancel="stopKeyHold(${c.id}, '${esc(c.command)}', this)"
                                onpointercancel="stopKeyHold(${c.id}, '${esc(c.command)}', this)"
                                title="${esc(c.label || c.command)} (hold)" ${btnStyle}>
                            <i class="fa-solid ${esc(c.icon || 'fa-keyboard')}"></i>
                            <span>${esc(c.label || c.command)}</span>
                            ${bindingBadge}
                        </button>
                    `;
                } else {
                    // Regular button — single click
                    const cd = (c.cooldown_ms != null && Number.isFinite(Number(c.cooldown_ms))) ? Number(c.cooldown_ms) : 100;
                    return `
                        <button class="control-btn" data-id="${c.id}" data-cmd="${esc(c.command)}" data-cooldown="${cd}"
                                data-keybind="${esc(c.key_binding || '')}"
                                onclick="sendControl(${c.id}, '${esc(c.command)}', this, ${cd})"
                                title="${esc(c.label || c.command)}" ${btnStyle}>
                            <i class="fa-solid ${esc(c.icon || 'fa-circle')}"></i>
                            <span>${esc(c.label || c.command)}</span>
                            ${bindingBadge}
                        </button>
                    `;
                }
            }).join('');
            html += '</div>';
        }

        // Render ONVIF camera controls
        if (onvifControls.length > 0) {
            const uniqueCameras = [...new Set(onvifControls.map(c => c.camera_id))];
            for (const cameraId of uniqueCameras) {
                const cameraControls = onvifControls.filter(c => c.camera_id === cameraId);
                try {
                    const cameraData = await api(`/onvif/cameras/${cameraId}`);
                    html += renderOnvifCameraWidget(cameraData, cameraControls);
                } catch (e) {
                    console.warn(`Failed to load camera ${cameraId}:`, e);
                }
            }
        }

        grid.innerHTML = html;

        // Setup video click overlay if enabled
        if (hasVideoClick) {
            setupVideoClickOverlay();
        } else {
            destroyVideoClickOverlay();
        }

        // Connect control WS
        connectControlWs(streamId);
    } catch (e) {
        console.error('Failed to load controls:', e);
        _controlsHaveContent = false;
        _applyControlsVisibility();
    }
}

/**
 * Build inline style string for a button (sanitized server-side)
 */
function buildBtnStyle(control) {
    const parts = [];
    if (control.btn_color) parts.push(`color:${control.btn_color}`);
    if (control.btn_bg) parts.push(`background:${control.btn_bg}`);
    if (control.btn_border_color) parts.push(`border-color:${control.btn_border_color}`);
    return parts.length ? `style="${parts.join(';')}"` : '';
}

/**
 * Render ONVIF camera control widget (D-pad + zoom + presets)
 */
function renderOnvifCameraWidget(camera, controls) {
    const id = `onvif-${camera.id}`;
    
    return `
        <div class="onvif-widget" id="${id}">
            <div class="onvif-header">
                <h3><i class="fa-solid fa-video"></i> ${esc(camera.name)}</h3>
                <span class="onvif-status ${camera.status === 'connected' ? 'connected' : camera.status === 'unreachable' ? 'unreachable' : 'unknown'}">
                    ${camera.status === 'connected' ? '🟢' : camera.status === 'unreachable' ? '🔴' : '⚪'}
                </span>
            </div>

            <div class="onvif-controls">
                <!-- D-Pad for Pan/Tilt -->
                <div class="dpad-container">
                    <button class="dpad-btn dpad-up" onclick="sendOnvifCommand(${camera.id}, 'tilt_up', this, 200)" title="Tilt up">
                        <i class="fa-solid fa-arrow-up"></i>
                    </button>
                    <button class="dpad-btn dpad-left" onclick="sendOnvifCommand(${camera.id}, 'pan_left', this, 200)" title="Pan left">
                        <i class="fa-solid fa-arrow-left"></i>
                    </button>
                    <button class="dpad-btn dpad-center" onclick="sendOnvifCommand(${camera.id}, 'stop', this, 0)" title="Stop">
                        <i class="fa-solid fa-circle"></i>
                    </button>
                    <button class="dpad-btn dpad-right" onclick="sendOnvifCommand(${camera.id}, 'pan_right', this, 200)" title="Pan right">
                        <i class="fa-solid fa-arrow-right"></i>
                    </button>
                    <button class="dpad-btn dpad-down" onclick="sendOnvifCommand(${camera.id}, 'tilt_down', this, 200)" title="Tilt down">
                        <i class="fa-solid fa-arrow-down"></i>
                    </button>
                </div>

                <!-- Zoom Controls -->
                <div class="zoom-container">
                    <button class="zoom-btn zoom-out" onclick="sendOnvifCommand(${camera.id}, 'zoom_out', this, 200)" title="Zoom out">
                        <i class="fa-solid fa-minus"></i>
                    </button>
                    <input type="range" class="zoom-slider" min="0" max="100" value="50" 
                           onchange="setOnvifZoom(${camera.id}, this.value)" title="Zoom">
                    <button class="zoom-btn zoom-in" onclick="sendOnvifCommand(${camera.id}, 'zoom_in', this, 200)" title="Zoom in">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                </div>

                <!-- Preset Buttons -->
                <div class="presets-container" id="presets-${camera.id}">
                    <!-- Loaded dynamically -->
                </div>
            </div>
        </div>
    `;
}

/**
 * Load and render camera presets
 */
async function loadCameraPresets(cameraId) {
    try {
        const data = await api(`/onvif/cameras/${cameraId}/presets`);
        const presetsDiv = document.getElementById(`presets-${cameraId}`);
        if (!presetsDiv) return;

        if (!data.presets || data.presets.length === 0) {
            presetsDiv.innerHTML = '<p style="text-align:center;font-size:0.8em;color:#999;">No presets saved</p>';
            return;
        }

        presetsDiv.innerHTML = data.presets.map(preset => `
            <button class="preset-btn" onclick="gotoOnvifPreset(${cameraId}, ${preset.id}, this)">
                ${esc(preset.name)}
            </button>
        `).join('');
    } catch (e) {
        console.warn(`Failed to load presets for camera ${cameraId}:`, e);
    }
}

/* ═══════════════════════════════════════════════════════════════
   Video Click Overlay
   ═══════════════════════════════════════════════════════════════ */

function setupVideoClickOverlay() {
    let overlay = document.getElementById('video-click-overlay');
    if (overlay) return; // Already exists

    const container = document.getElementById('video-container');
    if (!container) return;

    overlay = document.createElement('div');
    overlay.id = 'video-click-overlay';
    overlay.className = 'video-click-overlay';
    overlay.title = 'Click to send coordinates';

    overlay.addEventListener('click', (e) => {
        const rect = overlay.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width;
        const y = (e.clientY - rect.top) / rect.height;
        sendVideoClick(x, y, e);
    });

    overlay.addEventListener('touchend', (e) => {
        if (e.changedTouches.length === 0) return;
        const touch = e.changedTouches[0];
        const rect = overlay.getBoundingClientRect();
        const x = (touch.clientX - rect.left) / rect.width;
        const y = (touch.clientY - rect.top) / rect.height;
        sendVideoClick(x, y, e);
    });

    container.appendChild(overlay);
}

function destroyVideoClickOverlay() {
    const overlay = document.getElementById('video-click-overlay');
    if (overlay) overlay.remove();
}

function sendVideoClick(x, y, event) {
    if (!controlWs || controlWs.readyState !== WebSocket.OPEN) return;

    const rateLimitMs = parseInt(controlSettings.video_click_rate_limit_ms || controlSettings.control_rate_limit_ms || 100);
    const key = 'video-click';
    if (controlCooldowns[key]) return;

    controlWs.send(JSON.stringify({
        type: 'video_click',
        x: Math.round(Math.max(0, Math.min(1, x)) * 10000) / 10000,
        y: Math.round(Math.max(0, Math.min(1, y)) * 10000) / 10000,
        streamId: currentStreamId,
    }));

    // Visual ripple at click position
    showClickRipple(event, x, y);

    // Cooldown
    if (rateLimitMs > 0) {
        controlCooldowns[key] = true;
        setTimeout(() => { delete controlCooldowns[key]; }, rateLimitMs);
    }
}

function showClickRipple(event, x, y) {
    const overlay = document.getElementById('video-click-overlay');
    if (!overlay) return;

    const ripple = document.createElement('div');
    ripple.className = 'click-ripple';
    ripple.style.left = (x * 100) + '%';
    ripple.style.top = (y * 100) + '%';
    overlay.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);
}

/* ═══════════════════════════════════════════════════════════════
   Keyboard Hold Detection (key_down / key_up)
   ═══════════════════════════════════════════════════════════════ */

function _checkControlWs() {
    if (!controlWs || controlWs.readyState !== WebSocket.OPEN) {
        toast('Controls reconnecting… please wait', 'error');
        return false;
    }
    return true;
}

function startKeyHold(controlId, command, btnEl) {
    if (!_checkControlWs()) return;

    const holdKey = `hold-${controlId}`;
    if (heldKeys.has(holdKey)) return; // Already holding
    heldKeys.set(holdKey, { controlId, command, btnEl });

    btnEl.classList.add('key-held');

    controlWs.send(JSON.stringify({
        type: 'key_down',
        control_id: controlId,
        command: command,
        streamId: currentStreamId,
    }));
}

function stopKeyHold(controlId, command, btnEl) {
    const holdKey = `hold-${controlId}`;
    if (!heldKeys.has(holdKey)) return;
    heldKeys.delete(holdKey);

    btnEl.classList.remove('key-held');

    if (controlWs && controlWs.readyState === WebSocket.OPEN) {
        controlWs.send(JSON.stringify({
            type: 'key_up',
            control_id: controlId,
            command: command,
            streamId: currentStreamId,
        }));
    }
}

/**
 * Force-release ALL currently held keys.
 * Called on: WS disconnect, tab blur, visibility hidden, page unload, stream switch.
 */
function _forceReleaseAllHeldKeys() {
    if (heldKeys.size === 0) return;
    for (const [holdKey, state] of heldKeys) {
        if (state.btnEl) state.btnEl.classList.remove('key-held');
        // Best-effort send key_up — WS may already be closed
        if (controlWs && controlWs.readyState === WebSocket.OPEN) {
            try {
                controlWs.send(JSON.stringify({
                    type: 'key_up',
                    control_id: state.controlId,
                    command: state.command,
                    streamId: currentStreamId,
                }));
            } catch { /* WS send failed — hardware cleanup is server-side */ }
        }
    }
    heldKeys.clear();
    document.querySelectorAll('.control-btn-keyboard.key-held').forEach(b => b.classList.remove('key-held'));
}

/**
 * Connect to the control WebSocket with auto-reconnect.
 */
function connectControlWs(streamId) {
    destroyControlWs();
    _controlStreamId = streamId;
    _controlReconnectDelay = 1000;

    _connectControlWsInner(streamId);
}

function _connectControlWsInner(streamId) {
    if (_controlReconnectTimer) { clearTimeout(_controlReconnectTimer); _controlReconnectTimer = null; }

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const params = new URLSearchParams();
    params.set('mode', 'viewer');
    params.set('stream', String(streamId));

    const token = localStorage.getItem('token');
    if (token) params.set('token', token);

    const wsUrl = `${protocol}://${window.location.host}/ws/control?${params.toString()}`;

    controlWs = new WebSocket(wsUrl);

    controlWs.onopen = () => {
        console.log('[Controls] WebSocket connected');
        _controlReconnectDelay = 1000; // Reset backoff on successful connect
        _updateControlConnectionUI(true);
    };

    controlWs.onmessage = (e) => {
        try {
            const msg = JSON.parse(e.data);
            handleControlMessage(msg);
        } catch (err) {
            console.warn('Failed to parse control message:', err);
        }
    };

    controlWs.onerror = (err) => {
        console.warn('[Controls] WS error:', err);
    };

    controlWs.onclose = (e) => {
        console.log(`[Controls] WS closed (code=${e.code})`);
        // Force-release held keys — hardware bridge needs key_up cleanup
        _forceReleaseAllHeldKeys();
        controlWs = null;
        _updateControlConnectionUI(false);

        // Auto-reconnect if we still have a target stream
        if (_controlStreamId) {
            _controlReconnectTimer = setTimeout(() => {
                if (_controlStreamId) {
                    console.log(`[Controls] Reconnecting (delay=${_controlReconnectDelay}ms)...`);
                    _connectControlWsInner(_controlStreamId);
                }
            }, _controlReconnectDelay);
            // Exponential backoff: 1s → 2s → 4s → 8s → max 15s
            _controlReconnectDelay = Math.min(_controlReconnectDelay * 2, 15000);
        }
    };
}

function destroyControlWs() {
    // Stop reconnect
    _controlStreamId = null;
    if (_controlReconnectTimer) { clearTimeout(_controlReconnectTimer); _controlReconnectTimer = null; }

    // Force-release any held keys before closing WS
    _forceReleaseAllHeldKeys();

    if (controlWs) {
        controlWs.close();
        controlWs = null;
    }
    controlCooldowns = {};
    onvifCooldowns = {};
    _hardwareConnected = false;
    _updateControlConnectionUI(false);
}

/**
 * Update the controls panel header to show connection + hardware status.
 */
function _updateControlConnectionUI(wsConnected) {
    // Compact status indicator (no redundant "Controls" label — the tab is the title).
    const el = document.getElementById('controls-status');
    if (!el) return;
    if (!wsConnected) {
        el.innerHTML = '<span class="control-dot control-dot-disconnected" title="Reconnecting…">⚫</span> <span class="controls-status-txt">Reconnecting…</span>';
    } else if (_hardwareConnected) {
        el.innerHTML = '<span class="control-dot control-dot-online" title="Hardware connected">🟢</span> <span class="controls-status-txt">Hardware connected</span>';
    } else {
        el.innerHTML = '<span class="control-dot control-dot-waiting" title="Waiting for hardware bridge">🟡</span> <span class="controls-status-txt">Waiting for hardware…</span>';
    }
}

/* ── Send regular command ─────────────────────────────────────── */
function sendControl(controlId, command, btnEl, cooldownMs) {
    if (!_checkControlWs()) return;

    const globalRateLimitMs = parseInt(controlSettings.control_rate_limit_ms || 0) || 0;
    // Support 0ms cooldown: only default to 100 if explicitly null/undefined/NaN
    const rawCooldown = (cooldownMs != null && Number.isFinite(Number(cooldownMs))) ? Number(cooldownMs) : 100;
    const effectiveCooldownMs = Math.max(rawCooldown, globalRateLimitMs);
    const cooldownKey = `cmd-${controlId}`;
    const globalCooldownKey = 'cmd-global';
    if (controlCooldowns[cooldownKey] || controlCooldowns[globalCooldownKey]) return;

    controlWs.send(JSON.stringify({
        type: 'command',
        control_id: controlId,
        command: command,
        streamId: currentStreamId,
    }));

    // Apply cooldown
    btnEl.classList.add('on-cooldown');
    controlCooldowns[cooldownKey] = true;
    controlCooldowns[globalCooldownKey] = true;

    setTimeout(() => {
        btnEl.classList.remove('on-cooldown');
        delete controlCooldowns[cooldownKey];
        delete controlCooldowns[globalCooldownKey];
    }, effectiveCooldownMs);
}

/* ── Send ONVIF command ──────────────────────────────────────── */
function sendOnvifCommand(cameraId, movement, btnEl, cooldownMs) {
    if (!_checkControlWs()) return;

    // Check cooldown
    const cooldownKey = `onvif-${cameraId}-${movement}`;
    if (onvifCooldowns[cooldownKey]) return;

    controlWs.send(JSON.stringify({
        type: 'command',
        streamId: currentStreamId,
        isOnvif: true,
        cameraId: cameraId,
        movement: movement,
    }));

    // Apply cooldown
    if (btnEl) {
        btnEl.classList.add('on-cooldown');
    }
    onvifCooldowns[cooldownKey] = true;

    setTimeout(() => {
        if (btnEl) {
            btnEl.classList.remove('on-cooldown');
        }
        delete onvifCooldowns[cooldownKey];
    }, cooldownMs || 200);
}

/**
 * Adjust zoom level (sends discrete zoom_in/zoom_out as slider moves)
 */
let lastZoomValue = 50;
function setOnvifZoom(cameraId, value) {
    const numValue = parseInt(value);
    if (numValue > lastZoomValue) {
        sendOnvifCommand(cameraId, 'zoom_in', null, 100);
    } else if (numValue < lastZoomValue) {
        sendOnvifCommand(cameraId, 'zoom_out', null, 100);
    }
    lastZoomValue = numValue;
}

/**
 * Go to a saved preset position
 */
function gotoOnvifPreset(cameraId, presetId, btnEl) {
    if (!_checkControlWs()) return;

    const cooldownKey = `preset-${cameraId}-${presetId}`;
    if (onvifCooldowns[cooldownKey]) return;

    controlWs.send(JSON.stringify({
        type: 'command',
        streamId: currentStreamId,
        isOnvif: true,
        cameraId: cameraId,
        movement: 'preset',
        presetId: presetId,
    }));

    btnEl.classList.add('on-cooldown');
    onvifCooldowns[cooldownKey] = true;

    setTimeout(() => {
        btnEl.classList.remove('on-cooldown');
        delete onvifCooldowns[cooldownKey];
    }, 500);
}

/* ── Handle incoming control messages ─────────────────────────── */
function handleControlMessage(msg) {
    switch (msg.type) {
        case 'command_executed':
            showControlActivity(msg.command, msg.by);
            break;
        case 'onvif_activity':
            showOnvifActivity(msg.camera_name, msg.movement, msg.by);
            break;
        case 'hardware_status':
            _hardwareConnected = !!msg.connected;
            _hardwareStatusKnown = true;
            _updateControlConnectionUI(true);
            _applyControlsVisibility();
            break;
        case 'key_held':
            highlightHeldButton(msg.command, true);
            break;
        case 'key_released':
            highlightHeldButton(msg.command, false);
            break;
        case 'video_click_activity':
            showRemoteClickRipple(msg.x, msg.y, msg.by);
            break;
        case 'error':
            toast(msg.message || 'Control error', 'error');
            break;
        case 'cooldown':
            break;
        case 'ok':
            break;
    }
}

function showControlActivity(command, username) {
    const btn = document.querySelector(`.control-btn[data-cmd="${command}"]`);
    if (!btn) return;

    btn.style.borderColor = 'var(--accent)';
    btn.style.boxShadow = '0 0 8px rgba(139,92,246,0.4)';

    setTimeout(() => {
        btn.style.borderColor = '';
        btn.style.boxShadow = '';
    }, 300);
}

function highlightHeldButton(command, held) {
    const btn = document.querySelector(`.control-btn-keyboard[data-cmd="${command}"]`);
    if (!btn) return;
    if (held) {
        btn.classList.add('remote-held');
    } else {
        btn.classList.remove('remote-held');
    }
}

function showRemoteClickRipple(x, y, username) {
    const overlay = document.getElementById('video-click-overlay');
    if (!overlay) return;

    const ripple = document.createElement('div');
    ripple.className = 'click-ripple click-ripple-remote';
    ripple.style.left = (x * 100) + '%';
    ripple.style.top = (y * 100) + '%';
    overlay.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);
}

function showOnvifActivity(cameraName, movement, username) {
    const widget = document.querySelector('.onvif-widget');
    if (!widget) return;

    widget.style.borderColor = 'var(--accent)';
    widget.style.boxShadow = '0 0 12px rgba(139,92,246,0.5)';

    setTimeout(() => {
        widget.style.borderColor = '';
        widget.style.boxShadow = '';
    }, 300);
}

/* (hardware status handled by _updateControlConnectionUI) */

/* ── Keyboard controls ────────────────────────────────────────── */
// True when a keypress must NOT be captured as a hardware control: modifier
// combos (copy/paste/cut/select-all/devtools) and any editable focus (chat
// input, a selected message, contenteditable). Fixes Ctrl/Cmd+C on a chat
// message triggering a control + the "Hardware not connected" toast.
function _controlKeyShouldIgnore(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return true;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return true;
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return true;
    return false;
}

document.addEventListener('keydown', (e) => {
    if (!currentStreamId) return;
    if (_controlKeyShouldIgnore(e)) return;
    if (e.repeat) return; // Ignore OS key repeat for hold detection

    // Check keyboard-bound controls first
    const key = e.key.toLowerCase();
    const btn = document.querySelector(`.control-btn-keyboard[data-keybind="${key}"]`);
    if (btn) {
        e.preventDefault();
        const id = parseInt(btn.dataset.id);
        const cmd = btn.dataset.cmd;
        startKeyHold(id, cmd, btn);
        return;
    }

    // Also support regular button keybinds (single press)
    const regularBtn = document.querySelector(`.control-btn:not(.control-btn-keyboard)[data-keybind="${key}"]`);
    if (regularBtn) {
        e.preventDefault();
        const id = parseInt(regularBtn.dataset.id);
        const cmd = regularBtn.dataset.cmd;
        const cd = (regularBtn.dataset.cooldown != null && Number.isFinite(Number(regularBtn.dataset.cooldown))) ? Number(regularBtn.dataset.cooldown) : 500;
        sendControl(id, cmd, regularBtn, cd);
        return;
    }

    // ONVIF keyboard fallback
    const cameraId = getCurrentONVIFCamera();
    if (!cameraId) return;

    const keyMap = {
        'arrowup': 'tilt_up',
        'arrowdown': 'tilt_down',
        'arrowleft': 'pan_left',
        'arrowright': 'pan_right',
        '[': 'zoom_out',
        ']': 'zoom_in',
        ' ': 'stop',
    };

    const movement = keyMap[key];
    if (!movement) return;

    e.preventDefault();
    sendOnvifCommand(cameraId, movement, null, 200);
});

document.addEventListener('keyup', (e) => {
    if (!currentStreamId) return;
    if (_controlKeyShouldIgnore(e)) return;

    const key = e.key.toLowerCase();
    const btn = document.querySelector(`.control-btn-keyboard[data-keybind="${key}"]`);
    if (btn) {
        e.preventDefault();
        const id = parseInt(btn.dataset.id);
        const cmd = btn.dataset.cmd;
        stopKeyHold(id, cmd, btn);
    }
});

function getCurrentONVIFCamera() {
    const widget = document.querySelector('.onvif-widget');
    if (!widget) return null;
    const id = widget.id; // "onvif-{cameraId}"
    return parseInt(id.split('-')[1]);
}

/* ═══════════════════════════════════════════════════════════════
   Hold-key lifecycle: force-release on blur / visibility / unload
   ═══════════════════════════════════════════════════════════════ */
window.addEventListener('blur', () => _forceReleaseAllHeldKeys());
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') _forceReleaseAllHeldKeys();
});
window.addEventListener('beforeunload', () => _forceReleaseAllHeldKeys());
