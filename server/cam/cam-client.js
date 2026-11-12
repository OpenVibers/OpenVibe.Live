'use strict';
/**
 * OpenVibe.Cam — Live's server-side client for the cam button.
 *
 * Live calls Cam's POST /api/v1/stills with the viewer's own Network token (never a Cam service
 * token). Cam fetches OpenVibe.Media's public frame, stores the still in OpenVibe.Pics as that
 * person, and answers the still plus the exact line Live posts to the stream's chat.
 *
 * Env:
 *   CAM_URL   base URL   (default https://openvibe.cam)
 */
const drill = require('../drill');

const CAM_URL = (process.env.CAM_URL || 'https://openvibe.cam').replace(/\/+$/, '');
const TIMEOUT_MS = 10000;

class CamApiError extends Error {
    constructor(message, status, code) {
        super(message);
        this.name = 'CamApiError';
        this.status = status || 0;
        this.code = code || null;
    }
}

function available() { return !!CAM_URL && !drill.enabled; }

/** POST /api/v1/stills as the viewer. Resolves to Cam's JSON answer; rejects with CamApiError. */
async function createStill({ token, slot, streamId, caption }) {
    if (!available()) {
        throw new CamApiError('OpenVibe.Cam is unavailable right now', 503, 'cam.unavailable');
    }
    if (!token) {
        throw new CamApiError('A signed-in Network account is required', 401, 'cam.sign_in_required');
    }
    const res = await fetch(`${CAM_URL}/api/v1/stills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ slot, stream_id: streamId, caption }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let data = null;
    try { data = await res.json(); } catch { /* Cam's problem bodies are JSON; a proxy page is not */ }
    if (!res.ok) {
        const message = (data && (data.message || data.error)) || `OpenVibe.Cam answered ${res.status}`;
        throw new CamApiError(message, res.status, data && data.code);
    }
    return data;
}

// The signed-in person's camera choices on OpenVibe.Cam (GET/PUT /api/v1/me/camera-settings): the shared capture core
// syncs the ones that mean the same on any device (facing, resolution, mirror) through Live's /api/cam/settings.
async function cameraSettings({ token, method = 'GET', settings }) {
    if (!available()) throw new CamApiError('OpenVibe.Cam is unavailable right now', 503, 'cam.unavailable');
    if (!token) throw new CamApiError('A signed-in Network account is required', 401, 'cam.sign_in_required');
    const res = await fetch(`${CAM_URL}/api/v1/me/camera-settings`, {
        method, headers: { Authorization: `Bearer ${token}`, ...(method === 'PUT' ? { 'Content-Type': 'application/json' } : {}) },
        ...(method === 'PUT' ? { body: JSON.stringify(settings) } : {}), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json();
    if (!res.ok) throw new CamApiError(data.detail || 'Could not save camera settings', res.status, data.code);
    return data;
}

module.exports = { CAM_URL, available, createStill, cameraSettings, CamApiError };
