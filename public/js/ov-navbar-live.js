/* OpenVibe.Live on the network's shared navbar (openvibe-shared/navbar.js from OpenVibe.Shared, served at /shared/navbar.js).
 *
 * Live used to carry its own navbar: 130 lines of markup, its own user menu, its own mobile drawer. It now
 * mounts the same component every other OpenVibe site uses and describes what is specific to Live as data:
 * its pages, the Go Live dropdown, the two balances, and the Live-only rows of the user menu.
 * Live signs people in itself, so the navbar runs with auth: 'external' and is told who is here (LiveNav.sync).
 *
 *   LiveNav.sync(user)            after sign-in, sign-out or a profile change
 *   LiveNav.setActive(page)       the router calls this on every page change
 *   LiveNav.setChip(id, text)     'coins' | 'vibes'
 *   LiveNav.setLive(isLive)       the red dot on "Go Live"
 */
(function () {
    'use strict';
    const call = (name, ...a) => (typeof window[name] === 'function' ? window[name](...a) : undefined);
    const nav = () => window.OpenVibeNavbar;
    let booted = false;

    function links(user) {
        const staff = !!(user && ((user.capabilities && user.capabilities.admin_panel) || (typeof hasCapability === 'function' && hasCapability('can_access_staff_console'))));
        return [
            { id: 'home', page: 'home', label: 'Home', href: '/', icon: 'fa-house' },
            // VODs, clips and pastes people made are one feed; what the AI made is the other.
            { id: 'content', page: 'content', label: 'Content', href: '/content', icon: 'fa-photo-film' },
            { id: 'moments', page: 'moments', label: 'Moments', href: '/moments', icon: 'fa-wand-magic-sparkles' },
            { id: 'search', page: 'search', label: 'Search', href: '/search', icon: 'fa-magnifying-glass' },
            { id: 'chat', page: 'chat', label: 'Chat', href: '/chat', icon: 'fa-comments' },
            { id: 'arena', page: 'arena', label: 'Arena', href: '/arena', icon: 'fa-hand-fist' },
            { id: 'game', page: 'game', label: 'Game', href: 'https://openvibe.games', icon: 'fa-gamepad' },
            { id: 'broadcast', page: 'broadcast', elId: 'nav-broadcast', label: 'Go Live', href: '/broadcast', icon: 'fa-tower-broadcast', dot: false, dotId: 'nav-live-dot',
                onClick: (e) => call('goLiveNav', e),
                children: user ? [{ id: 'dashboard', label: 'Dashboard', href: '/dashboard', icon: 'fa-gauge-high', onClick: (e) => call('dashNav', e) }] : [] },
            { id: 'admin', page: 'admin', label: 'Admin', href: 'https://openvibe.network/admin', icon: 'fa-shield-halved', hidden: !staff },
        ];
    }

    function menu(user) {
        const isAdmin = !!(user && (user.role === 'admin' || (user.capabilities && user.capabilities.is_owner)));
        const act = (fn, ...a) => (e) => { if (e && e.preventDefault) e.preventDefault(); call(fn, ...a); return false; };
        return {
            label: 'Live', defaults: false,
            headerChips: [
                { id: 'coins', icon: 'fa-coins', tone: 'gold', value: '0', title: 'OpenCoins', onClick: () => call('openCosmeticsModal') },
                { id: 'vibes', icon: 'fa-wallet', tone: 'green', value: '0', title: 'Vibes balance', onClick: () => call('showModal', 'buy-funds') },
            ],
            sections: [
                { id: 'you', label: 'You', items: [
                    { id: 'dash', label: 'My Dashboard', icon: 'fa-gauge-high', href: '/dashboard' },
                    { id: 'channel', label: 'My Channel', icon: 'fa-user', href: user ? (typeof channelPath === 'function' ? channelPath(user.username) : '/@' + user.username) : '#' },
                    { id: 'setup', label: 'Streamer setup', icon: 'fa-list-check', onClick: act('openSetupHub') },
                    { id: 'account', label: 'My Account', icon: 'fa-id-card', href: 'https://openvibe.network/my' },
                    { id: 'adminpanel', label: 'Admin Panel', icon: 'fa-shield-halved', href: 'https://openvibe.network/admin', hidden: !isAdmin },
                ] },
                { id: 'live', label: 'On Live', items: [
                    { id: 'support', label: 'Support Us', icon: 'fa-coins', onClick: act('showModal', 'buy-funds') },
                    { id: 'cosmetics', label: 'Cosmetics', icon: 'fa-shirt', onClick: act('openCosmeticsModal') },
                    { id: 'shot', label: 'Screenshot', icon: 'fa-camera', onClick: act('captureScreenshot') },
                    { id: 'docs', label: 'Documentation', icon: 'fa-book', href: '/documentation' },
                ] },
            ],
            after: [
                { id: 'history', label: 'History', icon: 'fa-clock-rotate-left', href: 'https://openvibe.network/my#history' },
                { id: 'switch', label: 'Switch account', icon: 'fa-people-arrows', onClick: act('switchAccount') },
                { id: 'guest', label: 'Browse as guest', icon: 'fa-user-secret', onClick: act('browseAsGuest') },
            ],
        };
    }

    function config(user) {
        return {
            service: 'live', mount: '#navbar-mount', className: 'navbar', auth: 'external', apiBase: 'https://openvibe.network',
            user: user || null, token: (function () { try { return localStorage.getItem('token'); } catch (e) { return null; } })(),
            loginUrl: '/api/auth/sso/login', accounts: false, networkLinks: 0, history: false, silentLogin: false, fedcm: false, recent: false,
            notificationsRealtime: true,   // the bell hears new notifications over OpenVibe.Events (Shared 1.22.0)
            links: links(user), menu: menu(user),
            chips: [
                { id: 'coins', icon: 'fa-coins', tone: 'gold', value: '0', valueId: 'nav-coins-amount', title: 'OpenCoins: click to open your inventory', onClick: () => call('openCosmeticsModal') },
                { id: 'vibes', icon: 'fa-wallet', tone: 'green', value: '0', valueId: 'nav-balance-amount', title: 'Vibes balance', onClick: () => call('showModal', 'buy-funds') },
            ],
            // Same-origin links are routes of this single-page app.
            onNavigate: (href, e) => (typeof handleLinkClick === 'function' ? handleLinkClick(e, href) : true),
            onLogout: () => call('logout'),
        };
    }

    let last = { coins: '0', vibes: '0', live: false, page: null };
    function sync(user) {
        const N = nav(); if (!N) return;
        booted = true; N.init(config(user));   // init() merges the new config and re-renders
        N.setChip('coins', last.coins); N.setChip('vibes', last.vibes);
        if (last.page) N.setActive(last.page);
        if (last.live) N.updateLink('broadcast', { dot: true });
    }

    window.LiveNav = {
        sync,
        setActive(page) { last.page = page; const N = nav(); if (N && booted) N.setActive(page); },
        setChip(id, text) { last[id] = String(text); const N = nav(); if (N && booted) N.setChip(id, String(text)); },
        setLive(isLive) { last.live = !!isLive; const N = nav(); if (N && booted) N.updateLink('broadcast', { dot: !!isLive, label: isLive ? 'LIVE' : 'Go Live' }); },
    };

    // First paint: the bar appears signed out immediately; app.js calls sync() again when it knows who is here.
    const start = () => sync(typeof currentUser !== 'undefined' ? currentUser : null);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
