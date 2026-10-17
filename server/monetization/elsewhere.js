'use strict';
/**
 * A channel's support on OpenVibe.VIP and OpenVibe.Tips, shown on Live's channel page (owner 2026-10-08: "openvibe.vip
 * and openvibe.tips … should be directly integrated to openvibe.live"):
 *
 *   memberships     the creator's VIP plans (one per tier, each with Billing's price) from VIP's public card
 *                   (GET /embed/:username/card.json): Live's own Subscribe sells tier 1, the rest are joined on VIP
 *   support_links   other ways to support the creator, paid outside OpenVibe, from Tips' public profile
 *                   (GET /api/v1/profiles/:handle): Tips builds every link from a known service and a handle
 *
 * Both are public reads on loopback, cached per channel for a minute (a miss or an error is cached too, briefly), and
 * never block the page: whatever does not answer within the timeout is left out.
 */
const TTL_MS = 60_000;
const MISS_TTL_MS = 15_000;
const TIMEOUT_MS = 1500;
const cache = new Map();   // username → { at, ttl, value }

const vipUrl = () => String(process.env.OV_VIP_INTERNAL_URL || 'http://127.0.0.1:4620').replace(/\/+$/, '');
const tipsUrl = () => String(process.env.TIPS_URL || 'http://127.0.0.1:4610').replace(/\/+$/, '');
const HANDLE_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const https = (u) => (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : null);

async function getJson(url, fetchImpl) {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
}

/** VIP's card → the plans a viewer can join (name, tier, price, link), or null. */
function memberships(card) {
    if (!card || !Array.isArray(card.plans)) return null;
    const plans = card.plans.filter((p) => p && p.purchasable && https(p.join_url)).map((p) => ({
        name: String(p.name || '').slice(0, 80), tier: Number(p.tier) || 1,
        price_cents: Number.isSafeInteger(p.price_cents) && p.price_cents > 0 ? p.price_cents : null, join_url: p.join_url,
    }));
    if (!plans.length) return null;
    return { url: https(card.join_url) || https(card.creator && card.creator.url), plans: plans.slice(0, 10) };
}

/** Tips' public profile → the creator's other ways to support (label and link), or null. */
function supportLinks(profile) {
    const list = profile && Array.isArray(profile.support_links) ? profile.support_links : [];
    const out = list.map((l) => ({ provider: String(l.provider || ''), label: String(l.label || '').slice(0, 40), url: https(l.url) })).filter((l) => l.url && l.label);
    return out.length ? out.slice(0, 8) : null;
}

async function forChannel(username, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
    const name = String(username || '');
    if (!HANDLE_RE.test(name)) return { memberships: null, support_links: null, tips_url: null };
    const key = name.toLowerCase();
    const hit = cache.get(key);
    if (hit && now - hit.at < hit.ttl) return hit.value;
    const [card, tips] = await Promise.all([
        getJson(`${vipUrl()}/embed/${encodeURIComponent(key)}/card.json`, fetchImpl).catch(() => null),
        getJson(`${tipsUrl()}/api/v1/profiles/${encodeURIComponent(key)}`, fetchImpl).catch(() => null),
    ]);
    const profile = tips && tips.profile ? tips.profile : null;
    const value = {
        memberships: memberships(card && card.card ? card.card : card),
        support_links: supportLinks(profile),
        tips_url: profile && profile.page_enabled && profile.accepting ? https(profile.url) : null,
    };
    const empty = !value.memberships && !value.support_links && !value.tips_url;
    cache.set(key, { at: now, ttl: empty ? MISS_TTL_MS : TTL_MS, value });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return value;
}

function _reset() { cache.clear(); }

module.exports = { forChannel, memberships, supportLinks, _reset };
