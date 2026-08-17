/**
 * OpenVibe.Live — ONVIF Camera Dashboard Management
 * 
 * Handles:
 * - Discovery of ONVIF cameras on local network
 * - Creating/updating/deleting camera profiles
 * - Managing camera presets
 * - Linking cameras to stream controls
 */

// currentStreamId is declared in controls.js (shared global)

/**
 * Load camera list on dashboard
 */
async function loadDashboardCameras() {
    const container = document.getElementById('dash-cameras-list');
    if (!container) return;

    try {
        const data = await api('/onvif/cameras');
        const cameras = data.cameras || [];

        if (!cameras.length) {
            container.innerHTML = '<p class="muted" style="font-size: 0.9rem;">No cameras added yet. Discover or add one to get started.</p>';
            return;
        }

        container.innerHTML = cameras.map(cam => `
            <div class="dash-camera-item" style="padding:8px;border:1px solid var(--border);border-radius:var(--radius);margin-bottom:8px">
                <div style="display:flex;justify-content:space-between;align-items:center">
                    <div>
                        <div style="font-weight:bold;color:var(--accent)">${esc(cam.name)}</div>
                        <div style="font-size:0.8rem;color:var(--text-secondary)">${esc(cam.onvif_url)}</div>
                        <div style="font-size:0.75rem;color:${cam.status === 'connected' ? '#0f0' : cam.status === 'unreachable' ? '#f00' : '#999'}">
                            ${cam.status === 'connected' ? '🟢 Connected' : cam.status === 'unreachable' ? '🔴 Unreachable' : '⚪ Unknown'}
                        </div>
                    </div>
                    <div style="display:flex;gap:4px">
                        <button class="btn btn-sm" onclick="showEditCameraModal(${cam.id})" title="Edit">
                            <i class="fa-solid fa-pencil"></i>
                        </button>
                        <button class="btn btn-sm" onclick="showCameraPresetsModal(${cam.id})" title="Manage Presets">
                            <i class="fa-solid fa-bookmark"></i>
                        </button>
                        <button class="btn btn-sm" onclick="deleteCamera(${cam.id})" title="Delete">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                </div>
            </div>
        `).join('');
    } catch (e) {
        container.innerHTML = `<p class="error">Failed to load cameras: ${e.message}</p>`;
    }
}

/**
 * Discover cameras on the network
 */
async function doDiscoverCameras() {
    const overlay = document.getElementById('modal-overlay');
    const statusDiv = document.getElementById('discovery-status') || document.createElement('div');

    if (!document.getElementById('discovery-status')) {
        statusDiv.id = 'discovery-status';
        statusDiv.style.marginTop = '12px';
        document.body.appendChild(statusDiv);
    }

    statusDiv.innerHTML = '<p>Scanning network for ONVIF cameras...</p>';

    try {
        const data = await api('/onvif/discover', {
            method: 'POST',
            body: JSON.stringify({ timeout: 5000 })
        });

        const cameras = data.discovered || [];

        if (!cameras.length) {
            statusDiv.innerHTML = '<p class="error">No cameras found. Check your network connection and firewall.</p>';
            return;
        }

        let html = '<h4 style="margin-top:12px">Found Devices:</h4>';
        html += cameras.map((cam, idx) => `
            <div style="margin:8px 0;padding:8px;background:var(--bg-hover);border-radius:var(--radius)">
                <strong>${esc(cam.ip)}</strong> — ${cam.testable ? '✓ Testable' : '?  May need credentials'}
                <button class="btn btn-sm" style="float:right" onclick="selectDiscoveredCamera('${esc(cam.url)}')">
                    <i class="fa-solid fa-plus"></i> Add
                </button>
            </div>
        `).join('');

        statusDiv.innerHTML = html;
    } catch (e) {
        statusDiv.innerHTML = `<p class="error">Discovery failed: ${e.message}</p>`;
    }
}

function selectDiscoveredCamera(url) {
    document.getElementById('modal-cam-url').value = url;
    toast('URL filled. Enter credentials and click Add Camera.', 'info');
}

/**
 * Add new camera
 */
