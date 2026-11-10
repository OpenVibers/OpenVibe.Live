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

    const PANEL_MODES = ['panel', 'overlay', 'compact'];
    const VIEW_MODES = ['overlay', 'panel', 'hidden'];
    const CHOICE_KEY = 'ov:live:bot-controls';

    function embedSrc(botEmbed, mode = null) {
        if (!botEmbed || typeof botEmbed.url !== 'string' || !botEmbed.url) return null;
        let u;
        try { u = new URL(botEmbed.url); } catch { return null; }
        if (u.username || u.password) return null;
        const local = u.hostname === 'localhost' || u.hostname.endsWith('.localhost');
        if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
        if (!/\/embed$/.test(u.pathname)) return null;
        if (mode != null) {
            if (!PANEL_MODES.includes(mode)) return null;
            u.searchParams.set('mode', mode);
        }
        return u.href;
    }

    function iframeAttrs(botEmbed, { mode = null } = {}) {
        const src = embedSrc(botEmbed, mode);
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

    function mount(container, botEmbed, { mode = null, toggleSection = true } = {}) {
        if (!container) return null;
        const section = toggleSection ? sectionOf(container) : null;
        const attrs = iframeAttrs(botEmbed, { mode });
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

    // ── The viewer's choice, per channel and robot ────────────────────────────────────────────────────
    // No account is needed: localStorage only. A stored valid choice beats the streamer's default; without one
    // the channel's `bot_embed.controls_mode` decides, and 'panel' is the old behaviour.
    function choiceKey(channel, robotId) {
        return `${CHOICE_KEY}:${String(channel || '')}:${String(robotId || '')}`;
    }
    function validView(mode) { return VIEW_MODES.includes(mode) ? mode : null; }
    function defaultMode(botEmbed) { return botEmbed && botEmbed.controls_mode === 'overlay' ? 'overlay' : 'panel'; }
    function effectiveMode(botEmbed, stored) {
        return validView(stored) || defaultMode(botEmbed);
    }
    function readChoice(win, channel, robotId) {
        try {
            const s = win && win.localStorage;
            return s ? validView(s.getItem(choiceKey(channel, robotId))) : null;
        } catch { return null; }
    }
    function writeChoice(win, channel, robotId, mode) {
        if (!validView(mode)) return false;
        try {
            const s = win && win.localStorage;
            if (!s) return false;
            s.setItem(choiceKey(channel, robotId), mode);
            return true;
        } catch { return false; }
    }

    /** The control rectangles from ov-bot-size.hit → a clip-path path, or null when there is nothing usable. */
    function clipPathFor(hit) {
        if (!Array.isArray(hit)) return null;
        const rects = hit.filter((r) => r && [r.x, r.y, r.w, r.h].every((n) => Number.isFinite(Number(n))) && Number(r.w) > 0 && Number(r.h) > 0)
            .slice(0, 12)
            .map((r) => ({ x: Math.max(0, Number(r.x)), y: Math.max(0, Number(r.y)), w: Number(r.w), h: Number(r.h) }));
        if (!rects.length) return null;
        const path = rects.map((r) => `M${Math.round(r.x)} ${Math.round(r.y)} H${Math.round(r.x + r.w)} V${Math.round(r.y + r.h)} H${Math.round(r.x)} Z`).join(' ');
        return `path("${path}")`;
    }
    function applyClip(frame, message) {
        try {
            if (!frame || !frame.style) return;
            const path = message && message.mode === 'overlay' ? clipPathFor(message.hit) : null;
            frame.style.clipPath = path || '';
        } catch { /* a fake frame in the tests */ }
    }

    /** Ask the frame to switch view; it reloads itself in that view (its controls come from the robot's profile). */
    function setMode(frame, botEmbed, mode) {
        const src = embedSrc(botEmbed, mode);
        if (!frame || !src || !frame.contentWindow) return false;
        try {
            frame.contentWindow.postMessage({ type: 'ov-bot-mode', robot_id: botEmbed.robot_id, mode }, new URL(src).origin);
            return true;
        } catch { return false; }
    }

    /** Tell the frame the pointer is moving on the page (the overlay wakes from its idle fade). */
    function notifyActivity(frame, botEmbed) {
        const src = embedSrc(botEmbed);
        if (!frame || !src || !frame.contentWindow) return false;
        try {
            frame.contentWindow.postMessage({ type: 'ov-bot-activity', robot_id: botEmbed.robot_id }, new URL(src).origin);
            return true;
        } catch { return false; }
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

    function listen({ frame, botEmbed, requestTicket, onRefused = () => {}, onOpenPanel = () => {}, onFocusPlayer = () => {}, onSize = null, win = typeof window !== 'undefined' ? window : null }) {
        const src = embedSrc(botEmbed);
        if (!frame || !src || !win || typeof requestTicket !== 'function') return () => {};
        const origin = new URL(src).origin;
        const robotId = botEmbed.robot_id;
        let asking = false;
        const reply = (msg) => {
            try { if (frame.contentWindow) frame.contentWindow.postMessage(Object.assign({ robot_id: robotId }, msg), origin); } catch { /* the frame went away */ }
        };
        // The panel's height: it measures its content (a ResizeObserver on its end, at most 5×/s) and the page sets
        // the card around the frame to it, between MIN_HEIGHT and MAX_HEIGHT. Once it has spoken the card is no
        // longer hand-resizable (#ch-bot-container's resize handle in public/css/features/channel.css).
        const setHeight = (value) => {
            const height = Number(value);
            if (!Number.isFinite(height) || height <= 0) return;
            const clamped = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(height)));
            try {
                const card = typeof frame.closest === 'function' ? frame.closest('#ch-bot-container') : null;
                const host = card || frame;
                host.style.height = `${clamped}px`;
                host.style.resize = 'none';
                if (card) frame.style.height = '100%';   // the card grows; the frame fills it (channel.css)
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
            if (d.type === 'ov-bot-size') {
                if (d.robot_id == null || d.robot_id === robotId) {
                    // An overlay fills the player; its clip keeps the presses outside the controls going through.
                    if (d.mode === 'overlay') applyClip(frame, d);
                    else { applyClip(frame, null); setHeight(d.height); }
                    if (typeof onSize === 'function') onSize(d);
                }
                return;
            }
            if (!d || d.robot_id !== robotId) return;
            if (d.type === 'ov-bot-open-panel') { onOpenPanel(); return; }
            if (d.type === 'ov-bot-blur-controls') { onFocusPlayer(); return; }
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

    return { iframeAttrs, mount, listen, embedSrc, choiceKey, validView, defaultMode, effectiveMode, readChoice, writeChoice, clipPathFor, applyClip, setMode, notifyActivity, VIEW_MODES, PANEL_MODES, THEME_TOKENS, MIN_HEIGHT, MAX_HEIGHT };
});
