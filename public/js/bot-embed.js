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

   It also hands the panel the page's look and follows its height: ov-bot-theme { tokens } from this page's computed
   style on the frame's load and on ov:theme/ov:display (openvibe-shared/theme-loader.js); ov-bot-size { height } from
   the panel sets the frame between 160 and 720 px and stops the hand resize.

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

    // The panel takes the page's colours (OpenVibe.Bot public/embed-frame.js): these tokens, read from the page's
    // computed style. Plain colours only on the Bot side; --color-scheme is 'dark' or 'light'.
    const THEME_TOKENS = ['--bg-primary', '--bg-card', '--text-primary', '--text-secondary', '--accent', '--accent-strong', '--on-accent-strong', '--border'];
    const MIN_HEIGHT = 160;
    const MAX_HEIGHT = 720;

    function pageTheme(win) {
        try {
            const doc = win.document;
            const cs = win.getComputedStyle ? win.getComputedStyle(doc.documentElement) : null;
            if (!cs) return null;
            const tokens = {};
            for (const name of THEME_TOKENS) {
                const value = String(cs.getPropertyValue(name) || '').trim();
                if (value) tokens[name] = value;
            }
            let scheme = String(cs.getPropertyValue('--color-scheme') || '').trim();
            const root = doc.documentElement;
            if (scheme !== 'dark' && scheme !== 'light' && root && typeof root.getAttribute === 'function') scheme = root.getAttribute('data-theme-mode');
            if (scheme !== 'dark' && scheme !== 'light') {
                scheme = win.matchMedia && win.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
            }
            tokens['--color-scheme'] = scheme;
            return tokens;
        } catch { return null; }
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
        // The panel's height: it measures its content (a ResizeObserver on its end, at most 5×/s) and the page sets
        // the frame to it between MIN_HEIGHT and MAX_HEIGHT. Once it has spoken the card is no longer hand-resizable.
        const setHeight = (value) => {
            const height = Number(value);
            if (!Number.isFinite(height) || height <= 0) return;
            const clamped = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(height)));
            try {
                frame.style.height = `${clamped}px`;
                frame.style.resize = 'none';
            } catch { /* a fake frame in the tests */ }
        };
        // The page's theme, now (a kept frame) and again when the shared loader repaints one: ov:theme on first apply
        // and every change, ov:display when comfort/OLED settings change the tokens under it. Bot's loader has no
        // openvibe-theme-changed; ov:theme is its real event (openvibe-shared/theme-loader.js).
        const sendTheme = () => {
            const tokens = pageTheme(win);
            if (!tokens) return;
            try { if (frame.contentWindow) frame.contentWindow.postMessage({ type: 'ov-bot-theme', robot_id: robotId, tokens }, origin); } catch { /* the frame went away */ }
        };
        const onTheme = () => sendTheme();
        const onLoad = () => sendTheme();
        sendTheme();
        if (typeof frame.addEventListener === 'function') frame.addEventListener('load', onLoad);
        if (typeof win.addEventListener === 'function') {
            win.addEventListener('ov:theme', onTheme);
            win.addEventListener('ov:display', onTheme);
        }

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
            // The panel's size is about this frame, not about driving: accept it with or without the id, but never
            // for another robot.
            if (d.type === 'ov-bot-size') { if (d.robot_id == null || d.robot_id === robotId) setHeight(d.height); return; }
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
        return () => {
            deactivate();
            win.removeEventListener('message', onMessage);
            if (typeof frame.removeEventListener === 'function') frame.removeEventListener('load', onLoad);
            if (typeof win.removeEventListener === 'function') {
                win.removeEventListener('ov:theme', onTheme);
                win.removeEventListener('ov:display', onTheme);
            }
        };
    }

    return { iframeAttrs, mount, listen, THEME_TOKENS, MIN_HEIGHT, MAX_HEIGHT };
});