async function doAddCamera() {
    const url = document.getElementById('modal-cam-url')?.value.trim();
    const username = document.getElementById('modal-cam-username')?.value.trim();
    const password = document.getElementById('modal-cam-password')?.value;
    const name = document.getElementById('modal-cam-name')?.value.trim();

    if (!url || !username || !password || !name) {
        toast('All fields required', 'error');
        return;
    }

    try {
        const result = await api('/onvif/cameras', {
            method: 'POST',
            body: JSON.stringify({
                onvif_url: url,
                username,
                password,
                name,
                stream_id: currentStreamId,
            })
        });

        toast(`Camera "${result.name}" added!`, 'success');
        closeModal();
        loadDashboardCameras();
    } catch (e) {
        toast(`Failed to add camera: ${e.message}`, 'error');
    }
}

/**
 * Edit camera
 */
async function doEditCamera(cameraId) {
    const url = document.getElementById('modal-cam-url')?.value.trim();
    const username = document.getElementById('modal-cam-username')?.value.trim();
    const password = document.getElementById('modal-cam-password')?.value || undefined;
    const name = document.getElementById('modal-cam-name')?.value.trim();
    const panSpeed = parseFloat(document.getElementById('modal-cam-pan-speed')?.value) || 0.5;
    const tiltSpeed = parseFloat(document.getElementById('modal-cam-tilt-speed')?.value) || 0.5;
    const zoomSpeed = parseFloat(document.getElementById('modal-cam-zoom-speed')?.value) || 0.5;

    const data = { name, onvif_url: url, username, pan_speed: panSpeed, tilt_speed: tiltSpeed, zoom_speed: zoomSpeed };
    if (password) data.password = password;

    try {
        await api(`/onvif/cameras/${cameraId}`, {
            method: 'PUT',
            body: JSON.stringify(data)
        });

        toast('Camera updated!', 'success');
        closeModal();
        loadDashboardCameras();
    } catch (e) {
        toast(`Failed to update camera: ${e.message}`, 'error');
    }
}

/**
 * Delete camera
 */
async function deleteCamera(cameraId) {
    if (!confirm('Delete this camera?')) return;

    try {
        await api(`/onvif/cameras/${cameraId}`, { method: 'DELETE' });
        toast('Camera deleted', 'success');
        loadDashboardCameras();
    } catch (e) {
        toast(`Failed to delete camera: ${e.message}`, 'error');
    }
}

/**
 * Show camera presets modal
 */
async function showCameraPresetsModal(cameraId) {
    const overlay = document.getElementById('modal-overlay');
    const content = document.getElementById('modal-content');

    try {
        const camData = await api(`/onvif/cameras/${cameraId}`);
        const presetData = await api(`/onvif/cameras/${cameraId}/presets`);
        const presets = presetData.presets || [];

        let html = `
            <h3>${esc(camData.name)} — Presets</h3>
            <p class="muted" style="font-size:0.85rem;">Saved PTZ (pan-tilt-zoom) positions that viewers can jump to.</p>
            <div id="presets-list" style="max-height:300px;overflow-y:auto;margin-bottom:12px">
        `;

        if (presets.length > 0) {
            html += presets.map(p => `
                <div style="padding:8px;border:1px solid var(--border);border-radius:var(--radius);margin-bottom:6px">
                    <strong>${esc(p.name)}</strong>
                    <button class="btn btn-sm" style="float:right" onclick="deletePreset(${cameraId}, ${p.id})">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            `).join('');
        } else {
            html += '<p class="muted">No presets saved yet.</p>';
        }

        html += `
            </div>
            <h4 style="margin-top:12px">Save Current Position as Preset</h4>
            <div class="form-group">
                <label>Preset Name</label>
                <input type="text" id="preset-name"  class="form-input" placeholder="e.g. Home Position">
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
                <div class="form-group">
                    <label style="font-size:0.85rem">Pan (0–1)</label>
                    <input type="range" id="preset-pan" class="form-input" min="0" max="1" step="0.01" value="0.5">
                    <small id="pan-val">0.50</small>
                </div>
                <div class="form-group">
                    <label style="font-size:0.85rem">Tilt (0–1)</label>
                    <input type="range" id="preset-tilt" class="form-input" min="0" max="1" step="0.01" value="0.5">
                    <small id="tilt-val">0.50</small>
                </div>
                <div class="form-group">
                    <label style="font-size:0.85rem">Zoom (0–1)</label>
                    <input type="range" id="preset-zoom" class="form-input" min="0" max="1" step="0.01" value="0.5">
                    <small id="zoom-val">0.50</small>
                </div>
            </div>
            <button class="btn btn-primary btn-lg" onclick="doSavePreset(${cameraId})" style="width:100%;margin-top:8px">
                <i class="fa-solid fa-bookmark"></i> Save Preset
            </button>
        `;

        content.innerHTML = html;
        overlay.style.display = 'flex';

        // Update value displays
        ['pan', 'tilt', 'zoom'].forEach(axis => {
            const input = document.getElementById(`preset-${axis}`);
            if (input) {
                input.addEventListener('input', (e) => {
                    document.getElementById(`${axis}-val`).textContent = parseFloat(e.target.value).toFixed(2);
                });
            }
        });
    } catch (e) {
        toast(`Failed to load presets: ${e.message}`, 'error');
    }
}

