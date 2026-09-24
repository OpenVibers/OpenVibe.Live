const express = require('express');

const db = require('../db/database');
const { requireAuth } = require('../auth/auth');
const robotStreamerService = require('./robotstreamer-service');

const router = express.Router();

/**
 * Resolve + authorize an optional managed_stream_id (stream slot) parameter.
 * Returns: null (no slot requested), a positive integer slot id, or false
 * (invalid/unauthorized — response already sent).
 */
function resolveSlotId(req, res) {
    const raw = req.query.managed_stream_id ?? req.body?.managed_stream_id;
    if (raw === undefined || raw === null || raw === '') return null;
    const id = parseInt(raw, 10);
    if (!Number.isFinite(id) || id <= 0) {
        res.status(400).json({ error: 'Invalid managed_stream_id' });
        return false;
    }
    const ms = db.getManagedStreamById(id);
    if (!ms || ms.user_id !== req.user.id) {
        res.status(403).json({ error: 'Not your stream slot' });
        return false;
    }
    return id;
}

/**
 * RobotStreamer is configured per stream slot only: the writes (validate, login, save, remove)
 * need a slot. Returns the slot id, or false with a 400 already sent.
 */
function requireSlotId(req, res) {
    const slotId = resolveSlotId(req, res);
    if (slotId === false) return false;
    if (!slotId) {
        res.status(400).json({ error: 'Choose a stream slot: RobotStreamer is set up per stream slot (managed_stream_id is required)' });
        return false;
    }
    return slotId;
}

/** Live streams on the slot whose RS config this is (a slot's row applies to that slot only). */
function liveStreamsForConfig(userId, slotId) {
    const liveStreams = db.getLiveStreamsByUserId(userId) || [];
    return liveStreams.filter(s => s.managed_stream_id === slotId);
}

