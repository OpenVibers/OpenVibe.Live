'use strict';
/**
 * Where a sign-in may send the person back to (the `next` of /api/auth/login): a same-site path, or an
 * https URL on a zone OpenVibe owns (the list OpenVibe.Network keeps in server/auth/sso-owned.js).
 *
 * Never openvibe.<any tld>, which anyone can register, and never a Host tenant site (<site>.openvibe.host,
 * people's own pages). Browsers drop tab and newline characters from a URL and read a backslash as "/",
 * so "/<TAB>/evil.com" and "/\evil.com" are "//evil.com" to them: any control character or backslash
 * goes home. Until 2026-09-26 both got through (WS-R task 5).
 */
const OWNED_ZONES = [
    'openvibe.network', 'openvibe.live', 'openvibe.tools', 'openvibe.media', 'openvibe.games', 'openvibe.community',
    'openvibe.chat', 'openvibe.codes', 'openvibe.blog', 'openvibe.wiki', 'openvibe.news', 'openvibe.reviews',
    'openvibe.tips', 'openvibe.vip', 'openvibe.trade', 'openvibe.host', 'openvibe.deals', 'openvibe.coupons',
    'openre.stream',
];
const USER_CONTENT_ZONES = ['openvibe.host'];

function ownedHost(hostname) {
    const h = String(hostname || '').toLowerCase();
    return OWNED_ZONES.some((z) => h === z || (h.endsWith(`.${z}`) && !USER_CONTENT_ZONES.includes(z)));
}

function safeNext(raw) {
    const s = String(raw || '');
    if (!s) return '/';
    if (/[\\\u0000-\u001f\u007f]/.test(s)) return '/';
    if (s.startsWith('/') && !s.startsWith('//')) return s;
    try {
        const u = new URL(s);
        if (u.username || u.password) return '/';
        const local = /^(localhost|127\.0\.0\.1)$/.test(u.hostname);
        if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return '/';
        if (ownedHost(u.hostname) || local) return u.toString();
    } catch { /* not a URL */ }
    return '/';
}

module.exports = { safeNext, ownedHost, OWNED_ZONES };
