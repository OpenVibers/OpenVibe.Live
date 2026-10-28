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

    // The bar's places, most used first (the owner, 2026-10-28: "move search after the Rundown and the drop-down… reanalyze
    // the nav bars… redundant options"). Search is the navbar's magnifier now (Shared 4.21: Live's results first, then all
    // of OpenVibe; config.search below); Admin is in the account menu (Admin Panel) and was here twice for staff.
    function links(user) {
        return [
            { id: 'home', page: 'home', label: 'Home', href: '/', icon: 'fa-house' },
            // VODs, clips and pastes people made are one feed; what the AI made is the other.
            { id: 'content', page: 'content', label: 'Content', href: '/content', icon: 'fa-photo-film' },
            { id: 'moments', page: 'moments', label: 'Moments', href: '/moments', icon: 'fa-wand-magic-sparkles' },
            { id: 'chat', page: 'chat', label: 'Chat', href: '/chat', icon: 'fa-comments' },
            { id: 'rundown', page: 'rundown', label: 'Rundown', href: '/rundown', icon: 'fa-newspaper' },
            { id: 'broadcast', page: 'broadcast', elId: 'nav-broadcast', label: 'Go Live', href: '/broadcast', icon: 'fa-tower-broadcast', dot: false, dotId: 'nav-live-dot',
                onClick: (e) => call('goLiveNav', e),
                children: user ? [{ id: 'dashboard', label: 'Dashboard', href: '/dashboard', icon: 'fa-gauge-high', onClick: (e) => call('dashNav', e) }] : [] },
        ];
    }

    // Phones: the bottom tab bar (Shared 4.20's appBar). Home, what people made, going live in the middle, chat, and the
    // Rundown; everything else is in More (the drawer).
    function appBar() {
        return [
            { id: 'home', page: 'home', label: 'Home', href: '/', icon: 'fa-house' },
            { id: 'content', page: 'content', label: 'Videos', href: '/content', icon: 'fa-photo-film' },
            { id: 'broadcast', page: 'broadcast', label: 'Go Live', href: '/broadcast', icon: 'fa-tower-broadcast', onClick: (e) => call('goLiveNav', e) },
            { id: 'chat', page: 'chat', label: 'Chat', href: '/chat', icon: 'fa-comments' },
            { id: 'rundown', page: 'rundown', label: 'Rundown', href: '/rundown', icon: 'fa-newspaper' },
        ];
    }

    // The account menu (the owner, 2026-10-28: "duplicated things … could just be organized better"): Live's own rows in
    // one section, then the network's (You: account, notifications, channel, history, Vibe, admin; Display), as on every
    // OpenVibe site. Nothing here repeats the bar: the balances are its chips (whose clicks open the inventory and the
    // Vibes shop), Dashboard is also under Go Live, and other accounts and "Add another account" sit at the menu's top.
    function menu(user) {
        const act = (fn, ...a) => (e) => { if (e && e.preventDefault) e.preventDefault(); call(fn, ...a); return false; };
        return {
            label: 'Live',
            sections: [
                { id: 'live', label: 'Live', items: [
                    { id: 'dash', label: 'Dashboard', icon: 'fa-gauge-high', href: '/dashboard' },
                    { id: 'setup', label: 'Streamer setup', icon: 'fa-list-check', onClick: act('openSetupHub') },
                    { id: 'cosmetics', label: 'Cosmetics', icon: 'fa-shirt', onClick: act('openCosmeticsModal') },
                    { id: 'shot', label: 'Screenshot this page', icon: 'fa-camera', onClick: act('captureScreenshot') },
                    { id: 'docs', label: 'Help & docs', icon: 'fa-book', href: '/documentation' },
                    { id: 'guest', label: 'Browse as guest', icon: 'fa-user-secret', onClick: act('browseAsGuest'), hidden: !user },
                ] },
            ],
        };
    }

    function config(user) {
        return {
            service: 'live', mount: '#navbar-mount', className: 'navbar', auth: 'external', apiBase: 'https://openvibe.network',
            user: user || null, token: (function () { try { return localStorage.getItem('token'); } catch (e) { return null; } })(),
            // The menu's other accounts and "Add another account" go through the Network's chooser and come back through
            // this sign-in (Shared 4.13.0), which returns to the page they were on.
            loginUrl: '/api/auth/sso/login?next={path}', networkLinks: 0, history: false, silentLogin: false, fedcm: false, recent: false,
            notificationsRealtime: true,   // the bell hears new notifications over OpenVibe.Events (Shared 1.22.0)
            links: links(user), menu: menu(user), appBar: appBar(), adminLink: false,   // Admin Panel is in the account menu
            // The magnifier (Shared 4.21): Live's streams, recordings and clips first, Live's own search page, then OpenVibe.
            search: { owner: 'live', label: 'OpenVibe.Live', page: '/search' },
            chips: [
                // On a phone the two fold into one chip (Shared 4.16.0); its panel lists them by label.
                { id: 'coins', icon: 'fa-coins', tone: 'gold', value: '0', valueId: 'nav-coins-amount', label: 'OpenCoins', title: 'OpenCoins: click to open your inventory', onClick: () => call('openCosmeticsModal') },
                { id: 'vibes', icon: 'fa-wallet', tone: 'green', value: '0', valueId: 'nav-balance-amount', label: 'Vibes', title: 'Vibes balance', onClick: () => call('showModal', 'buy-funds') },
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
