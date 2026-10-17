/**
 * The channel's support on OpenVibe.VIP and OpenVibe.Tips, in the Subscribe and Donate windows (vibes.js calls these
 * when they exist): a creator's higher membership tiers, and their other ways to support. Loaded with the channel
 * feature (features.json), not on every page, so the home page's script budget does not carry it.
 */
// Memberships (VIP tiers) and other ways to support (Tips), from /api/payments/channel/:username/elsewhere. Built as
// DOM nodes: the names and links come from other services.
const _elsewhereCache = new Map();
function _elsewhere(username) {
    const key = String(username || '').toLowerCase();
    if (!key) return Promise.resolve(null);
    if (!_elsewhereCache.has(key)) _elsewhereCache.set(key, api(`/payments/channel/${encodeURIComponent(key)}/elsewhere`).catch(() => null));
    return _elsewhereCache.get(key);
}
function _channelUsername() {
    if (typeof currentStreamData !== 'undefined' && currentStreamData && currentStreamData.username) return currentStreamData.username;
    const m = /^\/@([^/?#]+)/.exec(location.pathname);
    return m ? decodeURIComponent(m[1]) : null;
}
function _elsewhereBlock(title, items, note) {
    const wrap = document.createElement('div');
    wrap.className = 'elsewhere';
    const h = document.createElement('div');
    h.className = 'elsewhere-title';
    h.textContent = title;
    const ul = document.createElement('ul');
    ul.className = 'elsewhere-list';
    for (const it of items) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = it.url;
        a.target = '_blank';
        a.rel = it.rel || 'noopener';
        a.className = 'btn btn-outline';
        a.textContent = it.label;
        li.appendChild(a);
        ul.appendChild(li);
    }
    wrap.append(h, ul);
    if (note) { const p = document.createElement('div'); p.className = 'muted elsewhere-note'; p.textContent = note; wrap.appendChild(p); }
    return wrap;
}
// Live's Subscribe sells tier 1; a creator's higher tiers are joined on openvibe.vip with the same account.
async function _appendTiers(box, username) {
    const d = await _elsewhere(username);
    const plans = d && d.memberships ? d.memberships.plans.filter((p) => p.tier > 1) : [];
    if (!plans.length || !box || !box.isConnected) return;
    box.appendChild(_elsewhereBlock('More tiers on OpenVibe.VIP', plans.map((p) => ({
        url: p.join_url, label: p.price_cents ? `${p.name} · $${(p.price_cents / 100).toFixed(2)}/mo` : p.name,
    })), 'Each tier has its own perks. You join on openvibe.vip with this account; one tier at a time.'));
}
async function _appendSupport(box, username) {
    const d = await _elsewhere(username);
    if (!d || !box || !box.isConnected) return;
    const items = [];
    if (d.tips_url) items.push({ url: d.tips_url, label: 'OpenVibe.Tips: paid messages, TTS and sounds' });
    for (const l of d.support_links || []) items.push({ url: l.url, label: l.label, rel: 'nofollow noopener ugc' });
    if (!items.length) return;
    box.appendChild(_elsewhereBlock('Other ways to support', items, d.support_links ? 'Ko-fi, PayPal and the like are paid outside OpenVibe, not in Vibes.' : ''));
}

