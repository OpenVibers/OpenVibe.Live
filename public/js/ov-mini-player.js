/* ───────────────────────────────────────────────────────────────
   ov-mini-player.js — the live player follows the viewer.

   A viewer who walks away from a channel that is live does not have to come back to keep
   watching: the picture moves into a small box in the corner of the page and keeps playing
   until the viewer closes it (the owner's rule, 2026-10-31).

   The box is not a second player: it holds the very same <video> element, moved out of the
   channel's container, so there is one session, one SFU transport and one sound. Coming back
   to the channel puts the element back where the channel expects it (and the channel then
   starts its own session, as it always did).

   Rules:
     • only a live picture that is playing right now is worth keeping;
     • not on the way to the broadcast desk — that page needs the machine for its own video;
     • not on the way to another channel — that page brings its own player.
   ─────────────────────────────────────────────────────────────── */

(function () {
    'use strict';
    if (window.OVMiniPlayer) return;

    const st = { box: null, video: null, home: null, title: '', href: '', styleEl: null };

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

    function ensureStyles() {
        if (st.styleEl || typeof document === 'undefined') return;
        st.styleEl = document.createElement('style');
        st.styleEl.id = 'ov-mini-player-style';
        st.styleEl.textContent = [
            '.ov-mini-player{position:fixed;right:14px;bottom:14px;width:min(46vw,320px);z-index:70;',
            'aspect-ratio:16/9;border-radius:12px;overflow:hidden;background:#000;',
            'box-shadow:0 10px 30px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.12)}',
            '.ov-mini-player.video-container #video-element{width:100%;height:100%;object-fit:contain;display:block;',
            'opacity:1;filter:none;transform:none;pointer-events:auto}',
            '.ov-mini-player-bar{position:absolute;left:0;right:0;top:0;display:flex;align-items:center;gap:6px;',
            'padding:5px 6px;background:linear-gradient(rgba(0,0,0,.7),rgba(0,0,0,0));color:#fff;font-size:12px}',
            '.ov-mini-player-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
            'background:none;border:0;color:inherit;font:inherit;text-align:left;cursor:pointer;padding:2px}',
            '.ov-mini-player-close{flex:0 0 auto;border:0;background:rgba(255,255,255,.16);color:#fff;border-radius:6px;',
            'width:22px;height:22px;line-height:1;cursor:pointer}',
            '.ov-mini-player-close:hover{background:rgba(255,255,255,.3)}',
            '@media (max-width:600px){.ov-mini-player{width:min(52vw,240px);right:8px;bottom:8px}}',
        ].join('');
        (document.head || document.documentElement).appendChild(st.styleEl);
    }

    function build() {
        ensureStyles();
        const box = document.createElement('div');
        box.className = 'video-container ov-mini-player';
        box.id = 'ov-mini-player';

        const bar = document.createElement('div');
        bar.className = 'ov-mini-player-bar';

        const name = document.createElement('button');
        name.type = 'button';
        name.className = 'ov-mini-player-name';
        name.textContent = st.title || 'Live';
        name.title = st.href ? 'Back to the channel' : '';
        name.addEventListener('click', () => {
            if (st.href && typeof navigate === 'function') navigate(st.href);
        });

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'ov-mini-player-close';
        close.setAttribute('aria-label', 'Close the mini player');
        close.textContent = '\u00d7';
        close.addEventListener('click', () => {
            // The viewer closed it: the player goes away for good.
            if (typeof destroyPlayer === 'function') { try { destroyPlayer(); } catch { /* */ } }
            release();
        });

        bar.appendChild(name);
        bar.appendChild(close);
        box.appendChild(bar);
        st.box = box;
        document.body.appendChild(box);
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

        build();
        st.box.appendChild(video);      // the picture follows the viewer
        return true;
    }

    /** Put the video back and take the box away (the channel page is opening its own player). */
    function release() {
        if (!st.box) return;
        const box = st.box;
        st.box = null;
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
