'use strict';
/**
 * Admin routes for the OpenRe ingest switch (mounted at /api/admin/openre, admin only). The lead
 * flips a slot during a maintenance window agreed with the broadcaster (OpenRe.Stream README,
 * "RTMP cutover runbook").
 *
 *   GET /api/admin/openre/status                                   configuration + switched slots
 *   PUT /api/admin/openre/managed/:id/ingest-authority             { authority: 'openre'|'live', force? }
 */
const express = require('express');
const db = require('../db/database');
const { requireAdmin } = require('../auth/auth');
const client = require('./openre-client');
const authority = require('./authority');

const router = express.Router();

router.get('/status', requireAdmin, (req, res) => {
    let slots = [];
    let live = [];
    try {
        slots = db.all("SELECT id, user_id, slug, title, protocol, streaming_method, openre_stream_id FROM managed_streams WHERE ingest_authority = 'openre' ORDER BY id");
        live = db.all("SELECT session_id, managed_stream_id, stream_id, state, confirmed_at FROM openre_sessions WHERE state = 'live'");
    } catch { /* schema not ready */ }
    res.json({
        enabled: client.enabled(),
        openre_url: client.settings().url || null,
        events_secret_set: Boolean(process.env.OPENRE_EVENTS_SECRET),
        protocols: [...authority.OPENRE_PROTOCOLS],
        slots,
        live_sessions: live,
    });
});

router.put('/managed/:id/ingest-authority', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid managed stream id' });
    try {
        const r = await authority.setAuthority(id, String((req.body && req.body.authority) || ''), { force: Boolean(req.body && req.body.force) });
        if (r.error) return res.status(r.status).json({ error: r.error });
        console.log(`[OpenRe] admin ${req.user.username} set slot ${id} ingest authority to ${r.body.ingest_authority}`);
        return res.status(r.status).json(r.body);
    } catch (err) {
        console.error('[OpenRe] switch failed:', err.message);
        return res.status(err.status && err.status < 500 ? 409 : 502).json({ error: `OpenRe: ${err.message}` });
    }
});

module.exports = router;
