'use strict';
/* ─────────────────────────────────────────────────────────────────
   broadcast-devices.js — Camera/microphone enumeration,
   permission requests, and device-selection sync helpers.
   ─────────────────────────────────────────────────────────────── */

/* ── Device Enumeration ──────────────────────────────────────── */
/**
 * Refresh all device lists without requesting new permissions.
 * Useful after the user plugs in a new device or changes system defaults.
 * Call after navigator.mediaDevices.enumerateDevices() via the refresh button.
 */
async function refreshDeviceLists() {
    try {
        // Try to get labels — if we already have permission, this will work without prompting.
        // If we don't have permission, we'll get unlabeled devices but still refresh the lists.
        const devices = await navigator.mediaDevices.enumerateDevices();
        _populateCreateDeviceDropdowns(devices);
        // Also refresh the settings panel selects
        const camSelect = document.getElementById('bc-forceCamera');
        const audioSelect = document.getElementById('bc-forceAudio');
        if (camSelect) {
            const prev = camSelect.value;
            camSelect.innerHTML = '<option value="default">Default</option>';
            devices.filter(d => d.kind === 'videoinput').forEach(d => {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Camera ${d.deviceId.slice(0, 8)}`;
                camSelect.appendChild(opt);
            });
            _setSelectValueIfPresent(camSelect, prev);
        }
        if (audioSelect) {
            const prev = audioSelect.value;
            audioSelect.innerHTML = '<option value="default">Default</option>';
            devices.filter(d => d.kind === 'audioinput').forEach(d => {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Mic ${d.deviceId.slice(0, 8)}`;
                audioSelect.appendChild(opt);
            });
            _setSelectValueIfPresent(audioSelect, prev);
        }
        // Refresh screen share device selects too
        const screenMicSelect = document.getElementById('bc-ws-screen-mic-select');
        if (screenMicSelect) {
            const prev = screenMicSelect.value;
            screenMicSelect.innerHTML = '<option value="default">Default Microphone</option>';
            devices.filter(d => d.kind === 'audioinput').forEach(d => {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Mic ${d.deviceId.slice(0, 8)}`;
                screenMicSelect.appendChild(opt);
            });
            _setSelectValueIfPresent(screenMicSelect, prev);
        }
        const screenCamSelect = document.getElementById('bc-ws-screen-cam-select');
        if (screenCamSelect) {
            const prev = screenCamSelect.value;
            screenCamSelect.innerHTML = '<option value="default">Default Camera</option>';
            devices.filter(d => d.kind === 'videoinput').forEach(d => {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Camera ${d.deviceId.slice(0, 8)}`;
                screenCamSelect.appendChild(opt);
            });
            _setSelectValueIfPresent(screenCamSelect, prev);
        }
        if (typeof toast === 'function') toast('Device list refreshed', 'success');
    } catch (err) {
        console.warn('[Broadcast] refreshDeviceLists failed:', err.message);
        if (typeof toast === 'function') toast('Could not refresh devices: ' + err.message, 'error');
    }
}

async function populateDeviceLists() {
    try {
        // Try to get a temp stream for permission/label enumeration.
        // On Android, combined audio+video can fail — fall back to separate requests.
        // Skip getUserMedia if we already have labels (permissions already granted) to
        // avoid racing with startMediaCapture() which is called right after this.
        let tempStream = null;
        const preDevices = await navigator.mediaDevices.enumerateDevices();
        const alreadyHaveLabels = preDevices.some(d => d.label);
        if (!alreadyHaveLabels) {
            try {
                tempStream = await _getUserMediaWithTimeout({ audio: true, video: true }, 8000);
            } catch {
                // Separate fallback for Android
                try {
                    tempStream = new MediaStream();
                    const vs = await _getUserMediaWithTimeout({ video: true }, 6000).catch(() => null);
                    const as = await _getUserMediaWithTimeout({ audio: true }, 6000).catch(() => null);
                    if (vs) vs.getTracks().forEach(t => tempStream.addTrack(t));
                    if (as) as.getTracks().forEach(t => tempStream.addTrack(t));
                } catch {}
            }
        }
        const devices = await navigator.mediaDevices.enumerateDevices();
        const camSelect = document.getElementById('bc-forceCamera');
        const audioSelect = document.getElementById('bc-forceAudio');
        if (!camSelect || !audioSelect) return;
        camSelect.innerHTML = '<option value="default">Default</option>';
        audioSelect.innerHTML = '<option value="default">Default</option>';
        devices.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.textContent = d.label || `Device ${d.deviceId.slice(0, 8)}`;
            if (d.kind === 'videoinput') camSelect.appendChild(opt);
            if (d.kind === 'audioinput') audioSelect.appendChild(opt.cloneNode(true));
        });
        const preferredCamera = broadcastState.settings.forceCamera || localStorage.getItem('bc-last-camera') || 'default';
        _syncCameraSelectionUI(preferredCamera, { persist: false });
        _syncAudioSelectionUI(broadcastState.settings.forceAudio || 'default', { persist: false });
        if (tempStream) tempStream.getTracks().forEach(t => t.stop());
    } catch (err) { console.warn('Could not enumerate devices:', err.message); }
}

