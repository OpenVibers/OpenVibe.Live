/**
 * openvibe-shared/sso-client.js — the pieces that make one sign-in feel like one sign-in
 * across separate domains. Loaded lazily by navbar.js; Live loads it directly.
 *
 *   OpenVibeSSO.handoffLinks({ signedIn })   cross-site links carry the session along
 *   OpenVibeSSO.fedcm({ apiBase, fedcmLogin, mediation })   browser-native sign-in (Chrome/Edge)
 *   OpenVibeSSO.loginUrlFor(href)            the silent-login URL that lands on `href`
 *
 * Link hand-off: when this page has a session and a link points at another OpenVibe site, the
 * navigation goes through that site's silent sign-in (`…/auth/login?silent=1&next=<link>`).
 * It is a top-level navigation, so it works in every browser with no third-party cookies, and
 * the target answers straight from its own session when it already has one. Sites that share a
 * cookie domain (openvibe.tools and its subdomains) are one site here. Links can opt out with
 * data-ov-nohandoff.
 *
 * FedCM: `navigator.credentials.get({ identity })` — the browser itself asks openvibe.network
 * for an assertion (a native chip the first time per site, silent auto re-auth after that) and
 * the page posts it to the site's /auth/fedcm, which exchanges it server-side for a session.
 * Never called for browsers the network has told "logged-out", so guests see nothing.
 */
(function (root) {
    'use strict';
    if (root.OpenVibeSSO) return;

    const NETWORK = 'https://openvibe.network';
    // Site → where its silent sign-in lives. Hosts sharing a session cookie share an entry.
    const SITES = [
        { test: (h) => h === 'openvibe.live' || h.endsWith('.openvibe.live'), key: 'live', login: 'https://openvibe.live/api/auth/sso/login?silent=1&next={url}', fedcm: 'https://openvibe.live/api/auth/fedcm' },
        { test: (h) => h === 'openvibe.tools' || h.endsWith('.openvibe.tools'), key: 'tools', login: 'https://openvibe.tools/auth/login?silent=1&next={url}', fedcm: 'https://openvibe.tools/auth/fedcm' },
        { test: (h) => h === 'openvibe.games' || h.endsWith('.openvibe.games'), key: 'games', login: 'https://openvibe.games/auth/login?silent=1&next={url}', fedcm: '/auth/fedcm' },
        { test: (h) => h === 'openvibe.community' || h.endsWith('.openvibe.community'), key: 'community', login: 'https://openvibe.community/auth/login?silent=1&next={url}', fedcm: '/auth/fedcm' },
    ];
    const siteFor = (host) => SITES.find(s => s.test(String(host || '').toLowerCase())) || null;
    const here = () => (typeof location !== 'undefined' ? siteFor(location.hostname) : null);

    /** The URL that signs the browser in on the link's site and lands on the link, or null. */
    function loginUrlFor(href) {
        let u; try { u = new URL(href, location.href); } catch { return null; }
        if (u.protocol !== 'https:') return null;
        const target = siteFor(u.hostname);
        if (!target) return null;
        const mine = here();
        if (mine && mine.key === target.key) return null;         // same session cookie already
        return target.login.replace('{url}', encodeURIComponent(u.toString()));
    }

    let _handoffOn = false, _signedIn = false;
    function rewrite(a) {
        if (!a || a.dataset.ovHandoff || a.hasAttribute('data-ov-nohandoff') || !a.getAttribute('href')) return;
        const url = loginUrlFor(a.href);
        if (!url) return;
        a.dataset.ovHandoff = a.href;
        a.href = url;
    }
    function onIntent(e) {
        if (!_signedIn) return;
        const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        if (a) rewrite(a);
    }
    /** Turn cross-site links into session hand-offs while signed in (idempotent; call again to update). */
    function handoffLinks(opts) {
        _signedIn = !!(opts && opts.signedIn);
        if (_handoffOn) return;
        _handoffOn = true;
        // Rewrite just before the navigation can start: pointer/keyboard intent, and touch.
        for (const ev of ['pointerdown', 'touchstart', 'focusin', 'auxclick']) document.addEventListener(ev, onIntent, { capture: true, passive: true });
        document.addEventListener('click', onIntent, true);
        document.addEventListener('contextmenu', (e) => {
            // A copied link should stay a plain link.
            const a = e.target && e.target.closest ? e.target.closest('a[data-ov-handoff]') : null;
            if (a) { a.href = a.dataset.ovHandoff; delete a.dataset.ovHandoff; }
        }, true);
    }

    /** FedCM availability: the API exists and this is a top-level, secure document. */
    function fedcmAvailable() {
        try { return typeof navigator !== 'undefined' && 'IdentityCredential' in root && root.isSecureContext && root.top === root; } catch { return false; }
    }

    /**
     * Ask the browser for a FedCM assertion from openvibe.network and turn it into a session here.
     * Resolves { ok, user } or { ok: false, reason }. mediation 'silent' = only auto re-auth
     * (previously approved on this site), 'optional' = show the chip the first time.
     */
    async function fedcm(opts) {
        const o = Object.assign({ apiBase: NETWORK, mediation: 'optional', timeoutMs: 15000 }, opts || {});
        if (!fedcmAvailable()) return { ok: false, reason: 'unsupported' };
        const site = here();
        const fedcmLogin = o.fedcmLogin || (site && site.fedcm) || '/auth/fedcm';
        const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
        const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), o.timeoutMs);
        let cred;
        try {
            cred = await navigator.credentials.get({
                identity: { context: 'signin', providers: [{ configURL: `${o.apiBase}/fedcm/config.json`, clientId: location.origin, nonce, params: { nonce } }] },
                mediation: o.mediation, signal: ctrl.signal,
            });
        } catch (err) {
            clearTimeout(timer);
            return { ok: false, reason: (err && (err.name || err.message)) || 'declined' };
        }
        clearTimeout(timer);
        if (!cred || !cred.token) return { ok: false, reason: 'no-token' };
        try {
            const res = await fetch(fedcmLogin, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: cred.token, nonce }) });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) return { ok: false, reason: data.error || `http-${res.status}`, auto: !!cred.isAutoSelected };
            try { sessionStorage.setItem('ov_sso_hint', 'account'); localStorage.setItem('ov_sso_hint', 'account'); } catch { /* */ }
            return { ok: true, user: data.user || null, auto: !!cred.isAutoSelected };
        } catch (err) { return { ok: false, reason: 'network' }; }
    }

    /** After an explicit sign-out: the browser must not auto re-auth us back in. */
    function preventSilent() { try { if (navigator.credentials && navigator.credentials.preventSilentAccess) navigator.credentials.preventSilentAccess(); } catch { /* */ } }

    root.OpenVibeSSO = { handoffLinks, loginUrlFor, fedcm, fedcmAvailable, preventSilent, siteFor, SITES };
})(typeof window !== 'undefined' ? window : globalThis);
