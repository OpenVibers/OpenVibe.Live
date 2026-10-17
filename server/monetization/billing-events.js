'use strict';
/**
 * OpenVibe.Events → Live: what OpenVibe.Billing (the money ledger) settled, told to the people it concerns: the
 * notices and celebrations Live's own checkout, webhook and renewal sweeper sent before the cutover of 2026-10-17.
 *
 *   POST /internal/billing-events   Live's subscription to billing.transaction.settled and billing.entitlement.changed
 *                                   (scripts/subscribe-media-events.js --billing), signed with LIVE_EVENTS_SECRET
 *                                   (else MEDIA_EVENTS_SECRET), signature v2 only.
 *
 *   settled purchase               "Vibes credited" to the buyer
 *   settled subscription           "Subscribed!" to the subscriber when a provider paid it (a Vibes-paid one was bought
 *                                  on the page, which said so); a PowerChat-paid one also fires the sub alert on the
 *                                  streamer's PowerChat overlay (Live's subscribe route does that for Vibes-paid ones)
 *   settled site-routed tip        a PowerChat tip paid to the site account for a creator: the channel's celebration
 *                                  (chat line, sound, goal, tip history), as integrations/powerchat-webhook.js does
 *   entitlement renewal_insufficient_credit / renewal_failed / expired / grace_ended / stripe_not_renewed
 *                                  the subscriber's "Subscription update", in the words Live's sweeper used
 *
 * Each event acts once: an inbox receipt (consumer live-billing-notices) commits before anything is sent, and a test
 * transaction never notifies.
 */
const db = require('../db/database');

const CONSUMER = 'live-billing-notices';
const EVENT_ID_RE = /^evt_[0-9A-HJKMNP-TV-Z]{26}$/;
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const stats = { received: 0, applied: 0, duplicate: 0, ignored: 0, refused: 0 };
let inbox = null;

function ensureInbox() {
    if (!inbox) inbox = require('openvibe-sdk/events').createPgInbox(db.getDb());
    return inbox;
}

const subjectId = (s) => (s && typeof s === 'object' ? s.id : s);

/** A Network subject → the Live user it signed in as (null when it never did). */
async function liveUser(subject) {
    const id = subjectId(subject);
    if (!SUBJECT_RE.test(String(id || ''))) return null;
    const row = await db.get("SELECT user_id FROM linked_accounts WHERE service = 'network' AND subject_id = ? ORDER BY id DESC LIMIT 1", [id]);
    return row ? await db.getUserById(row.user_id) : null;
}

const nameOf = (u) => (u ? u.display_name || u.username : null);
const usd = (cents) => `$${(Math.round(Number(cents) || 0) / 100).toFixed(2)}`;
const day = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null; };

function notify(user, title, message, url = '/') {
    const { pushNotification } = require('../utils/notify');
    pushNotification({ user_id: user.id, type: 'PAYMENT', title, message, url });
}

