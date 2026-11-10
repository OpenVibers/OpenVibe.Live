'use strict';
/**
 * The same list as openvibe-contracts/lib/money-reasons.js (0.390.0), copied so Live answers with the plain words
 * before its installed contract package carries the module. reasons.js prefers the installed copy when it is there.
 *
 * Money reasons: the plain words for a ledger row (2026-11-10).
 *
 * A ledger holds a key, never a sentence: OpenCoins rows carry `reason` ("quest:publish-a-video"),
 * Vibes/Balance rows carry a type and metadata. This list is the one place each kind is declared:
 * the key it matches, the site it belongs to, what its subject is (a quest, a stream, a tip, a
 * creator, an app, a project, a purchase), the phrase that names it, and how the subject's own
 * name and address are found.
 *
 * `describe(key, options)` makes `{ key, text, subject: { name, url } | null }`. `text` is the
 * phrase without the amount ("for the quest Publish a video"); the page writes
 * "+15 OpenCoins" before it and links the phrase to subject.url. A key nobody declared answers
 * "for something on <site>" and is marked known: false, so a caller logs it once and never shows
 * the key itself.
 *
 * `options.resolve` maps a subject type to a lookup: `{ quest: (id) => ({ name, url }) }`.
 * `options.subject` is an already-found subject (a tip's creator, a project). `options.site`
 * names the site for an undeclared key.
 */

/** The sites a key can belong to, in the words a person reads. */
const SITES = Object.freeze({
    quest: 'OpenVibe.Quest',
    fun: 'OpenVibe.Fun',
    live: 'OpenVibe.Live',
    network: 'OpenVibe.Network',
    billing: 'OpenVibe',
    inventory: 'OpenVibe.Inventory',
});

/**
 * One entry per reason kind.
 *   match        RegExp whose first group is the subject's id or name (or an exact key string)
 *   site         SITES key, for an undeclared key and for callers that show provenance
 *   subject      the subject type `options.resolve` can look up; omitted when there is none
 *   text         the phrase; `{name}` is where the subject's name goes
 *   fallback     the name when the subject cannot be found ("a creator", "an item")
 *   path         the subject's address; `{id}` is the matched group
 *   catalog      where the subject's own names live (a declaration for the resolver)
 */
const KINDS = Object.freeze([
    // ── OpenCoins: Network's coin_transactions.reason ───────────────────────────────────────────
    Object.freeze({ id: 'quest', match: /^quest:([a-z0-9-]+)$/i, site: 'quest', subject: 'quest', text: 'for the quest {name}',
        path: 'https://openvibe.quest/quests/{id}', catalog: 'https://openvibe.quest/api/v1/quests' }),
    Object.freeze({ id: 'fun-quest', match: /^fun:([a-z0-9-]+)$/i, site: 'fun', subject: 'fun-quest', text: 'for the quest {name}',
        path: 'https://openvibe.fun/q/{id}', catalog: 'https://openvibe.fun/api/v1/quests' }),
    Object.freeze({ id: 'media-request', match: /^Media request: (.+)$/, site: 'live', subject: 'media', text: 'for the stream {name}' }),
    Object.freeze({ id: 'media-refund', match: /^Refund: (.+)$/, site: 'live', subject: 'media', text: 'for a refund of {name}' }),
    Object.freeze({ id: 'migration', match: 'migration:hobo-coins', site: 'network', text: 'for OpenCoins moved from the old Live wallet' }),
    Object.freeze({ id: 'account-merge', match: 'account_merge', site: 'network', text: 'for merging your accounts' }),
    Object.freeze({ id: 'account-deleted', match: 'account_deleted', site: 'network', text: 'for closing your account' }),
    Object.freeze({ id: 'watch', match: 'watch', site: 'live', text: 'for watching a stream' }),
    Object.freeze({ id: 'chat', match: 'chat', site: 'live', text: 'for chatting on a stream' }),
    Object.freeze({ id: 'follow', match: 'follow', site: 'live', text: 'for following a channel' }),
    Object.freeze({ id: 'bonus-game', match: 'bonus game', site: 'live', text: 'for winning the bonus game' }),
    Object.freeze({ id: 'admin-grant', match: 'Admin grant', site: 'network', text: 'for OpenCoins from OpenVibe' }),

    // ── Vibes / Balance: Billing's transaction type + metadata ──────────────────────────────────
    Object.freeze({ id: 'ai-usage', match: 'credit:settle', site: 'billing', text: 'for AI usage' }),
    Object.freeze({ id: 'topup', match: 'credit:topup', site: 'billing', text: 'for adding money to your Balance' }),
    Object.freeze({ id: 'vibes-from-balance', match: 'purchase:vibes_from_balance', site: 'billing', text: 'for buying Vibes with your Balance' }),
    Object.freeze({ id: 'vibes-bought', match: 'purchase:vibes', site: 'billing', text: 'for buying Vibes' }),
    Object.freeze({ id: 'store-purchase', match: 'purchase:store', site: 'inventory', subject: 'item', text: 'for buying {name}', fallback: 'an item' }),
    Object.freeze({ id: 'app-payment', match: 'vibes_charge', site: 'billing', subject: 'app', text: 'for paying {name}', fallback: 'an app' }),
    Object.freeze({ id: 'app-purchase', match: 'purchase:app', site: 'billing', subject: 'app', text: 'for paying {name}', fallback: 'an app' }),
    Object.freeze({ id: 'tip', match: 'donation', site: 'billing', subject: 'creator', text: 'for a tip to {name}', fallback: 'a creator' }),
    Object.freeze({ id: 'tip-received', match: 'donation:received', site: 'billing', subject: 'creator', text: 'for a tip from {name}', fallback: 'someone' }),
    Object.freeze({ id: 'subscription', match: 'subscription', site: 'billing', subject: 'creator', text: 'for a subscription to {name}', fallback: 'a creator' }),
    Object.freeze({ id: 'subscription-share', match: 'subscription_share', site: 'billing', subject: 'creator', text: 'for a subscription to {name}', fallback: 'a creator' }),
    Object.freeze({ id: 'refund', match: 'refund', site: 'billing', text: 'for a refund' }),
    Object.freeze({ id: 'vibes-refund', match: 'vibes_refund', site: 'billing', text: 'for a refund of Vibes' }),
    Object.freeze({ id: 'move-to-project', match: 'balance_transfer', site: 'billing', subject: 'project', text: 'for moving money to {name}', fallback: 'a project' }),
    Object.freeze({ id: 'cashout-request', match: 'cashout_request', site: 'billing', text: 'for cashing out' }),
    Object.freeze({ id: 'cashout-paid', match: 'cashout_paid', site: 'billing', text: 'for a payout' }),
    Object.freeze({ id: 'cashout-denied', match: 'cashout_denied', site: 'billing', text: 'for a cashout that was denied' }),
    Object.freeze({ id: 'recycle', match: 'recycle', site: 'billing', text: 'for moving your cashout balance back to Vibes' }),
    Object.freeze({ id: 'adjustment', match: 'adjustment', site: 'billing', text: 'for an adjustment by OpenVibe' }),
]);