async function doSavePreset(cameraId) {
    const name = document.getElementById('preset-name')?.value.trim();
    const pan = parseFloat(document.getElementById('preset-pan')?.value) || 0.5;
    const tilt = parseFloat(document.getElementById('preset-tilt')?.value) || 0.5;
    const zoom = parseFloat(document.getElementById('preset-zoom')?.value) || 0.5;

    if (!name) {
        toast('Preset name required', 'error');
        return;
    }

    try {
        await api(`/onvif/cameras/${cameraId}/presets`, {
            method: 'POST',
            body: JSON.stringify({ name, pan, tilt, zoom })
        });

        toast('Preset saved!', 'success');
        showCameraPresetsModal(cameraId);
    } catch (e) {
        toast(`Failed to save preset: ${e.message}`, 'error');
    }
}

async function deletePreset(cameraId, presetId) {
    if (!confirm('Delete this preset?')) return;

    try {
        await api(`/onvif/cameras/${cameraId}/presets/${presetId}`, { method: 'DELETE' });
        showCameraPresetsModal(cameraId);
    } catch (e) {
        toast(`Failed to delete preset: ${e.message}`, 'error');
    }
}

/**
 * Show edit camera modal
 */
async function showEditCameraModal(cameraId) {
    const overlay = document.getElementById('modal-overlay');
    const content = document.getElementById('modal-content');

    try {
        const camData = await api(`/onvif/cameras/${cameraId}`);

        const html = `
            <h3><i class="fa-solid fa-video"></i> Edit Camera</h3>
            <div class="form-group">
                <label>Camera Name</label>
                <input type="text" id="modal-cam-name" class="form-input" value="${esc(camData.name)}">
            </div>
            <div class="form-group">
                <label>ONVIF URL</label>
                <input type="text" id="modal-cam-url" class="form-input" value="${esc(camData.onvif_url)}">
            </div>
            <div class="form-group">
                <label>Username</label>
                <input type="text" id="modal-cam-username" class="form-input" value="${esc(camData.username)}">
            </div>
            <div class="form-group">
                <label>Password (leave blank to keep current)</label>
                <input type="password" id="modal-cam-password" class="form-input">
            </div>
            <h4 style="margin-top:12px">Movement Speeds (0.0–1.0)</h4>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
                <div class="form-group">
                    <label style="font-size:0.85rem">Pan Speed</label>
                    <input type="range" id="modal-cam-pan-speed" min="0" max="1" step="0.1" value="${camData.pan_speed}">
                    <small>${camData.pan_speed}</small>
                </div>
                <div class="form-group">
                    <label style="font-size:0.85rem">Tilt Speed</label>
                    <input type="range" id="modal-cam-tilt-speed" min="0" max="1" step="0.1" value="${camData.tilt_speed}">
                    <small>${camData.tilt_speed}</small>
                </div>
                <div class="form-group">
                    <label style="font-size:0.85rem">Zoom Speed</label>
                    <input type="range" id="modal-cam-zoom-speed" min="0" max="1" step="0.1" value="${camData.zoom_speed}">
                    <small>${camData.zoom_speed}</small>
                </div>
            </div>
            <button class="btn btn-primary btn-lg" onclick="doEditCamera(${cameraId})" style="width:100%;margin-top:12px">
                <i class="fa-solid fa-floppy-disk"></i> Save Changes
            </button>
        `;

        content.innerHTML = html;
        overlay.style.display = 'flex';
    } catch (e) {
        toast(`Failed to load camera: ${e.message}`, 'error');
    }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('dash-cameras-list')) {
        loadDashboardCameras();
    }
});
