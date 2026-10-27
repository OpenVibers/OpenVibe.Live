/*
   OpenVibe.Live — a channel's OpenVibe.Bot robot panel (roadmap T15 R9). The channel JSON carries
   `bot_embed: { enabled, robot_id, url }` only with LIVE_BOT_EMBED on (server/bot/embed.js); app-channel.js
   loads this file (feature "botEmbed") only when that url is set, so with the flag off nothing here runs.

     iframeAttrs(botEmbed)       → the iframe's attributes, or null unless url is https (or http://localhost)
                                   and ends in /embed
     mount(container, botEmbed)  → puts one iframe in container and unhides its section; removes it and hides
                                   the section when there is nothing to show. Same url twice keeps the frame
                                   (an operator's session survives a channel refresh).
     listen({ frame, botEmbed, requestTicket, onRefused })  → stop(): answers the framed panel (OpenVibe.Bot
                                   public/panel.js and refused.js), only from that frame and Bot's origin, for
                                   this robot only:
                                     ov-bot-ticket-request → await requestTicket() ({ ticket } or { message }) →
                                       ov-bot-ticket { ticket } or ov-bot-ticket-none { message }: Drive without a
                                       popup or a second sign-in on openvibe.bot
                                     ov-bot-embed-refused  → onRefused(): the owner has not turned the panel on

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

    function listen({ frame, botEmbed, requestTicket, onRefused = () => {}, win = typeof window !== 'undefined' ? window : null }) {
        const src = embedSrc(botEmbed);
        if (!frame || !src || !win || typeof requestTicket !== 'function') return () => {};
        const origin = new URL(src).origin;
        const robotId = botEmbed.robot_id;
        let asking = false;
        const reply = (msg) => {
            try { if (frame.contentWindow) frame.contentWindow.postMessage(Object.assign({ robot_id: robotId }, msg), origin); } catch { /* the frame went away */ }
        };
        const onMessage = async (e) => {
            if (e.origin !== origin || !frame.contentWindow || e.source !== frame.contentWindow) return;
            const d = e.data || {};
            if (!d || d.robot_id !== robotId) return;
            if (d.type === 'ov-bot-embed-refused') { onRefused(); return; }
            if (d.type !== 'ov-bot-ticket-request' || asking) return;
            asking = true;
            try {
                const out = await requestTicket();
                if (out && typeof out.ticket === 'string') reply({ type: 'ov-bot-ticket', ticket: out.ticket });
                else reply({ type: 'ov-bot-ticket-none', message: String((out && out.message) || 'You cannot drive this robot from here.').slice(0, 200) });
            } catch (err) {
                reply({ type: 'ov-bot-ticket-none', message: String((err && err.message) || 'You cannot drive this robot from here.').slice(0, 200) });
            } finally { asking = false; }
        };
        win.addEventListener('message', onMessage);
        return () => win.removeEventListener('message', onMessage);
    }

    return { iframeAttrs, mount, listen };
});
