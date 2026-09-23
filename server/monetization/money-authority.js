'use strict';
/**
 * Who holds the money, and whether it may move (roadmap Wave 8, ADR-012).
 *
 * BILLING_AUTHORITY is read here and nowhere else:
 *   live     (default) Live's own columns and tables, exactly as before the Billing cutover.
 *   billing  OpenVibe.Billing is the ledger. Live asks it for every money action (billing-client.js,
 *            billing-actions.js) and never writes users.openvibe_bucks_balance /
 *            openvibe_bucks_cashout_balance, transactions, payment_orders or subscriptions — those
 *            become legacy, read-only (the database-level tripwire below enforces it).
 *   anything else is a misconfiguration: every Live money write is refused, never guessed.
 *
 * money_writes_frozen (site setting, owner-only, both modes) is runbook step 3 of the cutover: it
 * refuses every money action a person or an operator starts on Live — checkouts, donations and
 * tips, Vibes-paid media requests and their refunds, cashout requests/approvals/denials, recycling,
 * subscribing, cancelling, and the renewal sweep. Reads keep working. Provider confirmations of
 * checkouts that were started BEFORE the freeze (PowerChat/Stripe/PayPal/CCBill/crypto webhooks,
 * the PayPal return, the PowerChat paid-messages reconciler) still settle in `live` mode: that
 * money has already been taken by the provider, and refusing it would drop a real payment. The
 * runbook waits for them before the final snapshot.
 */

const MODES = ['live', 'billing'];

/** 'live' | 'billing' | 'invalid' — read on every call so tests and the admin page see the truth. */
function authority() {
    const raw = process.env.BILLING_AUTHORITY;
    if (raw === undefined || String(raw).trim() === '') return 'live';
    const v = String(raw).trim().toLowerCase();
    return MODES.includes(v) ? v : 'invalid';
}
const onBilling = () => authority() === 'billing';

class LedgerReadOnlyError extends Error {
    constructor(what, mode) {
        super(mode === 'billing'
            ? `Live's money columns are read-only (BILLING_AUTHORITY=billing): ${what} must go through OpenVibe.Billing`
            : `BILLING_AUTHORITY=${JSON.stringify(process.env.BILLING_AUTHORITY)} is not 'live' or 'billing': ${what} refused`);
        this.name = 'LedgerReadOnlyError';
        this.status = 503;
        this.code = 'ledger_read_only';
    }
}

/** Tripwire for database.js: a Live money column/table write outside `live` mode throws. */
function assertLiveLedger(what) {
    const mode = authority();
    if (mode !== 'live') throw new LedgerReadOnlyError(what, mode);
}

// ── Freeze (money_writes_frozen) ─────────────────────────────
const db = () => require('../db/database');   // lazy: database.js requires this module

function isFrozen() {
    try {
        const v = db().getSetting('money_writes_frozen');
        return v === true || v === 'true' || v === 1 || v === '1';
    } catch { return false; }
}

function freezeState() {
    let meta = null;
    try { meta = db().getSetting('money_writes_frozen_meta'); } catch { /* */ }
    if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
    const frozen = isFrozen();
    return { frozen, reason: frozen && meta ? meta.reason || null : null, since: frozen && meta ? meta.at || null : null, by: frozen && meta ? meta.by || null : null };
}

function setFrozen(on, { reason = null, by = null } = {}) {
    const d = db();
    d.getDb().transaction(() => {
        d.setSetting('money_writes_frozen', on ? 'true' : 'false');
        d.setSetting('money_writes_frozen_meta', JSON.stringify(on ? { reason: reason ? String(reason).slice(0, 300) : null, by, at: new Date().toISOString() } : {}));
    })();
    console.warn(`[Money] Live money writes ${on ? 'FROZEN' : 'unfrozen'} by ${by || 'unknown'}${reason ? ` (${reason})` : ''}`);
    return freezeState();
}

/**
 * Why a money write must be refused right now, or null. The shape matches Live's usual
 * `{ error }` bodies plus a stable `code`.
 */
function writeRefusal() {
    const mode = authority();
    if (mode === 'invalid') {
        return { status: 503, body: { error: 'Payments are unavailable: the server\'s billing configuration is invalid.', code: 'billing_misconfigured' } };
    }
    if (isFrozen()) {
        const st = freezeState();
        return { status: 503, body: { error: 'Payments, donations and cashouts are paused for maintenance. Nothing was charged — please try again later.', code: 'money_writes_frozen', reason: st.reason || undefined } };
    }
    return null;
}

/** Express middleware for every route that starts a money action. */
function guardWrite(req, res, next) {
    const r = writeRefusal();
    if (r) return res.status(r.status).json(r.body);
    return next();
}

/** For code paths that are not routes (media requests, sweeps): throws the refusal as an Error. */
function assertWritable() {
    const r = writeRefusal();
    if (r) {
        const e = new Error(r.body.error);
        e.status = r.status;
        e.code = r.body.code;
        throw e;
    }
}

module.exports = { authority, onBilling, assertLiveLedger, LedgerReadOnlyError, isFrozen, freezeState, setFrozen, writeRefusal, guardWrite, assertWritable, MODES };