function _getPreferredCameraId() {
    return broadcastState.settings.forceCamera || localStorage.getItem('bc-last-camera') || 'default';
}

function _setSelectValueIfPresent(select, value) {
    if (!select) return;
    const normalized = value || 'default';
    const hasExact = Array.from(select.options || []).some(opt => opt.value === normalized);
    select.value = hasExact ? normalized : 'default';
}

let _switchingCamera = false;
function _syncCameraSelectionUI(cameraId, { persist = true } = {}) {
    const normalized = cameraId || 'default';
    _setSelectValueIfPresent(document.getElementById('bc-forceCamera'), normalized);
    _setSelectValueIfPresent(document.getElementById('bc-create-camera'), normalized);
    _setSelectValueIfPresent(document.getElementById('bc-screen-camera'), normalized);
    broadcastState.settings.forceCamera = normalized;
    if (persist) {
        saveBroadcastSettings();
        try { localStorage.setItem('bc-last-camera', normalized); } catch {}
        // If currently streaming (non-screen-share), switch the live camera track
        const ss = getActiveStreamState();
        if (ss && ss.localStream && !broadcastState.settings.screenShare && !_switchingCamera) {
            _switchingCamera = true;
            _switchActiveCamera(normalized).catch(err => {
                console.warn('[Broadcast] Live camera switch failed:', err.message);
            }).finally(() => { _switchingCamera = false; });
        }
    }
}

let _switchingAudio = false;
function _syncAudioSelectionUI(audioId, { persist = true } = {}) {
    const normalized = audioId || 'default';
    _setSelectValueIfPresent(document.getElementById('bc-forceAudio'), normalized);
    _setSelectValueIfPresent(document.getElementById('bc-create-audio'), normalized);
    _setSelectValueIfPresent(document.getElementById('bc-screen-audio'), normalized);
    broadcastState.settings.forceAudio = normalized;
    if (persist) {
        saveBroadcastSettings();
        try { localStorage.setItem('bc-last-audio', normalized); } catch {}
        const ss = getActiveStreamState();
        const streamId = broadcastState.activeStreamId;
        if (ss && ss.localStream && streamId && !_switchingAudio) {
            _switchingAudio = true;
            if (broadcastState.settings.screenShare) {
                // During screen share: rebuild the audio mix with the new mic instead of blocking
                _rebuildScreenShareAudio(normalized, streamId).catch(err => {
                    console.warn('[Broadcast] Screen share audio rebuild failed:', err.message);
                    toast('Could not switch mic during screen share: ' + err.message, 'error');
                }).finally(() => { _switchingAudio = false; });
            } else {
                // Normal camera mode: replace the live audio track
                _switchActiveAudio(normalized).catch(err => {
                    console.warn('[Broadcast] Live audio switch failed:', err.message);
                    toast('Could not switch mic: ' + err.message, 'error');
                }).finally(() => { _switchingAudio = false; });
            }
        }
    }
}

function _describeCameraRole(device, index = 0) {
    const label = String(device?.label || '').toLowerCase();
    if (label.includes('back') || label.includes('rear') || label.includes('environment') || label.includes('world')) {
        return { icon: 'fa-solid fa-camera', title: 'Rear Camera', detail: 'Best for outward-facing mobile video.' };
    }
    if (label.includes('front') || label.includes('user') || label.includes('face') || label.includes('facetime')) {
        return { icon: 'fa-solid fa-user', title: 'Front Camera', detail: 'Best for selfie-style streaming.' };
    }
    if (label.includes('external') || label.includes('usb') || label.includes('webcam') || label.includes('obs')) {
        return { icon: 'fa-solid fa-video', title: 'External Camera', detail: 'Detected as an external or USB camera.' };
    }
    return { icon: 'fa-solid fa-camera-retro', title: `Camera ${index + 1}`, detail: 'Available video input device.' };
}

function _getCameraFacingHint(device) {
    const label = String(device?.label || '').toLowerCase();
    if (label.includes('back') || label.includes('rear') || label.includes('environment') || label.includes('world')) return 'environment';
    if (label.includes('front') || label.includes('user') || label.includes('face') || label.includes('facetime')) return 'user';
    return null;
}

