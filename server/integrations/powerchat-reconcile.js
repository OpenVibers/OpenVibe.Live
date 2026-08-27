/**
 * powerchat-reconcile.js — backfill missed donation.completed webhooks from
 * GET /streamers/:username/paid-messages (scope paid_messages:read).
 *
 * The signed webhook is the ONLY authoritative confirmation and stays the primary
 * credit path. But webhooks can be missed for good: the receiver was down past
 * PowerChat's ~24h retry tail, ~20 consecutive failures tripped its circuit
 * breaker, or a 410 disabled the endpoint. Until now a viewer who paid during
 * such a window simply never got their Vibes / subscription.
 *
 * /paid-messages is the same confirmed money as a cursor-paginated feed, and every
 * row echoes `appExternalRef` — the pcorder:/pcsub: ref we minted onto the checkout
 * link — so paid-but-uncredited orders are found by exact match, never guessed.
 *
 * Safe to run repeatedly and concurrently with live webhooks: everything is credited
 * through the same handleAttributedDonation() the webhook uses, which is idempotent
 * on the order's status. Work-list driven: no pending order → no API call at all.
 *
 * Envelope: written against { data: { rows, nextCursor } } (the corrected upstream
 * shape) and defensive on older deployments that left nextCursor outside `data`.
 */
'use strict';

const db = require('../db/database');
const oauth = require('./powerchat-oauth');
const checkout = require('./powerchat-checkout');

const PAGE_LIMIT = 100;
const MAX_PAGES_PER_HOST = 5;      // 500 newest confirmed tips per host per sweep
const LOOKBACK_DAYS = 3;           // intents live 1h; older pending orders are abandoned carts
const GRACE_MS = 2 * 60 * 60 * 1000; // rows may be a little older than the order (clock skew, slow checkout)
const SWEEP_MS = 15 * 60 * 1000;
const FIRST_SWEEP_MS = 2 * 60 * 1000;

function _sqliteTs(s) {
    if (!s) return 0;
    const t = Date.parse(String(s).includes('T') ? String(s) : String(s).replace(' ', 'T') + 'Z');
    return Number.isFinite(t) ? t : 0;
}
function _testAllowed() {
    try { const v = db.getSetting('powerchat_allow_test_fulfillment'); return v === true || v === 'true' || v === 1 || v === '1'; }
    catch { return false; }
}
function _hasScope(conn, scope) {
    return !!(conn && conn.access_token && conn.refresh_token && (!conn.scope || String(conn.scope).split(/\s+/).includes(scope)));
}

// Which PowerChat account hosted this order's checkout (where the money landed), and
// which local user "receives" it for the fulfillment pipeline.
//   pcsub direct → the streamer's own PowerChat; site → the site tips account.
function _hostFor(order) {
    const mode = String(order.provider_ref || 'site').split(':')[0];
    if (order.kind === 'subscription' && mode === 'direct' && order.streamer_id) {
        const conn = db.getPowerchatConnection(order.streamer_id);
        return conn && conn.powerchat_username ? { username: conn.powerchat_username, conn, receivingUserId: order.streamer_id } : null;
    }
    const site = checkout.getSiteAccount();
    if (!site) return null;
    const conn = db.getPowerchatConnectionByUsername(site.username);
    return { username: site.username, conn: conn || null, receivingUserId: conn ? conn.user_id : null };
}
function _refFor(order) {
    return order.kind === 'subscription' ? `pcsub:${order.id}` : `pcorder:${order.id}`;
}
function _page(json) {
    const d = json && json.data !== undefined ? json.data : json;
    const rows = Array.isArray(d) ? d : (d && Array.isArray(d.rows) ? d.rows : []);
    // Corrected shape nests nextCursor in data; older deployments put it beside it.
    const nextCursor = (d && !Array.isArray(d) && d.nextCursor != null) ? d.nextCursor
        : (json && json.nextCursor != null ? json.nextCursor : null);
    return { rows, nextCursor: nextCursor || null };
}

const _hostWarned = new Map();
function _warnHost(username, msg) {
    const now = Date.now();
    if ((_hostWarned.get(username) || 0) > now - 3600000) return;
    _hostWarned.set(username, now);
    console.warn(`[PowerChat] reconcile: ${msg} (@${username})`);
}

