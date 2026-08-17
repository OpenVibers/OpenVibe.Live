/**
 * OpenVibe.Live — TTS API Routes
 *
 * Public routes (authenticated users):
 *   GET  /api/tts/voices          — List available voices
 *   GET  /api/tts/settings        — Get TTS config for client
 *
 * Admin routes:
 *   GET  /api/tts/admin/settings  — Full TTS config with API keys
 *   PUT  /api/tts/admin/settings  — Update TTS config
 */
const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../auth/auth');
const { isOwner } = require('../auth/permissions');
const ttsEngine = require('./tts-engine');
const db = require('../db/database');

// TTS credential fields/keys are owner-only. Admins may still manage the
// non-secret TTS config (enabled, provider, limits, default voice).
const TTS_SECRET_FIELDS = ['googleApiKey', 'googleServiceAccount', 'awsAccessKeyId', 'awsSecretAccessKey'];
const TTS_SECRET_KEYS = new Set([
    'tts_google_api_key', 'tts_google_service_account',
    'tts_aws_access_key_id', 'tts_aws_secret_access_key',
]);
function maskTtsSecret(v) {
    if (!v) return v;
    const s = String(v);
    return s.length <= 8 ? '••••••••' : '••••' + s.slice(-4);
}

// ── Public: Get available voices ──────────────────────────────
router.get('/voices', (req, res) => {
    try {
        const voices = ttsEngine.getAvailableVoices();
        res.json({ voices });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Public: Get TTS settings for client ───────────────────────
router.get('/settings', (req, res) => {
    try {
        const settings = ttsEngine.getTTSSettings();
        // Don't expose API keys to the client
        res.json({
            enabled: settings.enabled,
            provider: settings.provider,
            googleConfigured: !!(settings.googleApiKey || settings.googleServiceAccount),
            pollyConfigured: !!settings.awsAccessKeyId,
            espeakAvailable: !!ttsEngine.detectEspeak(),
            maxLength: settings.maxLength,
            maxQueuePerUser: settings.maxQueuePerUser,
            maxQueueGlobal: settings.maxQueueGlobal,
            defaultVoice: settings.defaultVoice,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Admin: Get full TTS config ────────────────────────────────
router.get('/admin/settings', requireAuth, requireAdmin, (req, res) => {
    try {
        const settings = ttsEngine.getTTSSettings();
        // Mask credential fields for non-owners.
        if (!isOwner(req.user)) {
            for (const f of TTS_SECRET_FIELDS) {
                if (settings[f]) settings[f] = maskTtsSecret(settings[f]);
            }
            settings._secretsRedacted = true;
        }
        res.json({ settings });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Admin: Update TTS config ──────────────────────────────────
router.put('/admin/settings', requireAuth, requireAdmin, (req, res) => {
    try {
        const allowed = [
            'tts_enabled', 'tts_provider',
            'tts_google_api_key', 'tts_google_service_account',
            'tts_aws_access_key_id', 'tts_aws_secret_access_key', 'tts_aws_region',
            'tts_max_length', 'tts_max_queue_per_user', 'tts_max_queue_global',
            'tts_default_voice',
        ];
        const updates = req.body.settings || req.body;
        const owner = isOwner(req.user);
        let count = 0;
        for (const [key, value] of Object.entries(updates)) {
            if (!allowed.includes(key)) continue;
            // Credential keys are owner-only.
            if (TTS_SECRET_KEYS.has(key) && !owner) continue;
            // Never overwrite a stored secret with a masked placeholder.
            if (TTS_SECRET_KEYS.has(key) && typeof value === 'string' && /^••••/.test(value)) continue;
            db.setSetting(key, value);
            count++;
        }
        ttsEngine.invalidateSettingsCache();
        res.json({ success: true, updated: count });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Admin: Test voice synthesis ───────────────────────────────
router.post('/admin/test', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { voiceId, text } = req.body;
        const result = await ttsEngine.synthesize(text || 'This is a TTS test from OpenVibe.Live', voiceId);
        if (!result) return res.status(400).json({ error: 'Voice unavailable or TTS disabled' });
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