// GET without a slot answers what does not depend on one (the server passthrough capability),
// with exists:false — never the legacy account-level row, which applies to no stream.
router.get('/integration', requireAuth, async (req, res) => {
    try {
        const slotId = resolveSlotId(req, res);
        if (slotId === false) return;

        const row = slotId ? db.getRobotStreamerIntegrationBySlot(req.user.id, slotId) : null;
        let availableRobots = [];

        // If a saved token + robot exists, re-fetch available robots so the dropdown populates on reload
        if (row?.token && row?.robot_id) {
            try {
                const pageData = await robotStreamerService.robotPageLoad(row.token, row.robot_id);
                availableRobots = robotStreamerService.extractAvailableRobots(pageData);
            } catch {
                // Non-fatal — dropdown just stays empty, user can re-validate
            }
        }

        res.json({
            integration: robotStreamerService.sanitizeIntegration(row, { available_robots: availableRobots }),
            exists: !!row,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load RobotStreamer settings' });
    }
});

router.post('/integration/validate', requireAuth, async (req, res) => {
    try {
        const slotId = requireSlotId(req, res);
        if (slotId === false) return;

        const existing = db.getRobotStreamerIntegrationBySlot(req.user.id, slotId);
        const token = typeof req.body.token === 'string' && req.body.token.trim()
            ? req.body.token.trim()
            : existing?.token;
        const robotInput = req.body.robot_input || req.body.robot_id || existing?.robot_id;
        const validated = await robotStreamerService.validateConfiguration({ token, robotInput });

        // Cache RS viewer count for this user's active robot
        const robotId = robotStreamerService.normalizeRobotInput(robotInput);
        const activeRobot = validated.availableRobots.find(r => String(r.robot_id) === String(robotId));
        if (activeRobot) {
            robotStreamerService.setRsViewerCount(req.user.id, activeRobot.viewers, slotId);
        }

        res.json({
            integration: robotStreamerService.sanitizeIntegration({
                ...(existing || {}),
                managed_stream_id: slotId,
                enabled: existing?.enabled || 0,
                mirror_chat: existing?.mirror_chat ?? 1,
                token,
                ...validated.fields,
            }, { available_robots: validated.availableRobots }),
        });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to validate RobotStreamer settings' });
    }
});

// Log in with RobotStreamer username + password to auto-fetch the token + robots,
// as an easier alternative to pasting the token manually. The password is never stored.
router.post('/integration/login', requireAuth, async (req, res) => {
    try {
        const slotId = requireSlotId(req, res);
        if (slotId === false) return;

        const login = await robotStreamerService.loginWithCredentials(req.body?.user_name, req.body?.password);

        // Persist the fetched token (write-only) so the user never has to paste it.
        db.upsertRobotStreamerIntegration(req.user.id, {
            token: login.token,
            owner_id: login.user_id || undefined,
            owner_name: login.user_name || undefined,
        }, slotId);

        // If the account has exactly one robot, fully configure + validate it now so
        // the user only has to hit Save (or nothing, if they enable it).
        let integration = null;
        if (login.robots.length === 1) {
            try {
                const result = await robotStreamerService.upsertIntegration(
                    req.user.id, { robot_input: login.robots[0].robot_id }, slotId);
                integration = result.integration;
            } catch (err) {
                console.warn('[RS] Auto-select single robot failed:', err.message);
            }
        }
        if (!integration) {
            const row = db.getRobotStreamerIntegrationBySlot(req.user.id, slotId);
            integration = robotStreamerService.sanitizeIntegration(row, { available_robots: login.robots });
        }

        res.json({
            success: true,
            user_name: login.user_name,
            robot_count: login.robots.length,
            available_robots: login.robots,
            integration,
        });
    } catch (err) {
        res.status(400).json({ error: err.message || 'RobotStreamer login failed' });
    }
});

router.put('/integration', requireAuth, async (req, res) => {
    try {
        const slotId = requireSlotId(req, res);
        if (slotId === false) return;

        const result = await robotStreamerService.upsertIntegration(req.user.id, req.body || {}, slotId);
        const affected = liveStreamsForConfig(req.user.id, slotId);

        if (!result.row?.enabled) {
            for (const stream of affected) {
                robotStreamerService.stopForStream(stream.id);
            }
        } else {
            for (const stream of affected) {
                if (result.row?.mirror_chat === 0) {
                    robotStreamerService.stopChatBridge(stream.id);
                }
                // startForStream handles both the native video publish and
                // (when mirror_chat is on) the chat bridge.
                robotStreamerService.startForStream(stream).catch((err) => {
                    console.warn(`[RS] Failed to start RS integration for stream ${stream.id}:`, err.message);
                });
            }
        }

        res.json({ integration: result.integration });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to save RobotStreamer settings' });
    }
});

// ── Server-side RobotStreamer restream control ───────────────
// The video passthrough runs on the server, so the dashboard's Start/Stop must reach it: before
// these routes existed the button only touched the browser's own (unused) publisher, and the
// only way to stop the robot was to disable the whole integration.
function ownLiveStream(req, res) {
    const id = parseInt(req.body?.stream_id, 10);
    const stream = Number.isFinite(id) ? db.getStreamById(id) : null;
    if (!stream || stream.user_id !== req.user.id) { res.status(404).json({ error: 'Stream not found' }); return null; }
    return stream;
}

router.post('/restream/start', requireAuth, async (req, res) => {
    try {
        const stream = ownLiveStream(req, res);
        if (!stream) return;
        if (!stream.is_live) return res.status(409).json({ error: 'Stream is not live' });
        const integration = robotStreamerService.getIntegrationForStream(stream);
        if (!integration?.enabled || !integration.token || !integration.robot_id) {
            return res.status(400).json({ error: 'RobotStreamer is not configured (or disabled) for this stream' });
        }
        if (!['webrtc', 'whip'].includes(stream.protocol) && !require('../streaming/webrtc-sfu').hasProducers(`stream-${stream.id}`)) {
            return res.status(400).json({ error: `RobotStreamer passthrough needs a browser or OBS/WHIP source; this stream is ${stream.protocol}` });
        }
        await robotStreamerService.startForStream(stream);
        const relay = require('./rs-passthrough-relay');
        res.json({ ok: true, status: relay.status(stream.id) });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to start RobotStreamer restream' });
    }
});

router.post('/restream/stop', requireAuth, (req, res) => {
    try {
        const stream = ownLiveStream(req, res);
        if (!stream) return;
        require('./rs-passthrough-relay').stop(stream.id);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to stop RobotStreamer restream' });
    }
});

// Remove a slot's RS config (the slot then has no RobotStreamer)
router.delete('/integration', requireAuth, (req, res) => {
    try {
        const slotId = requireSlotId(req, res);
        if (slotId === false) return;

        for (const stream of liveStreamsForConfig(req.user.id, slotId)) {
            robotStreamerService.stopForStream(stream.id);
        }
        db.deleteRobotStreamerIntegrationForSlot(req.user.id, slotId);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to remove RobotStreamer settings' });
    }
});

module.exports = router;
