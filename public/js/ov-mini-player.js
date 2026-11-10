/* ───────────────────────────────────────────────────────────────
   ov-mini-player.js — the live player follows the viewer.

   A viewer who walks away from a channel that is live does not have to come back to keep
   watching: the picture moves into a small player in a corner and keeps playing until the
   viewer closes it (the owner's rule, 2026-10-31).

   The box is not a second player: it holds the very same <video> element, moved out of the
   channel's container, so there is one session, one SFU transport and one sound. Coming back
   to the channel puts the element back where the channel expects it.

   How it handles (the owner, 11-08: "move and resize it like YouTube on Android", "it shows
   behind the app bar", "a chat button for the room"):
     • it glides from the channel's player into its corner, and sits between the navbar and
       the phone's app bar, never under either;
     • drag it anywhere: let go and it settles in the nearest corner (a flick carries it);
       flick it off the side of the screen to close it;
     • resize it: the handle on its inner corner (a mouse), two fingers (a phone), or a double
       tap for small or large; the size and corner are remembered on this device;
     • a tap shows its controls (always shown under a mouse hover): sound, the channel's chat,
       back to the channel, close. The chat opens the channel's own chat (/popout/<name>)
       beside it, or as a sheet above the app bar on a phone, while the picture keeps playing.

   Rules:
     • only a live picture that is playing right now is worth keeping;
     • not on the way to the broadcast desk — that page needs the machine for its own video;
     • not on the way to another channel — that page brings its own player.
   ─────────────────────────────────────────────────────────────── */

