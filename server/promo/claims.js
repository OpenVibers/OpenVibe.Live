/**
 * promo/claims.js — the cashout ledger behind the RobotStreamer switch bonus.
 *
 * Every payout the promo promises is a ROW here instead of a DM:
 *   switch    → a converted RobotStreamer streamer claims the $25–$50 (one per account)
 *   referral  → created automatically for the referrer when a switch claim is approved
 *               (VIP recruiter rate when the referrer is RS_PROMO_VIP_USER)
 *
 * Lifecycle: pending → approved → paid (or rejected). The user sees their balance
 * (pending / approved / paid) and requests a cashout; the owner approves and marks paid
 * from the admin panel. Payout rails today are manual (Zelle / PayPal / crypto details on
 * the claim); a Stripe rail plugs in on the same rows (method 'stripe', paid via Connect).
 */
'use strict';

const db = require('../db/database');
const config = require('../config');

const METHODS = new Set(['zelle', 'paypal', 'crypto', 'stripe']);
const STATUSES = new Set(['pending', 'approved', 'paid', 'rejected', 'cashout_requested']);

let _ready = false;
function ensureTables() {
    if (_ready) return;
    db.run(`CREATE TABLE IF NOT EXISTS promo_claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'switch',
        rs_username TEXT,
        method TEXT NOT NULL DEFAULT 'zelle',
        payout_detail TEXT,
        referrer_user_id INTEGER,
        referrer_username TEXT,
        source_claim_id INTEGER,
        amount_cents INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        note TEXT,
        admin_note TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        paid_at DATETIME
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_promo_claims_user ON promo_claims (user_id, id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_promo_claims_status ON promo_claims (status, id)');
    _ready = true;
}

function promo() { return config.rsPromo || {}; }
function clean(s, n) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n); }
function isVip(username) { const v = String(promo().vipUser || '').toLowerCase(); return !!v && String(username || '').toLowerCase() === v; }

function view(row) {
    if (!row) return null;
    const u = db.getUserById(row.user_id);
    return {
        id: row.id, kind: row.kind, status: row.status, method: row.method, rs_username: row.rs_username || null,
        payout_detail: row.payout_detail || null, referrer_username: row.referrer_username || null, source_claim_id: row.source_claim_id || null,
        amount_cents: row.amount_cents || 0, amount: Number(((row.amount_cents || 0) / 100).toFixed(2)),
        note: row.note || null, admin_note: row.admin_note || null,
        user: u ? { id: u.id, username: u.username, display_name: u.display_name || u.username, avatar_url: u.avatar_url || null } : { id: row.user_id, username: `user${row.user_id}` },
        created_at: row.created_at, updated_at: row.updated_at, paid_at: row.paid_at || null,
    };
}

/** A converted streamer files their switch claim. One per account. */
function submitSwitch(userId, { rs_username, method, payout_detail, referrer, note }) {
    ensureTables();
    const p = promo();
    if (p.enabled === false) throw new Error('The promo is paused right now');
    const rs = clean(rs_username, 60);
    if (!rs) throw new Error('Your RobotStreamer username is required');
    const m = String(method || 'zelle').toLowerCase();
    if (!METHODS.has(m)) throw new Error('Pick Zelle, PayPal or crypto');
    const detail = clean(payout_detail, 200);
    if (m !== 'stripe' && detail.length < 3) throw new Error(`Add where to send it (${m === 'crypto' ? 'coin + network + address' : m === 'paypal' ? 'PayPal email' : 'Zelle phone or email'})`);
    const existing = db.get(`SELECT * FROM promo_claims WHERE user_id = ? AND kind = 'switch' AND status != 'rejected'`, [userId]);
    if (existing) throw new Error(`You already have a switch claim (#${existing.id}, ${existing.status})`);
    let refUser = null;
    const refName = clean(referrer, 60).replace(/^@/, '');
    if (refName) {
        refUser = db.getUserByUsername(refName);
        if (!refUser) throw new Error(`No OpenVibe user called "${refName}" — check the referrer's username`);
        if (refUser.id === userId) throw new Error("You can't refer yourself. Nice try.");
    }
    // The amount is settled at approval (the range is $25–$50); default to the top of the range.
    const r = db.run(`INSERT INTO promo_claims (user_id, kind, rs_username, method, payout_detail, referrer_user_id, referrer_username, amount_cents, note)
                      VALUES (?, 'switch', ?, ?, ?, ?, ?, ?, ?)`, [userId, rs, m, detail || null, refUser ? refUser.id : null, refUser ? refUser.username : null, (p.amount || 50) * 100, clean(note, 300) || null]);
    const claim = db.get('SELECT * FROM promo_claims WHERE id = ?', [Number(r.lastInsertRowid)]);
    console.log(`[Promo] switch claim #${claim.id} by user ${userId} (RS ${rs}, ${m}${refUser ? `, referred by ${refUser.username}` : ''})`);
    try { require('../utils/notify').pushNotification({ user_id: userId, type: 'PROMO_CLAIM', title: 'Switch bonus claim received', message: `Claim #${claim.id} is in. You'll get a notification when it's approved and paid.`, icon: '💸', url: `${String(config.baseUrl || '').replace(/\/$/, '')}/` }); } catch { /* */ }
    return view(claim);
}

/** Owner decision. Approving a switch claim mints the referrer's referral claim. */
function setStatus(id, { status, amount, admin_note }, adminId) {
    ensureTables();
    const claim = db.get('SELECT * FROM promo_claims WHERE id = ?', [id]);
    if (!claim) throw new Error('No such claim');
    const st = String(status || '').toLowerCase();
    if (!STATUSES.has(st)) throw new Error('Bad status');
    const cents = amount != null && amount !== '' ? Math.round(Number(amount) * 100) : claim.amount_cents;
    if (!Number.isFinite(cents) || cents < 0) throw new Error('Bad amount');
    db.run(`UPDATE promo_claims SET status = ?, amount_cents = ?, admin_note = COALESCE(?, admin_note), updated_at = CURRENT_TIMESTAMP, paid_at = CASE WHEN ? = 'paid' THEN CURRENT_TIMESTAMP ELSE paid_at END WHERE id = ?`,
        [st, cents, admin_note != null ? clean(admin_note, 300) : null, st, id]);
    if (st === 'approved' && claim.kind === 'switch' && claim.referrer_user_id && claim.status !== 'approved' && claim.status !== 'paid') {
        const already = db.get(`SELECT id FROM promo_claims WHERE kind = 'referral' AND source_claim_id = ?`, [id]);
        if (!already) {
            const p = promo();
            const refAmount = isVip(claim.referrer_username) ? (p.vipReferral || 20) : (p.referral || 10);
            db.run(`INSERT INTO promo_claims (user_id, kind, rs_username, method, payout_detail, source_claim_id, amount_cents, status, note)
                    VALUES (?, 'referral', ?, 'zelle', NULL, ?, ?, 'approved', ?)`, [claim.referrer_user_id, claim.rs_username, id, refAmount * 100, `Referral for switch claim #${id}`]);
            try { require('../utils/notify').pushNotification({ user_id: claim.referrer_user_id, type: 'PROMO_REFERRAL', title: `Referral approved: $${refAmount}`, message: `${claim.rs_username} came over from RobotStreamer and named you. Add your payout details to cash out.`, icon: '💰', url: `${String(config.baseUrl || '').replace(/\/$/, '')}/` }); } catch { /* */ }
        }
    }
    if (st === 'approved' || st === 'paid' || st === 'rejected') {
        try { require('../utils/notify').pushNotification({ user_id: claim.user_id, type: 'PROMO_CLAIM', title: st === 'paid' ? `Paid: $${(cents / 100).toFixed(2)}` : st === 'approved' ? `Approved: $${(cents / 100).toFixed(2)}` : 'Claim not approved', message: st === 'paid' ? 'Sent. Thanks for switching.' : st === 'approved' ? 'Your switch bonus is approved — payout is on its way.' : (admin_note ? clean(admin_note, 200) : 'Reach out on Discord if you think this is wrong.'), icon: st === 'rejected' ? '😬' : '💸', url: `${String(config.baseUrl || '').replace(/\/$/, '')}/` }); } catch { /* */ }
    }
    return view(db.get('SELECT * FROM promo_claims WHERE id = ?', [id]));
}

/** The user updates payout details on their own claim (e.g. a referral row minted without any). */
function setPayout(id, userId, { method, payout_detail }) {
    ensureTables();
    const claim = db.get('SELECT * FROM promo_claims WHERE id = ? AND user_id = ?', [id, userId]);
    if (!claim) throw new Error('No such claim');
    if (claim.status === 'paid' || claim.status === 'rejected') throw new Error('That claim is closed');
    const m = String(method || claim.method).toLowerCase();
    if (!METHODS.has(m)) throw new Error('Pick Zelle, PayPal or crypto');
    const detail = clean(payout_detail, 200);
    if (detail.length < 3) throw new Error('Add where to send it');
    db.run('UPDATE promo_claims SET method = ?, payout_detail = ?, status = CASE WHEN status = ? THEN ? ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [m, detail, 'approved', 'cashout_requested', id]);
    return view(db.get('SELECT * FROM promo_claims WHERE id = ?', [id]));
}

function mine(userId) {
    ensureTables();
    const rows = db.all('SELECT * FROM promo_claims WHERE user_id = ? ORDER BY id DESC', [userId]).map(view);
    const sum = (f) => Number((rows.filter(f).reduce((n, r) => n + r.amount_cents, 0) / 100).toFixed(2));
    return {
        claims: rows,
        balance: { pending: sum(r => r.status === 'pending'), approved: sum(r => r.status === 'approved' || r.status === 'cashout_requested'), paid: sum(r => r.status === 'paid') },
        has_switch_claim: rows.some(r => r.kind === 'switch' && r.status !== 'rejected'),
        referral_rate: isVip(db.getUserById(userId)?.username) ? (promo().vipReferral || 20) : (promo().referral || 10),
    };
}

function listAll({ status = null, limit = 200 } = {}) {
    ensureTables();
    const rows = status ? db.all('SELECT * FROM promo_claims WHERE status = ? ORDER BY id DESC LIMIT ?', [status, limit]) : db.all('SELECT * FROM promo_claims ORDER BY CASE status WHEN ? THEN 0 WHEN ? THEN 1 WHEN ? THEN 2 ELSE 3 END, id DESC LIMIT ?', ['pending', 'cashout_requested', 'approved', limit]);
    const totals = db.get(`SELECT COALESCE(SUM(CASE WHEN status = 'pending' THEN amount_cents END), 0) AS pending, COALESCE(SUM(CASE WHEN status IN ('approved', 'cashout_requested') THEN amount_cents END), 0) AS approved, COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_cents END), 0) AS paid, COUNT(*) AS n FROM promo_claims`) || {};
    return { claims: rows.map(view), totals: { pending: (totals.pending || 0) / 100, approved: (totals.approved || 0) / 100, paid: (totals.paid || 0) / 100, count: totals.n || 0 } };
}

function stats() {
    ensureTables();
    const t = db.get(`SELECT COUNT(*) AS claims, COALESCE(SUM(kind = 'switch' AND status IN ('approved', 'paid')), 0) AS converted, COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_cents END), 0) AS paid_cents FROM promo_claims`) || {};
    return { claims: t.claims || 0, converted: t.converted || 0, paid: (t.paid_cents || 0) / 100 };
}

module.exports = { ensureTables, submitSwitch, setStatus, setPayout, mine, listAll, stats, view, METHODS, STATUSES };