/** One sweep. Returns a summary; never throws. */
async function reconcileOnce() {
    const summary = { orders: 0, hosts: 0, pages: 0, rows: 0, credited: [], underpaid: [], skippedTest: 0, skippedHosts: 0, errors: 0 };
    let pending;
    try { pending = db.getPendingPowerchatOrders(LOOKBACK_DAYS) || []; } catch (e) { summary.errors++; return summary; }
    summary.orders = pending.length;
    if (!pending.length) return summary;

    // Group the work list by host account: one paged read per host, not per order.
    const hosts = new Map(); // username → { host, orders: Map(ref → order), oldestAt }
    for (const order of pending) {
        const host = _hostFor(order);
        if (!host) continue;
        const key = host.username.toLowerCase();
        let h = hosts.get(key);
        if (!h) { h = { host, orders: new Map(), oldestAt: Infinity }; hosts.set(key, h); }
        h.orders.set(_refFor(order), order);
        h.oldestAt = Math.min(h.oldestAt, _sqliteTs(order.created_at) || Date.now());
    }
    const allowTest = _testAllowed();

    for (const [, h] of hosts) {
        const { host, orders } = h;
        if (!_hasScope(host.conn, 'paid_messages:read')) {
            summary.skippedHosts++;
            _warnHost(host.username, `${orders.size} pending checkout(s) can't be reconciled — no connected account with paid_messages:read for the host`);
            continue;
        }
        summary.hosts++;
        let cursor = null;
        for (let page = 0; page < MAX_PAGES_PER_HOST && orders.size; page++) {
            let pg;
            try {
                const json = await oauth.apiRequest(host.conn.user_id, {
                    method: 'GET', path: '/paid-messages', username: host.username,
                    query: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
                });
                pg = _page(json);
            } catch (e) {
                summary.errors++;
                _warnHost(host.username, `paid-messages read failed: ${e.status || ''} ${e.message}`.trim());
                break;
            }
            summary.pages++;
            if (!pg.rows.length) break;
            let pastOldest = false;
            for (const row of pg.rows) {
                summary.rows++;
                if (_sqliteTs(row.occurredAt) && _sqliteTs(row.occurredAt) < h.oldestAt - GRACE_MS) pastOldest = true;
                const ref = row.appExternalRef ? String(row.appExternalRef) : '';
                if (!ref) continue;                       // someone else's tip — not ours to credit
                const order = orders.get(ref);
                if (!order) continue;                     // already credited, or not on this sweep's list
                if (row.source === 'developer_app') continue; // our own forwarded tip echo, never money in
                // /paid-messages rows carry NO isTest field, yet include source='manual_test'
                // rows (the no-payment-provider test tip path). PowerChat's own webhook
                // rule is isTest = event.isTest || source === 'manual_test' — mirror it, or
                // a test tip would be reconciled as real money on a production PowerChat.
                const isTest = !!row.isTest || row.source === 'manual_test';
                if (isTest && !allowTest) { summary.skippedTest++; continue; }
                // Same shape the webhook hands to the checkout module (money in integer cents).
                const data = {
                    eventId: row.eventId, occurredAt: row.occurredAt, source: row.source,
                    donorName: row.donorName, isAnonymous: !!row.isAnonymous, message: row.message,
                    amountCents: row.amountCents, currency: row.currency,
                    amountUsdCents: row.amountUsdCents != null ? row.amountUsdCents : row.amountCents,
                    appExternalRef: ref, isTest, reconciled: true,
                };
                let consumed = false;
                try { consumed = checkout.handleAttributedDonation(host.receivingUserId, data); }
                catch (e) { summary.errors++; console.warn(`[PowerChat] reconcile: fulfillment for ${ref} failed: ${e.message}`); }
                orders.delete(ref);
                let after = null;
                try { after = db.getPaymentOrderById(order.id); } catch { /* */ }
                if (after && after.status === 'credited') {
                    summary.credited.push({ ref, eventId: row.eventId, amountUsdCents: data.amountUsdCents, userId: order.user_id });
                    console.log(`[PowerChat] reconcile: credited ${ref} from paid-messages (event ${row.eventId || '?'}, $${(Number(data.amountUsdCents || 0) / 100).toFixed(2)}) — its webhook never arrived`);
                } else if (!consumed || (after && after.status !== 'credited')) {
                    summary.underpaid.push({ ref, eventId: row.eventId, amountUsdCents: data.amountUsdCents });
                }
            }
            if (!pg.nextCursor || pastOldest) break;   // null cursor = last page; older rows can't match
            cursor = pg.nextCursor;
        }
    }
    return summary;
}

let _timer = null;
function startReconciler() {
    if (_timer) return;
    const run = () => { reconcileOnce().catch((e) => console.warn('[PowerChat] reconcile sweep failed:', e.message)); };
    setTimeout(run, FIRST_SWEEP_MS).unref();
    _timer = setInterval(run, SWEEP_MS);
    if (_timer.unref) _timer.unref();
    console.log('[PowerChat] paid-messages reconciler started (backfills missed checkout webhooks every 15 min)');
}

module.exports = { reconcileOnce, startReconciler, _test: { page: _page } };
