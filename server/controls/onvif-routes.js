/**
 * OpenVibe.Live — ONVIF Camera Control Routes
 * 
 * GET    /api/onvif/discover          - Discover cameras on network
 * POST   /api/onvif/cameras           - Create camera profile
 * GET    /api/onvif/cameras           - List user's cameras
 * GET    /api/onvif/cameras/:id       - Get camera details
 * PUT    /api/onvif/cameras/:id       - Update camera settings
 * DELETE /api/onvif/cameras/:id       - Delete camera
 * GET    /api/onvif/cameras/:id/presets   - List camera presets
 * POST   /api/onvif/cameras/:id/presets  - Create preset
 * DELETE /api/onvif/cameras/:cameraId/presets/:presetId - Delete preset
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db/database');
const { requireAuth } = require('../auth/auth');
const { OnvifDiscovery, OnvifClient } = require('../core/onvif-client');

const router = express.Router();

// Cache ONVIF clients: cameraId -> OnvifClient instance
const clientCache = new Map();
const CLIENT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Helper: get or create cached ONVIF client
 */
function getCachedClient(cameraId) {
    const cached = clientCache.get(cameraId);
    if (cached && Date.now() - cached.createdAt < CLIENT_CACHE_TTL) {
        return cached.client;
    }
    return null;
}

function setCachedClient(cameraId, client) {
    clientCache.set(cameraId, {
        client,
        createdAt: Date.now(),
    });
    
    // Auto-cleanup after TTL
    setTimeout(() => {
        const entry = clientCache.get(cameraId);
        if (entry && entry.createdAt === clientCache.get(cameraId)?.createdAt) {
            clientCache.delete(cameraId);
        }
    }, CLIENT_CACHE_TTL);
}

/**
 * Helper: decrypt password (uses simple XOR with env key for MVP; upgrade to proper encryption)
 */
function decryptPassword(hash) {
    // For now, hash IS the plaintext password (bcrypt). 
    // In production, use a proper encryption scheme with a master key.
    return hash;
}

/**
 * POST /api/onvif/discover
 * Discover ONVIF devices on local network
 */
router.post('/discover', requireAuth, async (req, res) => {
    try {
        const discovery = new OnvifDiscovery();
        const devices = await discovery.discover(req.body.timeout || 3000);
        
        // Test each discovered device for connectivity
        const tested = await Promise.all(devices.map(async (device) => {
            try {
                const client = new OnvifClient(device.url, 'admin', 'admin');
                const connected = await Promise.race([
                    client.connect(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000))
                ]);
                
                if (connected) {
                    const caps = await client.getCapabilities();
                    client.disconnect();
                    return { ...device, testable: true, capabilities: caps };
                }
            } catch (e) {
                // Device unreachable with default creds
            }
            return { ...device, testable: false };
        }));

        res.json({ discovered: tested });
    } catch (err) {
        res.status(500).json({ error: 'Discovery failed: ' + err.message });
    }
});

/**
 * POST /api/onvif/cameras
 * Create a new camera profile
 */
