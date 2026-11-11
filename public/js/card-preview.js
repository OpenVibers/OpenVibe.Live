/**
 * card-preview.js — a card's moving preview (ask 355; Opus, 2026-11-11).
 *
 * Media makes a 6-second, 320 px, muted preview beside each recording's and clip's thumbnail (preview_url MP4 and
 * preview_webm_url); a live row's preview_url is Media's DVR playlist of the recording in progress (HLS). A card that
 * has one carries data-preview (previewAttrs below) and this file plays it inside the card's picture:
 *
 *   - with a mouse: after a short rest on the card (or keyboard focus on it), until the pointer or focus leaves;
 *   - on a touch screen: the card that settles in the middle of the screen after a scroll, one at a time.
 *
 * The picture stays until the video is really playing, then the video fades in over it; badges (LIVE, the length)
 * stay above it, and a thin line along the bottom shows how far the preview has played. Motion Off and Save-Data play
 * nothing; Calm and reduced motion keep hover but not the scroll-driven one. Live previews need HLS: Safari plays it
 * natively, other browsers load hls.js (the player's own copy) on the first live hover.
 */
(function () {
    'use strict';
    if (window.cardPreview) return;
    const FINE = window.matchMedia('(hover: hover) and (pointer: fine)');
    const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');
    const HLS_SRC = 'https://cdn.jsdelivr.net/npm/hls.js@latest';
    const REST_MS = 260;          // a pointer resting this long on a card means "show me"
    const SETTLE_MS = 420;        // a phone's scroll has stopped this long: play the card in the middle
    const motion = () => document.documentElement.getAttribute('data-ov-motion') || '';
    const allowed = () => motion() !== 'off' && !(navigator.connection && navigator.connection.saveData);
    const scrollAllowed = () => allowed() && motion() !== 'calm' && !REDUCED.matches;
    const safe = (u) => typeof u === 'string' && /^(https:\/\/|\/(?!\/))/.test(u) ? u : '';
    const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

    /** The data attributes for a row's card (empty when it has no preview). */
    function previewAttrs(row) {
        const src = safe(row && row.preview_url);
        if (!src) return '';
        const webm = safe(row.preview_webm_url);
        return ` data-preview="${attr(src)}"${webm ? ` data-preview-webm="${attr(webm)}"` : ''}${/\.m3u8(\?|$)/.test(src) ? ' data-preview-hls' : ''}`;
    }

    let hlsLoading = null;
    function loadHls() {
        if (window.Hls) return Promise.resolve(window.Hls);
        if (!hlsLoading) {
            hlsLoading = new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = HLS_SRC;
                s.async = true;
                s.onload = () => (window.Hls ? resolve(window.Hls) : reject(new Error('hls.js')));
                s.onerror = () => { hlsLoading = null; reject(new Error('hls.js')); };
                document.head.appendChild(s);
            });
        }
        return hlsLoading;
    }

    let current = null;           // { card, video, bar, hls }
    let restTimer = 0;

    function stop() {
        clearTimeout(restTimer);
        const c = current;
        current = null;
        if (!c) return;
        c.card.classList.remove('is-previewing');
        try { c.video.pause(); } catch { /* */ }
        if (c.hls) { try { c.hls.destroy(); } catch { /* */ } }
        // Let the fade run before the video leaves (the picture is underneath the whole time).
        setTimeout(() => {
            c.video.removeAttribute('src');
            c.video.replaceChildren();
            c.video.remove();
            if (c.bar) c.bar.remove();
        }, 220);
    }

    function start(card) {
        if (!card || !card.isConnected || !allowed()) return;
        if (current && current.card === card) return;
        stop();
        const thumb = card.querySelector('.stream-card-thumb');
        const src = safe(card.dataset.preview);
        if (!thumb || !src) return;
        const video = document.createElement('video');
        video.className = 'card-preview';
        video.muted = true;
        video.defaultMuted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.disablePictureInPicture = true;
        video.setAttribute('muted', '');
        video.setAttribute('playsinline', '');
        video.setAttribute('aria-hidden', 'true');
        video.tabIndex = -1;
        const live = card.hasAttribute('data-preview-hls');
        let bar = null;
        if (!live) {
            video.loop = true;
            bar = document.createElement('span');
            bar.className = 'card-preview-bar';
            bar.setAttribute('aria-hidden', 'true');
            video.addEventListener('timeupdate', () => {
                if (video.duration) bar.style.setProperty('--p', String(Math.min(1, video.currentTime / video.duration)));
            });
        }
        const entry = { card, video, bar, hls: null };
        current = entry;
        video.addEventListener('playing', () => { if (current === entry) card.classList.add('is-previewing'); }, { once: true });
        video.addEventListener('error', () => { if (current === entry) stop(); }, { once: true });
        // Under the badges: right after the picture, so LIVE and the length stay on top.
        const img = thumb.querySelector(':scope > img');
        thumb.insertBefore(video, img ? img.nextSibling : thumb.firstChild);
        if (bar) thumb.appendChild(bar);
        const play = () => { if (current === entry) video.play().catch(() => { /* autoplay refused: the picture stays */ }); };
        if (live) {
            if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = src; play(); return; }
            loadHls().then((Hls) => {
                if (current !== entry || !Hls.isSupported()) return;
                const hls = new Hls({ maxBufferLength: 6, backBufferLength: 0, liveSyncDurationCount: 2, startLevel: 0, capLevelToPlayerSize: true });
                entry.hls = hls;
                hls.loadSource(src);
                hls.attachMedia(video);
                hls.on(Hls.Events.MANIFEST_PARSED, play);
                hls.on(Hls.Events.ERROR, (_e, data) => { if (data && data.fatal && current === entry) stop(); });
            }).catch(() => { if (current === entry) stop(); });
            return;
        }
        const webm = safe(card.dataset.previewWebm);
        if (webm) { const s = document.createElement('source'); s.src = webm; s.type = 'video/webm'; video.appendChild(s); }
        const mp4 = document.createElement('source');
        mp4.src = src;
        mp4.type = 'video/mp4';
        video.appendChild(mp4);
        play();
    }

    const cardOf = (node) => (node && node.closest ? node.closest('a.stream-card[data-preview]') : null);

    // A mouse: rest on a card to play it, leave to stop.
    document.addEventListener('pointerover', (e) => {
        if (e.pointerType !== 'mouse' || !FINE.matches) return;
        const card = cardOf(e.target);
        if (!card || (current && current.card === card)) return;
        clearTimeout(restTimer);
        restTimer = setTimeout(() => start(card), REST_MS);
    }, { passive: true });
    document.addEventListener('pointerout', (e) => {
        if (e.pointerType !== 'mouse') return;
        const card = cardOf(e.target);
        if (!card || card.contains(e.relatedTarget)) return;
        clearTimeout(restTimer);
        if (current && current.card === card) stop();
    }, { passive: true });
    // The keyboard: focus plays, leaving stops.
    document.addEventListener('focusin', (e) => {
        const card = cardOf(e.target);
        if (card && card === e.target && FINE.matches) { clearTimeout(restTimer); restTimer = setTimeout(() => start(card), REST_MS); }
    });
    document.addEventListener('focusout', (e) => {
        const card = cardOf(e.target);
        if (card && current && current.card === card && !card.contains(e.relatedTarget)) stop();
    });

    // A touch screen: the card whose picture sits nearest the middle, fully in view, once the scroll settles.
    let settleTimer = 0;
    function settle() {
        if (FINE.matches || !scrollAllowed() || document.hidden) return;
        const mid = window.innerHeight / 2;
        let best = null;
        let bestD = Infinity;
        for (const card of document.querySelectorAll('a.stream-card[data-preview]')) {
            const t = card.querySelector('.stream-card-thumb');
            if (!t || !t.offsetParent) continue;
            const r = t.getBoundingClientRect();
            if (r.top < 0 || r.bottom > window.innerHeight || r.width < 120) continue;
            const d = Math.abs((r.top + r.bottom) / 2 - mid);
            if (d < bestD) { bestD = d; best = card; }
        }
        if (best) start(best); else stop();
    }
    window.addEventListener('scroll', () => {
        if (FINE.matches) return;
        clearTimeout(settleTimer);
        if (current && current.card) {
            const r = current.card.getBoundingClientRect();
            if (r.bottom < 0 || r.top > window.innerHeight) stop();
        }
        settleTimer = setTimeout(settle, SETTLE_MS);
    }, { passive: true, capture: true });

    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
    // A page change (the SPA swaps the grid): whatever was playing goes with it.
    window.addEventListener('popstate', stop);
    document.addEventListener('ov:navigate', stop);

    window.cardPreview = { previewAttrs, start, stop, settle };
    window.previewAttrs = previewAttrs;
})();
