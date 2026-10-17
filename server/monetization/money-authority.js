'use strict';
/**
 * Who holds the money, and whether it may move (ADR-012).
 *
 * OpenVibe.Billing is the money ledger since the cutover of 2026-10-17: Live asks it for every money action
 * (billing-client.js, billing-actions.js) and keeps no balance, order or subscription of its own. BILLING_AUTHORITY is
 * no longer read: there is no other mode to switch back to.
 *
 * money_writes_frozen (site setting, owner-only) refuses every money action a person or an operator starts on Live:
 * checkouts, donations and tips, Vibes-paid media requests and their refunds, cashout requests, recycling, subscribing
 * and cancelling. Reads keep working. Billing has its own freeze for its side.
 */

/** Always 'billing' (the admin page and the client config still show it). */
const authority = () => 'billing';

// ── Freeze (money_writes_frozen) ─────────────────────────────
const db = () => require('../db/database');   // lazy: no load cycle with database.js

async function isFrozen() {
    try {
        const v = await db().getSetting('money_writes_frozen');
        return v === true || v === 'true' || v === 1 || v === '1';
    } catch { return false; }
}

async function freezeState() {
    let meta = null;
    try { meta = await db().getSetting('money_writes_frozen_meta'); } catch { /* */ }
    if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
    const frozen = await isFrozen();
    return { frozen, reason: frozen && meta ? meta.reason || null : null, since: frozen && meta ? meta.at || null : null, by: frozen && meta ? meta.by || null : null };
}

async function setFrozen(on, { reason = null, by = null } = {}) {
    const d = db();
    await d.getDb().tx(async () => {
        await d.setSetting('money_writes_frozen', on ? 'true' : 'false');
        await d.setSetting('money_writes_frozen_meta', JSON.stringify(on ? { reason: reason ? String(reason).slice(0, 300) : null, by, at: new Date().toISOString() } : {}));
    });
    console.warn(`[Money] Live money writes ${on ? 'FROZEN' : 'unfrozen'} by ${by || 'unknown'}${reason ? ` (${reason})` : ''}`);
    return await freezeState();
}

/**
 * Why a money write must be refused right now, or null. The shape matches Live's usual
 * `{ error }` bodies plus a stable `code`.
 */
async function writeRefusal() {
    if (await isFrozen()) {
        const st = await freezeState();
        return { status: 503, body: { error: 'Payments, donations and cashouts are paused for maintenance. Nothing was charged — please try again later.', code: 'money_writes_frozen', reason: st.reason || undefined } };
    }
    return null;
}

/** Express middleware for every route that starts a money action. */
async function guardWrite(req, res, next) {
    const r = await writeRefusal();
    if (r) return res.status(r.status).json(r.body);
    return next();
}

/** For code paths that are not routes (media requests, sweeps): throws the refusal as an Error. */
async function assertWritable() {
    const r = await writeRefusal();
    if (r) {
        const e = new Error(r.body.error);
        e.status = r.status;
        e.code = r.body.code;
        throw e;
    }
}

module.exports = { authority, isFrozen, freezeState, setFrozen, writeRefusal, guardWrite, assertWritable };