/** "live-setup-slot" → "Live setup slot": the name a slug gives when its catalog is not at hand. */
function titleFromSlug(slug) {
    const words = String(slug == null ? '' : slug).replace(/[-_]+/g, ' ').trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

function siteName(id) {
    return SITES[String(id || '').toLowerCase()] || 'OpenVibe';
}

function subjectFrom(value, kind, options) {
    if (options.subject && typeof options.subject === 'object' && options.subject.name) {
        return { name: String(options.subject.name).slice(0, 160), url: options.subject.url ? String(options.subject.url).slice(0, 500) : null };
    }
    let found = null;
    if (value != null && kind.subject && options.resolve && typeof options.resolve[kind.subject] === 'function') {
        try { found = options.resolve[kind.subject](value); } catch { found = null; }
    }
    if (typeof found === 'string') found = { name: found };
    const name = found && found.name ? String(found.name).slice(0, 160) : (kind.fallback || titleFromSlug(value));
    const url = found && found.url ? String(found.url).slice(0, 500) : (kind.path && value != null ? kind.path.replace('{id}', encodeURIComponent(value)) : null);
    if (!name) return null;
    return { name, url: url || null };
}

/**
 * The plain words for a ledger reason.
 * @returns {{ key: string, text: string, subject: { name: string, url: string|null }|null, site: string, known: boolean }}
 */
function describe(key, options = {}) {
    const raw = key == null ? '' : String(key).trim();
    let kind = null;
    let value = null;
    for (const entry of KINDS) {
        if (typeof entry.match === 'string') {
            if (raw === entry.match) { kind = entry; break; }
            continue;
        }
        const m = raw.match(entry.match);
        if (m) { kind = entry; value = m[1] == null ? null : m[1].trim(); break; }
    }
    if (!kind) {
        return { key: raw, text: `for something on ${siteName(options.site || raw.split(':')[0])}`, subject: null,
            site: siteName(options.site || raw.split(':')[0]), known: false };
    }
    const subject = kind.subject ? subjectFrom(value, kind, options) : null;
    const text = kind.text.indexOf('{name}') < 0 ? kind.text
        : kind.text.replace('{name}', subject ? subject.name : (kind.fallback || 'something'));
    return { key: raw, text, subject, site: siteName(kind.site), known: true };
}

/** A row from a service that keeps the raw key: `{ reason, app_id }` or `{ reason }`. */
function describeRow(row, options = {}) {
    const reason = row && (row.reason != null ? row.reason : row.reason_key);
    return describe(reason, { ...options, site: options.site || (row && (row.app_id || row.site)) || undefined });
}

/** What an undeclared key reads, for a test and for a caller that wants only the words. */
function unknownText(site) {
    return `for something on ${siteName(site)}`;
}

module.exports = { KINDS, SITES, describe, describeRow, unknownText, siteName, titleFromSlug };