/** What to do for one envelope: an async function to run after the receipt commits, or null. */
async function plan(ev) {
    const p = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
    if (ev.event_type === 'billing.transaction.settled') {
        if (p.test) return null;
        const meta = p.metadata && typeof p.metadata === 'object' ? p.metadata : {};
        if (p.type === 'purchase') {
            const buyer = await liveUser(p.to_subject);
            const bits = Number(meta.bits) || 0;
            if (!buyer || bits < 1) return null;
            return async () => notify(buyer, 'Vibes credited 🎉', `${bits.toLocaleString()} Vibes were added to your balance${meta.paid_cents ? ` (${usd(meta.paid_cents)})` : ''}.`);
        }
        if (p.type === 'subscription') {
            if (!p.provider) return null;
            const [subscriber, streamer] = [await liveUser(p.from_subject), await liveUser(p.to_subject)];
            if (!subscriber || !streamer) return null;
            const until = day(meta.period_end);
            return async () => {
                if (!meta.renewal) {
                    notify(subscriber, 'Subscribed! ⭐', `Your subscription to ${nameOf(streamer)} is active${until ? ` until ${until}` : ''}.`, `/@${encodeURIComponent(streamer.username)}`);
                }
                if (p.provider === 'powerchat') {
                    await require('../integrations/powerchat-platform').forwardSubscription(streamer.id, {
                        subscriberName: nameOf(subscriber), externalId: `billing:${p.transaction_id}`, isResub: !!meta.renewal,
                    });
                }
            };
        }
        if (p.type === 'donation' && p.provider === 'powerchat' && meta.route === 'site') {
            const [creator, donor] = [await liveUser(p.to_subject), await liveUser(p.from_subject)];
            const bits = Number(meta.amount_bits) || 0;
            if (!creator || bits < 1) return null;
            return async () => require('../integrations/powerchat-webhook').creditDonationPipeline(creator.id, {
                eventId: `billing:${p.transaction_id}`, amountUsdCents: bits, donorName: meta.donor_name || nameOf(donor) || 'Someone', message: meta.message || '',
            }, { fromUserId: donor ? donor.id : null });
        }
        return null;
    }
    if (ev.event_type === 'billing.entitlement.changed') {
        const sub = p.subscription && typeof p.subscription === 'object' ? p.subscription : {};
        const message = {
            renewal_insufficient_credit: 'Your subscription could not auto-renew: not enough Vibes. Top up and resubscribe!',
            renewal_failed: `A renewal payment failed${day(p.grace_until) ? `; it is tried again until ${day(p.grace_until)}` : ''}. Your subscription is paused until it goes through.`,
            stripe_not_renewed: 'Your card subscription was not renewed by Stripe and has ended.',
            // Someone who cancelled already knows it ends.
            expired: sub.cancel_at_period_end ? null : 'Your channel subscription has ended. Resubscribe any time!',
            grace_ended: 'Your channel subscription has ended: the renewal never went through. Resubscribe any time!',
        }[p.reason];
        if (!message) return null;
        const [subscriber, streamer] = [await liveUser(p.subject), await liveUser(p.streamer)];
        if (!subscriber) return null;
        return async () => notify(subscriber, 'Subscription update', `${streamer ? nameOf(streamer) + ': ' : ''}${message}`,
            streamer ? `/@${encodeURIComponent(streamer.username)}` : '/');
    }
    return null;
}

/** Apply one envelope at most once. Returns 'applied' | 'duplicate' | 'ignored:<why>'. */
async function apply(ev) {
    if (!ev || !EVENT_ID_RE.test(String(ev.event_id || ''))) return 'ignored:envelope';
    if (ev.source !== 'billing') return 'ignored:source';
    if (ev.event_type !== 'billing.transaction.settled' && ev.event_type !== 'billing.entitlement.changed') return 'ignored:type';
    let after = null;
    const out = await ensureInbox().once(CONSUMER, `billing:${ev.event_id}`, async () => { after = await plan(ev); return after ? 'notify' : 'nothing'; });
    if (out.duplicate) return 'duplicate';
    if (after) { try { await after(); } catch (e) { console.warn(`[BillingEvents] ${ev.event_type}:`, e.message); } }
    return 'applied';
}

/** Express handler (needs req.rawBody from the express.json verify hook). */
async function handler(req, res) {
    const key = require('../auth/network-events').secret();
    if (key.length < 32) return res.status(503).json({ error: 'LIVE_EVENTS_SECRET is not set' });
    const { parseDelivery } = require('openvibe-sdk/events');
    const delivery = parseDelivery(req.rawBody, req.headers, key, { requireV2: true });
    if (!delivery) { stats.refused++; return res.status(401).json({ error: 'bad signature' }); }
    stats.received++;
    try {
        const out = await apply(delivery.event);
        if (out === 'applied') stats.applied++; else if (out === 'duplicate') stats.duplicate++; else stats.ignored++;
        return res.status(204).end();
    } catch (e) {
        console.error(`[BillingEvents] ${delivery.event && delivery.event.event_type} failed:`, e.message);
        return res.status(500).json({ error: 'not applied; retry' });
    }
}

function _reset() { inbox = null; }

module.exports = { handler, apply, stats, CONSUMER, _reset };
