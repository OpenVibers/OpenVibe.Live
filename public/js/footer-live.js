/**
 * footer-live.js — OpenVibe.Live's configuration for the shared cross-site footer.
 *
 * The footer itself (markup, styling, Network column, Legal column, signed-in row) comes from
 * openvibe-shared/footer.js, which every OpenVibe property loads. This file supplies only the
 * links that belong to Live, and decides which variant a page should use.
 *
 * Variant policy: a streamer's channel, a player and the broadcast desk are places people are
 * *doing* something, so they get the one-line compact footer. Browse and landing pages, where
 * someone may be looking for where to go next, get the full one.
 */
(function () {
    'use strict';
    const COMPACT_PAGES = ['channel', 'vod-player', 'clip-player', 'broadcast', 'game', 'canvas', 'chat', 'arena', 'recap'];
    const LINKS = [
        {
            heading: 'Watch',
            items: [
                { name: 'Live streams', url: '/', onclick: "return handleLinkClick(event, '/')" },
                { name: 'VODs, clips & pastes', url: '/content', onclick: "return handleLinkClick(event, '/content')" },
                { name: 'AI Moments', url: '/moments', onclick: "return handleLinkClick(event, '/moments')" },
                { name: 'The Arena', url: '/arena', onclick: "return handleLinkClick(event, '/arena')" },
                { name: 'Global chat', url: '/chat', onclick: "return handleLinkClick(event, '/chat')" },
            ],
        },
        {
            heading: 'Create',
            items: [
                { name: 'Start streaming', url: '/broadcast', onclick: "return handleLinkClick(event, '/broadcast')" },
                { name: 'Set up restreams', url: '/broadcast?guide=golive:restream', onclick: "event.preventDefault(); if (typeof startRestreamGuide === 'function') startRestreamGuide(); return false;" },
                { name: 'Streamer dashboard', url: '/dashboard', onclick: "return handleLinkClick(event, '/dashboard')" },
                { name: 'Pastes', url: '/pastes', onclick: "return handleLinkClick(event, '/pastes')" },
                { name: 'API docs', url: '/documentation', onclick: "return handleLinkClick(event, '/documentation')" },
            ],
        },
    ];

    /** Which footer this page deserves — compact where the footer is not the point. */
    function variantForPage() {
        const p = location.pathname;
        if (p === '/' || p === '') return 'full';
        if (/^\/@/.test(p)) return 'compact';                       // streamer channels
        const seg = p.split('/').filter(Boolean)[0] || '';
        if (COMPACT_PAGES.includes(seg)) return 'compact';
        if (seg === 'vod' || seg === 'clip' || seg === 'recap') return 'compact';
        return 'full';
    }

    function apply() {
        if (!window.OpenVibeFooter) return;
        OpenVibeFooter.setVariant(variantForPage());
    }

    function boot() {
        if (!window.OpenVibeFooter) return setTimeout(boot, 120);
        OpenVibeFooter.init({
            service: 'live',
            brandName: 'OpenVibe.Live',
            tagline: 'Free, open-source live streaming. Go live from a browser, OBS or a robot, restream everywhere, and keep your chat, emotes and clips in one place.',
            legalBase: location.origin,
            variant: variantForPage(),
            links: LINKS,
        });
        // SPA route changes swap the variant without a reload.
        const push = history.pushState;
        history.pushState = function () { const r = push.apply(this, arguments); setTimeout(apply, 40); return r; };
        window.addEventListener('popstate', () => setTimeout(apply, 40));
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
