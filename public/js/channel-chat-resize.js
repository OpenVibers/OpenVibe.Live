/*
   OpenVibe.Live — resize the channel page's chat with a mouse, a finger, a pen or the keyboard, in each layout it has:

     side     1181px and wider: the column beside the stream; the grip on its left edge sets the width
     overlay  1180px and narrower, landscape: the panel over the right side; the same grip sets its width
     sheet    1180px and narrower, portrait: the bottom sheet; the grip on its top edge sets the height, and
              letting go most of the way down closes the sheet

   Double-click or double-tap a grip (or press Enter on it) for the default size; arrow keys move it 24px.
   Each layout remembers its own size (localStorage), applied as CSS variables on #page-channel, which
   public/css/features/channel.css reads: --chat-w, --chat-ow, --chat-sheet-h.
*/
(function () {
    'use strict';
    const WIDE = window.matchMedia('(min-width: 1181px)');
    const LAND = window.matchMedia('(orientation: landscape)');
    const MODES = {
        side: { key: 'openvibe_chat_width', prop: '--chat-w', axis: 'x', min: 260, max: () => Math.min(window.innerWidth * 0.5, 760) },
        overlay: { key: 'openvibe_chat_overlay_w', prop: '--chat-ow', axis: 'x', min: 260, max: () => window.innerWidth * 0.7 },
        sheet: { key: 'openvibe_chat_sheet_h', prop: '--chat-sheet-h', axis: 'y', min: 180, max: () => window.innerHeight * 0.92 },
    };
    const page = () => document.getElementById('page-channel');
    const modeOf = () => (WIDE.matches ? 'side' : LAND.matches ? 'overlay' : 'sheet');
    const clamp = (v, a, b) => Math.round(Math.max(a, Math.min(b, v)));
    const read = (k) => { try { return parseInt(localStorage.getItem(k), 10) || 0; } catch { return 0; } };
    const write = (k, v) => { try { if (v) localStorage.setItem(k, String(Math.round(v))); else localStorage.removeItem(k); } catch { /* private mode */ } };

    function setSize(mode, v) {
        const p = page(); const m = MODES[mode];
        if (!p) return;
        if (v) p.style.setProperty(m.prop, `${clamp(v, m.min, m.max())}px`); else p.style.removeProperty(m.prop);
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
            const p = page(); if (p) p.style.setProperty(m.prop, `${drag.cur}px`);
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
            const v = clamp((m.axis === 'x' ? r.width : r.height) + grow[e.key] * 24, m.min, m.max());
            setSize(mode, v); write(m.key, v); settle();
            sync(g, sidebar);
        });
    }

    function init() {
        applySaved();
        document.querySelectorAll('#page-channel .stream-layout > .chat-sidebar').forEach(bind);
        syncAll();
    }
    init();
    document.addEventListener('ov:fragment', init);
    // A size saved on a wide window can be too wide for a smaller one: re-clamp when the window changes.
    let t = 0;
    window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => { applySaved(); syncAll(); }, 150); });
    window.ChannelChatResize = { init, reset: () => reset(modeOf()) };
})();