async function _enumerateBroadcastVideoInputs({ ensureLabels = false } = {}) {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    let tempStream = null;
    try {
        let devices = await navigator.mediaDevices.enumerateDevices();
        const missingLabels = devices.filter(d => d.kind === 'videoinput').some(d => !d.label);
        if (ensureLabels && missingLabels && navigator.mediaDevices?.getUserMedia) {
            try {
                tempStream = await _getUserMediaWithTimeout({ video: true, audio: false }, 8000);
                devices = await navigator.mediaDevices.enumerateDevices();
            } catch (err) {
                console.warn('[Broadcast] Could not refresh camera labels:', err.message);
            }
        }
        return devices.filter(d => d.kind === 'videoinput');
    } finally {
        if (tempStream) tempStream.getTracks().forEach(t => t.stop());
    }
}

/**
 * Check if we already have media permissions (devices have labels).
 * If so, show the device selects. Otherwise show the Request Permissions button.
 */
async function populateCreateFormDevices() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const hasLabels = devices.some(d => d.label);
        const permReq = document.getElementById('bc-perm-request');
        const devSelects = document.getElementById('bc-device-selects');
        if (hasLabels) {
            // Already have permissions — show dropdowns directly
            if (permReq) permReq.style.display = 'none';
            if (devSelects) devSelects.style.display = '';
            _populateCreateDeviceDropdowns(devices);
        } else {
            // No permissions yet — show the request button
            if (permReq) permReq.style.display = '';
            if (devSelects) devSelects.style.display = 'none';
        }
    } catch (err) { console.warn('Could not enumerate devices for create form:', err.message); }
}

/**
 * Helper: call getUserMedia with a timeout to avoid indefinite hangs on mobile.
 * Also handles Android-specific quirks:
 *  - Some Android devices need the previous track fully stopped before re-acquiring
 *  - OverconstrainedError gets retried with relaxed constraints
 */
function _getUserMediaWithTimeout(constraints, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Camera/mic request timed out — try tapping Allow in the browser prompt')), timeoutMs);
        navigator.mediaDevices.getUserMedia(constraints).then(stream => {
            clearTimeout(timer);
            resolve(stream);
        }).catch(err => {
            clearTimeout(timer);
            // On OverconstrainedError, retry with relaxed constraints
            if (err.name === 'OverconstrainedError') {
                const relaxed = {};
                if (constraints.video) relaxed.video = typeof constraints.video === 'object' ? { facingMode: constraints.video.facingMode || 'user' } : true;
                if (constraints.audio) relaxed.audio = typeof constraints.audio === 'object' ? { echoCancellation: true } : true;
                console.warn('[Broadcast] OverconstrainedError, retrying with relaxed constraints:', relaxed);
                navigator.mediaDevices.getUserMedia(relaxed).then(resolve).catch(reject);
                return;
            }
            reject(err);
        });
    });
}

/**
 * User clicked "Allow Camera & Mic" — request permissions, then populate lists.
 * On mobile Android, requesting audio+video together can silently fail,
 * so we try combined first, then individually.
 */
