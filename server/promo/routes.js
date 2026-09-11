/**
 * promo/routes.js — the RobotStreamer switch bonus (mounted at /api/promo)
 *
 *   GET   /robotstreamer                  public promo config (amounts, VIP recruiter, owner, links) + public totals
 *   GET   /claims/mine                    signed in: my claims + balance (pending / approved / paid)
 *   POST  /claims                         signed in: file the switch claim { rs_username, method, payout_detail, referrer, note }
 *   PATCH /claims/:id/payout              signed in: set payout details on my claim (referral rows start without any)
 *   GET   /claims                         admin: every claim + totals (?status=pending)
 *   PATCH /claims/:id                     admin: { status: approved|paid|rejected|pending, amount, admin_note }
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../auth/auth');
const permissions = require('../auth/permissions');
const db = require('../db/database');
const config = require('../config');
const claims = require('./claims');

const router = express.Router();

router.get('/robotstreamer', (req, res) => {
    const p = config.rsPromo || {};
    let vip = null;
    try { const u = p.vipUser ? db.getUserByUsername(p.vipUser) : null; vip = { username: u ? u.username : p.vipUser, display_name: u ? (u.display_name || u.username) : p.vipUser, avatar_url: u ? u.avatar_url : null, referral: p.vipReferral || 20, exists: !!u }; } catch { vip = { username: p.vipUser, display_name: p.vipUser, referral: p.vipReferral || 20, exists: false }; }
    let totals = null; try { totals = claims.stats(); } catch { totals = null; }
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ enabled: p.enabled !== false, amount: p.amount || 50, amount_min: p.amountMin || 25, referral: p.referral || 10, vip, github: p.github || null, owner: p.owner || 'admin', discord: p.discord || null, totals, cashout: true });
});

// Public social proof: who got paid (username + amount + when). Only PAID rows, no payout details.
router.get('/receipts', (req, res) => {
    try {
        res.set('Cache-Control', 'public, max-age=60');
        const rows = claims.listAll({ status: 'paid', limit: 30 }).claims.map(c => ({ username: c.user.username, display_name: c.user.display_name, avatar_url: c.user.avatar_url, amount: c.amount, kind: c.kind, paid_at: c.paid_at }));
        res.json({ receipts: rows, totals: claims.stats() });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/claims/mine', requireAuth, (req, res) => {
    try { res.set('Cache-Control', 'no-store'); res.json(claims.mine(req.user.id)); } catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/claims', requireAuth, (req, res) => {
    try { res.json({ ok: true, claim: claims.submitSwitch(req.user.id, req.body || {}), mine: claims.mine(req.user.id) }); } catch (err) { res.status(400).json({ error: err.message }); }
});
router.patch('/claims/:id/payout', requireAuth, (req, res) => {
    try { res.json({ ok: true, claim: claims.setPayout(Number(req.params.id), req.user.id, req.body || {}), mine: claims.mine(req.user.id) }); } catch (err) { res.status(400).json({ error: err.message }); }
});
router.get('/claims', requireAuth, permissions.requireAdmin, (req, res) => {
    try { res.set('Cache-Control', 'no-store'); res.json(claims.listAll({ status: req.query.status ? String(req.query.status) : null })); } catch (err) { res.status(500).json({ error: err.message }); }
});
router.patch('/claims/:id', requireAuth, permissions.requireAdmin, (req, res) => {
    try { res.json({ ok: true, claim: claims.setStatus(Number(req.params.id), req.body || {}, req.user.id) }); } catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
