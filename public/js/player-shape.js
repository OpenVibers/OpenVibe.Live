/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Live — the live player takes the stream's own shape (owner, 2026-10-26: "ensure the live feed viewers see is
   responsive and resizes intelligently and intuitively").

   The box was 16:9, or "vertical" when the picture was taller than wide: a 4:3, square or ultrawide stream sat in bars,
   and a portrait one on a desktop was a full-width black box whose height pushed the channel name off a laptop screen.
   Now:
   - The box's ratio is the picture's (--video-ar on #video-container, from the video's own size or a JSMPEG canvas's).
     The CSS keeps it the column's width and caps its height so the channel line below stays on screen (channel.css,
     "The player takes the stream's shape"): a wide picture fills the box exactly, a tall one is as tall as allowed.
   - A size change that keeps the ratio within SAME (WebRTC lowering 720p to 360p on a weak network) moves nothing; a
     real turn eases to the new shape (the CSS transition) instead of jumping.
   - The first paint already has the shape: the ratio this browser last saw on the channel, else the stream's thumbnail
     (hint()), until the picture says otherwise.
   - Where the box is wider than the picture (a portrait stream on a wide screen), a soft blurred copy of the picture
     fills the sides instead of black bars: a 48 px sample every 0.7 s while it plays and is on screen; none for reduced
     motion or data saver.

   OVPlayerShape.watch(video, box, { key, canvas }) — once per player start (stream-player.js initPlayer); idempotent
   per element, and a new key (another channel) starts from that channel's remembered shape.
   OVPlayerShape.hint(box, ratio) — a ratio known before the picture (the thumbnail); ignored once the picture has one.
   ═══════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    if (window.OVPlayerShape) return;
    const SAME = 0.03;                  // |ln(ratio a / ratio b)| under this is the same shape
    const MIN = 0.4, MAX = 3.2;         // 9:22 .. 32:10: anything outside is a broken size, not a shape
    const STORE = 'ov_player_shape';    // { channel: ratio } (the last 40 channels)
    const DEFAULT = 16 / 9;

    const clamp = (r) => Math.min(MAX, Math.max(MIN, r));
    const same = (a, b) => Math.abs(Math.log(a / b)) < SAME;
    function remembered(key) {
        if (!key) return null;
        try { const r = Number((JSON.parse(localStorage.getItem(STORE) || '{}') || {})[key]); return r > 0 ? clamp(r) : null; } catch { return null; }
    }
    function remember(key, ratio) {
        if (!key) return;
        try {
            const all = JSON.parse(localStorage.getItem(STORE) || '{}') || {};
            delete all[key];
            all[key] = +ratio.toFixed(4);
            const keys = Object.keys(all);
            for (const k of keys.slice(0, Math.max(0, keys.length - 40))) delete all[k];
            localStorage.setItem(STORE, JSON.stringify(all));
        } catch { /* private mode, storage full: the shape still follows the picture */ }
    }

    function apply(box, ratio) {
        const st = box._ovShape;
        st.ratio = ratio;
        box.style.setProperty('--video-ar', ratio.toFixed(4));
        box.dataset.shape = ratio < 0.95 ? 'portrait' : ratio > 1.05 ? 'landscape' : 'square';
        box.classList.toggle('is-vertical', ratio < 0.95);   // the chat sidebar's width on a desktop keys on it
        if (st.glow) st.glow.check();
    }

    /** The blurred fill beside a picture narrower than its box. */
    function glow(box, source) {
        const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
        const saver = navigator.connection && navigator.connection.saveData;
        const c = document.createElement('canvas');
        const ctx = !reduce && !saver && c.getContext && c.getContext('2d');
        if (!ctx) return null;
        c.className = 'player-shape-glow';
        c.setAttribute('aria-hidden', 'true');
        box.insertBefore(c, box.firstChild);
        let timer = 0, visible = true, on = false;
        if (typeof IntersectionObserver === 'function') new IntersectionObserver((es) => { visible = es[0].isIntersecting; }).observe(box);
        const paint = () => {
            const src = source();
            const w = src && (src.videoWidth || src.width), h = src && (src.videoHeight || src.height);
            if (!visible || document.hidden || !w || !h || (src.readyState !== undefined && src.readyState < 2)) return;
            // Cover the box: the picture's middle, scaled up to the box's shape (the blur hides the rest).
            const bw = box.clientWidth || 1, bh = box.clientHeight || 1;
            c.width = 48; c.height = Math.max(8, Math.round(48 * bh / bw));
            const s = Math.max(c.width / w, c.height / h);
            try { ctx.drawImage(src, (c.width - w * s) / 2, (c.height - h * s) / 2, w * s, h * s); } catch { return; }
            c.classList.add('is-on');
        };
        return {
            /** On when the box is visibly wider or taller than the picture; off (and still) when the picture fills it. */
            check() {
                const st = box._ovShape;
                const bw = box.clientWidth, bh = box.clientHeight;
                const want = !!(st.ratio && bw && bh && Math.abs(Math.log(st.ratio / (bw / bh))) > 0.05);
                if (want === on) return;
                on = want;
                clearInterval(timer);
                if (on) { paint(); timer = setInterval(paint, 700); } else c.classList.remove('is-on');
            },
        };
    }

    function watch(video, box, { key = null, canvas = null } = {}) {
        if (!video || !box) return null;
        let st = box._ovShape;
        if (!st) {
            st = box._ovShape = { ratio: null, fromPicture: false, key: null, glow: null };
            const shown = () => (canvas && canvas.style.display !== 'none' && canvas.width > 0 && !(video.videoWidth > 0) ? canvas : video);
            const update = () => {
                const src = shown();
                const w = src.videoWidth || (src === canvas ? canvas.width : 0);
                const h = src.videoHeight || (src === canvas ? canvas.height : 0);
                if (!(w > 0 && h > 0)) return;
                const r = clamp(w / h);
                st.fromPicture = true;
                if (st.ratio && same(r, st.ratio)) return;
                apply(box, r);
                remember(st.key, r);
            };
            video.addEventListener('loadedmetadata', update);
            video.addEventListener('resize', update);
            if (canvas && typeof MutationObserver === 'function') new MutationObserver(update).observe(canvas, { attributes: true, attributeFilter: ['width', 'height', 'style'] });
            st.glow = glow(box, shown);
            if (st.glow) {
                video.addEventListener('playing', () => st.glow.check());
                if (typeof ResizeObserver === 'function') new ResizeObserver(() => st.glow.check()).observe(box);
            }
            st.update = update;
        }
        // A new channel (or the first start): its remembered shape until its picture arrives. The element may still hold
        // the last channel's size, so only the new picture's own events set the shape from here.
        if (key !== st.key || !st.ratio) {
            st.key = key;
            st.fromPicture = false;
            apply(box, remembered(key) || DEFAULT);
        } else st.update();
        return st;
    }

    function hint(box, ratio) {
        const st = box && box._ovShape;
        if (!st || st.fromPicture || !(ratio > 0)) return;
        const r = clamp(ratio);
        if (!st.ratio || !same(r, st.ratio)) apply(box, r);
    }

    window.OVPlayerShape = { watch, hint, SAME, _same: same, _clamp: clamp };
})();