async function requestMediaPermissions() {
    console.log('[Broadcast] requestMediaPermissions() called');
    const permReq = document.getElementById('bc-perm-request');
    const devSelects = document.getElementById('bc-device-selects');
    const btn = document.getElementById('bc-perm-btn') || permReq?.querySelector('button');
    const dbg = document.getElementById('bc-perm-debug');
    const btnOrigText = btn?.innerHTML;

    // Immediate visual feedback — if user doesn't see spinner, the function isn't reached
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Requesting access...';
    }
    if (dbg) { dbg.style.display = ''; dbg.textContent = 'Requesting permissions...'; }

    // Feature detection
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        const msg = 'Camera/mic API not available — make sure you\'re using HTTPS';
        console.warn('[Broadcast]', msg);
        if (dbg) dbg.textContent = msg;
        toast(msg, 'error');
        if (btn) { btn.disabled = false; btn.innerHTML = btnOrigText; }
        return;
    }

    try {
        let tempStream;
        // Strategy 1: combined audio+video
        try {
            if (dbg) dbg.textContent = 'Requesting camera + mic...';
            tempStream = await _getUserMediaWithTimeout({ audio: true, video: true });
        } catch (firstErr) {
            console.warn('[Broadcast] Combined getUserMedia failed:', firstErr.message, '— trying separately');
            // Strategy 2: separate requests (common on Android)
            if (dbg) dbg.textContent = 'Combined failed, trying separately...';
            let vidStream, audStream;
            try { vidStream = await _getUserMediaWithTimeout({ video: { facingMode: 'user' } }, 10000); } catch (ve) {
                console.warn('[Broadcast] Video facingMode failed:', ve.message);
                // Strategy 2b: bare minimum video
                try { vidStream = await _getUserMediaWithTimeout({ video: true }, 10000); } catch (ve2) {
                    console.warn('[Broadcast] Video-only getUserMedia failed:', ve2.message);
                }
            }
            try { audStream = await _getUserMediaWithTimeout({ audio: true }, 10000); } catch (ae) { console.warn('[Broadcast] Audio-only getUserMedia failed:', ae.message); }
            if (!vidStream && !audStream) throw new Error('No camera or microphone available');
            tempStream = new MediaStream();
            if (vidStream) vidStream.getTracks().forEach(t => { tempStream.addTrack(t); });
            if (audStream) audStream.getTracks().forEach(t => { tempStream.addTrack(t); });
        }
        tempStream.getTracks().forEach(t => t.stop());
        if (dbg) dbg.textContent = 'Enumerating devices...';
        const devices = await navigator.mediaDevices.enumerateDevices();
        _populateCreateDeviceDropdowns(devices);

        // After permission grant, re-check what the browser actually gave us
        // and try to match to the user's saved preference. If no preference exists,
        // the browser's default selection stands.
        const savedAudio = broadcastState.settings.forceAudio || localStorage.getItem('bc-last-audio');
        if (savedAudio && savedAudio !== 'default') {
            _syncAudioSelectionUI(savedAudio, { persist: false });
        }
        const savedCamera = broadcastState.settings.forceCamera || localStorage.getItem('bc-last-camera');
        if (savedCamera && savedCamera !== 'default') {
            _syncCameraSelectionUI(savedCamera, { persist: false });
        }

        if (permReq) permReq.style.display = 'none';
        if (devSelects) devSelects.style.display = '';
        toast('Camera & microphone access granted', 'success');
    } catch (err) {
        console.warn('[Broadcast] Permission request failed:', err.message, err.name);
        const errDetail = `${err.name || 'Error'}: ${err.message}`;
        if (dbg) { dbg.style.display = ''; dbg.textContent = errDetail; }
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            toast('Camera/mic permission denied — check your browser settings or tap the lock icon in the address bar', 'error');
        } else if (err.name === 'NotFoundError') {
            toast('No camera or microphone found on this device', 'error');
        } else if (err.name === 'NotReadableError') {
            toast('Camera/mic in use by another app — close other camera/video apps and try again', 'error');
        } else if (err.name === 'OverconstrainedError') {
            toast('Camera does not support the requested settings — try a different camera', 'error');
        } else {
            toast('Could not access camera/mic: ' + err.message, 'error');
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = btnOrigText;
        }
    }
}

function _populateCreateDeviceDropdowns(devices) {
    const camSelect = document.getElementById('bc-create-camera');
    const audioSelect = document.getElementById('bc-create-audio');
    if (camSelect) {
        camSelect.innerHTML = '<option value="default">Default</option>';
        devices.filter(d => d.kind === 'videoinput').forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.textContent = d.label || `Camera ${d.deviceId.slice(0, 8)}`;
            camSelect.appendChild(opt);
        });
        _syncCameraSelectionUI(_getPreferredCameraId(), { persist: false });
        camSelect.onchange = () => _syncCameraSelectionUI(camSelect.value);
    }
    if (audioSelect) {
        audioSelect.innerHTML = '<option value="default">Default</option>';
        devices.filter(d => d.kind === 'audioinput').forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.textContent = d.label || `Mic ${d.deviceId.slice(0, 8)}`;
            audioSelect.appendChild(opt);
        });
        // Restore saved microphone selection (unified with broadcastState)
        _syncAudioSelectionUI(broadcastState.settings.forceAudio || localStorage.getItem('bc-last-audio') || 'default', { persist: false });
        audioSelect.onchange = () => _syncAudioSelectionUI(audioSelect.value);
    }

    // Also populate screen share device selects (same device lists)
    const screenAudioSelect = document.getElementById('bc-screen-audio');
    if (screenAudioSelect) {
        screenAudioSelect.innerHTML = '<option value="default">Default Microphone</option>';
        devices.filter(d => d.kind === 'audioinput').forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.textContent = d.label || `Mic ${d.deviceId.slice(0, 8)}`;
            screenAudioSelect.appendChild(opt);
        });
        // Sync from unified audio state
        _syncAudioSelectionUI(broadcastState.settings.forceAudio || 'default', { persist: false });
        screenAudioSelect.onchange = () => _syncAudioSelectionUI(screenAudioSelect.value);
    }
    const screenCamSelect = document.getElementById('bc-screen-camera');
    if (screenCamSelect) {
        screenCamSelect.innerHTML = '<option value="default">Default Camera</option>';
        devices.filter(d => d.kind === 'videoinput').forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.textContent = d.label || `Camera ${d.deviceId.slice(0, 8)}`;
            screenCamSelect.appendChild(opt);
        });
        _syncCameraSelectionUI(_getPreferredCameraId(), { persist: false });
    }
}

