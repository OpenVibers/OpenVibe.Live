/**
 * home-featured.js — the featured live stream at the top of the home page.
 *
 * Whenever someone is live, the home page opens on a stream: picked by the server from everyone
 * live (busiest first, rotating every few minutes so a quiet stream gets its turn), playing muted
 * and inline, with the newest AI "right now" description beside it and one button into the
 * stream and its chat. Loaded only when a stream is live (features.json: featured), so an empty
 * site pays nothing for it.
 *
 * Playback by protocol, without the channel page's player (which is bound to that page's DOM):
 *   rtmp    → HTTP-FLV through flv.js, the same relay the channel uses as its backup
 *   jsmpeg  → the JSMPEG relay socket into a canvas
 *   webrtc  → live frames (the stream's thumbnail, refreshed) with a "tap to watch" note; a
 *             mediasoup viewer session is the channel page's job
 * Sound is never on by itself; the Unmute button asks the browser for it. Playback pauses when
 * the tab is hidden or the box scrolls away, and stops when the reader leaves the home page.
 *
 * Off switch: the × in the corner (and "Show featured stream" in the Live Now header to undo it).
 * Remembered in localStorage.
 */
(function () {
    'use strict';
    if (window.homeFeatured) return;

    const OFF_KEY = 'ov_home_featured_off';
    const POLL_MS = 30000;
    const FRAME_MS = 10000;

    const st = { el: null, current: null, poll: 0, frame: 0, player: null, unmuted: false, visible: true, io: null, gen: 0, skip: null, retryTimer: 0, retries: 0, broken: false };
    const $ = (sel) => st.el && st.el.querySelector(sel);
    const escText = (v) => (typeof esc === 'function' ? esc(String(v == null ? '' : v)) : String(v == null ? '' : v));
    const constrained = () => {
        try {
            const c = navigator.connection || {};
            return !!(c.saveData || /(^|[^3-9])2g/.test(String(c.effectiveType || '')));
        } catch { return false; }
    };

    function isOff() { try { return localStorage.getItem(OFF_KEY) === '1'; } catch { return false; } }
    function setOff(off) {
        try { off ? localStorage.setItem(OFF_KEY, '1') : localStorage.removeItem(OFF_KEY); } catch { /* */ }
        const t = document.getElementById('home-featured-toggle');
        if (t) t.hidden = !off || !st.hasLive;
        if (off) stop(); else boot(true);
    }

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const have = document.querySelector(`script[data-hf-src="${src}"]`);
            if (have) { if (have.dataset.loaded) resolve(); else { have.addEventListener('load', resolve); have.addEventListener('error', reject); } return; }
            const s = document.createElement('script');
            s.src = src; s.async = true; s.dataset.hfSrc = src;
            s.onload = () => { s.dataset.loaded = '1'; resolve(); };
            s.onerror = () => reject(new Error('script failed: ' + src));
            document.head.appendChild(s);
        });
    }

    // ── Players ────────────────────────────────────────────────────────────────
    function destroyPlayer() {
        const p = st.player;
        st.player = null;
        if (!p) return;
        try { p.destroy(); } catch { /* */ }
    }
    async function playFlv(url, media) {
        if (typeof flvjs === 'undefined') await loadScript('https://cdn.jsdelivr.net/npm/flv.js@latest/dist/flv.min.js');
        if (typeof flvjs === 'undefined' || !flvjs.isSupported()) throw new Error('flv unsupported');
        const video = document.createElement('video');
        video.muted = !st.unmuted; video.autoplay = true; video.playsInline = true; video.setAttribute('playsinline', '');
        media.appendChild(video);
        const player = flvjs.createPlayer({ type: 'flv', url, isLive: true }, { enableStashBuffer: false, stashInitialSize: 128, lazyLoad: false, autoCleanupSourceBuffer: true, autoCleanupMaxBackwardDuration: 20, autoCleanupMinBackwardDuration: 8 });
        player.attachMediaElement(video);
        player.load();
        // A dropped network or a source that went quiet leaves the picture standing still: the
        // player picks itself up (the owner's rule, 2026-10-31) instead of asking for a reload.
        player.on('error', (errType, errDetail) => {
            console.warn('[Featured] The live feed failed:', errType, errDetail);
            scheduleRetry();
        });
        video.addEventListener('error', () => { console.warn('[Featured] The live video failed'); scheduleRetry(); });
        video.play().catch(() => { /* muted autoplay is allowed; a refusal only means no sound */ });
        return {
            video,
            pause() { try { video.pause(); } catch { /* */ } },
            resume() { video.play().catch(() => { }); },
            setMuted(m) { video.muted = m; if (!m) video.play().catch(() => { }); },
            destroy() { try { player.pause(); player.unload(); player.detachMediaElement(); player.destroy(); } catch { /* */ } video.remove(); },
        };
    }
    async function playJsmpeg(endpoint, media) {
        if (typeof JSMpeg === 'undefined') await loadScript('/js/jsmpeg.min.js');
        const port = endpoint.videoPort || endpoint.video_port || endpoint.wsPort || 9710;
        const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:${port}`;
        const canvas = document.createElement('canvas');
        media.appendChild(canvas);
        const player = new JSMpeg.Player(url, { canvas, audio: st.unmuted, disableGl: false, pauseWhenHidden: true, videoBufferSize: 1024 * 1024 });
        return {
            pause() { try { player.pause(); } catch { /* */ } },
            resume() { try { player.play(); } catch { /* */ } },
            setMuted(m) { try { if (player.audioOut) player.audioOut.volume = m ? 0 : 1; if (!m && player.audioOut && player.audioOut.unlock) player.audioOut.unlock(); } catch { /* */ } },
            destroy() { try { player.destroy(); } catch { /* */ } canvas.remove(); },
        };
    }
    function playFrames(stream, media) {
        const img = document.createElement('img');
        img.className = 'hf-frame'; img.alt = ''; img.decoding = 'async';
        img.src = stream.thumbnail_url || '';
        img.onerror = () => { img.style.display = 'none'; }; // a frame that fails to load shows nothing, not a broken-image icon
        media.appendChild(img);
        const tick = () => {
            if (!st.current || !st.visible || !stream.thumbnail_url) return;
            const next = new Image();
            const src = stream.thumbnail_url + (stream.thumbnail_url.includes('?') ? '&' : '?') + 't=' + Date.now();
            next.onload = () => { img.style.opacity = '0'; setTimeout(() => { img.src = src; img.style.opacity = '1'; }, 250); };
            next.src = src;
        };
        st.frame = setInterval(tick, FRAME_MS);
        return { pause() { }, resume() { }, setMuted() { }, destroy() { clearInterval(st.frame); st.frame = 0; img.remove(); } };
    }

    // ── Render ─────────────────────────────────────────────────────────────────
    function render(d) {
        const s = d.stream;
        const m = d.moment;
        // The note alone: the raw speech-to-text after " — heard:" is the AI's context, not something to show (it can be
        // 500 characters of another language; the server strips it too, server/db/database.js publicMemoryText).
        const now = m && m.description ? String(m.description).replace(/\s+—\s+heard:[\s\S]*$/, '').trim() : '';
        const chan = typeof channelPath === 'function' ? channelPath(s.username, s.managed_stream_slug || s.managed_stream_id || null) : `/@${s.username}`;
        const viewers = Number(s.total_viewer_count || s.viewer_count || 0);
        const up = (typeof formatUptime === 'function' && s.started_at) ? formatUptime(s.started_at) : '';
        const canPlay = !constrained() && (s.protocol === 'rtmp' || s.protocol === 'jsmpeg');
        // 2026-11-11 (owner: "you don't need the featured live text on that area … have it floating on top of it"): the
        // stream's title, who and how long ride on the picture, so the card is the picture and what it says right now.
        const inferred = s.ai_category && s.ai_category === s.category;
        // The session overview only when it says something Right now does not (a young stream's overview is that note).
        const ovText = String(s.ai_overview_short || s.ai_overview || '').trim();
        const same = (a, b) => !!a && !!b && a.slice(0, 48) === b.slice(0, 48);
        const overview = ovText && !same(ovText, now) ? ovText : '';
        st.el.innerHTML = `
            <div class="hf" data-stream-id="${escText(s.id)}">
                <div class="hf-media">
                    ${s.thumbnail_url ? `<div class="hf-poster" style="background-image:url('${escText(s.thumbnail_url)}')"></div>` : ''}
                    <a class="hf-media-link" href="${escText(chan)}" onclick="return handleLinkClick(event, '${escText(chan)}')" aria-label="Watch ${escText(s.title || 'the stream')} with ${escText(s.display_name || s.username)}"></a>
                    <div class="hf-top">
                        <span class="hf-live" title="Featured live stream"><i class="fa-solid fa-circle"></i> LIVE</span>
                        <span class="hf-viewers" title="Watching now"><i class="fa-solid fa-eye"></i> ${viewers.toLocaleString()}</span>
                        ${canPlay ? '' : `<span class="hf-preview-note" title="${constrained() ? 'Saving data: a new frame every few seconds' : 'A new frame every few seconds; open the stream to watch it live'}">${constrained() ? 'Frames · saving data' : 'Live frames'}</span>`}
                        <span class="hf-top-end">
                            ${canPlay ? `<button type="button" class="hf-sound" aria-pressed="${st.unmuted}" aria-label="${st.unmuted ? 'Mute' : 'Unmute'}" title="${st.unmuted ? 'Mute' : 'Unmute'}"><i class="fa-solid ${st.unmuted ? 'fa-volume-high' : 'fa-volume-xmark'}"></i></button>` : ''}
                            <button type="button" class="hf-hide" title="Hide the featured stream (bring it back from the Live Now header)" aria-label="Hide the featured stream"><i class="fa-solid fa-xmark"></i></button>
                        </span>
                    </div>
                    <div class="hf-cap" aria-hidden="true">
                        <h3 class="hf-title">${escText(s.title || 'Untitled Stream')}</h3>
                        <span class="hf-who">
                            ${typeof _avatarSpan === 'function' ? _avatarSpan(s.avatar_url, s.username, s.profile_color) : ''}
                            <b>${escText('@' + (s.username || s.display_name || ''))}</b>
                            ${s.category ? `<span class="hf-tag"${inferred ? ' title="Category inferred by OpenVibe&#39;s AI from the stream"' : ''}>${escText(s.category)}${inferred ? '<span class="cat-inferred"> · inferred</span>' : ''}</span>` : ''}
                            ${up ? `<span class="hf-up"><i class="fa-solid fa-clock"></i> ${escText(up)}</span>` : ''}
                        </span>
                    </div>
                </div>
                <div class="hf-panel">
                    <div class="hf-head">
                        <h3 class="hf-title">${escText(s.title || 'Untitled Stream')}</h3>
                        <a class="hf-who" href="${escText(chan)}" onclick="return handleLinkClick(event, '${escText(chan)}')">
                            ${typeof _avatarSpan === 'function' ? _avatarSpan(s.avatar_url, s.username, s.profile_color) : ''}
                            <b>${escText('@' + (s.username || s.display_name || ''))}</b>
                            ${s.category ? `<span class="hf-tag">${escText(s.category)}</span>` : ''}
                            ${up ? `<span class="hf-up"><i class="fa-solid fa-clock"></i> ${escText(up)}</span>` : ''}
                        </a>
                    </div>
                    ${now ? `<div class="hf-now"><span class="hf-now-head"><i class="fa-solid fa-wand-magic-sparkles"></i> Right now <span>${m.captured_at ? escText(typeof timeAgo === 'function' ? timeAgo(m.captured_at) : '') : ''}</span></span>${escText(now)}</div>` : ''}
                    ${overview ? `<div class="hf-overview">${escText(overview)}</div>` : ''}
                    <div class="hf-actions">
                        <a class="hf-watch" href="${escText(chan)}" onclick="return handleLinkClick(event, '${escText(chan)}')"><i class="fa-solid fa-play"></i> Watch &amp; chat</a>
                        ${d.count > 1 ? `<button type="button" class="hf-next" title="The next live stream"><i class="fa-solid fa-forward"></i> Next <small>${d.count} live</small></button>` : ''}
                    </div>
                    <span class="hf-chat"><i class="fa-solid fa-comments"></i> Anyone can chat, no account needed</span>
                </div>
            </div>`;
        $('.hf-hide').addEventListener('click', () => setOff(true));
        const sound = $('.hf-sound');
        if (sound) sound.addEventListener('click', () => {
            st.unmuted = !st.unmuted;
            if (st.player) st.player.setMuted(!st.unmuted);
            sound.setAttribute('aria-pressed', String(st.unmuted));
            sound.setAttribute('aria-label', st.unmuted ? 'Mute' : 'Unmute'); sound.title = st.unmuted ? 'Mute' : 'Unmute';
            sound.innerHTML = `<i class="fa-solid ${st.unmuted ? 'fa-volume-high' : 'fa-volume-xmark'}"></i>`;
        });
        const next = $('.hf-next');
        if (next) next.addEventListener('click', () => { st.skip = s.id; load(true); });
        startPlayer(s);
    }

    async function startPlayer(s) {
        destroyPlayer();
        const media = $('.hf-media');
        if (!media) return;
        const gen = ++st.gen;
        let p = null;
        try {
            if (constrained()) p = playFrames(s, media);
            else if (s.protocol === 'rtmp' && s.endpoint && s.endpoint.flvUrl) p = await playFlv(s.endpoint.flvUrl, media);
            else if (s.protocol === 'jsmpeg' && s.endpoint) p = await playJsmpeg(s.endpoint, media);
            else p = playFrames(s, media);
        } catch {
            p = playFrames(s, media);
        }
        if (gen !== st.gen) { try { p.destroy(); } catch { /* */ } return; }
        st.player = p;
        st.broken = false;
        if (!st.visible || document.hidden) p.pause();
    }

    /**
     * The live feed failed (a dropped network, a source that went away): try again by ourselves,
     * and fall back to the live frames when it keeps failing — a picture that stands still is
     * better than a broken player, and the reader can always open the channel.
     */
    function scheduleRetry(delay = 4000) {
        if (st.retryTimer) return;
        st.broken = true;
        st.retryTimer = setTimeout(() => {
            st.retryTimer = 0;
            if (!st.current || !st.el || st.el.hidden) return;
            st.retries++;
            if (st.retries > 4) {
                console.warn('[Featured] The live feed keeps failing — showing the live frames instead');
                destroyPlayer();
                st.player = playFrames(st.current, $('.hf-media'));
                return;
            }
            console.warn(`[Featured] Trying the live feed again (${st.retries}/4)`);
            startPlayer(st.current);
        }, delay);
    }

    /** Only the parts that change between polls; the player stays put unless the stream changed. */
    function update(d) {
        const s = d.stream;
        const v = $('.hf-viewers');
        if (v) v.innerHTML = `<i class="fa-solid fa-eye"></i> ${Number(s.total_viewer_count || s.viewer_count || 0).toLocaleString()}`;
        for (const t of st.el.querySelectorAll('.hf-title')) if (t.textContent !== (s.title || 'Untitled Stream')) t.textContent = s.title || 'Untitled Stream';
        const now = $('.hf-now');
        const m = d.moment;
        if (m && m.description) {
            const text = m.description;
            if (now) {
                const body = now.childNodes[now.childNodes.length - 1];
                if (body && body.nodeType === 3 && body.textContent !== text) {
                    now.classList.add('is-updating');
                    setTimeout(() => { body.textContent = text; const span = now.querySelector('.hf-now-head span'); if (span) span.textContent = typeof timeAgo === 'function' && m.captured_at ? timeAgo(m.captured_at) : ''; now.classList.remove('is-updating'); }, 300);
                }
            }
        }
        if (st.player && st.player.video === undefined && s.thumbnail_url && st.current) st.current.thumbnail_url = s.thumbnail_url;
    }

    async function load(force) {
        if (!st.el || isOff()) return;
        let d;
        try { d = await api('/home/featured' + (st.skip ? `?not=${encodeURIComponent(st.skip)}` : '')); } catch { return; }
        st.skip = null;
        if (!d || !d.stream) { stop(); return; }
        const changed = !st.current || st.current.id !== d.stream.id || force;
        if (changed) {
            const media = $('.hf-media');
            if (media) { media.classList.add('is-switching'); await new Promise((r) => setTimeout(r, 220)); }
            st.current = d.stream;
            st.retries = 0;      // a new stream starts with a clean sheet
            render(d);
        } else update(d);
        st.el.hidden = false;
        markGrid();
    }

    function watchVisibility() {
        if (st.io) return;
        const onVis = () => { if (!st.player) return; (document.hidden || !st.visible) ? st.player.pause() : st.player.resume(); };
        document.addEventListener('visibilitychange', onVis);
        try {
            st.io = new IntersectionObserver((entries) => { st.visible = !!(entries[0] && entries[0].isIntersecting); onVis(); }, { threshold: 0.15 });
            st.io.observe(st.el);
        } catch { st.io = { disconnect() { } }; }
        document.addEventListener('ov:page', (e) => { if (!e.detail || e.detail.page !== 'home') stop(); });
        // The network came back: a feed that had failed tries again by itself.
        window.addEventListener('online', () => { if (st.broken) scheduleRetry(500); });
    }

    /**
     * The featured stream's card in the Live Now grid carries .is-featured. Live Now lists every live stream (owner,
     * 2026-11-11: a streamer live on two slots showed one); only when the featured stream is the one stream live does a
     * phone leave the grid out, so it is not drawn twice 1,000 px apart (2026-10-31; features/home.css).
     */
    function markGrid() {
        const id = st.current && !st.el?.hidden ? String(st.current.id) : '';
        for (const c of document.querySelectorAll('#stream-grid-live .stream-card[data-stream-id]')) c.classList.toggle('is-featured', !!id && c.dataset.streamId === id);
    }

    /** Called by the home page once the live list has arrived. */
    function boot(hasLive) {
        st.hasLive = !!hasLive;
        const t = document.getElementById('home-featured-toggle');
        if (t) { t.hidden = !(isOff() && st.hasLive); t.onclick = () => setOff(false); }
        st.el = document.getElementById('home-featured');
        if (!st.el || !st.hasLive || isOff()) { stop(); return; }
        if (st.poll) return; // already running; the live-list poll calls this every 20 s
        watchVisibility();
        load(false);
        clearInterval(st.poll);
        st.poll = setInterval(() => { if (!document.hidden) load(false); }, POLL_MS);
    }
    function stop() {
        clearInterval(st.poll); st.poll = 0;
        if (st.retryTimer) { clearTimeout(st.retryTimer); st.retryTimer = 0; }
        destroyPlayer();
        st.current = null;
        if (st.el) { st.el.hidden = true; st.el.innerHTML = ''; }
        markGrid();
    }

    window.homeFeatured = { boot, stop, setOff, isOff, markGrid };
})();
