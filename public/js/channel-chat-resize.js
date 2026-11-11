/*
   OpenVibe.Live — resize the channel page's chat with a mouse, a finger, a pen or the keyboard, in each layout it has:

     side     1181px and wider: the column beside the stream; the grip on its left edge sets the width
     overlay  1180px and narrower, landscape: the panel over the right side; the same grip sets its width
     sheet    1180px and narrower, portrait: the bottom sheet; the grip on its top edge sets the height, and
              letting go most of the way down closes the sheet

   A phone held upright while a stream is live (ask 353, 2026-11-11): the chat is docked under the player and starts
   all the way up to it; letting go most of the way down folds it to the round chat button. Between those it has one
   other height (ask 366: the channel line showed cut in half above a sheet of any height): the channel line's own,
   so the sheet is all the way up, just under the line, or folded. That height is saved as LINE (-1) and measured
   on the page each time, so it fits whatever the line holds on this phone.

   Double-click or double-tap a grip (or press Enter on it) for the default size; arrow keys move it 24px.
   Each layout remembers its own size (localStorage), applied as CSS variables on #page-channel, which
   public/css/features/channel.css reads: --chat-w, --chat-ow, --chat-sheet-h.
*/
(function () {
    'use strict';
    const WIDE = window.matchMedia('(min-width: 1181px)');
    const LAND = window.matchMedia('(orientation: landscape)');
    const PHONE = window.matchMedia('(max-width: 768px) and (orientation: portrait)');
    const page = () => document.getElementById('page-channel');
    // Docked: a phone upright, live, and not a portrait stream (that one keeps its chat over the picture).
    const docked = () => {
        const p = page();
        return PHONE.matches && !!p && p.classList.contains('ch-is-live') && !p.querySelector('.video-container.is-vertical');
    };
    // The docked chat's room: from the player's bottom (or the robot's row under it) to the column's end.
    function dockRoom() {
        const p = page();
        const layout = p && p.querySelector('.stream-layout');
        const v = p && p.querySelector('#video-container');
        if (!layout || !v) return window.innerHeight * 0.6;
        let top = v.getBoundingClientRect().bottom;
        const row = p.classList.contains('ch-bot-compact') ? p.querySelector('#ch-bot-section') : null;
        if (row) top += row.getBoundingClientRect().height;
        return Math.max(180, layout.getBoundingClientRect().bottom - top);
    }
    const LINE = -1;   // the docked sheet just under the channel line
    /** The docked sheet's height with the channel line shown whole above it. */
    function lineSize() {
        const p = page();
        const info = p && p.querySelector('.stream-main > .ch-info-bar');
        const h = info && info.offsetParent !== null ? info.scrollHeight : 0;
        return Math.max(180, Math.round(dockRoom() - (h || 150)));
    }
    const MODES = {
        side: { key: 'openvibe_chat_width', prop: '--chat-w', axis: 'x', min: 260, max: () => Math.min(window.innerWidth * 0.5, 760) },
        overlay: { key: 'openvibe_chat_overlay_w', prop: '--chat-ow', axis: 'x', min: 260, max: () => window.innerWidth * 0.7 },
        sheet: { key: 'openvibe_chat_sheet_h', prop: '--chat-sheet-h', axis: 'y', min: 180, max: () => (docked() ? dockRoom() : window.innerHeight * 0.92) },
    };
    const modeOf = () => (WIDE.matches ? 'side' : LAND.matches ? 'overlay' : 'sheet');
    const clamp = (v, a, b) => Math.round(Math.max(a, Math.min(b, v)));
    const read = (k) => { try { return parseInt(localStorage.getItem(k), 10) || 0; } catch { return 0; } };
    const write = (k, v) => { try { if (v) localStorage.setItem(k, String(Math.round(v))); else localStorage.removeItem(k); } catch { /* private mode */ } };

    function setSize(mode, v) {
        const p = page(); const m = MODES[mode];
        if (!p) return;
        // Docked, a height saved before (any number of pixels) is the line height now.
        if (mode === 'sheet' && v > 0 && docked()) v = LINE;
        if (mode === 'sheet' && v === LINE) {
            // Shown first, so the line can be measured; a sheet that is not docked has no line height: the default.
            if (!docked()) { p.style.removeProperty(m.prop); p.classList.remove('ch-chat-sized'); return; }
            p.classList.add('ch-chat-sized');
            p.style.setProperty(m.prop, `${lineSize()}px`);
            return;
        }
        if (v) p.style.setProperty(m.prop, `${clamp(v, m.min, m.max())}px`); else p.style.removeProperty(m.prop);
        // A sheet with a height of its own leaves the rest to the channel line; without one it fills (channel.css).
        if (mode === 'sheet') p.classList.toggle('ch-chat-sized', !!v);
    }
    function applySaved() { for (const mode of Object.keys(MODES)) setSize(mode, read(MODES[mode].key)); }
    function settle() { window.dispatchEvent(new Event('resize')); }   // the player and the diagrams re-measure

    function reset(mode) { write(MODES[mode].key, 0); setSize(mode, 0); settle(); }

    // A focusable separator is a value control (WAI-ARIA): it says its orientation and the size it sets, in pixels,
    // kept current through every drag, key, reset and layout change.
    function sync(g, sidebar) {
        if (!g || !sidebar) return;
        const mode = modeOf(); const m = MODES[mode]; const r = sidebar.getBoundingClientRect();
        const now = Math.round(m.axis === 'x' ? r.width : r.height);
        g.setAttribute('aria-orientation', m.axis === 'x' ? 'vertical' : 'horizontal');
        g.setAttribute('aria-valuemin', String(m.min));
        g.setAttribute('aria-valuemax', String(Math.round(Math.max(m.min, m.max()))));
        g.setAttribute('aria-valuenow', String(clamp(now, m.min, Math.max(m.min, m.max()))));
        g.setAttribute('aria-valuetext', `Chat ${now} pixels ${m.axis === 'x' ? 'wide' : 'tall'}`);
    }
    function syncAll() { document.querySelectorAll('#page-channel .stream-layout > .chat-sidebar').forEach((s) => sync(s._ovGrip, s)); }

    function bind(sidebar) {
        if (!sidebar || sidebar._ovGrip) return;
        const g = document.createElement('div');
        g.className = 'chat-grip';
        g.setAttribute('role', 'separator');
        g.setAttribute('aria-label', 'Resize chat');
        g.tabIndex = 0;
        g.title = 'Drag to resize the chat · double-click for the default size';
        sidebar.prepend(g);
        sidebar._ovGrip = g;
        sync(g, sidebar);

        let drag = null, lastTap = 0;
        g.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            const mode = modeOf(); const r = sidebar.getBoundingClientRect();
            drag = { mode, id: e.pointerId, x: e.clientX, y: e.clientY, from: MODES[mode].axis === 'x' ? r.width : r.height, cur: 0, moved: false };
            try { g.setPointerCapture(e.pointerId); } catch { /* */ }
            g.classList.add('dragging');
            page()?.classList.add('chat-resizing');
            e.preventDefault();
        });
        g.addEventListener('pointermove', (e) => {
            if (!drag || e.pointerId !== drag.id) return;
            const m = MODES[drag.mode];
            const delta = m.axis === 'x' ? drag.x - e.clientX : drag.y - e.clientY;   // the chat sits right / at the bottom
            if (Math.abs(delta) > 3) drag.moved = true;
            // The sheet may go below its minimum while dragging: letting go there closes it.
            drag.cur = Math.round(Math.max(drag.mode === 'sheet' ? 60 : m.min, Math.min(m.max(), drag.from + delta)));
            const p = page(); if (p) { p.style.setProperty(m.prop, `${drag.cur}px`); if (drag.mode === 'sheet') p.classList.add('ch-chat-sized'); }
            sync(g, sidebar);
        });
        const end = (e) => {
            if (!drag || (e && e.pointerId !== drag.id)) return;
            const d = drag; drag = null;
            g.classList.remove('dragging');
            page()?.classList.remove('chat-resizing');
            if (!d.moved) {
                // A tap: two in a row restore the default size.
                const now = Date.now();
                if (now - lastTap < 320) { lastTap = 0; reset(d.mode); } else lastTap = now;
                return;
            }
            const m = MODES[d.mode];
            if (d.mode === 'sheet' && docked()) {
                // Docked: most of the way down folds the chat to its round button; all the way up is "fill" again.
                if (d.cur < m.min) {
                    setSize('sheet', read(m.key));
                    if (typeof window.toggleChannelChat === 'function') window.toggleChannelChat(true);
                    sync(g, sidebar);
                    return;
                }
                // Otherwise the nearer of its two heights: all the way up, or just under the channel line.
                const line = lineSize();
                if (Math.abs(d.cur - m.max()) <= Math.abs(d.cur - line)) { reset('sheet'); sync(g, sidebar); return; }
                write(m.key, LINE); setSize('sheet', LINE); settle(); sync(g, sidebar);
                return;
            }
            if (d.mode === 'sheet' && d.cur < m.min) {
                setSize('sheet', read(m.key));   // keep the last real height for next time
                const s = document.querySelector('#page-channel .chat-sidebar.mobile-chat-open');
                if (s && typeof window.toggleMobileChat === 'function') window.toggleMobileChat();
                return;
            }
            write(m.key, clamp(d.cur, m.min, m.max()));
            settle();
            sync(g, sidebar);
        };
        g.addEventListener('pointerup', end);
        g.addEventListener('pointercancel', end);
        g.addEventListener('lostpointercapture', end);
        g.addEventListener('dblclick', () => { reset(modeOf()); sync(g, sidebar); });
        g.addEventListener('keydown', (e) => {
            const mode = modeOf(); const m = MODES[mode];
            if (e.key === 'Enter') { e.preventDefault(); reset(mode); sync(g, sidebar); return; }
            const grow = m.axis === 'x' ? { ArrowLeft: 1, ArrowRight: -1 } : { ArrowUp: 1, ArrowDown: -1 };
            if (!(e.key in grow)) return;
            e.preventDefault();
            const r = sidebar.getBoundingClientRect();
            if (mode === 'sheet' && docked()) {
                // Up: all the way up. Down: under the channel line, then folded.
                if (grow[e.key] > 0) reset('sheet');
                else if (read(m.key) === LINE) { if (typeof window.toggleChannelChat === 'function') window.toggleChannelChat(true); }
                else { write(m.key, LINE); setSize('sheet', LINE); settle(); }
                sync(g, sidebar);
                return;
            }
            const v = clamp((m.axis === 'x' ? r.width : r.height) + grow[e.key] * 24, m.min, m.max());
            setSize(mode, v); write(m.key, v); settle();
            sync(g, sidebar);
        });
    }

    function init() {
        applySaved();
        document.querySelectorAll('#page-channel .stream-layout > .chat-sidebar').forEach(bind);
        syncAll();
        // The page goes live (or stops) after this runs: the docked sheet's saved height is measured again then.
        const p = page();
        if (p && !p._ovSheetWatch && window.MutationObserver) {
            p._ovSheetWatch = true;
            let was = p.classList.contains('ch-is-live');
            new MutationObserver(() => { const now = p.classList.contains('ch-is-live'); if (now !== was) { was = now; applySaved(); syncAll(); } })
                .observe(p, { attributes: true, attributeFilter: ['class'] });
        }
    }
    init();
    document.addEventListener('ov:fragment', init);
    // A size saved on a wide window can be too wide for a smaller one: re-clamp when the window changes.
    let t = 0;
    window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => { applySaved(); syncAll(); }, 150); });
    window.ChannelChatResize = { init, reset: () => reset(modeOf()) };
})();