(function () {
    'use strict';
    if (window.OVMiniPlayer) return;

    const KEY = 'ov-mini-player';
    const st = { box: null, video: null, home: null, title: '', href: '', user: '', styleEl: null, chat: null, x: 0, y: 0, w: 0, corner: 'br', idle: 0, offRo: null };
    const reduced = () => { try { return (document.documentElement.getAttribute('data-ov-motion') === 'off'); } catch { return false; } };
    const phone = () => { try { return matchMedia('(max-width: 759px)').matches; } catch { return false; } };
    const fine = () => { try { return matchMedia('(hover: hover) and (pointer: fine)').matches; } catch { return false; } };

    /** A channel page: /@name or /stream/... */
    function isChannelPath(path) {
        return /^\/(?:@|stream)/.test(String(path || ''));
    }

    /** The player is a live stream that is playing right now (SFU MediaStream, HLS or FLV). */
    function isPlaying() {
        const video = document.getElementById('video-element');
        if (!video) return false;
        if (!video.srcObject && !video.currentSrc && !video.src) return false;
        if (video.paused || video.ended) return false;
        return video.readyState >= 2;
    }

    const ICON = {
        sound: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
        muted: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M17 9.5l5 5M22 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
        chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-5 4V6a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
        expand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
        grip: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13L13 3M8 13l5-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    };

    function ensureStyles() {
        if (st.styleEl || typeof document === 'undefined') return;
        st.styleEl = document.createElement('style');
        st.styleEl.id = 'ov-mini-player-style';
        st.styleEl.textContent = `
.ov-mini-player{position:fixed;left:0;top:0;z-index:9980;width:var(--mp-w,320px);aspect-ratio:16/9;border-radius:14px;overflow:hidden;background:#000;
  transform:translate3d(var(--mp-x,0px),var(--mp-y,0px),0);box-shadow:0 18px 44px -12px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.1);
  touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;cursor:grab;will-change:transform}
.ov-mini-player.is-settling{transition:transform .34s cubic-bezier(.2,.8,.2,1),width .34s cubic-bezier(.2,.8,.2,1),height .34s cubic-bezier(.2,.8,.2,1),border-radius .34s,opacity .25s}
.ov-mini-player.is-dragging{cursor:grabbing;box-shadow:0 26px 60px -14px rgba(0,0,0,.7),0 0 0 1px rgba(255,255,255,.16)}
.ov-mini-player.is-leaving{opacity:.35}
.ov-mini-player.video-container #video-element{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:block;opacity:1;filter:none;transform:none;pointer-events:none}
.ov-mp-ui{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:space-between;opacity:0;transition:opacity .2s;background:linear-gradient(rgba(0,0,0,.62),rgba(0,0,0,0) 42%,rgba(0,0,0,0) 58%,rgba(0,0,0,.55))}
.ov-mini-player.is-ui .ov-mp-ui{opacity:1}
@media (hover:hover) and (pointer:fine){.ov-mini-player:hover .ov-mp-ui{opacity:1}}
.ov-mp-top,.ov-mp-row{display:flex;align-items:center;gap:6px;padding:7px 8px}
.ov-mp-live{flex:none;display:inline-flex;align-items:center;gap:5px;padding:2px 7px;border-radius:999px;background:#e5484d;color:#fff;font:800 10px/1.6 system-ui,sans-serif;letter-spacing:.06em}
.ov-mp-live::before{content:'';width:6px;height:6px;border-radius:50%;background:#fff}
.ov-mp-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#fff;font:700 12.5px/1.3 system-ui,sans-serif;text-shadow:0 1px 2px rgba(0,0,0,.5)}
.ov-mp-row{justify-content:flex-end}
.ov-mp-b{flex:none;display:inline-grid;place-items:center;width:34px;height:34px;border:0;border-radius:999px;background:rgba(20,22,30,.55);color:#fff;cursor:pointer;
  -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);transition:background-color .15s,transform .15s}
.ov-mp-b svg{width:18px;height:18px}
.ov-mp-b:hover{background:rgba(255,255,255,.24)}
.ov-mp-b:active{transform:scale(.9)}
.ov-mp-b:focus-visible{outline:2px solid #fff;outline-offset:1px}
.ov-mp-b[aria-pressed="true"]{background:#fff;color:#0b0f19}
.ov-mp-x{width:28px;height:28px}
.ov-mp-x svg{width:15px;height:15px}
.ov-mp-grip{position:absolute;width:26px;height:26px;display:grid;place-items:center;color:rgba(255,255,255,.85);cursor:nwse-resize;opacity:0;transition:opacity .2s}
.ov-mp-grip svg{width:14px;height:14px}
.ov-mini-player:hover .ov-mp-grip{opacity:1}
.ov-mini-player[data-corner="br"] .ov-mp-grip{left:0;top:0;transform:rotate(180deg)}
.ov-mini-player[data-corner="bl"] .ov-mp-grip{right:0;top:0;transform:rotate(270deg);cursor:nesw-resize}
.ov-mini-player[data-corner="tr"] .ov-mp-grip{left:0;bottom:0;transform:rotate(90deg);cursor:nesw-resize}
.ov-mini-player[data-corner="tl"] .ov-mp-grip{right:0;bottom:0}
@media (hover:none){.ov-mp-grip{display:none}}
.ov-mp-chat{position:fixed;z-index:9979;display:flex;flex-direction:column;overflow:hidden;border-radius:16px;background:var(--bg-card,#101624);
  box-shadow:0 20px 48px -14px rgba(0,0,0,.65),0 0 0 1px var(--border,rgba(255,255,255,.12));opacity:0;transform:translateY(10px) scale(.98);transform-origin:var(--mp-origin,100% 100%);
  transition:opacity .22s,transform .3s cubic-bezier(.2,.8,.2,1)}
.ov-mp-chat.is-open{opacity:1;transform:none}
.ov-mp-chat-h{display:flex;align-items:center;gap:8px;padding:8px 8px 8px 14px;border-bottom:1px solid var(--border,rgba(255,255,255,.1));color:var(--text-primary,#e6edf7);font:700 13px/1.3 system-ui,sans-serif}
.ov-mp-chat-h span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ov-mp-chat-h .ov-mp-b{background:transparent;color:inherit;width:30px;height:30px}
.ov-mp-chat-h .ov-mp-b:hover{background:rgba(127,127,127,.18)}
.ov-mp-chat iframe{flex:1;width:100%;border:0;background:transparent}
`;
        (document.head || document.documentElement).appendChild(st.styleEl);
    }

    // ── Where it may sit: between the navbar and the phone's app bar, a margin from each side ──
    function bounds() {
        const css = getComputedStyle(document.documentElement);
        const px = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
        const nav = document.querySelector('.openvibe-navbar');
        const navRect = nav ? nav.getBoundingClientRect() : null;
        const top = Math.max(8, navRect && navRect.bottom > 0 ? navRect.bottom + 8 : px(css.getPropertyValue('--ovnav-h'), 56) + 8);
        const bar = document.querySelector('.ovnav-appbar');
        const barH = bar && bar.getBoundingClientRect().height ? bar.getBoundingClientRect().height : 0;
        const m = phone() ? 10 : 16;
        return { left: m, right: innerWidth - m, top, bottom: innerHeight - barH - m };
    }
    const sizeOf = (w) => ({ w, h: Math.round(w * 9 / 16) });
    function clampW(w) {
        const min = phone() ? 160 : 220, max = Math.min(phone() ? innerWidth - 20 : 640, innerWidth * (phone() ? 0.94 : 0.6));
        return Math.round(Math.max(min, Math.min(max, w)));
    }
    function cornerXY(corner, w) {
        const b = bounds(), { h } = sizeOf(w);
        return { x: corner[1] === 'l' ? b.left : b.right - w, y: corner[0] === 't' ? b.top : Math.max(b.top, b.bottom - h) };
    }
    function place(x, y, w, settle) {
        const box = st.box; if (!box) return;
        st.x = x; st.y = y; st.w = w;
        box.classList.toggle('is-settling', !!settle && !reduced());
        box.style.setProperty('--mp-w', `${w}px`);
        box.style.setProperty('--mp-x', `${Math.round(x)}px`);
        box.style.setProperty('--mp-y', `${Math.round(y)}px`);
        placeChat();
    }
    function settle(corner, w) {
        st.corner = corner;
        st.box.setAttribute('data-corner', corner);
        const p = cornerXY(corner, w);
        place(p.x, p.y, w, true);
        try { localStorage.setItem(KEY, JSON.stringify({ corner, w })); } catch { /* private mode */ }
    }
    function saved() {
        try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (s && /^[tb][lr]$/.test(s.corner) && s.w > 0) return s; } catch { /* */ }
        return { corner: 'br', w: phone() ? Math.min(240, Math.round(innerWidth * 0.56)) : 360 };
    }
    function nearest(x, y, w) {
        const b = bounds(), { h } = sizeOf(w);
        const cx = x + w / 2, cy = y + h / 2;
        return `${cy < (b.top + b.bottom) / 2 ? 't' : 'b'}${cx < (b.left + b.right) / 2 ? 'l' : 'r'}`;
    }

    // ── The controls show on a tap and hide again after a moment (always under a mouse hover) ──
    function showUi() {
        if (!st.box) return;
        st.box.classList.add('is-ui');
        clearTimeout(st.idle);
        st.idle = setTimeout(() => { if (st.box && !st.box.matches(':focus-within')) st.box.classList.remove('is-ui'); }, 3200);
    }

    // ── Gestures: drag (a flick carries it, off the side closes it), pinch and the grip resize, double tap ──
    function wireGestures(box) {
        const pts = new Map();
        let drag = null, pinch = null, lastTap = 0, grip = null;
        const capture = (id) => { try { box.setPointerCapture(id); } catch { /* a pointer the browser no longer tracks */ } };
        const vel = [];
        box.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.ov-mp-b')) return;
            if (e.target.closest('.ov-mp-grip')) { grip = { x: e.clientX, w: st.w, corner: st.corner }; capture(e.pointerId); e.preventDefault(); return; }
            pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
            capture(e.pointerId);
            if (pts.size === 2) {
                const [a, b] = [...pts.values()];
                pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, w: st.w };
                drag = null;
                return;
            }
            drag = { sx: e.clientX, sy: e.clientY, x: st.x, y: st.y, moved: false, t: performance.now() };
            vel.length = 0;
        });
        box.addEventListener('pointermove', (e) => {
            if (grip) {
                const dx = (e.clientX - grip.x) * (grip.corner[1] === 'r' ? -1 : 1);
                const w = clampW(grip.w + dx);
                const p = cornerXY(grip.corner, w);
                place(p.x, p.y, w, false);
                return;
            }
            if (!pts.has(e.pointerId)) return;
            pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pinch && pts.size === 2) {
                const [a, b] = [...pts.values()];
                const w = clampW(pinch.w * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d));
                const cx = st.x + st.w / 2, cy = st.y + sizeOf(st.w).h / 2;
                place(cx - w / 2, cy - sizeOf(w).h / 2, w, false);
                return;
            }
            if (!drag) return;
            const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
            if (!drag.moved && Math.hypot(dx, dy) < 6) return;
            if (!drag.moved) { drag.moved = true; box.classList.add('is-dragging'); }
            vel.push({ x: e.clientX, y: e.clientY, t: performance.now() }); if (vel.length > 6) vel.shift();
            place(drag.x + dx, drag.y + dy, st.w, false);
            const b = bounds();
            box.classList.toggle('is-leaving', st.x + st.w < b.left + st.w * 0.45 || st.x > b.right - st.w * 0.55);
        });
        const end = (e) => {
            if (grip) { const g = grip; grip = null; settle(g.corner, st.w); return; }
            pts.delete(e.pointerId);
            if (pinch) { if (pts.size < 2) { pinch = null; settle(nearest(st.x, st.y, st.w), st.w); } return; }
            if (!drag) return;
            const d = drag; drag = null;
            box.classList.remove('is-dragging');
            if (!d.moved) {
                // A tap: the controls; a double tap: small or large.
                const now = performance.now();
                if (now - lastTap < 300) { lastTap = 0; const big = st.w < clampW(phone() ? innerWidth : 520) * 0.8; settle(st.corner, clampW(big ? (phone() ? innerWidth - 20 : 520) : (phone() ? 200 : 320))); return; }
                lastTap = now;
                if (box.classList.contains('is-ui') && !fine()) { box.classList.remove('is-ui'); clearTimeout(st.idle); } else showUi();
                return;
            }
            let vx = 0, vy = 0;
            if (vel.length > 1) { const a = vel[0], z = vel[vel.length - 1]; const dt = Math.max(1, z.t - a.t); vx = (z.x - a.x) / dt; vy = (z.y - a.y) / dt; }
            const b = bounds();
            // Off the side: dragged more than half out, or flicked sideways while already past that edge (a fast drag
            // across the screen to the other corner is a move, not a dismissal).
            const tdx = st.x - d.x, tdy = st.y - d.y;
            const sideways = Math.abs(vx) > 1.2 && Math.abs(vx) > Math.abs(vy) * 1.5 && Math.abs(tdx) > Math.abs(tdy) * 2;
            const off = st.x + st.w < b.left + st.w * 0.45 || st.x > b.right - st.w * 0.55
                || (sideways && vx > 0 && st.x + st.w > b.right + st.w * 0.15) || (sideways && vx < 0 && st.x < b.left - st.w * 0.15);
            if (off) { flyOff(vx >= 0 || st.x > b.right - st.w ? 1 : -1); return; }
            box.classList.remove('is-leaving');
            // A flick carries it: project where it would come to rest, then take that corner.
            settle(nearest(st.x + vx * 180, st.y + vy * 180, st.w), st.w);
        };
        box.addEventListener('pointerup', end);
        box.addEventListener('pointercancel', end);
        box.addEventListener('dblclick', (e) => { if (!e.target.closest('.ov-mp-b')) e.preventDefault(); });
        box.addEventListener('mouseenter', () => clearTimeout(st.idle));
        box.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeForGood(); });
    }

    function flyOff(dir) {
        const box = st.box; if (!box) return;
        box.classList.remove('is-dragging');
        if (reduced()) { closeForGood(); return; }
        box.classList.add('is-settling', 'is-leaving');
        box.style.setProperty('--mp-x', `${dir > 0 ? innerWidth + 20 : -st.w - 20}px`);
        setTimeout(closeForGood, 300);
    }

    // ── The channel's chat beside the picture (a sheet above the app bar on a phone) ──
    function toggleChat(force) {
        const open = force != null ? force : !st.chat;
        const btn = st.box && st.box.querySelector('[data-mp="chat"]');
        if (!open) {
            const c = st.chat; st.chat = null;
            if (btn) btn.setAttribute('aria-pressed', 'false');
            if (c) { c.classList.remove('is-open'); setTimeout(() => c.remove(), reduced() ? 0 : 260); }
            if (c && st.box) settle(st.corner, st.w);      // back to its corner from above the sheet
            return;
        }
        if (st.chat || !st.user) return;
        const c = document.createElement('section');
        c.className = 'ov-mp-chat';
        c.setAttribute('aria-label', `Chat for ${st.title}`);
        const h = document.createElement('div'); h.className = 'ov-mp-chat-h';
        const t = document.createElement('span'); t.textContent = `${st.title} \u00b7 chat`;
        const x = document.createElement('button'); x.type = 'button'; x.className = 'ov-mp-b'; x.setAttribute('aria-label', 'Close the chat'); x.innerHTML = ICON.close;
        x.addEventListener('click', () => toggleChat(false));
        h.append(t, x);
        const f = document.createElement('iframe');
        f.title = `${st.title}'s chat`;
        f.src = `/popout/${encodeURIComponent(st.user)}`;
        f.loading = 'eager';
        c.append(h, f);
        document.body.appendChild(c);
        st.chat = c;
        if (btn) btn.setAttribute('aria-pressed', 'true');
        placeChat();
        requestAnimationFrame(() => requestAnimationFrame(() => c.classList.add('is-open')));
    }
    function placeChat() {
        const c = st.chat; if (!c || !st.box) return;
        const b = bounds(), h = sizeOf(st.w).h;
        if (phone()) {
            // A sheet across the bottom, above the app bar; the picture rides on top of it.
            const sheetH = Math.round(Math.min(innerHeight * 0.55, b.bottom - b.top - h - 12));
            Object.assign(c.style, { left: '8px', right: '8px', width: 'auto', top: 'auto', bottom: `${innerHeight - b.bottom}px`, height: `${sheetH}px` });
            c.style.setProperty('--mp-origin', '50% 100%');
            return;
        }
        const w = Math.max(320, st.w), ch = Math.min(460, b.bottom - b.top - 10);
        const left = Math.min(Math.max(b.left, st.corner[1] === 'r' ? st.x + st.w - w : st.x), b.right - w);
        const above = st.corner[0] === 'b';
        const top = above ? Math.max(b.top, st.y - ch - 10) : Math.min(st.y + h + 10, b.bottom - ch);
        Object.assign(c.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${ch}px`, right: 'auto', bottom: 'auto' });
        c.style.setProperty('--mp-origin', `${st.corner[1] === 'r' ? '100%' : '0%'} ${above ? '100%' : '0%'}`);
    }
    // On a phone, with the chat open, the picture sits just above the sheet.
    function phoneChatCorner() {
        if (!st.chat || !phone()) return;
        const sheet = st.chat.getBoundingClientRect();
        const b = bounds();
        place(st.corner[1] === 'l' ? b.left : b.right - st.w, Math.max(b.top, sheet.top - sizeOf(st.w).h - 8), st.w, true);
    }

    function build() {
        ensureStyles();
        const box = document.createElement('div');
        box.className = 'video-container ov-mini-player';
        box.id = 'ov-mini-player';
        box.setAttribute('role', 'region');
        box.setAttribute('aria-label', `${st.title}, live, in a mini player`);

        const ui = document.createElement('div'); ui.className = 'ov-mp-ui';
        const top = document.createElement('div'); top.className = 'ov-mp-top';
        const live = document.createElement('span'); live.className = 'ov-mp-live'; live.textContent = 'LIVE';
        const name = document.createElement('span'); name.className = 'ov-mp-name'; name.textContent = st.title || 'Live';
        const btn = (key, label, icon, fn, cls) => {
            const b = document.createElement('button'); b.type = 'button'; b.className = `ov-mp-b${cls ? ` ${cls}` : ''}`; b.setAttribute('data-mp', key);
            b.setAttribute('aria-label', label); b.title = label; b.innerHTML = icon;
            b.addEventListener('click', (e) => { e.stopPropagation(); fn(b); showUi(); });
            return b;
        };
        const x = btn('close', 'Close the mini player', ICON.close, closeForGood, 'ov-mp-x');
        top.append(live, name, x);
        const row = document.createElement('div'); row.className = 'ov-mp-row';
        const sound = btn('sound', 'Sound', st.video && st.video.muted ? ICON.muted : ICON.sound, (b) => {
            if (!st.video) return;
            st.video.muted = !st.video.muted;
            b.innerHTML = st.video.muted ? ICON.muted : ICON.sound;
            b.setAttribute('aria-label', st.video.muted ? 'Turn the sound on' : 'Mute');
        });
        sound.setAttribute('aria-label', st.video && st.video.muted ? 'Turn the sound on' : 'Mute');
        const chat = btn('chat', 'Chat', ICON.chat, () => { toggleChat(); phoneChatCorner(); });
        chat.setAttribute('aria-pressed', 'false');
        if (!st.user) chat.hidden = true;
        const back = btn('back', 'Back to the channel', ICON.expand, () => { if (st.href && typeof navigate === 'function') navigate(st.href); });
        row.append(sound, chat, back);
        ui.append(top, row);

        const grip = document.createElement('span'); grip.className = 'ov-mp-grip'; grip.innerHTML = ICON.grip; grip.setAttribute('aria-hidden', 'true');
        box.append(ui, grip);
        st.box = box;
        document.body.appendChild(box);
        wireGestures(box);
        st.onResize = () => { if (st.box) { settle(st.corner, clampW(st.w)); phoneChatCorner(); } };
        addEventListener('resize', st.onResize);
    }

    /**
     * Keep the player alive across a route change. Returns true when the player was kept (the
     * caller must then NOT tear it down).
     */
    function keepAlive(nextPath) {
        // A channel page (or the studio) brings its own player: give the element back and let
        // the normal teardown destroy this session. This comes before the "already a mini
        // player" test — otherwise walking back to the channel left two players fighting over
        // the one <video> element.
        const onPlayerPage = nextPath && (isChannelPath(nextPath) || String(nextPath).startsWith('/broadcast'));
        if (onPlayerPage) {
            if (st.box) release();
            try { if (window.OVOverlay) window.OVOverlay.close('live'); } catch { /* */ }
            return false;
        }
        if (st.box) return true;                                   // already a mini player
        if (!isPlaying()) return false;
        const video = document.getElementById('video-element');
        const home = document.getElementById('video-container');
        if (!video || !home || video.parentElement !== home) return false;

        st.video = video;
        st.home = home;
        st.title = (document.getElementById('ch-display-name')?.textContent || '').trim()
            || (document.getElementById('ch-stream-title')?.textContent || '').trim()
            || 'Live';
        st.href = location.pathname;
        const m = /^\/@([^/?#]+)/.exec(location.pathname);
        st.user = m ? decodeURIComponent(m[1]) : '';

        const from = home.getBoundingClientRect();
        build();
        st.box.insertBefore(video, st.box.firstChild);      // the picture follows the viewer, under its controls
        // It glides from where the channel's player was into its corner.
        const s = saved();
        const w = clampW(s.w);
        st.corner = s.corner;
        st.box.setAttribute('data-corner', s.corner);
        if (!reduced() && from.width > 0) {
            place(from.left, from.top, Math.max(160, Math.min(innerWidth, from.width)), false);
            void st.box.offsetWidth;
        }
        requestAnimationFrame(() => settle(s.corner, w));
        if (!fine()) showUi();
        declare(true);
        return true;
    }

    // Across OpenVibe sites (Shared 4.152.0 overlay.js): while the picture is in this mini player, a link to another
    // OpenVibe site carries it as a floating card that frames Live's own /embed/<name> (a new session there; this one
    // ends with the page), with the channel's chat beside it. Coming back to the channel closes that card.
    function declare(on) {
        const nav = window.OpenVibeNavbar;
        if (!nav || typeof nav.overlays !== 'function') return;
        nav.overlays().then((O) => {
            if (!O) return;
            if (!on || !st.user) { O.declare('live', null); return; }
            const u = encodeURIComponent(st.user);
            O.declare('live', {
                src: `${location.origin}/embed/${u}`, title: st.title, live: true, href: `${location.origin}/@${u}`,
                side: { src: `${location.origin}/popout/${u}`, title: `${st.title} \u00b7 chat` },
            });
        }).catch(() => { /* the overlay host could not load: the mini player still works here */ });
    }

    /** The viewer closed it: the player goes away for good. */
    function closeForGood() {
        if (typeof destroyPlayer === 'function') { try { destroyPlayer(); } catch { /* */ } }
        release();
    }

    /** Put the video back and take the box away (the channel page is opening its own player). */
    function release() {
        if (!st.box) return;
        const box = st.box;
        toggleChat(false);
        declare(false);
        st.box = null;
        clearTimeout(st.idle);
        if (st.onResize) { removeEventListener('resize', st.onResize); st.onResize = null; }
        if (st.video && st.home && st.video.parentElement === box) {
            try { st.home.appendChild(st.video); } catch { /* the page is gone */ }
        }
        st.video = null;
        st.home = null;
        try { box.remove(); } catch { /* */ }
    }

    /** Is the picture in the mini player right now? */
    function isMini() { return !!st.box; }

    window.OVMiniPlayer = { keepAlive, release, isMini, isChannelPath };
})();
