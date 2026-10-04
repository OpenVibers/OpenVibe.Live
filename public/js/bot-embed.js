/*
   OpenVibe.Live — a channel's OpenVibe.Bot robot panel (roadmap T15 R9). The channel JSON carries
   `bot_embed: { enabled, robot_id, url }` only with LIVE_BOT_EMBED on (server/bot/embed.js); app-channel.js
   loads this file (feature "botEmbed") only when that url is set, so with the flag off nothing here runs.

     iframeAttrs(botEmbed)       → the iframe's attributes, or null unless url is https (or http://localhost)
                                   and ends in /embed
     mount(container, botEmbed)  → puts one iframe in container and unhides its section; removes it and hides
                                   the section when there is nothing to show. Same url twice keeps the frame
                                   (an operator's session survives a channel refresh).

   Plain script for the browser (window.BotEmbed) and require() for the tests.
*/
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.BotEmbed = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const SANDBOX = 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms';

    function embedSrc(botEmbed) {
        if (!botEmbed || typeof botEmbed.url !== 'string' || !botEmbed.url) return null;
        let u;
        try { u = new URL(botEmbed.url); } catch { return null; }
        if (u.username || u.password) return null;
        const local = u.hostname === 'localhost' || u.hostname.endsWith('.localhost');
        if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
        if (!/\/embed$/.test(u.pathname)) return null;
        return u.href;
    }

    function iframeAttrs(botEmbed) {
        const src = embedSrc(botEmbed);
        if (!src) return null;
        return {
            src,
            title: 'Robot control panel',
            loading: 'lazy',
            referrerpolicy: 'strict-origin-when-cross-origin',
            allow: 'gamepad',
            sandbox: SANDBOX,
        };
    }

    function sectionOf(container) {
        return (container.closest && container.closest('section')) || container.parentNode || null;
    }

    function mount(container, botEmbed) {
        if (!container) return null;
        const section = sectionOf(container);
        const attrs = iframeAttrs(botEmbed);
        if (!attrs) {
            container.replaceChildren();
            if (section) section.hidden = true;
            return null;
        }
        const current = container.firstChild;
        if (current && current.tagName === 'IFRAME' && current.getAttribute('src') === attrs.src) {
            if (section) section.hidden = false;
            return current;
        }
        const frame = container.ownerDocument.createElement('iframe');
        for (const [k, v] of Object.entries(attrs)) frame.setAttribute(k, v);
        container.replaceChildren(frame);
        if (section) section.hidden = false;
        return frame;
    }

    return { iframeAttrs, mount };
});
