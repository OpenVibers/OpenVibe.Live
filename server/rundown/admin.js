'use strict';
/**
 * The owner's controls for The Rundown's episode pictures (docs/rundown.md): on/off, the image model and size, the
 * style line, a monthly spend cap with the month's spend, and "remake this episode's picture".
 *
 *   GET  /api/admin/rundown                        settings, this month's spend and the recent pictures
 *   PUT  /api/admin/rundown/settings               { settings: { enabled, model, size, style, monthly_cap_usd } }
 *   POST /api/admin/rundown/episodes/:streamId/remake
 *
 * Owner only: the settings decide where the network's picture money goes. The rows themselves are site_settings, so a
 * change is one revision in the configuration journal (rolls back like every other setting).
 */
const express = require('express');
const { requireAuth } = require('../auth/auth');
const permissions = require('../auth/permissions');
const siteConfig = require('../admin/site-config');
const pictures = require('./pictures');

const router = express.Router();
router.use(requireAuth, permissions.requireOwner);

const oneLine = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

function boolOf(v) {
    if (v === true || v === 'true' || v === 1 || v === '1' || v === 'on') return true;
    if (v === false || v === 'false' || v === 0 || v === '0' || v === 'off') return false;
    return null;
}

/** Validate a settings patch before anything is written. Every field is optional; the merged result must be valid. */
function validate(patch, current) {
    const out = {};
    const errors = {};
    if (patch.enabled !== undefined) {
        const b = boolOf(patch.enabled);
        if (b === null) errors.enabled = 'on/off must be true or false'; else out.enabled = b;
    }
    if (patch.model !== undefined) {
        const model = String(patch.model || '').trim();
        if (!pictures.MODEL_RE.test(model)) errors.model = 'the model must be an Exchange model id, e.g. openai/gpt-image-1-mini'; else out.model = model;
    }
    if (patch.size !== undefined) {
        const size = String(patch.size || '').trim();
        if (!pictures.SIZE_RE.test(size)) errors.size = 'the size must look like 1536x1024'; else out.size = size;
    }
    if (patch.style !== undefined) {
        const style = oneLine(patch.style, 240);
        if (!style) errors.style = 'the style line cannot be empty'; else out.style = style;
    }
    if (patch.monthly_cap_usd !== undefined) {
        if (patch.monthly_cap_usd === null || patch.monthly_cap_usd === '') out.monthly_cap_usd = null;
        else {
            const n = Number(patch.monthly_cap_usd);
            if (!Number.isFinite(n) || n < 0 || n > 1000) errors.monthly_cap_usd = 'the cap is 0–1000 US dollars a month (empty for no cap)';
            else out.monthly_cap_usd = Math.round(n * 100) / 100;
        }
    }
    if (Object.keys(errors).length) return { errors };
    return { values: { ...current, ...out } };
}

router.get('/', async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store');
        res.json(await pictures.status({ limit: req.query.limit }));
    } catch (e) {
        console.error('[Rundown pictures] admin read:', e.message);
        res.status(500).json({ error: 'Could not read the picture settings' });
    }
});

router.put('/settings', async (req, res) => {
    try {
        const body = (req.body && (req.body.settings || req.body)) || {};
        const current = await pictures.settings();
        const v = validate(body, current);
        if (v.errors) return res.status(400).json({ error: 'Some settings were not valid', errors: v.errors });
        const set = {
            [pictures.SETTINGS.enabled]: v.values.enabled ? 'true' : 'false',
            [pictures.SETTINGS.model]: v.values.model,
            [pictures.SETTINGS.size]: v.values.size,
            [pictures.SETTINGS.style]: v.values.style,
            [pictures.SETTINGS.monthly_cap_usd]: v.values.monthly_cap_usd == null ? '' : String(v.values.monthly_cap_usd),
        };
        await siteConfig.change({ set }, { actor: siteConfig.actorOf(req.user), reason: 'Rundown episode pictures' });
        res.json(await pictures.status());
    } catch (e) {
        console.error('[Rundown pictures] admin write:', e.message);
        res.status(500).json({ error: 'Could not save the picture settings' });
    }
});

router.post('/episodes/:streamId/remake', async (req, res) => {
    try {
        const streamId = Number(req.params.streamId);
        if (!Number.isSafeInteger(streamId) || streamId < 1) return res.status(400).json({ error: 'A stream id is required' });
        const body = req.body || {};
        const row = await pictures.remake(streamId, { model: body.model ? String(body.model) : null, size: body.size ? String(body.size) : null });
        // Start it now, in the background: the picture takes a minute and an HTTP request should not wait for it.
        pictures.tick({ streamId }).catch((e) => console.warn('[Rundown pictures] remake:', e.message));
        res.status(202).json({ ok: true, picture: row, message: row.status === 'refused' ? 'These words cannot be pictured; the stream thumbnail stays.' : 'Picture queued' });
    } catch (e) {
        const status = e && e.status ? e.status : 500;
        if (status >= 500) console.error('[Rundown pictures] remake:', e.message);
        res.status(status).json({ error: status < 500 ? e.message : 'Could not remake the picture' });
    }
});

module.exports = { router, validate };
