/**
 * draggable-fab.js — make the floating buttons (DM messenger toggle + global-chat FAB)
 * drag-and-droppable, robustly, on desktop and touch.
 *
 * Key behaviours:
 *  • EDGE-ANCHORED position. We store which corner the button belongs to (left/right ×
 *    top/bottom) and its distance from those two edges — NOT an absolute x/y. On window
 *    resize (or mobile rotate / URL-bar show-hide), the button stays glued to its corner
 *    instead of drifting into the middle. Applied via CSS right/bottom so the browser
 *    keeps it anchored for free.
 *  • Tap ≠ drag. A real drag past a small threshold suppresses the click that follows, so
 *    moving the button never opens its menu; a plain tap opens it normally.
 *  • Mobile-safe. Guards against the spurious (0,0) pointermove some mobile browsers emit
 *    (the cause of the "button jumps to the top-left on tap" glitch) and against acting on
 *    a pre-layout zero-size rect.
 *
 * Pointer Events → one code path for mouse + touch.
 */
(function () {
    'use strict';

    var MARGIN = 12;          // keep this gap from every viewport edge
    var DRAG_THRESHOLD = 6;   // px of movement before it counts as a drag (not a tap)

    // Capture-phase click killer: cancels the click that fires right after a drag.
    document.addEventListener('click', function (e) {
        var el = e.target && e.target.closest ? e.target.closest('.fab-just-dragged') : null;
        if (el) { e.stopPropagation(); e.preventDefault(); el.classList.remove('fab-just-dragged'); }
    }, true);

    function makeFabDraggable(el, key) {
        if (!el || el._draggableInit) return;
        el._draggableInit = true;
        el.style.touchAction = 'none';

        var startX = 0, startY = 0, origLeft = 0, origTop = 0, dragging = false, moved = false, pid = null;

        function vw() { return window.innerWidth || document.documentElement.clientWidth; }
        function vh() { return window.innerHeight || document.documentElement.clientHeight; }
        function size() { return { w: el.offsetWidth || 52, h: el.offsetHeight || 52 }; }

        // Absolute placement (used live during a drag), clamped on-screen.
        function placeXY(x, y) {
            var s = size();
            x = Math.min(Math.max(MARGIN, x), Math.max(MARGIN, vw() - s.w - MARGIN));
            y = Math.min(Math.max(MARGIN, y), Math.max(MARGIN, vh() - s.h - MARGIN));
            el.style.left = x + 'px'; el.style.top = y + 'px';
            el.style.right = 'auto'; el.style.bottom = 'auto';
        }

        // Current on-screen rect → an edge-anchored model { ax, ay, dx, dy }.
        function anchorFromRect() {
            var s = size(), r = el.getBoundingClientRect();
            var cx = r.left + s.w / 2, cy = r.top + s.h / 2;
            var ax = cx > vw() / 2 ? 'right' : 'left';
            var ay = cy > vh() / 2 ? 'bottom' : 'top';
            var dx = ax === 'left' ? r.left : (vw() - r.right);
            var dy = ay === 'top' ? r.top : (vh() - r.bottom);
            return { ax: ax, ay: ay, dx: Math.round(dx), dy: Math.round(dy) };
        }

        // Apply an edge-anchored model using right/bottom CSS so it stays glued to its
        // corner across viewport changes. Returns true if clamping had to move it.
        function applyAnchor(a, animate) {
            var s = size();
            var maxX = Math.max(MARGIN, vw() - s.w - MARGIN);
            var maxY = Math.max(MARGIN, vh() - s.h - MARGIN);
            var dx = Math.min(Math.max(MARGIN, a.dx), maxX);
            var dy = Math.min(Math.max(MARGIN, a.dy), maxY);
            var clamped = (dx !== a.dx) || (dy !== a.dy);
            if (animate) el.style.transition = 'left .38s cubic-bezier(.34,1.56,.64,1), top .38s cubic-bezier(.34,1.56,.64,1), right .38s cubic-bezier(.34,1.56,.64,1), bottom .38s cubic-bezier(.34,1.56,.64,1)';
            if (a.ax === 'left') { el.style.left = dx + 'px'; el.style.right = 'auto'; }
            else { el.style.right = dx + 'px'; el.style.left = 'auto'; }
            if (a.ay === 'top') { el.style.top = dy + 'px'; el.style.bottom = 'auto'; }
            else { el.style.bottom = dy + 'px'; el.style.top = 'auto'; }
            if (animate) setTimeout(function () { el.style.transition = ''; }, 420);
            return clamped;
        }

        function save(a) { try { localStorage.setItem(key, JSON.stringify(a)); } catch (_) {} }
        function load() {
            try {
                var a = JSON.parse(localStorage.getItem(key));
                if (a && (a.ax === 'left' || a.ax === 'right') && (a.ay === 'top' || a.ay === 'bottom')
                    && typeof a.dx === 'number' && typeof a.dy === 'number' && isFinite(a.dx) && isFinite(a.dy)) return a;
            } catch (_) {}
            return null;
        }

        function bounce() {
            el.classList.remove('fab-bounce'); void el.offsetWidth; el.classList.add('fab-bounce');
            setTimeout(function () { el.classList.remove('fab-bounce'); }, 500);
        }

        // ── Restore a saved position (else leave the CSS default corner, which already
        //    resizes correctly on its own). ──
        var savedAnchor = load();
        if (savedAnchor) applyAnchor(savedAnchor, false);

        // ── Drag ──
        el.addEventListener('pointerdown', function (e) {
            if (e.button != null && e.button !== 0) return;   // primary button / touch only
            var r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) return;       // not laid out yet — ignore
            pid = e.pointerId;
            origLeft = r.left; origTop = r.top;
            startX = e.clientX; startY = e.clientY;
            dragging = true; moved = false;
            el.style.transition = '';
            try { el.setPointerCapture(pid); } catch (_) {}
        });

        el.addEventListener('pointermove', function (e) {
            if (!dragging || e.pointerId !== pid) return;
            // Some mobile browsers emit a bogus (0,0) move right after pointerdown — that
            // spurious jump is what threw the button to the top-left corner. Ignore it.
            if (e.clientX === 0 && e.clientY === 0) return;
            var dx = e.clientX - startX, dy = e.clientY - startY;
            if (!moved && (dx * dx + dy * dy) < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
            moved = true;
            el.classList.add('fab-dragging');
            placeXY(origLeft + dx, origTop + dy);
            e.preventDefault();
        });

        function end(e) {
            if (!dragging || (e && e.pointerId != null && e.pointerId !== pid)) return;
            dragging = false;
            try { el.releasePointerCapture(pid); } catch (_) {}
            el.classList.remove('fab-dragging');
            if (!moved) return;                 // a tap — leave the click to open the menu
            var a = anchorFromRect();
            applyAnchor(a, false);              // switch to edge anchoring (same visual spot)
            save(a);
            el.classList.add('fab-just-dragged');
            setTimeout(function () { el.classList.remove('fab-just-dragged'); }, 400);
        }
        el.addEventListener('pointerup', end);
        el.addEventListener('pointercancel', end);
        el.addEventListener('lostpointercapture', function () { if (dragging) end({ pointerId: pid }); });

        // ── Viewport changes: re-apply the anchor so the button stays in its corner. ──
        var rzT;
        function onViewportChange() {
            var a = load();
            if (!a) return;                     // unmoved → CSS default already handles it
            clearTimeout(rzT);
            rzT = setTimeout(function () {
                var before = el.getBoundingClientRect();
                var clamped = applyAnchor(a, false);
                var after = el.getBoundingClientRect();
                if (clamped && (Math.abs(after.left - before.left) > 2 || Math.abs(after.top - before.top) > 2)) bounce();
            }, 60);
        }
        window.addEventListener('resize', onViewportChange);
        window.addEventListener('orientationchange', onViewportChange);
    }
    window.makeFabDraggable = makeFabDraggable;

    // Auto-wire the two known buttons. The FAB is static; the messenger toggle is injected
    // later by messenger.js — watch for it. (messenger.js also calls this directly.)
    function tryInit() {
        var fab = document.getElementById('floating-chat-fab');
        if (fab) makeFabDraggable(fab, 'fabpos:floating-chat-fab');
        var toggle = document.getElementById('messenger-toggle');
        if (toggle) makeFabDraggable(toggle, 'fabpos:messenger-toggle');
        return !!(fab && toggle);
    }

    function boot() {
        if (tryInit()) return;
        var obs = new MutationObserver(function () { if (tryInit()) { /* both wired */ } });
        obs.observe(document.body, { childList: true, subtree: false });
        setTimeout(function () { try { obs.disconnect(); } catch (_) {} }, 60000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