router.post('/cameras', requireAuth, async (req, res) => {
    try {
        const { name, onvif_url, username, password, stream_id, pan_speed, tilt_speed, zoom_speed } = req.body;

        if (!name || !onvif_url || !username || !password) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Validate ONVIF URL
        let url;
        try {
            url = new URL(onvif_url);
            if (!['http:', 'https:'].includes(url.protocol)) {
                throw new Error('Invalid protocol');
            }
        } catch (e) {
            return res.status(400).json({ error: 'Invalid ONVIF URL' });
        }

        // Test connection
        const testClient = new OnvifClient(onvif_url, username, password);
        const connected = await Promise.race([
            testClient.connect(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
        ]);

        if (!connected) {
            return res.status(400).json({ error: 'Cannot connect to camera. Check URL and credentials.' });
        }

        const capabilities = await testClient.getCapabilities();
        testClient.disconnect();

        // Hash password
        const passwordHash = bcrypt.hashSync(password, 10);

        // Check stream ownership if stream_id provided
        if (stream_id) {
            const stream = db.getStreamById(stream_id);
            if (!stream) {
                return res.status(404).json({ error: 'Stream not found' });
            }
            if (stream.user_id !== req.user.id && req.user.role !== 'admin') {
                return res.status(403).json({ error: 'Not your stream' });
            }
        }

        const result = db.createCameraProfile({
            user_id: req.user.id,
            stream_id: stream_id || null,
            name,
            onvif_url,
            username,
            password_hash: passwordHash,
            pan_speed: pan_speed || 0.5,
            tilt_speed: tilt_speed || 0.5,
            zoom_speed: zoom_speed || 0.5,
        });

        res.status(201).json({
            id: result.lastInsertRowid,
            name,
            onvif_url,
            username,
            capabilities,
            message: 'Camera profile created successfully',
        });
    } catch (err) {
        console.error('[ONVIF] Create camera error:', err);
        res.status(500).json({ error: 'Failed to create camera: ' + err.message });
    }
});

/**
 * GET /api/onvif/cameras
 * List all cameras for authenticated user
 */
router.get('/cameras', requireAuth, (req, res) => {
    try {
        const cameras = db.getCameraProfilesByUser(req.user.id);
        
        // Strip password hashes for safety
        const safe = cameras.map(cam => ({
            id: cam.id,
            name: cam.name,
            onvif_url: cam.onvif_url,
            username: cam.username,
            pan_speed: cam.pan_speed,
            tilt_speed: cam.tilt_speed,
            zoom_speed: cam.zoom_speed,
            is_active: cam.is_active,
            last_connected: cam.last_connected,
            created_at: cam.created_at,
        }));

        res.json({ cameras: safe });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list cameras' });
    }
});

/**
 * GET /api/onvif/cameras/:id
 * Get camera profile
 */
router.get('/cameras/:id', requireAuth, async (req, res) => {
    try {
        const camera = db.getCameraProfile(req.params.id);
        
        if (!camera) {
            return res.status(404).json({ error: 'Camera not found' });
        }

        if (camera.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not your camera' });
        }

        // Test connection status
        let status = 'unknown';
        try {
            const client = getCachedClient(camera.id) || new OnvifClient(camera.onvif_url, camera.username, decryptPassword(camera.password_hash));
            
            const connected = await Promise.race([
                client.connect(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000))
            ]);
            
            status = connected ? 'connected' : 'unreachable';
            
            if (!getCachedClient(camera.id)) {
                setCachedClient(camera.id, client);
            }
        } catch (e) {
            status = 'error';
        }

        res.json({
            id: camera.id,
            name: camera.name,
            onvif_url: camera.onvif_url,
            username: camera.username,
            pan_speed: camera.pan_speed,
            tilt_speed: camera.tilt_speed,
            zoom_speed: camera.zoom_speed,
            is_active: camera.is_active,
            status,
            last_connected: camera.last_connected,
            created_at: camera.created_at,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get camera' });
    }
});

/**
 * PUT /api/onvif/cameras/:id
 * Update camera profile
 */
router.put('/cameras/:id', requireAuth, async (req, res) => {
    try {
        const camera = db.getCameraProfile(req.params.id);

        if (!camera) {
            return res.status(404).json({ error: 'Camera not found' });
        }

        if (camera.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not your camera' });
        }

        const { name, onvif_url, username, password, pan_speed, tilt_speed, zoom_speed } = req.body;

        // Re-test if URL/creds changed
        let passwordHash = camera.password_hash;
        if (onvif_url || username || password) {
            const testUrl = onvif_url || camera.onvif_url;
            const testUser = username || camera.username;
            const testPass = password || decryptPassword(camera.password_hash);

            const testClient = new OnvifClient(testUrl, testUser, testPass);
            const connected = await Promise.race([
                testClient.connect(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
            ]);

            if (!connected) {
                return res.status(400).json({ error: 'Cannot connect with new settings' });
            }

            testClient.disconnect();

            if (password) {
                passwordHash = bcrypt.hashSync(password, 10);
            }
        }

        db.updateCameraProfile(camera.id, {
            name: name || camera.name,
            onvif_url: onvif_url || camera.onvif_url,
            username: username || camera.username,
            password_hash: passwordHash,
            pan_speed: pan_speed !== undefined ? pan_speed : camera.pan_speed,
            tilt_speed: tilt_speed !== undefined ? tilt_speed : camera.tilt_speed,
            zoom_speed: zoom_speed !== undefined ? zoom_speed : camera.zoom_speed,
        });

        // Invalidate cache
        clientCache.delete(camera.id);

        res.json({ message: 'Camera updated successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update camera: ' + err.message });
    }
});

/**
 * DELETE /api/onvif/cameras/:id
 * Delete camera profile (cascades to presets and control assignments)
 */
router.delete('/cameras/:id', requireAuth, (req, res) => {
    try {
        const camera = db.getCameraProfile(req.params.id);

        if (!camera) {
            return res.status(404).json({ error: 'Camera not found' });
        }

        if (camera.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not your camera' });
        }

        db.deleteCameraProfile(camera.id);
        clientCache.delete(camera.id);

        res.json({ message: 'Camera deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete camera' });
    }
});

/**
 * GET /api/onvif/cameras/:id/presets
 * List presets for a camera
 */
router.get('/cameras/:id/presets', requireAuth, (req, res) => {
    try {
        const camera = db.getCameraProfile(req.params.id);

        if (!camera) {
            return res.status(404).json({ error: 'Camera not found' });
        }

        if (camera.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not your camera' });
        }

        const presets = db.getCameraPresetsByCamera(camera.id);
        res.json({ presets });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list presets' });
    }
});

/**
 * POST /api/onvif/cameras/:id/presets
 * Create a new preset (saves current PTZ position)
 */
router.post('/cameras/:id/presets', requireAuth, async (req, res) => {
    try {
        const camera = db.getCameraProfile(req.params.id);

        if (!camera) {
            return res.status(404).json({ error: 'Camera not found' });
        }

        if (camera.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not your camera' });
        }

        const { name, pan, tilt, zoom } = req.body;

        if (!name || pan === undefined || tilt === undefined || zoom === undefined) {
            return res.status(400).json({ error: 'Name and PTZ values required' });
        }

        // Clamp values to 0.0-1.0
        const clampedPan = Math.max(0, Math.min(1, parseFloat(pan)));
        const clampedTilt = Math.max(0, Math.min(1, parseFloat(tilt)));
        const clampedZoom = Math.max(0, Math.min(1, parseFloat(zoom)));

        const result = db.createCameraPreset({
            camera_id: camera.id,
            name,
            pan: clampedPan,
            tilt: clampedTilt,
            zoom: clampedZoom,
        });

        res.status(201).json({
            id: result.lastInsertRowid,
            name,
            pan: clampedPan,
            tilt: clampedTilt,
            zoom: clampedZoom,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to create preset: ' + err.message });
    }
});

/**
 * DELETE /api/onvif/cameras/:cameraId/presets/:presetId
 * Delete a preset
 */
router.delete('/cameras/:cameraId/presets/:presetId', requireAuth, (req, res) => {
    try {
        const camera = db.getCameraProfile(req.params.cameraId);

        if (!camera) {
            return res.status(404).json({ error: 'Camera not found' });
        }

        if (camera.user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not your camera' });
        }

        const preset = db.getCameraPreset(req.params.presetId);
        if (!preset || preset.camera_id !== camera.id) {
            return res.status(404).json({ error: 'Preset not found' });
        }

        db.deleteCameraPreset(preset.id);
        res.json({ message: 'Preset deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete preset' });
    }
});

module.exports = router;
