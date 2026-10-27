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
                                     ov-bot-controls       → while the panel drives ({ active, keys, pad }), the keys
                                       it named and this page's gamepad go to it (ov-bot-key, ov-bot-pad) when the
                                       person is on the page and not in the frame: WASD and a controller drive from
                                       the stream page. Never a key typed into chat or a field, never with Ctrl/Alt/⌘.

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

        // The page's keyboard and gamepad while the panel drives (Maticus, 2026-10-27: "WASD keyboard AND game controller"
        // on the stream page). The panel says which keys its controls take; only those are sent and kept from the
        // page's own shortcuts (the player's arrows and Space), and only until it says it stopped.
        let controls = null;          // { keys, lower, pad } while the panel drives
        const held = new Set();       // codes sent down and not yet up
        let padLoop = 0, padLast = 0, padAt = 0, padSent = '';
        const typing = (t) => !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '') || t.isContentEditable === true);
        const wanted = (e) => controls.keys.has(e.code) || (typeof e.key === 'string' && controls.lower.has(e.key.toLowerCase()));
        const onKeyDown = (e) => {
            if (!controls || typing(e.target) || e.ctrlKey || e.metaKey || e.altKey || !wanted(e)) return;
            e.preventDefault(); e.stopPropagation();
            held.add(e.code);
            reply({ type: 'ov-bot-key', code: e.code, key: e.key, down: true, repeat: e.repeat === true });
        };
        const onKeyUp = (e) => {
            if (!held.has(e.code)) return;
            held.delete(e.code);
            e.preventDefault(); e.stopPropagation();
            reply({ type: 'ov-bot-key', code: e.code, key: e.key, down: false });
        };
        const releaseKeys = () => { for (const code of held) reply({ type: 'ov-bot-key', code, key: '', down: false }); held.clear(); };
        const onHidden = () => { if (win.document && win.document.hidden) releaseKeys(); };
        const connected = () => [...((win.navigator && win.navigator.getGamepads && win.navigator.getGamepads()) || [])].filter((g) => g && g.connected);
        // About 30 states a second while they change, one every 200 ms while they do not (the panel lets go after 500 ms
        // without one), and none while this window is not the one in front.
        const padTick = () => {
            padLoop = 0;
            if (!controls || !controls.pad) return;
            const g = connected()[0];
            if (!g) return;                       // gamepadconnected starts it again
            const now = Date.now();
            if (now - padLast >= 33 && (!win.document || win.document.hasFocus())) {
                padLast = now;
                const state = { axes: [...g.axes].slice(0, 8).map((v) => Math.round(Number(v) * 1000) / 1000 || 0), buttons: [...g.buttons].slice(0, 20).map((b) => !!(b && b.pressed)) };
                const text = JSON.stringify(state);
                if (text !== padSent || now - padAt >= 200) { reply(Object.assign({ type: 'ov-bot-pad' }, state)); padSent = text; padAt = now; }
            }
            padLoop = win.requestAnimationFrame(padTick);
        };
        const padStart = () => { if (!padLoop && controls && controls.pad && typeof win.requestAnimationFrame === 'function') padLoop = win.requestAnimationFrame(padTick); };
        const deactivate = () => {
            if (!controls) return;
            releaseKeys();
            controls = null;
            win.removeEventListener('keydown', onKeyDown, true);
            win.removeEventListener('keyup', onKeyUp, true);
            win.removeEventListener('blur', releaseKeys);
            win.removeEventListener('gamepadconnected', padStart);
            if (win.document && win.document.removeEventListener) win.document.removeEventListener('visibilitychange', onHidden);
            if (padLoop && typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(padLoop);
            padLoop = 0; padSent = '';
        };
        const setControls = (d) => {
            const keys = (Array.isArray(d.keys) ? d.keys : []).filter((k) => typeof k === 'string' && k && k.length <= 40).slice(0, 64);
            if (d.active !== true || !keys.length) return deactivate();
            const fresh = !controls;
            controls = { keys: new Set(keys), lower: new Set(keys.map((k) => k.toLowerCase())), pad: d.pad === true };
            for (const code of [...held]) if (!controls.keys.has(code)) { held.delete(code); reply({ type: 'ov-bot-key', code, key: '', down: false }); }
            if (fresh) {
                win.addEventListener('keydown', onKeyDown, true);
                win.addEventListener('keyup', onKeyUp, true);
                win.addEventListener('blur', releaseKeys);
                win.addEventListener('gamepadconnected', padStart);
                if (win.document && win.document.addEventListener) win.document.addEventListener('visibilitychange', onHidden);
            }
            padStart();
        };
        const onMessage = async (e) => {
            if (e.origin !== origin || !frame.contentWindow || e.source !== frame.contentWindow) return;
            const d = e.data || {};
            if (!d || d.robot_id !== robotId) return;
            if (d.type === 'ov-bot-embed-refused') { onRefused(); return; }
            if (d.type === 'ov-bot-controls') { setControls(d); return; }
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
        return () => { deactivate(); win.removeEventListener('message', onMessage); };
    }

    return { iframeAttrs, mount, listen };
});
